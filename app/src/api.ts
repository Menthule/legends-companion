import { invoke } from "@tauri-apps/api/core";
import {
  confirm as dialogConfirm,
  open as dialogOpen,
} from "@tauri-apps/plugin-dialog";
import soundManifest from "../../assets/sounds/manifest.json";
import {
  IS_MOCK,
  MOCK_ZONES,
  mockCareerImport,
  mockCareerLevelTimeline,
  mockCareerLoot,
  mockCareerMobDrops,
  mockCareerMobKills,
  mockCareerReset,
  mockCareerSessions,
  mockCareerSummary,
  mockDiscoverLogs,
  mockEmit,
  mockGetConfig,
  mockGetFight,
  mockGetProfile,
  mockGetTriggers,
  mockGetTriggerTree,
  mockIsTailing,
  mockListFights,
  mockSaveTriggers,
  mockSetConfig,
  mockSetOverride,
  mockSetChannelOverride,
  mockSetProfile,
  mockSetTailing,
  mockShareImport,
  mockSetActiveCharacter,
  mockSwitchLoadout,
} from "./mock";
import { buildShareString } from "./lib/share";
import { formatParse, type ParseInput } from "./lib/parseText";
import type { InventorySnapshot } from "./lib/quests";
import type {
  ActiveTimerSnapshot,
  AppConfig,
  CareerImportReport,
  CareerLevelUp,
  CareerLootRow,
  CareerMobDrop,
  CareerMobKills,
  CareerSession,
  CareerSummary,
  CharacterProfile,
  DataUpdateInfo,
  DiscoveredLog,
  DropEffect,
  DropSearchResult,
  DropSource,
  QuestItemReference,
  DropZone,
  FightPage,
  FightRecord,
  GinaImportResult,
  ItemRecipes,
  ItemVendor,
  MeterRow,
  MobDetail,
  MobSearchResult,
  RecipeDetail,
  RecipeSearchResult,
  RespawnInfo,
  ShareImportResult,
  SpellScroll,
  SpellSearchResult,
  UnlockRow,
  Trigger,
  TriggerTreeEntry,
  TriggerUpdateInfo,
  WatchList,
  QuestWatchInput,
  InventoryWatchQuantity,
  ZoneInfo,
} from "./types";

export function getConfig(): Promise<AppConfig> {
  if (IS_MOCK) return Promise.resolve(mockGetConfig());
  return invoke<AppConfig>("get_config");
}

export function setConfig(config: AppConfig): Promise<void> {
  if (IS_MOCK) {
    mockSetConfig(config);
    return Promise.resolve();
  }
  return invoke("set_config", { config });
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Check the release channel for a newer signed build. Resolves null when
 *  already current, in mock, or on any error (offline/dev) — never rejects, so
 *  the update banner stays silent instead of nagging. */
export function checkUpdate(): Promise<UpdateInfo | null> {
  if (IS_MOCK) return Promise.resolve(null);
  return invoke<UpdateInfo | null>("check_update").catch(() => null);
}

/** Download + install the pending update and relaunch. */
export function installUpdate(): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return invoke("install_update");
}

// ---- reference-data update channel (drops.sqlite + trigger packs) ----

/** Installed reference-data version (version.txt in refdata-update/).
 *  Resolves null when only the bundled data is present, in mock mode, or on
 *  any error — never rejects. */
export function dataVersion(): Promise<string | null> {
  if (IS_MOCK) return Promise.resolve(null);
  return invoke<string | null>("data_version").catch(() => null);
}

/** Compare the installed data version against the rolling data-latest
 *  release. Rejects on network/manifest errors — the Updates section shows
 *  the failure quietly in its status line. */
export function dataUpdateCheck(): Promise<DataUpdateInfo> {
  if (IS_MOCK) {
    return Promise.resolve({
      current: null,
      latest: "",
      updateAvailable: false,
      totalBytes: 0,
    });
  }
  return invoke<DataUpdateInfo>("data_update_check");
}

/** Download, verify, and install the data pack; resolves to the installed
 *  version. A tailing session picks up new trigger packs on its next Start
 *  (or hot rebuild); drops queries use the new database immediately. */
export function dataUpdateInstall(): Promise<string> {
  if (IS_MOCK) {
    return Promise.reject(new Error("Data updates need the desktop app."));
  }
  return invoke<string>("data_update_install");
}

// ---- trigger-library update channel ----

/** Installed trigger-library version, or null when using the app bundle. */
export function triggerVersion(): Promise<string | null> {
  if (IS_MOCK) return Promise.resolve(null);
  return invoke<string | null>("trigger_version").catch(() => null);
}

/** Compare the installed trigger library with the rolling trigger release. */
export function triggerUpdateCheck(): Promise<TriggerUpdateInfo> {
  if (IS_MOCK) {
    return Promise.resolve({
      current: null,
      latest: "",
      updateAvailable: false,
      totalBytes: 0,
    });
  }
  return invoke<TriggerUpdateInfo>("trigger_update_check");
}

