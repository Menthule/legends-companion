import { useEffect, useMemo, useState } from "react";
import { listFights, pasteParse } from "../api";
import { fmtDuration, fmtNum, useTauriEvent, useTimers } from "../hooks";
import type {
  CastRow,
  FightRecord,
  FightUpdatePayload,
  LogLinePayload,
  MeterRow,
} from "../types";
import Empty from "./Empty";
import MeterTable, { type MeterMode, StatTile } from "./MeterTable";
import TimerBars from "./TimerBars";

// ---------------------------------------------------------------------------
// Damage by skill: your per-source damage (melee verbs, spells, damage
// shields) pivoted into a skill table — this fight, or aggregated across
// recent stored fights. Data is the same per-source breakdown the damage
// table shows under the expand chevron; this view makes it first-class.
// ---------------------------------------------------------------------------

type SkillScope = "fight" | "recent";

/** How many stored fights the "Recent fights" scope aggregates. */
const RECENT_FIGHTS = 25;

interface SkillAgg {
  name: string;
  total: number;
  hits: number;
  crits: number;
  maxHit: number;
  misses: number;
  casts: number;
}

function isPetSourceName(name: string) {
  return /\s+\(pet\)$/i.test(name);
}

function stripPetSuffix(name: string) {
  return name.replace(/\s+\(pet\)$/i, "");
}

function petDamageOf(row: MeterRow) {
  const rawPetDamage =
    typeof row.petDamage === "number"
      ? row.petDamage
      : typeof (row as MeterRow & { pet_damage?: unknown }).pet_damage ===
          "number"
        ? (row as MeterRow & { pet_damage: number }).pet_damage
        : 0;
  if (rawPetDamage > 0) return Math.min(row.total, rawPetDamage);
  return Math.min(
    row.total,
    (row.sources ?? [])
      .filter((s) => isPetSourceName(s.name))
      .reduce((sum, s) => sum + s.total, 0),
  );
}

function splitDamageRows(
  rows: MeterRow[],
  durationSecs: number,
  totalDamage: number,
): MeterRow[] {
  const duration = Math.max(1, durationSecs);
  const split: MeterRow[] = [];
  for (const row of rows) {
    const petDamage = petDamageOf(row);
    if (petDamage <= 0) {
      split.push(row);
      continue;
    }

    const petSources = (row.sources ?? []).filter((s) =>
      isPetSourceName(s.name),
    );
    const playerSources = (row.sources ?? []).filter(
      (s) => !isPetSourceName(s.name),
    );
    const playerDamage = Math.max(0, row.total - petDamage);
    if (playerDamage > 0 || playerSources.length > 0) {
      split.push({
        ...row,
        total: playerDamage,
        petDamage: 0,
        pet: false,
        dps: playerDamage / duration,
        pct: totalDamage > 0 ? (playerDamage / totalDamage) * 100 : 0,
        sources: playerSources,
      });
    }
    split.push({
      ...row,
      name: `${row.name} pet`,
      total: petDamage,
      petDamage: 0,
      pet: false,
      dps: petDamage / duration,
      pct: totalDamage > 0 ? (petDamage / totalDamage) * 100 : 0,
      sources:
        petSources.length > 0
          ? petSources.map((s) => ({ ...s, name: stripPetSuffix(s.name) }))
          : [
              {
                name: "pet damage",
                total: petDamage,
                hits: 0,
                crits: 0,
                maxHit: 0,
                misses: 0,
                casts: 0,
              },
            ],
    });
  }
  return split.sort((a, b) => b.total - a.total);
}

