// Session data panels — Rates / XP / Kills / Effects / Death recaps / Loot /
// Wishlist / Rolls. Moved out of FightsTab's session card into the Session
// (Coach) tab so each piece of session data has exactly one home. Data comes
// from lib/sessionLog, which accumulates for the whole app run regardless of
// which tab is mounted. Bodies render directly under a plain card head (the
// old per-tab Collapsible was double chrome inside a tab strip).

import { useEffect, useMemo, useState } from "react";
import { fmtClock, fmtDuration, fmtNum, useNowMs } from "../hooks";
import { openDrops } from "../lib/deepLinks";
import {
  loadMezBreakSpeak,
  saveMezBreakSpeak,
  subscribeMezBreakSpeak,
} from "../lib/mezBreaks";
import {
  dpsOf,
  loadScoreboard,
  scoreRows,
  subscribeScoreboard,
} from "../lib/scoreboard";
import {
  factionStore,
  mostDamaged,
  sortSessionRows,
  trendArrow,
} from "../lib/factionLedger";
import type { PaceState } from "../lib/pace";
import {
  type EffectEntry,
  respawnFor,
  resetXpSession,
  type RollEntry,
  type SessionLogSnapshot,
} from "../lib/sessionLog";
import {
  sessionsSinceUp,
  skillStore,
  STUCK_SESSIONS,
  stuckSkills,
} from "../lib/skillUps";
import {
  buildTrendSeries,
  fmtTrendValue,
  sparklineLayout,
  type TrendSessionInput,
} from "../lib/trends";
import {
  fmtCoins,
  fmtCopperAmount,
  WALLET_SOURCE_LABELS,
  walletPlatPerHour,
  type WalletSource,
} from "../lib/wallet";
import { toggleWishlist, type WishlistEntry } from "../lib/wishlist";
import { computeLevelEta, computeXpStats } from "../overlayState";
import { CareerPanel, LootLedgerPanel } from "./CareerPanels";
import Empty from "./Empty";
import { StatTile } from "./MeterTable";
import PaceRates from "./PaceRates";

export type SessionPanelId =
  | "rates"
  | "xp"
  | "wallet"
  | "kills"
  | "scoreboard"
  | "effects"
  | "deaths"
  | "loot"
  | "wishlist"
  | "rolls"
  | "factions"
  | "skills"
  | "trends"
  | "career"
  | "ledger";

export const SESSION_PANELS: { id: SessionPanelId; label: string }[] = [
  { id: "rates", label: "Rates" },
  { id: "xp", label: "XP" },
  { id: "wallet", label: "Wallet" },
  { id: "kills", label: "Kills" },
  { id: "scoreboard", label: "Scoreboard" },
  { id: "effects", label: "Effects" },
  { id: "deaths", label: "Death recaps" },
  { id: "loot", label: "Loot" },
  { id: "wishlist", label: "Wishlist" },
  { id: "rolls", label: "Rolls" },
  { id: "factions", label: "Factions" },
  { id: "skills", label: "Skills" },
  { id: "trends", label: "Trends" },
  { id: "career", label: "Career" },
  { id: "ledger", label: "Loot ledger" },
];

const KILL_ROW_CAP = 30;
const RECENT_ROLLS = 12;

function effectName(entry: Pick<EffectEntry, "spell">): string {
  return `Spell: ${entry.spell}`;
}

function effectAmountText(
  entry: Pick<EffectEntry, "amount" | "critical">,
): string {
  if (entry.amount == null) return entry.critical ? "crit" : "";
  return `${fmtNum(entry.amount)}${entry.critical ? " crit" : ""}`;
}

interface RollLeader {
  roller: string;
  best: number;
  count: number;
}

interface RollGroup {
  /** "min-max", the /random range these rolls share. */
  range: string;
  min: number;
  max: number;
  /** Per-roller best result, highest first. */
  leaders: RollLeader[];
  /** Roller with the top result (ties: first seen); null when empty. */
  winner: string | null;
  /** Newest roll timestamp in the group (for ordering groups). */
  lastTs: number;
  count: number;
}

