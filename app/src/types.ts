// TypeScript mirrors of the payloads the Rust side sends. Keep in sync with
// app/src-tauri/src/{config,tailing,meters,commands}.rs and
// crates/eqlog-triggers/src/model.rs.

/** Persisted app configuration (config.json in the app config dir). */
export interface AppConfig {
  logPath: string;
  characterName: string;
  triggerPackPath: string;
  /** Named pets/charmed mobs (exact in-game names). Friendly casters for
   *  the trigger engine; folded into the character on the damage meter. */
  pets: string[];
  ttsDictionary?: { from: string; to: string }[];
  /** Windows TTS voice display name; "" or absent = system default. */
  ttsVoice?: string;
  /** Master audio mute: alert speech/sounds are dropped while set (Settings
   *  previews still play). Distinct from the one-shot Silence. */
  ttsMuted?: boolean;
  /** Drop stored fights older than this many days at startup. 0/absent =
   *  keep history forever. */
  fightRetentionDays?: number;
}

/** Overlay lane a timer routes to (eqlog-triggers TimerLane, lowercase).
 *  "on-others" = buffs YOU cast on OTHER people (its own overlay lane). */
export type TimerLane = "buff" | "enemy" | "on-others" | "other";
export type TimerStartMode = "restart" | "ignore-if-running" | "start-new-instance";

export interface TimerTiming {
  duration_secs?: number | null;
  cast_time_secs?: number | null;
}

/** Extensible trigger overlay identifier. Known overlays get autocomplete,
 * while plugins/future builds can introduce another string id. */
export type OverlayId = "alerts" | "impact" | (string & {});

/** Template fields and presentation config are overlay-defined. The engine
 * expands every field template before emitting `trigger-overlay`; config is
 * deliberately open so adding an overlay does not change the core contract. */
export interface TriggerOverlaySpec {
  overlay: OverlayId;
  fields: Record<string, string>;
  config?: Record<string, unknown>;
}

/** eqlog-triggers Action enum, serde externally-tagged. */
export type TriggerAction =
  | { Speak: { template: string } }
  | { PlaySound: { path: string } }
  | { DisplayText: { template: string } }
  | { Overlay: TriggerOverlaySpec }
  | { CancelTimer: { name: string } }
  /** Post to a named webhook (Discord batphone). The URL lives in app
   *  settings keyed by `webhook`; absent = the default webhook. */
  | { PostWebhook: { template: string; webhook?: string | null } }
  | {
      StartTimer: {
        name: string;
        duration_secs: number;
        warn_at_secs: number | null;
        /** Classic EQ duration formula id — generated packs carry it so the
         *  engine can rescale duration_secs to the profile's level. */
        duration_formula?: number | null;
        /** Duration cap in ticks (1 tick = 6 s); 0/absent = uncapped. */
        duration_cap_ticks?: number | null;
        /** Overlay lane; absent = engine infers from the trigger category. */
        lane?: TimerLane | null;
        /** Cast-time lead-in so expiry is anchored to the effect landing. */
        cast_time_secs?: number | null;
        /** Exact timing by captured Roman rank; missing fields inherit base. */
        rank_variants?: Record<string, TimerTiming>;
        mode?: TimerStartMode | null;
        repeat_secs?: number | null;
        stopwatch?: boolean;
        warn_text?: string | null;
        expire_text?: string | null;
        warn_sound?: string | null;
        expire_sound?: string | null;
      };
    }
  /** Fire a big Impact-overlay moment. `style` picks the visual treatment;
   *  the text fields are template-expanded from the matched line's captures. */
  | {
      Impact: {
        style: string;
        headline?: string | null;
        big?: string | null;
        sub?: string | null;
        glyph?: string | null;
        color?: string | null;
      };
    };

/** Trigger provenance (serde lowercase of eqlog-triggers TriggerSource). */
export type TriggerSource = "generated" | "curated" | "user" | "gina" | "shared";

