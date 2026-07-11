// Mock mode: a scripted, realistic event stream so every view renders
// standalone in a browser (no Tauri backend). Active whenever the page runs
// outside Tauri, or when `?mock=1` is passed explicitly.
//
// Data is derived from fixtures/sample_session.txt — an active fight against
// Baron Telyx V`Zher — plus the starter trigger pack.

import { MOCK_PACK_TRIGGERS } from "./mockPacks";
import {
  activeLoadout,
  deriveId,
  effectiveEnabled,
  updateActiveLoadout,
} from "./resolution";
import { dedupeSharedTriggers, parseShareString } from "./lib/share";
import type {
  AppConfig,
  CharacterProfile,
  DiscoveredLog,
  FightPage,
  FightRecord,
  LogLinePayload,
  MeterRow,
  PackWarningsPayload,
  SessionEndedPayload,
  ShareImportResult,
  TailStatsPayload,
  TimerLane,
  TimerPayload,
  Trigger,
  TriggerFiredPayload,
  TriggerIdentity,
  TriggerTreeEntry,
} from "./types";

export const IS_MOCK: boolean =
  typeof window !== "undefined" &&
  (new URLSearchParams(window.location.search).get("mock") === "1" ||
    !("__TAURI_INTERNALS__" in window));

/** Mock demo switches: ?firstrun=1 blanks the config (welcome card);
 *  ?banners=1 drives the session-ended / pack-warnings / canary states. */
const MOCK_FIRSTRUN: boolean =
  IS_MOCK &&
  new URLSearchParams(window.location.search).get("firstrun") === "1";
const MOCK_BANNERS: boolean =
  IS_MOCK && new URLSearchParams(window.location.search).get("banners") === "1";

// ---------------------------------------------------------------------------
// Event bus (stands in for the Tauri event system)
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;
const bus = new Map<string, Set<Handler>>();

export function mockListen<T>(
  name: string,
  cb: (payload: T) => void,
): () => void {
  let set = bus.get(name);
  if (!set) {
    set = new Set();
    bus.set(name, set);
  }
  const h = cb as Handler;
  set.add(h);
  return () => {
    set.delete(h);
  };
}

export function mockEmit<T>(name: string, payload: T): void {
  const set = bus.get(name);
  if (set) for (const cb of [...set]) cb(payload);
}

// ---------------------------------------------------------------------------
// Mock command layer (stands in for invoke())
// ---------------------------------------------------------------------------

// Mock config edits persist to localStorage (like triggers and the profile)
// so Settings changes in the browser demo survive a reload — mirroring the
// desktop backend's config.json. ?firstrun=1 always starts blank.
const MOCK_CONFIG_KEY = "eqlogs.mock.config";

