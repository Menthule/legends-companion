// "When..." template registry for the trigger editor (docs/trigger-editor-spec.md §4/§8).
//
// Builder state serializes to the existing Trigger JSON with zero schema
// changes: `build(params, variantIx)` derives the pattern string, and
// `parse(pattern)` recognizes existing patterns by extracting candidate
// params and verifying `build(parsed) === pattern` BYTE-FOR-BYTE (the
// round-trip guarantee). Any mismatch falls through to the next variant /
// template, and ultimately to Advanced mode.
//
// Constraint: the Rust regex crate has no lookaround/backreferences — no
// template may emit them.

import type { TriggerAction } from "../types";
import { escapeRegex, toJsRegexSource, unescapeRegex } from "./patternJs";

/** Mob/player name capture used across templates (matches the starter pack). */
export const MOB = "(\\w[\\w`' ]*)";

export type TemplateParams = Record<string, string | string[] | boolean>;

export interface CaptureChip {
  /** 1-based regex group number. */
  group: number;
  /** Friendly label ("sender's name"). */
  label: string;
  /** Raw token the chip inserts ("${1}"). */
  token: string;
}

export type ParamDef =
  | {
      key: string;
      kind: "text";
      label: string;
      placeholder?: string;
      /** Show a "my character" chip that inserts the literal token {C}. */
      allowCharChip?: boolean;
    }
  | {
      key: string;
      kind: "spell";
      label: string;
      source: "castable" | "all";
      optional?: boolean;
      placeholder?: string;
    }
  | { key: string; kind: "spells"; label: string; source: "all" }
  | {
      key: string;
      kind: "seg";
      label: string;
      options: { value: string; label: string }[];
    }
  | { key: string; kind: "toggle"; label: string };

export interface TemplateContext {
  /** Buff duration lookup (spell_names.json `durations`), for W4's timer. */
  durationOf?(spell: string): number | null;
}