/** eqlog-triggers Trigger model (snake/plain field names, no rename). */
export interface Trigger {
  name: string;
  pattern: string;
  enabled: boolean;
  actions: TriggerAction[];
  /** Folder path for UI grouping, e.g. "Combat/Defense". */
  category?: string | null;
  comments?: string | null;
  case_insensitive?: boolean;
  /** Stable slug id; when absent it derives from category + name. */
  id?: string | null;
  /** Class names this trigger applies to; empty/absent = all classes. */
  classes?: string[];
  /** On by default before profile overrides (default true). */
  default_enabled?: boolean;
  /** Provenance (default "user"; serde omits it for user triggers). */
  source?: TriggerSource;
  /** Refire cooldown in seconds — after firing, matching lines stay silent
   *  this long (anti-spam throttle). Absent/0 = fire on every match. */
  cooldown_secs?: number | null;
  priority?: number;
  suppress?: boolean;
  /** Zone-name substrings in which this trigger may fire. Empty = all zones. */
  zones?: string[];
}

/** The 16 Legends classes, exact names as used in pack `classes` arrays. */
export const CLASS_NAMES = [
  "Bard",
  "Beastlord",
  "Berserker",
  "Cleric",
  "Druid",
  "Enchanter",
  "Magician",
  "Monk",
  "Necromancer",
  "Paladin",
  "Ranger",
  "Rogue",
  "ShadowKnight",
  "Shaman",
  "Warrior",
  "Wizard",
] as const;

/** Name of the loadout legacy flat profiles migrate into (Rust side). */
export const DEFAULT_LOADOUT_NAME = "Default";

/** Per-trigger TTS/alert channel override. Each field is tri-state: absent =
 *  use the trigger's default; true/false = force that channel on/off. */
export interface ChannelOverride {
  speak?: boolean;
  alert?: boolean;
}

/** One named trigger configuration inside a character profile. */
export interface Loadout {
  name: string;
  /** Up to 3 class names (tri-class characters). */
  classes: string[];
  /** trigger-id or category-path-prefix -> forced on/off. */
  overrides: Record<string, boolean>;
  /** trigger-id -> forced TTS/alert channel state. */
  channel_overrides?: Record<string, ChannelOverride>;
  /** trigger-id -> alert severity tier override ("info"/"warn"/"alarm"),
   *  overriding the auto-classifier. Absent = auto-classify. */
  severity_overrides?: Record<string, string>;
  /** Trigger id/category prefix -> replacement zone scope for this loadout. */
  zone_scopes?: Record<string, string[]>;
  /** Trigger id -> Roman rank -> exact timing for this character/loadout. */
  timing_overrides?: Record<string, Record<string, TimerTiming>>;
}

/** Per-character trigger settings (profiles/<slug>.json on the Rust side).
 *  Serialized snake_case by the backend; legacy flat profiles migrate to a
 *  single "Default" loadout on the Rust side. */
export interface CharacterProfile {
  character: string;
  level: number;
  /** Name of the loadout in `loadouts` that is currently applied. */
  active_loadout: string;
  loadouts: Loadout[];
}

/** One trigger flattened for the Triggers-tab tree (get_trigger_tree). */
export interface TriggerTreeEntry {
  id: string;
  name: string;
  category: string | null;
  classes: string[];
  defaultEnabled: boolean;
  /** Profile resolution AND the pack-level enabled switch. */
  effectiveEnabled: boolean;
  enabled: boolean;
  source: TriggerSource;
  pattern: string;
  /** Output channels summarized from the trigger's actions, so the list can
   *  show at a glance whether a trigger speaks / shows a text alert / plays a
   *  sound / runs a timer / posts to a webhook. */
  speaks: boolean;
  shows: boolean;
  sound: boolean;
  timer: boolean;
  webhook: boolean;
  /** Fires a big Impact-overlay moment (Finishing Blow, level-up, crit, …). */
  impact: boolean;
  /** Generic overlay destinations used by this trigger, in action order. */
  overlays: string[];
  /** Index into the user pack for user/gina triggers; null for bundled. */
  userIndex: number | null;
}

/** Result of the detect_character_classes command. */

/** Result of the import_gina command. */
export interface GinaImportResult {
  imported: number;
  warnings: string[];
}

/**
 * eqlog-core Event enum, serde externally-tagged: unit variants serialize as
 * a bare string ("System", "Loading", ...), data variants as a single-key
 * object ({ MeleeHit: {...} }). We only need the variant name + raw fields
 * for display, so keep it loose.
 */
export type EqEvent = string | Record<string, Record<string, unknown>>;

export function eventKind(event: EqEvent): string {
  if (typeof event === "string") return event;
  const keys = Object.keys(event);
  return keys.length > 0 ? keys[0] : "Unknown";
}

