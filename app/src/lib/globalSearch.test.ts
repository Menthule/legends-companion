import { describe, expect, it } from "vitest";
import { itemNavigationAction } from "./globalSearch";

describe("global item navigation", () => {
  it("reveals explicitly selected items without known drop sources", () => {
    expect(itemNavigationAction({ name: "Silvery Ring", sources: 0 })).toEqual({
      kind: "open-tab-search",
      tab: "drops",
      query: "Silvery Ring",
      revealUnsourced: true,
    });
  });

  it("preserves source filtering for sourced items", () => {
    expect(itemNavigationAction({ name: "Elegant Silvery Ring", sources: 1 }).revealUnsourced).toBe(false);
  });
});