function loadStoredMockConfig(): AppConfig | null {
  if (!IS_MOCK || MOCK_FIRSTRUN) return null;
  try {
    const raw = window.localStorage.getItem(MOCK_CONFIG_KEY);
    if (!raw) return null;
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object") return null;
    const c = p as Partial<AppConfig>;
    if (typeof c.logPath !== "string" || typeof c.characterName !== "string") {
      return null;
    }
    return {
      logPath: c.logPath,
      characterName: c.characterName,
      triggerPackPath: typeof c.triggerPackPath === "string" ? c.triggerPackPath : "",
      pets: Array.isArray(c.pets) ? c.pets.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

let mockConfig: AppConfig = MOCK_FIRSTRUN
  ? { logPath: "", characterName: "", triggerPackPath: "", pets: [] }
  : (loadStoredMockConfig() ?? {
      logPath:
        "C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Nyasha_legends.txt",
      characterName: "Nyasha",
      triggerPackPath: "",
      pets: ["Vibarn"],
    });

export function mockGetConfig(): AppConfig {
  return { ...mockConfig };
}
export function mockSetConfig(c: AppConfig): void {
  mockConfig = { ...c, pets: [...c.pets] };
  if (MOCK_FIRSTRUN) return; // demo mode: never persist the blank-slate run
  try {
    window.localStorage.setItem(MOCK_CONFIG_KEY, JSON.stringify(mockConfig));
  } catch {
    // storage unavailable: edits just won't survive a reload
  }
}

let mockTailing = true;
export function mockIsTailing(): boolean {
  return mockTailing;
}
export function mockSetTailing(v: boolean): void {
  mockTailing = v;
}

// Sample user triggers (the retired v1 starter set), inlined so the browser
// build is self-contained — these play the role of the user's own
// triggers.json in mock mode.
const DEFAULT_MOCK_TRIGGERS: Trigger[] = [
  {
    name: "Stunned",
    pattern: "^You are stunned!",
    enabled: true,
    category: "Combat/Defense",
    comments: "Can't cast or move while stunned.",
    actions: [{ Speak: { template: "stunned" } }],
  },
  {
    name: "Stun over",
    pattern: "^You are no longer stunned\\.",
    enabled: true,
    category: "Combat/Defense",
    actions: [{ Speak: { template: "stun over" } }],
  },
  {
    name: "Tell received",
    pattern: "^(\\w+) tells you,",
    enabled: true,
    category: "Social",
    comments: "Speaks the sender's name so tells aren't missed mid-fight.",
    actions: [{ Speak: { template: "tell from ${1}" } }],
  },
  {
    name: "Dangerous enemy cast",
    pattern:
      "^(\\w[\\w`' ]*) begins casting (Cancelling of Life|Engulfing Darkness)\\.",
    enabled: true,
    category: "Combat/Enemy Casts",
    comments:
      "Necro/SK nukes and snares seen throughout Befallen and Neriak trash.",
    actions: [{ Speak: { template: "${2} incoming" } }],
  },
  {
    name: "Encumbered",
    pattern: "^You are encumbered!",
    enabled: true,
    category: "Utility",
    actions: [{ Speak: { template: "encumbered" } }],
  },
  {
    name: "Level up",
    pattern: "^You have gained a level!",
    enabled: true,
    category: "Character",
    actions: [{ Speak: { template: "ding" } }],
  },
  {
    name: "Spell resisted",
    pattern: "resisted your (.+)!",
    enabled: true,
    category: "Combat/Offense",
    cooldown_secs: 3,
    comments: "Speaks + overlay by default; 3s cooldown stops back-to-back resists stacking speech.",
    actions: [
      { Speak: { template: "resisted" } },
      { DisplayText: { template: "Resisted: ${1}" } },
    ],
  },
  {
    name: "Mez worn off",
    pattern: "^Your Walking Sleep spell has worn off",
    enabled: true,
    category: "Combat/Crowd Control",
    comments: "Matches both the bare form and 'worn off of <target>.'",
    actions: [{ Speak: { template: "mez off" } }],
  },
  {
    name: "Mez cast timer",
    pattern: "^You begin casting Walking Sleep\\.",
    enabled: true,
    category: "Combat/Crowd Control",
    comments: "Walking Sleep runs ~48s; warns 6s before it breaks.",
    actions: [
      {
        StartTimer: {
          name: "Walking Sleep",
          duration_secs: 48,
          warn_at_secs: 6,
        },
      },
    ],
  },
  {
    name: "You died",
    pattern: "^You died\\.",
    enabled: true,
    category: "Combat/Defense",
    actions: [{ Speak: { template: "you died" } }],
  },
];

// Mock trigger edits persist to localStorage so the browser demo behaves like
// the real app across reloads (quick-trigger saves survive a refresh).
const MOCK_TRIGGERS_KEY = "eqlogs.mock.triggers";

function loadStoredMockTriggers(): Trigger[] | null {
  if (!IS_MOCK) return null;
  try {
    const raw = window.localStorage.getItem(MOCK_TRIGGERS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Trigger[]) : null;
  } catch {
    return null;
  }
}

let mockTriggers: Trigger[] = loadStoredMockTriggers() ?? DEFAULT_MOCK_TRIGGERS;

export function mockGetTriggers(): Trigger[] {
  return mockTriggers.map((t) => ({ ...t, actions: [...t.actions] }));
}
export function mockSaveTriggers(next: Trigger[]): void {
  mockTriggers = next.map((t) => ({ ...t, actions: [...t.actions] }));
  try {
    window.localStorage.setItem(MOCK_TRIGGERS_KEY, JSON.stringify(mockTriggers));
  } catch {
    // storage unavailable: edits just won't survive a reload
  }
}

// ---------------------------------------------------------------------------
// Trigger library v2: profile + tree (mirrors the Rust commands)
// ---------------------------------------------------------------------------

const MOCK_PROFILE_KEY = "eqlogs.mock.profile";

// Two loadouts so the topbar switcher and the Settings Loadouts card have
// something real to demo (mirrors the multi-loadout CharacterProfile shape).
const DEFAULT_MOCK_PROFILE: CharacterProfile = {
  character: "Nyasha",
  level: 50,
  active_loadout: "Raid",
  loadouts: [
    { name: "Raid", classes: ["Enchanter", "Cleric"], overrides: {} },
    { name: "Solo", classes: ["Enchanter", "Necromancer"], overrides: {} },
  ],
};

function cloneProfile(p: CharacterProfile): CharacterProfile {
  return {
    ...p,
    loadouts: p.loadouts.map((l) => ({
      ...l,
      classes: [...l.classes],
      overrides: { ...l.overrides },
    })),
  };
}

function loadStoredMockProfile(): CharacterProfile | null {
  if (!IS_MOCK) return null;
  try {
    const raw = window.localStorage.getItem(MOCK_PROFILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Pre-loadout (flat) profiles from older sessions: discard, use defaults.
    const p = parsed as Partial<CharacterProfile>;
    if (!Array.isArray(p.loadouts) || typeof p.active_loadout !== "string") {
      return null;
    }
    return parsed as CharacterProfile;
  } catch {
    return null;
  }
}

let mockProfile: CharacterProfile =
  loadStoredMockProfile() ?? DEFAULT_MOCK_PROFILE;

function persistMockProfile(): void {
  try {
    window.localStorage.setItem(MOCK_PROFILE_KEY, JSON.stringify(mockProfile));
  } catch {
    // storage unavailable: profile edits just won't survive a reload
  }
  // Mirror the backend, which emits "profile-changed" (full profile payload)
  // after set_profile / switch_loadout / set_override.
  mockEmit("profile-changed", cloneProfile(mockProfile));
}

export function mockGetProfile(): CharacterProfile {
  return cloneProfile(mockProfile);
}

export function mockSetProfile(p: CharacterProfile): void {
  mockProfile = cloneProfile(p);
  persistMockProfile();
}

export function mockSetOverride(key: string, value: boolean | null): void {
  const active = activeLoadout(mockProfile);
  const overrides = { ...active.overrides };
  if (value === null) delete overrides[key];
  else overrides[key] = value;
  mockProfile = updateActiveLoadout(mockProfile, { overrides });
  persistMockProfile();
}

export function mockSetChannelOverride(
  id: string,
  speak: boolean | null,
  alert: boolean | null,
): void {
  const active = activeLoadout(mockProfile);
  const channel_overrides = { ...(active.channel_overrides ?? {}) };
  const cur = { ...(channel_overrides[id] ?? {}) };
  if (speak !== null) cur.speak = speak;
  if (alert !== null) cur.alert = alert;
  if (cur.speak === undefined && cur.alert === undefined)
    delete channel_overrides[id];
  else channel_overrides[id] = cur;
  mockProfile = updateActiveLoadout(mockProfile, { channel_overrides });
  persistMockProfile();
}

/**
 * Mirrors set_active_character: repoint the demo profile at the chosen
 * character. (The real backend also swaps the tailed log + reloads that
 * character's stored profile; the mock keeps a single in-memory profile and
 * just relabels it so the switcher is exercisable.)
 */
export function mockSetActiveCharacter(_server: string, character: string): void {
  mockProfile = { ...mockProfile, character };
  persistMockProfile();
}

/** Mirrors switch_loadout: case-insensitive match, persists canonical name. */
export function mockSwitchLoadout(name: string): CharacterProfile {
  const found = mockProfile.loadouts.find(
    (l) => l.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!found) throw new Error(`No loadout named "${name}"`);
  mockProfile = { ...mockProfile, active_loadout: found.name };
  persistMockProfile();
  return cloneProfile(mockProfile);
}

/** Mirrors get_trigger_tree: bundled pack sample + the user pack. */
export function mockGetTriggerTree(): TriggerTreeEntry[] {
  // The mock pack list carries no actions, so approximate channels from the
  // id/category for a realistic demo. Real channels come from the backend,
  // which reads each trigger's actual actions.
  const packChannels = (id: string, cat: string | null) => {
    const s = `${id} ${cat ?? ""}`.toLowerCase();
    const timer = /timer|\/cast\/|debuff/.test(s);
    const speaks = /resist|wear-off|tell|survival|died|ending|enrage/.test(s);
    return {
      speaks,
      shows: !timer,
      sound: false,
      timer,
      webhook: false,
      impact: false,
      overlays: timer ? [] : ["alerts"],
    };
  };
  // Resolve per-trigger channel overrides on top of the base channels, so the
  // chips reflect the effective TTS/alert state (matches the Rust tree).
  const chOv = activeLoadout(mockProfile).channel_overrides ?? {};
  type Ch = {
    speaks: boolean;
    shows: boolean;
    sound: boolean;
    timer: boolean;
    webhook: boolean;
    impact: boolean;
    overlays: string[];
  };
  const applyOv = (id: string, ch: Ch): Ch => {
    const ov = chOv[id];
    if (!ov) return ch;
    return {
      speaks: ov.speak ?? ch.speaks,
      shows: ov.alert ?? ch.shows,
      sound: ch.sound,
      timer: ch.timer,
      webhook: ch.webhook,
      impact: ch.impact,
      overlays: ov.alert === false
        ? ch.overlays.filter((overlay) => overlay !== "alerts")
        : ov.alert === true && !ch.overlays.includes("alerts")
          ? [...ch.overlays, "alerts"]
          : ch.overlays,
    };
  };
  const packs: TriggerTreeEntry[] = MOCK_PACK_TRIGGERS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || null,
    classes: p.classes,
    defaultEnabled: p.defaultEnabled,
    effectiveEnabled: effectiveEnabled(
      { id: p.id, category: p.category || null, classes: p.classes, defaultEnabled: p.defaultEnabled },
      mockProfile,
    ),
    enabled: true,
    source: p.source,
    pattern: p.pattern,
    ...applyOv(p.id, packChannels(p.id, p.category || null)),
    userIndex: null,
  }));
  const user: TriggerTreeEntry[] = mockTriggers.map((t, i) => {
    const id = deriveId(t.id, t.category, t.name);
    const resolvable = {
      id,
      category: t.category ?? null,
      classes: t.classes ?? [],
      defaultEnabled: t.default_enabled ?? true,
    };
    return {
      id,
      name: t.name,
      category: t.category ?? null,
      classes: t.classes ?? [],
      defaultEnabled: t.default_enabled ?? true,
      effectiveEnabled: t.enabled && effectiveEnabled(resolvable, mockProfile),
      enabled: t.enabled,
      source: t.source ?? "user",
      pattern: t.pattern,
      ...applyOv(id, {
        speaks: t.actions.some((a) => "Speak" in a),
        shows: t.actions.some(
          (a) =>
            "DisplayText" in a ||
            ("Overlay" in a && a.Overlay.overlay === "alerts"),
        ),
        sound: t.actions.some((a) => "PlaySound" in a),
        timer: t.actions.some((a) => "StartTimer" in a || "CancelTimer" in a),
        webhook: t.actions.some((a) => "PostWebhook" in a),
        impact: t.actions.some(
          (a) => "Impact" in a || ("Overlay" in a && a.Overlay.overlay === "impact"),
        ),
        overlays: Array.from(
          new Set(
            t.actions.flatMap((a) => {
              if ("Overlay" in a) return [a.Overlay.overlay];
              if ("DisplayText" in a) return ["alerts"];
              if ("Impact" in a) return ["impact"];
              return [];
            }),
          ),
        ),
      }),
      userIndex: i,
    };
  });
  return [...packs, ...user];
}

/** Canned auto-detect: plausible for the scripted cast lines in the feed. */

// ---------------------------------------------------------------------------
// First-run log discovery (mirrors the discover_logs command)
// ---------------------------------------------------------------------------

const MOCK_LOG_DIR =
  "C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs";

export function mockDiscoverLogs(): DiscoveredLog[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      path: `${MOCK_LOG_DIR}/eqlog_Nyasha_legends.txt`,
      character: "Nyasha",
      server: "legends",
      modifiedTs: now - 190,
    },
    {
      path: `${MOCK_LOG_DIR}/eqlog_Torvin_legends.txt`,
      character: "Torvin",
      server: "legends",
      modifiedTs: now - 3600 * 26,
    },
  ];
}

