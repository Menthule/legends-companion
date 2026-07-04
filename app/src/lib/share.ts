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

/** What travels inside a share string (serde shape of SharePayload). */
export interface SharePayload {
  name?: string | null;
  triggers: Trigger[];
}

/** Import-preview summary shown before the user confirms. */
export interface SharePreview {
  name: string | null;
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
    count: payload.triggers.length,
    categories,
  };
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
