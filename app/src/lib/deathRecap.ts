// Death recap (P25): pull structured INCOMING damage out of parsed log events
// so the recap card can show "what hit me for how much" with a running total,
// not just raw lines. Every damage event carries an `amount`; we keep the ones
// whose target is You.

/** Read a serde-encoded eqlog-core Entity: "You" (bare string) or
 *  { Named: "<name>" }. Mirrors FightsTab's entityName. */
function entityName(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Named" in e) {
    return String((e as { Named: unknown }).Named);
  }
  return "?";
}

export interface IncomingHit {
  source: string;
  /** Spell/effect/verb that dealt it, e.g. "Ice Comet", "thorns", "crush". */
  label: string;
  amount: number;
}

/** Extract one incoming-damage hit from a parsed event, or null if the event
 *  isn't damage aimed at You. */
export function incomingDamage(ev: unknown): IncomingHit | null {
  if (typeof ev !== "object" || ev === null) return null;
  const o = ev as Record<string, unknown>;
  const amt = (d: Record<string, unknown>) =>
    typeof d.amount === "number" ? d.amount : 0;

  if ("MeleeHit" in o) {
    const d = o.MeleeHit as Record<string, unknown>;
    if (entityName(d.target) !== "You") return null;
    return {
      source: entityName(d.attacker),
      label: String(d.verb ?? "melee"),
      amount: amt(d),
    };
  }
  if ("SpellDamage" in o) {
    const d = o.SpellDamage as Record<string, unknown>;
    if (entityName(d.target) !== "You") return null;
    return {
      source: entityName(d.caster),
      label: d.spell ? String(d.spell) : "spell",
      amount: amt(d),
    };
  }
  if ("SpellDamageTaken" in o) {
    const d = o.SpellDamageTaken as Record<string, unknown>;
    if (entityName(d.target) !== "You") return null;
    return {
      source: entityName(d.source),
      label: String(d.spell ?? "spell"),
      amount: amt(d),
    };
  }
  if ("NonMeleeDamage" in o) {
    const d = o.NonMeleeDamage as Record<string, unknown>;
    if (entityName(d.target) !== "You") return null;
    return {
      source: d.source == null ? "?" : entityName(d.source),
      label: String(d.effect ?? "non-melee"),
      amount: amt(d),
    };
  }
  return null;
}

export interface DamageSummary {
  totalTaken: number;
  /** Per-source totals, biggest first. */
  bySource: { source: string; amount: number }[];
}

/** Aggregate a window of incoming hits into a total + per-source breakdown. */
export function summarizeDamage(hits: IncomingHit[]): DamageSummary {
  const map = new Map<string, number>();
  let totalTaken = 0;
  for (const h of hits) {
    if (h.amount <= 0) continue;
    totalTaken += h.amount;
    map.set(h.source, (map.get(h.source) ?? 0) + h.amount);
  }
  const bySource = [...map.entries()]
    .map(([source, amount]) => ({ source, amount }))
    .sort((a, b) => b.amount - a.amount);
  return { totalTaken, bySource };
}
