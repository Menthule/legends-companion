// JS mirrors of the Rust trigger engine's text machinery
// (crates/eqlog-triggers/src/engine.rs) so the editor can preview matches
// and rendered actions without a backend round-trip. Keep in sync.

/** Escape a literal string for use inside a regex (JS metachar set). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inverse of `escapeRegex` for recognizer spans: drops one backslash from
 * every escape pair. Lenient by design — template `parse()` verifies every
 * result by rebuilding the pattern byte-for-byte, which catches spans that
 * were never plain escaped literals.
 */
export function unescapeRegex(s: string): string {
  return s.replace(/\\([\s\S])/g, "$1");
}

/**
 * Mirror of engine.rs::expand_pattern — expands GINA-style tokens in a
 * trigger *pattern* before compilation: `{C}` -> regex-escaped character
 * name, `{S}`/`{S1}`/... -> `(?P<S1>.+)`, `{N}`/`{N2}`/... -> `(?P<N2>\d+)`.
 * Tokens are case-insensitive; repeats become non-capturing so the pattern
 * still compiles.
 */
export function expandPatternJs(pattern: string, character: string): string {
  const seen = new Set<string>();
  return pattern.replace(/\{([CcSsNn]\d*)\}/g, (_m, raw: string) => {
    const upper = raw.toUpperCase();
    if (upper.startsWith("C")) return escapeRegex(character);
    if (upper.startsWith("S")) {
      if (!seen.has(upper)) {
        seen.add(upper);
        return `(?P<${upper}>.+)`;
      }
      return "(?:.+)";
    }
    if (!seen.has(upper)) {
      seen.add(upper);
      return `(?P<${upper}>\\d+)`;
    }
    return "(?:\\d+)";
  });
}

/** Rust regex named groups are `(?P<name>...)`; JS wants `(?<name>...)`. */
export function toJsRegexSource(pattern: string): string {
  return pattern.replace(/\(\?P</g, "(?<");
}

/**
 * Compile an (already token-expanded) pattern for the browser preview.
 * Throws like `new RegExp` on invalid syntax.
 */
export function compilePreviewRegex(
  expandedPattern: string,
  caseInsensitive: boolean,
): RegExp {
  return new RegExp(toJsRegexSource(expandedPattern), caseInsensitive ? "i" : "");
}

/**
 * Mirror of engine.rs::expand_template — renders an action template after a
 * match: `${1}` positional captures, `${name}` named captures (falling back
 * to the uppercased key, as GINA templates reference `{S1}` tokens by their
 * lowercase form), `{C}` character name, `{TS}` the line timestamp as
 * HH:MM:SS. Unknown/unmatched references render as "".
 */
export function expandTemplateJs(
  template: string,
  match: RegExpExecArray | null,
  character: string,
  timestampSecs: number,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const rest = template.slice(i);
    if (rest.startsWith("${")) {
      const close = rest.indexOf("}");
      if (close !== -1) {
        const key = rest.slice(2, close);
        if (key.length > 0) {
          let value: string | undefined;
          if (/^\d+$/.test(key)) {
            value = match?.[parseInt(key, 10)];
          } else {
            value =
              match?.groups?.[key] ?? match?.groups?.[key.toUpperCase()];
          }
          out += value ?? "";
          i += close + 1;
          continue;
        }
      }
    } else if (rest.startsWith("{C}") || rest.startsWith("{c}")) {
      out += character;
      i += 3;
      continue;
    } else if (rest.startsWith("{TS}") || rest.startsWith("{ts}")) {
      const secs = ((timestampSecs % 86_400) + 86_400) % 86_400;
      const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
      const mm = String(Math.floor(secs / 60) % 60).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      out += `${hh}:${mm}:${ss}`;
      i += 4;
      continue;
    }
    out += template[i];
    i += 1;
  }
  return out;
}

/** The 27-char EQ log timestamp prefix, e.g. `[Wed Jul 01 22:14:05 2026] `. */
const TS_PREFIX_RE =
  /^\[[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}\] /;

/** Strip the log timestamp prefix if present (engine matches message only). */
export function stripTimestamp(line: string): string {
  return line.replace(TS_PREFIX_RE, "");
}

// ---------------------------------------------------------------------------
// Duration input helpers ("90", "1:30", "35m", "1h10m" -> seconds)
// ---------------------------------------------------------------------------

/**
 * Parse a friendly duration string to whole (positive) seconds; null when
 * unparsable or non-positive. THE canonical parser (P37) — a superset of the
 * two that used to diverge, so nothing that parsed before stops parsing:
 * colon `h:mm:ss`/`m:ss` (folded), plain `90`, decimal+unit `1.5h`/`35m`/`90s`,
 * and compound `1h30m`/`2m30s`. `lib/timers` re-exports this one.
 */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  const positive = (n: number): number | null =>
    Number.isFinite(n) && n > 0 ? Math.round(n) : null;

  // Colon form (h:mm:ss / m:ss / deeper) — fold left; components must be
  // non-negative numbers.
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return positive(secs);
  }
  // Plain number (optional decimal) = seconds.
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return positive(Number(m[1]));
  // Single value + unit, decimals allowed: 90s, 35m, 1.5h.
  m = /^(\d+(?:\.\d+)?)\s*([hms])$/.exec(s);
  if (m) {
    const mult = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
    return positive(Number(m[1]) * mult);
  }
  // Compound integer units: 1h30m, 2m30s, 1h10m, 1h.
  m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s?)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) {
    return positive(
      (m[1] ? parseInt(m[1], 10) * 3600 : 0) +
        (m[2] ? parseInt(m[2], 10) * 60 : 0) +
        (m[3] ? parseInt(m[3], 10) : 0),
    );
  }
  return null;
}

/** Render seconds in words for the duration echo — "10" must read back as
 *  "10 seconds", not an ambiguous "0:10" (naive users type minutes). */
export function formatDurationWords(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = s % 60;
  if (h === 0 && m === 0) return ss === 1 ? "1 second" : `${ss} seconds`;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hr`);
  if (m > 0) parts.push(m === 1 ? "1 minute" : `${m} minutes`);
  if (ss > 0) parts.push(`${ss} sec`);
  return parts.join(" ");
}

/** Render seconds as `ss`, `m:ss`, or `h:mm:ss` (timer-bar style). */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  if (h > 0) {
    return `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(ss).padStart(2, "0")}`;
}
