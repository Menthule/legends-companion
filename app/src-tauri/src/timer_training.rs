//! Read-only diagnostics for learning exact per-rank timer values from the
//! configured EQ log. Applying an estimate remains an explicit profile write
//! in the frontend; this module never mutates trigger or profile state.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};

use eqlog_core::events::Entity;
use eqlog_core::parser::Parser;
use eqlog_core::Event;
use eqlog_triggers::model::Action;
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

fn training_target(
    app: &AppHandle,
    cfg: &crate::config::AppConfig,
    trigger_id: &str,
) -> Result<TrainingTarget, String> {
    let library = crate::library::load_library(app, cfg)?;
    let trigger = library
        .packs
        .iter()
        .chain(library.user.iter())
        .find(|trigger| trigger.effective_id() == trigger_id)
        .ok_or_else(|| format!("Timer trigger {trigger_id:?} was not found."))?;
    if !trigger.pattern.contains("rank") {
        return Err(format!("{} is not a rank-aware trigger.", trigger.name));
    }
    let timer = trigger.actions.iter().find_map(|action| match action {
        Action::StartTimer {
            name,
            duration_secs,
            cast_time_secs,
            ..
        } if !name.contains("${") => Some((name, *duration_secs, cast_time_secs.unwrap_or(0))),
        _ => None,
    });
    let Some((timer_name, duration, cast_time)) = timer else {
        return Err(format!(
            "{} does not have a fixed-name start-timer action.",
            trigger.name
        ));
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
    Ok(TrainingTarget {
        trigger_id: trigger.effective_id(),
        trigger_name: trigger.name.clone(),
        timer_name: timer_name.clone(),
        configured_duration_secs: duration,
        configured_cast_time_secs: cast_time,
        cast_pattern,
    })
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
            confidence,
            reason,
            can_apply: duration_estimate.is_some() || cast_estimate.is_some(),
            samples: samples.into_iter().rev().take(5).collect(),
        });
    }
    ranks.sort_by(|a, b| a.rank.len().cmp(&b.rank.len()).then(a.rank.cmp(&b.rank)));

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
}