export interface TemplateDef {
  id: string;
  /** Dropdown text ("Someone sends me a tell"). */
  label: string;
  params: ParamDef[];
  variantCount: number;
  build(params: TemplateParams, variantIx?: number): string;
  parse(pattern: string): { params: TemplateParams; variantIx: number } | null;
  /** Quick-create suggestion: probe a raw log message. */
  fromLine(message: string): TemplateParams | null;
  captures(params: TemplateParams, variantIx?: number): CaptureChip[];
  /** Derived plain-English restatement ("When any player sends you a tell"). */
  sentence(params: TemplateParams): string;
  suggestName(params: TemplateParams): string;
  defaultCategory: string;
  defaultActions(params: TemplateParams, ctx?: TemplateContext): TriggerAction[];
  /** Canonical example log line for the test box ("show me" seed). */
  exampleLine(params: TemplateParams): string;
  /** Label of a bundled sound to prefill as an extra action row. */
  defaultSound?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a param value as a regex literal; a literal `{C}` chip value passes
 *  through unescaped (the engine expands it to the character name). */
function esc(value: string): string {
  return value === "{C}" ? "{C}" : escapeRegex(value);
}

function str(p: TemplateParams, key: string): string {
  const v = p[key];
  return typeof v === "string" ? v.trim() : "";
}

function strList(p: TemplateParams, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.map((s) => s.trim()).filter(Boolean) : [];
}

function flag(p: TemplateParams, key: string): boolean {
  return p[key] === true;
}

/**
 * Recognizer regex over the PATTERN STRING: string pieces are escaped
 * literals, `CAP`/`CAPL` insert greedy/lazy capture slots. Anchored both ends.
 */
const CAP = { cap: true as const, lazy: false };
const CAPL = { cap: true as const, lazy: true };
type RecPiece = string | typeof CAP | typeof CAPL;

function rec(...pieces: RecPiece[]): RegExp {
  let src = "^";
  for (const piece of pieces) {
    src +=
      typeof piece === "string"
        ? escapeRegex(piece)
        : piece.lazy
          ? "([\\s\\S]+?)"
          : "([\\s\\S]+)";
  }
  return new RegExp(src + "$");
}

/** Probe a raw log message with a canonical (token-free) pattern. */
function probe(pattern: string, message: string): RegExpExecArray | null {
  try {
    return new RegExp(toJsRegexSource(pattern), "i").exec(message);
  } catch {
    return null;
  }
}

/** Verified-parse helper: try recognizer shapes in order, return the first
 *  whose extracted params rebuild the pattern exactly. */
interface Shape {
  re: RegExp;
  variantIx: number;
  extract(m: RegExpExecArray): TemplateParams;
}

function parseShapes(
  pattern: string,
  build: (p: TemplateParams, v?: number) => string,
  shapes: Shape[],
): { params: TemplateParams; variantIx: number } | null {
  for (const s of shapes) {
    const m = s.re.exec(pattern);
    if (!m) continue;
    const params = s.extract(m);
    if (build(params, s.variantIx) === pattern) {
      return { params, variantIx: s.variantIx };
    }
  }
  return null;
}

/** Exhaustive parse for templates whose params are all enumerable. */
function parseEnum(
  pattern: string,
  build: (p: TemplateParams, v?: number) => string,
  combos: TemplateParams[],
  variantCount: number,
): { params: TemplateParams; variantIx: number } | null {
  for (let v = 0; v < variantCount; v++) {
    for (const c of combos) {
      if (build(c, v) === pattern) return { params: { ...c }, variantIx: v };
    }
  }
  return null;
}

function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------
// W16 core, kept byte-compatible with the original QuickTriggerModal builder
// ---------------------------------------------------------------------------

/**
 * Verbs that end a leading mob/player name ("Baron Telyx V`Zher slashes …",
 * "a hill giant hits …"). Third-person combat/emote/chat verbs seen in the
 * Legends log (docs/research-triggers.md).
 */
const LEAD_VERBS =
  "auctions|backstabs|bashes|begins|bites|casts|claws|crushes|falls|glances|" +
  "goes|gores|has|healed|hits|is|kicks|laughs|mauls|pierces|punches|" +
  "resisted|says|screams|screeches|shouts|slams|slashes|slices|smashes|" +
  "snarls|staggers|stings|strikes|tells|tries|was|whirls";

/**
 * Leading mob/player name candidate. Two shapes, tried in order:
 *  1. the FULL name — one or more words (capitalized start, or the lowercase
 *     mob articles a/an/the) up to a known third-person verb, so multi-word
 *     names like "Baron Telyx V`Zher" and "a hill giant" generalize whole;
 *  2. fallback: a single leading capitalized word (legacy behavior, used
 *     when no verb boundary is found, e.g. "Xantik, flee!").
 */
export const LEAD_NAME_RE = new RegExp(
  "^(?:" +
    `(?:a|an|the|[A-Z][\\w\`']*)(?: [\\w\`']+)*?(?= (?:${LEAD_VERBS})\\b)` +
    "|[A-Z][a-z]+)",
);

/** Single leading capitalized word (the pre-W16-generalization matcher —
 *  kept so old `^(\w+) …` patterns still round-trip as a W16 variant). */
const LEGACY_LEAD_RE = /^[A-Z][a-z]+/;

/**
 * Build the suggested pattern for a log line: anchored, regex-escaped message
 * text, optionally generalized so digit runs match any number and a leading
 * name (full multi-word mob shape) becomes a MOB capture. (W16's canonical
 * builder — originally from QuickTriggerModal.tsx.)
 */
export function buildPattern(
  message: string,
  anyNumbers: boolean,
  anyName: boolean,
): string {
  let head = "";
  let rest = message;
  if (anyName) {
    const m = LEAD_NAME_RE.exec(message);
    if (m) {
      head = MOB;
      rest = message.slice(m[0].length);
    }
  }
  let body = escapeRegex(rest);
  if (anyNumbers) body = body.replace(/\d+/g, "\\d+");
  return `^${head}${body}`;
}

/** The pre-generalization builder: leading name becomes `(\w+)` (single
 *  capitalized word). Only used to round-trip existing patterns (W16 v2/v3). */
function buildPatternLegacy(
  message: string,
  anyNumbers: boolean,
  anyName: boolean,
): string {
  let head = "";
  let rest = message;
  if (anyName) {
    const m = LEGACY_LEAD_RE.exec(message);
    if (m) {
      head = "(\\w+)";
      rest = message.slice(m[0].length);
    }
  }
  let body = escapeRegex(rest);
  if (anyNumbers) body = body.replace(/\d+/g, "\\d+");
  return `^${head}${body}`;
}

/** The leading name W16's toggles would generalize, or null ("You"/"Your"
 *  lines never generalize — they are about the player, not a mob). */
export function leadName(text: string): string | null {
  const m = LEAD_NAME_RE.exec(text);
  return m && m[0] !== "You" && m[0] !== "Your" ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Templates W1..W16
// ---------------------------------------------------------------------------

const W1_ANY = "^(\\w+) tells you,";

const W1: TemplateDef = {
  id: "tell",
  label: "Someone sends me a tell",
  params: [
    {
      key: "from",
      kind: "text",
      label: "From",
      placeholder: "anyone",
    },
  ],
  variantCount: 1,
  build(p) {
    const from = str(p, "from");
    return from ? `^(${esc(from)}) tells you,` : W1_ANY;
  },
  parse(pattern) {
    if (pattern === W1_ANY) return { params: { from: "" }, variantIx: 0 };
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^(", CAP, ") tells you,"),
        variantIx: 0,
        extract: (m) => ({ from: unescapeRegex(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    return probe(W1_ANY, message) ? { from: "" } : null;
  },
  captures() {
    return [{ group: 1, label: "sender's name", token: "${1}" }];
  },
  sentence(p) {
    const from = str(p, "from");
    return from
      ? `When ${from} sends you a tell`
      : "When any player sends you a tell";
  },
  suggestName(p) {
    const from = str(p, "from");
    return from ? `Tell from ${from}` : "Tell received";
  },
  defaultCategory: "Social",
  defaultActions() {
    return [{ Speak: { template: "tell from ${1}" } }];
  },
  exampleLine(p) {
    const from = str(p, "from");
    return `${from && from !== "{C}" ? from : "Torvin"} tells you, 'inc mez'`;
  },
  defaultSound: "Tell",
};

const W2_ANY = `^${MOB} told you,`;

const W2: TemplateDef = {
  id: "npc-tell",
  label: "An NPC says something to me",
  params: [
    { key: "npc", kind: "text", label: "NPC", placeholder: "any NPC" },
  ],
  variantCount: 1,
  build(p) {
    const npc = str(p, "npc");
    return npc ? `^(${esc(npc)}) told you,` : W2_ANY;
  },
  parse(pattern) {
    if (pattern === W2_ANY) return { params: { npc: "" }, variantIx: 0 };
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^(", CAP, ") told you,"),
        variantIx: 0,
        extract: (m) => ({ npc: unescapeRegex(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    return probe(W2_ANY, message) ? { npc: "" } : null;
  },
  captures() {
    return [{ group: 1, label: "NPC's name", token: "${1}" }];
  },
  sentence(p) {
    const npc = str(p, "npc");
    return npc ? `When ${npc} says something to you` : "When any NPC says something to you";
  },
  suggestName(p) {
    const npc = str(p, "npc");
    return npc ? `${npc} spoke to me` : "NPC spoke to me";
  },
  defaultCategory: "Social",
  defaultActions() {
    return [{ Speak: { template: "message from ${1}" } }];
  },
  exampleLine(p) {
    const npc = str(p, "npc");
    return `${npc || "Guard Hann"} told you, 'go away'`;
  },
};

const W3_ANY_V0 = `^${MOB} begins casting (.+)\\.$`;
const W3_ANY_V1 = "^(.+) begins casting (.+)\\.$";

const W3: TemplateDef = {
  id: "enemy-cast",
  label: "A mob begins casting a spell",
  params: [
    { key: "caster", kind: "text", label: "Caster", placeholder: "any mob" },
    { key: "spells", kind: "spells", label: "Spells", source: "all" },
  ],
  variantCount: 2,
  build(p, v = 0) {
    const spells = strList(p, "spells");
    const alts = spells.map(esc).join("|");
    if (v === 1) {
      // Legacy/generated shape: (.+) caster, trailing $. (Caster literal is
      // never emitted here — v1 only round-trips existing pack patterns.)
      return spells.length > 0
        ? `^(.+) begins casting (${alts})\\.$`
        : W3_ANY_V1;
    }
    const casterPart = str(p, "caster") ? `(${esc(str(p, "caster"))})` : MOB;
    return spells.length > 0
      ? `^${casterPart} begins casting (${alts})\\.`
      : `^${casterPart} begins casting (.+)\\.$`;
  },
  parse(pattern) {
    const build = this.build.bind(this);
    if (pattern === W3_ANY_V0) {
      return { params: { caster: "", spells: [] }, variantIx: 0 };
    }
    if (pattern === W3_ANY_V1) {
      return { params: { caster: "", spells: [] }, variantIx: 1 };
    }
    const splitAlts = (raw: string) => raw.split("|").map(unescapeRegex);
    return parseShapes(pattern, build, [
      {
        re: rec(`^${MOB} begins casting (`, CAP, ")\\."),
        variantIx: 0,
        extract: (m) => ({ caster: "", spells: splitAlts(m[1]) }),
      },
      {
        re: rec("^(", CAPL, ") begins casting (", CAP, ")\\."),
        variantIx: 0,
        extract: (m) => ({
          caster: unescapeRegex(m[1]),
          spells: splitAlts(m[2]),
        }),
      },
      {
        re: rec("^(", CAPL, ") begins casting (.+)\\.$"),
        variantIx: 0,
        extract: (m) => ({ caster: unescapeRegex(m[1]), spells: [] }),
      },
      {
        re: rec("^(.+) begins casting (", CAP, ")\\.$"),
        variantIx: 1,
        extract: (m) => ({ caster: "", spells: splitAlts(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    const m = probe(W3_ANY_V0, message);
    return m ? { caster: "", spells: [m[2]] } : null;
  },
  captures() {
    return [
      { group: 1, label: "caster's name", token: "${1}" },
      { group: 2, label: "spell name", token: "${2}" },
    ];
  },
  sentence(p) {
    const spells = strList(p, "spells");
    const caster = str(p, "caster");
    const what =
      spells.length === 0
        ? "any spell"
        : spells.length <= 3
          ? spells.join(" or ")
          : `one of ${spells.length} spells`;
    return `When ${caster || "any mob"} begins casting ${what}`;
  },
  suggestName(p) {
    const spells = strList(p, "spells");
    return spells.length > 0
      ? clip(`Enemy cast: ${spells.join(", ")}`)
      : "Enemy casting";
  },
  defaultCategory: "Combat/Enemy Casts",
  defaultActions() {
    return [{ Speak: { template: "${2} incoming" } }];
  },
  exampleLine(p) {
    const caster = str(p, "caster");
    const spells = strList(p, "spells");
    return `${caster && caster !== "{C}" ? caster : "Vibarn"} begins casting ${
      spells[0] ?? "Clinging Darkness"
    }.`;
  },
};

const W4: TemplateDef = {
  id: "my-cast",
  label: "I begin casting a spell",
  params: [
    {
      key: "spell",
      kind: "spell",
      label: "Spell",
      source: "castable",
      placeholder: "spell name",
    },
  ],
  variantCount: 2,
  build(p, v = 0) {
    const spell = esc(str(p, "spell"));
    return v === 1
      ? `^You begin casting ${spell}\\.$`
      : `^You begin casting ${spell}\\.`;
  },
  parse(pattern) {
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^You begin casting ", CAPL, "\\.$"),
        variantIx: 1,
        extract: (m) => ({ spell: unescapeRegex(m[1]) }),
      },
      {
        re: rec("^You begin casting ", CAPL, "\\."),
        variantIx: 0,
        extract: (m) => ({ spell: unescapeRegex(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    const m = probe("^You begin casting (.+)\\.$", message);
    return m ? { spell: m[1] } : null;
  },
  captures() {
    return [];
  },
  sentence(p) {
    const spell = str(p, "spell");
    return spell ? `When you begin casting ${spell}` : "When you begin casting a spell";
  },
  suggestName(p) {
    const spell = str(p, "spell");
    return spell ? `${spell} cast` : "My cast";
  },
  defaultCategory: "Combat",
  defaultActions(p, ctx) {
    const spell = str(p, "spell");
    if (!spell) return [{ Speak: { template: "casting" } }];
    const duration = ctx?.durationOf?.(spell) ?? 30;
    const warn = Math.max(6, Math.round(duration * 0.1));
    return [
      {
        StartTimer: {
          name: spell,
          duration_secs: duration,
          warn_at_secs: warn < duration ? warn : null,
        },
      },
    ];
  },
  exampleLine(p) {
    return `You begin casting ${str(p, "spell") || "Walking Sleep"}.`;
  },
};

const W5: TemplateDef = {
  id: "worn-off",
  label: "My spell wears off",
  params: [
    {
      key: "spell",
      kind: "spell",
      label: "Spell",
      source: "castable",
      placeholder: "spell name",
    },
    { key: "withTarget", kind: "toggle", label: "The line names a target" },
  ],
  variantCount: 3,
  build(p, v = 0) {
    const spell = esc(str(p, "spell"));
    if (v === 1) {
      // Curated optional-target shape.
      return `^Your ${spell} spell has worn off(?: of (.+))?\\.`;
    }
    if (v === 2) {
      // Generated packs: optional-target shape with a trailing anchor.
      return `^Your ${spell} spell has worn off(?: of (.+))?\\.$`;
    }
    return flag(p, "withTarget")
      ? `^Your ${spell} spell has worn off of (.+)\\.`
      : `^Your ${spell} spell has worn off`;
  },
  parse(pattern) {
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^Your ", CAPL, " spell has worn off of (.+)\\."),
        variantIx: 0,
        extract: (m) => ({ spell: unescapeRegex(m[1]), withTarget: true }),
      },
      {
        re: rec("^Your ", CAPL, " spell has worn off(?: of (.+))?\\.$"),
        variantIx: 2,
        extract: (m) => ({ spell: unescapeRegex(m[1]), withTarget: false }),
      },
      {
        re: rec("^Your ", CAPL, " spell has worn off(?: of (.+))?\\."),
        variantIx: 1,
        extract: (m) => ({ spell: unescapeRegex(m[1]), withTarget: false }),
      },
      {
        re: rec("^Your ", CAPL, " spell has worn off"),
        variantIx: 0,
        extract: (m) => ({ spell: unescapeRegex(m[1]), withTarget: false }),
      },
    ]);
  },
  fromLine(message) {
    let m = probe("^Your (.+) spell has worn off of (.+)\\.", message);
    if (m) return { spell: m[1], withTarget: true };
    m = probe("^Your (.+) spell has worn off", message);
    return m ? { spell: m[1], withTarget: false } : null;
  },
  captures(p, v = 0) {
    return flag(p, "withTarget") || v === 1 || v === 2
      ? [{ group: 1, label: "target's name", token: "${1}" }]
      : [];
  },
  sentence(p) {
    const spell = str(p, "spell") || "a spell";
    return `When your ${spell} wears off${flag(p, "withTarget") ? " of a target" : ""}`;
  },
  suggestName(p) {
    const spell = str(p, "spell");
    return spell ? `${spell} worn off` : "Spell worn off";
  },
  defaultCategory: "Combat",
  defaultActions(p) {
    const spell = str(p, "spell");
    return [{ Speak: { template: spell ? `${spell} worn off` : "spell worn off" } }];
  },
  exampleLine(p) {
    const spell = str(p, "spell") || "Walking Sleep";
    return flag(p, "withTarget")
      ? `Your ${spell} spell has worn off of Baron Telyx V\`Zher.`
      : `Your ${spell} spell has worn off.`;
  },
};

const W6_ANY = `^${MOB} has been slain by ${MOB}!`;

const W6: TemplateDef = {
  id: "slain",
  label: "Something is slain",
  params: [
    {
      key: "victim",
      kind: "text",
      label: "Victim",
      placeholder: "anyone",
      allowCharChip: true,
    },
    {
      key: "killer",
      kind: "text",
      label: "Killer",
      placeholder: "anyone",
      allowCharChip: true,
    },
  ],
  variantCount: 1,
  build(p) {
    const victim = str(p, "victim");
    const killer = str(p, "killer");
    const vp = victim ? `(${esc(victim)})` : MOB;
    const kp = killer ? `(${esc(killer)})` : MOB;
    return `^${vp} has been slain by ${kp}!`;
  },
  parse(pattern) {
    if (pattern === W6_ANY) {
      return { params: { victim: "", killer: "" }, variantIx: 0 };
    }
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^(", CAPL, `) has been slain by ${MOB}!`),
        variantIx: 0,
        extract: (m) => ({ victim: unescapeRegex(m[1]), killer: "" }),
      },
      {
        re: rec(`^${MOB} has been slain by (`, CAP, ")!"),
        variantIx: 0,
        extract: (m) => ({ victim: "", killer: unescapeRegex(m[1]) }),
      },
      {
        re: rec("^(", CAPL, ") has been slain by (", CAP, ")!"),
        variantIx: 0,
        extract: (m) => ({
          victim: unescapeRegex(m[1]),
          killer: unescapeRegex(m[2]),
        }),
      },
    ]);
  },
  fromLine(message) {
    return probe(W6_ANY, message) ? { victim: "", killer: "" } : null;
  },
  captures() {
    return [
      { group: 1, label: "victim's name", token: "${1}" },
      { group: 2, label: "killer's name", token: "${2}" },
    ];
  },
  sentence(p) {
    const victim = str(p, "victim") || "anything";
    const killer = str(p, "killer");
    const vd = victim === "{C}" ? "your character" : victim;
    const kd = killer === "{C}" ? "your character" : killer;
    return `When ${vd} is slain${killer ? ` by ${kd}` : ""}`;
  },
  suggestName(p) {
    const victim = str(p, "victim");
    return victim && victim !== "{C}" ? `${victim} slain` : "Something slain";
  },
  defaultCategory: "Combat",
  defaultActions() {
    return [{ Speak: { template: "${1} slain by ${2}" } }];
  },
  exampleLine(p) {
    const victim = str(p, "victim");
    const killer = str(p, "killer");
    return `${victim && victim !== "{C}" ? victim : "A soldier of V\`Zher"} has been slain by ${
      killer && killer !== "{C}" ? killer : "Nyasha"
    }!`;
  },
};

const W7_FULL = "^(?:You died\\.|You have been slain by (.+)!)";
const W7_SIMPLE = "^You died\\.";

const W7: TemplateDef = {
  id: "i-die",
  label: "I die",
  params: [
    {
      key: "alsoSlain",
      kind: "toggle",
      label: 'Also match "You have been slain by …!"',
    },
  ],
  variantCount: 1,
  build(p) {
    return flag(p, "alsoSlain") ? W7_FULL : W7_SIMPLE;
  },
  parse(pattern) {
    return parseEnum(
      pattern,
      this.build.bind(this),
      [{ alsoSlain: true }, { alsoSlain: false }],
      1,
    );
  },
  fromLine(message) {
    return probe(W7_FULL, message) ? { alsoSlain: true } : null;
  },
  captures(p) {
    return flag(p, "alsoSlain")
      ? [{ group: 1, label: "killer's name (may be empty)", token: "${1}" }]
      : [];
  },
  sentence() {
    return "When you die";
  },
  suggestName() {
    return "You died";
  },
  defaultCategory: "Combat/Defense",
  defaultActions() {
    return [{ Speak: { template: "you died" } }];
  },
  exampleLine(p) {
    return flag(p, "alsoSlain")
      ? "You have been slain by a hill giant!"
      : "You died.";
  },
  defaultSound: "Death",
};

const W8: TemplateDef = {
  id: "stun",
  label: "I am stunned / stun wears off",
  params: [
    {
      key: "which",
      kind: "seg",
      label: "When it",
      options: [
        { value: "begins", label: "Begins" },
        { value: "ends", label: "Ends" },
      ],
    },
  ],
  variantCount: 1,
  build(p) {
    return str(p, "which") === "ends"
      ? "^You are no longer stunned\\."
      : "^You are stunned!";
  },
  parse(pattern) {
    return parseEnum(
      pattern,
      this.build.bind(this),
      [{ which: "begins" }, { which: "ends" }],
      1,
    );
  },
  fromLine(message) {
    if (probe("^You are stunned!", message)) return { which: "begins" };
    if (probe("^You are no longer stunned\\.", message)) {
      return { which: "ends" };
    }
    return null;
  },
  captures() {
    return [];
  },
  sentence(p) {
    return str(p, "which") === "ends"
      ? "When your stun wears off"
      : "When you are stunned";
  },
  suggestName(p) {
    return str(p, "which") === "ends" ? "Stun over" : "Stunned";
  },
  defaultCategory: "Combat/Defense",
  defaultActions(p) {
    return [
      {
        Speak: {
          template: str(p, "which") === "ends" ? "stun over" : "stunned",
        },
      },
    ];
  },
  exampleLine(p) {
    return str(p, "which") === "ends"
      ? "You are no longer stunned."
      : "You are stunned!";
  },
};

const W9: TemplateDef = {
  id: "summoned",
  label: "I am summoned",
  params: [],
  variantCount: 1,
  build() {
    return "^You have been summoned!";
  },
  parse(pattern) {
    return pattern === "^You have been summoned!"
      ? { params: {}, variantIx: 0 }
      : null;
  },
  fromLine(message) {
    return probe("^You have been summoned!", message) ? {} : null;
  },
  captures() {
    return [];
  },
  sentence() {
    return "When a mob summons you to it";
  },
  suggestName() {
    return "Summoned";
  },
  defaultCategory: "Combat/Defense",
  defaultActions() {
    return [{ Speak: { template: "summoned" } }];
  },
  exampleLine() {
    return "You have been summoned!";
  },
};

const W10: TemplateDef = {
  id: "enrage",
  label: "A mob becomes enraged / calms",
  params: [
    {
      key: "which",
      kind: "seg",
      label: "When it",
      options: [
        { value: "begins", label: "Becomes enraged" },
        { value: "ends", label: "Calms down" },
      ],
    },
  ],
  variantCount: 2,
  build(p, v = 0) {
    const mob = v === 1 ? "(.+)" : MOB;
    return str(p, "which") === "ends"
      ? `^${mob} is no longer enraged\\.`
      : `^${mob} has become ENRAGED\\.`;
  },
  parse(pattern) {
    return parseEnum(
      pattern,
      this.build.bind(this),
      [{ which: "begins" }, { which: "ends" }],
      2,
    );
  },
  fromLine(message) {
    if (probe(`^${MOB} has become ENRAGED\\.`, message)) {
      return { which: "begins" };
    }
    if (probe(`^${MOB} is no longer enraged\\.`, message)) {
      return { which: "ends" };
    }
    return null;
  },
  captures() {
    return [{ group: 1, label: "mob's name", token: "${1}" }];
  },
  sentence(p) {
    return str(p, "which") === "ends"
      ? "When a mob is no longer enraged"
      : "When a mob becomes enraged";
  },
  suggestName(p) {
    return str(p, "which") === "ends" ? "Enrage over" : "Mob enraged";
  },
  defaultCategory: "Combat/Defense",
  defaultActions(p) {
    return str(p, "which") === "ends"
      ? [{ Speak: { template: "enrage over" } }]
      : [{ Speak: { template: "${1} enraged" } }];
  },
  exampleLine(p) {
    return str(p, "which") === "ends"
      ? "Baron Telyx V`Zher is no longer enraged."
      : "Baron Telyx V`Zher has become ENRAGED.";
  },
};

const W11: TemplateDef = {
  id: "resist-out",
  label: "A mob resists my spell",
  params: [
    {
      key: "spell",
      kind: "spell",
      label: "Spell",
      source: "castable",
      optional: true,
      placeholder: "any spell",
    },
  ],
  variantCount: 3,
  build(p, v = 0) {
    const spell = str(p, "spell");
    const sp = spell ? `(${esc(spell)})` : "(.+)";
    if (v === 1) return `resisted your ${sp}!`; // legacy: unanchored, no caster
    if (v === 2) return `^(.+) resisted your ${sp}!`; // curated (.+) caster
    return `^${MOB} resisted your ${sp}!`;
  },
  parse(pattern) {
    const build = this.build.bind(this);
    const exact = parseEnum(pattern, build, [{ spell: "" }], 3);
    if (exact) return exact;
    return parseShapes(pattern, build, [
      {
        re: rec(`^${MOB} resisted your (`, CAP, ")!"),
        variantIx: 0,
        extract: (m) => ({ spell: unescapeRegex(m[1]) }),
      },
      {
        re: rec("resisted your (", CAP, ")!"),
        variantIx: 1,
        extract: (m) => ({ spell: unescapeRegex(m[1]) }),
      },
      {
        re: rec("^(.+) resisted your (", CAP, ")!"),
        variantIx: 2,
        extract: (m) => ({ spell: unescapeRegex(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    const m = probe(`^${MOB} resisted your (.+)!`, message);
    return m ? { spell: "" } : null;
  },
  captures(_p, v = 0) {
    if (v === 1) return [{ group: 1, label: "spell name", token: "${1}" }];
    return [
      { group: 1, label: "resister's name", token: "${1}" },
      { group: 2, label: "spell name", token: "${2}" },
    ];
  },
  sentence(p) {
    const spell = str(p, "spell");
    return `When a mob resists your ${spell || "spell"}`;
  },
  suggestName(p) {
    const spell = str(p, "spell");
    return spell ? `${spell} resisted` : "Spell resisted";
  },
  defaultCategory: "Combat/Offense",
  defaultActions() {
    return [{ DisplayText: { template: "Resisted: ${2}" } }];
  },
  exampleLine(p) {
    return `A willowisp resisted your ${str(p, "spell") || "Vampiric Embrace"}!`;
  },
};

const W12_V0 = `^You resist ${MOB}'s (.+)!`;
const W12_V1 = "^You resist (.+)!";

const W12: TemplateDef = {
  id: "resist-in",
  label: "I resist a spell",
  params: [],
  variantCount: 2,
  build(_p, v = 0) {
    return v === 1 ? W12_V1 : W12_V0;
  },
  parse(pattern) {
    return parseEnum(pattern, this.build.bind(this), [{}], 2);
  },
  fromLine(message) {
    return probe(W12_V0, message) ? {} : null;
  },
  captures(_p, v = 0) {
    if (v === 1) return [{ group: 1, label: "spell name", token: "${1}" }];
    return [
      { group: 1, label: "caster's name", token: "${1}" },
      { group: 2, label: "spell name", token: "${2}" },
    ];
  },
  sentence() {
    return "When you resist a spell cast on you";
  },
  suggestName() {
    return "You resisted a spell";
  },
  defaultCategory: "Combat/Defense",
  defaultActions() {
    return [{ Speak: { template: "resisted ${2}" } }];
  },
  exampleLine() {
    return "You resist a necro initiate's Clinging Darkness!";
  },
};

const W13_EARLY = "^You feel yourself starting to appear";
const W13_FULL =
  "^(?:You feel yourself starting to appear|You appear\\.|You become visible\\.)";

const W13: TemplateDef = {
  id: "invis-drop",
  label: "My invisibility is dropping",
  params: [
    { key: "alsoBreak", kind: "toggle", label: "Also match the full break" },
  ],
  variantCount: 1,
  build(p) {
    return flag(p, "alsoBreak") ? W13_FULL : W13_EARLY;
  },
  parse(pattern) {
    return parseEnum(
      pattern,
      this.build.bind(this),
      [{ alsoBreak: false }, { alsoBreak: true }],
      1,
    );
  },
  fromLine(message) {
    if (probe(W13_EARLY, message)) return { alsoBreak: false };
    if (probe(W13_FULL, message)) return { alsoBreak: true };
    return null;
  },
  captures() {
    return [];
  },
  sentence(p) {
    return flag(p, "alsoBreak")
      ? "When your invisibility starts to drop or breaks"
      : "When your invisibility starts to drop";
  },
  suggestName() {
    return "Invis dropping";
  },
  defaultCategory: "Utility",
  defaultActions() {
    return [{ Speak: { template: "invis dropping" } }];
  },
  exampleLine() {
    return "You feel yourself starting to appear.";
  },
};

const W14_ANY = `^${MOB}'s (.+) spell is interrupted\\.`;

const W14: TemplateDef = {
  id: "interrupted",
  label: "A spell cast is interrupted",
  params: [
    { key: "caster", kind: "text", label: "Caster", placeholder: "anyone" },
  ],
  variantCount: 1,
  build(p) {
    const caster = str(p, "caster");
    return caster
      ? `^(${esc(caster)})'s (.+) spell is interrupted\\.`
      : W14_ANY;
  },
  parse(pattern) {
    if (pattern === W14_ANY) return { params: { caster: "" }, variantIx: 0 };
    return parseShapes(pattern, this.build.bind(this), [
      {
        re: rec("^(", CAPL, ")'s (.+) spell is interrupted\\."),
        variantIx: 0,
        extract: (m) => ({ caster: unescapeRegex(m[1]) }),
      },
    ]);
  },
  fromLine(message) {
    return probe(W14_ANY, message) ? { caster: "" } : null;
  },
  captures() {
    return [
      { group: 1, label: "caster's name", token: "${1}" },
      { group: 2, label: "spell name", token: "${2}" },
    ];
  },
  sentence(p) {
    const caster = str(p, "caster");
    return `When ${caster || "anyone"}'s spell cast is interrupted`;
  },
  suggestName(p) {
    const caster = str(p, "caster");
    return caster ? `${caster} interrupted` : "Cast interrupted";
  },
  defaultCategory: "Combat/Enemy Casts",
  defaultActions() {
    return [{ Speak: { template: "${2} interrupted" } }];
  },
  exampleLine(p) {
    const caster = str(p, "caster");
    return `${caster && caster !== "{C}" ? caster : "Baron Telyx V\`Zher"}'s Healing spell is interrupted.`;
  },
};

const W15: TemplateDef = {
  id: "mez",
  label: "Someone is mesmerized / wakes up",
  params: [
    {
      key: "which",
      kind: "seg",
      label: "When they are",
      options: [
        { value: "mesmerized", label: "Mesmerized" },
        { value: "awakened", label: "Awakened" },
      ],
    },
  ],
  variantCount: 2,
  build(p, v = 0) {
    const mob = v === 1 ? "(.+)" : MOB;
    const tail = v === 1 ? "\\.$" : "\\.";
    return str(p, "which") === "awakened"
      ? `^${mob} has been awakened(?: by ${mob})?${tail}`
      : `^${mob} has been mesmerized${tail}`;
  },
  parse(pattern) {
    return parseEnum(
      pattern,
      this.build.bind(this),
      [{ which: "mesmerized" }, { which: "awakened" }],
      2,
    );
  },
  fromLine(message) {
    if (probe(`^${MOB} has been mesmerized\\.`, message)) {
      return { which: "mesmerized" };
    }
    if (probe(`^${MOB} has been awakened`, message)) {
      return { which: "awakened" };
    }
    return null;
  },
  captures(p) {
    const caps = [{ group: 1, label: "target's name", token: "${1}" }];
    if (str(p, "which") === "awakened") {
      caps.push({ group: 2, label: "who broke it", token: "${2}" });
    }
    return caps;
  },
  sentence(p) {
    return str(p, "which") === "awakened"
      ? "When a mesmerized target wakes up"
      : "When a target is mesmerized";
  },
  suggestName(p) {
    return str(p, "which") === "awakened" ? "Mez broken" : "Mez landed";
  },
  defaultCategory: "Combat/Crowd Control",
  defaultActions(p) {
    return str(p, "which") === "awakened"
      ? [{ Speak: { template: "${1} awake" } }]
      : [{ Speak: { template: "${1} mezzed" } }];
  },
  exampleLine(p) {
    return str(p, "which") === "awakened"
      ? "Baron Telyx V`Zher has been awakened by Nyasha."
      : "Torvin has been mesmerized.";
  },
};

/** W16's short spoken/name text: leading name stripped when generalized,
 *  trailing punctuation dropped — "slashes YOU for 48 points of damage"
 *  instead of the whole 60-char raw line. */
function w16Short(p: TemplateParams, max: number): string {
  let text = str(p, "text");
  if (flag(p, "anyName") && str(p, "position") !== "anywhere") {
    const lead = leadName(text);
    if (lead) text = text.slice(lead.length).trimStart();
  }
  text = text.replace(/[.!?]+\s*$/, "");
  return clip(text, max);
}

// W16 variants are a 2-bit code: bit 0 = trailing `$` anchor (the generated
// packs' shape), bit 1 = legacy single-word `(\w+)` name capture.
const W16: TemplateDef = {
  id: "contains",
  label: "A line contains specific text",
  params: [
    {
      key: "text",
      kind: "text",
      label: "Text",
      placeholder: "exact text from the log line",
    },
    {
      key: "position",
      kind: "seg",
      label: "Match",
      // "Anywhere" first: it is the safer default for hand-typed fragments
      // (quick-create from a real line explicitly sets "start").
      options: [
        { value: "anywhere", label: "Anywhere in the line" },
        { value: "start", label: "At the start of the line" },
      ],
    },
    { key: "anyNumbers", kind: "toggle", label: "Any amount of damage or numbers" },
    { key: "anyName", kind: "toggle", label: "Any leading name" },
  ],
  variantCount: 4,
  build(p, v = 0) {
    const text = str(p, "text");
    const anyNumbers = flag(p, "anyNumbers");
    const endAnchor = (v & 1) === 1;
    const legacyName = (v & 2) === 2;
    let pat: string;
    if (str(p, "position") === "anywhere") {
      let body = escapeRegex(text);
      if (anyNumbers) body = body.replace(/\d+/g, "\\d+");
      pat = body;
    } else if (legacyName) {
      pat = buildPatternLegacy(text, anyNumbers, flag(p, "anyName"));
    } else {
      pat = buildPattern(text, anyNumbers, flag(p, "anyName"));
    }
    return endAnchor ? `${pat}$` : pat;
  },
  parse(pattern) {
    const build = this.build.bind(this);
    const start = pattern.startsWith("^");
    let body = start ? pattern.slice(1) : pattern;
    let endAnchor = false;
    if (body.endsWith("$") && !body.endsWith("\\$")) {
      endAnchor = true;
      body = body.slice(0, -1);
    }
    let anyName = false;
    let legacyName = false;
    if (start && body.startsWith(MOB)) {
      anyName = true;
      body = body.slice(MOB.length);
    } else if (start && body.startsWith("(\\w+)")) {
      anyName = true;
      legacyName = true;
      body = body.slice("(\\w+)".length);
    }
    const anyNumbers = body.includes("\\d+");
    // Reconstruct with a stand-in digit where \d+ ran; the rebuild replaces
    // any digit run with \d+ again, so byte-equality still verifies. A
    // leading-name capture erased the original name; "Aaa" stands in.
    const text = unescapeRegex(body.replace(/\\d\+/g, "0"));
    const params: TemplateParams = {
      text: anyName ? `Aaa${text}` : text,
      position: start ? "start" : "anywhere",
      anyNumbers,
      anyName,
    };
    const v = (endAnchor ? 1 : 0) | (legacyName ? 2 : 0);
    if (build(params, v) === pattern) return { params, variantIx: v };
    return null;
  },
  fromLine(message) {
    // Smart quick-create defaults: a line with digits almost always wants
    // "any number" (exact-48-damage triggers are useless), and a leading
    // non-You name wants generalizing the same way.
    return {
      text: message,
      position: "start",
      anyNumbers: /\d/.test(message),
      anyName: leadName(message) !== null,
    };
  },
  captures(p) {
    return flag(p, "anyName") && str(p, "position") !== "anywhere"
      ? [{ group: 1, label: "leading name", token: "${1}" }]
      : [];
  },
  sentence(p) {
    const text = str(p, "text");
    if (!text) return "When a line matches your text";
    const anywhere = str(p, "position") === "anywhere";
    let display = text;
    if (!anywhere && flag(p, "anyName")) {
      const lead = leadName(display);
      if (lead) display = `(any name)${display.slice(lead.length)}`;
    }
    if (flag(p, "anyNumbers")) {
      display = display.replace(/\d+/g, "(any number)");
    }
    return `When a line ${anywhere ? "contains" : "starts with"} "${clip(display, 64)}"`;
  },
  suggestName(p) {
    return w16Short(p, 40) || "Custom line";
  },
  defaultCategory: "Custom",
  defaultActions(p) {
    return [{ Speak: { template: w16Short(p, 48) || "alert" } }];
  },
  exampleLine(p) {
    return str(p, "text");
  },
};

// ---------------------------------------------------------------------------
// W17 — chat-channel lines (raid callouts in say/group/guild/ooc/…)
// ---------------------------------------------------------------------------

interface ChatChannel {
  value: string;
  /** The verb phrase between the sender and the quoted message. */
  phrase: string;
  /** Short segment-control label. */
  label: string;
  /** "in group chat" — sentence fragment. */
  inWords: string;
}

/** Channel line formats. "says," and "says out of character," are verified
 *  in the Legends log (fixtures/sample_session.txt); the rest are the
 *  standard classic-EQ third-person forms. */
const CHAT_CHANNELS: ChatChannel[] = [
  { value: "group", phrase: "tells the group", label: "Group", inWords: "in group chat" },
  { value: "guild", phrase: "tells the guild", label: "Guild", inWords: "in guild chat" },
  { value: "say", phrase: "says", label: "Say", inWords: "in say" },
  { value: "ooc", phrase: "says out of character", label: "OOC", inWords: "in OOC" },
  { value: "shout", phrase: "shouts", label: "Shout", inWords: "in a shout" },
  { value: "auction", phrase: "auctions", label: "Auction", inWords: "in auction" },
];

function chatChannel(value: string): ChatChannel {
  return CHAT_CHANNELS.find((c) => c.value === value) ?? CHAT_CHANNELS[0];
}

const W17: TemplateDef = {
  id: "chat",
  label: "Someone says something in chat",
  params: [
    {
      key: "channel",
      kind: "seg",
      label: "Channel",
      options: CHAT_CHANNELS.map((c) => ({ value: c.value, label: c.label })),
    },
    { key: "from", kind: "text", label: "From", placeholder: "anyone" },
    {
      key: "text",
      kind: "text",
      label: "Message contains",
      placeholder: "any message",
    },
  ],
  variantCount: 1,
  build(p) {
    const ch = chatChannel(str(p, "channel"));
    const from = str(p, "from");
    const sender = from ? `(${esc(from)})` : "(\\w+)";
    const text = str(p, "text");
    return text
      ? `^${sender} ${ch.phrase}, '(.*${esc(text)}.*)'`
      : `^${sender} ${ch.phrase}, '(.+)'`;
  },
  parse(pattern) {
    const build = this.build.bind(this);
    for (const ch of CHAT_CHANNELS) {
      if (pattern === `^(\\w+) ${ch.phrase}, '(.+)'`) {
        return {
          params: { channel: ch.value, from: "", text: "" },
          variantIx: 0,
        };
      }
      const hit = parseShapes(pattern, build, [
        {
          re: rec(`^(\\w+) ${ch.phrase}, '(.*`, CAPL, ".*)'"),
          variantIx: 0,
          extract: (m) => ({
            channel: ch.value,
            from: "",
            text: unescapeRegex(m[1]),
          }),
        },
        {
          re: rec("^(", CAPL, `) ${ch.phrase}, '(.*`, CAPL, ".*)'"),
          variantIx: 0,
          extract: (m) => ({
            channel: ch.value,
            from: unescapeRegex(m[1]),
            text: unescapeRegex(m[2]),
          }),
        },
        {
          re: rec("^(", CAPL, `) ${ch.phrase}, '(.+)'`),
          variantIx: 0,
          extract: (m) => ({
            channel: ch.value,
            from: unescapeRegex(m[1]),
            text: "",
          }),
        },
      ]);
      if (hit) return hit;
    }
    return null;
  },
  fromLine(message) {
    for (const ch of CHAT_CHANNELS) {
      if (probe(`^(\\w+) ${ch.phrase}, '(.+)'`, message)) {
        return { channel: ch.value, from: "", text: "" };
      }
    }
    return null;
  },
  captures() {
    return [
      { group: 1, label: "sender's name", token: "${1}" },
      { group: 2, label: "the message", token: "${2}" },
    ];
  },
  sentence(p) {
    const ch = chatChannel(str(p, "channel"));
    const from = str(p, "from") || "anyone";
    const text = str(p, "text");
    return text
      ? `When ${from} mentions "${clip(text, 40)}" ${ch.inWords}`
      : `When ${from} says anything ${ch.inWords}`;
  },
  suggestName(p) {
    const ch = chatChannel(str(p, "channel"));
    const text = str(p, "text");
    return text ? clip(`${ch.label}: ${text}`) : `${ch.label} message`;
  },
  defaultCategory: "Social",
  defaultActions() {
    // Repeat the callout aloud (the GINA raid-callout model).
    return [{ Speak: { template: "${2}" } }];
  },
  exampleLine(p) {
    const ch = chatChannel(str(p, "channel"));
    const from = str(p, "from");
    const text = str(p, "text");
    return `${from && from !== "{C}" ? from : "Torvin"} ${ch.phrase}, '${
      text ? `${text} on the left` : "inc mez on the left"
    }'`;
  },
};

// ---------------------------------------------------------------------------
// Registry + top-level helpers
// ---------------------------------------------------------------------------

/** Dropdown order (W1..W17, chat next to the other social templates). */
export const TEMPLATES: TemplateDef[] = [
  W1,
  W2,
  W17,
  W3,
  W4,
  W5,
  W6,
  W7,
  W8,
  W9,
  W10,
  W11,
  W12,
  W13,
  W14,
  W15,
  W16,
];

/** Recognizer order (spec §8): specific literals first, structured next,
 *  W16 last (it claims any fully-escaped anchored literal). */
const RECOGNIZE_ORDER: TemplateDef[] = [
  W8,
  W9,
  W13,
  W7,
  W4,
  W5,
  W1,
  W2,
  W17,
  W12,
  W15,
  W10,
  W14,
  W11,
  W6,
  W3,
  W16,
];

export function getTemplate(id: string): TemplateDef | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export interface Recognized {
  template: TemplateDef;
  params: TemplateParams;
  variantIx: number;
}

/** Recognize an existing pattern; null -> open in Advanced mode. */
export function recognizePattern(pattern: string): Recognized | null {
  for (const template of RECOGNIZE_ORDER) {
    const hit = template.parse(pattern);
    if (hit) return { template, ...hit };
  }
  return null;
}

/** Quick-create: suggest a template + params for a raw log message.
 *  Never null — W16 claims any line. */
export function suggestTemplateFromLine(message: string): {
  template: TemplateDef;
  params: TemplateParams;
} {
  for (const template of RECOGNIZE_ORDER) {
    if (template === W16) break;
    const params = template.fromLine(message);
    if (params) return { template, params };
  }
  return { template: W16, params: W16.fromLine(message) ?? { text: message } };
}
