// Shared trigger editor (docs/trigger-editor-spec.md): sentence-shaped
// builder ("When X happens -> Do Y") used by both the Triggers tab and the
// quick-create modal. Builder state derives the pattern from a template
// registry; unrecognized patterns open in Advanced mode. Zero schema changes:
// everything serializes to the existing Trigger JSON.

import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getConfig, listSounds, previewSound, type SoundInfo } from "../api";
import spellData from "../data/spell_names.json";
import {
  compilePreviewRegex,
  expandPatternJs,
  expandTemplateJs,
  formatDuration,
  formatDurationWords,
  parseDuration,
  stripTimestamp,
} from "../lib/patternJs";
import {
  getOverlayDefinition,
  listOverlayDefinitions,
  overlayDefaults,
} from "../lib/overlayRegistry";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconCopy,
  IconTrash,
} from "./Icons";
import {
  getTemplate,
  leadName,
  recognizePattern,
  suggestTemplateFromLine,
  TEMPLATES,
  type CaptureChip,
  type ParamDef,
  type TemplateContext,
  type TemplateDef,
  type TemplateParams,
} from "../lib/triggerTemplates";
import type { Trigger, TriggerAction } from "../types";

// ---------------------------------------------------------------------------
// Spell data
// ---------------------------------------------------------------------------

const SPELLS = spellData as {
  castable: string[];
  all: string[];
  durations: Record<string, number>;
};

const TEMPLATE_CTX: TemplateContext = {
  durationOf(spell) {
    const d = SPELLS.durations[spell];
    return typeof d === "number" && d > 0 ? d : null;
  },
};

// ---------------------------------------------------------------------------
// Action-row model (1:1 with Trigger.actions, order preserved)
// ---------------------------------------------------------------------------

type RowKind =
  | "speak"
  | "sound"
  | "overlay"
  | "timer"
  | "cancel"
  | "webhook";

interface RowState {
  id: number;
  kind: RowKind;
  /** Speak / Show / Webhook text template. */
  text: string;
  soundPath: string;
  /** Named webhook to post to (Webhook kind); empty = the default webhook. */
  webhookName: string;
  /** Timer name (Start timer) or timer to cancel (Cancel timer). */
  timerName: string;
  durationText: string;
  warnMode: "none" | "5" | "10" | "custom";
  warnText: string;
  /** "End early when my <spell> wears off" (first Start-timer row only). */
  endEarlySpell: string;
  /** Preserved StartTimer metadata (generated packs). */
  formula?: number | null;
  capTicks?: number | null;
  /** Original action retained so controls may edit a subset without dropping
   * advanced fields that this compact editor does not expose. */
  preservedAction?: TriggerAction;
  /** Generic overlay destination, structured template fields and renderer config. */
  overlay: string;
  overlayFields: Record<string, string>;
  overlayConfig: Record<string, unknown>;
  /** Editor-only disclosure state; never serialized into Trigger.actions. */
  expanded: boolean;
  appearanceOpen: boolean;
}

let nextRowId = 1;

function blankRow(kind: RowKind): RowState {
  return {
    id: nextRowId++,
    kind,
    text: "",
    soundPath: "",
    webhookName: "",
    timerName: "",
    durationText: "0:30",
    warnMode: "none",
    warnText: "",
    endEarlySpell: "",
    overlay: "alerts",
    overlayFields: overlayDefaults("alerts").fields,
    overlayConfig: overlayDefaults("alerts").config,
    expanded: true,
    appearanceOpen: false,
  };
}

export function rowsFromActions(actions: TriggerAction[]): RowState[] {
  return actions.map<RowState>((a) => {
    if ("Speak" in a) return { ...blankRow("speak"), text: a.Speak.template };
    if ("DisplayText" in a) {
      return {
        ...blankRow("overlay"),
        overlay: "alerts",
        overlayFields: {
          ...overlayDefaults("alerts").fields,
          text: a.DisplayText.template,
        },
        // DisplayText has no presentation metadata. Preserve Auto so legacy
        // CC/danger triggers continue through the compatibility classifier.
        overlayConfig: {
          ...overlayDefaults("alerts").config,
          severity: "auto",
        },
      };
    }
    if ("PlaySound" in a) {
      return { ...blankRow("sound"), soundPath: a.PlaySound.path };
    }
    if ("CancelTimer" in a) {
      return { ...blankRow("cancel"), timerName: a.CancelTimer.name };
    }
    if ("PostWebhook" in a) {
      return {
        ...blankRow("webhook"),
        text: a.PostWebhook.template,
        webhookName: a.PostWebhook.webhook ?? "",
      };
    }
    if ("Overlay" in a) {
      return {
        ...blankRow("overlay"),
        overlay: a.Overlay.overlay || "alerts",
        overlayFields: { ...a.Overlay.fields },
        overlayConfig: { ...(a.Overlay.config ?? {}) },
      };
    }
    if ("Impact" in a) {
      return {
        ...blankRow("overlay"),
        overlay: "impact",
        overlayFields: {
          ...overlayDefaults("impact").fields,
          headline: a.Impact.headline ?? "",
          big: a.Impact.big ?? "",
          sub: a.Impact.sub ?? "",
          glyph: a.Impact.glyph ?? "",
        },
        overlayConfig: {
          ...overlayDefaults("impact").config,
          style: a.Impact.style,
          color: a.Impact.color ?? "",
        },
      };
    }
    const t = a.StartTimer;
    const warn = t.warn_at_secs;
    return {
      ...blankRow("timer"),
      timerName: t.name,
      durationText: formatDuration(t.duration_secs),
      warnMode:
        warn == null ? "none" : warn === 5 ? "5" : warn === 10 ? "10" : "custom",
      warnText: warn != null ? String(warn) : "",
      formula: t.duration_formula,
      capTicks: t.duration_cap_ticks,
      preservedAction: a,
    };
  }).map((row, index) => ({ ...row, expanded: index === 0 }));
}

function configuredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function configuredNumber(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function compactRecord<T>(record: Record<string, T | undefined | "">): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, T>;
}

function warnSecsOf(row: RowState): number | null {
  if (row.warnMode === "none") return null;
  if (row.warnMode === "5") return 5;
  if (row.warnMode === "10") return 10;
  const n = parseDuration(row.warnText);
  return n !== null && n > 0 ? n : null;
}

