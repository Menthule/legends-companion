export type RespawnContext = "public" | "private" | "custom";
export type RespawnTimingSource = "reference" | "zone-default" | "manual" | "observed";

export interface RespawnTimingProfile {
  mob: string;
  zone: string;
  context: RespawnContext;
  durationSecs: number;
  source: "manual" | "observed";
  updatedAt: number;
}

export interface RespawnTimingResolution {
  durationSecs: number;
  source: RespawnTimingSource;
  profile: RespawnTimingProfile | null;
}

export const RESPAWN_CONTEXTS_KEY = "eqlogs.respawn.contexts.v1";
export const RESPAWN_TIMING_KEY = "eqlogs.respawn.timingProfiles.v1";

export function respawnZoneKey(zoneShort: string | null, zoneLong: string | null): string {
  const raw = (zoneShort || zoneLong || "unknown").trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

export function respawnMobKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function inferredRespawnContext(zoneName: string | null): RespawnContext {
  return /\b(expedition|instance)\b/i.test(zoneName ?? "") ? "private" : "public";
}

export function resolveRespawnTiming(
  profiles: RespawnTimingProfile[],
  args: {
    mob: string;
    zoneShort: string | null;
    zoneLong: string | null;
    context: RespawnContext;
    referenceSecs: number;
    fallbackSecs: number;
  },
): RespawnTimingResolution {
  const zone = respawnZoneKey(args.zoneShort, args.zoneLong);
  const mob = respawnMobKey(args.mob);
  const profile = profiles
    .filter(
      (p) =>
        respawnMobKey(p.mob) === mob &&
        p.zone === zone &&
        p.context === args.context &&
        Number.isFinite(p.durationSecs) &&
        p.durationSecs > 0,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  if (profile) {
    return { durationSecs: profile.durationSecs, source: profile.source, profile };
  }
  if (args.referenceSecs > 0) {
    return { durationSecs: args.referenceSecs, source: "reference", profile: null };
  }
  return {
    durationSecs: Math.max(1, args.fallbackSecs),
    source: "zone-default",
    profile: null,
  };
}

export function upsertRespawnTimingProfile(
  profiles: RespawnTimingProfile[],
  profile: RespawnTimingProfile,
): RespawnTimingProfile[] {
  const mob = respawnMobKey(profile.mob);
  return [
    profile,
    ...profiles.filter(
      (p) =>
        !(
          respawnMobKey(p.mob) === mob &&
          p.zone === profile.zone &&
          p.context === profile.context
        ),
    ),
  ];
}

export function removeRespawnTimingProfile(
  profiles: RespawnTimingProfile[],
  mob: string,
  zone: string,
  context: RespawnContext,
): RespawnTimingProfile[] {
  const key = respawnMobKey(mob);
  return profiles.filter(
    (p) => !(respawnMobKey(p.mob) === key && p.zone === zone && p.context === context),
  );
}

export function loadRespawnTimingProfiles(): RespawnTimingProfile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RESPAWN_TIMING_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is RespawnTimingProfile => {
      if (!p || typeof p !== "object") return false;
      const x = p as Record<string, unknown>;
      return (
        typeof x.mob === "string" &&
        typeof x.zone === "string" &&
        (x.context === "public" || x.context === "private" || x.context === "custom") &&
        typeof x.durationSecs === "number" &&
        x.durationSecs > 0 &&
        (x.source === "manual" || x.source === "observed")
      );
    });
  } catch {
    return [];
  }
}

export function saveRespawnTimingProfiles(profiles: RespawnTimingProfile[]): void {
  try {
    localStorage.setItem(RESPAWN_TIMING_KEY, JSON.stringify(profiles.slice(0, 500)));
  } catch {
    // The current timer still works if persistence is unavailable.
  }
}

export function loadRespawnContext(zone: string, fallback: RespawnContext): RespawnContext {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESPAWN_CONTEXTS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const value = parsed[zone];
    return value === "public" || value === "private" || value === "custom" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveRespawnContext(zone: string, context: RespawnContext): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESPAWN_CONTEXTS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    localStorage.setItem(RESPAWN_CONTEXTS_KEY, JSON.stringify({ ...parsed, [zone]: context }));
  } catch {
    // Context falls back to public/private inference when storage is unavailable.
  }
}
