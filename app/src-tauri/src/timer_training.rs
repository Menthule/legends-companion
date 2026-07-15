//! Read-only diagnostics for learning exact per-rank timer values from the
//! configured EQ log. Applying an estimate remains an explicit profile write
//! in the frontend; this module never mutates trigger or profile state.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};

use eqlog_core::events::Entity;
use eqlog_core::parser::Parser;
use eqlog_core::Event;
use eqlog_triggers::model::{Action, CharacterProfile, TimerTiming, Trigger};
use eqlog_triggers::{duration_ticks_at_level, effective_enabled};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{lock, AppState};

const MAX_LANDING_DELAY_SECS: i64 = 20;
const MIN_CLEAN_SAMPLES: usize = 3;

#[derive(Debug, Clone)]
struct TrainingTarget {
    trigger_id: String,
    trigger_name: String,
    timer_name: String,
    configured_duration_secs: u64,
    configured_cast_time_secs: u64,
    rank_timings: BTreeMap<String, TimerTiming>,
    cast_pattern: Regex,
}

#[derive(Debug, Clone)]
struct PendingCast {
    rank: String,
    cast_at: i64,
}

#[derive(Debug, Clone)]
struct ActiveEffect {
    rank: String,
    cast_at: i64,
    landed_at: i64,
    target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerTrainingSample {
    cast_at: i64,
    landed_at: i64,
    worn_off_at: i64,
    target: String,
    duration_secs: u64,
    cast_time_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankTrainingResult {
    rank: String,
    casts_seen: usize,
    clean_samples: usize,
    rejected_samples: usize,
    observed_min_secs: Option<u64>,
    observed_max_secs: Option<u64>,
    suggested_duration_secs: Option<u64>,
    cast_samples: usize,
    observed_cast_min_secs: Option<u64>,
    observed_cast_max_secs: Option<u64>,
    suggested_cast_time_secs: Option<u64>,
    configured_duration_secs: u64,
    configured_cast_time_secs: u64,
    duration_delta_secs: Option<i64>,
    cast_time_delta_secs: Option<i64>,
    status: String,
    needs_update: bool,
    confidence: String,
    reason: String,
    can_apply: bool,
    samples: Vec<TimerTrainingSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerTrainingReport {
    trigger_id: String,
    trigger_name: String,
    timer_name: String,
    log_path: String,
    lines_scanned: usize,
    ranked_casts: usize,
    rejected_samples: usize,
    configured_duration_secs: u64,
    configured_cast_time_secs: u64,
    ranks: Vec<RankTrainingResult>,
}

/// Summary for one effective rank-aware timer that was observed in the log.
/// Unlike [`TimerTrainingReport`], this is intended for batch discovery rather
/// than the expanded sample view for one selected trigger.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerTrainingCandidate {
    trigger_id: String,
    trigger_name: String,
    timer_name: String,
    configured_duration_secs: u64,
    configured_cast_time_secs: u64,
    ranks: Vec<RankTrainingResult>,
}

/// One-pass discovery report for every effective rank-aware fixed-name timer
/// that has at least one ranked cast in the configured log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerTrainingCandidatesReport {
    log_path: String,
    lines_scanned: usize,
    candidates: Vec<TimerTrainingCandidate>,
}

#[derive(Debug, Clone)]
struct Estimate {
    value: u64,
    min: u64,
    max: u64,
    inliers: usize,
    confidence: &'static str,
}

fn trailing_rank(spell: &str) -> Option<(&str, String)> {
    let (base, rank) = spell.trim().rsplit_once(' ')?;
    if base.is_empty()
        || rank.is_empty()
        || !rank
            .bytes()
            .all(|byte| matches!(byte, b'I' | b'V' | b'X' | b'L' | b'C' | b'D' | b'M'))
    {
        return None;
    }
    Some((base, rank.to_string()))
}

fn spell_base(spell: &str) -> &str {
    trailing_rank(spell)
        .map(|(base, _)| base)
        .unwrap_or(spell.trim())
}

fn entity_key(entity: &Entity) -> String {
    match entity {
        Entity::You => "you".to_string(),
        Entity::Named(name) => name.trim().to_lowercase(),
    }
}

fn effect_key(base: &str, target: &str) -> String {
    format!(
        "{}\0{}",
        base.trim().to_lowercase(),
        target.trim().to_lowercase()
    )
}

fn landing_target(message: &str, timer_name: &str) -> Option<String> {
    eqlog_triggers::buff_lands::BUFF_LAND_SUFFIXES
        .iter()
        .chain(eqlog_triggers::buff_lands::DEBUFF_LAND_SUFFIXES.iter())
        .find(|(name, _)| name.eq_ignore_ascii_case(timer_name))
        .and_then(|(_, suffix)| message.strip_suffix(suffix))
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(str::to_string)
}

fn damage_landing(event: &Event, timer_name: &str) -> Option<String> {
    match event {
        Event::SpellDamage {
            caster: Entity::You,
            target,
            spell: Some(spell),
            ..
        }
        | Event::SpellDamageTaken {
            source: Entity::You,
            target,
            spell,
            ..
        } if spell_base(spell).eq_ignore_ascii_case(timer_name) => Some(entity_key(target)),
        _ => None,
    }
}

fn estimate(values: &[u64], tick_rounded: bool) -> Option<Estimate> {
    if values.len() < MIN_CLEAN_SAMPLES {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let window = if tick_rounded { 6 } else { 1 };
    let mut best = (0usize, 0usize);
    let mut left = 0usize;
    for right in 0..sorted.len() {
        while sorted[right].saturating_sub(sorted[left]) > window {
            left += 1;
        }
        if right + 1 - left > best.1 - best.0 {
            best = (left, right + 1);
        }
    }
    let inliers = &sorted[best.0..best.1];
    if inliers.len() < MIN_CLEAN_SAMPLES || inliers.len() * 4 < values.len() * 3 {
        return None;
    }
    let center = inliers[inliers.len() / 2];
    let value = if tick_rounded && center >= 12 {
        ((center + 5) / 6) * 6
    } else {
        center
    };
    Some(Estimate {
        value,
        min: *inliers.first().unwrap_or(&center),
        max: *inliers.last().unwrap_or(&center),
        inliers: inliers.len(),
        confidence: if inliers.len() == values.len() {
            "high"
        } else {
            "good"
        },
    })
}

fn effective_rank_timings(
    trigger: &Trigger,
    profile: &CharacterProfile,
    authored: &BTreeMap<String, TimerTiming>,
) -> BTreeMap<String, TimerTiming> {
    let mut timings = authored.clone();
    let trigger_id = trigger.effective_id();
    let manual = profile
        .active_loadout()
        .timing_overrides
        .iter()
        .find(|(id, _)| id.eq_ignore_ascii_case(&trigger_id))
        .map(|(_, value)| value);
    if let Some(manual) = manual {
        for (rank, timing) in manual {
            let value = timings.entry(rank.trim().to_ascii_uppercase()).or_default();
            if timing.duration_secs.is_some() {
                value.duration_secs = timing.duration_secs;
            }
            if timing.cast_time_secs.is_some() {
                value.cast_time_secs = timing.cast_time_secs;
            }
        }
    }
    timings
}

fn training_target_from_trigger(
    trigger: &Trigger,
    profile: &CharacterProfile,
) -> Result<Option<TrainingTarget>, String> {
    if !trigger.pattern.contains("rank") {
        return Ok(None);
    }
    let timer = trigger.actions.iter().find_map(|action| match action {
        Action::StartTimer {
            name,
            duration_secs,
            cast_time_secs,
            duration_formula,
            duration_cap_ticks,
            rank_variants,
            ..
        } if !name.contains("${") => {
            let scaled_duration = duration_formula
                .map(|formula| {
                    u64::from(duration_ticks_at_level(
                        formula,
                        duration_cap_ticks.unwrap_or(0),
                        profile.level,
                    )) * 6
                })
                .filter(|seconds| *seconds > 0)
                .unwrap_or(*duration_secs);
            Some((
                name,
                scaled_duration,
                cast_time_secs.unwrap_or(0),
                effective_rank_timings(trigger, profile, rank_variants),
            ))
        }
        _ => None,
    });
    let Some((timer_name, duration, cast_time, rank_timings)) = timer else {
        return Ok(None);
    };
    let cast_pattern = RegexBuilder::new(&trigger.pattern)
        .case_insensitive(trigger.case_insensitive)
        .build()
        .map_err(|error| format!("compile {}: {error}", trigger.name))?;
    if !cast_pattern
        .capture_names()
        .flatten()
        .any(|name| name == "rank")
    {
        return Err(format!("{} has no named rank capture.", trigger.name));
    }
    Ok(Some(TrainingTarget {
        trigger_id: trigger.effective_id(),
        trigger_name: trigger.name.clone(),
        timer_name: timer_name.clone(),
        configured_duration_secs: duration,
        configured_cast_time_secs: cast_time,
        rank_timings,
        cast_pattern,
    }))
}

fn training_target(
    app: &AppHandle,
    cfg: &crate::config::AppConfig,
    trigger_id: &str,
) -> Result<TrainingTarget, String> {
    let library = crate::library::load_library(app, cfg)?;
    let profile = crate::library::load_profile(app, cfg);
    let trigger = library
        .packs
        .iter()
        .chain(library.user.iter())
        .find(|trigger| trigger.effective_id() == trigger_id)
        .ok_or_else(|| format!("Timer trigger {trigger_id:?} was not found."))?;
    training_target_from_trigger(trigger, &profile)?.ok_or_else(|| {
        format!(
            "{} is not a rank-aware fixed-name timer trigger.",
            trigger.name
        )
    })
}

fn active_training_targets(
    app: &AppHandle,
    cfg: &crate::config::AppConfig,
) -> Result<Vec<TrainingTarget>, String> {
    let library = crate::library::load_library(app, cfg)?;
    let profile = crate::library::load_profile(app, cfg);
    effective_training_targets(library.packs.iter().chain(library.user.iter()), &profile)
}

fn effective_training_targets<'a>(
    triggers: impl Iterator<Item = &'a Trigger>,
    profile: &CharacterProfile,
) -> Result<Vec<TrainingTarget>, String> {
    triggers
        .filter(|trigger| trigger.enabled && effective_enabled(trigger, profile))
        .filter_map(|trigger| training_target_from_trigger(trigger, profile).transpose())
        .collect()
}

fn configured_timing(target: &TrainingTarget, rank: &str) -> (u64, u64) {
    let variant = target
        .rank_timings
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(rank.trim()))
        .map(|(_, timing)| timing);
    (
        variant
            .and_then(|timing| timing.duration_secs)
            .unwrap_or(target.configured_duration_secs),
        variant
            .and_then(|timing| timing.cast_time_secs)
            .unwrap_or(target.configured_cast_time_secs),
    )
}

