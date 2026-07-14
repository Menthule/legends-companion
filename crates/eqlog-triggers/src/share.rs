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

use std::collections::{BTreeMap, HashMap, HashSet};
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
///
/// The `version`/`author`/`notes` metadata is additive (added for
/// version-aware re-import): every field is `Option` + `skip_serializing_if`
/// plus `default`. Payloads without them decode exactly as before, and omit
/// them when serialized, so the `LCS1:` wire prefix does NOT bump.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SharePayload {
    /// Human label for the bundle ("Kael Raid Pack", a loadout name, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Free-form pack version label ("1.2", "2026-07-13", …), shown in the
    /// import preview so users can tell a re-shared update from the original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Who built the pack (character or handle — whatever they typed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Release notes / description carried alongside the triggers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub triggers: Vec<Trigger>,
}

/// Result of [`parse_string`]: the decoded triggers (id-deduped, sources
/// stamped [`TriggerSource::Shared`]) plus what the dedupe did, for the
/// import summary dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareImport {
    /// The payload's bundle label, if the exporter set one.
    pub name: Option<String>,
    /// Pack version label from the payload metadata, if any.
    pub version: Option<String>,
    /// Pack author from the payload metadata, if any.
    pub author: Option<String>,
    /// Pack notes from the payload metadata, if any.
    pub notes: Option<String>,
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

/// Decode a share string to its raw [`SharePayload`] — no id dedupe, no
/// source stamping. This is the primitive [`parse_string`] builds on; use it
/// directly when the caller wants to diff/merge against an existing library
/// instead of blindly renaming collisions (version-aware re-import).
/// Surrounding whitespace and line wrapping inside the base64 (chat clients
/// love inserting breaks) are tolerated.
pub fn decode_string(input: &str) -> Result<SharePayload, ShareError> {
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
    Ok(serde_json::from_slice(&json)?)
}

/// Decode a share string produced by [`export_string`].
///
/// `existing_ids` are the effective ids already present in the target
/// library; any imported trigger whose [`Trigger::effective_id`] collides
/// with them — or with an earlier trigger in the same paste — is assigned
/// the first free `-2`/`-3`/… suffixed id (recorded in
/// [`ShareImport::renamed`]). Every imported trigger's `source` becomes
/// [`TriggerSource::Shared`].
pub fn parse_string(
    input: &str,
    existing_ids: &HashSet<String>,
) -> Result<ShareImport, ShareError> {
    let payload = decode_string(input)?;

    let mut taken: HashSet<String> = existing_ids.clone();
    let mut renamed: Vec<(String, String)> = Vec::new();
    let mut triggers = payload.triggers;
    for trigger in &mut triggers {
        trigger.source = TriggerSource::Shared;
        let id = trigger.effective_id();
        if taken.contains(&id) {
            let new_id = free_suffixed_id(&id, &taken);
            trigger.id = Some(new_id.clone());
            renamed.push((id, new_id.clone()));
            taken.insert(new_id);
        } else {
            taken.insert(id);
        }
    }
    Ok(ShareImport {
        name: payload.name,
        version: payload.version,
        author: payload.author,
        notes: payload.notes,
        triggers,
        renamed,
    })
}

/// First free `<id>-2`/`-3`/… suffix not in `taken`.
fn free_suffixed_id(id: &str, taken: &HashSet<String>) -> String {
    let mut n = 2u32;
    loop {
        let candidate = format!("{id}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

// ---------------------------------------------------------------------------
// Version-aware re-import: per-trigger diff + update-in-place merge
// ---------------------------------------------------------------------------

/// How one stable id compares between an incoming payload and the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    /// Incoming id not present in the existing set.
    Added,
    /// Same id on both sides, semantic definition differs.
    Changed,
    /// Existing id absent from the incoming payload (only meaningful when
    /// the caller scopes `existing` to a prior version of the same bundle).
    Removed,
    /// Same id on both sides, semantically identical.
    Unchanged,
}

/// One row of a [`diff_triggers`] result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriggerDiffEntry {
    /// Stable [`Trigger::effective_id`].
    pub id: String,
    /// Display name (incoming side when present there, else existing side).
    pub name: String,
    pub kind: DiffKind,
    /// The semantic fields that differ ([`DiffKind::Changed`] only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changed_fields: Vec<&'static str>,
}

/// The semantic definition fields that differ between two triggers with the
/// same stable id. `id` (equal by construction) and `source` (re-stamped on
/// every import) are deliberately excluded — a re-shared pack whose triggers
/// only changed provenance is "unchanged".
fn changed_fields(a: &Trigger, b: &Trigger) -> Vec<&'static str> {
    let mut out = Vec::new();
    if a.name != b.name {
        out.push("name");
    }
    if a.icon != b.icon {
        out.push("icon");
    }
    if a.pattern != b.pattern {
        out.push("pattern");
    }
    if a.enabled != b.enabled {
        out.push("enabled");
    }
    if a.actions != b.actions {
        out.push("actions");
    }
    if a.category != b.category {
        out.push("category");
    }
    if a.comments != b.comments {
        out.push("comments");
    }
    if a.case_insensitive != b.case_insensitive {
        out.push("case_insensitive");
    }
    if a.classes != b.classes {
        out.push("classes");
    }
    if a.default_enabled != b.default_enabled {
        out.push("default_enabled");
    }
    if a.cooldown_secs != b.cooldown_secs {
        out.push("cooldown_secs");
    }
    if a.priority != b.priority {
        out.push("priority");
    }
    if a.suppress != b.suppress {
        out.push("suppress");
    }
    if a.zones != b.zones {
        out.push("zones");
    }
    out
}