/** "log-line" event payload. */
export interface LogLinePayload {
  ts: number;
  message: string;
  event: EqEvent;
}

/** Identity of the trigger that fired (NOW-sprint item 7). */
export interface TriggerIdentity {
  id: string;
  name: string;
}

/** "trigger-fired" event payload. */
export interface TriggerFiredPayload {
  /** Firing trigger's identity when the engine knows it. */
  trigger: TriggerIdentity | null;
  action: {
    kind:
      | "speak"
      | "playSound"
      | "displayText"
      | "startTimer"
      | "cancelTimer"
      | "webhook"
      | "impact"
      | "overlay";
    text: string;
  };
}

/** Shared `trigger-overlay` event emitted after an Overlay action matches. */
export interface TriggerOverlayPayload {
  trigger: TriggerIdentity | null;
  overlay: OverlayId;
  /** Template-expanded values interpreted by the destination overlay. */
  fields: Record<string, string>;
  /** Destination-specific presentation options. */
  config: Record<string, unknown>;
}

/** The visual treatment an Impact moment renders as. Comes from the trigger's
 *  Impact action `style` field; unknown values fall back to "badge". */
export type ImpactStyle = "slash" | "big-number" | "level" | "badge" | "medal";

/** A trigger-driven Impact moment — the payload of the `impact` event. Every
 *  field is filled by the trigger's Impact action (template-expanded from the
 *  matched log line); NOTHING about a moment is hardcoded. The overlay assigns
 *  `id` locally for animation keying. */
export interface ImpactPayload {
  id: number;
  /** Visual treatment. */
  style: ImpactStyle | string;
  /** Small eyebrow line above the focal text (e.g. "FINISHING BLOW"). */
  headline?: string;
  /** The large focal text — a number or short word. */
  big?: string;
  /** Secondary line (who/what/target). */
  sub?: string;
  /** Emoji/glyph for badge/medal styles. */
  glyph?: string;
  /** Accent color (any CSS color) overriding the style default. */
  color?: string;
}

/** The `impact` event payload as emitted by the backend (no local `id`). */
export type ImpactEvent = Omit<ImpactPayload, "id">;

/** Parsed combat effect forwarded to analytics views. Alerts and TTS are
 * deliberately trigger-owned and never consume this event. */
export interface EffectObservedPayload {
  kind: "spell";
  spell: string;
  target: string;
  amount: number | null;
  critical: boolean;
}

/** "timer" event payload. */
export interface TimerPayload {
  name: string;
  kind: "started" | "warning" | "expired" | "cancelled" | "landed";
  /** Present on "started". */
  durationSecs?: number;
  warnAtSecs?: number | null;
  /** Overlay lane; present on "started"/"warning"/"landed"/"expired". */
  lane?: TimerLane;
  /** Cast-time lead-in on "started": the bar renders as a pending
   *  ("casting…") state until the "landed" event arrives (item 12). */
  pendingSecs?: number;
  /** Optional: seconds already elapsed at "started" (mock driver only). */
  elapsedSecs?: number;
}

/** One running timer from the `get_active_timers` resync command (P3): a
 *  window reopened mid-session, or the whole app restarted, seeds its timer
 *  state from these so live countdowns survive a reload. */
export interface ActiveTimerSnapshot {
  name: string;
  durationSecs: number;
  elapsedSecs: number;
  warnAtSecs: number | null;
  lane: TimerLane;
  pendingSecs: number;
}

/** One damage source under a meter row (item 15): melee verb, spell name,
 *  or "<effect> (damage shield)"; pet sources carry a "(pet)" suffix. */
export interface MeterSourceRow {
  name: string;
  total: number;
  hits?: number;
  crits?: number;
  maxHit?: number;
  /** Failed melee attempts on this source (drives the Acc% column). */
  misses?: number;
  /** Times this spell source was cast (drives the per-cast readout). */
  casts?: number;
}

export interface MeterRow {
  name: string;
  total: number;
  /** Portion of total damage contributed by attributed pets. */
  petDamage?: number;
  dps: number;
  pct: number;
  /** True when a pet's damage is folded into this row. */
  pet?: boolean;
  /** Optional breakdown for the hover tooltip. */
  hits?: number;
  misses?: number;
  crits?: number;
  maxHit?: number;
  /** Actual healing done by this combatant (X2 healing meter mode). */
  healing?: number;
  /** Potential-minus-actual healing when overheal syntax was present. */
  overheal?: number;
  /** Damage received from the fight target (X2 taken meter mode). */
  damageTaken?: number;
  /** Per-source breakdown, total descending (expandable rows, item 15). */
  sources?: MeterSourceRow[];
}