fn rank_results(
    target: &TrainingTarget,
    casts_by_rank: BTreeMap<String, usize>,
    mut samples_by_rank: BTreeMap<String, Vec<TimerTrainingSample>>,
) -> Vec<RankTrainingResult> {
    let mut ranks = Vec::new();
    for (rank, casts_seen) in casts_by_rank {
        let samples = samples_by_rank.remove(&rank).unwrap_or_default();
        let durations: Vec<u64> = samples.iter().map(|sample| sample.duration_secs).collect();
        let cast_times: Vec<u64> = samples.iter().map(|sample| sample.cast_time_secs).collect();
        let duration_estimate = estimate(&durations, true);
        let cast_estimate = estimate(&cast_times, false);
        let clean_samples = duration_estimate
            .as_ref()
            .map_or(durations.len(), |value| value.inliers);
        let rejected = casts_seen.saturating_sub(samples.len())
            + duration_estimate
                .as_ref()
                .map_or(0, |value| durations.len().saturating_sub(value.inliers));
        let (confidence, reason) = if let Some(value) = duration_estimate.as_ref() {
            (
                value.confidence.to_string(),
                format!(
                    "{} consistent natural wear-offs; preview only until Apply.",
                    value.inliers
                ),
            )
        } else if samples.len() < MIN_CLEAN_SAMPLES {
            (
                "insufficient".to_string(),
                format!(
                    "Need {} clean natural wear-offs; found {}.",
                    MIN_CLEAN_SAMPLES,
                    samples.len()
                ),
            )
        } else {
            (
                "inconsistent".to_string(),
                "Observed durations vary too much to apply safely.".to_string(),
            )
        };
        let (configured_duration_secs, configured_cast_time_secs) =
            configured_timing(target, &rank);
        let duration_delta_secs = duration_estimate
            .as_ref()
            .map(|value| value.value as i64 - configured_duration_secs as i64);
        let cast_time_delta_secs = cast_estimate
            .as_ref()
            .map(|value| value.value as i64 - configured_cast_time_secs as i64);
        let needs_update = duration_delta_secs.is_some_and(|delta| delta != 0)
            || cast_time_delta_secs.is_some_and(|delta| delta != 0);
        let status = if needs_update {
            "needs-update"
        } else if duration_estimate.is_some() || cast_estimate.is_some() {
            "matches"
        } else if samples.len() < MIN_CLEAN_SAMPLES {
            "insufficient"
        } else {
            "inconsistent"
        };
        ranks.push(RankTrainingResult {
            rank,
            casts_seen,
            clean_samples,
            rejected_samples: rejected,
            observed_min_secs: duration_estimate.as_ref().map(|value| value.min),
            observed_max_secs: duration_estimate.as_ref().map(|value| value.max),
            suggested_duration_secs: duration_estimate.as_ref().map(|value| value.value),
            cast_samples: cast_estimate
                .as_ref()
                .map_or(cast_times.len(), |value| value.inliers),
            observed_cast_min_secs: cast_estimate.as_ref().map(|value| value.min),
            observed_cast_max_secs: cast_estimate.as_ref().map(|value| value.max),
            suggested_cast_time_secs: cast_estimate.as_ref().map(|value| value.value),
            configured_duration_secs,
            configured_cast_time_secs,
            duration_delta_secs,
            cast_time_delta_secs,
            status: status.to_string(),
            needs_update,
            confidence,
            reason,
            can_apply: duration_estimate.is_some() || cast_estimate.is_some(),
            samples: samples.into_iter().rev().take(5).collect(),
        });
    }
    ranks.sort_by(|a, b| a.rank.len().cmp(&b.rank.len()).then(a.rank.cmp(&b.rank)));
    ranks
}

