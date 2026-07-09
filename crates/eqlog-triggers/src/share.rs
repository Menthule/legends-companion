//! Sharing v1 (NOW-sprint item 8): serialize triggers to a compact,
//! paste-anywhere share string and to a GINA-compatible `.gtp` archive.
//!
//! Share strings are `"LCS1:" + base64(deflate(json))` where the JSON is a
//! [`SharePayload`]. `LCS1` (Legends Companion Share, v1) is the wire
//! version: breaking payload changes bump the prefix. Import
//! ([`parse_string`]) dedupes on id collision by suffixing `-2`, `-3`, … so
//! pasting a string twice (or importing over an existing library) never
//! creates two triggers with one id.
//!
//! GINA export ([`export_gtp`]) is the inverse of [`crate::gina::import_gtp`]
//! and reuses its field vocabulary (`Name`, `TriggerText`, `EnableRegex`,
//! `UseTextToVoice`, `TimerType`, …). Lossy by design — GINA has no concept
//! of lanes, classes, level-scaling formulas, or `CancelTimer` actions — but
//! everything GINA *can* express round-trips through our own importer.
//!
//! Base64 is implemented inline (standard alphabet, padded): the sprint's
//! only approved new dependencies are rusqlite and flate2.

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};

use crate::model::{Action, Trigger, TriggerSource};

/// Wire prefix of a v1 share string.
pub const SHARE_PREFIX: &str = "LCS1:";

/// Inflated-payload cap: a hostile share string must not balloon into
/// gigabytes of JSON. 32 MiB comfortably fits the full 1,647-trigger library
/// many times over.
const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

/// What travels inside a share string: an optional label (pack or loadout
/// name, shown in the import summary) plus the triggers themselves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SharePayload {
    /// Human label for the bundle ("Kael Raid Pack", a loadout name, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub triggers: Vec<Trigger>,
}

/// Result of [`parse_string`]: the decoded triggers (id-deduped, sources
/// stamped [`TriggerSource::Shared`]) plus what the dedupe did, for the
/// import summary dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareImport {
    /// The payload's bundle label, if the exporter set one.
    pub name: Option<String>,
    pub triggers: Vec<Trigger>,
    /// `(colliding id, assigned id)` for every trigger that had to be
    /// renamed to avoid an id collision (against `existing_ids` or within
    /// the imported set itself).
    pub renamed: Vec<(String, String)>,
}

/// Errors from share-string parsing and `.gtp` export.
#[derive(Debug, thiserror::Error)]
pub enum ShareError {
    #[error("not a Legends Companion share string (expected the `LCS1:` prefix)")]
    BadPrefix,
    #[error("share string is not valid base64: {0}")]
    Base64(String),
    #[error("share string payload failed to inflate: {0}")]
    Inflate(String),
    #[error("share string payload exceeds the {MAX_PAYLOAD_BYTES}-byte safety cap")]
    TooLarge,
    #[error("share payload JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("gtp archive write failed: {0}")]
    Gtp(String),
}

/// Serialize `payload` to a paste-anywhere share string:
/// `"LCS1:" + base64(deflate(json))`.
pub fn export_string(payload: &SharePayload) -> String {
    let json = serde_json::to_vec(payload).expect("SharePayload serialization is infallible");
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&json)
        .and_then(|()| encoder.finish())
        .map(|compressed| format!("{SHARE_PREFIX}{}", b64_encode(&compressed)))
        .expect("in-memory deflate cannot fail")
}

/// Decode a share string produced by [`export_string`].
///
/// `existing_ids` are the effective ids already present in the target
/// library; any imported trigger whose [`Trigger::effective_id`] collides
/// with them — or with an earlier trigger in the same paste — is assigned
/// the first free `-2`/`-3`/… suffixed id (recorded in
/// [`ShareImport::renamed`]). Every imported trigger's `source` becomes
/// [`TriggerSource::Shared`]. Surrounding whitespace and line wrapping
/// inside the base64 (chat clients love inserting breaks) are tolerated.
pub fn parse_string(
    input: &str,
    existing_ids: &HashSet<String>,
) -> Result<ShareImport, ShareError> {
    let trimmed = input.trim();
    let Some(encoded) = trimmed.strip_prefix(SHARE_PREFIX) else {
        return Err(ShareError::BadPrefix);
    };
    let compressed = b64_decode(encoded)?;
    let mut json = Vec::new();
    let mut decoder = DeflateDecoder::new(compressed.as_slice()).take(MAX_PAYLOAD_BYTES as u64 + 1);
    decoder
        .read_to_end(&mut json)
        .map_err(|e| ShareError::Inflate(e.to_string()))?;
    if json.len() > MAX_PAYLOAD_BYTES {
        return Err(ShareError::TooLarge);
    }
    let payload: SharePayload = serde_json::from_slice(&json)?;

    let mut taken: HashSet<String> = existing_ids.clone();
    let mut renamed: Vec<(String, String)> = Vec::new();
    let mut triggers = payload.triggers;
    for trigger in &mut triggers {
        trigger.source = TriggerSource::Shared;
        let id = trigger.effective_id();
        if taken.contains(&id) {
            let mut n = 2u32;
            let new_id = loop {
                let candidate = format!("{id}-{n}");
                if !taken.contains(&candidate) {
                    break candidate;
                }
                n += 1;
            };
            trigger.id = Some(new_id.clone());
            renamed.push((id, new_id.clone()));
            taken.insert(new_id);
        } else {
            taken.insert(id);
        }
    }
    Ok(ShareImport {
        name: payload.name,
        triggers,
        renamed,
    })
}

