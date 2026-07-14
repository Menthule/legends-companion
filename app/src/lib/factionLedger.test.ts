import { describe, expect, it } from "vitest";
import {
  applyAllTimeDelta,
  applySessionDelta,
  characterStoreKey,
  mostDamaged,
  sortSessionRows,
  trendArrow,
  type FactionSessionRow,
} from "./factionLedger";

describe("characterStoreKey", () => {
  it("normalizes and falls back to unknown", () => {
    expect(characterStoreKey(" Nyasha ")).toBe("nyasha");
    expect(characterStoreKey("")).toBe("unknown");
  });
});

describe("applySessionDelta", () => {
  it("accumulates net and hits per faction, case-insensitively", () => {
    let map: Record<string, FactionSessionRow> = {};
    map = applySessionDelta(map, "Befallen Inhabitants", -2, 100);
    map = applySessionDelta(map, "befallen inhabitants", -2, 200);
    map = applySessionDelta(map, "Priests of Life", 1, 150);
    expect(Object.keys(map).length).toBe(2);
    const bef = map["befallen inhabitants"];
    expect(bef.net).toBe(-4);
    expect(bef.hits).toBe(2);
    expect(bef.lastTs).toBe(200);
    // Display name keeps the first-seen casing.
    expect(bef.faction).toBe("Befallen Inhabitants");
  });

  it("counts delta-0 floor/ceiling hits without moving the net", () => {
    let map: Record<string, FactionSessionRow> = {};
    map = applySessionDelta(map, "Burning Dead", 0, 100);
    expect(map["burning dead"].net).toBe(0);
    expect(map["burning dead"].hits).toBe(1);
  });

  it("does not mutate the input map", () => {
    const before: Record<string, FactionSessionRow> = {};
    const after = applySessionDelta(before, "X", -1, 1);
    expect(before).toEqual({});
    expect(after["x"].net).toBe(-1);
  });
});

describe("applyAllTimeDelta", () => {
  it("tracks first/last seen and accumulates across calls", () => {
    let map = applyAllTimeDelta({}, "Burning Dead", -2, 1000);
    map = applyAllTimeDelta(map, "Burning Dead", -2, 5000);
    const row = map["burning dead"];
    expect(row.net).toBe(-4);
    expect(row.hits).toBe(2);
    expect(row.firstSeenMs).toBe(1000);
    expect(row.lastSeenMs).toBe(5000);
  });
});

describe("mostDamaged", () => {
  const row = (faction: string, net: number, lastTs = 0): FactionSessionRow => ({
    faction,
    net,
    hits: 1,
    lastTs,
  });

  it("picks the most negative net, ignoring gains", () => {
    const worst = mostDamaged([row("A", 3), row("B", -2), row("C", -10)]);
    expect(worst?.faction).toBe("C");
  });

  it("is null when nothing is net-negative", () => {
    expect(mostDamaged([])).toBeNull();
    expect(mostDamaged([row("A", 0), row("B", 5)])).toBeNull();
  });

  it("breaks ties toward the most recent hit", () => {
    const worst = mostDamaged([row("A", -5, 100), row("B", -5, 200)]);
    expect(worst?.faction).toBe("B");
  });
});

describe("trendArrow / sortSessionRows", () => {
  it("maps sign to glyph", () => {
    expect(trendArrow(2)).toBe("▲");
    expect(trendArrow(-2)).toBe("▼");
    expect(trendArrow(0)).toBe("—");
  });

  it("sorts by absolute movement, then recency", () => {
    const map = {
      a: { faction: "A", net: -2, hits: 1, lastTs: 10 },
      b: { faction: "B", net: 9, hits: 1, lastTs: 5 },
      c: { faction: "C", net: -2, hits: 1, lastTs: 20 },
    };
    expect(sortSessionRows(map).map((r) => r.faction)).toEqual(["B", "C", "A"]);
  });
});