function addSources(acc: Map<string, SkillAgg>, row: MeterRow | undefined) {
  let petSourceTotal = 0;
  for (const s of row?.sources ?? []) {
    const isPet = isPetSourceName(s.name);
    const name = isPet ? `Pet: ${stripPetSuffix(s.name)}` : s.name;
    if (isPet) petSourceTotal += s.total;
    const a = acc.get(name) ?? {
      name,
      total: 0,
      hits: 0,
      crits: 0,
      maxHit: 0,
      misses: 0,
      casts: 0,
    };
    a.total += s.total;
    a.hits += s.hits ?? 0;
    a.crits += s.crits ?? 0;
    a.maxHit = Math.max(a.maxHit, s.maxHit ?? 0);
    a.misses += s.misses ?? 0;
    a.casts += s.casts ?? 0;
    acc.set(name, a);
  }
  const missingPetDamage = Math.max(0, row ? petDamageOf(row) - petSourceTotal : 0);
  if (missingPetDamage > 0) {
    const name = "Pet: damage";
    const a = acc.get(name) ?? {
      name,
      total: 0,
      hits: 0,
      crits: 0,
      maxHit: 0,
      misses: 0,
      casts: 0,
    };
    a.total += missingPetDamage;
    acc.set(name, a);
  }
}