/** Group rolls by their range and rank each roller's best result. */
function groupRolls(rolls: RollEntry[]): RollGroup[] {
  const byRange = new Map<string, RollEntry[]>();
  for (const r of rolls) {
    const key = `${r.min}-${r.max}`;
    const list = byRange.get(key);
    if (list) list.push(r);
    else byRange.set(key, [r]);
  }
  const groups: RollGroup[] = [];
  for (const [range, list] of byRange) {
    const best = new Map<string, RollLeader>();
    for (const r of list) {
      const cur = best.get(r.roller);
      if (!cur) best.set(r.roller, { roller: r.roller, best: r.result, count: 1 });
      else {
        cur.count += 1;
        if (r.result > cur.best) cur.best = r.result;
      }
    }
    const leaders = [...best.values()].sort((a, b) => b.best - a.best);
    groups.push({
      range,
      min: list[0].min,
      max: list[0].max,
      leaders,
      winner: leaders.length > 0 ? leaders[0].roller : null,
      lastTs: Math.max(...list.map((r) => r.ts)),
      count: list.length,
    });
  }
  // Most recently active range first.
  return groups.sort((a, b) => b.lastTs - a.lastTs);
}

export default function SessionPanel({
  tab,
  snap,
  wishlist,
  pace,
  onSetPace,
  character,
  history,
}: {
  tab: SessionPanelId;
  snap: SessionLogSnapshot;
  wishlist: WishlistEntry[];
  pace: PaceState;
  onSetPace: (next: PaceState) => void;
  /** Active character (keys the persisted faction/skill stores). */
  character: string;
  /** Persisted session-history rows for the Trends panel. */
  history: TrendSessionInput[];
}) {
  const { loot, rolls, effects, recaps, kills, xp, levelProgress, levelAnchorKnown } = snap;
  const [lootQuery, setLootQuery] = useState("");

  // Party Scoreboard mirror: sessionLog flushes the board to localStorage
  // (the overlay's channel) — subscribe to the same store here so the panel
  // and the overlay always agree.
  const [board, setBoard] = useState(() => loadScoreboard());
  useEffect(() => subscribeScoreboard(() => setBoard(loadScoreboard())), []);
  const [mezSpeak, setMezSpeak] = useState(() => loadMezBreakSpeak());
  useEffect(
    () => subscribeMezBreakSpeak(() => setMezSpeak(loadMezBreakSpeak())),
    [],
  );

  const shownLoot = useMemo(() => {
    const q = lootQuery.trim().toLowerCase();
    if (!q) return loot;
    return loot.filter(
      (l) =>
        l.item.toLowerCase().includes(q) ||
        l.who.toLowerCase().includes(q) ||
        (l.corpse ?? "").toLowerCase().includes(q),
    );
  }, [loot, lootQuery]);

  const groups = useMemo(() => groupRolls(rolls), [rolls]);
  const recentRolls = useMemo(() => rolls.slice(0, RECENT_ROLLS), [rolls]);
  const effectRows = useMemo(() => {
    const bySpell = new Map<
      string,
      {
        kind: EffectEntry["kind"];
        spell: string;
        count: number;
        damage: number;
        hasDamage: boolean;
        crits: number;
        lastTs: number;
      }
    >();
    for (const p of effects) {
      const key = `${p.kind}:${p.spell.toLowerCase()}`;
      const cur = bySpell.get(key);
      if (cur) {
        cur.count += 1;
        cur.damage += p.amount ?? 0;
        cur.hasDamage = cur.hasDamage || p.amount != null;
        cur.crits += p.critical ? 1 : 0;
        cur.lastTs = Math.max(cur.lastTs, p.ts);
      } else {
        bySpell.set(key, {
          kind: p.kind,
          spell: p.spell,
          count: 1,
          damage: p.amount ?? 0,
          hasDamage: p.amount != null,
          crits: p.critical ? 1 : 0,
          lastTs: p.ts,
        });
      }
    }
    return [...bySpell.values()]
      .sort((a, b) => b.count - a.count || b.damage - a.damage || b.lastTs - a.lastTs)
      .slice(0, 12);
  }, [effects]);
  // Live XP rate: the window extends to "now" (ticking every 15 s), so the
  // rate decays between kills instead of freezing at the last gain.
  const nowMs = useNowMs();
  const xpStats = useMemo(() => computeXpStats(xp, nowMs), [xp, nowMs]);
  const progressPct = levelAnchorKnown ? Math.min(100, Math.max(0, levelProgress)) : 0;
  // Kills/time to ding from the anchored position and the 10m rate window.
  const levelEta = useMemo(
    () =>
      computeLevelEta(
        { total: xpStats.total, count: xpStats.count, rows: [] },
        progressPct,
        xpStats.perHour,
      ),
    [xpStats.total, xpStats.count, xpStats.perHour, progressPct],
  );

  // Session kills, most-killed first (camp efficiency v1).
  const killRows = useMemo(
    () =>
      Object.values(kills)
        .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name))
        .slice(0, KILL_ROW_CAP),
    [kills],
  );

  // Faction ledger: session rows + the persisted all-time map. The store is
  // re-read whenever the session map moves (sessionLog writes both together).
  const factionRows = useMemo(() => sortSessionRows(snap.factions), [snap.factions]);
  const factionAllTime = useMemo(
    () => factionStore(character).load(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [character, snap.factions],
  );
  // Skill store mirrors: re-read on each session skill-up.
  const skillState = useMemo(
    () => skillStore(character).load(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [character, snap.skillUps],
  );
  const stuck = useMemo(() => stuckSkills(skillState), [skillState]);
  const trendSeries = useMemo(() => buildTrendSeries(history), [history]);

  // Career panels are durable DB-backed views (components/CareerPanels) —
  // they read the career store, not the app-run session log snapshot.
  if (tab === "career") return <CareerPanel />;
  if (tab === "ledger") return <LootLedgerPanel />;

  if (tab === "rates") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Rates</span>
        </div>
        <PaceRates pace={pace} onChange={onSetPace} />
      </section>
    );
  }

  if (tab === "xp") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">XP</span>
          {xp.rows.length > 0 && (
            <button className="ghost small" onClick={resetXpSession}>
              Reset
            </button>
          )}
        </div>
        {xp.rows.length === 0 ? (
          <Empty
            title="No XP yet"
            body="XP gains seen this session appear here with an hourly estimate."
          />
        ) : (
          <>
            <div className="stat-tiles compact">
              <StatTile value={`${xpStats.total.toFixed(2)}%`} label="XP gained 10m" />
              <StatTile
                value={xpStats.perHour === null ? "—" : `${xpStats.perHour.toFixed(2)}%`}
                label="XP/hour"
              />
              <StatTile
                value={
                  xpStats.perLevelHours === null
                    ? "—"
                    : fmtDuration(Math.round(xpStats.perLevelHours * 3600))
                }
                label="Per level"
              />
            </div>
            <div className="xp-tolevel">
              <div className="xp-tolevel-head">
                <span className="xp-tolevel-label">To level</span>
                <span className="xp-tolevel-vals num">
                  {!levelAnchorKnown || levelEta.kills === null
                    ? "—"
                    : `~${levelEta.kills} kill${levelEta.kills === 1 ? "" : "s"}`}
                  {levelAnchorKnown &&
                    levelEta.kills !== null &&
                    levelEta.mins !== null &&
                    ` · ~${fmtDuration(Math.round(levelEta.mins * 60))}`}
                </span>
              </div>
              <div
                className="xp-progress"
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress into current level"
              >
                <div
                  className="xp-progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="hint">
                {levelAnchorKnown
                  ? `${progressPct.toFixed(1)}% into level since the last ding seen by the app.`
                  : "No level ETA yet. It will start after the app sees your next ding."}
              </div>
            </div>
            <div className="session-loot">
              <div className="session-loot-row session-loot-head" aria-hidden="true">
                <span>Time</span>
                <span>XP</span>
                <span>Type</span>
              </div>
              {xp.rows.slice(0, 20).map((x) => (
                <div className="session-loot-row" key={x.id}>
                  <span className="session-time num">{fmtClock(x.ts)}</span>
                  <span className="num">{x.percent.toFixed(2)}%</span>
                  <span>{x.party ? "party" : "solo"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }

  if (tab === "wallet") {
    const wallet = snap.wallet;
    const platHr = walletPlatPerHour(wallet, nowMs);
    const sources = (
      Object.keys(WALLET_SOURCE_LABELS) as WalletSource[]
    ).filter((s) => (wallet.bySource[s] ?? 0) > 0);
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Wallet</span>
        </div>
        {wallet.count === 0 ? (
          <Empty
            title="No coin yet"
            body="Coin from corpses, vendor sales, item redemptions, and auto-sold loot totals here with a live plat/hour rate."
          />
        ) : (
          <>
            <div className="stat-tiles compact">
              <StatTile
                value={fmtCopperAmount(wallet.totalCopper)}
                label="Session income"
              />
              <StatTile
                value={platHr === null ? "—" : `${platHr.toFixed(2)}p`}
                label="Plat/hour"
              />
              <StatTile
                value={wallet.biggest ? fmtCoins(wallet.biggest.coins) : "—"}
                label={
                  wallet.biggest
                    ? `Biggest gain · ${WALLET_SOURCE_LABELS[wallet.biggest.source].toLowerCase()}`
                    : "Biggest gain"
                }
              />
            </div>
            {sources.length > 0 && (
              <div className="session-loot">
                <div
                  className="session-loot-row wishlist-row session-loot-head"
                  aria-hidden="true"
                >
                  <span>Source</span>
                  <span>Total</span>
                </div>
                {sources.map((s) => (
                  <div className="session-loot-row wishlist-row" key={s}>
                    <span className="session-item">{WALLET_SOURCE_LABELS[s]}</span>
                    <span className="num">{fmtCopperAmount(wallet.bySource[s] ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="session-loot">
              <div className="session-loot-row session-loot-head" aria-hidden="true">
                <span>Time</span>
                <span>Source</span>
                <span>Amount</span>
              </div>
              {wallet.gains.slice(0, 20).map((g) => (
                <div className="session-loot-row" key={g.id}>
                  <span className="session-time num">{fmtClock(g.ts)}</span>
                  <span className="session-item" title={g.note ?? undefined}>
                    {WALLET_SOURCE_LABELS[g.source]}
                    {g.note ? ` · ${g.note}` : ""}
                  </span>
                  <span className="num">{fmtCoins(g.coins)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }

  if (tab === "kills") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Kills</span>
        </div>
        {killRows.length === 0 ? (
          <Empty
            title="No kills yet"
            body="NPC kills seen this session tally here per mob, with a live kills/hour rate."
          />
        ) : (
          <div className="session-loot">
            <div className="kills-row session-loot-head" aria-hidden="true">
              <span>Mob</span>
              <span className="num">Kills</span>
              <span className="num">Kills/hr</span>
              <span className="num">Respawn</span>
            </div>
            {killRows.map((k) => {
              const elapsedMs = nowMs - k.firstAtMs;
              // Under a minute of data the rate is meaningless noise.
              const rate =
                elapsedMs >= 60_000 ? k.kills / (elapsedMs / 3_600_000) : null;
              const info = respawnFor(k.name);
              return (
                <div className="kills-row" key={k.name.toLowerCase()}>
                  <span className="session-item">{k.name}</span>
                  <span className="num">{k.kills}</span>
                  <span className="num">
                    {rate === null ? "—" : rate.toFixed(1)}
                  </span>
                  <span className="num">
                    {info && info.respawnSecs > 0
                      ? fmtDuration(info.respawnSecs)
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  if (tab === "scoreboard") {
    const players = scoreRows(board);
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Party Scoreboard</span>
        </div>
        {players.length === 0 ? (
          <Empty
            title="No scores yet"
            body="Per-player killing blows, finishing blows, mez breaks, and damage from this app run tally here (and on the Scoreboard overlay)."
          />
        ) : (
          <div className="session-loot">
            <div className="scorepanel-row session-loot-head" aria-hidden="true">
              <span>Player</span>
              <span className="num" title="Killing blows">KB</span>
              <span className="num" title="Finishing Blows (AA)">FB</span>
              <span
                className="num"
                title="CC breaks — heuristic: first hit after a mez break"
              >
                Mez
              </span>
              <span className="num" title="Biggest single hit">Hit</span>
              <span className="num" title="Damage per second (engagement span)">
                DPS
              </span>
              <span className="num" title="Deaths">Deaths</span>
            </div>
            {players.map((r) => (
              <div className="scorepanel-row" key={r.name.toLowerCase()}>
                <span className="session-item">{r.name}</span>
                <span className="num">{r.killingBlows}</span>
                <span className="num">{r.finishingBlows}</span>
                <span
                  className="num"
                  title="Heuristic: first hit after a mez break"
                >
                  {r.mezBreaks ?? 0}
                </span>
                <span className="num" title={r.highestHitLabel || undefined}>
                  {r.highestHit ? fmtNum(r.highestHit) : "—"}
                </span>
                <span className="num">{fmtNum(dpsOf(r))}</span>
                <span className="num">{r.deaths}</span>
              </div>
            ))}
          </div>
        )}
        <label className="scorepanel-speak">
          <input
            type="checkbox"
            checked={mezSpeak}
            onChange={(e) => saveMezBreakSpeak(e.target.checked)}
          />
          Speak mez breaks (&ldquo;Sliq broke mez on a gnoll&rdquo;)
        </label>
        <div className="hint">
          Mez breaks are a heuristic — the first player hit on a mezzed target
          (or right after its mez bar drops early) gets the credit. The spoken
          alert is off by default.
        </div>
      </section>
    );
  }

  if (tab === "effects") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Effects</span>
        </div>
        {effects.length === 0 ? (
          <Empty
            title="No effects yet"
            body="Parsed skill riders and direct spell hits from you appear here. Alerts and TTS are configured through triggers."
          />
        ) : (
          <>
            <div className="session-loot">
              <div className="kills-row session-loot-head" aria-hidden="true">
                <span>Effect</span>
                <span className="num">Hits</span>
                <span className="num">Damage</span>
                <span className="num">Last</span>
              </div>
              {effectRows.map((p) => (
                <div className="kills-row" key={`${p.kind}:${p.spell}`}>
                  <span className="session-item">{effectName(p)}</span>
                  <span className="num">
                    {p.count}
                    {p.crits > 0 ? ` / ${p.crits} crit` : ""}
                  </span>
                  <span className="num">{p.hasDamage ? fmtNum(p.damage) : "—"}</span>
                  <span className="num">{fmtClock(p.lastTs)}</span>
                </div>
              ))}
            </div>
            <div className="session-loot">
              <div className="session-loot-row session-loot-head" aria-hidden="true">
                <span>Time</span>
                <span>Effect</span>
                <span>Target</span>
              </div>
              {effects.slice(0, 20).map((p) => (
                <div className="session-loot-row" key={p.id}>
                  <span className="session-time num">{fmtClock(p.ts)}</span>
                  <span className="session-item">
                    {effectName(p)}{" "}
                    {effectAmountText(p) && (
                      <span className="session-qty num">{effectAmountText(p)}</span>
                    )}
                  </span>
                  <span className="session-who">{p.target}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }

  if (tab === "deaths") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Death recaps</span>
        </div>
        {recaps.length === 0 ? (
          <Empty
            title="No deaths yet"
            body="When you die, the last few combat lines are captured here for review."
          />
        ) : (
          <div className="death-recaps">
            {recaps.map((r) => (
              <div className="death-recap" key={r.id}>
                <div className="roll-group-head">
                  <span>
                    {fmtClock(r.ts)} · slain by {r.killer}
                  </span>
                  <span className="hint num">
                    {r.damage.totalTaken > 0
                      ? `${fmtNum(r.damage.totalTaken)} taken`
                      : `${r.lines.length} lines`}
                  </span>
                </div>
                {r.damage.bySource.length > 0 && (
                  <div className="death-damage">
                    {r.damage.bySource.slice(0, 5).map((s) => (
                      <div className="death-dmg-row" key={s.source}>
                        <span className="death-dmg-src">{s.source}</span>
                        <span className="death-dmg-bar-wrap">
                          <span
                            className="death-dmg-bar"
                            style={{
                              width: `${
                                r.damage.totalTaken > 0
                                  ? (s.amount / r.damage.totalTaken) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </span>
                        <span className="death-dmg-amt num">
                          {fmtNum(s.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="death-lines">
                  {r.lines.map((line, ix) => (
                    <div className="death-line" key={`${r.id}-${ix}`}>
                      <span className="session-time num">{fmtClock(line.ts)}</span>
                      <span className="chip chip-muted">{line.kind.toLowerCase()}</span>
                      <span>{line.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (tab === "loot") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Loot</span>
          <input
            type="search"
            className="session-search"
            placeholder="Filter items or looter…"
            value={lootQuery}
            onChange={(e) => setLootQuery(e.target.value)}
            aria-label="Filter loot"
          />
        </div>
        {loot.length === 0 ? (
          <Empty
            title="No loot yet"
            body="Items looted this session appear here, newest first. Loot something while tailing and it will show up."
          />
        ) : shownLoot.length === 0 ? (
          <Empty title="No matches" body="No looted item matches that filter." />
        ) : (
          <div className="session-loot">
            <div className="session-loot-row session-loot-head" aria-hidden="true">
              <span>Time</span>
              <span>Item</span>
              <span>Looter</span>
            </div>
            {shownLoot.map((l) => (
              <div className="session-loot-row" key={l.id}>
                <span className="session-time num">{fmtClock(l.ts)}</span>
                <span className="session-item">
                  {l.qty > 1 && <span className="session-qty num">{l.qty}×</span>}
                  <button
                    className="session-item-link"
                    title="Look up in the Drops database"
                    onClick={() => openDrops(l.item)}
                  >
                    {l.item}
                  </button>
                </span>
                <span className="session-who" title={l.corpse ?? undefined}>
                  {l.who}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (tab === "wishlist") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Wishlist</span>
        </div>
        {wishlist.length === 0 ? (
          <Empty
            title="Wishlist is empty"
            body="Star items in the Drops tab to build a wishlist — when one drops, you get a spoken alert here."
          />
        ) : (
          <>
            <div className="session-loot">
              {wishlist.map((w) => (
                <div
                  className="session-loot-row wishlist-row"
                  key={w.name.toLowerCase()}
                >
                  <span className="session-item">{w.name}</span>
                  <button
                    className="ghost small"
                    onClick={() => toggleWishlist(w.name)}
                    title="Remove from wishlist"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="hint">
              Star items in the Drops tab to add more.
            </div>
          </>
        )}
      </section>
    );
  }

  if (tab === "factions") {
    const worst = mostDamaged(factionRows);
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Factions</span>
        </div>
        {factionRows.length === 0 ? (
          <Empty
            title="No faction hits yet"
            body="Faction standing changes seen this session accumulate here, with an all-time net since tracking began."
          />
        ) : (
          <>
            {worst && (
              <div className="faction-callout">
                Most damaged this session: <strong>{worst.faction}</strong>{" "}
                <span className="num faction-down">{worst.net}</span>
              </div>
            )}
            <div className="session-loot">
              <div className="faction-row session-loot-head" aria-hidden="true">
                <span>Faction</span>
                <span className="num">Session</span>
                <span className="num">Since tracking began</span>
                <span className="num">Hits</span>
              </div>
              {factionRows.map((f) => {
                const all = factionAllTime[f.faction.toLowerCase()];
                return (
                  <div className="faction-row" key={f.faction.toLowerCase()}>
                    <span className="session-item">{f.faction}</span>
                    <span
                      className={`num ${
                        f.net > 0 ? "faction-up" : f.net < 0 ? "faction-down" : ""
                      }`}
                    >
                      {trendArrow(f.net)} {f.net > 0 ? `+${f.net}` : f.net}
                    </span>
                    <span className="num">
                      {all ? (all.net > 0 ? `+${all.net}` : all.net) : "—"}
                    </span>
                    <span className="num">{f.hits}</span>
                  </div>
                );
              })}
            </div>
            <div className="hint">
              The log carries only deltas, never your absolute standing — the
              all-time column counts from when this app started tracking this
              character.
            </div>
          </>
        )}
      </section>
    );
  }

  if (tab === "skills") {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Skills</span>
        </div>
        {snap.skillUps.length === 0 && stuck.length === 0 ? (
          <Empty
            title="No skill-ups yet"
            body="Skill increases seen this session appear here, along with skills that look stuck across sessions."
          />
        ) : (
          <>
            <div className="session-loot">
              <div className="faction-row session-loot-head" aria-hidden="true">
                <span>Skill</span>
                <span className="num">Now</span>
                <span className="num">Gained</span>
                <span className="num">Time</span>
              </div>
              {snap.skillUps.slice(0, 20).map((s) => (
                <div className="faction-row" key={s.id}>
                  <span className="session-item">{s.skill}</span>
                  <span className="num">{s.value}</span>
                  <span className="num">
                    {s.delta === null ? "—" : s.delta > 0 ? `+${s.delta}` : s.delta}
                  </span>
                  <span className="session-time num">{fmtClock(s.ts)}</span>
                </div>
              ))}
              {snap.skillUps.length === 0 && (
                <div className="hint">No skill-ups this session yet.</div>
              )}
            </div>
            {stuck.length > 0 && (
              <>
                <div className="card-head">
                  <span className="section-title">Possibly stuck</span>
                </div>
                <div className="session-loot">
                  {stuck.slice(0, 12).map((row) => (
                    <div
                      className="session-loot-row wishlist-row"
                      key={row.skill.toLowerCase()}
                    >
                      <span className="session-item">{row.skill}</span>
                      <span className="num">
                        {row.value} · no gain in {sessionsSinceUp(skillState, row)}{" "}
                        sessions
                      </span>
                    </div>
                  ))}
                </div>
                <div className="hint">
                  Heuristic: skills with no increase in your last{" "}
                  {STUCK_SESSIONS}+ play sessions that had any skill-up. The log
                  can't see caps, so a maxed skill also shows here.
                </div>
              </>
            )}
          </>
        )}
      </section>
    );
  }

  if (tab === "trends") {
    const chartable = trendSeries.some((s) => s.points.length >= 2);
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Trends</span>
          <span className="hint">Per-session rates, oldest → newest</span>
        </div>
        {!chartable ? (
          <Empty
            title="Not enough sessions yet"
            body="Finish at least two sessions (the New session button archives the current one) and per-session XP, kill, death, and plat rates chart here."
          />
        ) : (
          <div className="trend-grid">
            {trendSeries.map((series) => {
              const layout = sparklineLayout(
                series.points.map((p) => p.value),
                240,
                56,
                4,
              );
              const hasData = series.points.some((p) => p.value !== null);
              return (
                <div className="trend-chart" key={series.id}>
                  <div className="trend-head">
                    <span className="trend-label">{series.label}</span>
                    <span className="trend-latest num">
                      {series.latest === null
                        ? "—"
                        : `${fmtTrendValue(series.latest)}${series.unit}`}
                    </span>
                  </div>
                  {!hasData ? (
                    <div className="trend-nodata hint">
                      {series.id === "plat"
                        ? "Older sessions predate coin tracking."
                        : "No data yet."}
                    </div>
                  ) : (
                    <svg
                      className="trend-spark"
                      viewBox="0 0 240 56"
                      role="img"
                      aria-label={`${series.label} per hour across recent sessions`}
                    >
                      <line
                        className="trend-baseline"
                        x1="4"
                        y1="52"
                        x2="236"
                        y2="52"
                      />
                      {layout.path && (
                        <path className="trend-line" d={layout.path} />
                      )}
                      {layout.points.map((pt, i) => {
                        if (!pt) return null;
                        const point = series.points[i];
                        const ding = series.id === "xp" && point.levelUps > 0;
                        return (
                          <g key={point.id}>
                            <title>
                              {`${new Date(point.startedTs).toLocaleString()} — ${
                                point.value === null
                                  ? "—"
                                  : fmtTrendValue(point.value)
                              }${series.unit}${
                                ding
                                  ? ` · ${point.levelUps} level-up${point.levelUps === 1 ? "" : "s"}`
                                  : ""
                              }`}
                            </title>
                            <circle
                              className="trend-hit"
                              cx={pt.x}
                              cy={pt.y}
                              r="7"
                            />
                            <circle
                              className={ding ? "trend-ding" : "trend-dot"}
                              cx={pt.x}
                              cy={pt.y}
                              r={ding ? 3.5 : 2}
                            />
                          </g>
                        );
                      })}
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="hint">
          One point per archived session (sessions under a minute are skipped).
          Rings on the XP chart mark sessions with a level-up.
        </div>
      </section>
    );
  }

  // Rolls.
  return (
    <section className="card coach-span">
      <div className="card-head">
        <span className="section-title">Rolls</span>
      </div>
      {rolls.length === 0 ? (
        <Empty
          title="No rolls yet"
          body="/random rolls seen this session group by range here, with the top roll in each range marked."
        />
      ) : (
        <>
          {groups.map((g) => (
            <div className="roll-group" key={g.range}>
              <div className="roll-group-head">
                <span className="roll-range">{g.range}</span>
                <span className="hint num">
                  {g.count} roll{g.count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="roll-board">
                {g.leaders.map((ld) => (
                  <div
                    className={`roll-lead${
                      ld.roller === g.winner ? " roll-winner" : ""
                    }`}
                    key={ld.roller}
                  >
                    <span className="roll-lead-name">{ld.roller}</span>
                    <span className="roll-lead-best num">{ld.best}</span>
                    {ld.roller === g.winner && (
                      <span className="roll-win-tag">winner</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="roll-recent">
            <div className="roll-recent-head">Recent rolls</div>
            {recentRolls.map((r) => (
              <div className="roll-recent-row" key={r.id}>
                <span className="session-time num">{fmtClock(r.ts)}</span>
                <span className="roll-recent-name">{r.roller}</span>
                <span className="roll-recent-val num">
                  {r.result}
                  <span className="roll-recent-range"> ({r.min}-{r.max})</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