/** Download, verify, and install the latest trigger library. */
export function triggerUpdateInstall(): Promise<string> {
  if (IS_MOCK) {
    return Promise.reject(new Error("Trigger updates need the desktop app."));
  }
  return invoke<string>("trigger_update_install");
}

/** Size of the configured log file, for the Settings "large log" nudge.
 *  `sizeBytes` is null when the path is unset/unreadable (or in mock mode's
 *  absence of a real file). Never rejects — a failed invoke maps to null. */
export function getLogStats(): Promise<{ sizeBytes: number | null }> {
  // ~180 MB, so mock mode shows the size line without tripping the warning.
  if (IS_MOCK) return Promise.resolve({ sizeBytes: 188_743_680 });
  return invoke<{ sizeBytes: number | null }>("log_stats").catch(() => ({
    sizeBytes: null,
  }));
}

export function getTriggers(): Promise<Trigger[]> {
  if (IS_MOCK) return Promise.resolve(mockGetTriggers());
  return invoke<Trigger[]>("get_triggers");
}

// ---- character-scoped item watches ----

const EMPTY_WATCH_LIST: WatchList = {
  server: "",
  character: "",
  legacyNamesImported: false,
  items: [],
};

export function watchList(): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_list");
}

export function watchAddManual(
  itemName: string,
  quantity = 1,
  autoRemove = true,
): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_add_manual", { itemName, quantity, autoRemove });
}

export function watchAddQuestGoal(goal: QuestWatchInput): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_add_quest_goal", { goal });
}

export function watchAddQuestGoals(goals: QuestWatchInput[]): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_add_quest_goals", { goals });
}

export function watchRemoveItem(itemName: string): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_remove_item", { itemName });
}

export function watchRemoveQuestGoal(itemName: string, questId: string): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_remove_quest_goal", { itemName, questId });
}

export function watchRemoveQuestGoals(questId: string): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_remove_quest_goals", { questId });
}

export function watchUpdateGoal(
  itemName: string,
  goalId: string,
  values: { enabled?: boolean; autoRemove?: boolean; remainingQuantity?: number },
): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_update_goal", { itemName, goalId, ...values });
}

export function watchReconcileInventory(inventory: InventoryWatchQuantity[]): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<WatchList>("watch_reconcile_inventory", { inventory });
}

export function watchImportLegacyNames(names: string[]): Promise<WatchList> {
  if (IS_MOCK) return Promise.resolve(EMPTY_WATCH_LIST);
  return invoke<{ watchList: WatchList }>("watch_import_legacy_names", { names })
    .then((result) => result.watchList);
}

/** Running timers snapshot for UI resync after a window reload (P3). Mock mode
 *  drives timers via events, so no seed is needed there. */
export function getActiveTimers(): Promise<ActiveTimerSnapshot[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<ActiveTimerSnapshot[]>("get_active_timers").catch(() => []);
}

// Trigger-pack change notifications, so views that hold trigger state (the
// Triggers tab) refresh when another view (quick-trigger modal) saves.
type TriggersListener = () => void;
const triggerListeners = new Set<TriggersListener>();

/** Subscribe to trigger-pack saves; returns an unsubscribe function. */
export function onTriggersChanged(cb: TriggersListener): () => void {
  triggerListeners.add(cb);
  return () => {
    triggerListeners.delete(cb);
  };
}

function notifyTriggersChanged(): void {
  for (const cb of [...triggerListeners]) cb();
}

export async function saveTriggers(triggers: Trigger[]): Promise<void> {
  if (IS_MOCK) {
    mockSaveTriggers(triggers);
  } else {
    await invoke("save_triggers", { triggers });
  }
  notifyTriggersChanged();
}

/** Append custom triggers to the user pack atomically (P15) — the backend does
 *  load→extend→save under a lock, so this never clobbers a concurrent import
 *  the way a client-side getTriggers()+saveTriggers() read-modify-write could. */
export async function appendTriggers(triggers: Trigger[]): Promise<void> {
  if (IS_MOCK) {
    mockSaveTriggers([...mockGetTriggers(), ...triggers]);
  } else {
    await invoke("append_triggers", { triggers });
  }
  notifyTriggersChanged();
}

// ---- trigger library v2: profile + tree ----

export function getProfile(): Promise<CharacterProfile> {
  if (IS_MOCK) return Promise.resolve(mockGetProfile());
  return invoke<CharacterProfile>("get_profile");
}

export async function setProfile(profile: CharacterProfile): Promise<void> {
  if (IS_MOCK) mockSetProfile(profile);
  else await invoke("set_profile", { profile });
  notifyTriggersChanged();
}

/**
 * Make a different loadout the active one (case-insensitive name). The
 * backend persists the canonical name, hot-reloads the running engine, and
 * emits "profile-changed"; the updated profile is also returned directly.
 */
export async function switchLoadout(name: string): Promise<CharacterProfile> {
  const profile = IS_MOCK
    ? mockSwitchLoadout(name)
    : await invoke<CharacterProfile>("switch_loadout", { name });
  notifyTriggersChanged();
  return profile;
}

