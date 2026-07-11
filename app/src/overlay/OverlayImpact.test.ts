import { describe, expect, it } from "vitest";
import { impactDefaultSize } from "../lib/impactSizing";

describe("Impact overlay default size", () => {
  it("uses half of a 1080p screen", () => {
    expect(impactDefaultSize(1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  it("stays usable on small and very large screens", () => {
    expect(impactDefaultSize(1280, 720)).toEqual({ width: 720, height: 420 });
    expect(impactDefaultSize(3840, 2160)).toEqual({ width: 1200, height: 720 });
  });
});
