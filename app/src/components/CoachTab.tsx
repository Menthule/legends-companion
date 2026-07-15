import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  careerSummary,
  discoverLogs,
  exportSession,
  getConfig,
  getProfile,
  onCareerChanged,
} from "../api";
import {
  fmtDuration,
  fmtNum,
  useCopyFeedback,
  useNowMs,
  useTauriEvent,
} from "../hooks";
import type {
  AppConfig,
  CareerImportProgress,
  CatchUpPayload,
  CharacterProfile,
  DiscoveredLog,
  EqEvent,
  FightUpdatePayload,
  LogLinePayload,
  MeterSourceRow,
  EffectObservedPayload,
} from "../types";
import { petRowsForCharacter, summedRowsTotal } from "../lib/sessionInsights";
import {
  loadPaceState,
  lootMetricMatches,
  paceSnapshot,
  PACE_STATE_EVENT,
  savePaceState,
  type PaceState,
} from "../lib/pace";
import {
  compareSessions,
  type ComparisonGoal,
  type SessionComparisonSample,
  type SessionRouteSample,
} from "../lib/sessionComparison";
import { createLocalStore } from "../lib/localStore";
import {
  RECAP_CAP,
  SESSION_CAP,
  sessionBounds,
  sessionScoreboard,
  useSessionLog,
} from "../lib/sessionLog";
import type { TrendSessionInput } from "../lib/trends";
import { totalCopper, walletGainFromEvent } from "../lib/wallet";
import {
  loadWatchedKills,
  loadWishlist,
  onWishlistChanged,
  type KillWatchEntry,
  type WishlistEntry,
} from "../lib/wishlist";
import Empty from "./Empty";
import SessionPanel, {
  SESSION_PANELS,
  type SessionPanelId,
} from "./SessionPanels";
import { useToast } from "./Toast";

const COACH_KEY = "eqlogs.coach.v1";
const COACH_EVENT = "eqlogs-coach-changed";
const NPC_KEY = "eqlogs.npcMemory.v1";
const NPC_EVENT = "eqlogs-npc-memory-changed";
const NPC_CAP = 120;
const SESSION_HISTORY_CAP = 40;
const DIFFICULTIES = ["Unknown", "D1", "D2", "D3", "D4", "D5", "Custom"];

interface EffectAgg {
  key: string;
  kind: EffectObservedPayload["kind"];
  name: string;
  total: number;
  hits: number;
}

interface PetAgg {
  key: string;
  name: string;
  total: number;
  hits: number;
}

interface NpcMemory {
  name: string;
  lastTs: number;
  lines: string[];
}

interface EfficiencyBucket {
  key: string;
  zone: string;
  difficulty: string;
  xp: number;
  kills: number;
  deaths: number;
  damage: number;
  seconds: number;
}

interface SessionHistoryRow {
  id: string;
  startedTs: number;
  endedTs: number;
  durationSecs: number;
  endReason: string;
  xp: number;
  kills: number;
  deaths: number;
  petDamage: number;
  zones: string[];
  topMob: string;
  topMobKills: number;
  buckets: EfficiencyBucket[];
  damageSources: MeterSourceRow[];
  effects: EffectAgg[];
  /** Additive v2 comparison snapshot. Missing fields on legacy rows stay unknown. */
  schemaVersion?: 2;
  character?: string;
  server?: string;
  loadout?: string;
  classes?: string[];
  difficulty?: string;
  fightCount?: number;
  combatSecs?: number;
  playerDamage?: number;
  damageTaken?: number;
  healing?: number;
  aaPoints?: number;
  aaPercent?: number | null;
  motes?: number;
  routes?: SessionRouteSample[];
  /** Session coin income in copper (Money lines + auto-sold loot). Absent on
   *  rows persisted before coin tracking — the Trends panel shows a gap. */
  platCopper?: number;
  /** Level-ups seen during the session (Trends chart markers). */
  levelUps?: number;
}

interface CoachStore {
  difficulty: string;
  smartSession: boolean;
  idleMinutes: number;
  buckets: EfficiencyBucket[];
  history: SessionHistoryRow[];
  baselineSessionId?: string;
  comparisonGoal?: ComparisonGoal;
}

interface RouteSegment {
  id: string;
  label: string;
  zone: string;
  difficulty: string;
  startedAtMs: number;
  endedAtMs: number;
  xp: number;
  aaPoints: number;
  motes: number;
  kills: number;
  deaths: number;
  damage: number;
}

function storeKey(character: string, loadout: string): string {
  const c = character.trim().toLowerCase() || "unknown";
  const l = loadout.trim().toLowerCase() || "default";
  return `${COACH_KEY}:${c}:${l}`;
}

function decodeCoachStore(raw: unknown): CoachStore {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<CoachStore>;
  return {
    difficulty: parsed.difficulty || "Unknown",
    smartSession: parsed.smartSession === true,
    idleMinutes:
      typeof parsed.idleMinutes === "number" && parsed.idleMinutes >= 5
        ? parsed.idleMinutes
        : 15,
    buckets: Array.isArray(parsed.buckets) ? parsed.buckets.slice(0, 80) : [],
    history: Array.isArray(parsed.history) ? parsed.history.slice(0, SESSION_HISTORY_CAP) : [],
    baselineSessionId:
      typeof parsed.baselineSessionId === "string" ? parsed.baselineSessionId : "auto",
    comparisonGoal:
      parsed.comparisonGoal === "aa" ||
      parsed.comparisonGoal === "motes" ||
      parsed.comparisonGoal === "damage"
        ? parsed.comparisonGoal
        : "xp",
  };
}

// Best-effort insights cache, per character:loadout key (shared localStore
// scaffold — cross-window "storage" sync included).
function coachStore(key = COACH_KEY) {
  return createLocalStore<CoachStore>(key, COACH_EVENT, decodeCoachStore);
}

function loadStore(key = COACH_KEY): CoachStore {
  return coachStore(key).load();
}

function saveStore(store: CoachStore, key = COACH_KEY): void {
  coachStore(key).save(store);
}

// Best-effort NPC cache.
const npcStore = createLocalStore<NpcMemory[]>(NPC_KEY, NPC_EVENT, (raw) =>
  Array.isArray(raw) ? (raw.slice(0, NPC_CAP) as NpcMemory[]) : [],
);

function loadNpcMemory(): NpcMemory[] {
  return npcStore.load();
}

function saveNpcMemory(rows: NpcMemory[]): void {
  npcStore.save(rows.slice(0, NPC_CAP));
}

function eventData(event: EqEvent, key: string): Record<string, unknown> | null {
  if (typeof event !== "object" || event === null || !(key in event)) return null;
  const data = event[key];
  return typeof data === "object" && data !== null ? data : null;
}

function entityName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "Named" in value) {
    return String((value as { Named: unknown }).Named);
  }
  return "";
}