export default function MetersTab({ character }: { character: string }) {
  const [fight, setFight] = useState<FightUpdatePayload | null>(null);
  const [deaths, setDeaths] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"combat" | "casts">("combat");
  const [casts, setCasts] = useState<CastRow[]>([]);

  useTauriEvent<FightUpdatePayload>("fight-update", setFight);
  useTauriEvent<CastRow[]>("cast-update", setCasts);
  useTauriEvent<LogLinePayload>("log-line", (p) => {
    if (/^You died\.|^You have been slain/.test(p.message)) {
      setDeaths((d) => d + 1);
    }
  });

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(h);
  }, [toast]);

  const timers = useTimers();
  // Lane split (overlay-lanes spec): "buff" + "other" stack under Buffs so
  // recast/user timers aren't orphaned; "enemy" lands under On enemies.
  // Unlike the in-game overlays, this dashboard list shows every buff — the
  // show threshold only declutters the overlays.
  const buffTimers = timers.filter((t) => t.lane !== "enemy");
  const enemyTimers = timers.filter((t) => t.lane === "enemy");
  const rows = fight?.rows ?? [];
  const you = rows.find(
    (r) => r.name.toLowerCase() === character.toLowerCase(),
  );
  const damageRows = useMemo(
    () => splitDamageRows(rows, fight?.durationSecs ?? 0, fight?.totalDamage ?? 0),
    [rows, fight?.durationSecs, fight?.totalDamage],
  );

  // ---- meter mode (X2): damage / healing / damage-taken ----
  const [meterMode, setMeterMode] = useState<MeterMode>("damage");
  // The backend now emits healer-only and tank-only rows too; filter and
  // re-sort per mode so each mode ranks by its own metric (damage stays the
  // backend's damage-descending order).
  const meterRows = useMemo(() => {
    if (meterMode === "healing") {
      return rows
        .filter((r) => (r.healing ?? 0) > 0)
        .sort((a, b) => (b.healing ?? 0) - (a.healing ?? 0));
    }
    if (meterMode === "taken") {
      return rows
        .filter((r) => (r.damageTaken ?? 0) > 0)
        .sort((a, b) => (b.damageTaken ?? 0) - (a.damageTaken ?? 0));
    }
    return damageRows.filter((r) => r.total > 0);
  }, [rows, damageRows, meterMode]);
  const modeLabel =
    meterMode === "healing"
      ? "Healing"
      : meterMode === "taken"
        ? "Damage taken"
        : "Damage";

  // ---- damage by skill ----
  const [skillScope, setSkillScope] = useState<SkillScope>("fight");
  const [history, setHistory] = useState<FightRecord[] | null>(null);

  // (Re)load stored fights whenever the Recent scope is entered, and again
  // when the live fight ends (a fresh fight just landed in the store —
  // fightActive is a dependency purely to trigger that refresh).
  const fightActive = fight?.active === true;
  useEffect(() => {
    if (skillScope !== "recent") return;
    let stale = false;
    listFights(RECENT_FIGHTS, 0)
      .then((p) => {
        if (!stale) setHistory(p.fights);
      })
      .catch(() => {
        if (!stale) setHistory([]);
      });
    return () => {
      stale = true;
    };
  }, [skillScope, fightActive]);

  const skills = useMemo(() => {
    const acc = new Map<string, SkillAgg>();
    let duration = 0;
    let fights = 0;
    if (skillScope === "fight") {
      if (fight && you) {
        addSources(acc, you);
        duration = fight.durationSecs;
        fights = 1;
      }
    } else {
      for (const f of history ?? []) {
        const mine = f.rows.find(
          (r) => r.name.toLowerCase() === character.toLowerCase(),
        );
        if (mine && (mine.sources?.length ?? 0) > 0) {
          addSources(acc, mine);
          duration += f.durationSecs;
          fights += 1;
        }
      }
    }
    const list = [...acc.values()].sort((a, b) => b.total - a.total);
    const grand = list.reduce((s, a) => s + a.total, 0);
    return { list, duration: Math.max(1, duration), grand, fights };
  }, [skillScope, fight, you, history, character]);

  const maxSkill = skills.list.reduce((m, s) => Math.max(m, s.total), 0);

  async function copyParse() {
    if (!fight) return;
    try {
      const text = await pasteParse(null, {
        character,
        target: fight.target,
        durationSecs: fight.durationSecs,
        // The payload now carries healer-/tank-only rows; a copied parse is a
        // damage parse, so keep only damage contributors.
        rows: fight.rows.filter((r) => r.total > 0),
      });
      await navigator.clipboard.writeText(text);
      setToast("Parse copied — paste it into chat");
    } catch {
      setToast("Could not copy to the clipboard");
    }
  }

  return (
    <>
      <div className="meters-view-row">
        <div className="seg meters-view" role="group" aria-label="Meters view">
          <button
            className={view === "combat" ? "active" : ""}
            onClick={() => setView("combat")}
          >
            Combat
          </button>
          <button
            className={view === "casts" ? "active" : ""}
            onClick={() => setView("casts")}
            title="Caster resist / fizzle / land% this session"
          >
            Casts
          </button>
        </div>
      </div>
      {view === "casts" ? (
        <CastsView
          casts={casts}
          character={character}
          view={view}
          onViewChange={setView}
        />
      ) : (
        <>
      <div className="stat-tiles">
        <StatTile
          value={fight ? fmtDuration(fight.durationSecs) : "—"}
          label="Fight duration"
        />
        <StatTile
          value={fight ? fmtNum(fight.totalDamage) : "—"}
          label="Total damage"
        />
        <StatTile value={you ? fmtNum(you.dps) : "—"} label="Your DPS" />
        <StatTile value={String(deaths)} label="Deaths" />
      </div>

      <div className="card meter-card">
        <div className="card-head">
          <span className="section-title">
            {fight ? `${modeLabel} — ${fight.target}` : modeLabel}
          </span>
          <span className="card-head-side">
            {fight && (
              <span className="hint">
                {fight.active ? "in combat" : "last fight"}
              </span>
            )}
            <div className="seg" role="group" aria-label="Meter mode">
              <button
                className={meterMode === "damage" ? "active" : ""}
                onClick={() => setMeterMode("damage")}
              >
                Damage
              </button>
              <button
                className={meterMode === "healing" ? "active" : ""}
                onClick={() => setMeterMode("healing")}
              >
                Healing
              </button>
              <button
                className={meterMode === "taken" ? "active" : ""}
                onClick={() => setMeterMode("taken")}
              >
                Taken
              </button>
            </div>
            {fight && rows.length > 0 && (
              <button
                className="ghost small"
                onClick={() => void copyParse()}
                title="Copy this fight's damage as chat-ready text (240-char lines)"
              >
                Copy parse
              </button>
            )}
          </span>
        </div>
        {meterRows.length === 0 ? (
          <Empty
            title={
              meterMode === "damage"
                ? "No combat yet"
                : meterMode === "healing"
                  ? "No healing yet"
                  : "No damage taken yet"
            }
            body={
              meterMode === "damage"
                ? "Damage bars appear here as soon as combat lines arrive from the log."
                : meterMode === "healing"
                  ? "Healing bars appear here once heals land during a fight."
                  : "Bars appear here as the fight's target lands hits on your group."
            }
          />
        ) : (
          <MeterTable rows={meterRows} mode={meterMode} />
        )}
        {meterMode !== "damage" && meterRows.length > 0 && (
          <div className="hint skills-note">
            Healing parsing is log-limited — self-heals and HoTs may be
            under-counted.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="section-title">Damage by skill</span>
          <span className="card-head-side">
            <span className="hint num">
              {skills.fights > 0 &&
                (skillScope === "fight"
                  ? `over ${fmtDuration(skills.duration)}`
                  : `${skills.fights} fight${skills.fights === 1 ? "" : "s"} · ${fmtDuration(skills.duration)}`)}
            </span>
            <div className="seg" role="group" aria-label="Skill scope">
              <button
                className={skillScope === "fight" ? "active" : ""}
                onClick={() => setSkillScope("fight")}
              >
                This fight
              </button>
              <button
                className={skillScope === "recent" ? "active" : ""}
                onClick={() => setSkillScope("recent")}
                title={`Aggregates your last ${RECENT_FIGHTS} stored fights`}
              >
                Recent fights
              </button>
            </div>
          </span>
        </div>
        {character.trim() === "" ? (
          <div className="hint">
            Set your character name in Settings to attribute skills.
          </div>
        ) : skillScope === "recent" && history === null ? (
          <div className="hint">Loading fight history…</div>
        ) : skills.list.length === 0 ? (
          <Empty
            title="No skill data yet"
            body={
              skillScope === "fight"
                ? "Your per-skill breakdown appears here once you deal damage in a fight."
                : "No stored fights carry a per-skill breakdown for your character yet."
            }
          />
        ) : (
          <div className="skills-table" role="table" aria-label="Damage by skill">
            <div className="skill-row skill-head" role="row">
              <span role="columnheader">Skill</span>
              <span role="columnheader">Total</span>
              <span role="columnheader">DPS</span>
              <span role="columnheader" title="Damage per hit (hover for per-cast)">
                Avg hit
              </span>
              <span role="columnheader">Max hit</span>
              <span role="columnheader">Crit %</span>
              <span role="columnheader" title="Landed hits ÷ swings (melee only)">
                Acc %
              </span>
              <span role="columnheader">Share</span>
            </div>
            {skills.list.map((s) => (
              <div className="skill-row" role="row" key={s.name}>
                <div className="skill-name-cell" role="cell">
                  <div
                    className="skill-fill"
                    style={{
                      width: `${maxSkill > 0 ? (s.total / maxSkill) * 100 : 0}%`,
                    }}
                  />
                  <span className="skill-name">{s.name}</span>
                </div>
                <span className="meter-val" role="cell">
                  {fmtNum(s.total)}
                </span>
                <span className="meter-val" role="cell">
                  {fmtNum(s.total / skills.duration)}
                </span>
                <span
                  className="meter-val"
                  role="cell"
                  title={
                    s.casts > 0
                      ? `${fmtNum(s.total / s.casts)} per cast · ${s.casts} cast${s.casts === 1 ? "" : "s"}`
                      : undefined
                  }
                >
                  {s.hits > 0 ? fmtNum(s.total / s.hits) : "—"}
                </span>
                <span className="meter-val" role="cell">
                  {s.maxHit > 0 ? fmtNum(s.maxHit) : "—"}
                </span>
                <span className="meter-val" role="cell">
                  {s.hits > 0 ? `${((s.crits / s.hits) * 100).toFixed(0)}%` : "—"}
                </span>
                <span className="meter-val" role="cell">
                  {s.hits + s.misses > 0
                    ? `${((s.hits / (s.hits + s.misses)) * 100).toFixed(0)}%`
                    : "—"}
                </span>
                <span className="meter-val" role="cell">
                  {skills.grand > 0
                    ? `${((s.total / skills.grand) * 100).toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            ))}
            <div className="hint skills-note">
              DPS is measured over the whole {skillScope === "fight" ? "fight" : "scope"} —
              burst skills read low; compare Avg hit and Share for efficiency.
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="section-title">Active timers</span>
        </div>
        {timers.length === 0 ? (
          <Empty
            title="No active timers"
            body="Trigger timers count down here — buff durations, recast windows, effects on enemies."
          />
        ) : (
          <div className="timer-sections">
            <div className="timer-section">
              <span className="timer-section-title">Buffs</span>
              {buffTimers.length > 0 ? (
                <TimerBars timers={buffTimers} />
              ) : (
                <span className="hint">No buff timers running.</span>
              )}
            </div>
            <div className="timer-section">
              <span className="timer-section-title">On enemies</span>
              {enemyTimers.length > 0 ? (
                <TimerBars timers={enemyTimers} />
              ) : (
                <span className="hint">Nothing ticking on enemies.</span>
              )}
            </div>
          </div>
        )}
      </div>
        </>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Casts view (P45): per-caster / per-spell resist, fizzle, and inferred land
// rate this session, from the backend `cast-update` stream. "Landed" is
// attempts minus observed failures — most successful casts have no land line.
// ---------------------------------------------------------------------------

function CastsView({
  casts,
  character,
  view,
  onViewChange,
}: {
  casts: CastRow[];
  character: string;
  view: "combat" | "casts";
  onViewChange: (view: "combat" | "casts") => void;
}) {
  const [mineOnly, setMineOnly] = useState(false);
  const rows = useMemo(() => {
    const c = character.trim();
    return mineOnly && c !== ""
      ? casts.filter((r) => r.caster === c)
      : casts;
  }, [casts, mineOnly, character]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="section-title">Casting outcomes</span>
        <span className="card-head-side">
          <div className="seg" role="group" aria-label="Meters view">
            <button
              className={view === "combat" ? "active" : ""}
              onClick={() => onViewChange("combat")}
            >
              Combat
            </button>
            <button
              className={view === "casts" ? "active" : ""}
              onClick={() => onViewChange("casts")}
            >
              Casts
            </button>
          </div>
          <span className="hint">this session</span>
          <label className="hint check">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            My casts only
          </label>
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty
          title="No casts yet"
          body="Fizzles, resists, and land rate appear here as you and nearby casters cast spells. Land% is inferred (attempts minus fizzles, resists, and interrupts)."
        />
      ) : (
        <div className="cast-table" role="table" aria-label="Casting outcomes">
          <div className="cast-row cast-head" role="row">
            <span role="columnheader">Caster</span>
            <span role="columnheader">Spell</span>
            <span role="columnheader" title="Cast attempts">
              Casts
            </span>
            <span role="columnheader" title="Attempts not observed to fail">
              Land %
            </span>
            <span role="columnheader">Fizzle %</span>
            <span role="columnheader">Resist %</span>
          </div>
          {rows.map((r) => (
            <div className="cast-row" role="row" key={`${r.caster}:${r.spell}`}>
              <span className="cast-caster" role="cell">
                {r.caster}
              </span>
              <span className="cast-spell" role="cell">
                {r.spell}
              </span>
              <span className="meter-val" role="cell">
                {r.casts}
              </span>
              <span
                className={`meter-val cast-land${r.landPct < 75 ? " warn" : ""}`}
                role="cell"
                title={`${r.landed} landed of ${r.casts}`}
              >
                {r.landPct.toFixed(0)}%
              </span>
              <span className="meter-val" role="cell">
                {r.fizzles > 0 ? `${r.fizzlePct.toFixed(0)}%` : "—"}
              </span>
              <span className="meter-val" role="cell">
                {r.resists > 0 ? `${r.resistPct.toFixed(0)}%` : "—"}
              </span>
            </div>
          ))}
          <div className="hint skills-note">
            Land% is inferred — most spells have no explicit land line, so it's
            attempts minus fizzles, resists, and interrupts.
          </div>
        </div>
      )}
    </div>
  );
}