/// Per-trigger diff between an incoming payload and an existing trigger set,
/// keyed by stable [`Trigger::effective_id`]. Incoming triggers classify as
/// [`DiffKind::Added`] / [`DiffKind::Changed`] / [`DiffKind::Unchanged`]
/// (payload order); existing ids missing from the payload append as
/// [`DiffKind::Removed`] — meaningful only when the caller scopes `existing`
/// to what it believes is a prior version of the same bundle (e.g. the
/// Shared-source triggers of the user pack), so scope accordingly.
pub fn diff_triggers(incoming: &[Trigger], existing: &[Trigger]) -> Vec<TriggerDiffEntry> {
    let mut by_id: HashMap<String, &Trigger> = HashMap::new();
    for t in existing {
        by_id.entry(t.effective_id()).or_insert(t);
    }
    let mut entries = Vec::with_capacity(incoming.len());
    let mut seen: HashSet<String> = HashSet::new();
    for t in incoming {
        let id = t.effective_id();
        seen.insert(id.clone());
        let entry = match by_id.get(&id) {
            None => TriggerDiffEntry {
                id,
                name: t.name.clone(),
                kind: DiffKind::Added,
                changed_fields: Vec::new(),
            },
            Some(prior) => {
                let fields = changed_fields(t, prior);
                TriggerDiffEntry {
                    id,
                    name: t.name.clone(),
                    kind: if fields.is_empty() {
                        DiffKind::Unchanged
                    } else {
                        DiffKind::Changed
                    },
                    changed_fields: fields,
                }
            }
        };
        entries.push(entry);
    }
    for t in existing {
        let id = t.effective_id();
        if !seen.contains(&id) {
            seen.insert(id.clone());
            entries.push(TriggerDiffEntry {
                id,
                name: t.name.clone(),
                kind: DiffKind::Removed,
                changed_fields: Vec::new(),
            });
        }
    }
    entries
}

/// What [`merge_update_user_pack`] did, for the import summary.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MergeOutcome {
    /// Ids replaced in place (existing Shared-source triggers).
    pub updated: Vec<String>,
    /// Effective ids appended as new triggers (includes the renamed ones,
    /// under their assigned ids).
    pub added: Vec<String>,
    /// `(colliding id, assigned id)` pairs for appended triggers whose id
    /// collided with something not updatable in place.
    pub renamed: Vec<(String, String)>,
}

