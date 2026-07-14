// Welcome-back briefing ("Where was I?") — pure logic + persistence for the
// startup orientation card (components/WelcomeBack.tsx). Read-only stitching
// of stores that already exist: the Session tab's per-character session
// history (CoachTab's "eqlogs.coach.v1*" localStorage keys), lib/timers.ts
// camp timers, lib/wishlist.ts, and lib/sessionLog.ts loot (for drops
// replayed during catch-up). No new parsing.
//
// Timestamp domains (see the project's timestamp-domain notes): session rows
// and camp timers store WALL-CLOCK epoch ms — compared directly against
// Date.now(). Loot entries carry LOG timestamps (naive local encoded as UTC
// seconds); epochMsToLogTs converts the wall-clock "last played" boundary
// into that domain for the wishlist-drops filter.

import { createLocalStore } from "./localStore";

// ---------------------------------------------------------------------------
// Preferences (Settings toggle + per-gap dismissal).
// ---------------------------------------------------------------------------

export const WELCOME_BACK_KEY = "eqlogs.welcomeBack.v1";
export const WELCOME_BACK_EVENT = "eqlogs-welcome-back-changed";

/** Show the card only after at least this long away (~12 h). */
export const WELCOME_BACK_MIN_GAP_MS = 12 * 3_600_000;

export interface WelcomeBackPrefs {
  /** Master switch (Settings → General). Default ON — visual, not spoken. */
  enabled: boolean;
  /** endedTs (epoch ms) of the session the user dismissed the card for; the
   *  card reappears only when a NEWER qualifying gap exists. 0 = never. */
  dismissedForEndedMs: number;
}

export function decodeWelcomeBackPrefs(raw: unknown): WelcomeBackPrefs {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<WelcomeBackPrefs>;
  return {
    enabled: parsed.enabled !== false,
    dismissedForEndedMs:
      typeof parsed.dismissedForEndedMs === "number" && parsed.dismissedForEndedMs > 0
        ? parsed.dismissedForEndedMs
        : 0,
  };
}

const prefsStore = createLocalStore<WelcomeBackPrefs>(
  WELCOME_BACK_KEY,
  WELCOME_BACK_EVENT,
  decodeWelcomeBackPrefs,
);

export function loadWelcomeBackPrefs(): WelcomeBackPrefs {
  return prefsStore.load();
}

export function saveWelcomeBackEnabled(enabled: boolean): void {
  prefsStore.save({ ...prefsStore.load(), enabled });
}

export function dismissWelcomeBack(endedMs: number): void {
  prefsStore.save({ ...prefsStore.load(), dismissedForEndedMs: endedMs });
}

/** Subscribe to pref changes (Settings toggle ↔ card). */
export function onWelcomeBackPrefsChanged(cb: () => void): () => void {
  return prefsStore.subscribe(cb);
}

/** Gate: enabled, gap long enough, and not already dismissed for this gap. */
export function shouldShowWelcomeBack(
  prefs: WelcomeBackPrefs,
  lastEndedMs: number,
  nowMs: number,
  minGapMs = WELCOME_BACK_MIN_GAP_MS,
): boolean {
  if (!prefs.enabled) return false;
  if (!(lastEndedMs > 0) || lastEndedMs > nowMs) return false;
  if (nowMs - lastEndedMs < minGapMs) return false;
  return prefs.dismissedForEndedMs !== lastEndedMs;
}

// ---------------------------------------------------------------------------
// Timestamp-domain conversion.
// ---------------------------------------------------------------------------

/** Epoch ms → log-domain seconds (the log stamps naive LOCAL wall time and
 *  the parser encodes it as if it were UTC). Uses the zone offset at the
 *  converted instant, so a DST change during the away window can skew the
 *  boundary by up to an hour — acceptable for a coarse "since you left"
 *  filter. */
export function epochMsToLogTs(ms: number): number {
  return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000);
}

// ---------------------------------------------------------------------------
// Session-history rows (read-only view of CoachTab's persisted store).
// ---------------------------------------------------------------------------

/** CoachTab's localStorage key family: the legacy bare key plus
 *  `eqlogs.coach.v1:<character>:<loadout>` per-character keys. Kept in sync
 *  with COACH_KEY in components/CoachTab.tsx (stable, versioned key). */
export const COACH_STORE_PREFIX = "eqlogs.coach.v1";

/** The subset of CoachTab's SessionHistoryRow this feature reads. */
export interface WelcomeSessionRow {
  /** Wall-clock epoch ms the session was archived. */
  endedMs: number;
  durationSecs: number;
  xp: number;
  kills: number;
  deaths: number;
  topMob: string;
  topMobKills: number;
  zones: string[];
  character: string;
}

function coerceRow(raw: unknown): WelcomeSessionRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const endedMs = typeof r.endedTs === "number" ? r.endedTs : 0;
  if (!(endedMs > 0)) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    endedMs,
    durationSecs: Math.max(0, num(r.durationSecs)),
    xp: num(r.xp),
    kills: Math.max(0, num(r.kills)),
    deaths: Math.max(0, num(r.deaths)),
    topMob: typeof r.topMob === "string" ? r.topMob : "",
    topMobKills: Math.max(0, num(r.topMobKills)),
    zones: Array.isArray(r.zones)
      ? r.zones.filter((z): z is string => typeof z === "string" && z.length > 0)
      : [],
    character: typeof r.character === "string" ? r.character : "",
  };
}

/** Newest archived session for `character` across every coach store key
 *  (per-loadout keys plus the legacy bare key). Null when there is no
 *  history, no localStorage, or nothing matches the character. */