// ---------------------------------------------------------------------------
// Fight history (mirrors list_fights / get_fight over the SQLite store)
// ---------------------------------------------------------------------------

/** Per-combatant source templates (item 15): [label, share-of-total]. Shares
 *  sum to 1 so sources always add up to the row's damage; labels demo melee
 *  verbs, spells, a damage shield, and pet folding. */
const SOURCE_DEFS: Record<string, [string, number][]> = {
  Nyasha: [
    ["slash", 0.38],
    ["Negation of Life", 0.27],
    ["Boil Blood", 0.17],
    ["claw (pet)", 0.1],
    ["frost (damage shield)", 0.08],
  ],
  Torvin: [
    ["pierce", 0.46],
    ["Denon's Disruptive Discord", 0.3],
    ["kick", 0.24],
  ],
  Ellara: [
    ["bash", 0.62],
    ["slash", 0.38],
  ],
  Vibarn: [
    ["pierce", 0.4],
    ["Clinging Darkness", 0.35],
    ["Disease Cloud", 0.25],
  ],
};

/** Shape a combatant's total into MeterSourceRow[] using its template.
 *  Melee labels (lowercase verb) also carry misses so the skill table's Acc%
 *  column has data; spell labels (capitalized) carry casts (≥ hits, a couple
 *  of resists) for the per-cast readout. Damage shields carry neither. */
