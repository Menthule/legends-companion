import { describe, expect, it } from "vitest";
import { HighlightEvaluator } from "./highlights";
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
