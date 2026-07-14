// Tests for the version-aware re-import mirrors (diff + update-in-place
// merge) in lib/share.ts. These mirror eqlog-triggers::share::{diff_triggers,
// merge_update_user_pack} — the Rust suite covers the canonical side; this
// one pins the TS mirror to the same semantics. Pure functions only (the
// build/parse string helpers need browser stream APIs and are exercised via
// the Rust round-trip + mock mode instead).

import { describe, expect, it } from "vitest";
import type { Trigger } from "../types";
import {
  changedTriggerFields,
  diffIncomingTriggers,
  mergeUpdateSharedTriggers,
} from "./share";

function trig(id: string, name: string, pattern: string, extra: Partial<Trigger> = {}): Trigger {
  return { name, pattern, enabled: true, actions: [], id, ...extra };
}

describe("changedTriggerFields", () => {
  it("is empty for semantically identical triggers regardless of source", () => {
    const a = trig("x", "X", "^x$", { source: "shared" });
    const b = trig("x", "X", "^x$", { source: "user" });
    expect(changedTriggerFields(a, b)).toEqual([]);
  });

  it("treats absent optional fields as their serde defaults", () => {
    const sparse = trig("x", "X", "^x$");
    const explicit = trig("x", "X", "^x$", {
      case_insensitive: true,
      default_enabled: true,
      classes: [],
      zones: [],
      priority: 0,
      suppress: false,
      cooldown_secs: null,
      category: null,
      comments: null,
    });
    expect(changedTriggerFields(sparse, explicit)).toEqual([]);
  });

  it("lists each differing semantic field by its Rust name", () => {
    const a = trig("x", "X", "^new$", { cooldown_secs: 5, classes: ["Cleric"] });
    const b = trig("x", "X", "^old$");
    expect(changedTriggerFields(a, b)).toEqual([
      "pattern",
      "classes",
      "cooldown_secs",
    ]);
  });

  it("compares actions with serde-skip canonicalization", () => {
    const withNulls = trig("x", "X", "^x$", {
      actions: [
        {
          StartTimer: {
            name: "SoW",
            duration_secs: 30,
            warn_at_secs: null,
            lane: null,
            stopwatch: false,
            rank_variants: {},
          },
        },
      ],
    });
    const sparse = trig("x", "X", "^x$", {
      actions: [{ StartTimer: { name: "SoW", duration_secs: 30, warn_at_secs: null } }],
    });
    expect(changedTriggerFields(withNulls, sparse)).toEqual([]);
    const different = trig("x", "X", "^x$", {
      actions: [{ StartTimer: { name: "SoW", duration_secs: 45, warn_at_secs: null } }],
    });
    expect(changedTriggerFields(different, sparse)).toEqual(["actions"]);
  });
});

describe("diffIncomingTriggers", () => {
  it("classifies added / changed / unchanged by stable id", () => {
    const incoming = [
      trig("pack/new", "New", "^n$"),
      trig("pack/changed", "Changed", "^new pattern$"),
      trig("pack/same", "Same", "^s$"),
    ];
    const existing = [
      trig("pack/changed", "Changed", "^old pattern$", { source: "shared" }),
      trig("pack/same", "Same", "^s$", { source: "shared" }),
    ];
    const entries = diffIncomingTriggers(incoming, existing);
    expect(entries.map((e) => [e.id, e.kind])).toEqual([
      ["pack/new", "added"],
      ["pack/changed", "changed"],
      ["pack/same", "unchanged"],
    ]);
    expect(entries[1].changedFields).toEqual(["pattern"]);
  });

  it("derives ids from category + name when no explicit id is set", () => {
    const incoming: Trigger[] = [
      { name: "Mez Broken", pattern: "^x$", enabled: true, actions: [], category: "CC" },
    ];
    const existing: Trigger[] = [
      { name: "Mez Broken", pattern: "^x$", enabled: true, actions: [], category: "CC" },
    ];
    expect(diffIncomingTriggers(incoming, existing)[0]).toMatchObject({
      id: "cc/mez-broken",
      kind: "unchanged",
    });
  });
});

describe("mergeUpdateSharedTriggers", () => {
  it("updates shared id matches in place, preserving position and id", () => {
    const userPack = [
      trig("mine", "Mine", "^m$", { source: "user" }),
      trig("pack/t", "Old name", "^old$", { source: "shared" }),
    ];
    const incoming = [trig("pack/t", "New name", "^new$"), trig("pack/extra", "Extra", "^e$")];
    const { pack, updated, added, renamed } = mergeUpdateSharedTriggers(
      incoming,
      userPack,
      new Set(),
    );
    expect(updated).toEqual(["pack/t"]);
    expect(added).toEqual(["pack/extra"]);
    expect(renamed).toEqual([]);
    expect(pack).toHaveLength(3);
    expect(pack[1]).toMatchObject({ id: "pack/t", name: "New name", source: "shared" });
    expect(pack[2]).toMatchObject({ id: "pack/extra", source: "shared" });
    // Input array untouched (mock state is replaced, not mutated).
    expect(userPack[1].name).toBe("Old name");
  });

  it("renames collisions with user triggers and external (bundled) ids", () => {
    const userPack = [trig("mine", "Mine", "^m$", { source: "user" })];
    const incoming = [trig("mine", "Mine v2", "^m2$"), trig("bundled/x", "X", "^x$")];
    const { pack, updated, renamed } = mergeUpdateSharedTriggers(
      incoming,
      userPack,
      new Set(["bundled/x"]),
    );
    expect(updated).toEqual([]);
    expect(renamed).toEqual([
      ["mine", "mine-2"],
      ["bundled/x", "bundled/x-2"],
    ]);
    expect(pack[0]).toMatchObject({ name: "Mine", source: "user" }); // untouched
    expect(pack.map((t) => t.id)).toEqual(["mine", "mine-2", "bundled/x-2"]);
  });

  it("updates a duplicated incoming id once, then falls back to rename", () => {
    const userPack = [trig("pack/t", "Old", "^old$", { source: "shared" })];
    const incoming = [trig("pack/t", "First", "^1$"), trig("pack/t", "Second", "^2$")];
    const { pack, updated, renamed } = mergeUpdateSharedTriggers(incoming, userPack, new Set());
    expect(updated).toEqual(["pack/t"]);
    expect(renamed).toEqual([["pack/t", "pack/t-2"]]);
    expect(pack[0].name).toBe("First");
    expect(pack[1].id).toBe("pack/t-2");
  });
});
