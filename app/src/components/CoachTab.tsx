import { useEffect, useMemo, useRef, useState } from "react";
import { discoverLogs, getConfig, getProfile } from "../api";
import { fmtDuration, fmtNum, useTauriEvent } from "../hooks";
import type {
  AppConfig,
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

const COACH_KEY = "eqlogs.coach.v1";
const NPC_KEY = "eqlogs.npcMemory.v1";
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
}

interface CoachStore {
  difficulty: string;
  smartSession: boolean;
  idleMinutes: number;
  buckets: EfficiencyBucket[];
  history: SessionHistoryRow[];
}

function storeKey(character: string, loadout: string): string {
  const c = character.trim().toLowerCase() || "unknown";
  const l = loadout.trim().toLowerCase() || "default";
  return `${COACH_KEY}:${c}:${l}`;
}

function loadStore(key = COACH_KEY): CoachStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<CoachStore>;
    return {
      difficulty: parsed.difficulty || "Unknown",
      smartSession: parsed.smartSession === true,
      idleMinutes:
        typeof parsed.idleMinutes === "number" && parsed.idleMinutes >= 5
          ? parsed.idleMinutes
          : 15,
      buckets: Array.isArray(parsed.buckets) ? parsed.buckets.slice(0, 80) : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, SESSION_HISTORY_CAP) : [],
    };
  } catch {
    return {
      difficulty: "Unknown",
      smartSession: false,
      idleMinutes: 15,
      buckets: [],
      history: [],
    };
  }
}

function saveStore(store: CoachStore, key = COACH_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(store));
  } catch {
    // Best-effort insights cache.
  }
}

function loadNpcMemory(): NpcMemory[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NPC_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, NPC_CAP) : [];
  } catch {
    return [];
  }
}