export function latestSessionRow(character: string): WelcomeSessionRow | null {
  const want = character.trim().toLowerCase();
  let best: WelcomeSessionRow | null = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key !== COACH_STORE_PREFIX && !key.startsWith(`${COACH_STORE_PREFIX}:`)) {
        continue;
      }
      // Per-character keys embed the lowercased character as the segment
      // after the prefix; skip other characters' stores outright.
      if (want && key !== COACH_STORE_PREFIX) {
        const seg = key.slice(COACH_STORE_PREFIX.length + 1).split(":")[0];
        if (seg !== want && seg !== "unknown") continue;
      }
      let history: unknown;
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        history =
          parsed && typeof parsed === "object"
            ? (parsed as { history?: unknown }).history
            : null;
      } catch {
        continue; // one corrupt store must not hide the rest
      }
      if (!Array.isArray(history)) continue;
      for (const raw of history) {
        const row = coerceRow(raw);
        if (!row) continue;
        // v2 rows carry the character — trust it over the key when present.
        if (want && row.character && row.character.toLowerCase() !== want) continue;
        if (!best || row.endedMs > best.endedMs) best = row;
      }
    }
  } catch {
    return null; // localStorage unavailable
  }
  return best;
}

// ---------------------------------------------------------------------------
// Summary assembly (pure — component supplies the store snapshots).
// ---------------------------------------------------------------------------

export interface ExpiredTimerLine {
  label: string;
  zoneLong: string | null;
  /** Wall-clock epoch ms the countdown came due. */
  dueAtMs: number;
}

export interface WishlistDropLine {
  item: string;
  qty: number;
}

export interface WelcomeBackSummary {
  lastEndedMs: number;
  awayMs: number;
  durationSecs: number;
  xpGained: number;
  kills: number;
  deaths: number;
  /** Overall kills/hour of that session; null when it can't be computed. */
  killsPerHour: number | null;
  topMob: string;
  topMobKills: number;
  zone: string;
  /** XP% into the level when last seen (persisted anchor); null if unknown. */
  levelProgress: number | null;
  /** Camp/custom timers whose countdown came due during the away window. */
  expiredTimers: ExpiredTimerLine[];
  /** Wishlisted items looted (per the replayed log) since last played. */
  wishlistDrops: WishlistDropLine[];
}

export interface WelcomeBackInputs {
  nowMs: number;
  /** Newest session-history row (latestSessionRow); null = no history. */
  row: WelcomeSessionRow | null;
  minGapMs?: number;
  /** lib/timers.ts shapes (epoch-ms startedAt). */
  timers?: { label: string; zoneLong?: string | null; startedAt: number; durationSecs: number }[];
  /** lib/sessionLog.ts loot entries (LOG-domain ts seconds). */
  loot?: { ts: number; item: string; qty?: number }[];
  /** Wishlisted item names (lib/wishlist.ts). */
  wishlist?: string[];
  /** Persisted XP% into level (overlayState), when the anchor is known. */
  levelProgress?: number | null;
}

/** Build the briefing, or null when the away gap doesn't qualify. Pure —
 *  callers pass snapshots; nothing here touches localStorage. */
export function buildWelcomeBackSummary(
  inputs: WelcomeBackInputs,
): WelcomeBackSummary | null {
  const { nowMs, row } = inputs;
  const minGapMs = inputs.minGapMs ?? WELCOME_BACK_MIN_GAP_MS;
  if (!row || !(row.endedMs > 0) || row.endedMs > nowMs) return null;
  const awayMs = nowMs - row.endedMs;
  if (awayMs < minGapMs) return null;

  // Camp timers that came due while away (epoch-ms domain on both sides).
  const expiredTimers: ExpiredTimerLine[] = (inputs.timers ?? [])
    .map((t) => ({
      label: t.label,
      zoneLong: t.zoneLong ?? null,
      dueAtMs: t.startedAt + t.durationSecs * 1000,
    }))
    .filter((t) => t.dueAtMs > row.endedMs && t.dueAtMs <= nowMs)
    .sort((a, b) => b.dueAtMs - a.dueAtMs);

  // Wishlist items looted since last played. Loot timestamps are log-domain;
  // convert the wall-clock boundary once and compare in that domain.
  const sinceLogTs = epochMsToLogTs(row.endedMs);
  const wanted = new Set(
    (inputs.wishlist ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const dropCounts = new Map<string, WishlistDropLine>();
  if (wanted.size > 0) {
    for (const entry of inputs.loot ?? []) {
      if (entry.ts < sinceLogTs) continue;
      const key = entry.item.trim().toLowerCase();
      if (!wanted.has(key)) continue;
      const qty = typeof entry.qty === "number" && entry.qty > 0 ? entry.qty : 1;
      const cur = dropCounts.get(key);
      if (cur) cur.qty += qty;
      else dropCounts.set(key, { item: entry.item, qty });
    }
  }

  return {
    lastEndedMs: row.endedMs,
    awayMs,
    durationSecs: row.durationSecs,
    xpGained: row.xp,
    kills: row.kills,
    deaths: row.deaths,
    killsPerHour:
      row.durationSecs > 0 && row.kills > 0
        ? row.kills / (row.durationSecs / 3600)
        : null,
    topMob: row.topMob,
    topMobKills: row.topMobKills,
    zone: row.zones[0] ?? "",
    levelProgress:
      typeof inputs.levelProgress === "number" && Number.isFinite(inputs.levelProgress)
        ? inputs.levelProgress
        : null,
    expiredTimers,
    wishlistDrops: [...dropCounts.values()],
  };
}

/** "14 hours ago" under two days, then "3 days ago". */
export function fmtAway(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