function pct(total: number, value: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function bucketKey(zone: string, difficulty: string): string {
  return `${zone || "Unknown zone"}::${difficulty || "Unknown"}`;
}

function addBucketRows(
  rows: EfficiencyBucket[],
  patch: Partial<EfficiencyBucket> & Pick<EfficiencyBucket, "zone" | "difficulty">,
): EfficiencyBucket[] {
  const key = bucketKey(patch.zone, patch.difficulty);
  const buckets = [...rows];
  const i = buckets.findIndex((b) => b.key === key);
  const current =
    i >= 0
      ? buckets[i]
      : {
          key,
          zone: patch.zone || "Unknown zone",
          difficulty: patch.difficulty || "Unknown",
          xp: 0,
          kills: 0,
          deaths: 0,
          damage: 0,
          seconds: 0,
        };
  const next = {
    ...current,
    xp: current.xp + (patch.xp ?? 0),
    kills: current.kills + (patch.kills ?? 0),
    deaths: current.deaths + (patch.deaths ?? 0),
    damage: current.damage + (patch.damage ?? 0),
    seconds: current.seconds + (patch.seconds ?? 0),
  };
  if (i >= 0) buckets[i] = next;
  else buckets.unshift(next);
  return buckets;
}

function npcFromLine(p: LogLinePayload): { name: string; line: string } | null {
  const chat = eventData(p.event, "Chat");
  if (chat) {
    const speaker = entityName(chat.speaker);
    const text = typeof chat.text === "string" ? chat.text : "";
    if (speaker && speaker !== "You" && text) return { name: speaker, line: text };
  }
  const told = /^(.+?) told you, '(.+)'$/.exec(p.message);
  if (told) return { name: told[1], line: told[2] };
  return null;
}

function zoneFromEvent(event: EqEvent): string | null {
  const z = eventData(event, "ZoneEnter");
  const name = z?.zone;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function xpFromEvent(event: EqEvent): number {
  const xp = eventData(event, "XpGain");
  return typeof xp?.percent === "number" ? xp.percent : 0;
}

function aaPointsFromEvent(event: EqEvent): number {
  const aa = eventData(event, "AaPointGain");
  return typeof aa?.points === "number" && aa.points > 0 ? Math.floor(aa.points) : 0;
}

function motesFromEvent(event: EqEvent, pace: PaceState): number {
  const loot = eventData(event, "Loot");
  if (!loot) return 0;
  const item = typeof loot.item === "string" ? loot.item : "";
  const looter = entityName(loot.looter);
  const quantity = typeof loot.quantity === "number" ? Math.max(1, loot.quantity) : 1;
  const metric = pace.lootMetrics.find((row) => row.id === "motes" && row.enabled);
  return metric && lootMetricMatches(metric, item, looter) ? Math.floor(quantity) : 0;
}

function difficultyFromLine(message: string): string | null {
  const text = message.trim();
  const explicit = /\b(?:difficulty|instance|tier)\D{0,16}(D?[1-5])\b/i.exec(text);
  const bracket = /\[(D[1-5])\]|\((D[1-5])\)/i.exec(text);
  const raw = explicit?.[1] ?? bracket?.[1] ?? bracket?.[2] ?? "";
  if (!raw) return null;
  const normalized = raw.toUpperCase().startsWith("D") ? raw.toUpperCase() : `D${raw}`;
  return DIFFICULTIES.includes(normalized) ? normalized : null;
}

function slainVictim(event: EqEvent): string | null {
  const s = eventData(event, "Slain");
  if (!s) return null;
  return entityName(s.victim) || null;
}

function sourceSkills(sources: MeterSourceRow[]): SessionComparisonSample["skills"] {
  return sources.map((source) => ({
    name: source.name,
    damage: source.total,
    // Casts are the best denominator for spells. Melee and damage shields do
    // not have casts, so their landed tick count is the useful fallback.
    uses: source.casts || source.hits || 0,
  }));
}

function mergeMeterSources(...groups: MeterSourceRow[][]): MeterSourceRow[] {
  const merged = new Map<string, MeterSourceRow>();
  for (const sources of groups) {
    for (const source of sources) {
      const key = source.name.toLowerCase();
      const previous = merged.get(key);
      merged.set(key, {
        name: previous?.name ?? source.name,
        total: (previous?.total ?? 0) + source.total,
        hits: (previous?.hits ?? 0) + (source.hits ?? 0),
        crits: (previous?.crits ?? 0) + (source.crits ?? 0),
        maxHit: Math.max(previous?.maxHit ?? 0, source.maxHit ?? 0),
        misses: (previous?.misses ?? 0) + (source.misses ?? 0),
        casts: (previous?.casts ?? 0) + (source.casts ?? 0),
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.total - a.total);
}

function historySample(row: SessionHistoryRow): SessionComparisonSample {
  const legacyCombatSecs = (row.buckets ?? []).reduce((sum, bucket) => sum + bucket.seconds, 0);
  return {
    id: row.id,
    label: new Date(row.startedTs).toLocaleString(),
    durationSecs: row.durationSecs,
    combatSecs: row.combatSecs ?? (legacyCombatSecs > 0 ? legacyCombatSecs : null),
    activeSecs: row.combatSecs ?? (legacyCombatSecs > 0 ? legacyCombatSecs : null),
    observations: row.fightCount ?? row.kills,
    fights: row.fightCount ?? null,
    kills: row.kills,
    deaths: row.deaths,
    xp: row.xp,
    aaPoints: row.aaPoints ?? null,
    aaPercent: row.aaPercent ?? null,
    motes: row.motes ?? null,
    damage: row.playerDamage ?? null,
    damageTaken: row.damageTaken ?? null,
    skills: sourceSkills(row.damageSources ?? []),
    routes: row.routes,
  };
}

type BoardMetricId = "duration" | "xp" | "aa" | "motes" | "dps" | "damage" | "kills" | "deaths" | "downtime";

interface BoardMetric {
  id: BoardMetricId;
  label: string;
  higherIsBetter: boolean;
}

const BOARD_METRICS: BoardMetric[] = [
  { id: "duration", label: "Time", higherIsBetter: true },
  { id: "xp", label: "XP / hour", higherIsBetter: true },
  { id: "aa", label: "AA / hour", higherIsBetter: true },
  { id: "motes", label: "Motes / hour", higherIsBetter: true },
  { id: "dps", label: "DPS", higherIsBetter: true },
  { id: "damage", label: "Damage", higherIsBetter: true },
  { id: "kills", label: "Kills / hour", higherIsBetter: true },
  { id: "deaths", label: "Deaths / hour", higherIsBetter: false },
  { id: "downtime", label: "Downtime", higherIsBetter: false },
];

function perHourValue(value: number | null | undefined, durationSecs: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && durationSecs > 0
    ? (value / durationSecs) * 3600
    : null;
}

function boardMetricValue(sample: SessionComparisonSample | null, id: BoardMetricId, aaPointsMode: boolean): number | null {
  if (!sample) return null;
  if (id === "duration") return sample.durationSecs > 0 ? sample.durationSecs : null;
  if (id === "xp") return perHourValue(sample.xp, sample.durationSecs);
  if (id === "aa") return perHourValue(aaPointsMode ? sample.aaPoints : sample.aaPercent, sample.durationSecs);
  if (id === "motes") return perHourValue(sample.motes, sample.durationSecs);
  if (id === "dps") {
    if (sample.damage == null) return null;
    return sample.damage / Math.max(1, sample.combatSecs || sample.durationSecs);
  }
  if (id === "damage") return sample.damage ?? null;
  if (id === "kills") return perHourValue(sample.kills, sample.durationSecs);
  if (id === "deaths") return perHourValue(sample.deaths, sample.durationSecs);
  if (sample.activeSecs == null || sample.durationSecs <= 0) return null;
  return Math.max(0, Math.min(100, (1 - sample.activeSecs / sample.durationSecs) * 100));
}

function formatBoardValue(id: BoardMetricId, value: number | null, aaPointsMode: boolean): string {
  if (value === null) return "—";
  if (id === "duration") return fmtDuration(Math.round(value));
  if (id === "xp") return `${value.toFixed(2)}%`;
  if (id === "aa") return aaPointsMode ? `${value.toFixed(1)} pts` : `${value.toFixed(1)}%`;
  if (id === "motes" || id === "kills" || id === "deaths") return value.toFixed(value >= 100 ? 0 : 1);
  if (id === "downtime") return `${value.toFixed(1)}%`;
  return fmtNum(Math.round(value));
}

function boardDelta(current: number | null, baseline: number | null, higherIsBetter: boolean): { text: string; direction: "improved" | "declined" | "unchanged" } | null {
  if (current === null || baseline === null) return null;
  const delta = current - baseline;
  const tolerance = Math.max(0.001, Math.abs(baseline) * 0.001);
  if (Math.abs(delta) <= tolerance) return { text: "Same", direction: "unchanged" };
  const direction = (delta > 0) === higherIsBetter ? "improved" : "declined";
  if (baseline === 0) return { text: delta > 0 ? "Higher" : "Lower", direction };
  return {
    text: `${delta > 0 ? "+" : ""}${Math.round((delta / Math.abs(baseline)) * 100)}%`,
    direction,
  };
}

/** Session-tab sections: the Overview + insight views CoachTab always had,
 *  plus the session-data panels absorbed from FightsTab's session card. */
type CoachSection =
  | "session"
  | SessionPanelId
  | "damage"
  | "pets"
  | "efficiency"
  | "npcs";

/** Sections that show the scoped (fight/session/past) insight views. */
const INSIGHT_SECTIONS: readonly CoachSection[] = [
  "session",
  "damage",
  "pets",
  "efficiency",
  "npcs",
];

const SESSION_PANEL_IDS: readonly string[] = SESSION_PANELS.map((p) => p.id);

export default function CoachTab({ character }: { character: string }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [logs, setLogs] = useState<DiscoveredLog[]>([]);
  const [store, setStore] = useState<CoachStore>(() => loadStore());
  const [section, setSection] = useState<CoachSection>("session");
  const [viewScope, setViewScope] = useState<"fight" | "session" | "past">("session");
  const [pace, setPace] = useState<PaceState>(() => loadPaceState());
  const [effects, setEffects] = useState<Map<string, EffectAgg>>(() => new Map());
  const [petAggs, setPetAggs] = useState<Map<string, PetAgg>>(() => new Map());
  const [sessionBuckets, setSessionBuckets] = useState<EfficiencyBucket[]>([]);
  const [npcMemory, setNpcMemory] = useState<NpcMemory[]>(() => loadNpcMemory());
  const [currentZone, setCurrentZone] = useState("Unknown zone");
  const [fight, setFight] = useState<FightUpdatePayload | null>(null);
  const [sessionStart, setSessionStart] = useState(Date.now());
  const [recapCopied, copyRecapText] = useCopyFeedback<boolean>(2000);
  const now = useNowMs(1000);
  // Session-data panels (Rates/XP/Kills/…): accumulated app-run data from
  // lib/sessionLog — this tab is just a view over it.
  const sessionLog = useSessionLog();
  const [wishlist, setWishlist] = useState<WishlistEntry[]>(() => loadWishlist());
  const [watchedKills, setWatchedKills] = useState<KillWatchEntry[]>(() => loadWatchedKills());
  useEffect(() => onWishlistChanged(() => {
    setWishlist(loadWishlist());
    setWatchedKills(loadWatchedKills());
  }), []);
  const [exportingSession, setExportingSession] = useState(false);
  const [toastNode, showToast] = useToast();
  const [xpSession, setXpSession] = useState(0);
  const [kills, setKills] = useState(0);
  const [killCounts, setKillCounts] = useState<Map<string, number>>(() => new Map());
  const [deaths, setDeaths] = useState(0);
  const [aaPoints, setAaPoints] = useState(0);
  const [motes, setMotes] = useState(0);
  const [coinCopper, setCoinCopper] = useState(0);
  const [levelUpCount, setLevelUpCount] = useState(0);
  const [fightCount, setFightCount] = useState(0);
  const [combatSecs, setCombatSecs] = useState(0);
  const [playerDamageTotal, setPlayerDamageTotal] = useState(0);
  const [damageTakenTotal, setDamageTakenTotal] = useState(0);
  const [healingTotal, setHealingTotal] = useState(0);
  const [sourceAggs, setSourceAggs] = useState<Map<string, MeterSourceRow>>(() => new Map());
  const [routeSegments, setRouteSegments] = useState<RouteSegment[]>([]);
  const [sessionReason, setSessionReason] = useState("Manual session");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [currentPetName, setCurrentPetName] = useState("");
  const currentZoneRef = useRef(currentZone);
  const difficultyRef = useRef(store.difficulty);
  const completedFightRef = useRef("");
  const lastActivityMsRef = useRef(Date.now());
  const loadedStoreKeyRef = useRef("");
  const skipStoreSaveKeyRef = useRef("");

  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
    getProfile().then(setProfile).catch(() => setProfile(null));
    discoverLogs().then(setLogs).catch(() => setLogs([]));
  }, []);

  // Career tab-pill counts (sessions / loot events in the career DB): read
  // once on mount and again when an import finishes or the data is reset —
  // never polled.
  const [careerCounts, setCareerCounts] = useState({ sessions: 0, loot: 0 });
  const refreshCareerCounts = () => {
    careerSummary().then((s) =>
      setCareerCounts({ sessions: s?.sessions ?? 0, loot: s?.lootCount ?? 0 }),
    );
  };
  useEffect(refreshCareerCounts, []);
  useEffect(() => onCareerChanged(refreshCareerCounts), []);
  useTauriEvent<CareerImportProgress>("career-import-progress", (p) => {
    if (p.done && !p.error) refreshCareerCounts();
  });

  useEffect(() => {
    const reload = () => setPace(loadPaceState());
    window.addEventListener(PACE_STATE_EVENT, reload);
    return () => window.removeEventListener(PACE_STATE_EVENT, reload);
  }, []);

  const updatePace = (next: PaceState) => {
    savePaceState(next);
    setPace(next);
  };

  const activeLoadout = profile?.loadouts.find((l) => l.name === profile.active_loadout);
  const scopedKey = storeKey(profile?.character || character, activeLoadout?.name || profile?.active_loadout || "Default");

  useEffect(() => {
    if (loadedStoreKeyRef.current && loadedStoreKeyRef.current !== scopedKey) {
      clearTransientSession("Current session");
    }
    skipStoreSaveKeyRef.current = scopedKey;
    loadedStoreKeyRef.current = scopedKey;
    setStore(loadStore(scopedKey));
  }, [scopedKey]);

  useEffect(() => {
    if (loadedStoreKeyRef.current !== scopedKey) return;
    if (skipStoreSaveKeyRef.current === scopedKey) {
      skipStoreSaveKeyRef.current = "";
      return;
    }
    saveStore(store, scopedKey);
  }, [store, scopedKey]);

  // Cross-window sync: another window edited this character/loadout's store
  // (remote only — this window's own writes already hold the state).
  useEffect(() => {
    return coachStore(scopedKey).subscribe((remote) => {
      if (!remote) return;
      skipStoreSaveKeyRef.current = scopedKey;
      setStore(loadStore(scopedKey));
    });
  }, [scopedKey]);

  useEffect(() => {
    saveNpcMemory(npcMemory);
  }, [npcMemory]);

  useEffect(() => {
    return npcStore.subscribe((remote) => {
      if (remote) setNpcMemory(loadNpcMemory());
    });
  }, []);

  useEffect(() => {
    currentZoneRef.current = currentZone;
  }, [currentZone]);

  useEffect(() => {
    difficultyRef.current = store.difficulty;
  }, [store.difficulty]);

  const recordRoute = (
    atMs: number,
    zone: string,
    difficulty: string,
    patch: Partial<Pick<RouteSegment, "xp" | "aaPoints" | "motes" | "kills" | "deaths" | "damage">> = {},
  ) => {
    setRouteSegments((previous) => {
      const last = previous[previous.length - 1];
      const same = last?.zone === zone && last.difficulty === difficulty;
      const base: RouteSegment = same
        ? last
        : {
            id: `${atMs}:${zone}:${difficulty}`,
            label: `${zone}${difficulty !== "Unknown" ? ` · ${difficulty}` : ""}`,
            zone,
            difficulty,
            startedAtMs: atMs,
            endedAtMs: atMs,
            xp: 0,
            aaPoints: 0,
            motes: 0,
            kills: 0,
            deaths: 0,
            damage: 0,
          };
      const next = {
        ...base,
        endedAtMs: Math.max(base.endedAtMs, atMs),
        xp: base.xp + (patch.xp ?? 0),
        aaPoints: base.aaPoints + (patch.aaPoints ?? 0),
        motes: base.motes + (patch.motes ?? 0),
        kills: base.kills + (patch.kills ?? 0),
        deaths: base.deaths + (patch.deaths ?? 0),
        damage: base.damage + (patch.damage ?? 0),
      };
      return same ? [...previous.slice(0, -1), next] : [...previous, next].slice(-40);
    });
  };

  function sessionHasData(): boolean {
    return (
      xpSession > 0 ||
      kills > 0 ||
      deaths > 0 ||
      aaPoints > 0 ||
      motes > 0 ||
      coinCopper > 0 ||
      sessionBuckets.length > 0 ||
      effects.size > 0 ||
      petAggs.size > 0
    );
  }

  function makeSessionHistoryRow(endReason: string): SessionHistoryRow | null {
    if (!sessionHasData()) return null;
    const endedTs = Date.now();
    const mobRows = [...killCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const zones = [...new Set(sessionBuckets.map((b) => b.zone).filter(Boolean))];
    const petDamage = [...petAggs.values()]
      .filter((row) => !row.key.startsWith("source:"))
      .reduce((sum, row) => sum + row.total, 0);
    const damageSources = [...sourceAggs.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 16);
    const historyEffects = [...effects.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 16);
    const matchingPace = pace.active && pace.active.startedAtMs >= sessionStart
      ? pace.active
      : pace.history.find((sample) => sample.startedAtMs >= sessionStart) ?? null;
    const paceResult = matchingPace
      ? paceSnapshot(matchingPace, pace.lootMetrics, endedTs)
      : null;
    const routes: SessionRouteSample[] = routeSegments.map((route, index) => ({
      label: route.label || `Segment ${index + 1}`,
      durationSecs: Math.max(1, Math.round((route.endedAtMs - route.startedAtMs) / 1000)),
      xp: route.xp,
      aaPoints: route.aaPoints,
      motes: route.motes,
      damage: route.damage,
    }));
    return {
      id: `${sessionStart}:${endedTs}`,
      startedTs: sessionStart,
      endedTs,
      durationSecs: Math.max(1, Math.round((endedTs - sessionStart) / 1000)),
      endReason,
      xp: xpSession,
      kills,
      deaths,
      petDamage,
      zones: zones.length > 0 ? zones : [currentZoneRef.current],
      topMob: mobRows[0]?.name ?? "",
      topMobKills: mobRows[0]?.count ?? 0,
      buckets: sessionBuckets.slice(0, 12),
      damageSources,
      effects: historyEffects,
      schemaVersion: 2,
      character,
      server: currentLog?.server,
      loadout: activeLoadout?.name ?? profile?.active_loadout ?? "Default",
      classes: activeLoadout?.classes ?? [],
      difficulty: difficultyRef.current,
      fightCount,
      combatSecs,
      playerDamage: playerDamageTotal,
      damageTaken: damageTakenTotal,
      healing: healingTotal,
      aaPoints,
      aaPercent: paceResult?.aaPercentGained ?? null,
      motes,
      routes,
      platCopper: coinCopper,
      levelUps: levelUpCount,
    };
  }

  function archiveCurrentSession(endReason: string) {
    const row = makeSessionHistoryRow(endReason);
    if (!row) return;
    setStore((prev) => ({
      ...prev,
      history: [row, ...(prev.history ?? [])].slice(0, SESSION_HISTORY_CAP),
    }));
  }

  function clearTransientSession(reason: string) {
    setSessionStart(Date.now());
    setSessionReason(reason);
    setXpSession(0);
    setKills(0);
    setDeaths(0);
    setAaPoints(0);
    setMotes(0);
    setCoinCopper(0);
    setLevelUpCount(0);
    setFightCount(0);
    setCombatSecs(0);
    setPlayerDamageTotal(0);
    setDamageTakenTotal(0);
    setHealingTotal(0);
    setSourceAggs(new Map());
    setRouteSegments([]);
    setKillCounts(new Map());
    setSessionBuckets([]);
    setEffects(new Map());
    setPetAggs(new Map());
    setFight(null);
    completedFightRef.current = "";
    lastActivityMsRef.current = Date.now();
  }

  function resetSession(reason: string, endReason = reason) {
    archiveCurrentSession(endReason);
    clearTransientSession(reason);
  }

  function clearSession() {
    const hasData =
      sessionHasData();
    if (
      hasData &&
      !window.confirm("Start a new session? Fight history and NPC notes are not deleted.")
    ) {
      return;
    }
    resetSession("Manual session", "Started new session");
  }

  function clearSessionHistory() {
    if (
      store.history.length > 0 &&
      !window.confirm("Clear previous session summaries for this character/loadout?")
    ) {
      return;
    }
    setStore({ ...store, history: [] });
    setSelectedHistoryId("");
    setViewScope("session");
  }

  useTauriEvent<FightUpdatePayload>("fight-update", (p) => {
    setFight(p);
    if (p.active) {
      completedFightRef.current = "";
    }
    if (!p.active && p.durationSecs > 0 && p.totalDamage > 0) {
      const completedKey = `${p.target}:${p.durationSecs}:${p.totalDamage}`;
      if (completedFightRef.current === completedKey) return;
      completedFightRef.current = completedKey;
      const zone = currentZoneRef.current;
      const difficulty = difficultyRef.current;
      const player = p.rows.find(
        (row) => row.name.toLowerCase() === character.toLowerCase(),
      );
      const playerDamage = Math.max(0, (player?.total ?? 0) - (player?.petDamage ?? 0));
      setFightCount((value) => value + 1);
      setCombatSecs((value) => value + p.durationSecs);
      setPlayerDamageTotal((value) => value + playerDamage);
      setDamageTakenTotal((value) => value + (player?.damageTaken ?? 0));
      setHealingTotal((value) => value + (player?.healing ?? 0));
      setSourceAggs((previous) => {
        const next = new Map(previous);
        for (const source of player?.sources ?? []) {
          if (/\s+\(pet\)$/i.test(source.name)) continue;
          const key = source.name.toLowerCase();
          const old = next.get(key);
          next.set(key, {
            name: old?.name ?? source.name,
            total: (old?.total ?? 0) + source.total,
            hits: (old?.hits ?? 0) + (source.hits ?? 0),
            crits: (old?.crits ?? 0) + (source.crits ?? 0),
            maxHit: Math.max(old?.maxHit ?? 0, source.maxHit ?? 0),
            misses: (old?.misses ?? 0) + (source.misses ?? 0),
            casts: (old?.casts ?? 0) + (source.casts ?? 0),
          });
        }
        return next;
      });
      recordRoute(Date.now(), zone, difficulty, { damage: playerDamage });
      setSessionBuckets((rows) =>
        addBucketRows(rows, {
          zone,
          difficulty,
          damage: p.totalDamage,
          seconds: p.durationSecs,
        }),
      );
      const pets = petRowsForCharacter(p.rows, character);
      setPetAggs((prev) => {
        const next = new Map(prev);
        for (const pet of pets) {
          const old = next.get(pet.name) ?? {
            key: pet.name,
            name: pet.name,
            total: 0,
            hits: 0,
          };
          next.set(pet.name, {
            ...old,
            total: old.total + pet.total,
            hits: old.hits + 1,
          });
          for (const source of pet.sources ?? []) {
            const key = `source:${source.name}`;
            const prevSource = next.get(key) ?? {
              key,
              name: source.name,
              total: 0,
              hits: 0,
            };
            next.set(key, {
              ...prevSource,
              total: prevSource.total + source.total,
              hits: prevSource.hits + (source.hits ?? 0),
            });
          }
        }
        return next;
      });
    }
  });

  useTauriEvent<EffectObservedPayload>("effect-observed", (p) => {
    const key = `${p.kind}:${p.spell}`;
    setEffects((prev) => {
      const next = new Map(prev);
      const old = next.get(key) ?? {
        key,
        kind: p.kind,
        name: p.spell,
        total: 0,
        hits: 0,
      };
      next.set(key, {
        ...old,
        total: old.total + (p.amount ?? 0),
        hits: old.hits + 1,
      });
      return next;
    });
  });

  // Catch-up replay guard: replayed history must not be re-counted into the
  // live session (same pattern as FightsTab).
  const catchingUp = useRef(false);
  useTauriEvent<CatchUpPayload>("catch-up", (p) => {
    catchingUp.current = p.active;
  });

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    const now = Date.now();
    const idleMs = now - lastActivityMsRef.current;
    if (
      store.smartSession &&
      sessionHasData() &&
      idleMs >= store.idleMinutes * 60_000
    ) {
      resetSession(`Auto-reset: ${store.idleMinutes}+ min AFK`, `${store.idleMinutes}+ min AFK`);
    }
    lastActivityMsRef.current = now;
    const zone = zoneFromEvent(p.event);
    if (zone) {
      currentZoneRef.current = zone;
      setCurrentZone(zone);
    }
    const detectedDifficulty = difficultyFromLine(p.message);
    if (detectedDifficulty && detectedDifficulty !== difficultyRef.current) {
      difficultyRef.current = detectedDifficulty;
      setStore((prev) => ({ ...prev, difficulty: detectedDifficulty }));
    }
    const possessivePet = new RegExp(`^${character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\`s|'s)\\s+(.+?)\\s+(?:hits|slashes|pierces|claws|bites|kicks|bashes|punches|crushes|tries|begins|casts)\\b`, "i").exec(p.message);
    if (possessivePet?.[1]) {
      setCurrentPetName(possessivePet[1].trim());
    }
    // Session counters skip replayed lines (zone/difficulty/pet tracking
    // above still runs — replay legitimately advances "where am I now").
    if (!catchingUp.current) {
      const bucketZone = zone ?? currentZoneRef.current;
      const bucketDifficulty = difficultyRef.current;
      const xp = xpFromEvent(p.event);
      const gainedAa = aaPointsFromEvent(p.event);
      const gainedMotes = motesFromEvent(p.event, pace);
      if (xp > 0) {
        setXpSession((v) => v + xp);
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, xp }));
      }
      if (gainedAa > 0) setAaPoints((value) => value + gainedAa);
      if (gainedMotes > 0) setMotes((value) => value + gainedMotes);
      // Session coin (Money lines + auto-sold loot) and level-ups persist on
      // the history row for the Trends panel's plat/hr series and markers.
      const gain = walletGainFromEvent(p.event);
      if (gain) setCoinCopper((value) => value + totalCopper(gain.coins));
      if (eventData(p.event, "LevelUp")) setLevelUpCount((value) => value + 1);
      const victim = slainVictim(p.event);
      const killed = Boolean(victim && victim !== "You" && !/^[A-Z][a-z]+$/.test(victim));
      if (killed && victim) {
        setKills((v) => v + 1);
        setKillCounts((prev) => {
          const next = new Map(prev);
          next.set(victim, (next.get(victim) ?? 0) + 1);
          return next;
        });
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, kills: 1 }));
      }
      const died = p.message === "You died." || victim === "You";
      if (died) {
        setDeaths((v) => v + 1);
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, deaths: 1 }));
      }
      recordRoute(now, bucketZone, bucketDifficulty, {
        xp,
        aaPoints: gainedAa,
        motes: gainedMotes,
        kills: killed ? 1 : 0,
        deaths: died ? 1 : 0,
      });
    }
    const npc = npcFromLine(p);
    if (npc) {
      setNpcMemory((prev) => {
        const rest = prev.filter((row) => row.name.toLowerCase() !== npc.name.toLowerCase());
        return [
          {
            name: npc.name,
            lastTs: p.ts,
            lines: [npc.line, ...(prev.find((row) => row.name.toLowerCase() === npc.name.toLowerCase())?.lines ?? [])]
              .filter(Boolean)
              .slice(0, 8),
          },
          ...rest,
        ].slice(0, NPC_CAP);
      });
    }
  });

  const currentLog = logs.find((l) => l.path === config?.logPath) ?? null;
  const sessionHistory = store.history ?? [];
  const selectedHistory = viewScope === "past"
    ? sessionHistory.find((row) => row.id === selectedHistoryId) ?? sessionHistory[0] ?? null
    : null;
  const isViewingHistory = viewScope === "past" && selectedHistory !== null;
  const isViewingFight = viewScope === "fight";
  const petRows = fight ? petRowsForCharacter(fight.rows, character) : [];
  const petTotal = summedRowsTotal(petRows);
  const playerRow = fight?.rows.find((r) => r.name.toLowerCase() === character.toLowerCase());
  const playerDamage = Math.max(0, (playerRow?.total ?? 0) - (playerRow?.petDamage ?? 0));
  const playerSources = [...(playerRow?.sources ?? [])]
    .filter((s) => !/\s+\(pet\)$/i.test(s.name))
    .sort((a, b) => b.total - a.total);
  const sessionSources = [...sourceAggs.values()].sort((a, b) => b.total - a.total);
  const liveSessionSources = fight?.active ? mergeMeterSources(sessionSources, playerSources) : sessionSources;
  const visiblePlayerSources = selectedHistory?.damageSources ?? (isViewingFight ? playerSources : liveSessionSources);
  const visiblePlayerDamage = visiblePlayerSources.reduce((sum, row) => sum + row.total, 0) || (isViewingFight ? playerDamage : playerDamageTotal);
  const petSources = petRows
    .flatMap((row) => row.sources ?? [])
    .sort((a, b) => b.total - a.total);
  const sessionPetRows = [...petAggs.values()]
    .filter((row) => !row.key.startsWith("source:"))
    .sort((a, b) => b.total - a.total);
  const sessionPetSources = [...petAggs.values()]
    .filter((row) => row.key.startsWith("source:"))
    .sort((a, b) => b.total - a.total);
  const sessionPetTotal = sessionPetRows.reduce((sum, row) => sum + row.total, 0);
  const topKills = [...killCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);
  const elapsedSecs = Math.max(1, Math.round((now - sessionStart) / 1000));
  const visibleBuckets = selectedHistory?.buckets ?? (isViewingFight ? [] : sessionBuckets);
  const visibleXp = selectedHistory?.xp ?? (isViewingFight ? 0 : xpSession);
  const visibleKills = selectedHistory?.kills ?? (isViewingFight ? 0 : kills);
  const visibleDeaths = selectedHistory?.deaths ?? (isViewingFight ? 0 : deaths);
  const visiblePetDamage = selectedHistory?.petDamage ?? (isViewingFight ? petTotal : sessionPetTotal || petTotal);
  const visibleDurationSecs = selectedHistory?.durationSecs ?? (isViewingFight ? fight?.durationSecs ?? 0 : elapsedSecs);
  const visibleZones = selectedHistory?.zones ?? (isViewingFight
    ? [currentZone]
    : [...new Set(sessionBuckets.map((b) => b.zone))]);
  const visibleTopKills = selectedHistory
    ? selectedHistory.topMob
      ? [{ name: selectedHistory.topMob, count: selectedHistory.topMobKills }]
      : []
    : isViewingFight ? [] : topKills;
  const buckets = [...visibleBuckets].sort((a, b) => {
    const axp = a.seconds > 0 ? a.xp / a.seconds : a.xp;
    const bxp = b.seconds > 0 ? b.xp / b.seconds : b.xp;
    return bxp - axp;
  });
  const bestBucket = buckets[0] ?? null;
  const livePaceSample = pace.active
    ? pace.active
    : pace.history.find((sample) => sample.startedAtMs >= sessionStart) ?? null;
  const livePace = livePaceSample ? paceSnapshot(livePaceSample, pace.lootMetrics, now) : null;
  const recoveredPace = Boolean(pace.active && pace.active.startedAtMs < sessionStart);
  const recoveredMotes = livePace?.loot.find((row) => row.metricId === "motes")?.total ?? 0;
  const currentSessionDuration = Math.max(
    elapsedSecs,
    fight?.active ? fight.durationSecs : 0,
    recoveredPace ? Math.round((livePace?.elapsedMs ?? 0) / 1000) : 0,
  );
  const sessionRoutes: SessionRouteSample[] = routeSegments.map((route) => ({
    label: route.label,
    durationSecs: Math.max(1, Math.round((Math.max(route.endedAtMs, now) - route.startedAtMs) / 1000)),
    xp: route.xp,
    aaPoints: route.aaPoints,
    motes: route.motes,
    damage: route.damage,
  }));
  const currentSessionSample: SessionComparisonSample = {
    id: "current-session",
    label: "Current session",
    durationSecs: currentSessionDuration,
    combatSecs: combatSecs + (fight?.active ? fight.durationSecs : 0),
    activeSecs: fightCount > 0 || fight?.active ? combatSecs + (fight?.active ? fight.durationSecs : 0) : null,
    observations: fightCount + (fight?.active ? 1 : 0),
    fights: fightCount + (fight?.active ? 1 : 0),
    kills: recoveredPace ? null : kills,
    deaths: recoveredPace ? null : deaths,
    xp: recoveredPace ? livePace?.xpPercent ?? xpSession : xpSession,
    aaPoints: recoveredPace ? livePace?.aaPointsEarned ?? aaPoints : aaPoints,
    aaPercent: livePace?.aaPercentGained ?? null,
    motes: recoveredPace ? recoveredMotes : motes,
    damage: playerDamageTotal + (fight?.active ? playerDamage : 0),
    damageTaken: damageTakenTotal + (fight?.active ? playerRow?.damageTaken ?? 0 : 0),
    skills: sourceSkills(liveSessionSources),
    routes: sessionRoutes,
  };
  const currentFightSample: SessionComparisonSample = {
    id: "current-fight",
    label: fight?.active ? "Current fight" : "Last fight",
    durationSecs: fight?.durationSecs ?? 0,
    combatSecs: fight?.durationSecs ?? 0,
    activeSecs: fight?.durationSecs ?? 0,
    observations: fight ? 1 : 0,
    fights: fight ? 1 : 0,
    damage: fight ? playerDamage : null,
    damageTaken: fight ? playerRow?.damageTaken ?? 0 : null,
    skills: sourceSkills(playerSources),
  };
  const viewedSample = selectedHistory
    ? historySample(selectedHistory)
    : isViewingFight ? currentFightSample : currentSessionSample;
  const baselineCandidates = sessionHistory.filter((row) => row.id !== selectedHistory?.id);
  const configuredBaseline = store.baselineSessionId && store.baselineSessionId !== "auto"
    ? baselineCandidates.find((row) => row.id === store.baselineSessionId) ?? null
    : null;
  const baselineRow = configuredBaseline ?? baselineCandidates[0] ?? null;
  const baselineSample = baselineRow ? historySample(baselineRow) : null;
  const comparison = baselineSample
    ? compareSessions(currentSessionSample, baselineSample, store.comparisonGoal ?? "xp")
    : null;
  const visibleRoutes = selectedHistory?.routes ?? (isViewingFight ? [] : sessionRoutes);
  const aaPointsMode = [currentSessionSample, baselineSample]
    .some((sample) => (sample?.aaPoints ?? 0) > 0);
  const boardSamples = [currentFightSample, currentSessionSample, baselineSample] as const;
  const boardSources = [playerSources, liveSessionSources, baselineRow?.damageSources ?? []] as const;

  // One-click postable session summary (same cultural fit as the per-fight
  // "Parse copied" button): plain text for Discord/guild chat.
  async function copySessionRecap() {
    const durSecs = visibleDurationSecs;
    const xpPerHour = durSecs > 0 ? (visibleXp / durSecs) * 3600 : 0;
    const zones = visibleZones.filter(Boolean);
    const lines = [
      `Session recap — ${fmtDuration(durSecs)}${zones.length ? ` in ${zones.join(", ")}` : ""}`,
      `XP +${visibleXp.toFixed(3)}%${xpPerHour > 0 ? ` (${xpPerHour.toFixed(2)}%/hr)` : ""} · ${visibleKills} kill${visibleKills === 1 ? "" : "s"} · ${visibleDeaths} death${visibleDeaths === 1 ? "" : "s"}`,
      visibleTopKills[0]
        ? `Top mob: ${visibleTopKills[0].name} (${visibleTopKills[0].count})`
        : "",
      visiblePlayerSources[0]
        ? `Top damage source: ${visiblePlayerSources[0].name}`
        : "",
      visiblePetDamage > 0 ? `Pet damage: ${fmtNum(visiblePetDamage)}` : "",
      bestBucket && bestBucket.zone
        ? `Best XP pace: ${bestBucket.difficulty} in ${bestBucket.zone}`
        : "",
    ].filter(Boolean);
    // Clipboard unavailable => copy() resolves false; nothing useful to show.
    await copyRecapText(lines.join("\n"), true);
  }

  // One-file session export (moved from the old Fights session card): this
  // app run's XP, kills, effects, death recaps, loot, rolls, and scoreboard.
  async function exportCurrentSession() {
    const { startTs, endTs } = sessionBounds();
    if (startTs === null || endTs === null) {
      showToast("No session activity to export yet");
      return;
    }
    const safeCharacter = character.replace(/[^\w-]+/g, "_") || "character";
    const day = new Date().toISOString().slice(0, 10);
    setExportingSession(true);
    try {
      const path = await save({
        defaultPath: `legends-session-${safeCharacter}-${day}.json`,
        filters: [
          { name: "Legends Companion session", extensions: ["json"] },
        ],
      });
      if (typeof path !== "string") return;
      await exportSession({
        path,
        character,
        startTs,
        endTs,
        details: {
          xp: sessionLog.xp,
          pace,
          level: {
            progress: sessionLog.levelProgress,
            anchorKnown: sessionLog.levelAnchorKnown,
          },
          kills: Object.values(sessionLog.kills),
          effects: sessionLog.effects,
          deathRecaps: sessionLog.recaps.map(({ id, ts, killer, damage }) => ({
            id,
            ts,
            killer,
            damage,
          })),
          loot: sessionLog.loot,
          rolls: sessionLog.rolls,
          scoreboard: sessionScoreboard(),
          captureLimits: {
            collectionRows: SESSION_CAP,
            deathRecaps: RECAP_CAP,
            rawLogLinesIncluded: false,
          },
        },
      });
      showToast("Session exported");
    } catch (e) {
      showToast(`Could not export session: ${String(e)}`);
    } finally {
      setExportingSession(false);
    }
  }

  // Scoped insight sections show the fight/session/past switcher and summary;
  // session-data panels are app-run data with their own headers.
  const isInsight = INSIGHT_SECTIONS.includes(section);
  const isSessionPanel = SESSION_PANEL_IDS.includes(section);
  const panelCounts: Record<SessionPanelId, number> = {
    rates: pace.history.length,
    xp: sessionLog.xp.count,
    wallet: sessionLog.wallet.count,
    kills: Object.keys(sessionLog.kills).length,
    scoreboard: Object.keys(sessionScoreboard()).length,
    effects: sessionLog.effects.length,
    deaths: sessionLog.recaps.length,
    loot: sessionLog.loot.length,
    wishlist: wishlist.length + watchedKills.length,
    rolls: sessionLog.rolls.length,
    factions: Object.keys(sessionLog.factions).length,
    skills: sessionLog.skillUps.length,
    trends: sessionHistory.length,
    career: careerCounts.sessions,
    ledger: careerCounts.loot,
  };
  // Trends panel input: the persisted per-session history rows (legacy rows
  // without coin data pass null so the plat series gaps, never fakes a zero).
  const trendRows: TrendSessionInput[] = sessionHistory.map((row) => ({
    id: row.id,
    startedTs: row.startedTs,
    durationSecs: row.durationSecs,
    xp: row.xp,
    kills: row.kills,
    deaths: row.deaths,
    platCopper: row.platCopper ?? null,
    levelUps: row.levelUps ?? 0,
  }));

  return (
    <div className="coach-grid">
      <section className="card coach-span coach-context-card">
        <div className="coach-context-bar">
          <div className="coach-context-picker">
            <div className="coach-scope-switch" role="group" aria-label="View scope">
              {([
                ["fight", fight?.active ? "Current fight" : "Last fight"],
                ["session", "Current session"],
                ["past", "Past session"],
              ] as const).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={viewScope === id ? "active" : ""}
                  disabled={(id === "fight" && !fight) || (id === "past" && sessionHistory.length === 0)}
                  onClick={() => {
                    setViewScope(id);
                    if (isSessionPanel && id !== "session") {
                      setSection("session");
                    }
                    if (id === "past" && !selectedHistoryId && sessionHistory[0]) {
                      setSelectedHistoryId(sessionHistory[0].id);
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {isInsight && viewScope === "past" && (
              <select
                id="coach-session-context"
                value={selectedHistory?.id ?? ""}
                onChange={(event) => setSelectedHistoryId(event.target.value)}
                aria-label="Past session"
                disabled={sessionHistory.length === 0}
              >
                {sessionHistory.length === 0 && <option value="">No past sessions</option>}
                {sessionHistory.map((row) => (
                  <option key={row.id} value={row.id}>
                    {new Date(row.startedTs).toLocaleString()} · {fmtDuration(row.durationSecs)}
                  </option>
                ))}
              </select>
            )}
            {isInsight && viewScope === "past" && sessionHistory.length > 0 && (
              <button className="ghost small" onClick={clearSessionHistory}>Clear history</button>
            )}
            {viewScope === "session" && (
              <button className="ghost small" onClick={clearSession}>
                New session
              </button>
            )}
            <button
              className="ghost small"
              onClick={() => void copySessionRecap()}
              title="Copy a postable text summary of this session"
            >
              {recapCopied ? "Copied ✓" : "Copy recap"}
            </button>
            <button
              className="ghost small"
              onClick={() => void exportCurrentSession()}
              disabled={!sessionLog.hasActivity || exportingSession}
              title="Save this session's fights, XP, kills, effects, loot, and rolls"
            >
              {exportingSession ? "Exporting…" : "Export session"}
            </button>
          </div>
          <span className="context-chip">
            <span>{isViewingHistory ? "Past" : isViewingFight ? (fight?.active ? "Live" : "Last") : "Live"}</span>
            <strong>
              {isViewingHistory
                ? `${new Date(selectedHistory.startedTs).toLocaleTimeString()} - ${new Date(selectedHistory.endedTs).toLocaleTimeString()}`
                : isViewingFight
                  ? fight?.target ?? "No fight"
                  : `${sessionReason} · ${new Date(sessionStart).toLocaleTimeString()}`}
            </strong>
          </span>
          <span className="context-chip">
            <span>{isViewingHistory ? "Zones" : "Zone"}</span>
            <strong>{isViewingHistory ? selectedHistory.zones.join(" / ") || "Unknown zone" : currentZone}</strong>
          </span>
          {viewScope === "session" && (
            <>
              <label className="context-field" title="Best-effort auto-detects when a log line includes difficulty/tier/instance D1-D5. Otherwise set it here.">
                <span>Difficulty</span>
                <select
                  id="coach-difficulty"
                  value={store.difficulty}
                  onChange={(e) => setStore({ ...store, difficulty: e.target.value })}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="context-afk" title="Starts a fresh session after a long idle gap. Zone changes stay inside the same active play session.">
                <input
                  type="checkbox"
                  className="switch"
                  checked={store.smartSession}
                  onChange={(e) => setStore({ ...store, smartSession: e.target.checked })}
                />
                <span>AFK reset</span>
                {store.smartSession && (
                  <select
                    value={store.idleMinutes}
                    onChange={(e) => setStore({ ...store, idleMinutes: Number(e.target.value) || 15 })}
                  >
                    <option value={10}>10 min</option>
                    <option value={15}>15 min</option>
                    <option value={20}>20 min</option>
                    <option value={30}>30 min</option>
                    <option value={45}>45 min</option>
                  </select>
                )}
              </label>
            </>
          )}
        </div>
      </section>

      <section className="card coach-span coach-tabs-card">
        <div className="coach-tabs">
          <button
            className={`settings-tab${section === "session" ? " active" : ""}`}
            onClick={() => setSection("session")}
          >
            Overview
          </button>
          {SESSION_PANELS.map((p) => (
            <button
              key={p.id}
              className={`settings-tab${section === p.id ? " active" : ""}`}
              onClick={() => {
                setViewScope("session");
                setSection(p.id);
              }}
            >
              {p.label}
              <span className="pill">{panelCounts[p.id]}</span>
            </button>
          ))}
          {([
            ["damage", "Damage"],
            ["pets", "Pets"],
            ["efficiency", "Routes"],
            ["npcs", "NPC history"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={`settings-tab${section === id ? " active" : ""}`}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {isInsight && <section className="card coach-span coach-summary-card">
        <div className="card-head">
          <span className="section-title">{viewedSample.label}</span>
          <span className="hint">{isViewingHistory ? selectedHistory.endReason : isViewingFight ? fight?.target : "Live session totals"}</span>
        </div>
        <div className="coach-summary">
          <Stat label="XP" value={viewedSample.xp == null ? "—" : `${viewedSample.xp.toFixed(3)}%`} />
          <Stat label="AA" value={viewedSample.aaPoints == null ? "—" : String(viewedSample.aaPoints)} />
          <Stat label="Motes" value={viewedSample.motes == null ? "—" : String(viewedSample.motes)} />
          <Stat label="Damage (includes shields)" value={viewedSample.damage == null ? "—" : fmtNum(viewedSample.damage)} />
          <Stat label="Kills / Deaths" value={`${viewedSample.kills ?? "—"} / ${viewedSample.deaths ?? "—"}`} />
          <Stat label="Time" value={fmtDuration(visibleDurationSecs)} />
        </div>
      </section>}

      {isSessionPanel && (
        <SessionPanel
          tab={section as SessionPanelId}
          snap={sessionLog}
          wishlist={wishlist}
          watchedKills={watchedKills}
          pace={pace}
          onSetPace={updatePace}
          character={character}
          history={trendRows}
        />
      )}

      {section === "session" && <section className="card coach-span comparison-card">
        <div className="comparison-toolbar">
          <div>
            <span className="section-title">Performance</span>
            <span className={`comparison-confidence ${comparison?.confidence.level ?? "insufficient"}`}>
              {comparison?.confidence.label ?? "Start a new session to create a baseline"}
            </span>
          </div>
          <div className="comparison-controls">
            <label>
              <span>Goal</span>
              <select
                value={store.comparisonGoal ?? "xp"}
                onChange={(event) => setStore((previous) => ({ ...previous, comparisonGoal: event.target.value as ComparisonGoal }))}
              >
                <option value="xp">XP</option>
                <option value="aa">AA</option>
                <option value="motes">Motes</option>
                <option value="damage">Damage</option>
              </select>
            </label>
            <label>
              <span>Baseline</span>
              <select
                value={configuredBaseline?.id ?? "auto"}
                onChange={(event) => setStore((previous) => ({ ...previous, baselineSessionId: event.target.value }))}
                disabled={baselineCandidates.length === 0}
              >
                <option value="auto">Previous session (default)</option>
                {baselineCandidates.map((row) => (
                  <option key={row.id} value={row.id}>
                    {new Date(row.startedTs).toLocaleString()} · {fmtDuration(row.durationSecs)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="comparison-board">
          <div className="comparison-board-head">
            <span>Metric</span>
            <div>
              <strong>{fight?.active ? "Current fight" : "Last fight"}</strong>
              <small>{fight?.target ?? "Waiting for combat"}</small>
            </div>
            <div>
              <strong>Current session</strong>
              <small>{currentSessionSample.fights ?? 0} observed fight{currentSessionSample.fights === 1 ? "" : "s"} · {currentZone}</small>
            </div>
            <div>
              <strong>Baseline session</strong>
              <small>{baselineRow ? new Date(baselineRow.startedTs).toLocaleString() : "Finish a session to create one"}</small>
            </div>
          </div>
          {BOARD_METRICS.map((metric) => {
            const values = boardSamples.map((sample) => boardMetricValue(sample, metric.id, aaPointsMode));
            const delta = metric.id === "duration" || metric.id === "damage" || comparison?.confidence.level === "insufficient"
              ? null
              : boardDelta(values[1], values[2], metric.higherIsBetter);
            const goalMetric = store.comparisonGoal === "xp" ? "xp"
              : store.comparisonGoal === "aa" ? "aa"
                : store.comparisonGoal === "motes" ? "motes" : "dps";
            return (
              <div className={`comparison-board-row${metric.id === goalMetric ? " goal" : ""}`} key={metric.id}>
                <strong>{metric.label}</strong>
                {values.map((value, index) => (
                  <span className="comparison-board-value" key={index}>
                    <b>{formatBoardValue(metric.id, value, aaPointsMode)}</b>
                    {index === 1 && delta && <small className={delta.direction}>{delta.text} vs baseline</small>}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        <div className="comparison-skills-head">
          <span className="section-title">Top skills</span>
          <span className="hint">Damage shields are included as their own damage source.</span>
        </div>
        <div className="comparison-skills">
          {boardSources.map((sources, column) => {
            const total = sources.reduce((sum, source) => sum + source.total, 0);
            return (
              <div className="comparison-skill-column" key={column}>
                <strong>{column === 0 ? "Current fight" : column === 1 ? "Current session" : "Baseline session"}</strong>
                {sources.slice(0, 5).map((source) => {
                  const uses = source.casts ?? source.hits ?? 0;
                  return (
                    <div className="comparison-skill" key={source.name}>
                      <span>{source.name}</span>
                      <b>{fmtNum(source.total)}</b>
                      <small>{pct(total, source.total)}{uses > 0 ? ` · ${fmtNum(Math.round(source.total / uses))}/${source.casts ? "cast" : "hit"}` : ""}</small>
                    </div>
                  );
                })}
                {sources.length === 0 && <span className="comparison-skill-empty">No damage recorded</span>}
              </div>
            );
          })}
        </div>
        {comparison && comparison.confidence.level !== "insufficient" && comparison.findings.length > 0 && (
          <div className="comparison-findings">
            {comparison.findings.map((finding) => <span key={finding}>{finding}</span>)}
          </div>
        )}
      </section>}

      {section === "damage" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Player damage sources</span></div>
        <div className="coach-table">
          {visiblePlayerSources.slice(0, 12).map((row) => (
            <div className="coach-row compact" key={row.name}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>
                {pct(visiblePlayerDamage, row.total)} of damage
                {(row.casts ?? row.hits ?? 0) > 0 ? ` · ${fmtNum(Math.round(row.total / Math.max(1, row.casts ?? row.hits ?? 0)))} per ${row.casts ? "cast" : "hit"}` : ""}
              </span>
            </div>
          ))}
          {visiblePlayerSources.length === 0 && (
            <Empty
              title="No damage sources yet"
              body="Damage sources will appear here once the selected session has parsed damage."
            />
          )}
        </div>
      </section>}

      {section === "efficiency" && <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Route segments</span>
          <span className="hint">Wall-clock rates include travel, recovery, and downtime.</span>
        </div>
        <div className="coach-table">
          {visibleRoutes.slice(0, 10).map((route, index) => {
            const hours = Math.max(1, route.durationSecs) / 3600;
            return (
            <div className="coach-row compact route-row" key={`${route.label}:${index}`}>
              <strong>{route.label}</strong>
              <span>{fmtDuration(route.durationSecs)}</span>
              <span>
                {route.xp != null ? `${(route.xp / hours).toFixed(2)}% XP/hr` : "XP --"}
                {route.aaPoints != null ? ` · ${(route.aaPoints / hours).toFixed(1)} AA/hr` : ""}
                {route.motes != null ? ` · ${(route.motes / hours).toFixed(1)} motes/hr` : ""}
              </span>
              <span>{route.damage != null ? `${fmtNum(Math.round(route.damage / Math.max(1, route.durationSecs)))} DPS` : "Damage --"}</span>
            </div>
          )})}
          {visibleRoutes.length === 0 && (
            <Empty
              title="No route segments yet"
              body="Route segments appear as this session records activity by zone and difficulty."
            />
          )}
        </div>
      </section>}

      {section === "efficiency" && <section className="card">
        <div className="card-head"><span className="section-title">Zones / camps</span></div>
        <div className="coach-table">
          {buckets.slice(0, 6).map((bucket) => (
            <div className="coach-row compact" key={bucket.key}>
              <strong>{bucket.zone}</strong>
              <span>{bucket.difficulty}</span>
              <span>{bucket.kills} kills · {bucket.xp.toFixed(3)}% XP · {fmtNum(bucket.damage)} damage</span>
            </div>
          ))}
          {buckets.length === 0 && (
            <Empty
              title="No zone totals yet"
              body="Zone and camp totals appear as the selected session records activity."
            />
          )}
        </div>
      </section>}

      {section === "pets" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Pet contribution</span></div>
        <div className="coach-kv">
          <span>Detected pet</span><strong>{currentPetName || config?.pets?.join(", ") || "None yet"}</strong>
          <span>Configured pets</span><strong>{config?.pets?.join(", ") || "None"}</strong>
          <span>{isViewingHistory ? "Session pet damage" : "Current session pet damage"}</span><strong>{fmtNum(visiblePetDamage)}</strong>
          {!isViewingHistory && <><span>Current fight pet damage</span><strong>{fmtNum(petTotal)}</strong></>}
          {!isViewingHistory && <><span>Fight share</span><strong>{pct(fight?.totalDamage ?? 0, petTotal)}</strong></>}
        </div>
        <div className="coach-table">
          {!isViewingHistory && sessionPetRows.slice(0, 6).map((row) => (
            <div className="coach-row compact" key={`session-${row.name}`}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} session damage</span>
              <span>{pct(sessionPetTotal, row.total)} of pet damage</span>
            </div>
          ))}
          {!isViewingHistory && sessionPetSources.slice(0, 8).map((row) => (
            <div className="coach-row compact" key={row.key}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} session damage</span>
              <span>{pct(sessionPetTotal, row.total)} of pet damage</span>
            </div>
          ))}
          {!isViewingHistory && petRows.slice(0, 4).map((row) => (
            <div className="coach-row compact" key={row.name}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>{pct(fight?.totalDamage ?? 0, row.total)} of fight</span>
            </div>
          ))}
          {!isViewingHistory && petSources.slice(0, 8).map((row) => (
            <div className="coach-row compact" key={`source-${row.name}`}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>{pct(petTotal, row.total)} of pet damage</span>
            </div>
          ))}
          {isViewingHistory && (
            <div className="coach-row compact">
              <strong>{selectedHistory.topMob ? "Saved session" : "Previous session"}</strong>
              <span>{fmtNum(visiblePetDamage)} pet damage</span>
              <span>{selectedHistory.zones.join(" / ") || "No zone recorded"}</span>
            </div>
          )}
          {!isViewingHistory && sessionPetRows.length === 0 && petRows.length === 0 && (
            <Empty
              title="No pet damage yet"
              body="If you are using a pet, use the pet leader command once (the app remembers the name from then on) or add the pet's exact name in Settings so pet damage can be attributed."
            />
          )}
        </div>
      </section>}

      {section === "npcs" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">NPC history</span></div>
        <div className="coach-table">
          {npcMemory.slice(0, 12).map((npc) => (
            <div className="coach-row" key={npc.name}>
              <strong>{npc.name}</strong>
              <span>{new Date(npc.lastTs * 1000).toLocaleString()}</span>
              <span>{npc.lines[0]}</span>
              <span>
                <a href={`https://www.google.com/search?q=${encodeURIComponent(`EverQuest Legends ${npc.name}`)}`} target="_blank" rel="noreferrer">search web</a>
              </span>
            </div>
          ))}
          {npcMemory.length === 0 && (
            <Empty
              title="No NPC dialogue yet"
              body="NPC says/told-you dialogue is remembered here after hails and quest conversations."
            />
          )}
        </div>
      </section>}
      {toastNode}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="coach-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
