import type { MeterRow, MeterSourceRow } from "../types";

export function isPetSourceName(name: string): boolean {
  return /\s+\(pet\)$/i.test(name);
}

export function stripPetSuffix(name: string): string {
  return name.replace(/\s+\(pet\)$/i, "");
}

export function petDamageOf(row: MeterRow): number {
  const rawPetDamage =
    typeof row.petDamage === "number"
      ? row.petDamage
      : typeof (row as MeterRow & { pet_damage?: unknown }).pet_damage ===
          "number"
        ? (row as MeterRow & { pet_damage: number }).pet_damage
        : 0;
  if (rawPetDamage > 0) return Math.min(row.total, rawPetDamage);
  return Math.min(
    row.total,
    (row.sources ?? [])
      .filter((s) => isPetSourceName(s.name))
      .reduce((sum, s) => sum + s.total, 0),
  );
}

export function petSourcesOf(row: MeterRow): MeterSourceRow[] {
  return (row.sources ?? []).filter((s) => isPetSourceName(s.name));
}

export function playerSourcesOf(row: MeterRow): MeterSourceRow[] {
  return (row.sources ?? []).filter((s) => !isPetSourceName(s.name));
}

export function splitPetDamageRows(
  rows: MeterRow[],
  durationSecs: number,
  totalDamage: number,
): MeterRow[] {
  const duration = Math.max(1, durationSecs);
  const split: MeterRow[] = [];
  for (const row of rows) {
    const petDamage = petDamageOf(row);
    if (petDamage <= 0) {
      split.push(row);
      continue;
    }

    const petSources = petSourcesOf(row);
    const playerSources = playerSourcesOf(row);
    const playerDamage = Math.max(0, row.total - petDamage);
    if (playerDamage > 0 || playerSources.length > 0) {
      split.push({
        ...row,
        total: playerDamage,
        petDamage: 0,
        pet: false,
        dps: playerDamage / duration,
        pct: totalDamage > 0 ? (playerDamage / totalDamage) * 100 : 0,
        sources: playerSources,
      });
    }
    split.push({
      ...row,
      name: `${row.name} pet`,
      total: petDamage,
      petDamage: 0,
      pet: false,
      dps: petDamage / duration,
      pct: totalDamage > 0 ? (petDamage / totalDamage) * 100 : 0,
      sources:
        petSources.length > 0
          ? petSources.map((s) => ({ ...s, name: stripPetSuffix(s.name) }))
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
    });
  }
  return split.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