fn scan_reader(
    reader: impl BufRead,
    target: &TrainingTarget,
    log_path: String,
) -> Result<TimerTrainingReport, String> {
    let parser = Parser::new();
    let mut lines_scanned = 0usize;
    let mut ranked_casts = 0usize;
    let mut rejected_samples = 0usize;
    let mut pending: Option<PendingCast> = None;
    let mut active: HashMap<String, ActiveEffect> = HashMap::new();
    let mut casts_by_rank: BTreeMap<String, usize> = BTreeMap::new();
    let mut samples_by_rank: BTreeMap<String, Vec<TimerTrainingSample>> = BTreeMap::new();
    let mut completed: Vec<(String, TimerTrainingSample)> = Vec::new();

    for raw in reader.lines() {
        let raw = raw.map_err(|error| format!("read {log_path}: {error}"))?;
        lines_scanned += 1;
        let Some(parsed) = parser.parse_line(&raw) else {
            continue;
        };
        let timestamp = parsed.line.timestamp;
        let mut index = 0;
        while index < completed.len() {
            if completed[index].1.worn_off_at < timestamp {
                let (rank, sample) = completed.remove(index);
                samples_by_rank.entry(rank).or_default().push(sample);
            } else {
                index += 1;
            }
        }
        if pending
            .as_ref()
            .is_some_and(|cast| timestamp.saturating_sub(cast.cast_at) > MAX_LANDING_DELAY_SECS)
        {
            rejected_samples += 1;
            pending = None;
        }

        if let Event::CastBegin {
            caster: Entity::You,
            spell: _,
        } = &parsed.event
        {
            if let Some(captures) = target.cast_pattern.captures(&parsed.line.message) {
                if let Some(rank) = captures
                    .name("rank")
                    .map(|value| value.as_str().to_uppercase())
                {
                    if pending.take().is_some() {
                        rejected_samples += 1;
                    }
                    ranked_casts += 1;
                    *casts_by_rank.entry(rank.clone()).or_default() += 1;
                    pending = Some(PendingCast {
                        rank,
                        cast_at: timestamp,
                    });
                    continue;
                }
            }
        }

        if let Some(cast) = pending.as_ref() {
            let landed_target = damage_landing(&parsed.event, &target.timer_name)
                .or_else(|| landing_target(&parsed.line.message, &target.timer_name));
            if let Some(landed_target) = landed_target {
                let cast = cast.clone();
                let key = effect_key(&target.timer_name, &landed_target);
                if active
                    .insert(
                        key,
                        ActiveEffect {
                            rank: cast.rank,
                            cast_at: cast.cast_at,
                            landed_at: timestamp,
                            target: landed_target,
                        },
                    )
                    .is_some()
                {
                    rejected_samples += 1;
                }
                pending = None;
                continue;
            }
        }

        match &parsed.event {
            Event::CastInterrupted {
                caster: Entity::You,
                ..
            }
            | Event::CastFizzled {
                caster: Entity::You,
                ..
            } => {
                if pending.take().is_some() {
                    rejected_samples += 1;
                }
            }
            Event::Resisted {
                caster: Entity::You,
                spell,
                ..
            } if spell_base(spell.as_str()).eq_ignore_ascii_case(&target.timer_name) => {
                if pending.take().is_some() {
                    rejected_samples += 1;
                }
            }
            Event::BuffBlocked { spell, .. }
                if spell_base(spell.as_str()).eq_ignore_ascii_case(&target.timer_name) =>
            {
                if pending.take().is_some() {
                    rejected_samples += 1;
                }
            }
            Event::WornOff { spell, owner }
                if spell_base(spell.as_str()).eq_ignore_ascii_case(&target.timer_name) =>
            {
                let Some(owner) = owner.as_ref() else {
                    continue;
                };
                let key = effect_key(&target.timer_name, &entity_key(owner));
                let Some(effect) = active.remove(&key) else {
                    continue;
                };
                let duration = timestamp.saturating_sub(effect.landed_at);
                let cast_time = effect.landed_at.saturating_sub(effect.cast_at);
                if duration <= 0 || cast_time < 0 || cast_time > MAX_LANDING_DELAY_SECS {
                    rejected_samples += 1;
                    continue;
                }
                completed.push((
                    effect.rank,
                    TimerTrainingSample {
                        cast_at: effect.cast_at,
                        landed_at: effect.landed_at,
                        worn_off_at: timestamp,
                        target: effect.target,
                        duration_secs: duration as u64,
                        cast_time_secs: cast_time as u64,
                    },
                ));
            }
            Event::Slain { victim, .. } => {
                let victim = entity_key(victim);
                let before = active.len();
                active.retain(|_, effect| !effect.target.eq_ignore_ascii_case(&victim));
                rejected_samples += before - active.len();
                let before = completed.len();
                completed.retain(|(_, sample)| {
                    sample.worn_off_at != timestamp || !sample.target.eq_ignore_ascii_case(&victim)
                });
                rejected_samples += before - completed.len();
                if victim == "you" && pending.take().is_some() {
                    rejected_samples += 1;
                }
            }
            Event::Loading | Event::ZoneEnter { .. } => {
                rejected_samples += active.len();
                active.clear();
                rejected_samples += completed.len();
                completed.clear();
                if pending.take().is_some() {
                    rejected_samples += 1;
                }
            }
            _ => {}
        }
    }

    for (rank, sample) in completed {
        samples_by_rank.entry(rank).or_default().push(sample);
    }

    rejected_samples += active.len() + usize::from(pending.is_some());
    let ranks = rank_results(target, casts_by_rank, samples_by_rank);

    Ok(TimerTrainingReport {
        trigger_id: target.trigger_id.clone(),
        trigger_name: target.trigger_name.clone(),
        timer_name: target.timer_name.clone(),
        log_path,
        lines_scanned,
        ranked_casts,
        rejected_samples,
        configured_duration_secs: target.configured_duration_secs,
        configured_cast_time_secs: target.configured_cast_time_secs,
        ranks,
    })
}

