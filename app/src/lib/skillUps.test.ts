import { describe, expect, it } from "vitest";
import {
  applySkillUp,
  beginSkillSession,
  emptySkillStore,
  sessionsSinceUp,
  STUCK_SESSIONS,
  stuckSkills,
  type SkillStoreState,
} from "./skillUps";

function liveUp(
  state: SkillStoreState,
  skill: string,
  value: number,
  sessionIndex: number,
  nowMs = 1000,
): SkillStoreState {
  return applySkillUp(state, skill, value, { live: true, nowMs, sessionIndex }).state;
}

describe("applySkillUp", () => {
  it("first sighting has no delta; later ups report the gain", () => {
    const first = applySkillUp(emptySkillStore(), "Channeling", 118, {
      live: true,
      nowMs: 1000,
      sessionIndex: 1,
    });
    expect(first.delta).toBeNull();
    expect(first.state.skills["channeling"].value).toBe(118);
    const second = applySkillUp(first.state, "channeling", 119, {
      live: true,
      nowMs: 2000,
      sessionIndex: 1,
    });
    expect(second.delta).toBe(1);
    expect(second.state.skills["channeling"].value).toBe(119);
    expect(second.state.skills["channeling"].ups).toBe(2);
    // Display name keeps first-seen casing.
    expect(second.state.skills["channeling"].skill).toBe("Channeling");
  });

  it("replayed (catch-up) ups only raise the stored value, never activity", () => {
    let s = liveUp(emptySkillStore(), "Meditate", 63, 1, 5000);
    // Old replayed line with a LOWER value: value must not regress.
    const replayLow = applySkillUp(s, "Meditate", 40, {
      live: false,
      nowMs: 9000,
      sessionIndex: 0,
    });
    expect(replayLow.state.skills["meditate"].value).toBe(63);
    expect(replayLow.state.skills["meditate"].ups).toBe(1);
    expect(replayLow.state.skills["meditate"].lastUpMs).toBe(5000);
    // Replay with a higher value refreshes the value only.
    const replayHigh = applySkillUp(s, "Meditate", 70, {
      live: false,
      nowMs: 9000,
      sessionIndex: 0,
    });
    expect(replayHigh.state.skills["meditate"].value).toBe(70);
    expect(replayHigh.state.skills["meditate"].ups).toBe(1);
  });

  it("does not mutate the input state", () => {
    const before = emptySkillStore();
    liveUp(before, "1H Blunt", 163, 1);
    expect(before.skills).toEqual({});
  });
});

describe("beginSkillSession", () => {
  it("hands out monotonically increasing session indexes", () => {
    const a = beginSkillSession(emptySkillStore());
    expect(a.index).toBe(1);
    expect(a.state.sessionCounter).toBe(1);
    const b = beginSkillSession(a.state);
    expect(b.index).toBe(2);
  });
});

describe("stuckSkills", () => {
  it("flags skills with no gain in the last N skill-up sessions", () => {
    let s = emptySkillStore();
    s = beginSkillSession(s).state; // session 1
    s = liveUp(s, "Channeling", 100, 1);
    s = liveUp(s, "Meditate", 50, 1);
    // Three more sessions where only Meditate goes up.
    for (const session of [2, 3, 4]) {
      s = beginSkillSession(s).state;
      s = liveUp(s, "Meditate", 50 + session, session);
    }
    const stuck = stuckSkills(s, STUCK_SESSIONS);
    expect(stuck.map((r) => r.skill)).toEqual(["Channeling"]);
    expect(sessionsSinceUp(s, stuck[0])).toBe(3);
  });

  it("excludes skills never seen going up live (replay-only sightings)", () => {
    let s = emptySkillStore();
    s = applySkillUp(s, "Sense Heading", 12, {
      live: false,
      nowMs: 1000,
      sessionIndex: 0,
    }).state;
    s = { ...s, sessionCounter: 10 };
    expect(stuckSkills(s)).toEqual([]);
  });

  it("sorts stalest first", () => {
    let s = emptySkillStore();
    s = { ...s, sessionCounter: 10 };
    s = liveUp(s, "Old", 5, 1);
    s = liveUp(s, "Older", 5, 2);
    s = { ...s, sessionCounter: 10 };
    const stuck = stuckSkills(s);
    expect(stuck.map((r) => r.skill)).toEqual(["Old", "Older"]);
  });
});
