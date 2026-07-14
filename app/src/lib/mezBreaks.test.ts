import { describe, expect, it } from "vitest";
import {
  createMezTracker,
  isMezEffect,
  MEZ_BREAK_WINDOW_SECS,
} from "./mezBreaks";

// Timer names follow the engine convention "<Effect> — <target>" (em dash);
// generated debuff timers are named by spell, curated ones "Mez (<Spell>)".
const MEZ = "Mesmerization — a kor ghoul wizard";

function started(name = MEZ, durationSecs = 24) {
  return { name, kind: "started" as const, lane: "enemy" as const, durationSecs };
}

describe("isMezEffect", () => {
  it("accepts known mez spells and 'mez'-named timers", () => {
    expect(isMezEffect("Mesmerize")).toBe(true);
    expect(isMezEffect("Mesmerization")).toBe(true);
    expect(isMezEffect("Enthrall")).toBe(true);
    expect(isMezEffect("Walking Sleep")).toBe(true);
    expect(isMezEffect("Mez (Enthrall)")).toBe(true);
  });
  it("rejects non-mez effects", () => {
    expect(isMezEffect("Flame Lick")).toBe(false);
    expect(isMezEffect("Clinging Darkness")).toBe(false);
    // "mez" must be a word, not a substring of another name.
    expect(isMezEffect("Mezzanine Strike")).toBe(false);
  });
});

describe("mez-break attribution", () => {
  it("credits the first hit on a mezzed target, once per application", () => {
    const t = createMezTracker();
    t.onTimer(started(), 100);
    const brk = t.onDamage("Sliq", "a kor ghoul wizard", 105);
    expect(brk).toEqual({ attacker: "Sliq", target: "a kor ghoul wizard", ts: 105 });
    // Second hit on the same application: no double count.
    expect(t.onDamage("You", "a kor ghoul wizard", 106)).toBeNull();
    // The bar dropping after the claimed break credits nothing more.
    t.onTimer({ name: MEZ, kind: "cancelled" }, 106);
    expect(t.onDamage("You", "a kor ghoul wizard", 107)).toBeNull();
  });

  it("matches targets case-insensitively (log re-capitalizes mob names)", () => {
    const t = createMezTracker();
    t.onTimer(started("Enthrall — A kor ghoul wizard"), 100);
    expect(t.onDamage("You", "a kor ghoul wizard", 101)).not.toBeNull();
  });

  it("re-arms attribution when the target is mezzed again", () => {
    const t = createMezTracker();
    t.onTimer(started(), 100);
    expect(t.onDamage("Sliq", "a kor ghoul wizard", 101)).not.toBeNull();
    t.onTimer({ name: MEZ, kind: "cancelled" }, 102);
    // Fresh mez on the same mob: the next hit is a new break.
    t.onTimer(started(), 110);
    const brk = t.onDamage("Thaggar", "a kor ghoul wizard", 112);
    expect(brk?.attacker).toBe("Thaggar");
  });

  it("credits nothing after a natural expiry", () => {
    const t = createMezTracker();
    t.onTimer(started(MEZ, 24), 100);
    t.onTimer({ name: MEZ, kind: "expired" }, 124);
    expect(t.onDamage("You", "a kor ghoul wizard", 125)).toBeNull();
  });

  it("treats a cancel at the natural end as wear-off, not a break", () => {
    const t = createMezTracker();
    t.onTimer(started(MEZ, 24), 100);
    // Wear-off line cancels the bar ~when it would expire anyway.
    t.onTimer({ name: MEZ, kind: "cancelled" }, 123);
    expect(t.onDamage("You", "a kor ghoul wizard", 124)).toBeNull();
  });

  it("opens a claim window on an early cancel (cancel beats the damage event)", () => {
    const t = createMezTracker();
    t.onTimer(started(MEZ, 24), 100);
    t.onTimer({ name: MEZ, kind: "cancelled" }, 105);
    const brk = t.onDamage("You", "a kor ghoul wizard", 106);
    expect(brk).toEqual({ attacker: "You", target: "a kor ghoul wizard", ts: 106 });
    // The window is one-shot.
    expect(t.onDamage("Sliq", "a kor ghoul wizard", 107)).toBeNull();
  });

  it("expires the claim window", () => {
    const t = createMezTracker();
    t.onTimer(started(MEZ, 60), 100);
    t.onTimer({ name: MEZ, kind: "cancelled" }, 110);
    const late = 110 + MEZ_BREAK_WINDOW_SECS + 1;
    expect(t.onDamage("You", "a kor ghoul wizard", late)).toBeNull();
  });

  it("ignores non-mez timers, other lanes, and unbound (bare) timers", () => {
    const t = createMezTracker();
    // Non-mez enemy timer on the target.
    t.onTimer(started("Flame Lick — a kor ghoul wizard"), 100);
    expect(t.onDamage("You", "a kor ghoul wizard", 101)).toBeNull();
    // Mez-named timer on a non-enemy lane.
    t.onTimer({ name: "Mez (Enthrall) — a gnoll", kind: "started", lane: "buff", durationSecs: 24 }, 100);
    expect(t.onDamage("You", "a gnoll", 101)).toBeNull();
    // Bare curated timer without a bound target: no attribution possible.
    t.onTimer({ name: "Mez (Mesmerize)", kind: "started", lane: "enemy", durationSecs: 24 }, 100);
    expect(t.onDamage("You", "a gnoll", 101)).toBeNull();
    // Cancelling timers we never registered is a no-op.
    t.onTimer({ name: "Flame Lick — a kor ghoul wizard", kind: "cancelled" }, 102);
    expect(t.onDamage("You", "a kor ghoul wizard", 103)).toBeNull();
  });

  it("tracks separate targets independently", () => {
    const t = createMezTracker();
    t.onTimer(started("Enthrall — a gnoll"), 100);
    t.onTimer(started("Enthrall — a kobold"), 101);
    expect(t.onDamage("Sliq", "a gnoll", 102)?.target).toBe("a gnoll");
    // The kobold's mez is untouched by the gnoll break.
    expect(t.onDamage("You", "a kobold", 103)?.attacker).toBe("You");
  });

  it("kill of a mezzed mob credits the killer (documented behavior)", () => {
    const t = createMezTracker();
    t.onTimer(started(), 100);
    // The killing hit lands while the bar is still up (Slain reaps it after).
    const brk = t.onDamage("You", "a kor ghoul wizard", 103);
    expect(brk?.attacker).toBe("You");
    t.onTimer({ name: MEZ, kind: "cancelled" }, 103);
    expect(t.onDamage("Sliq", "a kor ghoul wizard", 104)).toBeNull();
  });
});