#[derive(Debug, Default)]
struct CandidateScanState {
    ranked_casts: usize,
    rejected_samples: usize,
    pending: Option<PendingCast>,
    active: HashMap<String, ActiveEffect>,
    casts_by_rank: BTreeMap<String, usize>,
    samples_by_rank: BTreeMap<String, Vec<TimerTrainingSample>>,
}

fn scan_candidates_reader(
    reader: impl BufRead,
    targets: Vec<TrainingTarget>,
    log_path: String,
) -> Result<TimerTrainingCandidatesReport, String> {
    let parser = Parser::new();
    let mut lines_scanned = 0usize;
    let mut states: Vec<CandidateScanState> = (0..targets.len())
        .map(|_| CandidateScanState::default())
        .collect();
    // Most library timers are never cast in a given character's log. These
    // sets keep ordinary combat lines proportional to observed timers rather
    // than to the full trigger catalog.
    let mut pending_indices: HashSet<usize> = HashSet::new();
    let mut active_indices: HashSet<usize> = HashSet::new();

    for raw in reader.lines() {
        let raw = raw.map_err(|error| format!("read {log_path}: {error}"))?;
        lines_scanned += 1;
        let Some(parsed) = parser.parse_line(&raw) else {
            continue;
        };
        let timestamp = parsed.line.timestamp;

        let expired: Vec<usize> = pending_indices
            .iter()
            .copied()
            .filter(|index| {
                states[*index].pending.as_ref().is_some_and(|cast| {
                    timestamp.saturating_sub(cast.cast_at) > MAX_LANDING_DELAY_SECS
                })
            })
            .collect();
        for index in expired {
            states[index].pending = None;
            states[index].rejected_samples += 1;
            pending_indices.remove(&index);
        }

        let mut matched_cast = false;
        if matches!(
            &parsed.event,
            Event::CastBegin {
                caster: Entity::You,
                ..
            }
        ) {
            for (index, target) in targets.iter().enumerate() {
                let Some(captures) = target.cast_pattern.captures(&parsed.line.message) else {
                    continue;
                };
                let Some(rank) = captures
                    .name("rank")
                    .map(|value| value.as_str().to_ascii_uppercase())
                else {
                    continue;
                };
                let state = &mut states[index];
                if state.pending.take().is_some() {
                    state.rejected_samples += 1;
                }
                state.ranked_casts += 1;
                *state.casts_by_rank.entry(rank.clone()).or_default() += 1;
                state.pending = Some(PendingCast {
                    rank,
                    cast_at: timestamp,
                });
                pending_indices.insert(index);
                matched_cast = true;
            }
        }
        if matched_cast {
            continue;
        }

        let pending_now: Vec<usize> = pending_indices.iter().copied().collect();
        for index in pending_now {
            let target = &targets[index];
            let landed_target = damage_landing(&parsed.event, &target.timer_name)
                .or_else(|| landing_target(&parsed.line.message, &target.timer_name));
            let Some(landed_target) = landed_target else {
                continue;
            };
            let state = &mut states[index];
            let Some(cast) = state.pending.take() else {
                pending_indices.remove(&index);
                continue;
            };
            let key = effect_key(&target.timer_name, &landed_target);
            if state
                .active
                .insert(
                    key,
                    ActiveEffect {
                        rank: cast.rank,
                        cast_at: cast.cast_at,
                        landed_at: timestamp,
                        target: landed_target,
                    },
                )
                .is_some()
            {
                state.rejected_samples += 1;
            }
            pending_indices.remove(&index);
            active_indices.insert(index);
        }

        match &parsed.event {
            Event::CastInterrupted {
                caster: Entity::You,
                ..
            }
            | Event::CastFizzled {
                caster: Entity::You,
                ..
            } => {
                for index in pending_indices.drain() {
                    if states[index].pending.take().is_some() {
                        states[index].rejected_samples += 1;
                    }
                }
            }
            Event::Resisted {
                caster: Entity::You,
                spell,
                ..
            }
            | Event::BuffBlocked { spell, .. } => {
                let rejected: Vec<usize> = pending_indices
                    .iter()
                    .copied()
                    .filter(|index| {
                        spell_base(spell.as_str()).eq_ignore_ascii_case(&targets[*index].timer_name)
                    })
                    .collect();
                for index in rejected {
                    if states[index].pending.take().is_some() {
                        states[index].rejected_samples += 1;
                    }
                    pending_indices.remove(&index);
                }
            }
            Event::WornOff { spell, owner } => {
                let Some(owner) = owner.as_ref() else {
                    continue;
                };
                let owner = entity_key(owner);
                let active_now: Vec<usize> = active_indices.iter().copied().collect();
                for index in active_now {
                    let target = &targets[index];
                    if !spell_base(spell.as_str()).eq_ignore_ascii_case(&target.timer_name) {
                        continue;
                    }
                    let state = &mut states[index];
                    let key = effect_key(&target.timer_name, &owner);
                    let Some(effect) = state.active.remove(&key) else {
                        continue;
                    };
                    let duration = timestamp.saturating_sub(effect.landed_at);
                    let cast_time = effect.landed_at.saturating_sub(effect.cast_at);
                    if duration <= 0 || cast_time < 0 || cast_time > MAX_LANDING_DELAY_SECS {
                        state.rejected_samples += 1;
                    } else {
                        state.samples_by_rank.entry(effect.rank).or_default().push(
                            TimerTrainingSample {
                                cast_at: effect.cast_at,
                                landed_at: effect.landed_at,
                                worn_off_at: timestamp,
                                target: effect.target,
                                duration_secs: duration as u64,
                                cast_time_secs: cast_time as u64,
                            },
                        );
                    }
                    if state.active.is_empty() {
                        active_indices.remove(&index);
                    }
                }
            }
            Event::Slain { victim, .. } => {
                let victim = entity_key(victim);
                // Also inspect states whose last active effect wore off on this
                // exact second: a same-timestamp death makes that wear-off an
                // early break rather than a natural duration sample.
                for index in 0..states.len() {
                    let state = &mut states[index];
                    let before = state.active.len();
                    state
                        .active
                        .retain(|_, effect| !effect.target.eq_ignore_ascii_case(&victim));
                    state.rejected_samples += before - state.active.len();
                    for samples in state.samples_by_rank.values_mut() {
                        let before = samples.len();
                        samples.retain(|sample| {
                            sample.worn_off_at != timestamp
                                || !sample.target.eq_ignore_ascii_case(&victim)
                        });
                        state.rejected_samples += before - samples.len();
                    }
                    if state.active.is_empty() {
                        active_indices.remove(&index);
                    }
                }
                if victim == "you" {
                    for index in pending_indices.drain() {
                        if states[index].pending.take().is_some() {
                            states[index].rejected_samples += 1;
                        }
                    }
                }
            }
            Event::Loading | Event::ZoneEnter { .. } => {
                for index in active_indices.drain() {
                    let state = &mut states[index];
                    state.rejected_samples += state.active.len();
                    state.active.clear();
                }
                for index in pending_indices.drain() {
                    if states[index].pending.take().is_some() {
                        states[index].rejected_samples += 1;
                    }
                }
            }
            _ => {}
        }
    }

    for index in active_indices {
        states[index].rejected_samples += states[index].active.len();
    }
    for index in pending_indices {
        if states[index].pending.is_some() {
            states[index].rejected_samples += 1;
        }
    }

    let mut candidates = Vec::new();
    for (target, state) in targets.into_iter().zip(states) {
        if state.ranked_casts == 0 {
            continue;
        }
        candidates.push(TimerTrainingCandidate {
            trigger_id: target.trigger_id.clone(),
            trigger_name: target.trigger_name.clone(),
            timer_name: target.timer_name.clone(),
            configured_duration_secs: target.configured_duration_secs,
            configured_cast_time_secs: target.configured_cast_time_secs,
            ranks: rank_results(&target, state.casts_by_rank, state.samples_by_rank),
        });
    }
    candidates.sort_by(|a, b| {
        a.timer_name
            .cmp(&b.timer_name)
            .then(a.trigger_id.cmp(&b.trigger_id))
    });
    Ok(TimerTrainingCandidatesReport {
        log_path,
        lines_scanned,
        candidates,
    })
}

