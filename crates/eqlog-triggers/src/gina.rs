//! GINA .gtp package import. A `.gtp` is a zip archive containing an XML
//! trigger-share document (`TriggerGroup` trees with `Trigger` children);
//! bare XML is accepted too. Import is best-effort: individual malformed
//! triggers are skipped with a warning, only unreadable input is an error.

use std::collections::BTreeMap;
use std::io::Read;

use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader;
use regex::Regex;

use crate::engine::expand_pattern;
use crate::model::{Action, TimerStartMode, Trigger};

#[derive(Debug, thiserror::Error)]
pub enum GinaImportError {
    #[error("invalid gtp archive: {0}")]
    Archive(String),
    #[error("invalid trigger xml: {0}")]
    Xml(String),
}

/// Result of a best-effort import: the triggers that converted cleanly plus
/// one warning per trigger (or file) that had to be skipped.
#[derive(Debug, Default)]
pub struct GinaImport {
    pub triggers: Vec<Trigger>,
    pub warnings: Vec<String>,
}

/// Import a GINA package from raw bytes. Accepts a `.gtp` zip (sniffed by
/// the `PK` magic) or a bare XML document. Never panics on malformed input.
pub fn import_gtp(bytes: &[u8]) -> Result<GinaImport, GinaImportError> {
    let mut import = GinaImport::default();
    if bytes.starts_with(b"PK") {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| GinaImportError::Archive(e.to_string()))?;
        let mut xml_files = 0usize;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| GinaImportError::Archive(e.to_string()))?;
            let name = file.name().to_ascii_lowercase();
            if !name.ends_with(".xml") {
                continue;
            }
            xml_files += 1;
            let mut raw = Vec::new();
            file.read_to_end(&mut raw)
                .map_err(|e| GinaImportError::Archive(e.to_string()))?;
            let text = String::from_utf8_lossy(&raw);
            parse_share_xml(&text, &mut import)?;
        }
        if xml_files == 0 {
            return Err(GinaImportError::Archive(
                "no .xml trigger file found in archive".into(),
            ));
        }
    } else {
        let text = String::from_utf8_lossy(bytes);
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        if !trimmed.starts_with('<') {
            return Err(GinaImportError::Archive(
                "input is neither a zip archive nor an XML document".into(),
            ));
        }
        parse_share_xml(trimmed, &mut import)?;
    }
    Ok(import)
}

