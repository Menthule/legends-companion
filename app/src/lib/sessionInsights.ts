import type { MeterRow } from "../types";
import {
  petDamageOf,
  petSourcesOf,
  splitPetDamageRows,
  stripPetSuffix,
} from "./meterRows";

export function petRowsForCharacter(rows: MeterRow[], character: string): MeterRow[] {
  const mine = rows.find((r) => r.name.toLowerCase() === character.toLowerCase());
  const explicitPets = rows.filter(
    (r) =>
      /\bpet\b/i.test(r.name) &&
      r.name.toLowerCase() !== character.toLowerCase(),
  );
  if (!mine) return explicitPets;

  const petSources = petSourcesOf(mine);
  const petDamage = petDamageOf(mine);
  if (petDamage <= 0) return explicitPets;

  const duration = mine.dps > 0 ? mine.total / mine.dps : 1;
  const syntheticPet =
    splitPetDamageRows([mine], duration, mine.total).find((r) =>
      r.name.toLowerCase().endsWith(" pet"),
    ) ?? {
      ...mine,
      name: `${mine.name} pet`,
      total: petDamage,
      petDamage: 0,
      pet: false,
      dps: petDamage / Math.max(1, duration),
      pct: mine.total > 0 ? (petDamage / mine.total) * mine.pct : 0,
      sources: petSources.map((s) => ({ ...s, name: stripPetSuffix(s.name) })),
    };
  return [syntheticPet, ...explicitPets];
}

export function summedRowsTotal(rows: { total: number }[]): number {
  return rows.reduce((sum, row) => sum + row.total, 0);
}
