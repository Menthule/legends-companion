// Sharing v1 (NOW-sprint item 8), browser side. Mirrors
// crates/eqlog-triggers/src/share.rs: a share string is
// "LCS1:" + base64(deflate(json)) where json is { name?, triggers: [...] }.
//
// The Rust side uses raw DEFLATE (flate2 DeflateEncoder) and standard padded
// base64. Browsers can produce/consume exactly that via
// CompressionStream/DecompressionStream("deflate-raw"), so strings built here
// round-trip with the CLI and the desktop backend. When the streams API is
// unavailable we fall back to uncompressed base64(json) — parseShareString
// (and only ours) accepts that form too, so mock-mode demos stay coherent.

import type { Trigger } from "../types";
import { deriveId } from "../resolution";

export const SHARE_PREFIX = "LCS1:";

/** What travels inside a share string (serde shape of SharePayload). The
 *  version/author/notes metadata is additive — absent on v1 strings and
 *  omitted when unset, so the wire prefix stays LCS1. */
export interface SharePayload {
  name?: string | null;
  /** Pack version label ("1.2", a date, …) for version-aware re-import. */
  version?: string | null;
  author?: string | null;
  notes?: string | null;
  triggers: Trigger[];
}

/** Import-preview summary shown before the user confirms. */
export interface SharePreview {
  name: string | null;
  version: string | null;
  author: string | null;
  notes: string | null;
  count: number;
  /** Unique category paths, sorted; "(uncategorized)" for blank. */
  categories: string[];
}

/** Inflated-payload safety cap, mirroring the Rust side (32 MiB). */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// base64 (standard alphabet, padded) over Uint8Array
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// deflate via the Streams API
// ---------------------------------------------------------------------------

async function pumpThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(
    transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function tryDeflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await pumpThrough(bytes, new CompressionStream("deflate-raw"));
  } catch {
    return null; // Streams API or format unavailable in this browser
  }
}

