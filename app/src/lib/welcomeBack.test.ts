import { describe, expect, it } from "vitest";
import {
  buildWelcomeBackSummary,
  decodeWelcomeBackPrefs,
  epochMsToLogTs,
  fmtAway,
  shouldShowWelcomeBack,
  WELCOME_BACK_MIN_GAP_MS,
  type WelcomeSessionRow,
} from "./welcomeBack";

const HOUR = 3_600_000;

function row(overrides: Partial<WelcomeSessionRow> = {}): WelcomeSessionRow {
  return {
    endedMs: 1_000 * HOUR,
    durationSecs: 7200,
    xp: 34.5,
    kills: 120,
    deaths: 1,
    topMob: "a dwarf guard",
    topMobKills: 44,
    zones: ["Crushbone"],
    character: "Nyasha",
    ...overrides,
  };
}

describe("buildWelcomeBackSummary — gap qualification", () => {
  it("returns null without a history row", () => {
    expect(buildWelcomeBackSummary({ nowMs: 50 * HOUR, row: null })).toBeNull();
  });

  it("returns null when the gap is under the threshold", () => {
    const r = row();
    const nowMs = r.endedMs + WELCOME_BACK_MIN_GAP_MS - 1;
    expect(buildWelcomeBackSummary({ nowMs, row: r })).toBeNull();
  });

  it("returns a summary exactly at the threshold", () => {
    const r = row();
    const nowMs = r.endedMs + WELCOME_BACK_MIN_GAP_MS;
    const s = buildWelcomeBackSummary({ nowMs, row: r });
    expect(s).not.toBeNull();
    expect(s!.awayMs).toBe(WELCOME_BACK_MIN_GAP_MS);
    expect(s!.lastEndedMs).toBe(r.endedMs);
  });

  it("returns null for a future or zero endedMs (clock skew / corrupt row)", () => {
    expect(
      buildWelcomeBackSummary({ nowMs: 10 * HOUR, row: row({ endedMs: 11 * HOUR }) }),
    ).toBeNull();
    expect(
      buildWelcomeBackSummary({ nowMs: 10 * HOUR, row: row({ endedMs: 0 }) }),
    ).toBeNull();
  });

  it("honors a custom minGapMs", () => {
    const r = row();
    const nowMs = r.endedMs + 2 * HOUR;
    expect(buildWelcomeBackSummary({ nowMs, row: r, minGapMs: HOUR })).not.toBeNull();
    expect(buildWelcomeBackSummary({ nowMs, row: r, minGapMs: 3 * HOUR })).toBeNull();
  });
});

describe("buildWelcomeBackSummary — session stats", () => {
  const nowFor = (r: WelcomeSessionRow) => r.endedMs + 24 * HOUR;

  it("computes overall kills/hour from the archived session", () => {
    const r = row({ kills: 30, durationSecs: 1800 });
    const s = buildWelcomeBackSummary({ nowMs: nowFor(r), row: r })!;
    expect(s.killsPerHour).toBeCloseTo(60);
    expect(s.topMob).toBe("a dwarf guard");
    expect(s.topMobKills).toBe(44);
  });

  it("reports null kills/hour with zero kills or zero duration", () => {
    const noKills = row({ kills: 0 });
    expect(
      buildWelcomeBackSummary({ nowMs: nowFor(noKills), row: noKills })!.killsPerHour,
    ).toBeNull();
    const noTime = row({ durationSecs: 0 });
    expect(
      buildWelcomeBackSummary({ nowMs: nowFor(noTime), row: noTime })!.killsPerHour,
    ).toBeNull();
  });

  it("passes zone and persisted level progress through", () => {
    const r = row();
    const s = buildWelcomeBackSummary({
      nowMs: nowFor(r),
      row: r,
      levelProgress: 42.5,
    })!;
    expect(s.zone).toBe("Crushbone");
    expect(s.levelProgress).toBe(42.5);
    const noAnchor = buildWelcomeBackSummary({ nowMs: nowFor(r), row: r })!;
    expect(noAnchor.levelProgress).toBeNull();
    expect(
      buildWelcomeBackSummary({ nowMs: nowFor(r), row: row({ zones: [] }) })!.zone,
    ).toBe("");
  });
});