/** "fight-update" event payload (throttled ~2/sec). */
export interface FightUpdatePayload {
  /** NPC target of the fight being shown. */
  target: string;
  durationSecs: number;
  totalDamage: number;
  active: boolean;
  rows: MeterRow[];
}

/** One row of the live caster resist/fizzle/land% view (`cast-update` event,
 *  P45). Percentages are precomputed by the backend. */
export interface CastRow {
  caster: string;
  spell: string;
  /** Attempts (CastBegin count, floored to failures). */
  casts: number;
  landed: number;
  fizzles: number;
  resists: number;
  interrupts: number;
  landPct: number;
  fizzlePct: number;
  resistPct: number;
}

/** One persisted fight from the SQLite store (list_fights / get_fight). */
export interface FightRecord {
  id: number;
  target: string;
  /** Unix seconds of the first / last event of the fight. */
  startTs: number;
  endTs: number;
  durationSecs: number;
  totalDamage: number;
  targetSlain: boolean;
  /** Combatant rows shaped like the live meter rows (damage desc). */
  rows: MeterRow[];
}

/** One page of fight history. `total` is null when the backend command
 *  returns a bare array (count unknown — paginate by "got a full page"). */
export interface FightPage {
  fights: FightRecord[];
  total: number | null;
}

/** One log file found by discover_logs (first-run onboarding). */
export interface DiscoveredLog {
  path: string;
  /** Character / server parsed from eqlog_<Character>_<server>.txt. */
  character: string;
  server: string;
  /** Unix seconds of last modification; null when unknown. */
  modifiedTs: number | null;
}

/** "session-ended" event payload — the tail thread died unexpectedly. */
export interface SessionEndedPayload {
  reason: string;
}

/** "catch-up" event payload (item 13): the tail session is replaying old
 *  log content (alerts + fight-history writes suppressed) or just finished
 *  doing so (`active: false`, with the suppressed-line count). */
export interface CatchUpPayload {
  active: boolean;
  lines: number;
}

/**
 * "pack-warnings" event payload — problems while loading trigger packs.
 * Emitted at every engine build; count 0 clears a stale banner.
 */
export interface PackWarningsPayload {
  count: number;
  messages: string[];
}

/** "tail-stats" periodic event payload (patch-day canary). */
export interface TailStatsPayload {
  /** Percent (0–100) of recent lines the parser could not classify,
   *  over a rolling window (~1000 lines). */
  unclassifiedPct: number;
}

/** Result of the share_import command (and its mock twin). */
export interface ShareImportResult {
  imported: number;
  /** (colliding id, assigned id) pairs from the dedupe pass. */
  renamed: [string, string][];
}

/** "overlay-lock-changed" payload, emitted when click-through is toggled. */
export interface OverlayLockPayload {
  label: string;
  clickThrough: boolean;
}

export const OVERLAY_ALERTS = "overlay-alerts";
export const OVERLAY_BUFFS = "overlay-buffs";
export const OVERLAY_TARGET = "overlay-target";
export const OVERLAY_METER = "overlay-meter";
export const OVERLAY_STANCE = "overlay-stance";
export const OVERLAY_ONOTHERS = "overlay-onothers";
export const OVERLAY_XP = "overlay-xp";
export const OVERLAY_PACE = "overlay-pace";
export const OVERLAY_RESPAWN = "overlay-respawn";
export const OVERLAY_IMPACT = "overlay-impact";
export const OVERLAY_SCOREBOARD = "overlay-scoreboard";

/** All overlay window labels, in top-bar/Settings display order. */
export const OVERLAY_LABELS = [
  OVERLAY_ALERTS,
  OVERLAY_BUFFS,
  OVERLAY_ONOTHERS,
  OVERLAY_TARGET,
  OVERLAY_METER,
  OVERLAY_XP,
  OVERLAY_PACE,
  OVERLAY_STANCE,
  OVERLAY_RESPAWN,
  OVERLAY_IMPACT,
  OVERLAY_SCOREBOARD,
] as const;

