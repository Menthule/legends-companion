import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  confirmDiscard,
  dropsZones,
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
  shareExportFile,
  shareReadFile,
  triggerUpdateCheck,
  triggerUpdateInstall,
  triggerVersion,
} from "../api";
import { useDebouncedValue, useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  activeLoadout,
  deriveId,
  pathHasPrefix,
  slugifyPath,
  updateActiveLoadout,
  withTimingOverride,
  zoneScopeFor,
} from "../resolution";
import {
  CLASS_NAMES,
  type CharacterProfile,
  type DropZone,
  type PackWarningsPayload,
  type Trigger,
  type TriggerAction,
  type TriggerUpdateInfo,
  type TriggerTreeEntry,
} from "../types";
import { buildShareString, parseShareString } from "../lib/share";
import { getOverlayDefinition } from "../lib/overlayRegistry";
import {
  formatDuration,
  parseDuration,
  parseNonNegativeDuration,
} from "../lib/patternJs";
import Empty from "./Empty";
import { fmtBytes as formatUpdateBytes } from "../lib/format";
import { savedLocation } from "./QuickTriggerModal";
import { SearchSelect } from "./SearchSelect";
import { ImportDialog, ShareDialog, type ShareRequest } from "./ShareDialogs";
import { useToast } from "./Toast";
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

interface TimingEditorState {
  id: string;
  name: string;
  rank: string;
  duration: string;
  castTime: string;
}

/** Draft state for the per-category zone-scope editor (loadout
 *  `zone_scopes`, keyed by the group's category-path prefix). */
interface ZoneScopeEditorState {
  /** The group's override path (TreeNode.overridePath). */
  path: string;
  /** The group label, for copy. */
  label: string;
  zones: string[];
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
  const searchQuery = useDebouncedValue(query);
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [timingEditor, setTimingEditor] = useState<TimingEditorState | null>(null);
  const [zoneScopeEditor, setZoneScopeEditor] =
    useState<ZoneScopeEditorState | null>(null);
  /** Reference zone list for the zone-scope autocomplete (loaded once). */
  const [zoneOptions, setZoneOptions] = useState<DropZone[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedSeeded = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryVersion, setLibraryVersion] = useState<string | null>(null);
  const [libraryUpdate, setLibraryUpdate] =
    useState<TriggerUpdateInfo | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState<string | null>(null);
  const [toastNode, showToast] = useToast();
  const demoSeeded = useRef(false);
  /** Pack-load warnings pushed by the backend (amber dismissible banner). */
  const [packWarnings, setPackWarnings] = useState<string[]>([]);
  const [warnOpen, setWarnOpen] = useState(false);
  /** Sharing v1 dialogs. */
  const [share, setShare] = useState<ShareRequest | null>(null);
  const [importing, setImporting] = useState<{
    initialText?: string;
    sourceName?: string;
  } | null>(null);
  const shareDemoSeeded = useRef(false);

  useEffect(() => {
    if (searchRequest?.query) setQuery(searchRequest.query);
  }, [searchRequest?.seq]);

  useEffect(() => {
    void triggerVersion().then(setLibraryVersion).catch(() => {});
    void dropsZones().then(setZoneOptions).catch(() => {});
  }, []);

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

  useTauriEvent<string>("trigger-library-updated", (version) => {
    setLibraryVersion(version);
    setLibraryUpdate(null);
    void getTriggerTree()
      .then((tree) => {
        setEntries(tree);
        setLibraryStatus(
          `Trigger library ${version} installed. ${tree.length} triggers loaded.`,
        );
      })
      .catch((e) =>
        setLibraryStatus(`Library installed; reload failed: ${String(e)}`),
      );
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
    const q = searchQuery.trim().toLowerCase();
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
  }, [entries, searchQuery, triggerFilter]);

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

