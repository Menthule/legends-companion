import { describe, expect, it } from "vitest";
import { incomingDamage, summarizeDamage } from "./deathRecap";

describe("incomingDamage (P25)", () => {
  it("reads a melee hit aimed at You", () => {
    const hit = incomingDamage({
      MeleeHit: {
        attacker: { Named: "a Teir`Dal ranger" },
        target: "You",
        verb: "slash",
        amount: 42,
      },
    });
    expect(hit).toEqual({
      source: "a Teir`Dal ranger",
      label: "slash",
      amount: 42,
    });
  });

  it("reads incoming spell damage with its spell name", () => {
    const hit = incomingDamage({
      SpellDamageTaken: {
        target: "You",
        source: { Named: "an icy sprite" },
        spell: "Ice Comet",
        amount: 300,
      },
    });
    expect(hit).toEqual({ source: "an icy sprite", label: "Ice Comet", amount: 300 });
  });

  it("ignores damage NOT aimed at You (outgoing)", () => {
    expect(
      incomingDamage({
        MeleeHit: {
          attacker: "You",
          target: { Named: "a gnoll" },
          verb: "crush",
          amount: 99,
        },
      }),
    ).toBeNull();
    // Non-damage events too.
    expect(incomingDamage({ XpGain: { percent: 5 } })).toBeNull();
    expect(incomingDamage("Zoned")).toBeNull();
  });
});

describe("summarizeDamage (P25)", () => {
  it("totals damage and ranks sources biggest-first", () => {
    const s = summarizeDamage([
      { source: "sprite", label: "Ice Comet", amount: 300 },
      { source: "ranger", label: "slash", amount: 42 },
      { source: "sprite", label: "melee", amount: 58 },
      { source: "ranger", label: "miss", amount: 0 }, // zero drops out
    ]);
    expect(s.totalTaken).toBe(400);
    expect(s.bySource).toEqual([
      { source: "sprite", amount: 358 },
      { source: "ranger", amount: 42 },
    ]);
  });
});