/**
 * Switch the active character (server + character identity). The backend
 * re-points the tailed log at that character's file, loads its profile
 * (fresh default if none), rebuilds the engine if tailing, and re-emits
 * "config-changed" / "profile-changed" — so the top bar and profile sync
 * via those events. In mock mode we update the in-memory profile directly.
 */
export async function setActiveCharacter(server: string, character: string): Promise<void> {
  if (IS_MOCK) {
    mockSetActiveCharacter(server, character);
    notifyTriggersChanged();
    return;
  }
  await invoke("set_active_character", { server, character });
}

/** The merged bundled-packs + user-pack triggers, profile-resolved. */
export function getTriggerTree(): Promise<TriggerTreeEntry[]> {
  if (IS_MOCK) return Promise.resolve(mockGetTriggerTree());
  return invoke<TriggerTreeEntry[]>("get_trigger_tree");
}

/** Set (value true/false) or clear (value null) one enable override. */
export async function setOverride(
  key: string,
  value: boolean | null,
): Promise<void> {
  if (IS_MOCK) mockSetOverride(key, value);
  else await invoke("set_override", { key, value });
  notifyTriggersChanged();
}

/** Force a trigger's TTS (`speak`) and/or text-alert (`alert`) channel on/off
 *  for the active loadout. Each is tri-state: `true`/`false` sets it, `null`
 *  leaves it unchanged. Works for bundled pack triggers, not just user ones. */
export async function setChannelOverride(
  id: string,
  speak: boolean | null,
  alert: boolean | null,
): Promise<void> {
  if (IS_MOCK) mockSetChannelOverride(id, speak, alert);
  else await invoke("set_channel_override", { id, speak, alert });
  notifyTriggersChanged();
}

/** Override a trigger's alert severity tier ("info"/"warn"/"alarm"), or clear
 *  it (null) to restore the auto-classifier. Persisted per active loadout. */
export async function setSeverityOverride(
  id: string,
  severity: string | null,
): Promise<void> {
  if (IS_MOCK) {
    notifyTriggersChanged();
    return;
  }
  await invoke("set_severity_override", { id, severity });
  notifyTriggersChanged();
}

/** Guess the character's classes from spell names seen in cast lines. */

/** Import a GINA .gtp package; returns count + per-trigger warnings. */
export function importGina(path: string): Promise<GinaImportResult> {
  if (IS_MOCK) {
    return Promise.reject(new Error("GINA import needs the desktop app."));
  }
  return invoke<GinaImportResult>("import_gina", { path });
}

export function startTailing(): Promise<void> {
  if (IS_MOCK) {
    mockSetTailing(true);
    return Promise.resolve();
  }
  return invoke("start_tailing");
}

export function stopTailing(): Promise<void> {
  if (IS_MOCK) {
    mockSetTailing(false);
    return Promise.resolve();
  }
  return invoke("stop_tailing");
}

export function isTailing(): Promise<boolean> {
  if (IS_MOCK) return Promise.resolve(mockIsTailing());
  return invoke<boolean>("is_tailing");
}

/** Kill switch (item 14): drop queued TTS/sounds and cut the current
 *  utterance. No-op in mock mode (there is no audio thread). */
/** Installed Windows TTS voice names for the Settings picker. */
export function listTtsVoices(): Promise<string[]> {
  if (IS_MOCK) return Promise.resolve(["Microsoft David", "Microsoft Zira"]);
  return invoke<string[]>("list_tts_voices").catch(() => []);
}

export function silenceAudio(): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return invoke("silence_audio");
}

/** Speak text through the app TTS queue — same voice, pronunciation
 *  dictionary, and silence kill-switch as trigger speech. Best-effort:
 *  no-op in mock mode, never rejects. */
export function speakText(text: string): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return invoke<void>("speak_text", { text }).catch(() => {});
}

/** A camp timer's mob is back up. Shown on the alerts overlay (visual only —
 *  respawn is glanceable info, not worth speaking over combat). Broadcast to
 *  every window via the Tauri event bus; OverlayAlerts renders it. */
export function announceCampRespawn(name: string): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return import("@tauri-apps/api/event")
    .then((m) => m.emit("camp-respawn", { name }))
    .catch(() => {});
}

/** Reference respawn data for a slain NPC (bundled classic-era database).
 *  Resolves null for unknown NPCs, in mock mode, or when the backend
 *  command is unavailable — never rejects. */
export function refdbRespawnFor(name: string): Promise<RespawnInfo | null> {
  if (IS_MOCK) return Promise.resolve(null);
  return invoke<RespawnInfo | null>("refdb_respawn_for", { name }).catch(
    () => null,
  );
}

// ---- bundled alert sounds ----

