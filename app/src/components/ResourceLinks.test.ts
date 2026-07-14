import { describe, expect, it } from "vitest";
import { resourceUrls } from "./ResourceLinks";

describe("resourceUrls", () => {
  it("searches Allakhazam by item name instead of using a ProjectEQ item ID", () => {
    expect(resourceUrls("item", "Silvery Ring", 20700).zam).toBe(
      "https://everquest.allakhazam.com/search.html?q=Silvery%20Ring",
    );
  });

  it("keeps direct Allakhazam links for live spell IDs", () => {
    expect(resourceUrls("spell", "Tremor", 1234).zam).toBe(
      "https://everquest.allakhazam.com/db/spell.html?spell=1234",
    );
  });
});