fn scan_inner(
    app: &AppHandle,
    cfg: &crate::config::AppConfig,
    trigger_id: &str,
) -> Result<TimerTrainingReport, String> {
    let target = training_target(app, cfg, trigger_id)?;
    let path = cfg.log_path.trim();
    if path.is_empty() {
        return Err("Choose an EverQuest log before training timers.".to_string());
    }
    let file = File::open(path).map_err(|error| format!("open {path}: {error}"))?;
    scan_reader(BufReader::new(file), &target, path.to_string())
}

fn candidates_inner(
    app: &AppHandle,
    cfg: &crate::config::AppConfig,
) -> Result<TimerTrainingCandidatesReport, String> {
    let targets = active_training_targets(app, cfg)?;
    let path = cfg.log_path.trim();
    if path.is_empty() {
        return Err("Choose an EverQuest log before training timers.".to_string());
    }
    let file = File::open(path).map_err(|error| format!("open {path}: {error}"))?;
    scan_candidates_reader(BufReader::new(file), targets, path.to_string())
}

/// Analyze historical evidence for one rank-aware timer. This command is a
/// test run only: it reads the log and returns estimates without saving them.
#[tauri::command]
pub async fn timer_training_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    trigger_id: String,
) -> Result<TimerTrainingReport, String> {
    let cfg = lock(&state.config, "config")?.clone();
    tauri::async_runtime::spawn_blocking(move || scan_inner(&app, &cfg, &trigger_id))
        .await
        .map_err(|error| format!("timer training task failed: {error}"))?
}