/// Streaming parse of a GINA share XML document. Tracks the open
/// `TriggerGroup` name stack to build category paths; collects the direct
/// text children of each `Trigger` element into a key→value map.
fn parse_share_xml(xml: &str, import: &mut GinaImport) -> Result<(), GinaImportError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    /// One open TriggerGroup; its Name child fills `name` when seen.
    struct Group {
        name: Option<String>,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut path: Vec<String> = Vec::new();
    let mut in_trigger_at: Option<usize> = None; // depth of the open <Trigger>
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut saw_element = false;

    loop {
        match reader.read_event() {
            Ok(XmlEvent::Start(e)) => {
                saw_element = true;
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "TriggerGroup" {
                    groups.push(Group { name: None });
                } else if name == "Trigger" && in_trigger_at.is_none() {
                    in_trigger_at = Some(path.len());
                    fields.clear();
                }
                path.push(name);
            }
            Ok(XmlEvent::Empty(_)) => {
                saw_element = true;
            }
            Ok(XmlEvent::Text(t)) => {
                let text = t
                    .unescape()
                    .map_err(|e| GinaImportError::Xml(e.to_string()))?
                    .into_owned();
                if let Some(depth) = in_trigger_at {
                    // Only direct children of <Trigger> (e.g. Name, TriggerText).
                    if path.len() == depth + 2 {
                        if let Some(field) = path.last() {
                            fields.push((field.clone(), text));
                        }
                    }
                } else if path.len() >= 2
                    && path[path.len() - 1] == "Name"
                    && path[path.len() - 2] == "TriggerGroup"
                {
                    if let Some(group) = groups.last_mut() {
                        if group.name.is_none() {
                            group.name = Some(text);
                        }
                    }
                }
            }
            Ok(XmlEvent::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                path.pop();
                if name == "Trigger" && in_trigger_at == Some(path.len()) {
                    in_trigger_at = None;
                    let category: Vec<&str> =
                        groups.iter().filter_map(|g| g.name.as_deref()).collect();
                    let category = if category.is_empty() {
                        None
                    } else {
                        Some(category.join("/"))
                    };
                    match build_trigger(&fields, category) {
                        Ok((trigger, warnings)) => {
                            import.warnings.extend(warnings);
                            import.triggers.push(trigger);
                        }
                        Err(warning) => import.warnings.push(warning),
                    }
                } else if name == "TriggerGroup" {
                    groups.pop();
                }
            }
            Ok(XmlEvent::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(GinaImportError::Xml(e.to_string())),
        }
    }
    if !saw_element {
        return Err(GinaImportError::Xml("document contains no elements".into()));
    }
    Ok(())
}

fn field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn has_field(fields: &[(String, String)], key: &str) -> bool {
    fields.iter().any(|(k, v)| k == key && !v.trim().is_empty())
}

fn is_true(value: Option<&str>) -> bool {
    value.is_some_and(|v| v.eq_ignore_ascii_case("true") || v == "1")
}

/// Regex-escape a plain-text GINA trigger while keeping `{C}`/`{S}`/`{N}`
/// tokens live (escape turns `{C}` into `\{C\}`; undo that for tokens).
fn escape_keeping_tokens(text: &str) -> String {
    let escaped = regex::escape(text);
    let token_re = Regex::new(r"\\\{([CcSsNn]\d*)\\}").expect("valid");
    token_re.replace_all(&escaped, "{$1}").into_owned()
}

/// Convert GINA display/TTS template token forms (`{S1}`, `{N}`) into the
/// engine's `${...}` capture references. `{C}` and `{TS}` pass through.
fn gina_template(text: &str) -> String {
    let token_re = Regex::new(r"\{([SsNn]\d*)\}").expect("valid");
    token_re
        .replace_all(text, |caps: &regex::Captures| {
            format!("${{{}}}", caps[1].to_ascii_uppercase())
        })
        .into_owned()
}

fn build_trigger(
    fields: &[(String, String)],
    category: Option<String>,
) -> Result<(Trigger, Vec<String>), String> {
    let name = field(fields, "Name")
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "trigger skipped: missing Name".to_string())?
        .to_string();
    let text = field(fields, "TriggerText")
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("trigger '{name}' skipped: missing TriggerText"))?;

    let pattern = if is_true(field(fields, "EnableRegex")) {
        text.to_string()
    } else {
        escape_keeping_tokens(text)
    };
    // Validate with a placeholder character name so broken regexes are
    // skipped at import time rather than at engine build.
    let probe = format!("(?i){}", expand_pattern(&pattern, "Xyzzy"));
    Regex::new(&probe)
        .map_err(|e| format!("trigger '{name}' skipped: bad pattern '{pattern}': {e}"))?;

    let mut actions = Vec::new();
    if is_true(field(fields, "UseText")) {
        if let Some(display) = field(fields, "DisplayText").filter(|d| !d.is_empty()) {
            actions.push(Action::DisplayText {
                template: gina_template(display),
            });
        }
    }
    if is_true(field(fields, "UseTextToVoice")) {
        if let Some(tts) = field(fields, "TextToVoiceText").filter(|t| !t.is_empty()) {
            actions.push(Action::Speak {
                template: gina_template(tts),
            });
        }
    }
    let mut skipped_empty_media = false;
    if is_true(field(fields, "PlayMediaFile")) {
        // A PlaySound with an empty path is a no-op that can shadow a real
        // sound at play time — skip it and warn instead (P43).
        match field(fields, "MediaFileName").filter(|p| !p.is_empty()) {
            Some(path) => actions.push(Action::PlaySound {
                path: path.to_string(),
            }),
            None => skipped_empty_media = true,
        }
    }
    let mut warnings = Vec::new();
    if skipped_empty_media {
        warnings.push(format!(
            "trigger '{name}': PlayMediaFile was set but MediaFileName was empty; sound action skipped"
        ));
    }
    let timer_type = field(fields, "TimerType").unwrap_or("");
    if has_field(fields, "TimerEarlyEnders") || has_field(fields, "TimerEarlyEnder") {
        warnings.push(format!(
            "trigger '{name}': GINA timer early enders are not imported yet; add CancelTimer triggers manually if needed"
        ));
    }
    if has_field(fields, "TimerEndedTrigger") || has_field(fields, "TimerEndingTrigger") {
        warnings.push(format!(
            "trigger '{name}': GINA nested timer-ending/ended trigger actions were reduced to timer labels where possible"
        ));
    }
    if !timer_type.is_empty() && !timer_type.eq_ignore_ascii_case("NoTimer") {
        let duration = field(fields, "TimerDuration")
            .and_then(|d| d.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let stopwatch = timer_type.eq_ignore_ascii_case("Stopwatch");
        if duration > 0 || stopwatch {
            let timer_name = field(fields, "TimerName")
                .filter(|n| !n.is_empty())
                .unwrap_or(&name);
            let warn = field(fields, "TimerEndingTime")
                .and_then(|w| w.trim().parse::<u64>().ok())
                .filter(|w| *w > 0 && *w < duration);
            let behavior = field(fields, "TimerStartBehavior")
                .or_else(|| field(fields, "TimerStartMode"))
                .unwrap_or("");
            let mode = if behavior.to_ascii_lowercase().contains("ignore")
                || behavior.to_ascii_lowercase().contains("do not")
            {
                Some(TimerStartMode::IgnoreIfRunning)
            } else if behavior.to_ascii_lowercase().contains("new") {
                Some(TimerStartMode::StartNewInstance)
            } else {
                None
            };
            let repeating = timer_type.to_ascii_lowercase().contains("repeat")
                || is_true(field(fields, "TimerRepeats"))
                || is_true(field(fields, "TimerRepeat"));
            actions.push(Action::StartTimer {
                name: gina_template(timer_name),
                duration_secs: duration,
                warn_at_secs: warn,
                duration_formula: None,
                duration_cap_ticks: None,
                cast_time_secs: None,
                rank_variants: BTreeMap::new(),
                lane: None,
                mode,
                repeat_secs: repeating.then_some(duration).filter(|s| *s > 0),
                stopwatch,
                warn_text: field(fields, "TimerEndingDisplayText")
                    .or_else(|| field(fields, "TimerEndingTextToVoiceText"))
                    .filter(|v| !v.is_empty())
                    .map(gina_template),
                expire_text: field(fields, "TimerEndedDisplayText")
                    .or_else(|| field(fields, "TimerEndedTextToVoiceText"))
                    .filter(|v| !v.is_empty())
                    .map(gina_template),
                warn_sound: field(fields, "TimerEndingMediaFileName")
                    .filter(|v| !v.is_empty())
                    .map(str::to_string),
                expire_sound: field(fields, "TimerEndedMediaFileName")
                    .filter(|v| !v.is_empty())
                    .map(str::to_string),
            });
            if stopwatch {
                warnings.push(format!(
                    "trigger '{name}': imported GINA stopwatch as a zero-duration timer; overlay elapsed-time display is limited"
                ));
            }
        }
    }

    let comments = field(fields, "Comments")
        .filter(|c| !c.is_empty())
        .map(str::to_string);

    Ok((
        Trigger {
            name,
            icon: None,
            pattern,
            event: None,
            enabled: true,
            actions,
            category,
            comments,
            case_insensitive: true,
            id: None,
            classes: Vec::new(),
            default_enabled: true,
            track_when_observed: false,
            source: crate::model::TriggerSource::Gina,
            cooldown_secs: None,
            priority: 0,
            suppress: false,
            zones: Vec::new(),
        },
        warnings,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_keeps_tokens() {
        let out = escape_keeping_tokens("{C} has fallen (dead) x{N}");
        assert!(out.contains("{C}"), "token {{C}} must survive: {out}");
        assert!(out.contains("{N}"), "token {{N}} must survive: {out}");
        assert!(out.contains(r"\(dead\)"), "parens must be escaped: {out}");
        // and the result must still expand+compile
        let expanded = crate::engine::expand_pattern(&out, "Nyasha");
        assert!(Regex::new(&expanded).is_ok());
    }

    #[test]
    fn gina_template_converts_capture_tokens() {
        assert_eq!(
            gina_template("{S1} slain, {C} at {TS}"),
            "${S1} slain, {C} at {TS}"
        );
    }

    #[test]
    fn empty_gina_media_is_skipped_with_warning() {
        // PlayMediaFile set but MediaFileName absent must NOT yield an empty
        // PlaySound (which shadows real sounds at play time) (P43).
        let fields = vec![
            ("Name".to_string(), "Test".to_string()),
            ("TriggerText".to_string(), "hello".to_string()),
            ("PlayMediaFile".to_string(), "1".to_string()),
        ];
        let (trigger, warnings) = build_trigger(&fields, None).unwrap();
        assert!(
            !trigger
                .actions
                .iter()
                .any(|a| matches!(a, Action::PlaySound { .. })),
            "empty media must not produce a PlaySound action"
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("MediaFileName was empty")),
            "expected a skip warning, got {warnings:?}"
        );
    }
}
