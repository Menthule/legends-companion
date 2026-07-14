// Sharing v1 dialogs (NOW-sprint item 8): export a group/loadout to an LCS1
// string (with optional GINA .gtp export), and import a pasted string with a
// preview (count + categories) before committing.

import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { getProfile, getTriggers, shareExport, shareExportGtp, shareImport } from "../api";
import { lintTriggersForShare, type LintFinding } from "../lib/packLint";
import {
  diffIncomingTriggers,
  parseShareString,
  summarizeShare,
  type SharePayload,
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

const MAX_LINT_SHOWN = 8;

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
  const [lint, setLint] = useState<LintFinding[]>([]);
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
    // Portability lint over the selected triggers — advisory only, never
    // blocks the share. The active character name feeds the {C} check.
    getProfile()
      .then((p) => p.character)
      .catch(() => "")
      .then((character) => {
        if (!cancelled) setLint(lintTriggersForShare(request.triggers, character));
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
              {lint.length > 0 && (
                <div className="share-lint" role="note">
                  <div className="share-lint-title">
                    {lint.length} portability warning
                    {lint.length === 1 ? "" : "s"} — the string works, but
                    importers may hit these:
                  </div>
                  <ul className="share-lint-list">
                    {lint.slice(0, MAX_LINT_SHOWN).map((f, i) => (
                      <li key={`${f.triggerId}-${f.rule}-${i}`}>
                        <span className="share-lint-name">{f.triggerName}</span>{" "}
                        {f.message}
                      </li>
                    ))}
                  </ul>
                  {lint.length > MAX_LINT_SHOWN && (
                    <div className="hint">
                      +{lint.length - MAX_LINT_SHOWN} more warning
                      {lint.length - MAX_LINT_SHOWN === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
              )}
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
const MAX_DIFF_SHOWN = 6;

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
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"update" | "copies">("update");
  const [installedShared, setInstalledShared] = useState<Trigger[] | null>(null);
  const parseNonce = useRef(0);

  // The already-installed Shared-source triggers, for the re-import diff.
  useEffect(() => {
    let cancelled = false;
    getTriggers()
      .then((all) => {
        if (!cancelled) {
          setInstalledShared(all.filter((t) => t.source === "shared"));
        }
      })
      .catch(() => {
        if (!cancelled) setInstalledShared([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live preview: parse (async — decompression) whenever the paste changes.
  useEffect(() => {
    const trimmed = text.trim();
    const nonce = ++parseNonce.current;
    if (trimmed.length === 0) {
      setPreview(null);
      setPayload(null);
      setError(null);
      return;
    }
    parseShareString(trimmed)
      .then((parsed) => {
        if (parseNonce.current !== nonce) return;
        setPreview(summarizeShare(parsed));
        setPayload(parsed);
        setError(null);
      })
      .catch((e) => {
        if (parseNonce.current !== nonce) return;
        setPreview(null);
        setPayload(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [text]);

  // Per-trigger diff against installed Shared triggers (stable-id keyed).
  // Non-null only when >=1 incoming id already exists as a Shared trigger —
  // that's when "Update in place" vs "Import as copies" is a real choice.
  const diff = useMemo(() => {
    if (!payload || !installedShared || installedShared.length === 0) return null;
    const entries = diffIncomingTriggers(payload.triggers, installedShared);
    return entries.some((e) => e.kind !== "added") ? entries : null;
  }, [payload, installedShared]);
  const diffCounts = useMemo(() => {
    if (!diff) return null;
    return {
      added: diff.filter((e) => e.kind === "added").length,
      changed: diff.filter((e) => e.kind === "changed").length,
      unchanged: diff.filter((e) => e.kind === "unchanged").length,
    };
  }, [diff]);
  const changedEntries = diff?.filter((e) => e.kind === "changed") ?? [];

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const updateInPlace = diff !== null && mode === "update";
      const result: ShareImportResult = await shareImport(
        text.trim(),
        updateInPlace,
      );
      const updates =
        result.updated > 0 ? ` (${result.updated} updated in place)` : "";
      const renames =
        result.renamed.length > 0
          ? ` (${result.renamed.length} renamed to avoid id collisions)`
          : "";
      onImported(
        `Imported ${result.imported} shared trigger${
          result.imported === 1 ? "" : "s"
        }${updates}${renames}.`,
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
            {(preview.version || preview.author) && (
              <div className="import-preview-meta hint">
                {preview.version ? `v${preview.version}` : ""}
                {preview.version && preview.author ? " · " : ""}
                {preview.author ? `by ${preview.author}` : ""}
              </div>
            )}
            {preview.notes && (
              <div className="import-preview-notes hint">{preview.notes}</div>
            )}
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
            {diff && diffCounts ? (
              <div className="import-diff">
                <div className="import-diff-title">
                  You already have {diffCounts.changed + diffCounts.unchanged}{" "}
                  of these as shared triggers
                  {preview.version ? ` (this paste is v${preview.version})` : ""}
                  :
                </div>
                <div className="import-diff-counts num">
                  {diffCounts.added} new · {diffCounts.changed} changed ·{" "}
                  {diffCounts.unchanged} unchanged
                </div>
                {changedEntries.length > 0 && (
                  <ul className="import-diff-list">
                    {changedEntries.slice(0, MAX_DIFF_SHOWN).map((e) => (
                      <li key={e.id}>
                        <span className="import-diff-name">{e.name}</span>{" "}
                        <span className="hint">
                          {e.changedFields.join(", ")}
                        </span>
                      </li>
                    ))}
                    {changedEntries.length > MAX_DIFF_SHOWN && (
                      <li className="hint">
                        +{changedEntries.length - MAX_DIFF_SHOWN} more changed
                      </li>
                    )}
                  </ul>
                )}
                <div className="import-mode" role="radiogroup" aria-label="Import mode">
                  <label className="import-mode-option">
                    <input
                      type="radio"
                      name="import-mode"
                      checked={mode === "update"}
                      onChange={() => setMode("update")}
                    />
                    <span>
                      <b>Update in place</b> — replace your copies with this
                      version. Your per-trigger settings (enables, voice/alert
                      overrides) stay: they follow the trigger id.
                    </span>
                  </label>
                  <label className="import-mode-option">
                    <input
                      type="radio"
                      name="import-mode"
                      checked={mode === "copies"}
                      onChange={() => setMode("copies")}
                    />
                    <span>
                      <b>Import as copies</b> — keep your current versions and
                      add renamed duplicates (-2/-3 ids).
                    </span>
                  </label>
                </div>
              </div>
            ) : (
              <p className="hint">
                Imports into your custom triggers with a “shared” badge. Id
                collisions are renamed automatically — nothing gets
                overwritten.
              </p>
            )}
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
                ? `${diff && mode === "update" ? "Update" : "Import"} ${preview.count} trigger${preview.count === 1 ? "" : "s"}`
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