/** One bundled alert sound (mirror of the planned `list_sounds` command). */
export interface SoundInfo {
  label: string;
  file: string;
  /** Resolved path to store in PlaySound.path ("assets/sounds/<file>" in
   *  mock/fallback mode; an absolute resource path from the backend). */
  path: string;
  duration_ms: number;
  description: string;
}

interface ManifestEntry {
  file: string;
  label: string;
  description: string;
  duration_ms: number;
}

const FALLBACK_SOUNDS: SoundInfo[] = (soundManifest as ManifestEntry[]).map(
  (m) => ({
    label: m.label,
    file: m.file,
    path: `assets/sounds/${m.file}`,
    duration_ms: m.duration_ms,
    description: m.description,
  }),
);

/** Bundled sounds; falls back to the static manifest when the backend
 *  command is unavailable (mock mode, or the command hasn't shipped yet). */
export async function listSounds(): Promise<SoundInfo[]> {
  if (!IS_MOCK) {
    try {
      return await invoke<SoundInfo[]>("list_sounds");
    } catch {
      // command not available yet — fall back to the bundled manifest
    }
  }
  return FALLBACK_SOUNDS;
}

/** Play a sound once for preview. Rejects when nothing could be played so
 *  the editor can show real feedback (a silently-broken custom sound file
 *  is the shared-trigger failure case). */
export async function previewSound(path: string): Promise<void> {
  if (!IS_MOCK) {
    try {
      await invoke("preview_sound", { path });
      return;
    } catch {
      // command not available yet — try the browser audio element below
    }
  }
  // Rejects (NotSupportedError / NotAllowedError) when the file is missing
  // or unplayable — propagate to the caller.
  await new Audio(path).play();
}

/** Ask the user to confirm a destructive action. Uses the native dialog
 *  in the desktop app and window.confirm in mock/browser mode. */
export async function confirmDiscard(
  message: string,
  title = "Unsaved changes",
): Promise<boolean> {
  if (!IS_MOCK) {
    try {
      return await dialogConfirm(message, {
        title,
        kind: "warning",
      });
    } catch {
      // dialog plugin unavailable — fall back to the browser dialog
    }
  }
  return window.confirm(message);
}

// ---- fight history (NOW-sprint item 2) ----

/** Tolerant mapper: accepts the raw store shape (snake_case FightSummary
 *  fields, CombatantRow rows) as well as an already-camelCased payload, so
 *  the frontend keeps working whichever the backend command settles on. */
function normalizeFight(raw: unknown): FightRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const summary =
    typeof o.summary === "object" && o.summary !== null
      ? (o.summary as Record<string, unknown>)
      : o;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const pick = (a: unknown, b: unknown): unknown => (a !== undefined ? a : b);
  const isObj = (r: unknown): r is Record<string, unknown> =>
    typeof r === "object" && r !== null;
  const rowsRaw = Array.isArray(summary.rows) ? summary.rows : [];
  const rows: MeterRow[] = rowsRaw
    .filter(isObj)
    .map((r) => ({
      name: String(r.name ?? "?"),
      total: num(pick(r.total, r.damage)),
      petDamage: num(pick(r.petDamage, r.pet_damage)),
      dps: num(r.dps),
      pct: num(pick(r.pct, r.percent)),
      pet: num(pick(r.pet_damage, r.petDamage)) > 0 || r.pet === true,
      hits: num(r.hits),
      misses: num(r.misses),
      crits: num(r.crits),
      maxHit: num(pick(r.maxHit, r.max_hit)),
      healing: num(r.healing),
      overheal: num(r.overheal),
      damageTaken: num(pick(r.damageTaken, r.damage_taken)),
      // Per-source breakdown (item 15). Accepts the camelCased store shape
      // and the raw snake_case FightSummary rows; older stored fights have
      // no sources at all. misses/casts ride along for the skill table's
      // Acc% / per-cast columns; the total>0 filter keeps the damage table
      // (and its expand) unchanged for stored fights.
      sources: (Array.isArray(r.sources) ? r.sources : [])
        .filter(isObj)
        .map((s) => ({
          name: String(s.name ?? "?"),
          total: num(s.total),
          hits: num(s.hits),
          crits: num(s.crits),
          maxHit: num(pick(s.maxHit, s.max_hit)),
          misses: num(s.misses),
          casts: num(s.casts),
        }))
        .filter((s) => s.total > 0),
    }))
    .filter((r) => r.total > 0);
  return {
    id: num(o.id),
    target: String(summary.target ?? "?"),
    startTs: num(pick(summary.startTs, summary.start_ts)),
    endTs: num(pick(summary.endTs, summary.end_ts)),
    durationSecs: num(pick(summary.durationSecs, summary.duration_secs)),
    totalDamage: num(pick(summary.totalDamage, summary.total_damage)),
    targetSlain: Boolean(pick(summary.targetSlain, summary.target_slain)),
    rows,
  };
}