async function tryInflate(
  bytes: Uint8Array,
  format: CompressionFormat,
): Promise<Uint8Array | null> {
  try {
    return await pumpThrough(bytes, new DecompressionStream(format));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Serialize a payload to a single-line LCS1 share string. */
export async function buildShareString(payload: SharePayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await tryDeflateRaw(json);
  return SHARE_PREFIX + bytesToBase64(compressed ?? json);
}

/**
 * Decode a share string. Tolerates surrounding whitespace and line breaks
 * inside the base64 (chat clients wrap long pastes). Throws Error with a
 * user-facing message on anything malformed.
 */
export async function parseShareString(input: string): Promise<SharePayload> {
  const squashed = input.replace(/\s+/g, "");
  if (!squashed.startsWith(SHARE_PREFIX)) {
    throw new Error(
      "Not a Legends Companion share string (expected it to start with LCS1:).",
    );
  }
  let body: Uint8Array;
  try {
    body = base64ToBytes(squashed.slice(SHARE_PREFIX.length));
  } catch {
    throw new Error("Share string is damaged (invalid base64).");
  }
  // Uncompressed JSON fallback first (mock-built strings), then raw deflate
  // (the real wire format), then zlib/gzip for good measure.
  let json: Uint8Array | null = body[0] === 0x7b /* '{' */ ? body : null;
  if (json === null) json = await tryInflate(body, "deflate-raw");
  if (json === null) json = await tryInflate(body, "deflate");
  if (json === null) json = await tryInflate(body, "gzip");
  if (json === null) {
    throw new Error("Share string payload failed to decompress.");
  }
  if (json.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Share string payload is unreasonably large.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error("Share string payload is not valid JSON.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as SharePayload).triggers)
  ) {
    throw new Error("Share string payload has an unexpected shape.");
  }
  return payload as SharePayload;
}

/** Summarize a decoded payload for the import-preview dialog. */
export function summarizeShare(payload: SharePayload): SharePreview {
  const categories = [
    ...new Set(
      payload.triggers.map((t) => t.category?.trim() || "(uncategorized)"),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return {
    name: payload.name ?? null,
    version: payload.version ?? null,
    author: payload.author ?? null,
    notes: payload.notes ?? null,
    count: payload.triggers.length,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Version-aware re-import: per-trigger diff + update-in-place merge.
// TS mirrors of eqlog-triggers::share::{diff_triggers, merge_update_user_pack}
// — the Rust side is canonical (the desktop import command runs it); these
// drive the import dialog's diff preview and mock mode. Keep in sync.
// ---------------------------------------------------------------------------

export type ShareDiffKind = "added" | "changed" | "unchanged";

export interface ShareDiffEntry {
  /** Stable effective id. */
  id: string;
  name: string;
  kind: ShareDiffKind;
  /** Semantic fields that differ (kind "changed" only). */
  changedFields: string[];
}

/**
 * Canonicalize a JSON value the way serde round-trips it for Rust equality:
 * keys sorted, and values serde would skip (null/undefined, `false` booleans,
 * empty arrays/objects — every optional Action field uses
 * `skip_serializing_if` with exactly those defaults) dropped. Lets a payload
 * that omits `warn_at_secs` compare equal to a stored trigger carrying
 * `warn_at_secs: null`.
 */
function canonValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = canonValue((v as Record<string, unknown>)[k]);
      if (val === null || val === undefined || val === false) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      if (
        typeof val === "object" &&
        !Array.isArray(val) &&
        Object.keys(val as object).length === 0
      ) {
        continue;
      }
      out[k] = val;
    }
    return out;
  }
  return v;
}

function canonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonValue(a)) === JSON.stringify(canonValue(b));
}

/**
 * The semantic fields that differ between two same-id triggers, with the
 * Trigger-level serde defaults applied so presence/absence of an optional
 * key never reads as a change. Field names match the Rust side's
 * `changed_fields` exactly. `id` and `source` are deliberately excluded.
 */
export function changedTriggerFields(a: Trigger, b: Trigger): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push("name");
  if (a.pattern !== b.pattern) out.push("pattern");
  if ((a.enabled ?? true) !== (b.enabled ?? true)) out.push("enabled");
  if (!canonEq(a.actions, b.actions)) out.push("actions");
  if ((a.category ?? null) !== (b.category ?? null)) out.push("category");
  if ((a.comments ?? null) !== (b.comments ?? null)) out.push("comments");
  if ((a.case_insensitive ?? true) !== (b.case_insensitive ?? true)) {
    out.push("case_insensitive");
  }
  if (!canonEq(a.classes ?? [], b.classes ?? [])) out.push("classes");
  if ((a.default_enabled ?? true) !== (b.default_enabled ?? true)) {
    out.push("default_enabled");
  }
  if ((a.cooldown_secs ?? null) !== (b.cooldown_secs ?? null)) {
    out.push("cooldown_secs");
  }
  if ((a.priority ?? 0) !== (b.priority ?? 0)) out.push("priority");
  if ((a.suppress ?? false) !== (b.suppress ?? false)) out.push("suppress");
  if (!canonEq(a.zones ?? [], b.zones ?? [])) out.push("zones");
  return out;
}

/**
 * Classify each incoming trigger against `existing` by stable id (payload
 * order preserved). Scope `existing` to the triggers an update could replace
 * — the dialog passes the user pack's Shared-source triggers. (The Rust
 * diff also reports `removed` rows for the reverse direction; the dialog
 * doesn't show removals, so this mirror skips them.)
 */
export function diffIncomingTriggers(
  incoming: Trigger[],
  existing: Trigger[],
): ShareDiffEntry[] {
  const byId = new Map<string, Trigger>();
  for (const t of existing) {
    const id = deriveId(t.id, t.category, t.name);
    if (!byId.has(id)) byId.set(id, t);
  }
  return incoming.map((t) => {
    const id = deriveId(t.id, t.category, t.name);
    const prior = byId.get(id);
    if (!prior) return { id, name: t.name, kind: "added", changedFields: [] };
    const changedFields = changedTriggerFields(t, prior);
    return {
      id,
      name: t.name,
      kind: changedFields.length > 0 ? "changed" : "unchanged",
      changedFields,
    };
  });
}

/**
 * Mock-mode mirror of eqlog-triggers::share::merge_update_user_pack: replace
 * matching Shared-source triggers in place by stable id (preserving position
 * — per-id user overrides keep binding), rename-append everything else that
 * collides (`externalIds` = ids outside the user pack, e.g. bundled packs),
 * and append the rest. Every incoming trigger is stamped source "shared".
 */
export function mergeUpdateSharedTriggers(
  incoming: Trigger[],
  userPack: Trigger[],
  externalIds: Set<string>,
): {
  pack: Trigger[];
  updated: string[];
  added: string[];
  renamed: [string, string][];
} {
  const pack = [...userPack];
  const sharedAt = new Map<string, number>();
  const taken = new Set(externalIds);
  pack.forEach((t, i) => {
    const id = deriveId(t.id, t.category, t.name);
    if (t.source === "shared" && !sharedAt.has(id)) sharedAt.set(id, i);
    taken.add(id);
  });
  const updated: string[] = [];
  const added: string[] = [];
  const renamed: [string, string][] = [];
  for (const t of incoming) {
    const stamped: Trigger = { ...t, source: "shared" };
    const id = deriveId(t.id, t.category, t.name);
    const at = sharedAt.get(id);
    if (at !== undefined) {
      sharedAt.delete(id); // a duplicate id in the paste falls to rename
      pack[at] = stamped;
      updated.push(id);
      continue;
    }
    let assigned = id;
    for (let n = 2; taken.has(assigned); n++) assigned = `${id}-${n}`;
    if (assigned !== id) {
      stamped.id = assigned;
      renamed.push([id, assigned]);
    }
    taken.add(assigned);
    added.push(assigned);
    pack.push(stamped);
  }
  return { pack, updated, added, renamed };
}

/**
 * Mock-mode import merge: stamps every trigger `source: "shared"` and
 * resolves effective-id collisions (against `existingIds` and within the
 * paste) by assigning the first free explicit "<id>-2"/"-3"… id — the same
 * policy as eqlog-triggers::share::parse_string.
 */
export function dedupeSharedTriggers(
  payload: SharePayload,
  existingIds: Set<string>,
): { triggers: Trigger[]; renamed: [string, string][] } {
  const taken = new Set(existingIds);
  const renamed: [string, string][] = [];
  const triggers = payload.triggers.map((t) => {
    const wanted = deriveId(t.id, t.category, t.name);
    let id = wanted;
    for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`;
    if (id !== wanted) renamed.push([wanted, id]);
    taken.add(id);
    const next: Trigger = { ...t, source: "shared" };
    if (id !== wanted || t.id) next.id = id;
    return next;
  });
  return { triggers, renamed };
}
