export type FeedbackKind = "bug" | "idea" | "missing-trigger";

const REPOSITORY_ISSUES_URL =
  "https://github.com/Menthule/legends-companion/issues/new";

const FORM_BY_KIND: Record<FeedbackKind, string> = {
  bug: "bug.yml",
  idea: "idea.yml",
  "missing-trigger": "missing-trigger.yml",
};

/** A privacy-safe platform label suitable for a public issue. */
export function feedbackPlatform(userAgent: string): string {
  const windows = /Windows NT ([0-9.]+)/i.exec(userAgent);
  if (windows) return `Windows (NT ${windows[1]})`;
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Unknown platform";
}

/**
 * Link straight to the selected issue form. GitHub maps query parameters to
 * form field IDs, so version and OS arrive prefilled but remain reviewable.
 */
export function feedbackUrl(
  kind: FeedbackKind,
  version: string,
  userAgent: string,
): string {
  const url = new URL(REPOSITORY_ISSUES_URL);
  url.searchParams.set("template", FORM_BY_KIND[kind]);
  url.searchParams.set("version", `v${version}`);
  url.searchParams.set("os", feedbackPlatform(userAgent));
  return url.toString();
}

/**
 * Explicitly excludes character names, log locations, log lines, and profile
 * data. The caller lets the player review this clipboard text before sharing.
 */
export function feedbackDiagnostics(
  version: string,
  userAgent: string,
  capturedAt = new Date(),
): string {
  return [
    `Legends Companion: v${version}`,
    `Platform: ${feedbackPlatform(userAgent)}`,
    `WebView: ${userAgent}`,
    `Captured: ${capturedAt.toISOString()}`,
  ].join("\n");
}