/** Page through persisted fights, newest first. */
export async function listFights(
  limit: number,
  offset: number,
): Promise<FightPage> {
  if (IS_MOCK) return mockListFights(limit, offset);
  const raw = await invoke<unknown>("list_fights", { limit, offset });
  if (Array.isArray(raw)) {
    return {
      fights: raw.map(normalizeFight).filter((f): f is FightRecord => f !== null),
      total: null,
    };
  }
  const o = (raw ?? {}) as { fights?: unknown[]; total?: number };
  return {
    fights: (o.fights ?? [])
      .map(normalizeFight)
      .filter((f): f is FightRecord => f !== null),
    total: typeof o.total === "number" ? o.total : null,
  };
}

export async function getFight(id: number): Promise<FightRecord | null> {
  if (IS_MOCK) return mockGetFight(id);
  return normalizeFight(await invoke<unknown>("get_fight", { id }));
}

/** Delete one stored fight (Fights-tab × button). Returns whether a row went. */
export async function deleteFight(id: number): Promise<boolean> {
  if (IS_MOCK) return true;
  return (await invoke<boolean>("delete_fight", { id })) === true;
}

/** Prune history: keep the newest N and/or drop everything before a timestamp.
 *  "Clear history" passes keepLastN: 0. Returns rows removed. */
export async function pruneFights(opts: {
  keepLastN?: number;
  beforeTs?: number;
}): Promise<number> {
  if (IS_MOCK) return 0;
  return (
    (await invoke<number>("prune_fights", {
      keepLastN: opts.keepLastN ?? null,
      beforeTs: opts.beforeTs ?? null,
    })) ?? 0
  );
}

/** Export one stored fight's full summary as pretty JSON. */
export async function exportFight(id: number): Promise<string> {
  if (IS_MOCK) return JSON.stringify({ id, mock: true }, null, 2);
  return await invoke<string>("export_fight", { id });
}

/** Write a versioned snapshot of the current play session. Stored fights are
 * selected by the backend so the export retains their full summaries. */
export async function exportSession(args: {
  path: string;
  character: string;
  startTs: number;
  endTs: number;
  details: Record<string, unknown>;
}): Promise<void> {
  if (IS_MOCK) return;
  await invoke("export_session", args);
}

/** Offline log import (P26): replay a past log file and return its fights,
 *  read-only. Ids are positional — these are not stored. */
export async function analyzeLog(path: string): Promise<FightRecord[]> {
  if (IS_MOCK) return [];
  const raw = await invoke<unknown>("analyze_log", { path });
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeFight).filter((f): f is FightRecord => f !== null);
}

/** Native file picker for a log to import; null if cancelled. */
export async function pickLogFile(): Promise<string | null> {
  if (IS_MOCK) return null;
  const sel = await dialogOpen({
    multiple: false,
    directory: false,
    filters: [{ name: "EverQuest log", extensions: ["txt", "log"] }],
  });
  return typeof sel === "string" ? sel : null;
}