function mockSources(
  name: string,
  total: number,
  maxHit: number,
): MeterRow["sources"] {
  const defs = SOURCE_DEFS[name];
  if (!defs) return [];
  return defs.map(([label, share], i) => {
    const t = Math.round(total * share);
    const hits = Math.max(1, Math.round(t / 55));
    const base = label.replace(" (pet)", "");
    const isDs = label.includes("(damage shield)");
    const isSpell = !isDs && /^[A-Z]/.test(base);
    return {
      name: label,
      total: t,
      hits,
      crits: Math.round(hits * 0.15),
      maxHit: Math.max(1, Math.round(maxHit * (1 - i * 0.13))),
      misses: isSpell || isDs ? 0 : Math.round(hits * 0.3),
      casts: isSpell ? hits + Math.round(hits * 0.2) + 1 : 0,
    };
  });
}

/** Plausible healing / overheal / damage-taken for a roster member (X2 demo).
 *  Ellara is the group's healer; Nyasha (necro) self-heals via lifetaps; Torvin
 *  tanks and takes the most. Deterministic via the shared `seeded`. */
function mockSupport(
  name: string,
  duration: number,
  seed: number,
): { healing: number; overheal: number; damageTaken: number } {
  const rnd = (k: number) => seeded(seed + k);
  let healRate = 0;
  if (name === "Ellara") healRate = 520 + rnd(1) * 380;
  else if (name === "Nyasha") healRate = 120 + rnd(2) * 90;
  const healing = Math.round(healRate * duration);
  const overheal = Math.round(healing * (0.18 + rnd(3) * 0.22));
  const takenRate =
    name === "Torvin"
      ? 180 + rnd(4) * 160
      : name === "Nyasha"
        ? 90 + rnd(5) * 120
        : 40 + rnd(6) * 90;
  const damageTaken = Math.round(takenRate * duration);
  return { healing, overheal, damageTaken };
}

const FIGHT_TARGETS = [
  "Baron Telyx V`Zher",
  "a soldier of V`Zher",
  "a restless spirit",
  "Kizrak the Cruel",
  "a burly gnoll",
  "an undead knight",
  "a Teir`Dal ranger",
  "Priest of Najena",
];

