import { describe, expect, it } from "vitest";
import {
  feedbackDiagnostics,
  feedbackPlatform,
  feedbackUrl,
} from "./feedback";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

describe("feedback", () => {
  it("routes each report type to its dedicated form with safe prefills", () => {
    const url = new URL(feedbackUrl("missing-trigger", "3.0.3", WINDOWS_UA));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/Menthule/legends-companion/issues/new");
    expect(url.searchParams.get("template")).toBe("missing-trigger.yml");
    expect(url.searchParams.get("version")).toBe("v3.0.3");
    expect(url.searchParams.get("os")).toBe("Windows (NT 10.0)");
  });

  it("builds diagnostics without character, path, or log inputs", () => {
    const text = feedbackDiagnostics(
      "3.0.3",
      WINDOWS_UA,
      new Date("2026-07-20T05:00:00.000Z"),
    );
    expect(text).toContain("Legends Companion: v3.0.3");
    expect(text).toContain("Platform: Windows (NT 10.0)");
    expect(text).toContain("Captured: 2026-07-20T05:00:00.000Z");
    expect(text).not.toMatch(/character|log path|eqlog_/i);
  });

  it("uses a useful fallback for unfamiliar platforms", () => {
    expect(feedbackPlatform("UnusualWebView/1.0")).toBe("Unknown platform");
  });
});
