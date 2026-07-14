import { describe, expect, it } from "vitest";
import type { MeterRow } from "../types";
import { incomingDamageRows, incomingDamageTotal } from "./meterRows";

function row(name: string, damageTaken?: number): MeterRow {
  return {
    name,
    total: 0,
    dps: 0,
    pct: 0,
    pet: false,
    damageTaken,
  };
}

describe("incoming fight damage", () => {
  it("keeps only damaged combatants and ranks them by damage taken", () => {
    const rows = incomingDamageRows([
      row("Healer", 125),
      row("Observer"),
      row("Tank", 900),
      row("Pet", 0),
    ]);

    expect(rows.map((entry) => entry.name)).toEqual(["Tank", "Healer"]);
    expect(incomingDamageTotal(rows)).toBe(1025);
  });

  it("treats absent incoming damage as zero", () => {
    expect(incomingDamageRows([row("Player")])).toEqual([]);
    expect(incomingDamageTotal([row("Player")])).toBe(0);
  });
});
