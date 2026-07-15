import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { impactDefaultSize } from "../lib/impactSizing";
import { ImpactPresentation } from "./ImpactPresentation";

describe("Impact overlay default size", () => {
  it("uses half of a 1080p screen", () => {
    expect(impactDefaultSize(1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  it("stays usable on small and very large screens", () => {
    expect(impactDefaultSize(1280, 720)).toEqual({ width: 720, height: 420 });
    expect(impactDefaultSize(3840, 2160)).toEqual({ width: 1200, height: 720 });
  });
});

describe("Impact overlay presentation", () => {
  it("renders loot-chest treatment with trigger-provided text", () => {
    const markup = renderToStaticMarkup(
      createElement(ImpactPresentation, {
        payload: {
          id: 1,
          style: "loot-chest",
          headline: "YOU LOOTED",
          big: "Large Sky Sapphire",
          sub: "1/2 for Test of Wind",
          glyph: "+",
        },
      }),
    );

    expect(markup).toContain("impact-loot-chest");
    expect(markup).toContain("impact-intensity-high");
    expect(markup).toContain("ov-loot-chest");
    expect(markup).toContain("loot-chest-closed.webp");
    expect(markup).toContain("loot-chest-open.webp");
    expect(markup).toContain("ov-chest-flash");
    expect(markup).toContain("ov-chest-particles");
    expect(markup).toContain("YOU LOOTED");
    expect(markup).toContain("Large Sky Sapphire");
    expect(markup).toContain("1/2 for Test of Wind");
    expect(markup).toContain("ov-chest-glyph\">+");
  });

  it("renders monster-rip treatment with trigger-provided text", () => {
    const markup = renderToStaticMarkup(
      createElement(ImpactPresentation, {
        payload: {
          id: 2,
          style: "monster-rip",
          headline: "RIP",
          big: "Splitpaw assassin",
          sub: "3 remaining for Hollow Skull Quest",
        },
      }),
    );

    expect(markup).toContain("impact-monster-rip");
    expect(markup).toContain("ov-monster-rip");
    expect(markup).toContain("ov-rip-stone");
    expect(markup).toContain("ov-rip-glyph\">RIP");
    expect(markup).toContain("Splitpaw assassin");
  });
});
