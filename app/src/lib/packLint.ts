// Pre-share pack lint: static portability checks over the triggers a user is
// about to export/share, surfaced as NON-BLOCKING warnings in the Share
// dialog. Everything here is heuristic and advisory — sharing always stays
// possible; the goal is that the string the guildmate pastes actually works
// on their machine (Rust regex engine, their character name, their disk).

import type { Trigger, TriggerAction } from "../types";
import { deriveId } from "../resolution";
import { escapeRegex } from "./patternJs";

export type LintRule =
  | "regex-lookaround"
  | "absolute-sound-path"
  | "hardcoded-character"
  | "hot-pattern-no-cooldown"
  | "timer-without-lane";

export interface LintFinding {
  rule: LintRule;
  /** Stable effective id of the trigger the finding is about. */
  triggerId: string;
  triggerName: string;
  /** One-line, user-facing description of the problem + what to do. */
  message: string;
}

/**
 * Lookaround constructs present in `pattern`: `(?=`, `(?!`, `(?<=`, `(?<!`.
 * JavaScript's RegExp (the editor preview) accepts these, but the app's
 * Rust `regex` engine has NO lookarounds — the trigger would fail to compile
 * on the importer's machine at pack load. Escaped parens (`\(`) and
 * characters inside a `[...]` class are not flagged; `(?P<name>` /
 * `(?<name>` named groups are not lookarounds and pass through.
 */
export function findLookarounds(pattern: string): string[] {
  const found: string[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch !== "(") continue;
    const rest = pattern.slice(i + 1);
    if (rest.startsWith("?<=")) found.push("(?<=");
    else if (rest.startsWith("?<!")) found.push("(?<!");
    else if (rest.startsWith("?=")) found.push("(?=");
    else if (rest.startsWith("?!")) found.push("(?!");
  }
  return found;
}

/** Windows drive (`C:\…`), UNC (`\\server\…`), or Unix (`/home/…`) absolute
 *  path — a sound file at such a path exists only on the exporter's disk. */
export function isAbsoluteLocalPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

/** Substrings of very high-frequency Legends combat/heal lines. A pattern
 *  mentioning one of these fires on melee-round cadence. */
const HOT_LINE_RES: RegExp[] = [
  /points? of damage/i,
  /\bhits\b/i,
  /\bslashes\b/i,
  /\bpierces\b/i,
  /\bcrushes\b/i,
  /\bbashes\b/i,
  /\bkicks\b/i,
  /\bhealed\b/i,
];

/**
 * Heuristic: would this pattern match at combat-spam frequency? True when it
 * mentions a known hot combat verb, or when it is unanchored (no leading
 * `^`) AND contains a broad wildcard (`.*` / `.+` / a `{S}`/`{N}` token) —
 * i.e. it substring-scans every log line with a catch-all in it.
 */
export function isHotPattern(pattern: string): boolean {
  if (HOT_LINE_RES.some((re) => re.test(pattern))) return true;
  const anchored = pattern.trimStart().startsWith("^");
  const broad = /\.\*|\.\+|\{[SsNn]\d*\}/.test(pattern);
  return !anchored && broad;
}

/** Speak/DisplayText templates of a trigger, for the character-name check. */
function textTemplates(actions: TriggerAction[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if ("Speak" in a) out.push(a.Speak.template);
    else if ("DisplayText" in a) out.push(a.DisplayText.template);
  }
  return out;
}

/**
 * Lint `triggers` before sharing. `characterName` is the active profile's
 * character (rule: a literal occurrence of it in a pattern/template almost
 * always meant the `{C}` placeholder — on the importer's machine the trigger
 * would still watch for the EXPORTER'S name). Pass null/"" to skip that rule.
 * All findings are warnings — never block the share.
 */
export function lintTriggersForShare(
  triggers: Trigger[],
  characterName: string | null | undefined,
): LintFinding[] {
  const findings: LintFinding[] = [];
  // Names shorter than 3 chars would false-positive on ordinary words.
  const charName = (characterName ?? "").trim();
  const nameRe =
    charName.length >= 3
      ? new RegExp(`(^|[^A-Za-z])${escapeRegex(charName)}([^A-Za-z]|$)`, "i")
      : null;

  for (const t of triggers) {
    const id = deriveId(t.id, t.category, t.name);
    const push = (rule: LintRule, message: string) =>
      findings.push({ rule, triggerId: id, triggerName: t.name, message });

    const lookarounds = [...new Set(findLookarounds(t.pattern))];
    if (lookarounds.length > 0) {
      push(
        "regex-lookaround",
        `pattern uses ${lookarounds.join(", ")} — the app's Rust regex engine has no lookarounds, so this trigger will fail to load for importers. Rewrite without lookarounds.`,
      );
    }

    for (const a of t.actions) {
      if ("PlaySound" in a && isAbsoluteLocalPath(a.PlaySound.path)) {
        push(
          "absolute-sound-path",
          `plays a sound from "${a.PlaySound.path}" — an absolute path on YOUR machine. Importers won't have that file; use a bundled sound or a relative path.`,
        );
      }
      if ("StartTimer" in a && a.StartTimer.lane == null) {
        push(
          "timer-without-lane",
          `timer "${a.StartTimer.name}" has no explicit lane — importers' overlays will guess (buff/enemy/other) from the category. Set a lane so it lands on the right overlay.`,
        );
      }
    }

    if (nameRe) {
      const inPattern = nameRe.test(t.pattern);
      const inTemplate = textTemplates(t.actions).some((tpl) => nameRe.test(tpl));
      if (inPattern || inTemplate) {
        const where =
          inPattern && inTemplate
            ? "pattern and alert text"
            : inPattern
              ? "pattern"
              : "alert text";
        push(
          "hardcoded-character",
          `${where} contains your character name "${charName}" literally — on an importer's machine it will still watch for ${charName}. Use the {C} token instead.`,
        );
      }
    }

    const cooldown = t.cooldown_secs ?? 0;
    if (!t.suppress && cooldown <= 0 && isHotPattern(t.pattern)) {
      push(
        "hot-pattern-no-cooldown",
        "pattern matches high-frequency combat text with no cooldown — importers could get an alert per hit. Set cooldown_secs to throttle refires.",
      );
    }
  }
  return findings;
}