/// Discover every effective ranked timer represented in the configured log.
/// The file is parsed once regardless of how many active timer triggers exist.
#[tauri::command]
pub async fn timer_training_candidates(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TimerTrainingCandidatesReport, String> {
    let cfg = lock(&state.config, "config")?.clone();
    tauri::async_runtime::spawn_blocking(move || candidates_inner(&app, &cfg))
        .await
        .map_err(|error| format!("timer training discovery task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> TrainingTarget {
        TrainingTarget {
            trigger_id: "debuffs/shaman/cast/odium".to_string(),
            trigger_name: "Enemy timer: Odium".to_string(),
            timer_name: "Odium".to_string(),
            configured_duration_secs: 30,
            configured_cast_time_secs: 3,
            rank_timings: BTreeMap::new(),
            cast_pattern: Regex::new(r"^You begin casting Odium(?: (?P<rank>[IVXLCDM]+))?\.$")
                .unwrap(),
        }
    }

    #[test]
    fn parses_only_trailing_roman_ranks() {
        assert_eq!(trailing_rank("Odium VI"), Some(("Odium", "VI".to_string())));
        assert_eq!(trailing_rank("Odium"), None);
        assert_eq!(trailing_rank("Odium 6"), None);
        assert_eq!(trailing_rank("CIVIL"), None);
    }

    #[test]
    fn consistent_estimate_rejects_one_outlier_and_rounds_to_ticks() {
        let estimate = estimate(&[29, 30, 31, 92], true).expect("estimate");
        assert_eq!(estimate.value, 30);
        assert_eq!(estimate.inliers, 3);
        assert_eq!((estimate.min, estimate.max), (29, 31));
    }

    #[test]
    fn inconsistent_or_sparse_samples_do_not_produce_an_estimate() {
        assert!(estimate(&[30, 31], true).is_none());
        assert!(estimate(&[20, 30, 40, 50], true).is_none());
        assert!(estimate(&[0, 2, 4], false).is_none());
    }

    #[test]
    fn test_run_collects_natural_wearoffs_without_mutating_any_profile() {
        let log = [
            "[Tue Jul 14 10:00:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:00:02 2026] A test drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:00:32 2026] Your Odium spell has worn off of A test drake.",
            "[Tue Jul 14 10:01:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:01:02 2026] A second drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:01:33 2026] Your Odium spell has worn off of A second drake.",
            "[Tue Jul 14 10:02:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:02:02 2026] A third drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:02:31 2026] Your Odium spell has worn off of A third drake.",
        ]
        .join("\n");

        let report = scan_reader(log.as_bytes(), &target(), "test.log".to_string()).unwrap();
        assert_eq!(report.ranked_casts, 3);
        assert_eq!(report.ranks.len(), 1);
        assert_eq!(report.ranks[0].suggested_duration_secs, Some(30));
        assert_eq!(report.ranks[0].suggested_cast_time_secs, Some(2));
        assert_eq!(report.ranks[0].configured_duration_secs, 30);
        assert_eq!(report.ranks[0].duration_delta_secs, Some(0));
        assert_eq!(report.ranks[0].status, "needs-update");
        assert!(report.ranks[0].can_apply);
    }

    #[test]
    fn recasts_deaths_and_resists_do_not_become_training_samples() {
        let log = [
            "[Tue Jul 14 10:00:00 2026] You begin casting Odium VII.",
            "[Tue Jul 14 10:00:02 2026] A test drake has taken 10 damage from your Odium VII.",
            "[Tue Jul 14 10:00:10 2026] You begin casting Odium VII.",
            "[Tue Jul 14 10:00:12 2026] A test drake has taken 10 damage from your Odium VII.",
            "[Tue Jul 14 10:00:20 2026] You have slain A test drake!",
            "[Tue Jul 14 10:01:00 2026] You begin casting Odium VII.",
            "[Tue Jul 14 10:01:01 2026] A second drake resisted your Odium VII!",
        ]
        .join("\n");

        let report = scan_reader(log.as_bytes(), &target(), "test.log".to_string()).unwrap();
        assert_eq!(report.ranked_casts, 3);
        assert_eq!(report.ranks[0].clean_samples, 0);
        assert!(!report.ranks[0].can_apply);
    }

    #[test]
    fn one_pass_discovery_omits_unobserved_timers_and_compares_rank_variants() {
        let mut odium = target();
        odium.rank_timings.insert(
            "VI".to_string(),
            TimerTiming {
                duration_secs: Some(30),
                cast_time_secs: Some(2),
            },
        );
        let mut unseen = target();
        unseen.trigger_id = "debuffs/shaman/cast/malosi".to_string();
        unseen.trigger_name = "Enemy timer: Malosi".to_string();
        unseen.timer_name = "Malosi".to_string();
        unseen.cast_pattern =
            Regex::new(r"^You begin casting Malosi(?: (?P<rank>[IVXLCDM]+))?\.$").unwrap();
        let log = [
            "[Tue Jul 14 10:00:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:00:02 2026] A first drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:00:32 2026] Your Odium spell has worn off of A first drake.",
            "[Tue Jul 14 10:01:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:01:02 2026] A second drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:01:32 2026] Your Odium spell has worn off of A second drake.",
            "[Tue Jul 14 10:02:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:02:02 2026] A third drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:02:32 2026] Your Odium spell has worn off of A third drake.",
        ]
        .join("\n");

        let report =
            scan_candidates_reader(log.as_bytes(), vec![odium, unseen], "test.log".to_string())
                .unwrap();
        assert_eq!(report.lines_scanned, 9);
        assert_eq!(report.candidates.len(), 1);
        let result = &report.candidates[0].ranks[0];
        assert_eq!(result.rank, "VI");
        assert_eq!(result.casts_seen, 3);
        assert_eq!(result.configured_duration_secs, 30);
        assert_eq!(result.configured_cast_time_secs, 2);
        assert_eq!(result.duration_delta_secs, Some(0));
        assert_eq!(result.cast_time_delta_secs, Some(0));
        assert_eq!(result.status, "matches");
        assert!(!result.needs_update);
    }

    #[test]
    fn discovery_marks_a_consistent_rank_duration_change() {
        let log = [
            "[Tue Jul 14 10:00:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:00:02 2026] A first drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:00:44 2026] Your Odium spell has worn off of A first drake.",
            "[Tue Jul 14 10:01:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:01:02 2026] A second drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:01:44 2026] Your Odium spell has worn off of A second drake.",
            "[Tue Jul 14 10:02:00 2026] You begin casting Odium VI.",
            "[Tue Jul 14 10:02:02 2026] A third drake has taken 10 damage from your Odium VI.",
            "[Tue Jul 14 10:02:44 2026] Your Odium spell has worn off of A third drake.",
        ]
        .join("\n");

        let report =
            scan_candidates_reader(log.as_bytes(), vec![target()], "test.log".to_string()).unwrap();
        let result = &report.candidates[0].ranks[0];
        assert_eq!(result.suggested_duration_secs, Some(42));
        assert_eq!(result.duration_delta_secs, Some(12));
        assert_eq!(result.status, "needs-update");
        assert!(result.needs_update);
    }

    #[test]
    fn discovery_targets_follow_active_loadout_and_pack_enablement() {
        let active: Trigger = serde_json::from_value(serde_json::json!({
            "id": "debuffs/shaman/cast/odium",
            "name": "Enemy timer: Odium",
            "pattern": "^You begin casting Odium(?: (?P<rank>[IVXLCDM]+))?\\.$",
            "enabled": true,
            "default_enabled": true,
            "source": "generated",
            "category": "Debuffs/Shaman/Timers",
            "classes": ["Shaman"],
            "actions": [{
                "StartTimer": {
                    "name": "Odium",
                    "duration_secs": 30,
                    "cast_time_secs": 3,
                    "lane": "enemy"
                }
            }]
        }))
        .unwrap();
        let mut wrong_class = active.clone();
        wrong_class.id = Some("debuffs/wizard/cast/odium".to_string());
        wrong_class.classes = vec!["Wizard".to_string()];
        let mut disabled = active.clone();
        disabled.id = Some("debuffs/shaman/cast/odium-disabled".to_string());
        disabled.enabled = false;
        let mut profile = CharacterProfile::new("Tester");
        profile.active_loadout_mut().classes = vec!["Shaman".to_string()];

        let triggers = [active, wrong_class, disabled];
        let targets = effective_training_targets(triggers.iter(), &profile).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].trigger_id, "debuffs/shaman/cast/odium");
    }
}
