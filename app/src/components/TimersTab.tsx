import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useNowMs,
  useTauriEvent,
  useTimers,
  type TimerView as BarTimer,
} from "../hooks";
import { IS_MOCK } from "../mock";
import { SearchSelect } from "./DropsTab";
import {
  announceCampRespawn,
  dropsZones,
  refdbRespawnFor,
  refdbZoneInfo,
  speakText,
} from "../api";
import type {
  CatchUpPayload,
  DropZone,
  LogLinePayload,
  RespawnInfo,
  TimerLane,
  ZoneNamedMob,
} from "../types";
import {
  activeTimers,
  addLearnedRare,
  isRare,
  loadCampRaresOnly,
  loadLearnedRares,
  loadTimers,
  parseDuration,
  saveTimers,
  TIMER_CAP,
  type Timer,
  type TimerView,
} from "../lib/timers";

/** ss / m:ss / h:mm:ss — compact countdown. */
function fmtCountdown(secs: number): string {
  if (secs <= 0) return "UP";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Backend trigger-engine timers (recasts, buffs, DoTs, CC) grouped into the
 *  Active list by their overlay lane, so the Timers window shows EVERY live
 *  timer — not just the respawn/custom ones this tab owns. Order = display
 *  order. `dot` reuses the legend dot palette. */
const BAR_CATEGORIES: {
  lane: TimerLane;
  title: string;
  dot: string;
}[] = [
  { lane: "other", title: "Recasts & abilities", dot: "k-recast" },
  { lane: "buff", title: "Buffs", dot: "k-buff" },
  { lane: "on-others", title: "Buffs · on others", dot: "k-onothers" },
  { lane: "enemy", title: "Enemy · DoTs & CC", dot: "k-enemy" },
];

/** Read-only row for a backend trigger timer (the engine owns its lifecycle —
 *  no reset/dismiss). Reuses the respawn/custom row visuals. */
function BarRow({ t }: { t: BarTimer }) {
  const state = t.expired
    ? "up"
    : t.warn
      ? "urgent"
      : t.frac <= 0.33
        ? "warn"
        : "calm";
  // Fill grows with elapsed time (frac is the fraction REMAINING).
  const width = t.expired ? 100 : Math.max(0, Math.min(100, (1 - t.frac) * 100));
  return (
    <div className={`tmr-t s-${state} k-bar${t.pending ? " pending" : ""}`}>
      <div className="tmr-t-fill" style={{ width: `${width}%` }} />
      <div className="tmr-t-main">
        <span className="tmr-t-name">{t.name}</span>
        <span className="tmr-t-grow" />
        <span className="tmr-t-time num">
          {t.warn && !t.expired && <span className="tmr-warn">&#9888;</span>}
          {t.pending ? "casting…" : fmtCountdown(Math.ceil(t.left))}
        </span>
      </div>
    </div>
  );
}

/** m:ss / h:mm — respawn length for list rows. */
function fmtLen(secs: number): string {
  if (secs <= 0) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}:00`;
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

interface RecentKill {
  id: number;
  name: string;
  atMs: number;
}

// Last-resort respawn when a mob has no DB data and the zone default is unknown
// (classic outdoor standard). Camps usually resolve to the zone default below.
const DEFAULT_RESPAWN_SECS = 400; // 6:40

/** Player-shaped name (one capitalized word — "Torvin") is a dead GROUPMATE,
 *  not a camp kill; mobs carry articles or multiple words. Same heuristic as
 *  the curated ally-slain trigger. */
function looksLikePlayer(name: string): boolean {
  return /^[A-Z][a-z]+$/.test(name);
}

function entityName(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Named" in e) {
    return String((e as { Named: unknown }).Named);
  }
  return "?";
}

const MOCK_TIMERS: Timer[] = IS_MOCK
  ? [
      {
        id: "m1",
        kind: "respawn",
        label: "a ghoul sentinel",
        zoneShort: "gukbottom",
        zoneLong: "Ruins of Old Guk",
        startedAt: Date.now() - 913_000,
        durationSecs: 1680,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: false,
        announced: false,
        source: "auto",
      },
      {
        id: "m2",
        kind: "custom",
        label: "Get off — bedtime",
        zoneShort: null,
        zoneLong: null,
        startedAt: Date.now() - 2_362_000,
        durationSecs: 2400,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: true,
        announced: false,
        source: "manual",
      },
      {
        id: "m3",
        kind: "custom",
        label: "Gate reuse",
        zoneShort: null,
        zoneLong: null,
        startedAt: Date.now() - 3_680_000,
        durationSecs: 4320,
        varianceSecs: 0,
        repeat: true,
        ttsOnPop: true,
        announced: false,
        source: "manual",
      },
    ]
  : [];

export default function TimersTab() {
  const [timers, setTimers] = useState<Timer[]>(() =>
    IS_MOCK ? MOCK_TIMERS : loadTimers(),
  );
  const [learnedTick, setLearnedTick] = useState(0);
  const learned = useRef<Set<string>>(loadLearnedRares());
  const [recentKills, setRecentKills] = useState<RecentKill[]>(
    IS_MOCK
      ? [
          { id: 1, name: "an imp protector", atMs: Date.now() - 18_000 },
          { id: 2, name: "a lava guardian", atMs: Date.now() - 120_000 },
          { id: 3, name: "a fire giant", atMs: Date.now() - 200_000 },
        ]
      : [],
  );
  const [zoneShort, setZoneShort] = useState<string | null>(
    IS_MOCK ? "gukbottom" : null,
  );
  const [zoneLong, setZoneLong] = useState<string | null>(
    IS_MOCK ? "Ruins of Old Guk" : null,
  );
  const [zoneRares, setZoneRares] = useState<ZoneNamedMob[]>([]);
  // Full zone list for the manual zone picker (so you can set the zone without
  // waiting to zone in — useful when you launch the app already at a camp).
  const [zones, setZones] = useState<DropZone[]>(
    IS_MOCK
      ? [
          { shortName: "gukbottom", longName: "Ruins of Old Guk", era: 0 },
          { shortName: "guktop", longName: "Guk", era: 0 },
          { shortName: "sebilis", longName: "Old Sebilis", era: 0 },
          { shortName: "befallen", longName: "Befallen", era: 0 },
        ]
      : [],
  );

  // Custom quick-add form.
  const [durInput, setDurInput] = useState("30m");
  const [label, setLabel] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [tts, setTts] = useState(true);
  const [addError, setAddError] = useState<string | null>(null);

  const respawnCache = useRef(new Map<string, RespawnInfo | null>());
  const respawnPending = useRef(new Set<string>());
  const zoneMap = useRef<Map<string, string> | null>(null); // longLower → short
  // The zone's typical respawn (mode of its rares), used as the fallback when a
  // killed placeholder isn't in the reference DB. Read from async callbacks.
  const zoneDefaultRef = useRef(0);
  const catchingUp = useRef(false);
  const announced = useRef(new Set<string>());
  const killSeq = useRef(0);
  // Bumped when a lazy respawn lookup resolves, so kill rows re-render.
  const [, setLookupTick] = useState(0);

  // Zone long→short map + picker list, loaded once (the ZoneEnter event gives
  // the long name; refdbZoneInfo wants the short one). No new Tauri command.
  useEffect(() => {
    if (IS_MOCK) return;
    void dropsZones().then((zs) => {
      const map = new Map<string, string>();
      for (const z of zs) map.set(z.longName.toLowerCase(), z.shortName);
      zoneMap.current = map;
      setZones(
        [...zs].sort((a, b) => a.longName.localeCompare(b.longName)),
      );
    });
  }, []);

  /** Point the "this zone" section at a zone and load its rares. Shared by the
   *  ZoneEnter auto-detection and the manual zone picker. */
  const loadZoneRares = useCallback(
    (short: string | null, long: string | null) => {
      setZoneShort(short);
      setZoneLong(long);
      if (short) {
        void refdbZoneInfo(short).then((info) => setZoneRares(info.namedMobs));
      } else {
        setZoneRares([]);
      }
    },
    [],
  );

  // Mock only: the real app loads zone rares off the ZoneEnter line; in the
  // browser mock there is no log, so load the seeded starting zone on mount.
  useEffect(() => {
    if (IS_MOCK && zoneShort) loadZoneRares(zoneShort, zoneLong);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Add or reset a timer. Respawn timers dedupe by label (a re-kill resets the
   *  countdown); custom timers are always distinct. */
  const upsertTimer = useCallback(
    (t: Timer) => {
      // A re-armed timer reuses its id; clear the pop-announce guard so it can
      // announce again when it next expires.
      announced.current.delete(t.id);
      setTimers((prev) => {
        const next =
          t.kind === "respawn"
            ? [
                t,
                ...prev.filter(
                  (x) =>
                    !(
                      x.kind === "respawn" &&
                      x.label.toLowerCase() === t.label.toLowerCase()
                    ),
                ),
              ]
            : [t, ...prev];
        const capped = next.slice(0, TIMER_CAP);
        saveTimers(capped);
        return capped;
      });
    },
    [],
  );

  const startRespawnTimer = useCallback(
    (
      name: string,
      info: RespawnInfo | null,
      source: "auto" | "manual",
    ) => {
      if (!info || info.respawnSecs <= 0) return;
      const rare = isRare(name, info.named, learned.current);
      // Auto (kill-detected) timers honor the rares-only preference; manual
      // Track/Arm always create a timer regardless.
      if (source === "auto") {
        if (loadCampRaresOnly()) {
          if (!rare) return;
        } else if (!rare && info.respawnSecs < 300) {
          return;
        }
      }
      upsertTimer({
        id: `r_${name.toLowerCase()}`,
        kind: "respawn",
        label: info.name || name,
        zoneShort,
        zoneLong: info.zoneLong ?? zoneLong,
        startedAt: Date.now(),
        durationSecs: info.respawnSecs,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: false,
        announced: false,
        source,
      });
    },
    [upsertTimer, zoneShort, zoneLong],
  );

  /** Look up a mob's respawn once, cache it, then run `then`. */
  const withRespawn = useCallback(
    (name: string, then: (info: RespawnInfo | null) => void) => {
      const key = name.toLowerCase();
      if (respawnCache.current.has(key)) {
        then(respawnCache.current.get(key) ?? null);
        return;
      }
      if (respawnPending.current.has(key)) return;
      respawnPending.current.add(key);
      void refdbRespawnFor(name).then((info) => {
        respawnPending.current.delete(key);
        respawnCache.current.set(key, info);
        setLookupTick((n) => n + 1);
        then(info);
      });
    },
    [],
  );

  // --- Live log events ------------------------------------------------------

  useTauriEvent<CatchUpPayload>("catch-up", (p) => {
    catchingUp.current = p.active;
  });

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    const ev = p.event;
    if (typeof ev !== "object" || ev === null) return;

    if ("Consider" in ev) {
      const d = ev.Consider as Record<string, unknown>;
      if (d.rare === true) {
        const target = String(d.target ?? "").trim();
        if (target && addLearnedRare(target)) {
          learned.current = loadLearnedRares();
          setLearnedTick((n) => n + 1);
          // Surface a freshly-learned rare in "This zone's rares" right away
          // (we're standing in the zone we conned it in).
          withRespawn(target, (info) => {
            const secs = info?.respawnSecs ?? 0;
            const lvl =
              typeof d.level === "number" ? (d.level as number) : info ? 0 : 0;
            setZoneRares((prev) =>
              prev.some((m) => m.name.toLowerCase() === target.toLowerCase())
                ? prev
                : [
                    ...prev,
                    { id: -1, name: target, level: lvl, respawnSecs: secs },
                  ],
            );
          });
        }
      }
      return;
    }

    if ("ZoneEnter" in ev) {
      const d = ev.ZoneEnter as Record<string, unknown>;
      const long = String(d.zone ?? "").trim();
      if (!long) return;
      const short = zoneMap.current?.get(long.toLowerCase()) ?? null;
      // Keep the log's long name even when it isn't in the reference DB, so
      // the header still reflects where you are.
      loadZoneRares(short, long);
      return;
    }

    if ("Slain" in ev) {
      const d = ev.Slain as Record<string, unknown>;
      const victim = entityName(d.victim);
      if (
        victim === "You" ||
        victim === "?" ||
        looksLikePlayer(victim) ||
        catchingUp.current
      ) {
        return;
      }
      // Only NPC victims carry the Named entity shape.
      if (typeof d.victim !== "object" || d.victim === null || !("Named" in d.victim)) {
        return;
      }
      setRecentKills((prev) =>
        [{ id: killSeq.current++, name: victim, atMs: Date.now() }, ...prev].slice(
          0,
          12,
        ),
      );
      withRespawn(victim, (info) => startRespawnTimer(victim, info, "auto"));
      return;
    }
  });

  // --- Pop announcement (visual for respawns, TTS for custom) ---------------
  // Lives here (always-mounted tab), never in the overlay window which may be
  // hidden. Fires once per timer at pop; persists `announced` so a reload
  // never repeats it.
  useEffect(() => {
    if (IS_MOCK) return;
    const check = () => {
      const now = Date.now();
      const poppedIds = new Set<string>();
      for (const t of timers) {
        const dueAt = t.startedAt + t.durationSecs * 1000;
        if (t.announced || now < dueAt) continue;
        if (announced.current.has(t.id)) continue;
        announced.current.add(t.id);
        if (t.kind === "custom" && t.ttsOnPop) {
          void speakText(`${t.label}`);
        } else {
          void announceCampRespawn(t.label);
        }
        poppedIds.add(t.id);
      }
      if (poppedIds.size > 0) {
        setTimers((prev) => {
          const now2 = Date.now();
          const next = prev.map((t) => {
            if (!poppedIds.has(t.id)) return t;
            if (t.kind === "custom" && t.repeat) {
              // Re-arm a repeating timer from its pop instant (P7), skipping
              // any cycles missed while the app was closed so it doesn't
              // machine-gun on reopen. Clearing the announce guard lets the
              // next cycle speak again.
              let started = t.startedAt + t.durationSecs * 1000;
              while (started + t.durationSecs * 1000 <= now2) {
                started += t.durationSecs * 1000;
              }
              announced.current.delete(t.id);
              return { ...t, startedAt: started, announced: false };
            }
            // One-shot: mark announced so it reads "UP" and never re-speaks.
            return { ...t, announced: true };
          });
          saveTimers(next);
          return next;
        });
      }
    };
    check();
    const h = window.setInterval(check, 1000);
    return () => window.clearInterval(h);
  }, [timers]);

  // --- Actions --------------------------------------------------------------

  /** Manually start (or restart) a respawn timer for a killed mob, anchored to
   *  the actual kill time. Unlike auto-detection this always creates a timer,
   *  even for mobs the reference DB doesn't know (Legends placeholders): it
   *  falls back to the zone's typical respawn, since spawn points in a zone
   *  share a respawn cadence. */
  const trackKill = useCallback(
    (name: string, atMs: number) => {
      withRespawn(name, (info) => {
        const secs =
          info && info.respawnSecs > 0
            ? info.respawnSecs
            : zoneDefaultRef.current || DEFAULT_RESPAWN_SECS;
        upsertTimer({
          id: `r_${name.toLowerCase()}`,
          kind: "respawn",
          label: info?.name || name,
          zoneShort,
          zoneLong: info?.zoneLong ?? zoneLong,
          startedAt: atMs,
          durationSecs: secs,
          varianceSecs: 0,
          repeat: false,
          ttsOnPop: false,
          announced: false,
          source: "manual",
        });
      });
    },
    [withRespawn, upsertTimer, zoneShort, zoneLong],
  );

  const armRare = useCallback(
    (mob: ZoneNamedMob) => {
      const secs =
        mob.respawnSecs > 0
          ? mob.respawnSecs
          : zoneDefaultRef.current || DEFAULT_RESPAWN_SECS;
      upsertTimer({
        id: `r_${mob.name.toLowerCase()}`,
        kind: "respawn",
        label: mob.name,
        zoneShort,
        zoneLong,
        startedAt: Date.now(),
        durationSecs: secs,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: false,
        announced: false,
        source: "manual",
      });
    },
    [upsertTimer, zoneShort, zoneLong],
  );

  const addCustom = useCallback(() => {
    const secs = parseDuration(durInput);
    if (secs == null || secs <= 0) {
      setAddError("Enter 30m, 6:40, 1:02:00, or seconds.");
      return;
    }
    setAddError(null);
    upsertTimer({
      id: `c_${Date.now().toString(36)}`,
      kind: "custom",
      label: label.trim() || "Timer",
      zoneShort: null,
      zoneLong: null,
      startedAt: Date.now(),
      durationSecs: secs,
      varianceSecs: 0,
      repeat,
      ttsOnPop: tts,
      announced: false,
      source: "manual",
    });
    setLabel("");
  }, [durInput, label, repeat, tts, upsertTimer]);

  const dismiss = useCallback((id: string) => {
    setTimers((prev) => {
      const t = prev.find((x) => x.id === id);
      // A dismissed repeating custom timer re-arms from now instead of leaving.
      if (t && t.kind === "custom" && t.repeat && !t.announced) {
        const next = prev.map((x) =>
          x.id === id ? { ...x, startedAt: Date.now(), announced: false } : x,
        );
        saveTimers(next);
        return next;
      }
      const next = prev.filter((x) => x.id !== id);
      saveTimers(next);
      return next;
    });
    announced.current.delete(id);
  }, []);

  /** Re-anchor a timer's countdown to now — for when the mob actually pops (or
   *  you re-kill it and the log missed the "slain" line), so the clock stays
   *  honest without waiting for auto-detection. */
  const resetTimer = useCallback((id: string) => {
    setTimers((prev) => {
      const next = prev.map((x) =>
        x.id === id ? { ...x, startedAt: Date.now(), announced: false } : x,
      );
      saveTimers(next);
      return next;
    });
    announced.current.delete(id);
  }, []);

  // --- Derived --------------------------------------------------------------

  const nowMs = useNowMs(1000);
  const active = useMemo(
    () => activeTimers(timers, nowMs),
    [timers, nowMs],
  );
  // Backend trigger-engine timers (recasts, buffs, DoTs, CC) — live-ticking,
  // read-only. Folded into the Active list below so this window shows EVERY
  // running timer, not just the respawn/custom ones it owns.
  const barTimers = useTimers();
  const respawns = useMemo(
    () => active.filter((t) => t.kind === "respawn"),
    [active],
  );
  const customs = useMemo(
    () => active.filter((t) => t.kind === "custom"),
    [active],
  );
  const totalActive = active.length + barTimers.length;

  const trackedLabels = useMemo(
    () =>
      new Set(
        timers
          .filter((t) => t.kind === "respawn")
          .map((t) => t.label.toLowerCase()),
      ),
    [timers],
  );

  // Zone's typical respawn = the most common respawn among its rares (spawn
  // points in a zone share a cadence). Fallback for placeholders with no DB
  // respawn data. Mirrored into a ref for the async Arm/Track callbacks.
  const zoneDefault = useMemo(() => {
    const counts = new Map<number, number>();
    for (const m of zoneRares) {
      if (m.respawnSecs > 0)
        counts.set(m.respawnSecs, (counts.get(m.respawnSecs) ?? 0) + 1);
    }
    let best = 0;
    let bestN = 0;
    for (const [secs, n] of counts) {
      if (n > bestN) {
        best = secs;
        bestN = n;
      }
    }
    return best;
  }, [zoneRares]);
  useEffect(() => {
    zoneDefaultRef.current = zoneDefault;
  }, [zoneDefault]);
  const fallbackRespawn = zoneDefault || DEFAULT_RESPAWN_SECS;

  void learnedTick; // isRare reads learned.current; this state just forces render

  return (
    <div className="tmr-page">
      {/* ACTIVE */}
      <div className="card">
        <div className="card-head">
          <span className="section-title">Active</span>
          <span className="tmr-legend">
            <span><i className="tmr-dot s-warn" /> Soon</span>
            <span><i className="tmr-dot s-urgent" /> Imminent</span>
            <span><i className="tmr-dot s-up" /> Up</span>
          </span>
        </div>
        {totalActive === 0 ? (
          <div className="empty">
            <div className="empty-title">No active timers</div>
            <div className="empty-body">
              Recast, buff, and DoT timers from your triggers show up here the
              moment they fire. Kill a rare to start a respawn countdown, or add
              a custom timer below.
            </div>
          </div>
        ) : (
          <div className="tmr-groups">
            {BAR_CATEGORIES.map((cat) => {
              const rows = barTimers.filter(
                (b) => (b.lane ?? "other") === cat.lane,
              );
              if (rows.length === 0) return null;
              return (
                <div className="tmr-group" key={cat.lane}>
                  <div className="tmr-group-head">
                    <i className={`tmr-dot ${cat.dot}`} />
                    <span>{cat.title}</span>
                    <span className="tmr-count num">{rows.length}</span>
                  </div>
                  <div className="tmr-list">
                    {rows.map((b) => (
                      <BarRow key={`bar:${b.name}`} t={b} />
                    ))}
                  </div>
                </div>
              );
            })}
            {respawns.length > 0 && (
              <div className="tmr-group">
                <div className="tmr-group-head">
                  <i className="tmr-dot k-respawn" />
                  <span>Respawns</span>
                  <span className="tmr-count num">{respawns.length}</span>
                </div>
                <div className="tmr-list">
                  {respawns.map((t) => (
                    <ActiveRow
                      key={t.id}
                      t={t}
                      inZone={t.zoneShort === zoneShort}
                      onReset={() => resetTimer(t.id)}
                      onDismiss={() => dismiss(t.id)}
                    />
                  ))}
                </div>
              </div>
            )}
            {customs.length > 0 && (
              <div className="tmr-group">
                <div className="tmr-group-head">
                  <i className="tmr-dot k-custom" />
                  <span>Custom</span>
                  <span className="tmr-count num">{customs.length}</span>
                </div>
                <div className="tmr-list">
                  {customs.map((t) => (
                    <ActiveRow
                      key={t.id}
                      t={t}
                      inZone={false}
                      onReset={() => resetTimer(t.id)}
                      onDismiss={() => dismiss(t.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="tmr-cols">
        {/* THIS ZONE'S RARES */}
        <div className="card">
          <div className="card-head">
            <span className="section-title">
              This zone · rares
              {zoneRares.length > 0 && (
                <span className="tmr-count num"> {zoneRares.length}</span>
              )}
            </span>
            <div className="tmr-zone-pick">
              <SearchSelect
                value={zoneShort ?? ""}
                anyLabel="Set zone…"
                options={zones.map((z) => ({
                  value: z.shortName,
                  label: z.longName,
                }))}
                onChange={(v) => {
                  const z = zones.find((x) => x.shortName === v);
                  loadZoneRares(v || null, z?.longName ?? null);
                }}
              />
            </div>
          </div>
          {zoneRares.length === 0 ? (
            <div className="empty">
              <div className="empty-title">
                {zoneShort ? "No known rares here" : "Pick your zone"}
              </div>
              <div className="empty-body">
                {zoneShort
                  ? "Rares for this zone are listed here. Con one (“a rare creature”) and it appears the moment you see it."
                  : "Set your zone above (or just zone in) to list its rares, respawn times, and an Arm button."}
              </div>
            </div>
          ) : (
            <div className="tmr-rows">
              {zoneRares
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((m) => {
                  const tracking = trackedLabels.has(m.name.toLowerCase());
                  const lowArticle = /^(an?|the)\s/i.test(m.name);
                  return (
                    <div className="tmr-row" key={`${m.id}_${m.name}`}>
                      <div className="tmr-row-main">
                        <span className="tmr-row-name">{m.name}</span>
                        <span className="tmr-row-sub">
                          {m.level > 0 ? `Lvl ${m.level}` : "rare"}
                          {lowArticle && " · learned"}
                        </span>
                      </div>
                      <span className="tmr-row-val num">
                        {fmtLen(m.respawnSecs)}
                      </span>
                      <button
                        className="tmr-btn"
                        title={
                          tracking
                            ? "Killed it — restart the respawn countdown from now"
                            : "Arm this respawn countdown from now"
                        }
                        onClick={() => armRare(m)}
                      >
                        {tracking ? "Killed" : "Arm"}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* RECENT KILLS */}
        <div className="card">
          <div className="card-head">
            <span className="section-title">
              Recent kills
              {recentKills.length > 0 && (
                <span className="tmr-count num"> {recentKills.length}</span>
              )}
            </span>
            <span className="tmr-row-sub">tap Arm for placeholders</span>
          </div>
          {recentKills.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No kills yet</div>
              <div className="empty-body">
                NPC kills seen this session appear here. Tap Arm on the mob you
                are camping to start its respawn timer.
              </div>
            </div>
          ) : (
            <div className="tmr-rows">
              {recentKills.map((k) => {
                const info = respawnCache.current.get(k.name.toLowerCase());
                const rare = isRare(
                  k.name,
                  info?.named ?? 0,
                  learned.current,
                );
                const tracking = trackedLabels.has(k.name.toLowerCase());
                // Prefer the mob's own DB respawn; otherwise fall back to the
                // zone's typical respawn (spawn points share a cadence). An
                // estimate is flagged with a leading "~".
                const known = info != null && info.respawnSecs > 0;
                const secs = known ? info!.respawnSecs : fallbackRespawn;
                return (
                  <div className="tmr-row" key={k.id}>
                    <div className="tmr-row-main">
                      <span className="tmr-row-name">{k.name}</span>
                      <span className="tmr-row-sub">
                        {fmtAgo(nowMs - k.atMs)}
                        {rare && " · rare"}
                        {tracking && " · tracking"}
                      </span>
                    </div>
                    <span className="tmr-row-val num">
                      {known ? "" : "~"}
                      {fmtLen(secs)}
                    </span>
                    <button
                      className={`tmr-btn${tracking ? "" : " primary"}`}
                      title={
                        known
                          ? "Arm the respawn countdown from this kill"
                          : "Not in the mob DB — timer uses the zone's typical respawn"
                      }
                      onClick={() => trackKill(k.name, k.atMs)}
                    >
                      {tracking ? "Re-arm" : "Arm"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* CUSTOM QUICK-ADD */}
      <div className="card">
        <div className="card-head">
          <span className="section-title">New custom timer</span>
          <span className="tmr-row-sub">bio break, cooldowns, reminders</span>
        </div>
        <div className="tmr-add">
          <div className="tmr-add-row">
            <input
              className="tmr-fld num"
              style={{ width: 92 }}
              value={durInput}
              onChange={(e) => setDurInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              aria-label="Duration"
            />
            <input
              className="tmr-fld"
              style={{ flex: 1, minWidth: 140 }}
              value={label}
              placeholder="Label (optional)"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              aria-label="Label"
            />
            <button
              className={`tmr-toggle${repeat ? " on" : ""}`}
              onClick={() => setRepeat((v) => !v)}
            >
              <span className="tmr-sw" />
              Repeat
            </button>
            <button
              className={`tmr-toggle${tts ? " on" : ""}`}
              onClick={() => setTts((v) => !v)}
            >
              <span className="tmr-sw" />
              Speak at pop
            </button>
            <button className="tmr-btn primary" onClick={addCustom}>
              Start
            </button>
          </div>
          <div className="tmr-add-hint">
            {addError ? (
              <span className="tmr-add-err">{addError}</span>
            ) : (
              <>
                Accepts <b>30m</b>, <b>6:40</b>, <b>1:02:00</b>, or bare seconds.
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One active-timer row with a draining bar and color-state. */
function ActiveRow({
  t,
  inZone,
  onReset,
  onDismiss,
}: {
  t: TimerView;
  inZone: boolean;
  onReset: () => void;
  onDismiss: () => void;
}) {
  const width = t.state === "up" ? 100 : (t.progress * 100).toFixed(2);
  const warnGlyph = t.state === "warn" || t.state === "urgent";
  // A respawn countdown starts at the KILL and ends at the pop, so the
  // re-anchor action is "I just killed it", not a vague "reset".
  const isRespawn = t.kind === "respawn";
  const resetLabel = isRespawn ? "Killed" : "Restart";
  const resetTitle = isRespawn
    ? "Killed it — restart the respawn countdown to the next pop"
    : "Restart this timer from now";
  return (
    <div className={`tmr-t s-${t.state} k-${t.kind}`}>
      <div className="tmr-t-fill" style={{ width: `${width}%` }} />
      <div className="tmr-t-main">
        <span className={`tmr-t-kind k-${t.kind}`} />
        <span className="tmr-t-name">{t.label}</span>
        <span className="tmr-t-meta">
          {t.kind === "respawn"
            ? inZone
              ? "this zone"
              : t.zoneLong ?? "respawn"
            : t.repeat
              ? "repeats"
              : "custom"}
        </span>
        <span className="tmr-t-grow" />
        {t.kind === "respawn" && t.source === "auto" && (
          <span className="tmr-badge">rare</span>
        )}
        {t.kind === "custom" && t.repeat && (
          <span className="tmr-badge repeat">&#8635; repeat</span>
        )}
        <span className="tmr-t-time num">
          {warnGlyph && <span className="tmr-warn">&#9888;</span>}
          {fmtCountdown(t.remainingSecs)}
        </span>
        <button className="tmr-reset" title={resetTitle} onClick={onReset}>
          {resetLabel}
        </button>
        <button className="tmr-x" title="Dismiss" onClick={onDismiss}>
          &#10005;
        </button>
      </div>
    </div>
  );
}