/** Deterministic pseudo-random (so screenshots are stable across reloads). */
function seeded(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function makeMockFights(): FightRecord[] {
  const roster: [string, boolean][] = [
    ["Nyasha", true],
    ["Torvin", false],
    ["Ellara", false],
    ["Vibarn", true],
  ];
  const fights: FightRecord[] = [];
  let endTs = Math.floor(Date.now() / 1000) - 420;
  for (let i = 0; i < 57; i++) {
    const id = 57 - i;
    const boss = seeded(id) > 0.8;
    const duration = Math.round(boss ? 90 + seeded(id * 3) * 160 : 12 + seeded(id * 3) * 48);
    const startTs = endTs - duration;
    const rows: MeterRow[] = roster
      .slice(0, 2 + Math.floor(seeded(id * 7) * 3))
      .map(([name, pet], j) => {
        const dps = 120 + seeded(id * 13 + j) * 820;
        const total = Math.round(dps * duration);
        const hits = Math.max(1, Math.round(total / 52));
        const maxHit = Math.round(120 + seeded(id * 17 + j) * 380);
        const support = mockSupport(name, duration, id * 37 + j);
        return {
          name,
          total,
          dps,
          pct: 0,
          pet,
          hits,
          crits: Math.round(hits * 0.16),
          misses: Math.round(hits * 0.24),
          maxHit,
          healing: support.healing,
          overheal: support.overheal,
          damageTaken: support.damageTaken,
          sources: mockSources(name, total, maxHit),
        };
      })
      .sort((a, b) => b.total - a.total);
    const sum = rows.reduce((s, r) => s + r.total, 0);
    for (const r of rows) r.pct = (r.total / sum) * 100;
    fights.push({
      id,
      target: FIGHT_TARGETS[id % FIGHT_TARGETS.length],
      startTs,
      endTs,
      durationSecs: duration,
      totalDamage: sum,
      targetSlain: seeded(id * 23) > 0.12,
      rows,
    });
    endTs = startTs - Math.round(20 + seeded(id * 29) * 900);
  }
  return fights; // newest first (descending startTs), like the store
}

const MOCK_FIGHTS: FightRecord[] = makeMockFights();

export function mockListFights(limit: number, offset: number): FightPage {
  return {
    fights: MOCK_FIGHTS.slice(offset, offset + limit).map((f) => ({
      ...f,
      rows: f.rows.map((r) => ({ ...r })),
    })),
    total: MOCK_FIGHTS.length,
  };
}

export function mockGetFight(id: number): FightRecord | null {
  const f = MOCK_FIGHTS.find((x) => x.id === id);
  return f ? { ...f, rows: f.rows.map((r) => ({ ...r })) } : null;
}

// ---------------------------------------------------------------------------
// Share import (mirrors the share_import command)
// ---------------------------------------------------------------------------

export async function mockShareImport(text: string): Promise<ShareImportResult> {
  const payload = await parseShareString(text);
  const existing = new Set<string>([
    ...MOCK_PACK_TRIGGERS.map((p) => p.id),
    ...mockTriggers.map((t) => deriveId(t.id, t.category, t.name)),
  ]);
  const { triggers, renamed } = dedupeSharedTriggers(payload, existing);
  mockSaveTriggers([...mockTriggers, ...triggers]);
  return { imported: triggers.length, renamed };
}

// ---------------------------------------------------------------------------
// Scripted stream
// ---------------------------------------------------------------------------

interface Combatant {
  name: string;
  pet: boolean;
  total: number;
  rate: number; // dmg/sec baseline
  maxHit: number;
  phase: number; // sin phase so rank 3/4 trade places over time
  swing: number; // sin amplitude
  healRate: number; // heal/sec baseline (X2 demo; 0 = pure DPS)
  takenRate: number; // damage-taken/sec baseline
  heal: number; // accumulated healing
  taken: number; // accumulated damage taken
}

const COMBATANTS: Combatant[] = [
  { name: "Nyasha", pet: true, total: 37400, rate: 930, maxHit: 412, phase: 0.0, swing: 0.25, healRate: 150, takenRate: 120, heal: 6100, taken: 4900 },
  { name: "Torvin", pet: false, total: 23300, rate: 590, maxHit: 236, phase: 1.4, swing: 0.25, healRate: 0, takenRate: 240, heal: 0, taken: 9800 },
  { name: "Ellara", pet: false, total: 10900, rate: 268, maxHit: 198, phase: 2.1, swing: 0.7, healRate: 640, takenRate: 90, heal: 26200, taken: 3700 },
  { name: "Vibarn", pet: true, total: 10750, rate: 272, maxHit: 154, phase: 5.2, swing: 0.7, healRate: 0, takenRate: 70, heal: 0, taken: 2900 },
];

let fightDuration = 41;

function fightTick(): void {
  fightDuration += 0.5;
  for (const c of COMBATANTS) {
    const swing = 1 + c.swing * Math.sin(fightDuration / 5 + c.phase);
    c.total += c.rate * 0.5 * swing * (0.7 + Math.random() * 0.6);
    c.heal += c.healRate * 0.5 * (0.7 + Math.random() * 0.6);
    c.taken += c.takenRate * 0.5 * (0.6 + Math.random() * 0.8);
  }
  const sum = COMBATANTS.reduce((s, c) => s + c.total, 0);
  const rows: MeterRow[] = [...COMBATANTS]
    .sort((a, b) => b.total - a.total)
    .map((c) => {
      const hits = Math.round(c.total / 52);
      return {
        name: c.name,
        total: Math.round(c.total),
        dps: c.total / fightDuration,
        pct: (c.total / sum) * 100,
        pet: c.pet,
        hits,
        crits: Math.round(hits * 0.16),
        misses: Math.round(hits * 0.24),
        maxHit: c.maxHit,
        healing: Math.round(c.heal),
        overheal: Math.round(c.heal * 0.28),
        damageTaken: Math.round(c.taken),
        sources: mockSources(c.name, Math.round(c.total), c.maxHit),
      };
    });
  mockEmit("fight-update", {
    target: "Baron Telyx V`Zher",
    durationSecs: Math.round(fightDuration),
    totalDamage: Math.round(sum),
    active: true,
    rows,
  });
}

// Mixed real-looking feed lines: hits, heals, a death, loot, chat, faction.
// [event kind, message]
const FEED: [string, string][] = [
  ["System", "You have entered The Estate of Unrest."],
  ["CastBegin", "You begin casting Walking Sleep."],
  ["MeleeHit", "You slash Baron Telyx V`Zher for 118 points of damage."],
  ["MeleeHit", "Torvin pierces Baron Telyx V`Zher for 48 points of damage."],
  ["NonMeleeDamage", "Baron Telyx V`Zher is pierced by Torvin's thorns for 1 point of non-melee damage."],
  ["MeleeHit", "Baron Telyx V`Zher slashes YOU for 83 points of damage."],
  ["SpellDamage", "Torvin`s warder hit Baron Telyx V`Zher for 72 points of cold damage by Spirit of Blizzard Strike."],
  ["MeleeMiss", "Baron Telyx V`Zher tries to slash Torvin, but Torvin parries!"],
  ["Heal", "You have been healed for 264 points."],
  ["MeleeHit", "You crush Baron Telyx V`Zher for 412 points of damage. (Critical)"],
  ["Chat", "Vheden tells NewPlayers:1, 'Anyone know what to do with Troll Raider's Head'"],
  ["SpellDamage", "Baron Telyx V`Zher has taken 21 damage from Denon's Disruptive Discord by Torvin."],
  ["MeleeHit", "Ellara bashes Baron Telyx V`Zher for 96 points of damage."],
  ["MeleeMiss", "Vibarn tries to kick Baron Telyx V`Zher, but misses!"],
  ["CastBegin", "Vibarn begins casting Clinging Darkness."],
  ["MeleeHit", "Baron Telyx V`Zher bashes YOU for 47 points of damage."],
  ["SpellDamage", "Baron Telyx V`Zher has taken 38 damage from Disease Cloud by Vibarn."],
  ["MeleeHit", "Nyasha`s warder claws Baron Telyx V`Zher for 88 points of damage."],
  ["Slain", "A soldier of V`Zher has been slain by Nyasha!"],
  ["Loot", "You looted a Pristine Studded Leather Leggings +1 from Soldier of V`Zher's corpse."],
  ["Faction", "Your faction standing with the Knights of Truth got better."],
  ["MeleeHit", "You slash Baron Telyx V`Zher for 134 points of damage."],
  ["Heal", "Ellara is bathed in a healing light."],
  ["Chat", "Zyonis tells NewPlayers:1, 'can we turn on right click inspect in this?'"],
  ["MeleeHit", "Torvin kicks Baron Telyx V`Zher for 40 points of damage."],
  ["SpellResist", "Baron Telyx V`Zher resisted your Negation of Life!"],
  ["MeleeHit", "Baron Telyx V`Zher cleaves YOU for 121 points of damage."],
  ["Slain", "You died."],
  ["System", "Returning to home point, please wait..."],
  ["Heal", "You have been healed for 512 points."],
  ["Unclassified", "You begin to change your stance."],
  ["Unclassified", "You assume an evasive stance."],
  ["Unclassified", "You begin reciting the recovery invocation."],
  ["CastBegin", "You begin casting Negation of Life."],
  ["SpellDamage", "Baron Telyx V`Zher has taken 167 damage from Negation of Life by Nyasha."],
  ["MeleeHit", "Vibarn pierces Baron Telyx V`Zher for 61 points of damage."],
  ["MeleeMiss", "Torvin`s warder tries to cleave Baron Telyx V`Zher, but misses!"],
  ["Chat", "Haldis tells NewPlayers:1, 'harm touch into wizard nukes is rough'"],
  ["MeleeHit", "You slash Baron Telyx V`Zher for 156 points of damage."],
  ["Loot", "You looted 4 platinum, 7 gold from Baron Telyx V`Zher's guard."],
  ["Faction", "Your faction standing with the Dead got worse."],
  ["Heal", "A cool breeze slips through your mind: you have been healed for 340 points."],
  ["MeleeHit", "Ellara slashes Baron Telyx V`Zher for 104 points of damage."],
];

/** Scripted alerts, each carrying the identity of the mock trigger that
 *  "fired" it (ids derive from the mock user pack's category + name). */
const ALERTS: { text: string; trigger: TriggerIdentity }[] = [
  {
    text: "Resisted: Negation of Life",
    trigger: { id: "combat/offense/spell-resisted", name: "Spell resisted" },
  },
  {
    text: "Cancelling of Life incoming",
    trigger: {
      id: "combat/enemy-casts/dangerous-enemy-cast",
      name: "Dangerous enemy cast",
    },
  },
  {
    text: "Tell from Vheden",
    trigger: { id: "social/tell-received", name: "Tell received" },
  },
  {
    text: "Stunned",
    trigger: { id: "combat/defense/stunned", name: "Stunned" },
  },
  {
    text: "Mez worn off — re-mez now",
    trigger: { id: "combat/crowd-control/mez-worn-off", name: "Mez worn off" },
  },
];

// Structured loot + /random rolls for the Fights-tab session tracker (X10).
// Unlike FEED (which carries only the event-kind string), these carry the full
// serde-encoded EqEvent so the loot log and roll leaderboard populate. Field
// names match eqlog-core Event::Loot / Event::Roll exactly (looter is an
// Entity: "You" or { Named }).
const SESSION_DEMO: LogLinePayload[] = [
  {
    ts: 0,
    message:
      "--You have looted a Pristine Studded Leather Leggings +1 from a Soldier of V`Zher's corpse.--",
    event: {
      Loot: {
        looter: "You",
        item: "Pristine Studded Leather Leggings +1",
        quantity: 1,
        corpse: "a Soldier of V`Zher",
      },
    },
  },
  {
    ts: 0,
    message: "--Torvin has looted a Rune of Impetus from a fallen knight's corpse.--",
    event: {
      Loot: {
        looter: { Named: "Torvin" },
        item: "Rune of Impetus",
        quantity: 1,
        corpse: "a fallen knight",
      },
    },
  },
  {
    ts: 0,
    message: "--You have looted 4 Bone Chips from a greater skeleton's corpse.--",
    event: {
      Loot: {
        looter: "You",
        item: "Bone Chips",
        quantity: 4,
        corpse: "a greater skeleton",
      },
    },
  },
  {
    ts: 0,
    message: "--Ellara has looted a Flame Lick from a Teir`Dal wizard's corpse.--",
    event: {
      Loot: {
        looter: { Named: "Ellara" },
        item: "Flame Lick (Rune)",
        quantity: 1,
        corpse: "a Teir`Dal wizard",
      },
    },
  },
];

// Rolls across two ranges so the leaderboard groups and marks a winner.
const ROLL_DEMO: { roller: string; min: number; max: number; result: number }[] =
  [
    { roller: "Torvin", min: 0, max: 100, result: 84 },
    { roller: "Ellara", min: 0, max: 100, result: 47 },
    { roller: "You", min: 0, max: 100, result: 92 },
    { roller: "Vibarn", min: 0, max: 100, result: 61 },
    { roller: "Torvin", min: 0, max: 100, result: 12 },
    { roller: "Ellara", min: 0, max: 1000, result: 733 },
    { roller: "You", min: 0, max: 1000, result: 508 },
  ];

interface MockTimerDef {
  name: string;
  duration: number;
  warn: number | null;
  elapsed: number; // pre-elapsed at boot so bars sit at different fractions
  lane: TimerLane;
  /** Cast-time lead-in (item 12): starts pending, "landed" after this. */
  pending?: number;
}

// Laned demo timers so all overlays render standalone: buffs + an "other"
// recast (buffs overlay), targeted + untargeted enemy effects (target
// overlay, incl. one group per mob and the "(target)" fallback group).
// Two pending ("casting…") bars — one per lane — exercise item 12.
const TIMER_DEFS: MockTimerDef[] = [
  { name: "Spirit of Wolf", duration: 120, warn: 15, elapsed: 26, lane: "buff" },
  { name: "Regeneration", duration: 90, warn: 10, elapsed: 82, lane: "buff" }, // inside warn
  { name: "Spirit of Blizzard", duration: 150, warn: 15, elapsed: 40, lane: "buff" },
  { name: "Talisman of Altuna", duration: 96, warn: 12, elapsed: 0, lane: "buff", pending: 10 },
  { name: "Lay on Hands", duration: 300, warn: null, elapsed: 180, lane: "other" },
  // Buffs cast on OTHER people — the "on others" lane (per-target bars).
  { name: "Spirit of Wolf — Torvin", duration: 120, warn: 15, elapsed: 30, lane: "on-others" },
  { name: "Spirit of Wolf — Ellara", duration: 120, warn: 15, elapsed: 12, lane: "on-others" },
  { name: "Spirit Armor — Torvin", duration: 240, warn: 20, elapsed: 60, lane: "on-others" },
  { name: "Mez (Enthrall) — a burly gnoll", duration: 48, warn: 10, elapsed: 34, lane: "enemy" }, // warns shortly
  { name: "Root — a fallen knight", duration: 48, warn: 10, elapsed: 20, lane: "enemy" },
  { name: "Heat Blood — a fallen knight", duration: 42, warn: null, elapsed: 12, lane: "enemy" },
  { name: "Boil Blood", duration: 42, warn: null, elapsed: 0, lane: "enemy", pending: 8 },
  { name: "Clinging Darkness", duration: 30, warn: null, elapsed: 9, lane: "enemy" },
];

let driverStarted = false;

/** Boot the scripted stream. Safe to call once from main.tsx. */
export function startMockDriver(): void {
  if (driverStarted || !IS_MOCK) return;
  driverStarted = true;

  // Fight updates every 500ms (live totals, re-sorting rank 3/4).
  window.setInterval(fightTick, 500);
  window.setTimeout(fightTick, 120);

  // Live feed: ~40 seeded lines, then a new line every ~900ms. Timestamps are
  // monotonically non-decreasing: the seed's random steps are laid out
  // backwards from "just before now", so the backlog always ends where the
  // live lines pick up, and live lines are clamped to never step behind it.
  let lastFeedTs = 0;
  const emitFeedLine = (kind: string, message: string, ts: number): void => {
    lastFeedTs = Math.max(lastFeedTs, ts);
    const payload: LogLinePayload = { ts: lastFeedTs, message, event: kind };
    mockEmit("log-line", payload);
  };
  window.setTimeout(() => {
    const steps = Array.from({ length: 40 }, () => 0.5 + Math.random() * 1.6);
    let ts = Date.now() / 1000 - 1.2 - steps.reduce((s, x) => s + x, 0);
    for (let n = 0; n < 40; n++) {
      const [kind, message] = FEED[n % FEED.length];
      ts += steps[n];
      emitFeedLine(kind, message, ts);
    }
  }, 100);
  let feedIdx = 40;
  window.setInterval(() => {
    const [kind, message] = FEED[feedIdx++ % FEED.length];
    emitFeedLine(kind, message, Date.now() / 1000);
  }, 900);

  // Timers: three actives at different fractions; each restarts ~2.5s after
  // expiry so warn transitions and the expiry pulse keep exercising. Defs
  // with a `pending` cast time start as "casting…" bars and get a "landed"
  // event when the cast completes (item 12).
  const startTimer = (d: MockTimerDef, elapsed: number): void => {
    const pending = elapsed === 0 ? d.pending : undefined;
    const payload: TimerPayload = {
      name: d.name,
      kind: "started",
      durationSecs: d.duration,
      warnAtSecs: d.warn,
      lane: d.lane,
      elapsedSecs: elapsed,
      pendingSecs: pending,
    };
    mockEmit("timer", payload);
    if (pending) {
      window.setTimeout(() => {
        const landed: TimerPayload = {
          name: d.name,
          kind: "landed",
          lane: d.lane,
        };
        mockEmit("timer", landed);
      }, pending * 1000);
    }
    window.setTimeout(
      () => startTimer(d, 0),
      (d.duration - elapsed) * 1000 + 2600,
    );
  };
  window.setTimeout(() => TIMER_DEFS.forEach((d) => startTimer(d, d.elapsed)), 150);

  // Alerts: three quickly at boot (so a fresh screenshot shows a stack), then
  // one every ~4.2s to exercise appear/fade.
  let alertIdx = 0;
  const emitAlert = (): void => {
    const a = ALERTS[alertIdx++ % ALERTS.length];
    const payload: TriggerFiredPayload = {
      trigger: a.trigger,
      action: { kind: "displayText", text: a.text },
    };
    mockEmit("trigger-fired", payload);
  };
  for (const t of [250, 1000, 1800]) window.setTimeout(emitAlert, t);
  window.setTimeout(() => window.setInterval(emitAlert, 4200), 2600);

  // Session tracker (X10): seed structured loot + rolls at boot so the Fights
  // tab cards populate for screenshots, then trickle new ones in.
  window.setTimeout(() => {
    const now = Date.now() / 1000;
    SESSION_DEMO.forEach((line, i) => {
      mockEmit("log-line", { ...line, ts: now - (SESSION_DEMO.length - i) * 7 });
    });
    ROLL_DEMO.forEach((r, i) => {
      mockEmit("log-line", {
        ts: now - (ROLL_DEMO.length - i) * 5,
        message: `**A Magic Die is rolled by ${r.roller}. It could have been any number from ${r.min} to ${r.max}, but this time it turned up a ${r.result}.`,
        event: { Roll: r },
      });
    });
  }, 300);
  // A fresh drop + roll every so often to show the cards updating live.
  let sessionIdx = 0;
  window.setInterval(() => {
    const now = Date.now() / 1000;
    const loot = SESSION_DEMO[sessionIdx % SESSION_DEMO.length];
    mockEmit("log-line", { ...loot, ts: now });
    const r = ROLL_DEMO[sessionIdx % ROLL_DEMO.length];
    mockEmit("log-line", {
      ts: now,
      message: `**A Magic Die is rolled by ${r.roller}. It could have been any number from ${r.min} to ${r.max}, but this time it turned up a ${r.result}.`,
      event: { Roll: { ...r, result: Math.floor(Math.random() * (r.max - r.min + 1)) + r.min } },
    });
    sessionIdx += 1;
  }, 8000);

  // Patch-day canary: periodic tail-stats. Healthy by default; ?banners=1
  // demos the >3% amber state (plus session death and pack warnings).
  const emitStats = (): void => {
    const payload: TailStatsPayload = {
      unclassifiedPct: MOCK_BANNERS ? 4.6 : 0.4,
    };
    mockEmit("tail-stats", payload);
  };
  window.setTimeout(emitStats, 400);
  window.setInterval(emitStats, 5000);

  if (MOCK_BANNERS) {
    window.setTimeout(() => {
      mockTailing = false;
      const ended: SessionEndedPayload = {
        reason:
          "The log file became unreadable (Access is denied). Tailing stopped.",
      };
      mockEmit("session-ended", ended);
      const messages = [
        "generated/enchanter_buffs.json: trigger \"Clarity II\" pattern failed to compile: unclosed group",
        "curated/universal_raid.json: duplicate trigger id universal/raid/rampage — later copy ignored",
        "user pack: trigger \"Old harmshield\" references unknown sound file harm.wav",
      ];
      const warnings: PackWarningsPayload = {
        count: messages.length,
        messages,
      };
      mockEmit("pack-warnings", warnings);
    }, 1200);
  }
}
