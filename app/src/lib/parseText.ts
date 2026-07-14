// Paste-parse-to-chat (NOW-sprint item 9): a fight summary in EQ-paste
// format — "You: 2761 (38.3 DPS) | Torvin: 2210 (30.7 DPS) | …" — split into
// chat-safe lines of at most 240 characters. Used as the local formatter in
// mock mode and as the fallback when the paste_parse command is unavailable.

import { fmtDuration } from "./format";

/** EQ chat input is ~250 chars; stay comfortably under it. */
export const PARSE_CHUNK_LIMIT = 240;

export interface ParseRowInput {
  name: string;
  total: number;
  dps: number;
}

export interface ParseInput {
  /** The log owner's character name — their row is rendered as "You". */
  character: string;
  target: string;
  durationSecs: number;
  rows: ParseRowInput[];
}

/**
 * Format a fight for pasting into chat. Multiple lines when the roster
 * doesn't fit one 240-char message; every line stands alone.
 */
export function formatParse(input: ParseInput): string {
  const header = `${input.target} (${fmtDuration(input.durationSecs)}) - `;
  const entries = input.rows.map((r) => {
    const label =
      input.character &&
      r.name.toLowerCase() === input.character.toLowerCase()
        ? "You"
        : r.name;
    return `${label}: ${Math.round(r.total)} (${r.dps.toFixed(1)} DPS)`;
  });
  if (entries.length === 0) return header.trimEnd();

  const lines: string[] = [];
  let line = header + entries[0];
  for (const entry of entries.slice(1)) {
    const appended = `${line} | ${entry}`;
    if (appended.length > PARSE_CHUNK_LIMIT) {
      lines.push(line);
      line = entry;
    } else {
      line = appended;
    }
  }
  lines.push(line);
  return lines.join("\n");
}