  async function checkLibraryUpdate() {
    setLibraryBusy(true);
    setLibraryStatus("Checking for the latest trigger library…");
    try {
      const info = await triggerUpdateCheck();
      setLibraryUpdate(info);
      setLibraryVersion(info.current);
      setLibraryStatus(
        info.updateAvailable
          ? `Trigger library ${info.latest} is ready to install.`
          : info.latest
            ? `You have the latest trigger library (${info.latest}).`
            : "Trigger library updates are available in the desktop app.",
      );
    } catch (e) {
      setLibraryStatus(`Could not check for updates: ${String(e)}`);
    } finally {
      setLibraryBusy(false);
    }
  }

  async function installLibraryUpdate() {
    setLibraryBusy(true);
    setLibraryStatus("Downloading and verifying the trigger library…");
    try {
      const version = await triggerUpdateInstall();
      const tree = await getTriggerTree();
      setEntries(tree);
      setLibraryVersion(version);
      setLibraryUpdate(null);
      setLibraryStatus(
        `Trigger library ${version} installed. ${tree.length} triggers loaded.`,
      );
    } catch (e) {
      setLibraryStatus(`Trigger library update failed: ${String(e)}`);
    } finally {
      setLibraryBusy(false);
    }
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
    const base = e.event ? e.id : deriveId(null, e.category, e.name);
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
        event: e.event,
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
      event: e.event,
      enabled: true,
      category: e.category,
      classes: e.classes,
      default_enabled: e.defaultEnabled,
      track_when_observed: e.trackWhenObserved,
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

  async function onExportCompanion() {
    setError(null);
    if (!entries || entries.length === 0) return;
    if (IS_MOCK) {
      setStatus("Companion package export needs the desktop app (mock mode).");
      return;
    }
    const name = loadout
      ? `${loadout.name} trigger library`
      : "Legends Companion trigger library";
    const filename = `${name.replace(/[^\w -]+/g, "").trim() || "triggers"}.lct`;
    try {
      const path = await save({
        defaultPath: filename,
        filters: [
          { name: "Legends Companion trigger package", extensions: ["lct"] },
        ],
      });
      if (typeof path !== "string") return;
      const count = await shareExportFile(
        name,
        entries.map((entry) => entry.id),
        path,
      );
      setStatus(
        `Exported ${count} trigger${count === 1 ? "" : "s"} to a Companion package.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onImportCompanion() {
    setError(null);
    if (IS_MOCK) {
      setStatus("Companion package import needs the desktop app (mock mode).");
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        filters: [
          { name: "Legends Companion trigger package", extensions: ["lct"] },
        ],
      });
      if (typeof picked !== "string") return;
      const text = await shareReadFile(picked);
      const sourceName = picked.split(/[\\/]/).pop() || "Companion package";
      setImporting({ initialText: text, sourceName });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
    // A bundled typed-event trigger is customized as a user copy. Disable the
    // bundled source while the copy exists so one loot signal produces one
    // alert, then revert/delete restores the bundled default below.
    const baseEventId = t.event && t.id
      ? t.id.replace(/-copy(?:-\d+)?$/, "")
      : null;
    if (
      baseEventId &&
      baseEventId !== t.id &&
      entries?.some((entry) => entry.userIndex === null && entry.id === baseEventId)
    ) {
      await setOverride(baseEventId, false);
    }
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
    const treeEntry = entries?.find((entry) => entry.userIndex === index) ?? null;
    const bundled = treeEntry ? bundledDefaultFor(treeEntry) : null;
    const next = userTriggers.filter((_, j) => j !== index);
    void persistUser(next, null).then(() => {
      if (removed.event && bundled) void resetEntryOverrides(bundled, null);
      showToast(`Deleted “${removed.name}”`, {
        undo: () => {
          const restored = [...next];
          restored.splice(Math.min(index, restored.length), 0, removed);
          void persistUser(restored, `Restored “${removed.name}”.`).then(() => {
            if (removed.event && bundled) void setOverride(bundled.id, false);
          });
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
      || Object.prototype.hasOwnProperty.call(loadout.timing_overrides ?? {}, e.id)
    );
  }

  async function resetEntryOverrides(e: TriggerTreeEntry, note?: string | null) {
    if (!profile || !loadout) return;
    const overrides = { ...loadout.overrides };
    delete overrides[e.id];
    const channel_overrides = { ...(loadout.channel_overrides ?? {}) };
    delete channel_overrides[e.id];
    const timing_overrides = { ...(loadout.timing_overrides ?? {}) };
    delete timing_overrides[e.id];
    await saveProfile(
      updateActiveLoadout(profile, { overrides, channel_overrides, timing_overrides }),
    );
    setStatus(note ?? `Reset “${e.name}” to loadout defaults.`);
  }

  /** The loadout `zone_scopes` key addressing this category path, if any —
   *  entries may be stored under the display path or its slug form (the same
   *  duality the enable overrides have), matched case-insensitively. */
  function zoneScopeKeyFor(path: string): string | null {
    const scopes = loadout?.zone_scopes;
    if (!scopes) return null;
    const lower = path.toLowerCase();
    const slugLower = slugifyPath(path).toLowerCase();
    return (
      Object.keys(scopes)
        .sort()
        .find((k) => {
          const kl = k.toLowerCase();
          return kl === lower || kl === slugLower;
        }) ?? null
    );
  }

  function openZoneScopeEditor(node: TreeNode) {
    if (!node.overridePath) return;
    const key = zoneScopeKeyFor(node.overridePath);
    setZoneScopeEditor({
      path: node.overridePath,
      label: node.label,
      zones: key ? [...(loadout?.zone_scopes?.[key] ?? [])] : [],
    });
  }

  /** Persist (or with `remove`, clear) the drafted category zone scope.
   *  Same save path as the enable-override group toggle: stale keys under
   *  the prefix (either address form) would out-rank the new entry, so they
   *  are pruned first, then the whole map is written to the active loadout. */
  async function saveZoneScope(remove: boolean) {
    if (!profile || !loadout || !zoneScopeEditor) return;
    if (!remove && zoneScopeEditor.zones.length === 0) {
      setError(
        "Add at least one zone, or use “Remove limit” to fire everywhere again.",
      );
      return;
    }
    setError(null);
    const prefix = zoneScopeEditor.path;
    const slugPrefix = slugifyPath(prefix);
    const zone_scopes: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(loadout.zone_scopes ?? {})) {
      if (pathHasPrefix(k, prefix) || pathHasPrefix(k, slugPrefix)) continue;
      zone_scopes[k] = v;
    }
    if (!remove) zone_scopes[prefix] = zoneScopeEditor.zones;
    await saveProfile(updateActiveLoadout(profile, { zone_scopes }));
    setStatus(
      remove
        ? `“${zoneScopeEditor.label}” triggers fire in every zone again (${loadout.name} loadout).`
        : `“${zoneScopeEditor.label}” triggers now fire only in ${zoneScopeEditor.zones.length} zone${zoneScopeEditor.zones.length === 1 ? "" : "s"} (${loadout.name} loadout).`,
    );
    setZoneScopeEditor(null);
  }

  function openTimingEditor(e: TriggerTreeEntry) {
    const existing = loadout?.timing_overrides?.[e.id] ?? {};
    const rank = Object.keys(existing)[0] ?? "II";
    const timing = existing[rank] ?? {};
    setTimingEditor({
      id: e.id,
      name: e.name,
      rank,
      duration:
        timing.duration_secs != null ? formatDuration(timing.duration_secs) : "",
      castTime:
        timing.cast_time_secs != null ? formatDuration(timing.cast_time_secs) : "",
    });
  }

  function selectTimingRank(triggerId: string, rank: string) {
    if (!timingEditor) return;
    const timing = loadout?.timing_overrides?.[triggerId]?.[rank] ?? {};
    setTimingEditor({
      ...timingEditor,
      rank,
      duration:
        timing.duration_secs != null ? formatDuration(timing.duration_secs) : "",
      castTime:
        timing.cast_time_secs != null ? formatDuration(timing.cast_time_secs) : "",
    });
  }

  async function saveTimingEditor() {
    if (!profile || !timingEditor) return;
    const rank = timingEditor.rank.trim().toUpperCase();
    if (!/^[IVXLCDM]+$/.test(rank)) {
      setError("Spell rank must be a Roman numeral such as II, IV, or VII.");
      return;
    }
    const duration = timingEditor.duration.trim()
      ? parseDuration(timingEditor.duration)
      : null;
    const castTime = timingEditor.castTime.trim()
      ? parseNonNegativeDuration(timingEditor.castTime)
      : null;
    if (duration !== null && duration <= 0) {
      setError("Rank duration must be positive (for example 3:36 or 216).");
      return;
    }
    if (castTime !== null && castTime < 0) {
      setError("Rank cast time cannot be negative.");
      return;
    }
    if (duration === null && castTime === null) {
      setError("Enter a duration, a cast time, or clear this rank override.");
      return;
    }
    await saveProfile(
      withTimingOverride(profile, timingEditor.id, rank, {
        ...(duration !== null ? { duration_secs: duration } : {}),
        ...(castTime !== null ? { cast_time_secs: castTime } : {}),
      }),
    );
    setStatus(`Saved ${timingEditor.name} ${rank} timing for ${loadout?.name ?? "this loadout"}.`);
    setTimingEditor(null);
  }

  async function clearTimingEditor() {
    if (!profile || !timingEditor) return;
    await saveProfile(
      withTimingOverride(profile, timingEditor.id, timingEditor.rank, null),
    );
    setStatus(`Cleared ${timingEditor.name} ${timingEditor.rank.toUpperCase()} timing override.`);
    setTimingEditor(null);
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
      showToast(`Reverted “${removed.name}” to default`, {
        undo: () => {
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
    const timingCount = Object.keys(loadout?.timing_overrides?.[e.id] ?? {}).length;
    // Effective zone scope: a loadout zone_scopes entry replaces the
    // pack-authored Trigger.zones (empty scope = muted everywhere).
    const packZones = e.zones ?? [];
    const zoneScope = loadout ? zoneScopeFor(e, loadout) : null;
    const effectiveZones = zoneScope ?? packZones;
    const zoneScoped = zoneScope !== null || packZones.length > 0;
    const editingTiming = timingEditor?.id === e.id;
    const hasCurrentTiming = Boolean(
      timingEditor && loadout?.timing_overrides?.[e.id]?.[timingEditor.rank],
    );
    return (
      <div className="tt-entry" key={`${e.id}-${e.userIndex ?? "p"}`}>
        <div
          className={`tt-row${e.effectiveEnabled ? "" : " off"}`}
          style={{ paddingLeft: 10 + depth * 18 }}
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
        <span
          className="tt-pattern"
          title={e.event ? "Structured app event" : e.pattern}
        >
          {e.event === "watched-loot"
            ? "Watched item looted"
            : e.event === "watched-kill"
              ? "Watched mob killed"
              : e.event === "achievement-self"
                ? "You complete an achievement"
                : e.event === "achievement-other"
                  ? "Another player completes an achievement"
              : e.pattern}
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
            <button
              type="button"
              className={`chan-chip on${timingCount > 0 ? " timing-custom" : ""}`}
              title={
                timingCount > 0
                  ? `${timingCount} custom rank timing${timingCount === 1 ? "" : "s"} in this loadout`
                  : "Set exact duration and cast time by spell rank"
              }
              onClick={() =>
                editingTiming ? setTimingEditor(null) : openTimingEditor(e)
              }
            >
              {timingCount > 0 ? `Timing ${timingCount}` : "Timer"}
            </button>
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
          {zoneScoped && (
            <span
              className={`chan-chip zone-chip${zoneScope !== null ? " scoped" : ""}`}
              title={
                zoneScope !== null
                  ? zoneScope.length === 0
                    ? `Loadout zone limit: no zones — never fires (${loadout?.name ?? "active"} loadout)`
                    : `Loadout zone limit (${loadout?.name ?? "active"}): ${zoneScope.join(", ")}`
                  : `Fires only in: ${packZones.join(", ")}`
              }
            >
              {effectiveZones.length === 0
                ? "No zones"
                : effectiveZones.length === 1
                  ? effectiveZones[0]
                  : `${effectiveZones[0]} +${effectiveZones.length - 1}`}
            </span>
          )}
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
                title="Clear enabled, TTS, alert, and timing overrides for this loadout"
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
                title="Clear enabled, TTS, alert, and timing overrides for this loadout"
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
        {editingTiming && timingEditor && (
          <div
            className="tt-timing-editor"
            style={{ marginLeft: 36 + depth * 18 }}
          >
            <div className="tt-timing-copy">
              <strong>{e.name}</strong>
              <span className="hint">
                Exact values for {loadout?.name ?? "this loadout"}; blank fields inherit the library timing.
              </span>
            </div>
            <label className="field compact">
              <span>Rank</span>
              <select
                className="tt-rank-input"
                value={timingEditor.rank}
                aria-label={`Spell rank for ${e.name}`}
                onChange={(event) =>
                  selectTimingRank(e.id, event.target.value)
                }
              >
                {Array.from(
                  new Set([
                    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
                    ...Object.keys(loadout?.timing_overrides?.[e.id] ?? {}),
                  ]),
                ).map((rank) => (
                  <option value={rank} key={rank}>{rank}</option>
                ))}
              </select>
            </label>
            <label className="field compact">
              <span>Duration</span>
              <input
                value={timingEditor.duration}
                placeholder="3:36"
                aria-label={`Duration for ${e.name}`}
                onChange={(event) =>
                  setTimingEditor({ ...timingEditor, duration: event.target.value })
                }
              />
            </label>
            <label className="field compact">
              <span>Cast time</span>
              <input
                value={timingEditor.castTime}
                placeholder="2"
                aria-label={`Cast time for ${e.name}`}
                onChange={(event) =>
                  setTimingEditor({ ...timingEditor, castTime: event.target.value })
                }
              />
            </label>
            <div className="tt-timing-actions">
              {hasCurrentTiming && (
                <button className="ghost small" onClick={() => void clearTimingEditor()}>
                  Clear rank
                </button>
              )}
              <button className="ghost small" onClick={() => setTimingEditor(null)}>
                Cancel
              </button>
              <button className="primary small" onClick={() => void saveTimingEditor()}>
                Save timing
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const isOpen = searching || expanded.has(node.key);
    const allOn = node.total > 0 && node.on === node.total;
    const someOn = node.on > 0 && !allOn;
    const scopeKey = node.overridePath ? zoneScopeKeyFor(node.overridePath) : null;
    const scopeCount = scopeKey
      ? (loadout?.zone_scopes?.[scopeKey]?.length ?? 0)
      : 0;
    const editingZones = zoneScopeEditor?.path === node.overridePath;
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
          {node.overridePath && !node.custom && profile && (
            <button
              className={`ghost small tt-zones${scopeKey ? " scoped" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (editingZones) setZoneScopeEditor(null);
                else openZoneScopeEditor(node);
              }}
              title={
                scopeKey
                  ? `This loadout limits “${node.label}” triggers to ${scopeCount} zone${scopeCount === 1 ? "" : "s"} — click to edit`
                  : `Limit every trigger under “${node.label}” to chosen zones (saved to the active loadout)`
              }
            >
              {scopeKey ? `Zones ${scopeCount}` : "Zones"}
            </button>
          )}
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
        {editingZones && zoneScopeEditor && (
          <div
            className="tt-timing-editor tt-zone-editor"
            style={{ marginLeft: 36 + depth * 18 }}
          >
            <div className="tt-timing-copy">
              <strong>Zones for “{node.label}”</strong>
              <span className="hint">
                Every trigger under this group fires only in the listed zones
                — replacing any zone list the pack set. Saved to the “
                {loadout?.name ?? "active"}” loadout.
              </span>
            </div>
            <div className="tt-zone-fields">
              {zoneScopeEditor.zones.length > 0 && (
                <div className="zone-chiplist">
                  {zoneScopeEditor.zones.map((z) => (
                    <button
                      type="button"
                      key={z}
                      className="ted-chip"
                      title={`Remove ${z}`}
                      onClick={() =>
                        setZoneScopeEditor({
                          ...zoneScopeEditor,
                          zones: zoneScopeEditor.zones.filter((x) => x !== z),
                        })
                      }
                    >
                      {z} ✕
                    </button>
                  ))}
                </div>
              )}
              <SearchSelect
                value=""
                anyLabel="Add a zone…"
                options={zoneOptions
                  .filter((z) => !zoneScopeEditor.zones.includes(z.longName))
                  .map((z) => ({ value: z.longName, label: z.longName }))}
                onChange={(v) => {
                  if (v && !zoneScopeEditor.zones.includes(v)) {
                    setZoneScopeEditor({
                      ...zoneScopeEditor,
                      zones: [...zoneScopeEditor.zones, v],
                    });
                  }
                }}
              />
            </div>
            <div className="tt-timing-actions">
              {scopeKey && (
                <button
                  className="ghost small"
                  title="Clear this zone limit — triggers fire everywhere again"
                  onClick={() => void saveZoneScope(true)}
                >
                  Remove limit
                </button>
              )}
              <button className="ghost small" onClick={() => setZoneScopeEditor(null)}>
                Cancel
              </button>
              <button className="primary small" onClick={() => void saveZoneScope(false)}>
                Save zones
              </button>
            </div>
          </div>
        )}
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
                  void onImportCompanion();
                }}
              >
                Companion package…
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
              <button
                className="ghost"
                onClick={() => {
                  setImportOpen(false);
                  void onImportGina();
                }}
                title="Import a GINA package; unsupported Companion fields may be skipped"
              >
                GINA .gtp…
              </button>
            </div>
          )}
        </div>
        <button
          className="ghost"
          onClick={() => void onExportCompanion()}
          disabled={!entries || entries.length === 0}
          title="Save every current trigger in a lossless Companion package"
        >
          Export all
        </button>
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
      <div className="trigger-library-update" aria-live="polite">
        <div className="trigger-library-copy">
          <div className="trigger-library-title-row">
            <span className="section-title">Trigger library</span>
            <span className="trigger-library-version">
              {libraryVersion
                ? `Installed ${libraryVersion}`
                : "Included with app"}
            </span>
          </div>
          <span className="hint">
            {libraryStatus ??
              "Keep shared spell, combat, and class triggers current without waiting for an app release."}
          </span>
        </div>
        <div className="trigger-library-actions">
          <button
            className="ghost"
            onClick={() => void checkLibraryUpdate()}
            disabled={libraryBusy}
          >
            {libraryBusy ? "Working…" : "Check for updates"}
          </button>
          {libraryUpdate?.updateAvailable && (
            <button
              className="primary"
              onClick={() => void installLibraryUpdate()}
              disabled={libraryBusy}
            >
              Install {libraryUpdate.latest}
              {libraryUpdate.totalBytes > 0
                ? ` · ${formatUpdateBytes(libraryUpdate.totalBytes)}`
                : ""}
            </button>
          )}
        </div>
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
      {toastNode}
      {share && <ShareDialog request={share} onClose={() => setShare(null)} />}
      {importing && (
        <ImportDialog
          initialText={importing.initialText}
          sourceName={importing.sourceName}
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
