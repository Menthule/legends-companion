// Ding digest (P8): on a LevelUp, show a dismissible card of exactly what the
// character just unlocked — newly-trainable spells and abilities for their
// class set — each a deep-link into the Spells/Abilities DB tab. Turns the
// silent XP-bar ding into an actionable "go train these" moment.

import { useState } from "react";
import { unlocksAtLevel } from "../api";
import { useTauriEvent } from "../hooks";
import { openSpells } from "../lib/deepLinks";
import type { LogLinePayload, UnlockRow } from "../types";

export default function DingDigest({
  classes,
  catchingUp,
}: {
  /** The character's class set (active loadout). Empty => no card. */
  classes: string[];
  /** Suppress the card during catch-up replay — a replayed ding is old news. */
  catchingUp: boolean;
}) {
  const [card, setCard] = useState<{
    level: number;
    unlocks: UnlockRow[];
  } | null>(null);

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    if (catchingUp || classes.length === 0) return;
    const ev = p.event;
    if (typeof ev !== "object" || ev === null || !("LevelUp" in ev)) return;
    const level = Number((ev.LevelUp as { level?: number }).level ?? 0);
    if (level <= 0) return;
    void unlocksAtLevel(classes.join(","), level)
      .then((unlocks) => setCard({ level, unlocks }))
      .catch(() => setCard({ level, unlocks: [] }));
  });

  if (!card) return null;

  const spells = card.unlocks.filter((u) => u.isAbility === 0);
  const abilities = card.unlocks.filter((u) => u.isAbility !== 0);

  const openSpell = (u: UnlockRow) => {
    openSpells(u.name, u.isAbility !== 0);
    setCard(null);
  };

  const group = (label: string, rows: UnlockRow[]) =>
    rows.length === 0 ? null : (
      <div className="ding-group">
        <span className="ding-group-label">{label}</span>
        {rows.map((u) => (
          <button
            className="ding-unlock"
            key={u.id}
            onClick={() => openSpell(u)}
            title={`${u.classes} — open in the database`}
          >
            <span className="ding-unlock-name">{u.name}</span>
            <span className="ding-unlock-meta">{u.classes}</span>
          </button>
        ))}
      </div>
    );

  return (
    <div
      className="ding-card"
      role="dialog"
      aria-label={`Level ${card.level} unlocks`}
    >
      <div className="ding-head">
        <span className="ding-title">Ding! Level {card.level}</span>
        <button
          className="ghost small icon-btn"
          onClick={() => setCard(null)}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {card.unlocks.length === 0 ? (
        <div className="ding-empty">
          Nothing new to train at this level — keep grinding.
        </div>
      ) : (
        <div className="ding-body">
          {group("New spells", spells)}
          {group("New abilities", abilities)}
        </div>
      )}
    </div>
  );
}