function saveNpcMemory(rows: NpcMemory[]): void {
  try {
    localStorage.setItem(NPC_KEY, JSON.stringify(rows.slice(0, NPC_CAP)));
  } catch {
    // Best-effort NPC cache.
  }
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

export default function CoachTab({ character }: { character: string }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [logs, setLogs] = useState<DiscoveredLog[]>([]);
  const [store, setStore] = useState<CoachStore>(() => loadStore());
  const [section, setSection] = useState<"session" | "damage" | "pets" | "efficiency" | "npcs">("session");
  const [effects, setEffects] = useState<Map<string, EffectAgg>>(() => new Map());
  const [petAggs, setPetAggs] = useState<Map<string, PetAgg>>(() => new Map());
  const [sessionBuckets, setSessionBuckets] = useState<EfficiencyBucket[]>([]);
  const [npcMemory, setNpcMemory] = useState<NpcMemory[]>(() => loadNpcMemory());
  const [currentZone, setCurrentZone] = useState("Unknown zone");
  const [fight, setFight] = useState<FightUpdatePayload | null>(null);
  const [sessionStart, setSessionStart] = useState(Date.now());
  const [recapCopied, setRecapCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [xpSession, setXpSession] = useState(0);
  const [kills, setKills] = useState(0);
  const [killCounts, setKillCounts] = useState<Map<string, number>>(() => new Map());
  const [deaths, setDeaths] = useState(0);
  const [sessionReason, setSessionReason] = useState("Manual session");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [currentPetName, setCurrentPetName] = useState("");
  const currentZoneRef = useRef(currentZone);
  const difficultyRef = useRef(store.difficulty);
  const completedFightRef = useRef("");
  const lastActivityMsRef = useRef(Date.now());
  const loadedStoreKeyRef = useRef("");

  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
    getProfile().then(setProfile).catch(() => setProfile(null));
    discoverLogs().then(setLogs).catch(() => setLogs([]));
  }, []);

  const activeLoadout = profile?.loadouts.find((l) => l.name === profile.active_loadout);
  const scopedKey = storeKey(profile?.character || character, activeLoadout?.name || profile?.active_loadout || "Default");

  useEffect(() => {
    loadedStoreKeyRef.current = scopedKey;
    setStore(loadStore(scopedKey));
  }, [scopedKey]);

  useEffect(() => {
    if (loadedStoreKeyRef.current !== scopedKey) return;
    saveStore(store, scopedKey);
  }, [store, scopedKey]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    saveNpcMemory(npcMemory);
  }, [npcMemory]);

  useEffect(() => {
    currentZoneRef.current = currentZone;
  }, [currentZone]);

  useEffect(() => {
    difficultyRef.current = store.difficulty;
  }, [store.difficulty]);

  function sessionHasData(): boolean {
    return (
      xpSession > 0 ||
      kills > 0 ||
      deaths > 0 ||
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
    const activePlayerRow = fight?.rows.find((r) => r.name.toLowerCase() === character.toLowerCase());
    const damageSources = [...(activePlayerRow?.sources ?? [])]
      .filter((s) => !/\s+\(pet\)$/i.test(s.name))
      .sort((a, b) => b.total - a.total)
      .slice(0, 16);
    const historyEffects = [...effects.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 16);
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

  function resetSession(reason: string, endReason = reason) {
    archiveCurrentSession(endReason);
    setSessionStart(Date.now());
    setSessionReason(reason);
    setXpSession(0);
    setKills(0);
    setDeaths(0);
    setKillCounts(new Map());
    setSessionBuckets([]);
    setEffects(new Map());
    setPetAggs(new Map());
    setFight(null);
    completedFightRef.current = "";
    lastActivityMsRef.current = Date.now();
  }

  function clearSession() {
    const hasData =
      sessionHasData();
    if (
      hasData &&
      !window.confirm("Start a new Insights session? Fight history and NPC notes are not deleted.")
    ) {
      return;
    }
    resetSession("Manual session", "Started new session");
  }

  function clearSessionHistory() {
    if (
      store.history.length > 0 &&
      !window.confirm("Clear previous Insights session summaries for this character/loadout?")
    ) {
      return;
    }
    setStore({ ...store, history: [] });
    setSelectedHistoryId("");
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
      if (xp > 0) {
        setXpSession((v) => v + xp);
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, xp }));
      }
      const victim = slainVictim(p.event);
      if (victim && victim !== "You" && !/^[A-Z][a-z]+$/.test(victim)) {
        setKills((v) => v + 1);
        setKillCounts((prev) => {
          const next = new Map(prev);
          next.set(victim, (next.get(victim) ?? 0) + 1);
          return next;
        });
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, kills: 1 }));
      }
      if (p.message === "You died." || victim === "You") {
        setDeaths((v) => v + 1);
        setSessionBuckets((rows) => addBucketRows(rows, { zone: bucketZone, difficulty: bucketDifficulty, deaths: 1 }));
      }
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

  const newestLog = useMemo(
    () =>
      logs
        .filter((l) => l.modifiedTs != null)
        .sort((a, b) => (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0))[0] ?? null,
    [logs],
  );
  const currentLog = logs.find((l) => l.path === config?.logPath) ?? null;
  const sessionHistory = store.history ?? [];
  const selectedHistory = sessionHistory.find((row) => row.id === selectedHistoryId) ?? null;
  const isViewingHistory = selectedHistory !== null;
  const effectsRows = [...effects.values()].sort((a, b) => b.total - a.total);
  const petRows = fight ? petRowsForCharacter(fight.rows, character) : [];
  const petTotal = summedRowsTotal(petRows);
  const playerRow = fight?.rows.find((r) => r.name.toLowerCase() === character.toLowerCase());
  const playerDamage = Math.max(0, (playerRow?.total ?? 0) - (playerRow?.petDamage ?? 0));
  const playerSources = [...(playerRow?.sources ?? [])]
    .filter((s) => !/\s+\(pet\)$/i.test(s.name))
    .sort((a, b) => b.total - a.total);
  const visiblePlayerSources = selectedHistory?.damageSources ?? playerSources;
  const visiblePlayerDamage = visiblePlayerSources.reduce((sum, row) => sum + row.total, 0) || playerDamage;
  // Old session caches may contain the removed proc/skill classifications.
  const visibleEffectsRows = (selectedHistory?.effects ?? effectsRows).filter(
    (row) => row.kind === "spell",
  );
  const visibleEffectDamage = visibleEffectsRows.reduce((sum, row) => sum + row.total, 0);
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
  const visibleBuckets = selectedHistory?.buckets ?? sessionBuckets;
  const visibleXp = selectedHistory?.xp ?? xpSession;
  const visibleKills = selectedHistory?.kills ?? kills;
  const visibleDeaths = selectedHistory?.deaths ?? deaths;
  const visiblePetDamage = selectedHistory?.petDamage ?? (sessionPetTotal || petTotal);
  const visibleDurationSecs = selectedHistory?.durationSecs ?? elapsedSecs;
  const visibleZones = selectedHistory?.zones ?? [...new Set(sessionBuckets.map((b) => b.zone))];
  const visibleTopKills = selectedHistory
    ? selectedHistory.topMob
      ? [{ name: selectedHistory.topMob, count: selectedHistory.topMobKills }]
      : []
    : topKills;
  const buckets = [...visibleBuckets].sort((a, b) => {
    const axp = a.seconds > 0 ? a.xp / a.seconds : a.xp;
    const bxp = b.seconds > 0 ? b.xp / b.seconds : b.xp;
    return bxp - axp;
  });
  const overallBucket = sessionBuckets.reduce<EfficiencyBucket>(
    (acc, b) => ({
      ...acc,
      xp: acc.xp + b.xp,
      kills: acc.kills + b.kills,
      deaths: acc.deaths + b.deaths,
      damage: acc.damage + b.damage,
      seconds: acc.seconds + b.seconds,
    }),
    {
      key: "overall",
      zone: "All zones",
      difficulty: "All",
      xp: 0,
      kills: 0,
      deaths: 0,
      damage: 0,
      seconds: 0,
    },
  );
  const bestBucket = buckets[0] ?? null;
  const currentBucket = buckets.find((b) => b.key === bucketKey(currentZone, store.difficulty));
  const currentXpHour =
    currentBucket && currentBucket.seconds > 0
      ? (currentBucket.xp / currentBucket.seconds) * 3600
      : null;

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
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setRecapCopied(true);
      window.setTimeout(() => setRecapCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing useful to surface here.
    }
  }

  const findings = [
    visibleTopKills[0] ? `${visibleTopKills[0].name} is your most-killed mob (${visibleTopKills[0].count}).` : "",
    visiblePlayerSources[0] ? `${visiblePlayerSources[0].name} is your top damage source.` : "",
    visibleXp > 0 && buckets.length === 0 ? "XP was gained, but there is not enough zone timing yet to judge pace." : "",
    bestBucket && currentBucket && bestBucket.key !== currentBucket.key
      ? `${bestBucket.difficulty} in ${bestBucket.zone} is your best stored XP pace.`
      : "",
    visibleEffectsRows[0] ? `${visibleEffectsRows[0].name} leads observed spell damage.` : "",
    visiblePetDamage > 0 ? `Pets have contributed ${fmtNum(visiblePetDamage)} damage.` : "",
  ].filter(Boolean);

  return (
    <div className="coach-grid">
      <section className="card coach-span coach-context-card">
        <div className="coach-context-bar">
          <div className="coach-context-picker">
            <select
              id="coach-session-context"
              value={selectedHistoryId || "current"}
              onChange={(e) => setSelectedHistoryId(e.target.value === "current" ? "" : e.target.value)}
              aria-label="Insights session"
            >
              <option value="current">Current session</option>
              {sessionHistory.map((row) => (
                <option key={row.id} value={row.id}>
                  {new Date(row.startedTs).toLocaleString()} · {fmtDuration(row.durationSecs)} · {row.xp.toFixed(3)}% XP
                </option>
              ))}
            </select>
            {!isViewingHistory && (
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
          </div>
          <span className="context-chip">
            <span>{isViewingHistory ? "Previous" : "Live"}</span>
            <strong>
              {isViewingHistory
                ? `${new Date(selectedHistory.startedTs).toLocaleTimeString()} - ${new Date(selectedHistory.endedTs).toLocaleTimeString()}`
                : `${sessionReason} · ${new Date(sessionStart).toLocaleTimeString()}`}
            </strong>
          </span>
          <span className="context-chip">
            <span>{isViewingHistory ? "Zones" : "Zone"}</span>
            <strong>{isViewingHistory ? selectedHistory.zones.join(" / ") || "Unknown zone" : currentZone}</strong>
          </span>
          {!isViewingHistory && (
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
              <label className="context-afk" title="Starts a fresh Insights session after a long idle gap. Zone changes stay inside the same active play session.">
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

      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">{isViewingHistory ? "Session Summary" : "Current Session"}</span>
          <span className="hint">{isViewingHistory ? selectedHistory.endReason : "Live session totals"}</span>
        </div>
        <div className="coach-summary">
          <Stat label="XP" value={`${visibleXp.toFixed(3)}%`} />
          <Stat label="Kills" value={String(visibleKills)} />
          <Stat label="Deaths" value={String(visibleDeaths)} />
          <Stat label="Pet Damage" value={fmtNum(visiblePetDamage)} />
          <Stat label="Zones" value={String(Math.max(1, visibleZones.filter(Boolean).length))} />
          <Stat label="Time" value={fmtDuration(visibleDurationSecs)} />
        </div>
        <div className="coach-tabs">
          {[
            ["session", "Overview"],
            ["damage", "Damage"],
            ["pets", "Pets"],
            ["efficiency", "XP / Zones"],
            ["npcs", "NPC History"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={`settings-tab${section === id ? " active" : ""}`}
              onClick={() => setSection(id as typeof section)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {section === "session" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Session Takeaways</span></div>
        <ul className="coach-list">
          {findings.length > 0 ? findings.map((r) => <li key={r}>{r}</li>) : <li>Start fighting, gaining XP, or hailing NPCs to build session findings.</li>}
        </ul>
      </section>}

      {section === "session" && <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Previous Sessions</span>
          {sessionHistory.length > 0 && (
            <button className="ghost small" onClick={clearSessionHistory}>
              Clear history
            </button>
          )}
        </div>
        <div className="coach-table">
          {sessionHistory.slice(0, 8).map((row) => (
            <button
              type="button"
              className={`coach-row session-history-row${selectedHistoryId === row.id ? " active" : ""}`}
              key={row.id}
              onClick={() => setSelectedHistoryId(row.id)}
            >
              <strong>{new Date(row.startedTs).toLocaleString()}</strong>
              <span>{fmtDuration(row.durationSecs)}, {row.zones.slice(0, 2).join(" / ") || "Unknown zone"}</span>
              <span>{row.xp.toFixed(3)}% XP, {row.kills} kills, {row.deaths} deaths</span>
              <span>{row.topMob ? `${row.topMob} x${row.topMobKills}` : row.endReason}</span>
            </button>
          ))}
          {sessionHistory.length === 0 && <div className="hint">Previous sessions appear here after you start a new session or AFK auto-reset ends one.</div>}
        </div>
      </section>}

      {section === "session" && <section className="card">
        <div className="card-head"><span className="section-title">Zones / Camps</span></div>
        <div className="coach-table">
          {buckets.slice(0, 6).map((b) => (
            <div className="coach-row compact" key={b.key}>
              <strong>{b.zone}</strong>
              <span>{b.difficulty}</span>
              <span>{b.kills} kills, {b.xp.toFixed(3)}% XP, {fmtNum(b.damage)} dmg</span>
            </div>
          ))}
          {buckets.length === 0 && <div className="hint">Zones appear here after zone, XP, kill, or fight lines are parsed.</div>}
        </div>
      </section>}

      {section === "session" && <section className="card">
        <div className="card-head"><span className="section-title">Mobs Killed</span></div>
        <div className="coach-table">
          {visibleTopKills.map((row) => (
            <div className="coach-row compact" key={row.name}>
              <strong>{row.name}</strong>
              <span>{row.count} kill{row.count === 1 ? "" : "s"}</span>
              <span>{visibleXp > 0 ? "contributed to session XP sample" : "waiting for XP sample"}</span>
            </div>
          ))}
          {visibleTopKills.length === 0 && <div className="hint">Kill counts appear here after slain lines are parsed.</div>}
        </div>
      </section>}

      {section === "session" && <section className="card">
        <div className="card-head"><span className="section-title">{isViewingHistory ? "Saved Damage Sources" : "Current Fight Damage"}</span></div>
        <div className="coach-table">
          {visiblePlayerSources.slice(0, 8).map((row) => (
            <div className="coach-row compact" key={row.name}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>{pct(visiblePlayerDamage, row.total)} of damage</span>
            </div>
          ))}
          {visiblePlayerSources.length === 0 && <div className="hint">Damage sources appear here once parsed for the selected session.</div>}
        </div>
      </section>}

      {section === "session" && <section className="card">
        <div className="card-head"><span className="section-title">Setup Details</span></div>
        <div className="coach-kv">
          <span>Current</span><strong>{currentLog ? `${currentLog.character} / ${currentLog.server}` : character || "Unknown"}</strong>
          <span>Newest</span><strong>{newestLog ? `${newestLog.character} / ${newestLog.server}` : "No logs found"}</strong>
          <span>Loadout</span><strong>{activeLoadout?.name ?? "Default"}</strong>
          <span>Classes</span><strong>{activeLoadout?.classes.join(" / ") || "No classes set"}</strong>
          <span>Scope</span><strong>Saved for this character and loadout</strong>
        </div>
        <p className="hint">Dashboard prompts when another discovered log is newer than the active tailed log.</p>
      </section>}

      {section === "damage" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Player Damage Sources</span></div>
        <div className="coach-table">
          {visiblePlayerSources.slice(0, 12).map((row) => (
            <div className="coach-row compact" key={row.name}>
              <strong>{row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>{pct(visiblePlayerDamage, row.total)} of damage</span>
            </div>
          ))}
          {visiblePlayerSources.length === 0 && <div className="hint">Damage sources will appear here once the selected session has parsed damage.</div>}
        </div>
      </section>}

      {section === "efficiency" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">XP by Zone</span></div>
        {store.difficulty === "Unknown" && (
          <div className="hint">Set the current difficulty whenever you change instance difficulty. Rows below stay split by zone and difficulty.</div>
        )}
        {currentXpHour !== null && (
          <div className="hint">Current bucket pace: {currentXpHour.toFixed(2)}% XP/hr. Treat small samples cautiously.</div>
        )}
        <div className="coach-table">
          {(overallBucket.xp > 0 || overallBucket.kills > 0 || overallBucket.damage > 0) && (
            <div className="coach-row compact">
              <strong>Overall session</strong>
              <span>{overallBucket.seconds > 0 ? `${((overallBucket.xp / overallBucket.seconds) * 3600).toFixed(2)}% XP/hr` : `${overallBucket.xp.toFixed(3)}% XP`}</span>
              <span>{overallBucket.kills} kills, {overallBucket.deaths} deaths, {fmtNum(overallBucket.damage)} dmg</span>
            </div>
          )}
          {buckets.slice(0, 8).map((b) => (
            <div className="coach-row compact" key={b.key}>
              <strong>{b.zone} / {b.difficulty}</strong>
              <span>{b.seconds > 0 ? `${((b.xp / b.seconds) * 3600).toFixed(2)}% XP/hr` : `${b.xp.toFixed(3)}% XP`}</span>
              <span>{b.kills} kills, {b.deaths} deaths, {fmtNum(b.damage)} dmg</span>
            </div>
          ))}
          {buckets.length === 0 && <div className="hint">XP, kills, deaths, and fight damage will accumulate by zone and difficulty.</div>}
        </div>
      </section>}

      {section === "damage" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Spell Effect Totals</span></div>
        <p className="hint">Aggregate parsed spell damage for this session. Alerting and TTS are configured through triggers.</p>
        <div className="coach-table">
          {visibleEffectsRows.slice(0, 12).map((row) => (
            <div className="coach-row compact" key={row.key}>
              <strong>Spell: {row.name}</strong>
              <span>{fmtNum(row.total)} damage</span>
              <span>{row.hits} hits, {pct(visibleEffectDamage, row.total)} share</span>
            </div>
          ))}
          {visibleEffectsRows.length === 0 && <div className="hint">Parsed spell damage will appear here as it occurs.</div>}
        </div>
      </section>}

      {section === "pets" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">Pet Contribution</span></div>
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
            <div className="hint">No pet damage has parsed yet. If you are using a pet, use the pet leader command once (the app remembers the name from then on) or add the pet's exact name in Settings so pet damage can be attributed.</div>
          )}
        </div>
      </section>}

      {section === "npcs" && <section className="card coach-span">
        <div className="card-head"><span className="section-title">NPC History</span></div>
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
          {npcMemory.length === 0 && <div className="hint">NPC says/told-you dialogue is remembered here after hails and quest conversations.</div>}
        </div>
      </section>}
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
