import { describe, expect, it } from "vitest";
import { DOT_AGGREGATE_MS, HighlightEvaluator } from "./highlights";
import type { LogLinePayload } from "../types";

function line(event: LogLinePayload["event"], message = ""): LogLinePayload {
  return { ts: 1, message, event };
}

describe("HighlightEvaluator", () => {
  it("aggregates owned direct spell damage candidates and marks crits", () => {
    const evaluator = new HighlightEvaluator();
    expect(
      evaluator.evaluate(
        line({
          SpellDamage: {
            caster: "You",
            target: { Named: "a skeleton" },
            amount: 120,
            spell: "Blast of Frost",
            flags: { critical: true },
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        key: "spell:blast of frost",
        text: "Blast of Frost",
        amount: 120,
        detail: "Critical",
      }),
    ]);
  });

  it("emits every owned DoT tick with one long-lived aggregation key", () => {
    const evaluator = new HighlightEvaluator();
    const tick = (amount: number) =>
      line({
        SpellDamageTaken: {
          source: "You",
          target: { Named: "a skeleton" },
          amount,
          spell: "Engulfing Darkness",
        },
      });

    expect(evaluator.evaluate(tick(18))[0]).toEqual(
      expect.objectContaining({
        key: "spell:engulfing darkness",
        amount: 18,
        periodic: true,
        aggregateMs: DOT_AGGREGATE_MS,
        ttlMs: DOT_AGGREGATE_MS,
      }),
    );
    expect(evaluator.evaluate(tick(21))[0]).toEqual(
      expect.objectContaining({ key: "spell:engulfing darkness", amount: 21 }),
    );
  });

  it("accepts configured character and pet periodic damage but rejects enemies", () => {
    const evaluator = new HighlightEvaluator();
    evaluator.setOwners("Nyasha", ["Zumaik"]);
    const periodic = (source: unknown) =>
      line({
        NonMeleeDamage: {
          source,
          target: { Named: "a skeleton" },
          amount: 9,
          effect: "frost",
        },
      });

    expect(evaluator.evaluate(periodic({ Named: "Nyasha" }))[0]).toEqual(
      expect.objectContaining({ key: "effect:frost", amount: 9, periodic: true }),
    );
    expect(evaluator.evaluate(periodic({ Named: "Zumaik" }))).toHaveLength(1);
    expect(evaluator.evaluate(periodic({ Named: "a Teir`Dal necromancer" }))).toEqual([]);
  });

  it("seeds a skill record silently and emits later improvements", () => {
    const evaluator = new HighlightEvaluator();
    const event = (amount: number) =>
      line({
        MeleeHit: {
          attacker: "You",
          target: { Named: "a skeleton" },
          verb: "kick",
          amount,
          flags: {},
        },
      });
    expect(evaluator.evaluate(event(20))).toEqual([]);
    expect(evaluator.evaluate(event(25))).toEqual([
      expect.objectContaining({ text: "Kick best", amount: 25, important: true }),
    ]);
  });

  it("keeps ordinary crits quiet but surfaces rare combat flags", () => {
    const evaluator = new HighlightEvaluator();
    expect(
      evaluator.evaluate(
        line({
          MeleeHit: {
            attacker: "You",
            target: { Named: "a skeleton" },
            verb: "slash",
            amount: 90,
            flags: { critical: true, other: [] },
          },
        }),
      ),
    ).toEqual([]);
    expect(
      evaluator.evaluate(
        line({
          MeleeHit: {
            attacker: "You",
            target: { Named: "a skeleton" },
            verb: "slash",
            amount: 91,
            flags: { other: ["Double Bow Shot"] },
          },
        }),
      )[0],
    ).toEqual(expect.objectContaining({ text: "Double Bow Shot", amount: 91 }));
  });

  it("emits progression milestones without every skill-up", () => {
    const evaluator = new HighlightEvaluator();
    expect(evaluator.evaluate(line({ SkillUp: { skill: "Mend", value: 24 } }))).toEqual([]);
    expect(evaluator.evaluate(line({ SkillUp: { skill: "Mend", value: 25 } }))[0]).toEqual(
      expect.objectContaining({ text: "Mend milestone", amount: 25 }),
    );
    expect(
      evaluator.evaluate(
        line("System", "You have gained the ability to use Flying Kick."),
      )[0],
    ).toEqual(expect.objectContaining({ text: "Ability unlocked", detail: "Flying Kick" }));
  });
});
