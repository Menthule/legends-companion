//! Per-character enable resolution: layers the overrides of one [`Loadout`]
//! (classes + override map both live per loadout) on top of trigger defaults.
//!
//! Resolution order (first hit wins):
//! 1. Exact trigger-id override (`overrides["class/enchanter/cc/mez-broken"]`).
//! 2. Longest matching path-prefix override. A prefix matches a path only on
//!    `/` boundaries: `"Class/Enchanter"` matches `"Class/Enchanter/Mez"` and
//!    `"Class/Enchanter"` itself, but never `"Class/EnchanterX"`. Prefixes are
//!    tried against both the trigger's category path and its effective id, so
//!    group toggles work with either addressing scheme.
//! 3. Trigger defaults: `default_enabled` AND (trigger has no class
//!    restriction OR it intersects the profile's classes).
//!
//! All key/name comparisons are ASCII-case-insensitive so hand-edited profile
//! JSON doesn't silently miss (`"class/enchanter"` vs `"Class/Enchanter"`).
//!
//! Note this resolves *profile-level* enablement only; the pack-level hard
//! switch `Trigger::enabled` is applied separately (a trigger with
//! `enabled: false` never fires regardless of profile).

use crate::model::{CharacterProfile, Loadout, Trigger};

/// True when `path` equals `prefix` or starts with `prefix` followed by `/`
/// (ASCII-case-insensitive). Empty prefixes and empty paths never match.
fn path_has_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() || path.len() < prefix.len() {
        return false;
    }
    let head = &path[..prefix.len()];
    if !head.eq_ignore_ascii_case(prefix) {
        return false;
    }
    path.len() == prefix.len() || path.as_bytes()[prefix.len()] == b'/'
}

/// Whether `trigger` is enabled under the profile's *active* loadout — a
/// thin wrapper over [`effective_enabled_in_loadout`] for call sites that
/// hold a whole [`CharacterProfile`].
pub fn effective_enabled(trigger: &Trigger, profile: &CharacterProfile) -> bool {
    effective_enabled_in_loadout(trigger, profile.active_loadout())
}

/// Whether `trigger` is enabled under `loadout` — see the module docs for
/// the precedence rules. Does NOT consult `trigger.enabled` (the pack-level
/// hard switch); callers combine the two.
pub fn effective_enabled_in_loadout(trigger: &Trigger, loadout: &Loadout) -> bool {
    let id = trigger.effective_id();

    // 1. Exact trigger-id override.
    for (key, &value) in &loadout.overrides {
        if key.eq_ignore_ascii_case(&id) {
            return value;
        }
    }

    // 2. Longest matching path-prefix override, tried against both the
    //    category path and the effective id. Ties (distinct keys of equal
    //    length) resolve to the alphabetically-first key — the BTreeMap
    //    iteration order — for determinism.
    let category = trigger.category.as_deref().unwrap_or("");
    let mut best: Option<(usize, bool)> = None;
    for (key, &value) in &loadout.overrides {
        if !(path_has_prefix(category, key) || path_has_prefix(&id, key)) {
            continue;
        }
        if best.is_none_or(|(len, _)| key.len() > len) {
            best = Some((key.len(), value));
        }
    }
    if let Some((_, value)) = best {
        return value;
    }

    // 3. Defaults: default_enabled AND class intersection (empty trigger
    //    classes = applies to everyone).
    trigger.default_enabled
        && (trigger.classes.is_empty()
            || trigger
                .classes
                .iter()
                .any(|c| loadout.classes.iter().any(|p| p.eq_ignore_ascii_case(c))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_matches_on_slash_boundaries_only() {
        assert!(path_has_prefix("Class/Enchanter/Mez", "Class/Enchanter"));
        assert!(path_has_prefix("Class/Enchanter", "Class/Enchanter"));
        assert!(path_has_prefix("class/enchanter/mez", "Class/Enchanter"));
        assert!(!path_has_prefix("Class/EnchanterX", "Class/Enchanter"));
        assert!(!path_has_prefix("Class", "Class/Enchanter"));
        assert!(!path_has_prefix("Class/Enchanter", ""));
        assert!(!path_has_prefix("", "Class"));
    }
}
