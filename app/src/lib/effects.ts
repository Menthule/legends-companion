import type { EffectObservedPayload } from "../types";

/** Convert the parser's structured SpellDamage event to analytics data.
 * Special handling and alerting belong to triggers, not item-name heuristics. */
export function observedSpellEffect(
  spell: string,
  target: string,
  amount: number,
  critical: boolean,
): EffectObservedPayload {
  return { kind: "spell", spell, target, amount, critical };
}