/** Build actions from rows; returns an error message instead on bad input. */
export function actionsFromRows(rows: RowState[]): TriggerAction[] | string {
  if (rows.length === 0) {
    return "Add at least one action — a trigger with no actions does nothing.";
  }
  const actions: TriggerAction[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "speak": {
        if (!row.text.trim()) return "Speak needs some text to say.";
        actions.push({ Speak: { template: row.text.trim() } });
        break;
      }
      case "overlay": {
        const overlay = row.overlay.trim();
        if (!overlay) return "Pick an overlay destination.";
        const definition = getOverlayDefinition(overlay);
        const fields = definition
          ? compactRecord(row.overlayFields)
          : { ...row.overlayFields };
        const missing = definition?.fields.find(
          (field) => field.required && !fields[field.key]?.trim(),
        );
        if (missing) {
          return `${definition?.label ?? overlay} needs ${missing.label.toLowerCase()}.`;
        }
        const config = definition
          ? compactRecord(row.overlayConfig)
          : { ...row.overlayConfig };
        actions.push({
          Overlay: {
            overlay,
            fields,
            ...(Object.keys(config).length > 0 ? { config } : {}),
          },
        });
        break;
      }
      case "sound": {
        if (!row.soundPath.trim()) return "Pick a sound to play.";
        actions.push({ PlaySound: { path: row.soundPath.trim() } });
        break;
      }
      case "cancel": {
        if (!row.timerName.trim()) return "Cancel timer needs a timer name.";
        actions.push({ CancelTimer: { name: row.timerName.trim() } });
        break;
      }
      case "webhook": {
        if (!row.text.trim()) return "Webhook needs a message to post.";
        const name = row.webhookName.trim();
        actions.push({
          PostWebhook: {
            template: row.text.trim(),
            ...(name ? { webhook: name } : {}),
          },
        });
        break;
      }
      case "timer": {
        const secs = parseDuration(row.durationText);
        if (!row.timerName.trim()) return "The timer needs a name.";
        if (secs === null || secs <= 0) {
          return `Timer duration "${row.durationText}" — use seconds (90), m:ss (1:30), or 35m.`;
        }
        const warn = warnSecsOf(row);
        if (warn !== null && warn >= secs) {
          return "The timer warning must be shorter than the duration.";
        }
        const preserved =
          row.preservedAction && "StartTimer" in row.preservedAction
            ? row.preservedAction.StartTimer
            : null;
        const timer: TriggerAction = {
          StartTimer: {
            ...(preserved ?? {}),
            name: row.timerName.trim(),
            duration_secs: secs,
            warn_at_secs: warn,
          },
        };
        if (row.formula != null) timer.StartTimer.duration_formula = row.formula;
        if (row.capTicks != null) {
          timer.StartTimer.duration_cap_ticks = row.capTicks;
        }
        actions.push(timer);
        break;
      }
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Autocomplete combobox over spell names; free text allowed. */
function SpellCombo({
  value,
  onChange,
  source,
  placeholder,
  onPick,
  clearOnPick,
  commitOnBlur,
  ariaLabel,
}: {
  value: string;
  onChange(v: string): void;
  source: "castable" | "all";
  placeholder?: string;
  /** Called with the chosen suggestion (Enter/click). */
  onPick?(v: string): void;
  clearOnPick?: boolean;
  /** Commit pending typed text via onPick when focus leaves the box, so
   *  Save never silently discards it (the "Ice Comet" spam-trigger trap). */
  commitOnBlur?: boolean;
  ariaLabel: string;
}) {
  const [openList, setOpenList] = useState(false);
  const [hi, setHi] = useState(0);
  const names = source === "castable" ? SPELLS.castable : SPELLS.all;

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts: string[] = [];
    const contains: string[] = [];
    for (const n of names) {
      const ln = n.toLowerCase();
      if (ln.startsWith(q)) starts.push(n);
      else if (ln.includes(q)) contains.push(n);
      if (starts.length >= 20) break;
    }
    return [...starts, ...contains].slice(0, 20);
  }, [value, names]);

  function pick(n: string) {
    if (onPick) onPick(n);
    onChange(clearOnPick ? "" : n);
    setOpenList(false);
  }

  return (
    <div className="ted-combo">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => {
          onChange(e.target.value);
          setOpenList(true);
          setHi(0);
        }}
        onFocus={() => setOpenList(true)}
        onBlur={() => {
          if (commitOnBlur && onPick && value.trim()) pick(value.trim());
          window.setTimeout(() => setOpenList(false), 120);
        }}
        onKeyDown={(e) => {
          if (!openList || matches.length === 0) {
            if (e.key === "Enter" && onPick && value.trim()) {
              e.preventDefault();
              pick(value.trim());
            }
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(matches[hi] ?? value.trim());
          } else if (e.key === "Escape") {
            // Dismiss only the suggestion popup — never the surrounding
            // modal (stopPropagation keeps the window Escape handler out).
            e.preventDefault();
            e.stopPropagation();
            setOpenList(false);
          }
        }}
      />
      {openList && matches.length > 0 && (
        <div className="ted-combo-pop" role="listbox">
          {matches.map((n, i) => (
            <div
              key={n}
              role="option"
              aria-selected={i === hi}
              className={`ted-combo-item${i === hi ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(n);
              }}
            >
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function firstClause(s: string): string {
  return s.split(/[.,(]/)[0].trim();
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export interface TriggerEditorProps {
  /** Existing trigger being edited; null = new. */
  initial: Trigger | null;
  /** Raw log line (quick create): prefills the template and the test box. */
  initialLine?: string;
  /** "card" (Triggers tab, test box collapsed) or "modal" (test box open). */
  variant: "card" | "modal";
  /** Existing user triggers — lets the editor find an "end early" companion. */
  userTriggers?: Trigger[];
  /** Enabled triggers (excluding the one being edited) for the
   *  duplicate-pattern hint. */
  existing?: { name: string; category: string | null; pattern: string }[];
  /** Reports user edits so callers can guard their discard paths. */
  onDirtyChange?(dirty: boolean): void;
  onCancel(): void;
  /**
   * Persist. `companion` is the generated "<name> — end early" trigger (null
   * = none / remove); `prevCompanionName` names the companion a previous save
   * created, so callers can replace or drop it.
   */
  onSave(
    trigger: Trigger,
    companion: Trigger | null,
    prevCompanionName: string | null,
  ): Promise<void>;
}

interface InitState {
  mode: "builder" | "advanced";
  templateId: string;
  params: TemplateParams;
  variantIx: number;
  advPattern: string;
  name: string;
  category: string;
  rows: RowState[];
  enabled: boolean;
  caseIns: boolean;
  dirty: boolean;
  endEarlySpell: string;
  testLine: string;
}

function defaultParams(t: TemplateDef): TemplateParams {
  const p: TemplateParams = {};
  for (const def of t.params) {
    if (def.kind === "seg") p[def.key] = def.options[0].value;
    else if (def.kind === "toggle") p[def.key] = false;
    else if (def.kind === "spells") p[def.key] = [];
    else p[def.key] = "";
  }
  if (t.id === "i-die") p["alsoSlain"] = true;
  return p;
}

function findCompanionSpell(
  initial: Trigger | null,
  userTriggers: Trigger[] | undefined,
): string {
  if (!initial || !userTriggers) return "";
  const companion = userTriggers.find(
    (t) =>
      t.name === `${initial.name} — end early` &&
      t.actions.some((a) => "CancelTimer" in a),
  );
  if (!companion) return "";
  const worn = getTemplate("worn-off");
  const parsed = worn?.parse(companion.pattern);
  const spell = parsed?.params["spell"];
  return typeof spell === "string" ? spell : "";
}

function computeInit(
  initial: Trigger | null,
  initialLine: string | undefined,
  userTriggers: Trigger[] | undefined,
): InitState {
  if (initial) {
    const hit = recognizePattern(initial.pattern);
    const rows = rowsFromActions(initial.actions);
    const endEarlySpell = findCompanionSpell(initial, userTriggers);
    if (endEarlySpell) {
      const t = rows.find((r) => r.kind === "timer");
      if (t) t.endEarlySpell = endEarlySpell;
    }
    return {
      mode: hit ? "builder" : "advanced",
      templateId: hit?.template.id ?? "contains",
      params: hit?.params ?? {},
      variantIx: hit?.variantIx ?? 0,
      advPattern: initial.pattern,
      name: initial.name,
      category: initial.category ?? "",
      rows,
      enabled: initial.enabled,
      caseIns: initial.case_insensitive !== false,
      dirty: true,
      endEarlySpell,
      // Seed the (collapsed) test box with the template's canonical example
      // so expanding it is a one-click "show me".
      testLine: hit ? hit.template.exampleLine(hit.params) : "",
    };
  }
  const message = initialLine ? stripTimestamp(initialLine) : "";
  const suggestion = message
    ? suggestTemplateFromLine(message)
    : { template: TEMPLATES[0], params: defaultParams(TEMPLATES[0]) };
  const t = suggestion.template;
  const params = { ...defaultParams(t), ...suggestion.params };
  return {
    mode: "builder",
    templateId: t.id,
    params,
    variantIx: 0,
    advPattern: "",
    name: t.suggestName(params),
    category: t.defaultCategory,
    rows: rowsFromActions(t.defaultActions(params, TEMPLATE_CTX)),
    enabled: true,
    caseIns: true,
    dirty: false,
    endEarlySpell: "",
    testLine: message || t.exampleLine(params),
  };
}

export default function TriggerEditor({
  initial,
  initialLine,
  variant,
  userTriggers,
  existing,
  onDirtyChange,
  onCancel,
  onSave,
}: TriggerEditorProps) {
  const init = useMemo(
    () => computeInit(initial, initialLine, userTriggers),
    // The editor instance is keyed by its caller; props don't change mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [mode, setMode] = useState(init.mode);
  const [templateId, setTemplateId] = useState(init.templateId);
  const [params, setParams] = useState(init.params);
  const [variantIx, setVariantIx] = useState(init.variantIx);
  const [advPattern, setAdvPattern] = useState(init.advPattern);
  const [advOpen, setAdvOpen] = useState(init.mode === "advanced");
  const [caseIns, setCaseIns] = useState(init.caseIns);
  const [name, setName] = useState(init.name);
  const [category, setCategory] = useState(init.category);
  const [rows, setRows] = useState<RowState[]>(init.rows);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [enabled, setEnabled] = useState(init.enabled);
  /** Refire cooldown in seconds; 0 = fire on every match. */
  const [cooldown, setCooldown] = useState<number>(initial?.cooldown_secs ?? 0);
  const [testLine, setTestLine] = useState(init.testLine);
  const [testOpen, setTestOpen] = useState(
    variant === "modal" || Boolean(initialLine),
  );
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sounds, setSounds] = useState<SoundInfo[]>([]);
  const [character, setCharacter] = useState("");
  const [previewState, setPreviewState] = useState<
    Record<number, "playing" | "failed">
  >({});
  const dirty = useRef({
    name: init.dirty,
    category: init.dirty,
    actions: init.dirty,
  });
  const textRefs = useRef(new Map<number, HTMLInputElement>());
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  /** True once the user has edited anything (guards discard paths). */
  const touched = useRef(false);
  /** True once the user typed in the test box (stop reseeding examples). */
  const testTouched = useRef(Boolean(initialLine));
  /** The test box auto-expands only once per editor instance. */
  const autoOpenedTest = useRef(false);

  function touch() {
    if (!touched.current) {
      touched.current = true;
      onDirtyChange?.(true);
    }
  }

  /** #16: reveal the test box on the first meaningful "When…" input. */
  function revealTest() {
    if (autoOpenedTest.current) return;
    autoOpenedTest.current = true;
    setTestOpen(true);
  }

  /** Raise a save/validation error; the banner scrolls into view + focuses
   *  even when the same message repeats (errorTick). */
  function fail(msg: string) {
    setError(msg);
    setErrorTick((t) => t + 1);
  }

  useEffect(() => {
    listSounds().then(setSounds).catch(() => {});
    getConfig()
      .then((c) => setCharacter(c.characterName))
      .catch(() => {});
  }, []);

  // On open: bring the editor into view (Edit on a deep tree row otherwise
  // opens at -2500px with zero visible change) and focus the Name field.
  useEffect(() => {
    if (variant === "card") {
      const reduce = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      )?.matches;
      if (!rootRef.current?.closest(".trigger-editor-workspace")) {
        const card = rootRef.current?.closest(".card.editor") ?? rootRef.current;
        card?.scrollIntoView({
          block: "start",
          behavior: reduce ? "auto" : "smooth",
        });
      }
    }
    nameRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save/validation errors must never render off-screen (silent failure).
  useEffect(() => {
    if (!error) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      ?.matches;
    errorRef.current?.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
    errorRef.current?.focus({ preventScroll: true });
  }, [error, errorTick]);

  const template = mode === "builder" ? getTemplate(templateId) : null;
  const pattern = template ? template.build(params, variantIx) : advPattern;

  // Auto-fill name / category / default actions until the user edits them;
  // templates with a purpose-built sound (Tell, Death) prefill it as an
  // extra row. The test box tracks the template's example line until the
  // user types their own.
  useEffect(() => {
    if (mode !== "builder") return;
    const t = getTemplate(templateId);
    if (!t) return;
    if (!dirty.current.name) setName(t.suggestName(params));
    if (!dirty.current.category) setCategory(t.defaultCategory);
    if (!dirty.current.actions) {
      const nextRows = rowsFromActions(t.defaultActions(params, TEMPLATE_CTX));
      if (t.defaultSound) {
        const s = sounds.find((x) => x.label === t.defaultSound);
        if (s) nextRows.push({ ...blankRow("sound"), soundPath: s.path });
      }
      setRows(nextRows);
    }
    if (!testTouched.current) setTestLine(t.exampleLine(params));
  }, [mode, templateId, params, sounds]);

  const chips: CaptureChip[] = useMemo(() => {
    if (template) return template.captures(params, variantIx);
    // Advanced mode: generic labels for however many groups the pattern has.
    const groups = (advPattern.match(/\((?!\?)/g) ?? []).length;
    return Array.from({ length: Math.min(groups, 6) }, (_, i) => ({
      group: i + 1,
      label: `capture ${i + 1}`,
      token: `$\{${i + 1}}`,
    }));
  }, [template, params, variantIx, advPattern]);

  // Compile state, independent of the test line — surfaces regex errors in
  // the Advanced section itself (the test box may be collapsed).
  const compileError = useMemo(() => {
    try {
      compilePreviewRegex(expandPatternJs(pattern, character), caseIns);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [pattern, character, caseIns]);

  // Duplicate-pattern hint: the built pattern already fires elsewhere.
  const dupe = useMemo(() => {
    if (!existing || !pattern.trim()) return null;
    return existing.find((x) => x.pattern === pattern) ?? null;
  }, [existing, pattern]);

  // Non-empty test lines, timestamp stripped per line (P34: batch paste).
  const testLines = useMemo(
    () =>
      testLine
        .split(/\r?\n/)
        .map((l) => stripTimestamp(l))
        .filter((l) => l.trim().length > 0),
    [testLine],
  );

  // Live test evaluation of the FIRST line (drives captures + will-do preview).
  const test = useMemo(() => {
    let re: RegExp;
    try {
      re = compilePreviewRegex(expandPatternJs(pattern, character), caseIns);
    } catch (e) {
      return {
        state: "err" as const,
        text: `Invalid pattern: ${e instanceof Error ? e.message : String(e)}`,
        match: null,
      };
    }
    const first = testLines[0];
    if (!first) return null;
    const match = re.exec(first) as RegExpExecArray | null;
    return match
      ? { state: "ok" as const, text: "Pattern matches this line", match }
      : {
          state: "miss" as const,
          text: "Pattern does not match this line",
          match: null,
        };
  }, [pattern, character, caseIns, testLines]);

  // Batch evaluation across all pasted lines (P34) — a match count + per-line
  // hit/miss list, so anti-spam generalization can be tuned on real volume.
  const batch = useMemo(() => {
    if (testLines.length <= 1) return null;
    let re: RegExp;
    try {
      re = compilePreviewRegex(expandPatternJs(pattern, character), caseIns);
    } catch {
      return null; // the single-line `test` already surfaces the error
    }
    // Strip any global flag so `.test()` doesn't advance lastIndex between lines.
    const one = new RegExp(re.source, re.flags.replace("g", ""));
    const results = testLines.map((line) => ({ line, hit: one.test(line) }));
    return { results, matched: results.filter((r) => r.hit).length };
  }, [pattern, character, caseIns, testLines]);

  const nowSecs = Math.floor(Date.now() / 1000);

  function willDo(row: RowState, match: RegExpExecArray | null): string {
    const render = (tpl: string) =>
      expandTemplateJs(tpl, match, character || "you", nowSecs);
    switch (row.kind) {
      case "speak":
        return `Will say: “${render(row.text)}”`;
      case "overlay": {
        const definition = getOverlayDefinition(row.overlay);
        const preferredKeys = [
          ...(definition?.fields.filter((field) => field.required) ?? []),
          ...(definition?.fields ?? []),
        ].map((field) => field.key);
        const raw = preferredKeys
          .map((key) => row.overlayFields[key])
          .find((value) => value?.trim()) ??
          Object.values(row.overlayFields).find((value) => value.trim()) ??
          "";
        return `Sends to ${definition?.label ?? (row.overlay || "overlay")}: ${raw ? render(raw) : "structured data"}`;
      }
      case "sound": {
        const s = matchSound(row.soundPath);
        return `Plays: ${s ? s.label : baseName(row.soundPath) || "(no sound picked)"}`;
      }
      case "cancel":
        return `Cancels timer: ${render(row.timerName)}`;
      case "webhook":
        return `Posts to ${row.webhookName.trim() || "default"} webhook: “${render(row.text)}”`;
      case "timer": {
        const secs = parseDuration(row.durationText);
        const warn = warnSecsOf(row);
        return `Starts timer: ${render(row.timerName)} — ${
          secs !== null ? formatDuration(secs) : "?"
        }${warn !== null ? `, warn at ${formatDuration(warn)}` : ""}`;
      }
    }
  }

  function actionLabel(row: RowState): string {
    switch (row.kind) {
      case "overlay":
        return `${getOverlayDefinition(row.overlay)?.label ?? row.overlay ?? "Unknown"} overlay`;
      case "speak":
        return "Text to speech";
      case "sound":
        return "Play sound";
      case "timer":
        return "Start timer";
      case "cancel":
        return "Cancel timer";
      case "webhook":
        return "Legacy webhook";
    }
  }

  function actionBadge(kind: RowKind): string {
    return {
      overlay: "OV",
      speak: "TTS",
      sound: "SND",
      timer: "TMR",
      cancel: "END",
      webhook: "WEB",
    }[kind];
  }

  function matchSound(path: string): SoundInfo | null {
    if (!path) return null;
    const base = baseName(path);
    return sounds.find((s) => s.path === path || s.file === base) ?? null;
  }

  // ---- state updaters ----

  const setParam = (key: string, value: string | string[] | boolean) => {
    touch();
    revealTest();
    setParams((p) => ({ ...p, [key]: value }));
  };

  const updateRow = (id: number, patch: Partial<RowState>) => {
    touch();
    dirty.current.actions = true;
    if (patch.soundPath !== undefined) {
      setPreviewState((ps) => {
        if (!(id in ps)) return ps;
        const next = { ...ps };
        delete next[id];
        return next;
      });
    }
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const setRowDisclosure = (
    id: number,
    patch: Pick<Partial<RowState>, "expanded" | "appearanceOpen">,
  ) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (id: number) => {
    touch();
    dirty.current.actions = true;
    setRows((rs) => rs.filter((r) => r.id !== id));
  };

  const moveRow = (id: number, delta: -1 | 1) => {
    touch();
    dirty.current.actions = true;
    setRows((current) => {
      const from = current.findIndex((row) => row.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const duplicateRow = (id: number) => {
    touch();
    dirty.current.actions = true;
    setRows((current) => {
      const index = current.findIndex((row) => row.id === id);
      if (index < 0) return current;
      const source = current[index];
      const duplicate: RowState = {
        ...source,
        id: nextRowId++,
        overlayFields: { ...source.overlayFields },
        overlayConfig: { ...source.overlayConfig },
        expanded: true,
      };
      const next = [...current];
      next.splice(index + 1, 0, duplicate);
      return next;
    });
  };

  const addRow = (kind: RowKind) => {
    touch();
    dirty.current.actions = true;
    const row = blankRow(kind);
    if (kind === "sound") row.soundPath = sounds[0]?.path ?? "";
    if (kind === "timer") row.timerName = name || "Timer";
    if (kind === "overlay") {
      const defaults = overlayDefaults("alerts");
      row.overlayFields = { ...defaults.fields, text: name || "Alert" };
      row.overlayConfig = defaults.config;
    }
    setRows((rs) => [...rs, row]);
    setAddMenuOpen(false);
  };

  function insertToken(rowId: number, token: string) {
    const el = textRefs.current.get(rowId);
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== rowId) return r;
        const field = r.kind === "timer" || r.kind === "cancel" ? "timerName" : "text";
        const cur = field === "text" ? r.text : r.timerName;
        const at = el?.selectionStart ?? cur.length;
        const end = el?.selectionEnd ?? at;
        const next = cur.slice(0, at) + token + cur.slice(end);
        if (el) {
          window.requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(at + token.length, at + token.length);
          });
        }
        return { ...r, [field]: next };
      }),
    );
    touch();
    dirty.current.actions = true;
  }

  function pickTemplate(id: string) {
    touch();
    revealTest();
    setError(null);
    if (id === "__custom__") {
      setAdvPattern(pattern);
      setMode("advanced");
      setAdvOpen(true);
      return;
    }
    const t = getTemplate(id);
    if (!t) return;
    // Coming back from Advanced: adopt the pattern if this template owns it.
    const parsed = mode === "advanced" ? t.parse(advPattern) : null;
    setTemplateId(id);
    setParams(parsed?.params ?? defaultParams(t));
    setVariantIx(parsed?.variantIx ?? 0);
    setMode("builder");
  }

  function backToBuilder() {
    const hit = recognizePattern(advPattern);
    if (!hit) return;
    touch();
    setTemplateId(hit.template.id);
    setParams(hit.params);
    setVariantIx(hit.variantIx);
    setMode("builder");
  }

  async function browseSound(rowId: number) {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Audio file", extensions: ["wav", "mp3"] }],
      });
      if (typeof picked === "string") updateRow(rowId, { soundPath: picked });
    } catch {
      fail("Browsing for a file needs the desktop app.");
    }
  }

  async function doPreview(row: RowState) {
    const s = matchSound(row.soundPath);
    const path = s?.path ?? row.soundPath;
    setPreviewState((ps) => ({ ...ps, [row.id]: "playing" }));
    try {
      await previewSound(path);
      const ms = s?.duration_ms ?? 800;
      window.setTimeout(
        () =>
          setPreviewState((ps) => {
            if (ps[row.id] !== "playing") return ps;
            const next = { ...ps };
            delete next[row.id];
            return next;
          }),
        Math.max(300, ms),
      );
    } catch {
      setPreviewState((ps) => ({ ...ps, [row.id]: "failed" }));
    }
  }

  // ---- save ----

  async function handleSave() {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      fail("Give the trigger a name.");
      return;
    }
    if (!pattern.trim()) {
      fail(
        template
          ? "Fill in the highlighted fields above — the pattern is empty."
          : "Enter a pattern.",
      );
      return;
    }
    try {
      compilePreviewRegex(expandPatternJs(pattern, character), caseIns);
    } catch (e) {
      fail(
        `The pattern does not compile: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    const actions = actionsFromRows(rows);
    if (typeof actions === "string") {
      fail(actions);
      return;
    }
    const trigger: Trigger = {
      ...(initial ?? {}),
      case_insensitive: caseIns,
      name: trimmedName,
      pattern,
      category: category.trim() || (variant === "modal" ? "Custom" : null),
      enabled,
      actions,
      cooldown_secs: cooldown > 0 ? cooldown : null,
    };
    let companion: Trigger | null = null;
    const timerRow = rows.find((r) => r.kind === "timer");
    if (timerRow && timerRow.endEarlySpell.trim()) {
      const worn = getTemplate("worn-off");
      const spell = timerRow.endEarlySpell.trim();
      if (worn) {
        companion = {
          name: `${trimmedName} — end early`,
          pattern: worn.build({ spell, withTarget: false }, 1),
          enabled: true,
          case_insensitive: true,
          category: trigger.category,
          comments: `Auto-generated: cancels the "${timerRow.timerName.trim()}" timer when ${spell} wears off.`,
          actions: [{ CancelTimer: { name: timerRow.timerName.trim() } }],
        };
      }
    }
    setSaving(true);
    try {
      await onSave(
        trigger,
        companion,
        initial ? `${initial.name} — end early` : null,
      );
      onDirtyChange?.(false);
    } catch (e) {
      setSaving(false);
      fail(String(e));
    }
  }

  // ---- rendering ----

  function renderParam(def: ParamDef) {
    const t = template;
    if (!t) return null;
    switch (def.kind) {
      case "text": {
        const value = typeof params[def.key] === "string" ? (params[def.key] as string) : "";
        // GINA migrants paste regex into W16's literal-text field; detect it
        // and offer the Custom-pattern mode instead of double-escaping.
        const looksRegex =
          t.id === "contains" &&
          def.key === "text" &&
          (value.startsWith("^") ||
            /\{[SsNnCc]\d*\}/.test(value) ||
            /\\[dwsDWS]/.test(value) ||
            value.includes("(.+)") ||
            value.includes(".*") ||
            /[^\\]\$$/.test(value));
        return (
          <label className="field ted-param" key={def.key}>
            <span>{def.label}</span>
            <div className="ted-param-line">
              <input
                type="text"
                value={value}
                placeholder={def.placeholder}
                onChange={(e) => setParam(def.key, e.target.value)}
              />
              {def.allowCharChip && value !== "{C}" && (
                <button
                  type="button"
                  className="ted-chip"
                  title="Use your character's name (the {C} token — expands per character)"
                  onClick={() => setParam(def.key, "{C}")}
                >
                  my character
                </button>
              )}
            </div>
            {looksRegex && (
              <div className="ted-warn">
                This looks like a regex pattern — here it would match as
                literal text.{" "}
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    touch();
                    setAdvPattern(value);
                    setMode("advanced");
                    setAdvOpen(true);
                  }}
                >
                  Use as a custom pattern
                </button>
              </div>
            )}
          </label>
        );
      }
      case "spell": {
        const value = typeof params[def.key] === "string" ? (params[def.key] as string) : "";
        return (
          <label className="field ted-param" key={def.key}>
            <span>{def.label}</span>
            <SpellCombo
              value={value}
              onChange={(v) => setParam(def.key, v)}
              source={def.source}
              placeholder={def.placeholder}
              ariaLabel={def.label}
            />
          </label>
        );
      }
      case "spells": {
        const values = Array.isArray(params[def.key]) ? (params[def.key] as string[]) : [];
        return (
          <div className="field ted-param" key={def.key}>
            <span className="field-label">
              {def.label}
              {values.length === 0 && (
                <span className="ted-param-note"> — empty = any spell</span>
              )}
            </span>
            {values.length > 0 && (
              <div className="ted-chips ted-spell-chips">
                {values.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className="ted-chip"
                    title="Remove"
                    onClick={() =>
                      setParam(def.key, values.filter((x) => x !== s))
                    }
                  >
                    {s} ✕
                  </button>
                ))}
              </div>
            )}
            <SpellCombo
              value={typeof params["__spellsDraft"] === "string" ? (params["__spellsDraft"] as string) : ""}
              onChange={(v) => setParam("__spellsDraft", v)}
              onPick={(v) => {
                if (v && !values.includes(v)) setParam(def.key, [...values, v]);
              }}
              clearOnPick
              commitOnBlur
              source={def.source}
              placeholder="add a spell…"
              ariaLabel={`Add ${def.label}`}
            />
            {values.includes("Gate") && (
              <div className="hint ted-param-note">
                Classic mobs also say “begins to cast the gate spell.” — the
                curated pack covers that form.
              </div>
            )}
          </div>
        );
      }
      case "seg": {
        const value = typeof params[def.key] === "string" ? (params[def.key] as string) : def.options[0].value;
        return (
          <div className="field ted-param" key={def.key}>
            <span className="field-label">{def.label}</span>
            <div className="seg">
              {def.options.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={value === o.value ? "active" : ""}
                  aria-pressed={value === o.value}
                  onClick={() => setParam(def.key, o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      }
      case "toggle": {
        // W16's generalize toggles get contextual labels + disabled reasons.
        const value = params[def.key] === true;
        let label: string = def.label;
        let disabled = false;
        let why: string | undefined;
        if (t.id === "contains") {
          const text = typeof params["text"] === "string" ? (params["text"] as string) : "";
          if (def.key === "anyName") {
            if (typeof params["position"] === "string" && params["position"] === "anywhere") {
              return null; // leading-name generalization needs a line start
            }
            const lead = leadName(text);
            label = lead ? `Anyone, not just ${lead}` : "Any leading name";
            disabled = lead === null;
            why = disabled
              ? "The text doesn't start with a name the matcher recognizes."
              : undefined;
          } else if (def.key === "anyNumbers") {
            disabled = !/\d/.test(text);
            why = disabled ? "There are no numbers in the text." : undefined;
          }
        }
        return (
          <label className="check-row ted-param" key={def.key} title={why}>
            <input
              type="checkbox"
              className="switch"
              checked={value && !disabled}
              disabled={disabled}
              onChange={(e) => setParam(def.key, e.target.checked)}
            />
            {label}
          </label>
        );
      }
    }
  }

  function renderRow(row: RowState, isFirstTimer: boolean, rowIndex: number) {
    const rowChips = [
      ...chips,
      { group: 0, label: "my character", token: "{C}" },
      { group: 0, label: "time", token: "{TS}" },
    ];
    return (
      <div className={`ted-action-card${row.expanded ? " open" : ""}`} key={row.id}>
        <div className="ted-action-head">
          <button
            type="button"
            className="ted-action-toggle"
            aria-expanded={row.expanded}
            onClick={() => setRowDisclosure(row.id, { expanded: !row.expanded })}
          >
            <span className={`ted-action-chevron${row.expanded ? " open" : ""}`}>
              <IconChevronDown size={14} />
            </span>
            <span className="ted-action-badge" aria-hidden="true">{actionBadge(row.kind)}</span>
            <span className="ted-action-title">
              <strong>{actionLabel(row)}</strong>
              <span>{willDo(row, test?.match ?? null)}</span>
            </span>
          </button>
          <div className="ted-action-tools">
            <button type="button" className="icon-button" title="Move action up" aria-label="Move action up" disabled={rowIndex === 0} onClick={() => moveRow(row.id, -1)}>
              <IconArrowUp />
            </button>
            <button type="button" className="icon-button" title="Move action down" aria-label="Move action down" disabled={rowIndex === rows.length - 1} onClick={() => moveRow(row.id, 1)}>
              <IconArrowDown />
            </button>
            <button type="button" className="icon-button" title="Duplicate action" aria-label="Duplicate action" onClick={() => duplicateRow(row.id)}>
              <IconCopy />
            </button>
            <button type="button" className="icon-button danger" title="Delete action" aria-label="Delete action" onClick={() => removeRow(row.id)}>
              <IconTrash />
            </button>
          </div>
        </div>

        {row.expanded && <div className="ted-action-main">
          {(row.kind === "speak" || row.kind === "webhook") && (
            <>
              <input
                type="text"
                ref={(el) => {
                  if (el) textRefs.current.set(row.id, el);
                  else textRefs.current.delete(row.id);
                }}
                value={row.text}
                placeholder={
                  row.kind === "speak"
                    ? "what to say aloud"
                    : "message to post"
                }
                aria-label={
                  row.kind === "speak"
                    ? "Speak text"
                    : "Webhook message"
                }
                onChange={(e) => updateRow(row.id, { text: e.target.value })}
              />
              <div className="ted-chips">
                {rowChips.map((c) => (
                  <button
                    type="button"
                    key={`${c.token}`}
                    className="ted-chip"
                    title={`Inserts ${c.token}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertToken(row.id, c.token)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {row.kind === "webhook" && (
                <>
                  <div className="ted-warn">
                    Webhook delivery is unavailable in this build. This legacy
                    action will be preserved unless you delete it.
                  </div>
                  <input
                    type="text"
                    value={row.webhookName}
                    placeholder="webhook name (blank = default)"
                    aria-label="Webhook name"
                    onChange={(e) =>
                      updateRow(row.id, { webhookName: e.target.value })
                    }
                  />
                  <div className="hint">
                    Posts to a webhook you configure in Settings. The URL stays
                    in your settings — only the name is saved here, so a shared
                    trigger never leaks your endpoint.
                  </div>
                </>
              )}
            </>
          )}

          {row.kind === "overlay" && (() => {
            const definitions = listOverlayDefinitions();
            const definition = getOverlayDefinition(row.overlay);
            const changeDestination = (overlay: string) => {
              const defaults = overlayDefaults(overlay);
              updateRow(row.id, {
                overlay,
                overlayFields: defaults.fields,
                overlayConfig: defaults.config,
              });
            };
            const setField = (key: string, value: string) =>
              updateRow(row.id, {
                overlayFields: { ...row.overlayFields, [key]: value },
              });
            const setConfig = (key: string, value: unknown) =>
              updateRow(row.id, {
                overlayConfig: { ...row.overlayConfig, [key]: value },
              });
            return (
              <div className="ted-impact">
                <label className="field">
                  <span>Overlay</span>
                  <select
                    value={row.overlay}
                    aria-label="Overlay destination"
                    onChange={(e) => changeDestination(e.target.value)}
                  >
                    {!definition && row.overlay && (
                      <option value={row.overlay}>{row.overlay}</option>
                    )}
                    {definitions.map((item) => (
                      <option value={item.id} key={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                {definition && <div className="hint">{definition.description}</div>}
                {definition?.fields.map((field) => (
                  <label className="field" key={field.key} title={field.description}>
                    <span>{field.label}{field.required ? " *" : ""}</span>
                    {field.type === "textarea" ? (
                      <textarea
                        value={row.overlayFields[field.key] ?? ""}
                        placeholder={field.placeholder}
                        onChange={(e) => setField(field.key, e.target.value)}
                      />
                    ) : field.type === "select" ? (
                      <select
                        value={row.overlayFields[field.key] ?? field.default}
                        onChange={(e) => setField(field.key, e.target.value)}
                      >
                        {field.options?.map((option) => (
                          <option value={option.value} key={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={row.overlayFields[field.key] ?? ""}
                        placeholder={field.placeholder}
                        onChange={(e) => setField(field.key, e.target.value)}
                      />
                    )}
                  </label>
                ))}
                {definition && definition.config.length > 0 && (
                  <button
                    type="button"
                    className="ted-appearance-toggle"
                    aria-expanded={row.appearanceOpen}
                    onClick={() => setRowDisclosure(row.id, { appearanceOpen: !row.appearanceOpen })}
                  >
                    <span>Appearance and behavior</span>
                    <span className={`ted-action-chevron${row.appearanceOpen ? " open" : ""}`}>
                      <IconChevronDown size={14} />
                    </span>
                  </button>
                )}
                {row.appearanceOpen && definition?.config.map((config) => (
                  <label className="field" key={config.key} title={config.description}>
                    <span>{config.label}</span>
                    {config.type === "select" ? (
                      <select
                        value={configuredString(row.overlayConfig, config.key) || String(config.default)}
                        onChange={(e) => setConfig(config.key, e.target.value)}
                      >
                        {config.options?.map((option) => (
                          <option value={option.value} key={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : config.type === "number" ? (
                      <input
                        type="number"
                        min={config.min == null ? undefined : config.min / (config.inputScale ?? 1)}
                        max={config.max == null ? undefined : config.max / (config.inputScale ?? 1)}
                        step={config.step == null ? undefined : config.step / (config.inputScale ?? 1)}
                        value={(() => {
                          const raw = configuredNumber(row.overlayConfig, config.key);
                          return raw === "" ? "" : Number(raw) / (config.inputScale ?? 1);
                        })()}
                        placeholder={
                          typeof config.default === "number"
                            ? String(config.default / (config.inputScale ?? 1))
                            : "default"
                        }
                        onChange={(e) =>
                          setConfig(
                            config.key,
                            e.target.value === ""
                              ? ""
                              : Number(e.target.value) * (config.inputScale ?? 1),
                          )
                        }
                      />
                    ) : config.type === "color" ? (
                      <div className="ted-color-line">
                        <input
                          type="color"
                          aria-label={`${config.label} picker`}
                          value={configuredString(row.overlayConfig, config.key) || "#ffffff"}
                          onChange={(e) => setConfig(config.key, e.target.value)}
                        />
                        <input
                          type="text"
                          value={configuredString(row.overlayConfig, config.key)}
                          placeholder="Overlay default"
                          onChange={(e) => setConfig(config.key, e.target.value)}
                        />
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={configuredString(row.overlayConfig, config.key)}
                        placeholder={config.placeholder}
                        onChange={(e) => setConfig(config.key, e.target.value)}
                      />
                    )}
                  </label>
                ))}
                {!definition && (
                  <div className="hint">
                    This destination is not installed in this build. Its fields and
                    presentation settings will be preserved unchanged.
                  </div>
                )}
              </div>
            );
          })()}

          {row.kind === "sound" && (
            <div className="ted-sound-line">
              <select
                value={
                  matchSound(row.soundPath)?.path ??
                  (row.soundPath ? "__custom__" : "")
                }
                aria-label="Sound"
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__browse__") void browseSound(row.id);
                  else if (v !== "__custom__") updateRow(row.id, { soundPath: v });
                }}
              >
                {!row.soundPath && <option value="">choose a sound…</option>}
                {sounds.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.label} — {firstClause(s.description)}
                  </option>
                ))}
                {row.soundPath && !matchSound(row.soundPath) && (
                  <option value="__custom__">
                    Custom: {baseName(row.soundPath)}
                  </option>
                )}
                <option value="__browse__">Custom file…</option>
              </select>
              <button
                type="button"
                className="ghost small"
                disabled={!row.soundPath || previewState[row.id] === "playing"}
                onClick={() => void doPreview(row)}
              >
                {previewState[row.id] === "playing" ? "Playing…" : "▸ Preview"}
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => void browseSound(row.id)}
              >
                Browse…
              </button>
              {previewState[row.id] === "failed" && (
                <span className="ted-warn">
                  Couldn’t play this sound — check that the file exists.
                </span>
              )}
            </div>
          )}

          {(row.kind === "timer" || row.kind === "cancel") && (
            <>
              <div className="ted-timer-line">
                <input
                  type="text"
                  className="ted-timer-name"
                  ref={(el) => {
                    if (el) textRefs.current.set(row.id, el);
                    else textRefs.current.delete(row.id);
                  }}
                  value={row.timerName}
                  placeholder="timer name"
                  aria-label="Timer name"
                  onChange={(e) => updateRow(row.id, { timerName: e.target.value })}
                />
                {row.kind === "timer" && (
                  <>
                    <label className="ted-inline-field">
                      <span>for</span>
                      <input
                        type="text"
                        className="ted-duration"
                        value={row.durationText}
                        aria-label="Duration"
                        placeholder="1:30"
                        onChange={(e) =>
                          updateRow(row.id, { durationText: e.target.value })
                        }
                      />
                    </label>
                    <span className="hint num">
                      {(() => {
                        const secs = parseDuration(row.durationText);
                        // In words — "10" must read as seconds, not "0:10"
                        // (a plausible ten-minute intent).
                        return secs !== null
                          ? `= ${formatDurationWords(secs)}`
                          : "?";
                      })()}
                    </span>
                    <label className="ted-inline-field">
                      <span>warn</span>
                      <select
                        value={row.warnMode}
                        aria-label="Warn before end"
                        onChange={(e) =>
                          updateRow(row.id, {
                            warnMode: e.target.value as RowState["warnMode"],
                          })
                        }
                      >
                        <option value="none">never</option>
                        <option value="5">5 s before end</option>
                        <option value="10">10 s before end</option>
                        <option value="custom">custom…</option>
                      </select>
                    </label>
                    {row.warnMode === "custom" && (
                      <input
                        type="text"
                        className="ted-duration"
                        value={row.warnText}
                        placeholder="secs"
                        aria-label="Warn seconds"
                        onChange={(e) => updateRow(row.id, { warnText: e.target.value })}
                      />
                    )}
                  </>
                )}
              </div>
              <div className="ted-chips">
                {rowChips.map((c) => (
                  <button
                    type="button"
                    key={c.token}
                    className="ted-chip"
                    title={`Inserts ${c.token} into the timer name`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertToken(row.id, c.token)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {row.kind === "timer" && (
                <div className="hint">
                  A new match with the same timer name restarts the bar.
                </div>
              )}
              {row.kind === "timer" && isFirstTimer && (
                <label className="field ted-endearly">
                  <span>End early when this spell of mine wears off (optional)</span>
                  <SpellCombo
                    value={row.endEarlySpell}
                    onChange={(v) => updateRow(row.id, { endEarlySpell: v })}
                    source="castable"
                    placeholder="e.g. Walking Sleep — saves a companion cancel trigger"
                    ariaLabel="End early spell"
                  />
                </label>
              )}
            </>
          )}

        </div>}
      </div>
    );
  }

  const firstTimerId = rows.find((r) => r.kind === "timer")?.id;
  const labelByGroup = new Map(chips.map((c) => [c.group, c.label]));
  const recognizedAdv = mode === "advanced" ? recognizePattern(advPattern) : null;

  return (
    <div className="ted" ref={rootRef}>
      {error && (
        <div
          className="error-banner ted-error"
          ref={errorRef}
          tabIndex={-1}
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="ted-namecat">
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            ref={nameRef}
            value={name}
            onChange={(e) => {
              touch();
              dirty.current.name = true;
              setName(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>Category</span>
          <input
            type="text"
            value={category}
            placeholder="e.g. Combat/Defense"
            onChange={(e) => {
              touch();
              dirty.current.category = true;
              setCategory(e.target.value);
            }}
          />
        </label>
      </div>

      <div className="ted-section">
        <div className="ted-sec-head">
          <span className="section-title">When</span>
          <button
            type="button"
            className="ghost small"
            aria-expanded={advOpen}
            onClick={() => setAdvOpen((v) => !v)}
          >
            Advanced {advOpen ? "▾" : "▸"}
          </button>
        </div>
        <select
          className="ted-template"
          value={mode === "advanced" ? "__custom__" : templateId}
          aria-label="When"
          onChange={(e) => pickTemplate(e.target.value)}
        >
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
          <option value="__custom__">Custom pattern (regex)…</option>
        </select>

        {template && template.params.length > 0 && (
          <div className="ted-params">{template.params.map(renderParam)}</div>
        )}
        {template && (
          <div className="ted-sentence">{template.sentence(params)}</div>
        )}

        {(advOpen || mode === "advanced") && (
          <div className="ted-advanced">
            {mode === "builder" ? (
              <>
                <label className="field">
                  <span>Derived pattern (read-only)</span>
                  <input type="text" value={pattern} readOnly />
                </label>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setAdvPattern(pattern);
                    setMode("advanced");
                  }}
                >
                  Edit pattern directly
                </button>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Pattern (regex)</span>
                  <input
                    type="text"
                    value={advPattern}
                    onChange={(e) => {
                      touch();
                      revealTest();
                      setAdvPattern(e.target.value);
                    }}
                  />
                </label>
                {compileError && (
                  <div className="qt-preview err" role="alert">
                    <span className="dot" />
                    Pattern error: {compileError}
                  </div>
                )}
                <div className="ted-adv-row">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      className="switch"
                      checked={caseIns}
                      onChange={(e) => {
                        touch();
                        setCaseIns(e.target.checked);
                      }}
                    />
                    Ignore upper/lower case
                  </label>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="ghost small"
                    disabled={!recognizedAdv}
                    title={
                      recognizedAdv
                        ? undefined
                        : "This pattern doesn't match any builder template."
                    }
                    onClick={backToBuilder}
                  >
                    ◂ Back to builder
                  </button>
                </div>
                <div className="hint">
                  {"{C}"} your name · {"{S1}"} any text · {"{N1}"} any number ·
                  use {"${1}"} / {"${S1}"} in action text. No
                  lookahead/backreferences (Rust regex).
                </div>
                {character && advPattern.toLowerCase().includes("{c}") && (
                  <div className="hint num">
                    Expands to: {expandPatternJs(advPattern, character)}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="ted-section">
        <div className="ted-sec-head">
          <span className="section-title">Then</span>
        </div>
        {rows.length === 0 && (
          <div className="hint">
            No actions yet — a trigger with no actions does nothing.
          </div>
        )}
        {rows.map((r, index) => renderRow(r, r.id === firstTimerId, index))}
        <div className="ted-add-wrap">
          <button
            type="button"
            className="ghost ted-add"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((open) => !open)}
          >
            + Add action
          </button>
          {addMenuOpen && (
            <div className="ted-action-picker" role="menu" aria-label="Add an action">
              {([
                ["overlay", "Overlay", "Send matched data to a configurable overlay"],
                ["speak", "Text to speech", "Read a message aloud"],
                ["sound", "Sound", "Play an audio cue"],
                ["timer", "Start timer", "Create or restart a timer bar"],
                ["cancel", "Cancel timer", "Stop a timer by name"],
              ] as const).map(([kind, label, description]) => (
                <button
                  type="button"
                  role="menuitem"
                  key={kind}
                  onClick={() => addRow(kind)}
                >
                  <span className="ted-action-badge" aria-hidden="true">
                    {actionBadge(kind)}
                  </span>
                  <span><strong>{label}</strong><small>{description}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ted-section">
        <div className="ted-sec-head">
          <button
            type="button"
            className="ted-test-toggle"
            aria-expanded={testOpen}
            onClick={() => setTestOpen((v) => !v)}
          >
            <span className="section-title">
              Test against a line {testOpen ? "▾" : "▸"}
            </span>
          </button>
        </div>
        {testOpen && (
          <div className="ted-test">
            {batch && (
              <div
                className={`qt-preview ted-test-status ${batch.matched > 0 ? "ok" : "miss"}`}
                role="status"
              >
                <span className="dot" />
                <strong>{batch.matched} / {batch.results.length} lines match</strong>
              </div>
            )}
            {!batch && test && (
              <div className={`qt-preview ted-test-status ${test.state}`} role="status">
                <span className="dot" />
                <strong>{test.text}</strong>
              </div>
            )}
            <label className="field ted-test-field">
              <span>Test line</span>
            <textarea
              className="ted-test-input"
              rows={testLines.length > 1 ? 4 : 1}
              value={testLine}
              placeholder="paste one or more log lines here to try the trigger"
              aria-label="Test lines"
              onChange={(e) => {
                testTouched.current = true;
                setTestLine(e.target.value);
              }}
            />
            </label>
            {batch && (
              <div className="ted-batch-list">
                {batch.results.map((r, i) => (
                  <div
                    className={`ted-batch-row ${r.hit ? "hit" : "miss"}`}
                    key={i}
                  >
                    <span className="ted-batch-mark" aria-hidden="true">
                      {r.hit ? "✓" : "·"}
                    </span>
                    <span className="ted-batch-line">{r.line}</span>
                  </div>
                ))}
              </div>
            )}
            {test?.match && test.match.length > 1 && (
              <table className="ted-captures">
                <tbody>
                  {Array.from({ length: test.match.length - 1 }, (_, i) => (
                    <tr key={i}>
                      <td className="num">{i + 1}</td>
                      <td className="ted-cap-label">
                        {labelByGroup.get(i + 1) ?? `capture ${i + 1}`}
                      </td>
                      <td className="ted-cap-value">
                        {test.match?.[i + 1] ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {test?.match && rows.length > 0 && (
              <div className="ted-will-list">
                {rows.map((r) => (
                  <div className="ted-will" key={r.id}>
                    {willDo(r, test.match)}
                  </div>
                ))}
              </div>
            )}
            <div className="hint ted-engine-hint">
              Preview matching is approximate — the app matches with its own
              engine.
            </div>
          </div>
        )}
      </div>

      {dupe && (
        <div className="ted-warn ted-dupe" role="status">
          “{dupe.category ? `${dupe.category}/` : ""}
          {dupe.name}” already fires on this exact pattern — saving will
          double the alerts.
        </div>
      )}

      <div className="editor-foot ted-foot">
        <label className="check-row">
          <input
            type="checkbox"
            className="switch"
            checked={enabled}
            onChange={(e) => {
              touch();
              setEnabled(e.target.checked);
            }}
          />
          Enabled
        </label>
        <label
          className="ted-inline-field ted-cooldown"
          title="After firing, matching lines stay silent this long — the anti-spam throttle for repeating combat lines."
        >
          <span>Fire</span>
          <select
            value={String(cooldown)}
            aria-label="Refire cooldown"
            onChange={(e) => {
              touch();
              setCooldown(parseInt(e.target.value, 10) || 0);
            }}
          >
            <option value="0">every match</option>
            <option value="2">at most every 2 s</option>
            <option value="5">at most every 5 s</option>
            <option value="10">at most every 10 s</option>
            <option value="30">at most every 30 s</option>
            <option value="60">at most every 1 min</option>
            <option value="300">at most every 5 min</option>
            {![0, 2, 5, 10, 30, 60, 300].includes(cooldown) && (
              <option value={String(cooldown)}>
                at most every {formatDurationWords(cooldown)}
              </option>
            )}
          </select>
        </label>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          Save trigger
        </button>
      </div>
    </div>
  );
}
