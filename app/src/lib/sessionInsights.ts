import type { MeterRow } from "../types";

export function petRowsForCharacter(rows: MeterRow[], character: string): MeterRow[] {
  const mine = rows.find((r) => r.name.toLowerCase() === character.toLowerCase());
  const explicitPets = rows.filter(
    (r) =>
      /\bpet\b/i.test(r.name) &&
      r.name.toLowerCase() !== character.toLowerCase(),
  );
  if (!mine) return explicitPets;

  const petSources = (mine.sources ?? []).filter((s) => /\s+\(pet\)$/i.test(s.name));
  const petDamage =
    mine.petDamage && mine.petDamage > 0
      ? mine.petDamage
      : petSources.reduce((sum, s) => sum + s.total, 0);
  if (petDamage <= 0) return explicitPets;

  const duration = Math.max(1, mine.dps > 0 ? mine.total / mine.dps : 1);
  const syntheticPet: MeterRow = {
    ...mine,
    name: `${mine.name} pet`,
    total: petDamage,
    petDamage: 0,
    pet: false,
    dps: petDamage / duration,
    pct: mine.total > 0 ? (petDamage / mine.total) * mine.pct : 0,
    sources:
      petSources.length > 0
        ? petSources.map((s) => ({ ...s, name: s.name.replace(/\s+\(pet\)$/i, "") }))
        : [
            {
              name: "pet damage",
              total: petDamage,
              hits: 0,
              crits: 0,
              maxHit: 0,
              misses: 0,
              casts: 0,
            },
          ],
  };
  return [syntheticPet, ...explicitPets];
}

export function summedRowsTotal(rows: { total: number }[]): number {
  return rows.reduce((sum, row) => sum + row.total, 0);
}
