// TypeScript port of the enable-resolution helpers in
// crates/eqlog-triggers/src/{model,profile}.rs — keep in sync. Used by mock
// mode (which has no Rust engine) and by the Triggers tab when it prunes
// stale override keys before a group toggle.

import { DEFAULT_LOADOUT_NAME, type CharacterProfile, type Loadout } from "./types";

/** Rust `slugify`: alphanumerics kept (lowercased), other runs collapse to `-`. */
export function slugify(s: string): string {
  let out = "";
  let pendingDash = false;
  for (const ch of s) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (pendingDash && out.length > 0) out += "-";
      pendingDash = false;
      out += ch.toLowerCase();
    } else {
      pendingDash = true;
    }
  }
  return out;
}

/** Slugify each `/` segment of a category path, dropping empty segments. */
export function slugifyPath(path: string): string {
  return path
    .split("/")
    .map(slugify)
    .filter((s) => s.length > 0)
    .join("/");
}

/** A trigger's stable id: explicit id, else slug of category path + name. */
export function deriveId(
  id: string | null | undefined,
  category: string | null | undefined,
  name: string,
): string {
  if (id) return id;
  const cat = category ? slugifyPath(category) : "";
  return cat ? `${cat}/${slugify(name)}` : slugify(name);
}

/**
 * True when `path` equals `prefix` or starts with `prefix` followed by `/`
 * (case-insensitive). Empty prefixes and paths never match.
 */
export function pathHasPrefix(path: string, prefix: string): boolean {
  if (prefix.length === 0 || path.length < prefix.length) return false;
  if (path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return false;
  }
  return path.length === prefix.length || path[prefix.length] === "/";
}

/** The fields resolution needs from a trigger. */
export interface ResolvableTrigger {
  id: string;
  category: string | null;
  classes: string[];
  defaultEnabled: boolean;
}

/**
 * The profile's active loadout (mirrors Rust `active_loadout()`):
 * case-insensitive name match, first-loadout fallback, and a synthesized
 * empty "Default" when the profile has no loadouts at all.
 */
export function activeLoadout(profile: CharacterProfile): Loadout {
  const wanted = profile.active_loadout.toLowerCase();
  return (
    profile.loadouts.find((l) => l.name.toLowerCase() === wanted) ??
    profile.loadouts[0] ?? { name: DEFAULT_LOADOUT_NAME, classes: [], overrides: {} }
  );
}

/**
 * A copy of `profile` with `patch` applied to its active loadout (appending
 * a loadout when the profile somehow has none) — the frontend counterpart
 * of Rust's self-healing `active_loadout_mut()`.
 */
export function updateActiveLoadout(
  profile: CharacterProfile,
  patch: Partial<Pick<Loadout, "classes" | "overrides" | "channel_overrides">>,
): CharacterProfile {
  const active = activeLoadout(profile);
  const present = profile.loadouts.some((l) => l.name === active.name);
  return {
    ...profile,
    loadouts: present
      ? profile.loadouts.map((l) =>
          l.name === active.name ? { ...l, ...patch } : l,
        )
      : [...profile.loadouts, { ...active, ...patch }],
  };
}

/**
 * Loadout-level enablement (mirrors Rust `effective_enabled_in_loadout`):
 * exact-id override > longest prefix override (vs category path AND id, ties
 * to the alphabetically-first key) > defaultEnabled && class intersection.
 * Does NOT consult the pack-level `enabled` switch — callers combine.
 */
export function effectiveEnabledInLoadout(
  t: ResolvableTrigger,
  loadout: Loadout,
): boolean {
  const idLower = t.id.toLowerCase();
  // Sorted keys mirror the Rust BTreeMap iteration order for tie-breaks.
  const keys = Object.keys(loadout.overrides).sort();

  for (const key of keys) {
    if (key.toLowerCase() === idLower) return loadout.overrides[key];
  }

  const category = t.category ?? "";
  let best: { len: number; value: boolean } | null = null;
  for (const key of keys) {
    if (!(pathHasPrefix(category, key) || pathHasPrefix(t.id, key))) continue;
    if (best === null || key.length > best.len) {
      best = { len: key.length, value: loadout.overrides[key] };
    }
  }
  if (best !== null) return best.value;

  return (
    t.defaultEnabled &&
    (t.classes.length === 0 ||
      t.classes.some((c) =>
        loadout.classes.some((p) => p.toLowerCase() === c.toLowerCase()),
      ))
  );
}

/** Back-compat wrapper: resolution against the profile's ACTIVE loadout. */
export function effectiveEnabled(
  t: ResolvableTrigger,
  profile: CharacterProfile,
): boolean {
  return effectiveEnabledInLoadout(t, activeLoadout(profile));
}