describe("buildWelcomeBackSummary — expired camp timers", () => {
  it("keeps only timers that came due inside the away window", () => {
    const r = row();
    const nowMs = r.endedMs + 24 * HOUR;
    const timer = (label: string, dueAtMs: number) => ({
      label,
      zoneLong: "Crushbone",
      startedAt: dueAtMs - 10 * 60_000,
      durationSecs: 600,
    });
    const s = buildWelcomeBackSummary({
      nowMs,
      row: r,
      timers: [
        timer("before you left", r.endedMs - HOUR),
        timer("popped while away", r.endedMs + 2 * HOUR),
        timer("popped later while away", r.endedMs + 20 * HOUR),
        timer("still counting down", nowMs + HOUR),
      ],
    })!;
    expect(s.expiredTimers.map((t) => t.label)).toEqual([
      "popped later while away", // newest first
      "popped while away",
    ]);
    expect(s.expiredTimers[0].dueAtMs).toBe(r.endedMs + 20 * HOUR);
  });
});

describe("buildWelcomeBackSummary — wishlist drops since last played", () => {
  it("filters loot by the log-domain boundary and matches case-insensitively", () => {
    const r = row();
    const nowMs = r.endedMs + 24 * HOUR;
    const since = epochMsToLogTs(r.endedMs);
    const s = buildWelcomeBackSummary({
      nowMs,
      row: r,
      wishlist: ["Dwarven Ringmail Tunic", "Screaming Mace"],
      loot: [
        { ts: since - 60, item: "Dwarven Ringmail Tunic" }, // before leaving
        { ts: since + 60, item: "dwarven ringmail tunic" },
        { ts: since + 120, item: "Dwarven Ringmail Tunic", qty: 2 },
        { ts: since + 180, item: "Rusty Axe" }, // not wishlisted
      ],
    })!;
    expect(s.wishlistDrops).toEqual([{ item: "dwarven ringmail tunic", qty: 3 }]);
  });

  it("is empty with no wishlist even when loot exists", () => {
    const r = row();
    const s = buildWelcomeBackSummary({
      nowMs: r.endedMs + 24 * HOUR,
      row: r,
      loot: [{ ts: epochMsToLogTs(r.endedMs) + 5, item: "Rusty Axe" }],
    })!;
    expect(s.wishlistDrops).toEqual([]);
  });
});

describe("epochMsToLogTs", () => {
  it("shifts epoch time by the local zone offset (naive-local-as-UTC)", () => {
    const ms = Date.UTC(2026, 6, 13, 12, 0, 0);
    const expected = Math.floor(
      (ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000,
    );
    expect(epochMsToLogTs(ms)).toBe(expected);
    // Round-trip: converting back with the same offset recovers the input.
    expect(
      epochMsToLogTs(ms) * 1000 + new Date(ms).getTimezoneOffset() * 60_000,
    ).toBe(ms);
  });
});

describe("prefs decode + show gate", () => {
  it("defaults to enabled with no dismissal", () => {
    expect(decodeWelcomeBackPrefs(null)).toEqual({
      enabled: true,
      dismissedForEndedMs: 0,
    });
    expect(decodeWelcomeBackPrefs("garbage")).toEqual({
      enabled: true,
      dismissedForEndedMs: 0,
    });
  });

  it("keeps a stored disable + dismissal", () => {
    expect(
      decodeWelcomeBackPrefs({ enabled: false, dismissedForEndedMs: 123 }),
    ).toEqual({ enabled: false, dismissedForEndedMs: 123 });
  });

  it("shows only for an undismissed qualifying gap while enabled", () => {
    const endedMs = 1_000 * HOUR;
    const nowMs = endedMs + 24 * HOUR;
    const on = { enabled: true, dismissedForEndedMs: 0 };
    expect(shouldShowWelcomeBack(on, endedMs, nowMs)).toBe(true);
    // Too recent.
    expect(shouldShowWelcomeBack(on, endedMs, endedMs + HOUR)).toBe(false);
    // Disabled entirely.
    expect(
      shouldShowWelcomeBack({ ...on, enabled: false }, endedMs, nowMs),
    ).toBe(false);
    // Dismissed for THIS gap stays hidden…
    expect(
      shouldShowWelcomeBack({ ...on, dismissedForEndedMs: endedMs }, endedMs, nowMs),
    ).toBe(false);
    // …but a newer session end (next qualifying gap) shows again.
    expect(
      shouldShowWelcomeBack(
        { ...on, dismissedForEndedMs: endedMs },
        endedMs + 30 * HOUR,
        endedMs + 60 * HOUR,
      ),
    ).toBe(true);
  });
});

describe("fmtAway", () => {
  it("uses hours under two days, days after", () => {
    expect(fmtAway(13 * HOUR)).toBe("13 hours ago");
    expect(fmtAway(30 * 60_000)).toBe("1 hour ago");
    expect(fmtAway(47 * HOUR)).toBe("47 hours ago");
    expect(fmtAway(72 * HOUR)).toBe("3 days ago");
  });
});