export async function pickInventoryFile(): Promise<string | null> {
  if (IS_MOCK) return null;
  const selected = await dialogOpen({
    multiple: false,
    directory: false,
    filters: [{ name: "EverQuest inventory export", extensions: ["txt"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export function inventoryDiscover(args: {
  logPath: string;
  character: string;
  server: string;
}): Promise<InventorySnapshot | null> {
  if (IS_MOCK) return Promise.resolve(null);
  return invoke<InventorySnapshot | null>("inventory_discover", args);
}

export function inventoryImport(path: string): Promise<InventorySnapshot> {
  if (IS_MOCK) return Promise.reject(new Error("Inventory import needs the desktop app."));
  return invoke<InventorySnapshot>("inventory_import", { path });
}

/**
 * Paste-parse text for a fight. Persisted fights ask the backend
 * (paste_parse command); the live fight — and any fallback — formats
 * locally with the same "You: 2761 (38.3 DPS) | …" layout.
 */
export async function pasteParse(
  fightId: number | null,
  fallback: ParseInput,
): Promise<string> {
  if (!IS_MOCK && fightId !== null) {
    try {
      // Backend returns chat-safe 240-char chunks (Vec<String>); join them
      // the same way formatParse does so the clipboard text is identical
      // in shape either way.
      const chunks = await invoke<unknown>("paste_parse", { id: fightId });
      if (Array.isArray(chunks)) {
        const text = chunks
          .filter((c): c is string => typeof c === "string")
          .join("\n");
        if (text.length > 0) return text;
      }
    } catch {
      // command not available yet — format locally below
    }
  }
  return formatParse(fallback);
}

// ---- first-run log discovery (NOW-sprint item 4) ----

/** Character-name guess from an eqlog_<Character>_<server>.txt path. */
function parseLogFilename(path: string): { character: string; server: string } {
  const file = path.split(/[\\/]/).pop() ?? "";
  const m = /^eqlog_([^_]+)_(.+)\.txt$/i.exec(file);
  return { character: m?.[1] ?? "", server: m?.[2] ?? "" };
}

/** Logs found in the game's default Logs folder, most recent first. */
export async function discoverLogs(): Promise<DiscoveredLog[]> {
  if (IS_MOCK) return mockDiscoverLogs();
  let raw: unknown;
  try {
    raw = await invoke<unknown>("discover_logs");
  } catch {
    return []; // command not available yet — welcome card degrades gracefully
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => {
      const path = String(e.path ?? "");
      const parsed = parseLogFilename(path);
      const modified = e.modifiedTs ?? e.modified_ts ?? e.modified ?? null;
      return {
        path,
        character: String(e.character ?? "") || parsed.character,
        server: String(e.server ?? "") || parsed.server,
        modifiedTs: typeof modified === "number" ? modified : null,
      };
    })
    .filter((e) => e.path.length > 0);
}

// ---- sharing v1 (NOW-sprint item 8) ----

/**
 * Export triggers to an LCS1 share string. The backend command gets the
 * selected trigger ids; when it is unavailable (mock mode, older backend)
 * the string is built locally from `fallbackTriggers` — same wire format.
 */
export async function shareExport(
  name: string | null,
  ids: string[],
  fallbackTriggers: Trigger[],
): Promise<string> {
  if (!IS_MOCK) {
    try {
      const s = await invoke<string>("share_export", { name, ids });
      if (typeof s === "string" && s.length > 0) return s;
    } catch {
      // fall through to the local builder
    }
  }
  return buildShareString({ name, triggers: fallbackTriggers });
}

/** Write a GINA-compatible .gtp package (desktop backend only). */
export function shareExportGtp(
  name: string,
  ids: string[],
  path: string,
): Promise<void> {
  if (IS_MOCK) {
    return Promise.reject(new Error("GINA export needs the desktop app."));
  }
  // Tauri arg key is camelCase for the command's `package_name` parameter.
  return invoke("share_export_gtp", { packageName: name, ids, path });
}

/** Write a lossless native Legends Companion trigger package. */
export function shareExportFile(
  name: string,
  ids: string[],
  path: string,
): Promise<number> {
  if (IS_MOCK) {
    return Promise.reject(
      new Error("Companion package export needs the desktop app."),
    );
  }
  return invoke<number>("share_export_file", { name, ids, path });
}

/** Read and validate a native trigger package for preview/import. */
export function shareReadFile(path: string): Promise<string> {
  if (IS_MOCK) {
    return Promise.reject(
      new Error("Companion package import needs the desktop app."),
    );
  }
  return invoke<string>("share_read_file", { path });
}

/** Import an LCS1 share string into the user pack. Default: dedupe id
 *  collisions with -2/-3 renames. With `updateInPlace`, incoming ids that
 *  match an existing Shared-source trigger replace it in place (same stable
 *  id, so per-id overrides keep applying). */
export async function shareImport(
  text: string,
  updateInPlace = false,
): Promise<ShareImportResult> {
  let result: ShareImportResult;
  if (IS_MOCK) {
    result = await mockShareImport(text, updateInPlace);
  } else {
    const raw = await invoke<unknown>("share_import", { text, updateInPlace });
    const o = (raw ?? {}) as {
      imported?: number;
      updated?: number;
      renamed?: [string, string][];
    };
    result = {
      imported: typeof o.imported === "number" ? o.imported : 0,
      updated: typeof o.updated === "number" ? o.updated : 0,
      renamed: Array.isArray(o.renamed) ? o.renamed : [],
    };
  }
  notifyTriggersChanged();
  return result;
}

export function overlayShow(label: string): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return invoke("overlay_show", { label });
}

export function overlayHide(label: string): Promise<void> {
  if (IS_MOCK) return Promise.resolve();
  return invoke("overlay_hide", { label });
}

export function overlaySetClickThrough(
  label: string,
  ignore: boolean,
): Promise<void> {
  if (IS_MOCK) {
    mockEmit("overlay-lock-changed", { label, clickThrough: ignore });
    return Promise.resolve();
  }
  return invoke("overlay_set_click_through", { label, ignore });
}

/** Enter/leave overlay arrange mode. Entering unlocks + reveals every overlay
 *  and latches a backend guard so a drag that shifts focus can't re-lock the
 *  others. Call with `false` BEFORE applying a normal lock/hide pass. */
export function overlaySetArranging(arranging: boolean): Promise<void> {
  if (IS_MOCK) {
    return Promise.resolve();
  }
  return invoke("overlay_set_arranging", { arranging });
}

// ---------------------------------------------------------------------------
// Drops research database (bundled classic-era reference data).
// ---------------------------------------------------------------------------

export function dropsSearchItems(args: {
  query: string;
  eraMax: number;
  onlySourced: boolean;
  slotMask: number;
  classMask: number;
  zone: string;
  effectType: string;
  effectName: string;
  sort: string;
  descending: boolean;
  limit: number;
  offset: number;
}): Promise<DropSearchResult> {
  if (IS_MOCK) return Promise.resolve({ total: 0, rows: [] });
  return invoke<DropSearchResult>("drops_search_items", args);
}

export function dropsEffects(eraMax: number): Promise<DropEffect[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<DropEffect[]>("drops_effects", { eraMax });
}

export function dropsZones(): Promise<DropZone[]> {
  // Mock mode gets a small classic-zone sample so the zone pickers
  // (trigger zone scopes, Timers tab) are exercisable in the browser.
  if (IS_MOCK) return Promise.resolve(MOCK_ZONES);
  return invoke<DropZone[]>("drops_zones");
}

export function dropsItemSources(
  itemId: number,
  eraMax: number,
): Promise<DropSource[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<DropSource[]>("drops_item_sources", { itemId, eraMax });
}

export function dropsQuestItemReferences(
  names: string[],
  eraMax: number,
): Promise<QuestItemReference[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<QuestItemReference[]>("drops_quest_item_references", { names, eraMax });
}

// ---------------------------------------------------------------------------
// Spell/ability reference database (same bundled sqlite as drops).
// ---------------------------------------------------------------------------

export function spellsSearch(args: {
  query: string;
  isAbility: boolean;
  /** Comma-wrapped full class names (",Cleric,Wizard,"); "" = any. */
  classes: string;
  /** 0 = any; caps the castable level within the class selection. */
  maxLevel: number;
  sort: string;
  descending: boolean;
  limit: number;
  offset: number;
}): Promise<SpellSearchResult> {
  if (IS_MOCK) return Promise.resolve({ total: 0, rows: [] });
  return invoke<SpellSearchResult>("spells_search", args);
}

export interface SpellIconMatch {
  name: string;
  iconId: number | null;
}

/** Resolve spell names to the icon ids in the player's installed client. */
export function spellIconsForNames(names: string[]): Promise<SpellIconMatch[]> {
  if (IS_MOCK) {
    const known: Record<string, number> = {
      "spirit of wolf": 10,
      root: 10,
      invisibility: 12,
      "arch lich": 374,
    };
    return Promise.resolve(names.map((name) => ({
      name,
      iconId: known[name.toLowerCase()] ?? null,
    })));
  }
  return invoke<SpellIconMatch[]>("spell_icons_for_names", { names });
}

/** Crop one installed EverQuest gem icon to a small PNG data URL. */
export function spellIconData(iconId: number): Promise<string> {
  if (IS_MOCK) return Promise.reject(new Error("Spell art is unavailable in browser mock mode."));
  return invoke<string>("spell_icon_data", { iconId });
}

/** Spells/abilities newly trainable at `level` for a class set (P8 ding
 *  digest). `classes` is comma-separated full class names. */
export async function unlocksAtLevel(
  classes: string,
  level: number,
): Promise<UnlockRow[]> {
  if (IS_MOCK) return [];
  const raw = await invoke<unknown>("unlocks_at_level", { classes, level });
  return Array.isArray(raw) ? (raw as UnlockRow[]) : [];
}

// ---------------------------------------------------------------------------
// Reference DB v2: mobs, vendors, recipes, zone info (same bundled sqlite).
// ---------------------------------------------------------------------------

/** Merchants selling an item within the era filter. */
export function refdbItemVendors(
  itemId: number,
  eraMax: number,
): Promise<ItemVendor[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<ItemVendor[]>("refdb_item_vendors", { itemId, eraMax });
}

/** Search NPCs by name/level/zone. 0 for minLevel/maxLevel = unbounded;
 *  "" zone = any. */
export function refdbMobSearch(args: {
  query: string;
  eraMax: number;
  minLevel: number;
  maxLevel: number;
  zone: string;
  limit: number;
  offset: number;
}): Promise<MobSearchResult> {
  if (IS_MOCK) return Promise.resolve({ total: 0, rows: [] });
  return invoke<MobSearchResult>("refdb_mob_search", args);
}

export function refdbMobDetail(npcId: number): Promise<MobDetail> {
  if (IS_MOCK) {
    return Promise.resolve({
      id: npcId,
      name: "",
      level: 0,
      named: 0,
      faction: null,
      zones: [],
      loot: [],
      sells: [],
    });
  }
  return invoke<MobDetail>("refdb_mob_detail", { npcId });
}

/** Scribeable scroll items that teach a spell, with sourcing hints. */
export function refdbSpellScrolls(
  spellId: number,
  eraMax: number,
  zone = "",
): Promise<SpellScroll[]> {
  if (IS_MOCK) return Promise.resolve([]);
  return invoke<SpellScroll[]>("refdb_spell_scrolls", { spellId, eraMax, zone });
}

/** Recipes that consume (usedIn) or produce (makes) an item. */
export function refdbItemRecipes(itemId: number): Promise<ItemRecipes> {
  if (IS_MOCK) return Promise.resolve({ usedIn: [], makes: [] });
  return invoke<ItemRecipes>("refdb_item_recipes", { itemId });
}

export function refdbRecipeDetail(
  recipeId: number,
  eraMax: number,
  zone = "",
): Promise<RecipeDetail> {
  if (IS_MOCK) {
    return Promise.resolve({
      id: recipeId,
      name: "",
      tradeskill: 0,
      trivial: 0,
      noFail: 0,
      components: [],
      results: [],
    });
  }
  return invoke<RecipeDetail>("refdb_recipe_detail", { recipeId, eraMax, zone });
}

/** Search recipes by name. tradeskill 0 = any; maxTrivial 0 = any. */
export function refdbRecipeSearch(args: {
  query: string;
  tradeskill: number;
  maxTrivial: number;
  limit: number;
  offset: number;
}): Promise<RecipeSearchResult> {
  if (IS_MOCK) return Promise.resolve({ total: 0, rows: [] });
  return invoke<RecipeSearchResult>("refdb_recipe_search", args);
}

/** Zone almanac: connections, forage/fishing tables, named mobs. */
export function refdbZoneInfo(shortName: string): Promise<ZoneInfo> {
  if (IS_MOCK) {
    return Promise.resolve({
      shortName,
      longName: shortName,
      era: 0,
      connections: [],
      forage: [],
      fishing: [],
      namedMobs: [
        { id: 1, name: "a ghoul sentinel", level: 42, respawnSecs: 1680 },
        { id: 2, name: "a ghoul knight commander", level: 45, respawnSecs: 1680 },
        { id: 3, name: "Frenzied Ghoul", level: 40, respawnSecs: 1320 },
        { id: 4, name: "Ghoul Lord Maltavis", level: 48, respawnSecs: 21600 },
      ],
    });
  }
  return invoke<ZoneInfo>("refdb_zone_info", { shortName });
}

// ---------------------------------------------------------------------------
// Career database + log-history backfill (docs/career-db-design.md §6).
// All queries are implicitly scoped to the active character/server from
// AppConfig — the backend reads its own config, the frontend never passes
// names. All `ts` fields are log-domain epoch seconds (lib/career helpers).
// ---------------------------------------------------------------------------

// Career-data change notifications so career views (Session-tab panels,
// CoachTab pill counts) refresh after a same-window import or reset without
// polling. Cross-window import completion additionally arrives via the
// backend's "career-import-progress" done event.
type CareerListener = () => void;
const careerListeners = new Set<CareerListener>();

/** Subscribe to career-data changes; returns an unsubscribe function. */
export function onCareerChanged(cb: CareerListener): () => void {
  careerListeners.add(cb);
  return () => {
    careerListeners.delete(cb);
  };
}

function notifyCareerChanged(): void {
  for (const cb of [...careerListeners]) cb();
}

/** Import log history into the career DB. Empty/omitted paths = the active
 *  configured log file. Emits "career-import-progress" events while running;
 *  resolves with one report per file. Rejects only on DB-open failure (or
 *  when an import is already running). */
export async function careerImport(paths?: string[]): Promise<CareerImportReport[]> {
  const reports = IS_MOCK
    ? await mockCareerImport(paths ?? [])
    : await invoke<CareerImportReport[]>("career_import", { paths: paths ?? [] });
  notifyCareerChanged();
  return reports;
}

/** Career summary for the active character; null = no career data yet. */
export async function careerSummary(): Promise<CareerSummary | null> {
  if (IS_MOCK) return Promise.resolve(mockCareerSummary());
  return invoke<CareerSummary | null>("career_summary").catch(() => null);
}

/** Paged career sessions, newest first. */
export async function careerSessions(
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerSession[] }> {
  if (IS_MOCK) return Promise.resolve(mockCareerSessions(limit, offset));
  return invoke("career_sessions", { limit, offset });
}

/** Every level-up, ascending ts (level timeline chart). */
export async function careerLevelTimeline(): Promise<CareerLevelUp[]> {
  if (IS_MOCK) return Promise.resolve(mockCareerLevelTimeline());
  return invoke<CareerLevelUp[]>("career_level_timeline").catch(() => []);
}

/** Paged loot ledger; search filters item substring, "" = all. */
export async function careerLoot(
  search: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerLootRow[] }> {
  if (IS_MOCK) return Promise.resolve(mockCareerLoot(search, limit, offset));
  return invoke("career_loot", { search, limit, offset });
}

/** Paged per-mob kill counts + observed drop counts; search "" = all. */
export async function careerMobKills(
  search: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerMobKills[] }> {
  if (IS_MOCK) return Promise.resolve(mockCareerMobKills(search, limit, offset));
  return invoke("career_mob_kills", { search, limit, offset });
}

/** Observed drops off one mob, most-seen first. */
export async function careerMobDrops(mob: string): Promise<CareerMobDrop[]> {
  if (IS_MOCK) return Promise.resolve(mockCareerMobDrops(mob));
  return invoke<CareerMobDrop[]>("career_mob_drops", { mob }).catch(() => []);
}

/** Delete all career data + import watermarks for the active character.
 *  Destructive; caller confirms first (confirmDiscard pattern). */
export async function careerReset(): Promise<void> {
  if (IS_MOCK) mockCareerReset();
  else await invoke("career_reset");
  notifyCareerChanged();
}
