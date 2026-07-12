import { describe, expect, it } from "vitest";
import {
  inferredRespawnContext,
  removeRespawnTimingProfile,
  resolveRespawnTiming,
  respawnZoneKey,
  upsertRespawnTimingProfile,
  type RespawnTimingProfile,
} from "./respawnTiming";

const privateProfile: RespawnTimingProfile = {
  mob: "Frenzied Ghoul",
  zone: "gukbottom",
  context: "private",
  durationSecs: 900,
  source: "manual",
  updatedAt: 10,
};

describe("respawn timing profiles", () => {
  it("infers private contexts only from explicit instance names", () => {
    expect(inferredRespawnContext("New Sebilis Expedition")).toBe("private");
    expect(inferredRespawnContext("Private Instance")).toBe("private");
    expect(inferredRespawnContext("Ruins of Old Guk")).toBe("public");
  });

  it("prefers the matching mob, zone, and context override", () => {
    expect(
      resolveRespawnTiming([privateProfile], {
        mob: "frenzied   ghoul",
        zoneShort: "gukbottom",
        zoneLong: "Ruins of Old Guk",
        context: "private",
        referenceSecs: 1320,
        fallbackSecs: 400,
      }),
    ).toMatchObject({ durationSecs: 900, source: "manual" });
  });

  it("falls back to reference, then the zone default", () => {
    const common = {
      mob: "Frenzied Ghoul",
      zoneShort: "gukbottom",
      zoneLong: "Ruins of Old Guk",
      context: "public" as const,
      fallbackSecs: 400,
    };
    expect(resolveRespawnTiming([], { ...common, referenceSecs: 1320 })).toMatchObject({
      durationSecs: 1320,
      source: "reference",
    });
    expect(resolveRespawnTiming([], { ...common, referenceSecs: 0 })).toMatchObject({
      durationSecs: 400,
      source: "zone-default",
    });
  });

  it("upserts and removes one context without disturbing another", () => {
    const publicProfile = { ...privateProfile, context: "public" as const, durationSecs: 1320 };
    const updated = upsertRespawnTimingProfile(
      [privateProfile, publicProfile],
      { ...privateProfile, durationSecs: 840, updatedAt: 20 },
    );
    expect(updated).toHaveLength(2);
    expect(updated[0].durationSecs).toBe(840);
    expect(removeRespawnTimingProfile(updated, privateProfile.mob, "gukbottom", "private")).toEqual([
      publicProfile,
    ]);
  });

  it("normalizes long-name-only zones into stable keys", () => {
    expect(respawnZoneKey(null, "New Sebilis Expedition")).toBe("new-sebilis-expedition");
  });
});
