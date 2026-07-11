import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  confirmDiscard,
  getProfile,
  getTriggers,
  getTriggerTree,
  importGina,
  onTriggersChanged,
  saveTriggers,
  setChannelOverride,
  setOverride,
  setProfile,
  setSeverityOverride,
  shareExport,
} from "../api";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  activeLoadout,
  deriveId,
  pathHasPrefix,
  slugifyPath,
  updateActiveLoadout,
} from "../resolution";
import {
  CLASS_NAMES,
  type CharacterProfile,
  type PackWarningsPayload,
  type Trigger,
  type TriggerAction,
  type TriggerTreeEntry,
} from "../types";
import { buildShareString, parseShareString } from "../lib/share";
import { getOverlayDefinition } from "../lib/overlayRegistry";
import Empty from "./Empty";
import { savedLocation } from "./QuickTriggerModal";
import { ImportDialog, ShareDialog, type ShareRequest } from "./ShareDialogs";
import TriggerEditor from "./TriggerEditor";

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

interface TreeNode {
  /** Unique key for expansion state — the display path. */
  key: string;
  label: string;
  /** Category-path prefix for profile overrides; null in the Custom subtree. */
  overridePath: string | null;
  /** True for the Custom subtree (user/gina triggers, toggled via `enabled`). */
  custom: boolean;
  children: TreeNode[];
  items: TriggerTreeEntry[];
  total: number;
  on: number;
}

// ---------------------------------------------------------------------------
// Pack-warning dismissal persistence: the backend re-emits the same warning
// set on every engine build (i.e. every launch), so "Dismiss" stores a
// fingerprint of the dismissed set — identical warnings stay quiet across
// sessions, while any new or changed warning surfaces again.
// ---------------------------------------------------------------------------

const WARN_DISMISS_KEY = "eqlogs.packWarnings.dismissed";

/** Order-insensitive djb2 fingerprint of the warning messages. */
function warningsFingerprint(messages: string[]): string {
  const joined = [...messages].sort().join("\0");
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  }
  return `${messages.length}:${h}`;
}

function isWarningsDismissed(messages: string[]): boolean {
  try {
    return (
      window.localStorage.getItem(WARN_DISMISS_KEY) ===
      warningsFingerprint(messages)
    );
  } catch {
    return false;
  }
}

function rememberWarningsDismissed(messages: string[]): void {
  try {
    window.localStorage.setItem(WARN_DISMISS_KEY, warningsFingerprint(messages));
  } catch {
    // storage unavailable — dismissal just won't survive a restart
  }
}

const TOP_ORDER = ["Universal", "Enemy Casts", "Class", "Buffs", "Custom"];

function newNode(key: string, label: string, custom: boolean): TreeNode {
  return {
    key,
    label,
    overridePath: custom ? null : key,
    custom,
    children: [],
    items: [],
    total: 0,
    on: 0,
  };
}

function childNode(parent: TreeNode, seg: string, custom: boolean): TreeNode {
  const found = parent.children.find(
    (c) => c.label.toLowerCase() === seg.toLowerCase(),
  );
  if (found) return found;
  const node = newNode(`${parent.key}/${seg}`, seg, custom || parent.custom);
  parent.children.push(node);
  return node;
}

function topOrder(label: string): number {
  const i = TOP_ORDER.findIndex((t) => t.toLowerCase() === label.toLowerCase());
  return i === -1 ? TOP_ORDER.length : i;
}

function buildTree(entries: TriggerTreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const e of entries) {
    const isCustom = e.userIndex !== null;
    let segs = (e.category ?? "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (isCustom) {
      // User triggers live under Custom; don't double a literal "Custom".
      if (segs[0]?.toLowerCase() === "custom") segs = segs.slice(1);
      segs = ["Custom", ...segs];
    } else if (segs.length === 0) {
      segs = ["Uncategorized"];
    }
    let node = roots.find(
      (r) => r.label.toLowerCase() === segs[0].toLowerCase(),
    );
    if (!node) {
      node = newNode(segs[0], segs[0], isCustom);
      roots.push(node);
    }
    for (const seg of segs.slice(1)) node = childNode(node, seg, isCustom);
    node.items.push(e);
  }
  for (const n of roots) aggregate(n);
  return roots.sort(
    (a, b) =>
      topOrder(a.label) - topOrder(b.label) || a.label.localeCompare(b.label),
  );
}

function aggregate(node: TreeNode): void {
  node.children.sort((a, b) => a.label.localeCompare(b.label));
  node.total = node.items.length;
  node.on = node.items.filter((e) => e.effectiveEnabled).length;
  for (const c of node.children) {
    aggregate(c);
    node.total += c.total;
    node.on += c.on;
  }
}

function collectItems(node: TreeNode, out: TriggerTreeEntry[] = []): TriggerTreeEntry[] {
  out.push(...node.items);
  for (const c of node.children) collectItems(c, out);
  return out;
}