/// Merge an incoming payload's triggers into the user pack, updating
/// matching Shared-source triggers **in place by stable id** instead of
/// duplicate-renaming them. This is the "Update in place" re-import path:
/// because the id never changes, every per-id user override (loadout
/// enables, speak/alert channel overrides, severity, zone scopes, timings)
/// keeps applying to the updated definition.
///
/// - Incoming id matches a Shared-source trigger in `user_pack` → that entry
///   is replaced in place (position preserved), recorded in
///   [`MergeOutcome::updated`].
/// - Incoming id collides with anything else (`external_ids` — e.g. bundled
///   packs — or non-Shared user triggers, or an earlier trigger in the same
///   payload) → suffixed `-2`/`-3`/… and appended (the classic behavior).
/// - Otherwise → appended under its own id.
///
/// Every incoming trigger is stamped [`TriggerSource::Shared`] first.
pub fn merge_update_user_pack(
    incoming: Vec<Trigger>,
    user_pack: &mut Vec<Trigger>,
    external_ids: &HashSet<String>,
) -> MergeOutcome {
    let mut outcome = MergeOutcome::default();
    let mut shared_at: HashMap<String, usize> = HashMap::new();
    let mut taken: HashSet<String> = external_ids.clone();
    for (i, t) in user_pack.iter().enumerate() {
        let id = t.effective_id();
        if t.source == TriggerSource::Shared {
            shared_at.entry(id.clone()).or_insert(i);
        }
        taken.insert(id);
    }
    for mut trigger in incoming {
        trigger.source = TriggerSource::Shared;
        let id = trigger.effective_id();
        if let Some(idx) = shared_at.remove(&id) {
            // In-place update: id and position preserved, so per-id user
            // overrides keep binding. (Removed from the map so a duplicate
            // id later in the same payload falls through to the rename arm.)
            user_pack[idx] = trigger;
            outcome.updated.push(id);
            continue;
        }
        if taken.contains(&id) {
            let new_id = free_suffixed_id(&id, &taken);
            trigger.id = Some(new_id.clone());
            taken.insert(new_id.clone());
            outcome.renamed.push((id, new_id.clone()));
            outcome.added.push(new_id);
        } else {
            taken.insert(id.clone());
            outcome.added.push(id);
        }
        user_pack.push(trigger);
    }
    outcome
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
            // Generic overlay destinations have no GINA equivalent.
            Action::Overlay { .. } => {}
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
            // GINA has no Impact-overlay concept; dropped on export.
            Action::Impact { .. } => {}
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

    use crate::model::Action;

    fn trig(id: &str, name: &str, pattern: &str) -> Trigger {
        let mut t = Trigger::new(name, pattern, vec![]);
        t.id = Some(id.to_string());
        t
    }

    /// Build a share string straight from raw JSON (bypassing SharePayload)
    /// — simulates strings produced by other/older builds of the exporter.
    fn encode_raw_json(json: &str) -> String {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(json.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        format!("{SHARE_PREFIX}{}", b64_encode(&compressed))
    }

    #[test]
    fn metadata_round_trips_through_the_wire() {
        let payload = SharePayload {
            name: Some("Kael Raid Pack".into()),
            version: Some("1.2".into()),
            author: Some("Nyasha".into()),
            notes: Some("adds slow-resist calls".into()),
            triggers: vec![trig("a/b", "T", "^x$")],
        };
        let s = export_string(&payload);
        assert_eq!(decode_string(&s).unwrap(), payload);
        let import = parse_string(&s, &HashSet::new()).unwrap();
        assert_eq!(import.version.as_deref(), Some("1.2"));
        assert_eq!(import.author.as_deref(), Some("Nyasha"));
        assert_eq!(import.notes.as_deref(), Some("adds slow-resist calls"));
    }

    #[test]
    fn old_strings_without_metadata_still_parse() {
        // The exact v1 JSON shape ({name?, triggers}) — no metadata keys.
        let s = encode_raw_json(
            r#"{"name":"Old Pack","triggers":[{"name":"t","pattern":"^x$","actions":[]}]}"#,
        );
        let payload = decode_string(&s).unwrap();
        assert_eq!(payload.name.as_deref(), Some("Old Pack"));
        assert_eq!(payload.version, None);
        assert_eq!(payload.author, None);
        assert_eq!(payload.notes, None);
        assert_eq!(payload.triggers.len(), 1);
        assert!(parse_string(&s, &HashSet::new()).is_ok());
    }

    #[test]
    fn unset_metadata_stays_off_the_wire_for_old_importers() {
        // A new exporter with no metadata must emit the exact old JSON shape
        // so pre-metadata builds (and the strict TS mirror) keep working.
        let payload = SharePayload {
            name: Some("p".into()),
            triggers: vec![trig("a", "T", "^x$")],
            ..Default::default()
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("version"));
        assert!(!json.contains("author"));
        assert!(!json.contains("notes"));
    }

    #[test]
    fn unknown_payload_fields_are_tolerated() {
        // Forward compatibility: a FUTURE exporter adding more metadata must
        // not brick today's importer (serde ignores unknown fields).
        let s = encode_raw_json(
            r#"{"name":"p","future_field":123,"triggers":[{"name":"t","pattern":"^x$","actions":[]}]}"#,
        );
        assert_eq!(decode_string(&s).unwrap().triggers.len(), 1);
    }

    #[test]
    fn diff_classifies_added_changed_removed_unchanged() {
        let mut changed_new = trig("pack/changed", "Changed", "^new pattern$");
        changed_new.cooldown_secs = Some(5);
        let changed_old = trig("pack/changed", "Changed", "^old pattern$");
        let unchanged = trig("pack/same", "Same", "^same$");
        let added = trig("pack/new", "New", "^n$");
        let removed = trig("pack/gone", "Gone", "^g$");

        let incoming = vec![added.clone(), changed_new, unchanged.clone()];
        let existing = vec![changed_old, unchanged, removed];
        let entries = diff_triggers(&incoming, &existing);

        assert_eq!(entries.len(), 4);
        assert_eq!(
            (entries[0].id.as_str(), entries[0].kind),
            ("pack/new", DiffKind::Added)
        );
        assert_eq!(entries[1].kind, DiffKind::Changed);
        assert_eq!(entries[1].changed_fields, vec!["pattern", "cooldown_secs"]);
        assert_eq!(entries[2].kind, DiffKind::Unchanged);
        assert!(entries[2].changed_fields.is_empty());
        assert_eq!(
            (entries[3].id.as_str(), entries[3].kind),
            ("pack/gone", DiffKind::Removed)
        );
    }

    #[test]
    fn diff_ignores_source_and_reports_action_changes() {
        // Source differs (Shared vs User) but nothing semantic: unchanged.
        let mut a = trig("x", "X", "^x$");
        a.source = TriggerSource::Shared;
        let b = trig("x", "X", "^x$");
        assert_eq!(
            diff_triggers(std::slice::from_ref(&a), std::slice::from_ref(&b))[0].kind,
            DiffKind::Unchanged
        );
        // An action change is semantic.
        let mut c = b.clone();
        c.actions = vec![Action::Speak {
            template: "hi".into(),
        }];
        let entries = diff_triggers(&[c], &[b]);
        assert_eq!(entries[0].kind, DiffKind::Changed);
        assert_eq!(entries[0].changed_fields, vec!["actions"]);
    }

    #[test]
    fn merge_updates_shared_in_place_preserving_position_and_id() {
        let mut user_own = trig("mine", "Mine", "^m$");
        user_own.source = TriggerSource::User;
        let mut old_shared = trig("pack/t", "Old name", "^old$");
        old_shared.source = TriggerSource::Shared;
        let mut tail = trig("tail", "Tail", "^t$");
        tail.source = TriggerSource::User;
        let mut pack = vec![user_own, old_shared, tail];

        let incoming = vec![
            trig("pack/t", "New name", "^new$"),
            trig("pack/extra", "Extra", "^e$"),
        ];
        let outcome = merge_update_user_pack(incoming, &mut pack, &HashSet::new());

        assert_eq!(outcome.updated, vec!["pack/t"]);
        assert_eq!(outcome.added, vec!["pack/extra"]);
        assert!(outcome.renamed.is_empty());
        // Position 1 replaced in place, id unchanged, source stamped Shared.
        assert_eq!(pack.len(), 4);
        assert_eq!(pack[1].effective_id(), "pack/t");
        assert_eq!(pack[1].name, "New name");
        assert_eq!(pack[1].pattern, "^new$");
        assert_eq!(pack[1].source, TriggerSource::Shared);
        assert_eq!(pack[3].effective_id(), "pack/extra");
        assert_eq!(pack[3].source, TriggerSource::Shared);
    }

    #[test]
    fn merge_renames_non_updatable_collisions() {
        // Collides with a USER trigger (not updatable) and with a bundled
        // pack id (external): both get the classic -2 suffix treatment.
        let mut user_own = trig("mine", "Mine", "^m$");
        user_own.source = TriggerSource::User;
        let mut pack = vec![user_own];
        let external: HashSet<String> = ["bundled/x".to_string()].into();

        let incoming = vec![
            trig("mine", "Mine v2", "^m2$"),
            trig("bundled/x", "X", "^x$"),
        ];
        let outcome = merge_update_user_pack(incoming, &mut pack, &external);

        assert!(outcome.updated.is_empty());
        assert_eq!(
            outcome.renamed,
            vec![
                ("mine".to_string(), "mine-2".to_string()),
                ("bundled/x".to_string(), "bundled/x-2".to_string())
            ]
        );
        assert_eq!(outcome.added, vec!["mine-2", "bundled/x-2"]);
        assert_eq!(pack.len(), 3);
        // The original user trigger is untouched.
        assert_eq!(pack[0].name, "Mine");
        assert_eq!(pack[0].source, TriggerSource::User);
    }

    #[test]
    fn merge_duplicate_incoming_ids_update_once_then_rename() {
        let mut old_shared = trig("pack/t", "Old", "^old$");
        old_shared.source = TriggerSource::Shared;
        let mut pack = vec![old_shared];
        let incoming = vec![
            trig("pack/t", "First", "^1$"),
            trig("pack/t", "Second", "^2$"),
        ];
        let outcome = merge_update_user_pack(incoming, &mut pack, &HashSet::new());
        assert_eq!(outcome.updated, vec!["pack/t"]);
        assert_eq!(
            outcome.renamed,
            vec![("pack/t".to_string(), "pack/t-2".to_string())]
        );
        assert_eq!(pack[0].name, "First");
        assert_eq!(pack[1].effective_id(), "pack/t-2");
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