/** Timer-name convention for per-target enemy effects: "<Effect> — <target>"
 *  (e.g. "Root — a fallen knight"). Split on the em-dash separator; names
 *  without one have no known target (v1 generated packs key enemy timers by
 *  spell name only). */
export function splitTimerTarget(name: string): {
  label: string;
  target: string | null;
} {
  const idx = name.indexOf(" \u2014 "); // " \u2014 " = em dash
  if (idx < 0) return { label: name, target: null };
  const label = name.slice(0, idx);
  const target = name.slice(idx + 3);
  return target ? { label, target } : { label: name, target: null };
}

/** Render a Windows-style path (display only; state keeps whatever the user picked). */
export function displayPath(p: string): string {
  return p.replace(/\//g, "\\");
}

export const DEFAULT_LOG_DIR =
  "C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs";

// ---------------------------------------------------------------------------
// Drops research database (bundled classic-era PEQ reference data).
// ---------------------------------------------------------------------------

export interface DropItemRow {
  id: number;
  name: string;
  itemtype: number;
  slots: number;
  classes: number;
  races: number;
  ac: number;
  hp: number;
  mana: number;
  astr: number;
  asta: number;
  aagi: number;
  adex: number;
  awis: number;
  aint: number;
  acha: number;
  damage: number;
  delay: number;
  magic: number;
  noDrop: number;
  noRent: number;
  loregroup: number;
  weight: number;
  reqlevel: number;
  haste: number;
  procName: string | null;
  clickName: string | null;
  wornName: string | null;
  focusName: string | null;
  /** Distinct dropping NPCs within the era filter. */
  sources: number;
  /** Highest-chance dropping mob (zone-filter preferred), and its zone. */
  topNpc: string | null;
  topZone: string | null;
}

export interface DropSearchResult {
  total: number;
  rows: DropItemRow[];
}

export interface DropEffect {
  name: string;
  /** "proc" | "click" | "worn" | "focus" */
  kind: string;
  items: number;
}

export interface DropZone {
  shortName: string;
  longName: string;
  era: number;
}

export interface DropSource {
  npc: string;
  level: number;
  zone: string | null;
  zoneLong: string | null;
  era: number | null;
  chance: number;
  spawns: number | null;
}

/** Result of refdb_respawn_for: reference respawn data for a slain NPC
 *  (bundled classic-era database). Null from the command = unknown NPC. */
export interface RespawnInfo {
  npcId: number;
  name: string;
  /** 1 = named/rare spawn, 0 = trash. */
  named: number;
  respawnSecs: number;
  zoneLong: string | null;
}

// ---------------------------------------------------------------------------
// Spell/ability reference database (same bundled sqlite as drops).
// ---------------------------------------------------------------------------

export interface SpellRow {
  id: number;
  name: string;
  /** 1 = endurance-costed combat ability, 0 = spell. */
  isAbility: number;
  mana: number;
  endurance: number;
  castTimeMs: number;
  recastMs: number;
  durationSecs: number;
  spellRange: number;
  targetType: number;
  resistType: number;
  skill: number;
  beneficial: number;
  castOnYou: string | null;
  castOnOther: string | null;
  wearOff: string | null;
  /** "Enchanter 12, Necromancer 16" — full class names with levels. */
  classesStr: string | null;
  /** The filtered class's level (null when no class filter is set). */
  classLevel: number | null;
}

export interface SpellSearchResult {
  total: number;
  rows: SpellRow[];
}

/** One spell/ability newly trainable at a level — the ding digest (P8). */
export interface UnlockRow {
  id: number;
  name: string;
  isAbility: number;
  /** The character class(es) that gain this at the level, e.g. "Enchanter". */
  classes: string;
  mana: number;
  beneficial: number;
}

// ---------------------------------------------------------------------------
// Reference DB v2: mobs, vendors, recipes, zone info (same bundled sqlite).
// All payloads are serde camelCase from the refdb_* commands.
// ---------------------------------------------------------------------------

/** One merchant selling an item (refdb_item_vendors). */
export interface ItemVendor {
  npc: string;
  level: number;
  zone: string | null;
  zoneLong: string | null;
  era: number | null;
}

/** One NPC row from refdb_mob_search. */
export interface MobRow {
  id: number;
  name: string;
  level: number;
  /** 1 = named/rare spawn. */
  named: number;
  /** 1 = merchant (sells items). */
  merchant: number;
  topZone: string | null;
  lootCount: number;
  /** 0 = unknown. */
  respawnSecs: number;
}

export interface MobSearchResult {
  total: number;
  rows: MobRow[];
}

export interface MobZone {
  zone: string;
  zoneLong: string | null;
  era: number | null;
  spawns: number;
  respawnSecs: number;
}

export interface MobLootRow {
  itemId: number;
  item: string;
  chance: number;
  /** Optional item-type/slot hints if the backend ever provides them
   *  (drive the item-type icon; absent = generic icon). */
  itemtype?: number | null;
  slots?: number | null;
}

export interface MobSellRow {
  itemId: number;
  item: string;
}

/** Full NPC detail (refdb_mob_detail). */
export interface MobDetail {
  id: number;
  name: string;
  level: number;
  named: number;
  faction: string | null;
  zones: MobZone[];
  loot: MobLootRow[];
  sells: MobSellRow[];
}

/** One scribeable scroll teaching a spell (refdb_spell_scrolls). */
export interface SpellScroll {
  itemId: number;
  item: string;
  dropCount: number;
  vendorCount: number;
  /** Preformatted "best drop" / "best vendor" hint strings; null = none. */
  topDrop: string | null;
  topVendor: string | null;
}

/** Recipe reference row (refdb_recipe_search rows, refdb_item_recipes). */
export interface RecipeRef {
  id: number;
  name: string;
  tradeskill: number;
  trivial: number;
}

/** Recipes an item participates in (refdb_item_recipes). */
export interface ItemRecipes {
  /** Recipes consuming this item as a component. */
  usedIn: RecipeRef[];
  /** Recipes producing this item. */
  makes: RecipeRef[];
}

export interface RecipeComponent {
  itemId: number;
  item: string;
  count: number;
  /** Preformatted farming hints; null = none known. */
  topDrop: string | null;
  topVendor: string | null;
}

export interface RecipeResult {
  itemId: number;
  item: string;
  count: number;
}

/** Full recipe detail (refdb_recipe_detail). */
export interface RecipeDetail {
  id: number;
  name: string;
  tradeskill: number;
  trivial: number;
  noFail: number | boolean;
  components: RecipeComponent[];
  results: RecipeResult[];
}

export interface RecipeSearchResult {
  total: number;
  rows: RecipeRef[];
}

/** EQ tradeskill ids → display names. Ids outside the map render as the
 *  raw number (tradeskillName) — the data is the source of truth. */
export const TRADESKILL_NAMES: Record<number, string> = {
  55: "Fishing",
  56: "Make Poison",
  57: "Tinkering",
  58: "Research",
  59: "Alchemy",
  60: "Baking",
  61: "Tailoring",
  63: "Blacksmithing",
  64: "Fletching",
  65: "Brewing",
  68: "Jewelry Making",
  69: "Pottery",
};

export function tradeskillName(id: number): string {
  return TRADESKILL_NAMES[id] ?? `Tradeskill #${id}`;
}

export interface ZoneConnection {
  zone: string;
  zoneLong: string | null;
  era: number | null;
}

/** One forage/fishing yield row in refdb_zone_info. */
export interface ZoneGatherRow {
  itemId: number;
  item: string;
  chance: number;
}

export interface ZoneNamedMob {
  id: number;
  name: string;
  level: number;
  respawnSecs: number;
}

/** Zone almanac (refdb_zone_info). */
export interface ZoneInfo {
  shortName: string;
  longName: string;
  era: number;
  connections: ZoneConnection[];
  forage: ZoneGatherRow[];
  fishing: ZoneGatherRow[];
  namedMobs: ZoneNamedMob[];
}

/** Reference-data update channel state (data_update_check). */
export interface DataUpdateInfo {
  /** Installed data version (version.txt); null = bundled data only. */
  current: string | null;
  /** Latest version published on the data-latest release. */
  latest: string;
  updateAvailable: boolean;
  /** Total download size of the data pack, in bytes. */
  totalBytes: number;
}

/** Trigger-library update channel state (trigger_update_check). */
export interface TriggerUpdateInfo {
  /** Installed trigger-library version; null = bundled library only. */
  current: string | null;
  /** Latest version published on the rolling trigger release. */
  latest: string;
  updateAvailable: boolean;
  /** Trigger-library download size, in bytes. */
  totalBytes: number;
}
