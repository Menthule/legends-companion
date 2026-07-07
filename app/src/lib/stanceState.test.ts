import { describe, it, expect } from "vitest";
import { applyStanceLine, EMPTY_STANCE_STATE } from "./stanceState";

describe("applyStanceLine", () => {
  it("names the stance on completion and clears the changing flag", () => {
    const begun = applyStanceLine(
      EMPTY_STANCE_STATE,
      "You begin to change your stance.",
    );
    expect(begun).toEqual({ ...EMPTY_STANCE_STATE, stanceChanging: true });
    const done = applyStanceLine(begun!, "You assume a striker stance.");
    expect(done).toEqual({
      ...EMPTY_STANCE_STATE,
      stance: "striker",
      stanceChanging: false,
    });
  });

  it("tracks invocation begin/complete", () => {
    const begun = applyStanceLine(
      EMPTY_STANCE_STATE,
      "You begin to change your invocation.",
    );
    expect(begun?.invocationChanging).toBe(true);
    const done = applyStanceLine(
      begun!,
      "You begin reciting the recovery invocation.",
    );
    expect(done?.invocation).toBe("recovery");
    expect(done?.invocationChanging).toBe(false);
  });

  it("clears a stuck 'changing…' transition on death or zone (P43)", () => {
    const mid = {
      ...EMPTY_STANCE_STATE,
      stance: "striker",
      stanceChanging: true,
      invocationChanging: true,
    };
    for (const line of [
      "You died.",
      "You have been slain by a kobold shaman!",
      "You have entered the Greater Faydark.",
    ]) {
      const next = applyStanceLine(mid, line);
      expect(next).toEqual({
        ...mid,
        stanceChanging: false,
        invocationChanging: false,
      });
      // resolved stance value is preserved, only the transition is aborted
      expect(next?.stance).toBe("striker");
    }
  });

  it("ignores death/zone lines when nothing is in transition", () => {
    expect(applyStanceLine(EMPTY_STANCE_STATE, "You died.")).toBeNull();
    expect(
      applyStanceLine(EMPTY_STANCE_STATE, "You have entered the Greater Faydark."),
    ).toBeNull();
  });

  it("returns null for unrelated lines", () => {
    expect(applyStanceLine(EMPTY_STANCE_STATE, "You hit a rat for 5.")).toBeNull();
  });
});
