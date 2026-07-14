// Sharing v1 dialogs (NOW-sprint item 8): export a group/loadout to an LCS1
// string (with optional GINA .gtp export), and import a pasted string with a
// preview (count + categories) before committing.

import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { shareExport, shareExportGtp, shareImport } from "../api";
import {
  parseShareString,
  summarizeShare,
  type SharePreview,
} from "../lib/share";
import { IS_MOCK } from "../mock";
import type { ShareImportResult, Trigger } from "../types";
import Modal from "./Modal";

// ---------------------------------------------------------------------------
// Share (export) dialog
// ---------------------------------------------------------------------------

export interface ShareRequest {
  /** Bundle label carried in the string (group or loadout name). */
  name: string;
  /** Effective ids of the selected triggers (backend export). */
  ids: string[];
  /** Full trigger objects for the local/mock string builder. */
  triggers: Trigger[];
}

export function ShareDialog({
  request,
  onClose,
}: {
  request: ShareRequest;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    shareExport(request.name, request.ids, request.triggers)
      .then((s) => {
        if (!cancelled) setText(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied — paste it to your guild.");
    } catch {
      boxRef.current?.select();
      setNote("Press Ctrl+C to copy the selected string.");
    }
  }

  async function exportGtp() {
    setError(null);
    if (IS_MOCK) {
      setNote("GINA .gtp export needs the desktop app (mock mode).");
      return;
    }
    try {
      const path = await save({
        defaultPath: `${request.name.replace(/[^\w -]+/g, "").trim() || "triggers"}.gtp`,
        filters: [{ name: "GINA trigger package", extensions: ["gtp"] }],
      });
      if (typeof path !== "string") return;
      await shareExportGtp(request.name, request.ids, path);
      setNote("GINA package written. GINA users import it via File > Import.");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Modal label={`Share — ${request.name}`} onClose={onClose}>
        <div className="card-head">
          <span className="section-title">Share — {request.name}</span>
          <span className="hint num">
            {request.ids.length} trigger{request.ids.length === 1 ? "" : "s"}
          </span>
        </div>
        {error && <div className="error-banner qt-error">{error}</div>}
        {text === null && !error ? (
          <div className="hint">Building share string…</div>
        ) : (
          text !== null && (
            <>
              <textarea
                ref={boxRef}
                className="share-str"
                readOnly
                rows={5}
                value={text}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Share string"
              />
              <p className="hint">
                Anyone can paste this string into their Triggers tab
                (Import) — imported triggers keep their timers, sounds, and
                categories, and show a “shared” badge.
              </p>
            </>
          )
        )}
        {note && !error && <div className="status-banner">{note}</div>}
        <div className="editor-foot">
          <button className="primary" onClick={() => void copy()} disabled={!text}>
            Copy string
          </button>
          <button
            className="ghost"
            onClick={() => void exportGtp()}
            title="Write a GINA-compatible .gtp package (lossy: GINA has no lanes, classes, or level scaling)"
          >
            Save as GINA .gtp…
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import dialog (paste -> preview -> confirm)
// ---------------------------------------------------------------------------

const MAX_PREVIEW_CATEGORIES = 8;

export function ImportDialog({
  initialText,
  sourceName,
  onClose,
  onImported,
}: {
  /** Prefill (mock screenshot hook). */
  initialText?: string;
  /** Native package filename; replaces the paste field when present. */
  sourceName?: string;
  onClose: () => void;
  /** Called after a successful import with a human summary line. */
  onImported: (summary: string) => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parseNonce = useRef(0);

  // Live preview: parse (async — decompression) whenever the paste changes.
  useEffect(() => {
    const trimmed = text.trim();
    const nonce = ++parseNonce.current;
    if (trimmed.length === 0) {
      setPreview(null);
      setError(null);
      return;
    }
    parseShareString(trimmed)
      .then((payload) => {
        if (parseNonce.current !== nonce) return;
        setPreview(summarizeShare(payload));
        setError(null);
      })
      .catch((e) => {
        if (parseNonce.current !== nonce) return;
        setPreview(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [text]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result: ShareImportResult = await shareImport(text.trim());
      const renames =
        result.renamed.length > 0
          ? ` (${result.renamed.length} renamed to avoid id collisions)`
          : "";
      onImported(
        `Imported ${result.imported} shared trigger${
          result.imported === 1 ? "" : "s"
        }${renames}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const shownCategories = preview?.categories.slice(0, MAX_PREVIEW_CATEGORIES);

  return (
    <Modal
      label={sourceName ? "Review Companion package" : "Import shared triggers"}
      onClose={onClose}
    >
        <div className="card-head">
          <span className="section-title">
            {sourceName ? "Review Companion package" : "Import shared triggers"}
          </span>
        </div>
        {sourceName ? (
          <div className="import-file-source">
            <span className="import-file-name">{sourceName}</span>
            <span className="hint">Legends Companion trigger package</span>
          </div>
        ) : (
          <label className="field">
            <span>Paste a share string (starts with LCS1:)</span>
            <textarea
              className="share-str"
              rows={5}
              value={text}
              autoFocus
              placeholder="LCS1:…"
              onChange={(e) => setText(e.target.value)}
              aria-label="Share string to import"
            />
          </label>
        )}
        {error && text.trim().length > 0 && (
          <div className="error-banner qt-error">{error}</div>
        )}
        {preview && (
          <div className="import-preview">
            <div className="import-preview-title">
              {preview.name ? `“${preview.name}” — ` : ""}
              {preview.count} trigger{preview.count === 1 ? "" : "s"}
            </div>
            {shownCategories && shownCategories.length > 0 && (
              <div className="import-preview-cats">
                {shownCategories.map((c) => (
                  <span className="ted-chip" key={c}>
                    {c}
                  </span>
                ))}
                {preview.categories.length > MAX_PREVIEW_CATEGORIES && (
                  <span className="hint">
                    +{preview.categories.length - MAX_PREVIEW_CATEGORIES} more
                  </span>
                )}
              </div>
            )}
            <p className="hint">
              Imports into your custom triggers with a “shared” badge. Id
              collisions are renamed automatically — nothing gets overwritten.
            </p>
          </div>
        )}
        <div className="editor-foot">
          <button
            className="primary"
            disabled={!preview || busy}
            onClick={() => void confirm()}
          >
            {busy
              ? "Importing…"
              : preview
                ? `Import ${preview.count} trigger${preview.count === 1 ? "" : "s"}`
                : "Import"}
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
    </Modal>
  );
}