// ---------------------------------------------------------------------------
// GINA .gtp export
// ---------------------------------------------------------------------------

/// Export `triggers` as a GINA-compatible `.gtp` package (a zip holding one
/// share XML document). Inverse of [`crate::gina::import_gtp`]:
/// category paths become nested `TriggerGroup` elements; actions map onto
/// GINA's field vocabulary. Lossy where GINA has no equivalent:
/// `CancelTimer` actions, lanes, classes, ids and duration formulas are
/// dropped, and only the first action of each kind (speak / display /
/// sound / timer) is emitted — GINA holds at most one of each per trigger.
pub fn export_gtp(package_name: &str, triggers: &[Trigger]) -> Result<Vec<u8>, ShareError> {
    let xml = share_xml(package_name, triggers);
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer
        .start_file("ShareData.xml", options)
        .map_err(|e| ShareError::Gtp(e.to_string()))?;
    writer
        .write_all(xml.as_bytes())
        .map_err(|e| ShareError::Gtp(e.to_string()))?;
    let cursor = writer
        .finish()
        .map_err(|e| ShareError::Gtp(e.to_string()))?;
    Ok(cursor.into_inner())
}

/// Category tree node for XML grouping.
#[derive(Default)]
struct GroupNode<'t> {
    groups: BTreeMap<String, GroupNode<'t>>,
    triggers: Vec<&'t Trigger>,
}

impl<'t> GroupNode<'t> {
    fn insert(&mut self, trigger: &'t Trigger) {
        let mut node = self;
        if let Some(category) = trigger.category.as_deref() {
            for segment in category.split('/').filter(|s| !s.is_empty()) {
                node = node.groups.entry(segment.to_string()).or_default();
            }
        }
        node.triggers.push(trigger);
    }
}

/// Build the GINA share XML document (the file inside the `.gtp` zip).
fn share_xml(package_name: &str, triggers: &[Trigger]) -> String {
    let mut root = GroupNode::default();
    for trigger in triggers {
        root.insert(trigger);
    }
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<SharedData>\n");
    // Wrap everything in one named group so GINA shows a single package
    // folder; our importer turns it into the top category segment only when
    // the trigger had one (uncategorized triggers go directly under it).
    xml.push_str("  <TriggerGroup>\n");
    write_tag(&mut xml, 4, "Name", package_name);
    write_group_children(&mut xml, &root, 4);
    xml.push_str("  </TriggerGroup>\n</SharedData>\n");
    xml
}

fn write_group_children(xml: &mut String, node: &GroupNode<'_>, indent: usize) {
    for trigger in &node.triggers {
        write_trigger(xml, trigger, indent);
    }
    for (name, child) in &node.groups {
        pad(xml, indent);
        xml.push_str("<TriggerGroup>\n");
        write_tag(xml, indent + 2, "Name", name);
        write_group_children(xml, child, indent + 2);
        pad(xml, indent);
        xml.push_str("</TriggerGroup>\n");
    }
}