function collectNodeKeys(nodes: TreeNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    out.add(node.key);
    collectNodeKeys(node.children, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editor state — the form itself lives in the shared TriggerEditor
// ---------------------------------------------------------------------------

interface EditingState {
  /** Index into the user pack; null = new trigger. */
  index: number | null;
  trigger: Trigger | null;
  /** Optional test-box prefill (mock demo). */
  line?: string;
}

type TriggerIntent = "speak" | "alert" | "sound" | "timer" | "effect";
type TriggerFilter = "all" | "mine" | "enabled" | "tts" | "alerts" | "timers" | "disabled";

/** Mock-only demo hook: ?editordemo=1 opens the editor prefilled. */
const EDITOR_DEMO: string | null = IS_MOCK
  ? new URLSearchParams(window.location.search).get("editordemo")
  : null;

/** Mock-only: ?sharedemo=1 opens the share dialog on the first top group;
 *  ?importdemo=1 opens the import dialog prefilled with a real string. */
const SHARE_DEMO: boolean = IS_MOCK
  ? new URLSearchParams(window.location.search).get("sharedemo") === "1"
  : false;
const IMPORT_DEMO: boolean = IS_MOCK
  ? new URLSearchParams(window.location.search).get("importdemo") === "1"
  : false;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function stripLineTimestamp(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function firstClause(s: string): string {
  return s.split(/[.,(]/)[0].trim();
}

function regexForLine(line: string): string {
  const stripped = stripLineTimestamp(line);
  if (!stripped) return ".*";
  return stripped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function simpleTrigger(intent: TriggerIntent, line: string): Trigger | null {
  const message = stripLineTimestamp(line);
  if (!message) return null;
  const label = firstClause(message).slice(0, 48) || "New trigger";
  const pattern = regexForLine(message);
  const common = {
    name: label,
    pattern,
    enabled: true,
    case_insensitive: true,
    category: "Custom",
    source: "user" as const,
  };
  switch (intent) {
    case "speak":
      return { ...common, actions: [{ Speak: { template: label } }] };
    case "alert":
      return {
        ...common,
        actions: [
          {
            Overlay: {
              overlay: "alerts",
              fields: { text: label },
              config: { severity: "info" },
            },
          },
        ],
      };
    case "sound":
      return {
        ...common,
        actions: [
          {
            Overlay: {
              overlay: "alerts",
              fields: { text: label },
              config: { severity: "info" },
            },
          },
          { PlaySound: { path: "" } },
        ],
      };
    case "timer":
      return {
        ...common,
        actions: [
          {
            StartTimer: {
              name: label,
              duration_secs: 30,
              warn_at_secs: null,
            },
          },
        ],
      };
    case "effect":
      return {
        ...common,
        name: `Effect: ${label}`,
        actions: [
          {
            Overlay: {
              overlay: "alerts",
              fields: { text: `Effect: ${label}` },
              config: { severity: "info" },
            },
          },
        ],
      };
  }
}

/** Checkbox with an indeterminate ("partial") third display state. */
function TriState({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="tree-check"
      checked={checked}
      onChange={onChange}
      aria-label={label}
    />
  );
}

/** Searchable class picker backed by a shared <datalist>. */
function ClassPicker({
  value,
  slot,
  onCommit,
}: {
  value: string;
  slot: number;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  function commit(raw: string) {
    const v = raw.trim();
    if (v === "") {
      if (value !== "") onCommit("");
      else setText("");
      return;
    }
    const match = CLASS_NAMES.find((c) => c.toLowerCase() === v.toLowerCase());
    if (match) {
      if (match !== value) onCommit(match);
      else setText(match);
    } else {
      setText(value); // invalid: revert
    }
  }

  return (
    <input
      type="text"
      className="class-pick"
      list="eq-class-list"
      placeholder={`Class ${slot + 1}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
      }}
      aria-label={`Class ${slot + 1}`}
    />
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export default function TriggersTab({
  character,
  searchRequest,
}: {
  character?: string;
  searchRequest?: { query: string; seq: number } | null;
}) {
  const [entries, setEntries] = useState<TriggerTreeEntry[] | null>(null);
  const [profile, setProfileState] = useState<CharacterProfile | null>(null);
  const [userTriggers, setUserTriggers] = useState<Trigger[]>([]);
  const [editor, setEditor] = useState<EditingState | null>(null);
  const [starterOpen, setStarterOpen] = useState(false);
  const [starterIntent, setStarterIntent] = useState<TriggerIntent>("alert");
  const [starterLine, setStarterLine] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editorNonce, setEditorNonce] = useState(0);
  const [query, setQuery] = useState("");
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedSeeded = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{
    message: string;
    undo: () => void;
  } | null>(null);
  const demoSeeded = useRef(false);
  /** Pack-load warnings pushed by the backend (amber dismissible banner). */
  const [packWarnings, setPackWarnings] = useState<string[]>([]);
  const [warnOpen, setWarnOpen] = useState(false);
  /** Sharing v1 dialogs. */
  const [share, setShare] = useState<ShareRequest | null>(null);
  const [importing, setImporting] = useState<{ initialText?: string } | null>(
    null,
  );
  const shareDemoSeeded = useRef(false);

  useEffect(() => {
    if (searchRequest?.query) setQuery(searchRequest.query);
  }, [searchRequest?.seq]);

  useTauriEvent<PackWarningsPayload>("pack-warnings", (p) => {
    // Backend emits { count, messages } on every engine build; count 0
    // (empty messages) clears a stale banner. A dismissed warning SET stays
    // dismissed across sessions (fingerprint match) — the same broken
    // trigger must not re-nag on every launch — but any new/changed warning
    // surfaces again.
    const messages = Array.isArray(p.messages) ? p.messages : [];
    if (messages.length > 0 && isWarningsDismissed(messages)) {
      setPackWarnings([]);
      return;
    }
    setPackWarnings(messages);
  });

  useEffect(() => {
    const refresh = () => {
      Promise.all([getTriggerTree(), getProfile(), getTriggers()])
        .then(([tree, prof, user]) => {
          setEntries(tree);
          setProfileState(prof);
          setUserTriggers(user);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    };
    refresh();
    // Stay in sync when triggers/profile are saved elsewhere (quick-trigger
    // modal on the Live tab, our own override writes).
    return onTriggersChanged(refresh);
  }, [character]);

  const tree = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    const shown = entries.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q) && !e.pattern.toLowerCase().includes(q)) {
        return false;
      }
      switch (triggerFilter) {
        case "mine":
          return e.userIndex !== null;
        case "enabled":
          return e.effectiveEnabled;
        case "tts":
          return e.speaks;
        case "alerts":
          return e.shows;
        case "timers":
          return e.timer;
        case "disabled":
          return !e.effectiveEnabled;
        case "all":
          return true;
      }
    });
    return buildTree(shown);
  }, [entries, query, triggerFilter]);

  // First load: expand the top-level groups (plus the first group's
  // children, so actual trigger rows are visible immediately) — deeper
  // levels stay collapsed (big generated packs lazy-render on expand).
  useEffect(() => {
    if (expandedSeeded.current || !entries) return;
    expandedSeeded.current = true;
    const roots = buildTree(entries);
    const keys = roots.map((n) => n.key);
    if (roots[0]) keys.push(...roots[0].children.map((c) => c.key));
    setExpanded(new Set(keys));
  }, [entries]);

  const searching = query.trim().length > 0;
  const totalOn = entries?.filter((e) => e.effectiveEnabled).length ?? 0;

  // Undo toast auto-dismiss.
  useEffect(() => {
    if (!undoToast) return;
    const h = window.setTimeout(() => setUndoToast(null), 6000);
    return () => window.clearTimeout(h);
  }, [undoToast]);

  /** Set true by the editor on any user edit; guards every discard path. */
  const editorDirty = useRef(false);

  async function openEditor(next: EditingState) {
    if (editor && editorDirty.current) {
      const ok = await confirmDiscard("Discard your unsaved trigger edits?");
      if (!ok) return;
    }
    editorDirty.current = false;
    setEditorNonce((n) => n + 1);
    setEditor(next);
  }

  function startSimpleTrigger() {
    const trigger = simpleTrigger(starterIntent, starterLine);
    void openEditor({
      index: null,
      trigger,
      line: starterLine.trim() || undefined,
    });
    setStarterOpen(false);
  }

  async function cancelEditor() {
    if (
      editorDirty.current &&
      !(await confirmDiscard("Discard your unsaved trigger edits?"))
    ) {
      return;
    }
    editorDirty.current = false;
    setEditor(null);
  }

  /** #6: open a curated/generated trigger in the editor as a user copy —
   *  the pack library becomes a template gallery. Real actions come from
   *  the share exporter when available; otherwise a Speak fallback. */
  async function duplicateEntry(e: TriggerTreeEntry) {
    let actions: TriggerAction[] = [
      { Speak: { template: e.name.toLowerCase() } },
    ];
    try {
      const s = await shareExport(null, [e.id], [shareableTrigger(e)]);
      const payload = await parseShareString(s);
      const full = payload.triggers[0];
      if (full && Array.isArray(full.actions) && full.actions.length > 0) {
        actions = full.actions;
      }
    } catch {
      // exporter unavailable — keep the synthesized Speak action
    }
    // Re-slug the id so the copy never collides with the pack trigger (or
    // an earlier copy) in overrides/shares.
    const base = deriveId(null, e.category, e.name);
    const taken = new Set(
      userTriggers.map((t) => deriveId(t.id, t.category, t.name)),
    );
    let id = `${base}-copy`;
    for (let n = 2; taken.has(id); n++) id = `${base}-copy-${n}`;
    void openEditor({
      index: null,
      trigger: {
        name: e.name,
        pattern: e.pattern,
        enabled: true,
        case_insensitive: true,
        category: e.category,
        classes: e.classes,
        id,
        source: "user",
        actions,
      },
    });
  }

  // ---- sharing v1 ----

  /** Full trigger for the share string. User triggers carry their real
   *  actions; bundled entries are synthesized (the desktop backend exports
   *  bundled triggers in full by id — this shape only feeds mock/fallback). */
  function shareableTrigger(e: TriggerTreeEntry): Trigger {
    if (e.userIndex !== null && userTriggers[e.userIndex]) {
      const t = userTriggers[e.userIndex];
      return { ...t, id: t.id ?? e.id };
    }
    return {
      name: e.name,
      pattern: e.pattern,
      enabled: true,
      category: e.category,
      classes: e.classes,
      default_enabled: e.defaultEnabled,
      id: e.id,
      source: e.source,
      actions: [{ Speak: { template: e.name.toLowerCase() } }],
    };
  }

  function openShare(node: TreeNode) {
    const items = collectItems(node);
    if (items.length === 0) return;
    setShare({
      name: node.label,
      ids: items.map((i) => i.id),
      triggers: items.map(shareableTrigger),
    });
  }

  // Mock-only screenshot hooks: open the share / import dialogs directly.
  useEffect(() => {
    if (!SHARE_DEMO || shareDemoSeeded.current || !entries || entries.length === 0) {
      return;
    }
    shareDemoSeeded.current = true;
    const roots = buildTree(entries);
    if (roots[0]) openShare(roots[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);
  useEffect(() => {
    if (!IMPORT_DEMO || shareDemoSeeded.current || userTriggers.length === 0) {
      return;
    }
    shareDemoSeeded.current = true;
    void buildShareString({
      name: "Kael raid pack",
      triggers: userTriggers.slice(0, 4),
    }).then((s) => setImporting({ initialText: s }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTriggers]);

  // Mock-only: ?editordemo=1 opens the editor on a rich starter trigger so
  // screenshots show the builder populated (timer + end-early + test box).
  useEffect(() => {
    if (!EDITOR_DEMO || demoSeeded.current || userTriggers.length === 0) return;
    demoSeeded.current = true;
    if (EDITOR_DEMO === "controls") {
      void openEditor({
        index: null,
        line: "You are out of mana.",
        trigger: {
          name: "Out of mana",
          pattern: "out of mana",
          enabled: true,
          case_insensitive: true,
          category: "Combat/Resources",
          actions: [
            {
              Overlay: {
                overlay: "alerts",
                fields: { text: "out of mana", icon: "!" },
                config: { severity: "warn" },
              },
            },
          ],
        },
      });
      return;
    }
    if (EDITOR_DEMO === "overlay") {
      void openEditor({
        index: null,
        line: "Vulak'Aerr begins to cast Ancient Breath.",
        trigger: {
          name: "Vulak breath warning",
          pattern: "^Vulak'Aerr begins to cast (.+)\\.$",
          enabled: true,
          case_insensitive: true,
          category: "Raid/Vulak'Aerr",
          actions: [
            {
              Overlay: {
                overlay: "alerts",
                fields: { text: "${1} - move away" },
                config: { severity: "alarm", durationMs: 7000 },
              },
            },
            {
              Overlay: {
                overlay: "impact",
                fields: { headline: "INCOMING", big: "${1}", sub: "Move away" },
                config: { style: "badge", color: "#ff5a5f" },
              },
            },
            { Speak: { template: "${1}. Move away." } },
          ],
        },
      });
      return;
    }
    const ix = Math.max(
      userTriggers.findIndex((t) => t.name === "Mez cast timer"),
      0,
    );
    void openEditor({
      index: ix,
      trigger: userTriggers[ix],
      line: "You begin casting Walking Sleep.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTriggers]);

  async function persistUser(next: Trigger[], note?: string | null) {
    setError(null);
    try {
      await saveTriggers(next); // notifies listeners -> tree refreshes
      setStatus(note === undefined ? "Saved — applied to the live session." : note);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveProfile(next: CharacterProfile) {
    setProfileState(next); // optimistic; refresh follows via listener
    setError(null);
    try {
      await setProfile(next);
      setStatus(null);
    } catch (e) {
      setError(String(e));
    }
  }

  // All class/override edits below target the profile's ACTIVE loadout.
  const loadout = profile ? activeLoadout(profile) : null;

  function setClassSlot(slot: number, value: string) {
    if (!profile || !loadout) return;
    const slots = [0, 1, 2].map((i) => loadout.classes[i] ?? "");
    slots[slot] = value;
    const classes = slots.filter(Boolean);
    // Drop duplicates, keeping first occurrence.
    const dedup = classes.filter(
      (c, i) => classes.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i,
    );
    void saveProfile(updateActiveLoadout(profile, { classes: dedup }));
  }

  function commitLevel(raw: string) {
    if (!profile) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    // Legends' level cap is 50 (verified research; profile default is 50).
    const level = Math.max(1, Math.min(50, n));
    if (level !== profile.level) void saveProfile({ ...profile, level });
  }

  async function toggleEntry(e: TriggerTreeEntry) {
    setError(null);
    if (e.userIndex !== null) {
      const idx = e.userIndex;
      const next = userTriggers.map((t, i) =>
        i === idx ? { ...t, enabled: !e.effectiveEnabled } : t,
      );
      await persistUser(next);
    } else {
      try {
        await setOverride(e.id, !e.effectiveEnabled);
      } catch (err) {
        setError(String(err));
      }
    }
  }

  /** Quick per-trigger channel toggle. Sets a profile-level channel override
   *  (works for ANY trigger, including read-only bundled ones) rather than
   *  editing pack files — mirrors how the enabled checkbox uses setOverride. */
  async function toggleChannel(e: TriggerTreeEntry, kind: "speak" | "show") {
    setError(null);
    try {
      if (kind === "speak") await setChannelOverride(e.id, !e.speaks, null);
      else await setChannelOverride(e.id, null, !e.shows);
    } catch (err) {
      setError(String(err));
    }
  }

  /** Override a trigger's alert loudness tier (or "auto" to clear). Persisted
   *  per active loadout; the alert overlay re-reads it on profile-changed. */
  async function setSeverity(e: TriggerTreeEntry, value: string) {
    setError(null);
    try {
      await setSeverityOverride(e.id, value === "auto" ? null : value);
    } catch (err) {
      setError(String(err));
    }
  }

  async function toggleGroup(node: TreeNode) {
    setError(null);
    const target = !(node.total > 0 && node.on === node.total);
    if (node.custom) {
      const idxs = new Set(
        collectItems(node)
          .map((e) => e.userIndex)
          .filter((i): i is number => i !== null),
      );
      const next = userTriggers.map((t, i) =>
        idxs.has(i) ? { ...t, enabled: target } : t,
      );
      await persistUser(next);
      return;
    }
    if (!node.overridePath || !profile || !loadout) return;
    // One group override; stale keys underneath it (either address form)
    // would out-rank the new prefix, so prune them first.
    const prefix = node.overridePath;
    const slugPrefix = slugifyPath(prefix);
    const overrides: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(loadout.overrides)) {
      if (pathHasPrefix(k, prefix) || pathHasPrefix(k, slugPrefix)) continue;
      overrides[k] = v;
    }
    overrides[prefix] = target;
    await saveProfile(updateActiveLoadout(profile, { overrides }));
  }

  async function onImportGina() {
    setError(null);
    if (IS_MOCK) {
      setStatus("GINA import needs the desktop app (mock mode).");
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "GINA trigger package", extensions: ["gtp"] }],
      });
      if (typeof picked !== "string") return;
      const result = await importGina(picked);
      const warn =
        result.warnings.length > 0
          ? ` (${result.warnings.length} skipped: ${result.warnings[0]}${
              result.warnings.length > 1 ? ", …" : ""
            })`
          : "";
      setStatus(`Imported ${result.imported} trigger(s) from GINA package.${warn}`);
      setEntries(await getTriggerTree());
      setUserTriggers(await getTriggers());
    } catch (e) {
      setError(String(e));
    }
  }

  /** TriggerEditor save handler — throws so the editor can show the error. */
  async function onEditorSave(
    t: Trigger,
    companion: Trigger | null,
    prevCompanionName: string | null,
  ) {
    if (!editor) return;
    const next = [...userTriggers];
    if (editor.index === null) next.push(t);
    else next[editor.index] = t;
    if (prevCompanionName) {
      const ix = next.findIndex(
        (x) =>
          x.name === prevCompanionName &&
          x.actions.some((a) => "CancelTimer" in a),
      );
      if (ix !== -1) {
        if (companion) next[ix] = companion;
        else next.splice(ix, 1);
      } else if (companion) {
        next.push(companion);
      }
    } else if (companion) {
      next.push(companion);
    }
    await saveTriggers(next); // notifies listeners -> tree refreshes
    editorDirty.current = false;
    setEditor(null);
    // Reveal where it landed: name the path in the status line and expand
    // the tree down to it (new triggers otherwise vanish into a collapsed
    // group, findable only via search).
    const location = savedLocation(t.category);
    setExpanded((prev) => {
      const nextKeys = new Set(prev);
      let key = "";
      for (const seg of location.split(" › ")) {
        key = key ? `${key}/${seg}` : seg;
        nextKeys.add(key);
      }
      return nextKeys;
    });
    setStatus(
      companion
        ? `Saved to ${location} (with its end-early companion) — applied to the live session.`
        : `Saved to ${location} — applied to the live session.`,
    );
  }

  function deleteTrigger(index: number) {
    const removed = userTriggers[index];
    if (!removed) return;
    const next = userTriggers.filter((_, j) => j !== index);
    void persistUser(next, null).then(() => {
      setUndoToast({
        message: `Deleted “${removed.name}”`,
        undo: () => {
          setUndoToast(null);
          const restored = [...next];
          restored.splice(Math.min(index, restored.length), 0, removed);
          void persistUser(restored, `Restored “${removed.name}”.`);
        },
      });
    });
  }

  function bundledDefaultFor(e: TriggerTreeEntry): TriggerTreeEntry | null {
    if (e.userIndex === null || !entries) return null;
    const baseId = e.id.replace(/-copy(?:-\d+)?$/, "");
    return (
      entries.find((x) => x.userIndex === null && x.id === baseId) ??
      entries.find(
        (x) =>
          x.userIndex === null &&
          x.name.toLowerCase() === e.name.toLowerCase() &&
          (x.category ?? "") === (e.category ?? ""),
      ) ??
      null
    );
  }

  function rowHasResettableOverrides(e: TriggerTreeEntry): boolean {
    if (!loadout) return false;
    return (
      Object.prototype.hasOwnProperty.call(loadout.overrides, e.id) ||
      Object.prototype.hasOwnProperty.call(loadout.channel_overrides ?? {}, e.id)
    );
  }

  async function resetEntryOverrides(e: TriggerTreeEntry, note?: string | null) {
    if (!profile || !loadout) return;
    const overrides = { ...loadout.overrides };
    delete overrides[e.id];
    const channel_overrides = { ...(loadout.channel_overrides ?? {}) };
    delete channel_overrides[e.id];
    await saveProfile(
      updateActiveLoadout(profile, { overrides, channel_overrides }),
    );
    setStatus(note ?? `Reset “${e.name}” to loadout defaults.`);
  }

  function revertCustomizedTrigger(e: TriggerTreeEntry) {
    const index = e.userIndex;
    if (index === null) return;
    const removed = userTriggers[index];
    const bundled = bundledDefaultFor(e);
    if (!removed || !bundled) return;
    if (
      !window.confirm(
        `Roll “${removed.name}” back to the bundled default? This removes your customized copy.`,
      )
    ) {
      return;
    }
    const next = userTriggers.filter((_, j) => j !== index);
    void persistUser(next, null).then(() => {
      void resetEntryOverrides(bundled, null).catch(() => {});
      setUndoToast({
        message: `Reverted “${removed.name}” to default`,
        undo: () => {
          setUndoToast(null);
          const restored = [...next];
          restored.splice(Math.min(index, restored.length), 0, removed);
          void persistUser(restored, `Restored customized “${removed.name}”.`);
        },
      });
    });
  }

  function renderEntry(e: TriggerTreeEntry, depth: number) {
    const bundledDefault = bundledDefaultFor(e);
    const resettable = rowHasResettableOverrides(e);
    const declaredDestinations = e.overlays;
    const destinations = Array.from(
      new Set(
        declaredDestinations
          ? declaredDestinations
          : [e.shows ? "alerts" : null, e.impact ? "impact" : null].filter(
              (destination): destination is string => destination !== null,
            ),
      ),
    );
    return (
      <div
        className={`tt-row${e.effectiveEnabled ? "" : " off"}`}
        style={{ paddingLeft: 10 + depth * 18 }}
        key={`${e.id}-${e.userIndex ?? "p"}`}
      >
        <input
          type="checkbox"
          className="tree-check"
          checked={e.effectiveEnabled}
          onChange={() => void toggleEntry(e)}
          aria-label={e.name}
        />
        <span className="tt-name" title={e.classes.length ? `Classes: ${e.classes.join(", ")}` : undefined}>
          {e.name}
        </span>
        <span className="tt-pattern" title={e.pattern}>
          {e.pattern}
        </span>
        <span className="tt-chan">
          <button
            type="button"
            className={`chan-chip${e.speaks ? " on" : ""}`}
            title={
              e.speaks
                ? "Speaks aloud (TTS) — click to turn off"
                : "Silent — click to speak this aloud (TTS)"
            }
            onClick={() => void toggleChannel(e, "speak")}
          >
            TTS
          </button>
          <button
            type="button"
            className={`chan-chip${e.shows ? " on" : ""}`}
            title={
              e.shows
                ? "Shows in the alert window — click to remove"
                : "Not shown — click to show in the alert window"
            }
            onClick={() => void toggleChannel(e, "show")}
          >
            Alert
          </button>
          {e.shows && (
            <select
              className={`chan-sev sev-${
                loadout?.severity_overrides?.[e.id] ?? "auto"
              }`}
              value={loadout?.severity_overrides?.[e.id] ?? "auto"}
              title="Alert loudness — Auto uses the built-in classifier; pick a tier to override it for this trigger"
              aria-label={`Alert loudness for ${e.name}`}
              onChange={(ev) => void setSeverity(e, ev.target.value)}
            >
              <option value="auto">Auto</option>
              <option value="info">Quiet</option>
              <option value="warn">Warn</option>
              <option value="alarm">Loud</option>
            </select>
          )}
          {e.sound && (
            <span className="chan-chip on" title="Plays a sound">
              Snd
            </span>
          )}
          {e.timer && (
            <span className="chan-chip on" title="Runs a timer bar">
              Timer
            </span>
          )}
          {destinations.filter((destination) => destination !== "alerts").map((destination) => (
            <span
              className="chan-chip on"
              title={`Sends matched data to the ${getOverlayDefinition(destination)?.label ?? destination} overlay`}
              key={destination}
            >
              {getOverlayDefinition(destination)?.label ?? destination}
            </span>
          ))}
        </span>
        {e.userIndex !== null ? (
          <span className="tt-btns">
            <button
              className="ghost small"
              onClick={() =>
                void openEditor({
                  index: e.userIndex as number,
                  trigger: userTriggers[e.userIndex as number],
                })
              }
            >
              Edit
            </button>
            <button
              className="danger small"
              onClick={() => deleteTrigger(e.userIndex as number)}
            >
              Delete
            </button>
            {bundledDefault && (
              <button
                className="ghost small"
                title={`Remove this customized copy and use the bundled “${bundledDefault.name}” default`}
                onClick={() => revertCustomizedTrigger(e)}
              >
                Revert
              </button>
            )}
            {resettable && (
              <button
                className="ghost small"
                title="Clear enabled, TTS, and alert overrides for this loadout"
                onClick={() => void resetEntryOverrides(e)}
              >
                Reset
              </button>
            )}
          </span>
        ) : (
          <span className="tt-btns">
            {resettable && (
              <button
                className="ghost small"
                title="Clear enabled, TTS, and alert overrides for this loadout"
                onClick={() => void resetEntryOverrides(e)}
              >
                Reset
              </button>
            )}
            <button
              className="ghost small"
              title="Copy this pack trigger into My Triggers and open it in the editor"
              onClick={() => void duplicateEntry(e)}
            >
              Customize
            </button>
          </span>
        )}
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const isOpen = searching || expanded.has(node.key);
    const allOn = node.total > 0 && node.on === node.total;
    const someOn = node.on > 0 && !allOn;
    return (
      <div className="tt-group" key={node.key}>
        <div
          className={`tt-group-head${depth === 0 ? " top" : ""}`}
          style={{ paddingLeft: 10 + depth * 18 }}
        >
          <TriState
            checked={allOn}
            indeterminate={someOn}
            onChange={() => void toggleGroup(node)}
            label={`Toggle ${node.key}`}
          />
          <button
            className="tt-disclose"
            aria-expanded={isOpen}
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(node.key)) next.delete(node.key);
                else next.add(node.key);
                return next;
              })
            }
          >
            <span className={`tt-chevron${isOpen ? " open" : ""}`} />
            <span className="tt-label">{node.label}</span>
          </button>
          <span className="tt-count num">
            {node.on} on / {node.total}
          </span>
          <button
            className="ghost small tt-share"
            onClick={(e) => {
              e.stopPropagation();
              openShare(node);
            }}
            title={`Share the ${node.total} trigger${node.total === 1 ? "" : "s"} under “${node.label}” as a paste string`}
          >
            Share
          </button>
        </div>
        {isOpen && (
          <div className="tt-children">
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.items.map((e) => renderEntry(e, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (editor) {
    return (
      <div className="trigger-editor-workspace">
        <div className="trigger-editor-workspace-head">
          <button className="ghost" onClick={() => void cancelEditor()}>
            Back to triggers
          </button>
          <div>
            <div className="trigger-editor-breadcrumb">Triggers / {editor.index === null ? "New trigger" : "Edit trigger"}</div>
            <h2>{editor.index === null ? "Create trigger" : editor.trigger?.name ?? "Edit trigger"}</h2>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {status && !error && <div className="status-banner">{status}</div>}
        <div className="card editor trigger-editor-surface">
          <TriggerEditor
            key={editorNonce}
            initial={editor.trigger}
            initialLine={editor.line}
            variant="card"
            userTriggers={userTriggers}
            existing={(entries ?? [])
              .filter(
                (entry) =>
                  entry.effectiveEnabled &&
                  (editor.index === null || entry.userIndex !== editor.index),
              )
              .map((entry) => ({
                name: entry.name,
                category: entry.category,
                pattern: entry.pattern,
              }))}
            onDirtyChange={(dirty) => {
              editorDirty.current = dirty;
            }}
            onCancel={() => void cancelEditor()}
            onSave={onEditorSave}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar triggers-toolbar">
        <input
          type="text"
          placeholder="Search name or pattern…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search triggers"
        />
        <div className="toolbar-group">
          <button
            className="ghost"
            onClick={() => setExpanded(new Set(collectNodeKeys(tree)))}
            disabled={tree.length === 0}
          >
            Expand all
          </button>
          <button
            className="ghost"
            onClick={() => setExpanded(new Set())}
            disabled={tree.length === 0}
          >
            Collapse all
          </button>
        </div>
        <span className="spacer" />
        <span className="hint num">
          {entries ? `${totalOn} on / ${entries.length} triggers` : "…"}
        </span>
        <div className="topbar-menu">
          <button
            className="ghost"
            onClick={() => setImportOpen((o) => !o)}
            aria-expanded={importOpen}
          >
            Import
          </button>
          {importOpen && (
            <div className="topbar-popover trigger-import-menu">
              <button
                className="ghost"
                onClick={() => {
                  setImportOpen(false);
                  void onImportGina();
                }}
              >
                GINA .gtp…
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setImportOpen(false);
                  setImporting({});
                }}
                title="Paste an LCS1 share string from a guildmate"
              >
                Share string…
              </button>
            </div>
          )}
        </div>
        <button
          className="primary"
          onClick={() => setStarterOpen((o) => !o)}
        >
          + Trigger
        </button>
      </div>
      <div className="chip-row" role="group" aria-label="Trigger filters">
        {[
          ["all", "All"],
          ["mine", "My triggers"],
          ["enabled", "Enabled"],
          ["tts", "TTS"],
          ["alerts", "Alerts"],
          ["timers", "Timers"],
          ["disabled", "Disabled"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`kchip${triggerFilter === id ? " active" : ""}`}
            onClick={() => setTriggerFilter(id as TriggerFilter)}
          >
            {label}
          </button>
        ))}
      </div>
      {starterOpen && (
        <div className="card trigger-starter">
          <div className="card-head">
            <span className="section-title">New trigger</span>
            <span className="hint">Pick the outcome, paste an example log line, then tune it in the builder.</span>
          </div>
          <div className="trigger-starter-grid">
            <label className="field">
              <span>What should happen?</span>
              <select
                value={starterIntent}
                onChange={(e) => setStarterIntent(e.target.value as TriggerIntent)}
              >
                <option value="alert">Show alert</option>
                <option value="speak">Speak TTS</option>
                <option value="timer">Start timer</option>
                <option value="sound">Play sound</option>
                <option value="effect">Proc / skill / spell alert</option>
              </select>
            </label>
            <label className="field trigger-starter-line">
              <span>Example log line</span>
              <input
                type="text"
                value={starterLine}
                onChange={(e) => setStarterLine(e.target.value)}
                placeholder="Paste a line from Live, or leave blank for the guided builder"
              />
            </label>
            <div className="trigger-starter-actions">
              <button className="primary" onClick={startSimpleTrigger}>
                Continue
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setStarterOpen(false);
                  void openEditor({ index: null, trigger: null });
                }}
              >
                Advanced
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {status && !error && <div className="status-banner">{status}</div>}
      {packWarnings.length > 0 && (
        <div className="warn-banner" role="alert">
          <span className="warn-banner-text">
            {packWarnings.length} trigger-pack warning
            {packWarnings.length === 1 ? "" : "s"} while loading — some
            triggers may be inactive.
          </span>
          <button className="ghost small" onClick={() => setWarnOpen((o) => !o)}>
            {warnOpen ? "Hide details" : "Details"}
          </button>
          <button
            className="ghost small"
            title="Hide these warnings — they stay hidden across restarts unless the warnings change"
            onClick={() => {
              rememberWarningsDismissed(packWarnings);
              setPackWarnings([]);
            }}
          >
            Dismiss
          </button>
          {warnOpen && (
            <ul className="warn-banner-list">
              {packWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card classes-bar">
        <div className="card-head">
          <span className="section-title">My classes</span>
          <span className="hint">
            Class packs enable themselves for the classes you pick (up to 3)
            {loadout ? ` — saved to the “${loadout.name}” loadout.` : "."}
          </span>
        </div>
        {profile && loadout ? (
          <div className="classes-row">
            <datalist id="eq-class-list">
              {CLASS_NAMES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {[0, 1, 2].map((slot) => (
              <ClassPicker
                key={`${loadout.name}-${slot}-${loadout.classes[slot] ?? ""}`}
                slot={slot}
                value={loadout.classes[slot] ?? ""}
                onCommit={(v) => setClassSlot(slot, v)}
              />
            ))}
            <label className="level-field">
              <span>Level</span>
              <input
                type="number"
                min={1}
                max={50}
                defaultValue={profile.level}
                key={profile.level}
                onBlur={(e) => commitLevel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    commitLevel((e.target as HTMLInputElement).value);
                }}
              />
            </label>
          </div>
        ) : (
          <div className="hint">Loading profile…</div>
        )}
      </div>

      {entries === null ? (
        <div className="card">
          <div className="hint">Loading trigger library…</div>
        </div>
      ) : entries.length === 0 ? (
        <div className="card">
          <Empty
            title="No triggers found"
            body="The bundled packs were not found and no custom triggers exist yet. Add a trigger above or import a GINA package."
          />
        </div>
      ) : tree.length === 0 ? (
        <div className="card">
          <Empty
            title="No matches"
            body={`No trigger name or pattern matches “${query.trim()}”.`}
          />
        </div>
      ) : (
        <div className="card tt-tree">{tree.map((n) => renderNode(n, 0))}</div>
      )}
      {undoToast && (
        <div className="toast toast-undo" role="status">
          {undoToast.message}
          <button className="ghost small" onClick={undoToast.undo}>
            Undo
          </button>
        </div>
      )}
      {share && <ShareDialog request={share} onClose={() => setShare(null)} />}
      {importing && (
        <ImportDialog
          initialText={importing.initialText}
          onClose={() => setImporting(null)}
          onImported={(summary) => {
            setImporting(null);
            setStatus(summary);
          }}
        />
      )}
    </>
  );
}