fn write_trigger(xml: &mut String, trigger: &Trigger, indent: usize) {
    pad(xml, indent);
    xml.push_str("<Trigger>\n");
    let i = indent + 2;
    write_tag(xml, i, "Name", &trigger.name);
    // Our patterns are regexes (possibly with {C}/{S}/{N} tokens, which GINA
    // shares); always exported with EnableRegex so nothing is double-escaped.
    write_tag(xml, i, "TriggerText", &trigger.pattern);
    if let Some(comments) = trigger.comments.as_deref().filter(|c| !c.is_empty()) {
        write_tag(xml, i, "Comments", comments);
    }
    write_tag(xml, i, "EnableRegex", "True");

    let mut display: Option<&str> = None;
    let mut speak: Option<&str> = None;
    let mut sound: Option<&str> = None;
    let mut timer: Option<(&str, u64, Option<u64>)> = None;
    for action in &trigger.actions {
        match action {
            Action::DisplayText { template } => display = display.or(Some(template)),
            Action::Speak { template } => speak = speak.or(Some(template)),
            Action::PlaySound { path } => sound = sound.or(Some(path)),
            Action::StartTimer {
                name,
                duration_secs,
                warn_at_secs,
                ..
            } => timer = timer.or(Some((name.as_str(), *duration_secs, *warn_at_secs))),
            // No GINA equivalent (their early-enders live outside the field
            // set our importer reads); dropped by design.
            Action::CancelTimer { .. } => {}
            // GINA has no webhook concept; dropped on export.
            Action::PostWebhook { .. } => {}
        }
    }
    if let Some(template) = display {
        write_tag(xml, i, "UseText", "True");
        write_tag(xml, i, "DisplayText", &gina_text(template));
    }
    if let Some(template) = speak {
        write_tag(xml, i, "UseTextToVoice", "True");
        write_tag(xml, i, "TextToVoiceText", &gina_text(template));
    }
    if let Some(path) = sound {
        write_tag(xml, i, "PlayMediaFile", "True");
        write_tag(xml, i, "MediaFileName", path);
    }
    match timer {
        Some((name, duration, warn)) => {
            write_tag(xml, i, "TimerType", "Timer");
            write_tag(xml, i, "TimerName", &gina_text(name));
            write_tag(xml, i, "TimerDuration", &duration.to_string());
            if let Some(warn) = warn.filter(|w| *w > 0 && *w < duration) {
                write_tag(xml, i, "UseTimerEnding", "True");
                write_tag(xml, i, "TimerEndingTime", &warn.to_string());
            }
        }
        None => write_tag(xml, i, "TimerType", "NoTimer"),
    }
    pad(xml, indent);
    xml.push_str("</Trigger>\n");
}

/// Convert engine `${S1}`-style capture references back to GINA's `{S1}`
/// token form (inverse of `gina::gina_template`). `{C}`/`{TS}` pass through;
/// positional `${1}` references have no GINA spelling and are left as-is.
fn gina_text(template: &str) -> String {
    let re = regex::Regex::new(r"\$\{([SsNn]\d*)\}").expect("valid");
    re.replace_all(template, "{$1}").into_owned()
}

fn pad(xml: &mut String, indent: usize) {
    for _ in 0..indent {
        xml.push(' ');
    }
}

fn write_tag(xml: &mut String, indent: usize, tag: &str, text: &str) {
    pad(xml, indent);
    xml.push('<');
    xml.push_str(tag);
    xml.push('>');
    xml.push_str(&xml_escape(text));
    xml.push_str("</");
    xml.push_str(tag);
    xml.push_str(">\n");
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Inline base64 (standard alphabet, padded) — the sprint's approved new
// dependencies are rusqlite and flate2 only, so no base64 crate.
// ---------------------------------------------------------------------------

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Decode standard base64, ignoring ASCII whitespace (pasted strings get
/// line-wrapped by chat clients) and tolerating absent padding.
fn b64_decode(text: &str) -> Result<Vec<u8>, ShareError> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Some((byte - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding_seen = false;
    for &byte in text.as_bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            padding_seen = true;
            continue;
        }
        if padding_seen {
            return Err(ShareError::Base64("data after `=` padding".into()));
        }
        let Some(v) = value(byte) else {
            return Err(ShareError::Base64(format!(
                "invalid character {:?}",
                byte as char
            )));
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    // Leftover bits must be zero-value padding bits from a valid final
    // quantum (2 or 4 dangling bits); 6 dangling bits = truncated input.
    if bits == 6 {
        return Err(ShareError::Base64("truncated final group".into()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_and_matches_reference() {
        // RFC 4648 vectors.
        for (raw, encoded) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(b64_encode(raw), encoded);
            assert_eq!(b64_decode(encoded).unwrap(), raw);
        }
        // Whitespace/wrapping tolerated; garbage rejected.
        assert_eq!(b64_decode("Zm9v\nYmFy ").unwrap(), b"foobar");
        assert!(b64_decode("Zm9v!").is_err());
        assert!(b64_decode("Zm9vY").is_err(), "truncated group must fail");
        assert!(
            b64_decode("Zg==Zg").is_err(),
            "data after padding must fail"
        );
    }

    #[test]
    fn xml_escape_covers_the_five() {
        assert_eq!(
            xml_escape(r#"<a & "b's">"#),
            "&lt;a &amp; &quot;b&apos;s&quot;&gt;"
        );
    }

    #[test]
    fn gina_text_inverts_capture_tokens() {
        assert_eq!(
            gina_text("${S1} at {TS} for {C}, x${N2}"),
            "{S1} at {TS} for {C}, x{N2}"
        );
        assert_eq!(
            gina_text("keep ${sender} and ${1}"),
            "keep ${sender} and ${1}"
        );
    }
}
