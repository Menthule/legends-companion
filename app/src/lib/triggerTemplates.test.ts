// Plain-assert test runner for the template registry + patternJs mirrors.
// No test framework in this repo: bundle with esbuild and run under node
// (from app/, so the golden-corpus audit finds ../triggers), e.g.
//   npx esbuild src/lib/triggerTemplates.test.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/tt.test.mjs && node /tmp/tt.test.mjs

import {
  expandPatternJs,
  expandTemplateJs,
  formatDuration,
  formatDurationWords,
  parseDuration,
  stripTimestamp,
  toJsRegexSource,
} from "./patternJs";
import {
  buildPattern,
  LEAD_NAME_RE,
  leadName,
  recognizePattern,
  suggestTemplateFromLine,
  TEMPLATES,
  type TemplateParams,
} from "./triggerTemplates";

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

function eq<T>(got: T, want: T, label: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(g === w, `${label}\n  got:  ${g}\n  want: ${w}`);
}

// ---------------------------------------------------------------------------
// patternJs mirrors
// ---------------------------------------------------------------------------

eq(
  expandPatternJs("{C} hits", "Ny(a)sha+"),
  "Ny\\(a\\)sha\\+ hits",
  "expandPatternJs escapes character metachars",
);
eq(
  expandPatternJs("{S} and {N2} and {s1} {S1}", "X"),
  "(?P<S>.+) and (?P<N2>\\d+) and (?P<S1>.+) (?:.+)",
  "expandPatternJs tokens + repeat becomes non-capturing",
);
eq(
  toJsRegexSource("(?P<S1>.+) x (?P<N2>\\d+)"),
  "(?<S1>.+) x (?<N2>\\d+)",
  "toJsRegexSource translates rust named groups",
);

{
  const re = new RegExp(toJsRegexSource("^(\\w+) tells you, '(?P<MSG>.+)'"));
  const m = re.exec("Torvin tells you, 'inc mez'");
  ok(m !== null, "preview regex matches tell line");
  eq(
    expandTemplateJs("tell from ${1}: ${msg} at {TS} for {C}", m as RegExpExecArray, "Nyasha", 3725),
    "tell from Torvin: inc mez at 01:02:05 for Nyasha",
    "expandTemplateJs positional + named(lowercase fallback) + {TS} + {C}",
  );
  eq(
    expandTemplateJs("x${9}x${nope}x", m as RegExpExecArray, "N", 0),
    "xxx",
    "unknown references expand to empty",
  );
}

eq(
  stripTimestamp("[Wed Jul 01 22:14:05 2026] You are stunned!"),
  "You are stunned!",
  "stripTimestamp removes the 27-char prefix",
);
eq(
  stripTimestamp("You are stunned!"),
  "You are stunned!",
  "stripTimestamp leaves bare lines alone",
);

eq(parseDuration("90"), 90, "parseDuration plain seconds");
eq(parseDuration("1:30"), 90, "parseDuration m:ss");
eq(parseDuration("1:02:05"), 3725, "parseDuration h:mm:ss");
eq(parseDuration("35m"), 2100, "parseDuration 35m");
eq(parseDuration("1h10m"), 4200, "parseDuration 1h10m");
eq(parseDuration("2m30s"), 150, "parseDuration 2m30s");
eq(parseDuration("nope"), null, "parseDuration garbage -> null");
eq(formatDuration(90), "1:30", "formatDuration m:ss");
eq(formatDuration(3725), "1:02:05", "formatDuration h:mm:ss");
eq(formatDurationWords(10), "10 seconds", "formatDurationWords bare seconds");
eq(formatDurationWords(1), "1 second", "formatDurationWords singular second");
eq(formatDurationWords(600), "10 minutes", "formatDurationWords whole minutes");
eq(formatDurationWords(90), "1 minute 30 sec", "formatDurationWords m+s");
eq(formatDurationWords(3725), "1 hr 2 minutes 5 sec", "formatDurationWords h+m+s");

// ---------------------------------------------------------------------------
// Acceptance table (spec §8): every v1 starter trigger opens in builder mode
// ---------------------------------------------------------------------------

const STARTERS: { name: string; pattern: string; template: string; variant: number }[] = [
  { name: "Stunned", pattern: "^You are stunned!", template: "stun", variant: 0 },
  { name: "Stun over", pattern: "^You are no longer stunned\\.", template: "stun", variant: 0 },
  { name: "Tell received", pattern: "^(\\w+) tells you,", template: "tell", variant: 0 },
  {
    name: "Dangerous enemy cast",
    pattern: "^(\\w[\\w`' ]*) begins casting (Cancelling of Life|Engulfing Darkness)\\.",
    template: "enemy-cast",
    variant: 0,
  },
  { name: "Encumbered", pattern: "^You are encumbered!", template: "contains", variant: 0 },
  { name: "Level up", pattern: "^You have gained a level!", template: "contains", variant: 0 },
  { name: "Spell resisted", pattern: "resisted your (.+)!", template: "resist-out", variant: 1 },
  {
    name: "Mez worn off",
    pattern: "^Your Walking Sleep spell has worn off",
    template: "worn-off",
    variant: 0,
  },
  {
    name: "Mez cast timer",
    pattern: "^You begin casting Walking Sleep\\.",
    template: "my-cast",
    variant: 0,
  },
  { name: "You died", pattern: "^You died\\.", template: "i-die", variant: 0 },
];

for (const s of STARTERS) {
  const hit = recognizePattern(s.pattern);
  ok(hit !== null, `starter "${s.name}" opens in builder mode`);
  if (!hit) continue;
  eq(hit.template.id, s.template, `starter "${s.name}" -> template`);
  eq(hit.variantIx, s.variant, `starter "${s.name}" -> variant`);
  eq(
    hit.template.build(hit.params, hit.variantIx),
    s.pattern,
    `starter "${s.name}" rebuilds byte-for-byte`,
  );
}

// Params spot-checks on the interesting starters.
{
  const cast = recognizePattern(
    "^(\\w[\\w`' ]*) begins casting (Cancelling of Life|Engulfing Darkness)\\.",
  );
  eq(
    cast?.params["spells"],
    ["Cancelling of Life", "Engulfing Darkness"],
    "W3 legacy starter extracts the spell list",
  );
  const worn = recognizePattern("^Your Walking Sleep spell has worn off");
  eq(worn?.params["spell"], "Walking Sleep", "W5 starter extracts spell");
  const my = recognizePattern("^You begin casting Walking Sleep\\.");
  eq(my?.params["spell"], "Walking Sleep", "W4 starter extracts spell");
}

// ---------------------------------------------------------------------------
// Curated/generated pack shapes also open in builder mode
// ---------------------------------------------------------------------------

const PACK_SHAPES: { pattern: string; template: string; variant: number }[] = [
  // Trailing-$ pack shapes (the report's 28% round-trip failure buckets).
  {
    pattern: "^Your Chloroplast spell has worn off(?: of (.+))?\\.$",
    template: "worn-off",
    variant: 2,
  },
  {
    pattern: "^The spirit of wolf leaves you\\.$",
    template: "contains",
    variant: 1,
  },
  { pattern: "^You slow down\\.$", template: "contains", variant: 1 },
  // Legacy single-word name capture with trailing anchor (CH chains).
  {
    pattern: "^(\\w+) begins casting Complete Heal\\.$",
    template: "contains",
    variant: 3,
  },
  // Chat-channel shapes (W17).
  { pattern: "^(\\w+) tells the group, '(.+)'", template: "chat", variant: 0 },
  {
    pattern: "^(\\w+) says out of character, '(.*WTS.*)'",
    template: "chat",
    variant: 0,
  },
  { pattern: "^You have been summoned!", template: "summoned", variant: 0 },
  { pattern: "^(.+) has become ENRAGED\\.", template: "enrage", variant: 1 },
  { pattern: "^(.+) is no longer enraged\\.", template: "enrage", variant: 1 },
  { pattern: "^(.+) has been mesmerized\\.$", template: "mez", variant: 1 },
  { pattern: "^(.+) has been awakened(?: by (.+))?\\.$", template: "mez", variant: 1 },
  { pattern: "^(.+) resisted your (.+)!", template: "resist-out", variant: 2 },
  { pattern: "^You resist (.+)!", template: "resist-in", variant: 1 },
  { pattern: "^You feel yourself starting to appear\\.", template: "contains", variant: 0 },
  { pattern: "^You begin casting Resist Cold\\.$", template: "my-cast", variant: 1 },
  {
    pattern:
      "^(.+) begins casting (Markar's Clash|Sound of Force|Tishan's Clash|Color Shift|Color Slant|Color Flux|Color Skew|Holy Might|Force|Stun)\\.$",
    template: "enemy-cast",
    variant: 1,
  },
  {
    pattern: "^Your Walking Sleep spell has worn off(?: of (.+))?\\.",
    template: "worn-off",
    variant: 1,
  },
];

for (const s of PACK_SHAPES) {
  const hit = recognizePattern(s.pattern);
  ok(hit !== null, `pack pattern recognized: ${s.pattern}`);
  if (!hit) continue;
  eq(hit.template.id, s.template, `pack pattern -> template: ${s.pattern}`);
  eq(hit.variantIx, s.variant, `pack pattern -> variant: ${s.pattern}`);
  eq(
    hit.template.build(hit.params, hit.variantIx),
    s.pattern,
    `pack pattern rebuilds byte-for-byte: ${s.pattern}`,
  );
}

// ---------------------------------------------------------------------------
// parse(build(p, v)) === {p, v} for every template/variant
// ---------------------------------------------------------------------------

const ROUND_TRIP: { id: string; params: TemplateParams; variant?: number }[] = [
  { id: "tell", params: { from: "" } },
  { id: "tell", params: { from: "Torvin" } },
  { id: "tell", params: { from: "Mr. Odd (x)" } }, // metachars survive esc/unesc
  { id: "npc-tell", params: { npc: "" } },
  { id: "npc-tell", params: { npc: "Guard Hann" } },
  { id: "enemy-cast", params: { caster: "", spells: [] } },
  { id: "enemy-cast", params: { caster: "", spells: ["Gate"] } },
  { id: "enemy-cast", params: { caster: "a lich", spells: ["Harm Touch", "Fear"] } },
  { id: "enemy-cast", params: { caster: "a lich", spells: [] } },
  { id: "enemy-cast", params: { caster: "", spells: [] }, variant: 1 },
  { id: "enemy-cast", params: { caster: "", spells: ["Complete Heal"] }, variant: 1 },
  { id: "my-cast", params: { spell: "Clarity" } },
  { id: "my-cast", params: { spell: "Divine Aura" }, variant: 1 },
  { id: "worn-off", params: { spell: "Root", withTarget: false } },
  { id: "worn-off", params: { spell: "Root", withTarget: true } },
  { id: "worn-off", params: { spell: "Root", withTarget: false }, variant: 1 },
  { id: "slain", params: { victim: "", killer: "" } },
  { id: "slain", params: { victim: "Torvin", killer: "" } },
  { id: "slain", params: { victim: "", killer: "{C}" } }, // {C} chip passes unescaped
  { id: "slain", params: { victim: "a bat", killer: "{C}" } },
  { id: "i-die", params: { alsoSlain: true } },
  { id: "i-die", params: { alsoSlain: false } },
  { id: "stun", params: { which: "begins" } },
  { id: "stun", params: { which: "ends" } },
  { id: "summoned", params: {} },
  { id: "enrage", params: { which: "begins" } },
  { id: "enrage", params: { which: "ends" } },
  { id: "enrage", params: { which: "begins" }, variant: 1 },
  { id: "resist-out", params: { spell: "" } },
  { id: "resist-out", params: { spell: "Fire Flux" } },
  { id: "resist-out", params: { spell: "" }, variant: 1 },
  { id: "resist-out", params: { spell: "Fire Flux" }, variant: 1 },
  { id: "resist-out", params: { spell: "" }, variant: 2 },
  { id: "resist-in", params: {} },
  { id: "resist-in", params: {}, variant: 1 },
  { id: "invis-drop", params: { alsoBreak: false } },
  { id: "invis-drop", params: { alsoBreak: true } },
  { id: "interrupted", params: { caster: "" } },
  { id: "interrupted", params: { caster: "Baron Telyx V`Zher" } },
  { id: "mez", params: { which: "mesmerized" } },
  { id: "mez", params: { which: "awakened" } },
  { id: "mez", params: { which: "mesmerized" }, variant: 1 },
  { id: "mez", params: { which: "awakened" }, variant: 1 },
  {
    id: "contains",
    params: { text: "You are out of food and drink.", position: "start", anyNumbers: false, anyName: false },
  },
  {
    id: "contains",
    params: { text: "hits YOU for 128 points", position: "anywhere", anyNumbers: true, anyName: false },
  },
  {
    id: "contains",
    params: { text: "Aaa pierces you for 48 points of damage.", position: "start", anyNumbers: true, anyName: true },
  },
  // W16 variants: bit 0 = trailing $, bit 1 = legacy (\w+) name capture.
  {
    id: "contains",
    params: { text: "The spirit of wolf leaves you.", position: "start", anyNumbers: false, anyName: false },
    variant: 1,
  },
  {
    id: "contains",
    params: { text: "Aaa slashes YOU for 48 points of damage.", position: "start", anyNumbers: true, anyName: true },
    variant: 1,
  },
  {
    id: "contains",
    params: { text: "Aaa pierces you for 48 points of damage.", position: "start", anyNumbers: true, anyName: true },
    variant: 2,
  },
  {
    id: "contains",
    params: { text: "Aaa begins casting Complete Heal.", position: "start", anyNumbers: false, anyName: true },
    variant: 3,
  },
  // W5 trailing-$ variant (generated wear-off packs).
  { id: "worn-off", params: { spell: "Chloroplast", withTarget: false }, variant: 2 },
  // W17 chat channels.
  { id: "chat", params: { channel: "group", from: "", text: "" } },
  { id: "chat", params: { channel: "group", from: "", text: "inc mez" } },
  { id: "chat", params: { channel: "guild", from: "Torvin", text: "" } },
  { id: "chat", params: { channel: "ooc", from: "Torvin", text: "WTS jboots" } },
  { id: "chat", params: { channel: "say", from: "", text: "camp check" } },
  { id: "chat", params: { channel: "shout", from: "", text: "" } },
  { id: "chat", params: { channel: "auction", from: "", text: "10p" } },
];

const seenTemplates = new Set<string>();
for (const c of ROUND_TRIP) {
  seenTemplates.add(c.id);
  const t = TEMPLATES.find((x) => x.id === c.id);
  ok(t !== undefined, `template exists: ${c.id}`);
  if (!t) continue;
  const v = c.variant ?? 0;
  const pattern = t.build(c.params, v);
  const parsed = t.parse(pattern);
  ok(parsed !== null, `${c.id} v${v} parses its own build: ${pattern}`);
  if (!parsed) continue;
  eq(
    t.build(parsed.params, parsed.variantIx),
    pattern,
    `${c.id} v${v} canonical rebuild is stable`,
  );
  // The globally recognized template must rebuild the same pattern too
  // (a different template may claim it first only if byte-identical).
  const global = recognizePattern(pattern);
  ok(global !== null, `${c.id} v${v} recognized globally`);
  if (global) {
    eq(
      global.template.build(global.params, global.variantIx),
      pattern,
      `${c.id} v${v} global recognition rebuilds byte-for-byte`,
    );
  }
}
eq(seenTemplates.size, TEMPLATES.length, "round-trip table covers all 17 templates");

// ---------------------------------------------------------------------------
// buildPattern (W16 core) + full-name generalization (report item #1)
// ---------------------------------------------------------------------------

eq(
  buildPattern("Torvin pierces you for 48 points of damage.", false, false),
  "^Torvin pierces you for 48 points of damage\\.",
  "buildPattern literal",
);
eq(
  buildPattern("Torvin pierces you for 48 points of damage.", true, true),
  "^(\\w[\\w`' ]*) pierces you for \\d+ points of damage\\.",
  "buildPattern generalized emits the MOB capture",
);

// LEAD_NAME_RE: the FULL name generalizes, including multi-word and
// lowercase-article mobs (the W16 "Anyone" toggle's whole point).
eq(
  leadName("Baron Telyx V`Zher slashes YOU for 20 points of damage."),
  "Baron Telyx V`Zher",
  "leadName captures a full multi-word name up to the verb",
);
eq(
  leadName("a hill giant hits YOU for 48 points of damage."),
  "a hill giant",
  "leadName captures a lowercase-article mob name",
);
eq(leadName("Xantik, flee!"), "Xantik", "leadName single-word fallback");
eq(leadName("You have gained a level!"), null, "leadName excludes You");
eq(leadName("Your faction standing got worse."), null, "leadName excludes Your");
ok(LEAD_NAME_RE.exec("Aaa slashes YOU")?.[0] === "Aaa", "stand-in name re-extracts");

{
  // The generalized pattern must actually match OTHER mobs' lines — the
  // toggle's promise (NAIVE #1/#4: the old single-word matcher made
  // "Baron Telyx V`Zher slashes…" match essentially nobody else).
  const built = buildPattern(
    "Baron Telyx V`Zher slashes YOU for 20 points of damage.",
    true,
    true,
  );
  eq(
    built,
    "^(\\w[\\w`' ]*) slashes YOU for \\d+ points of damage\\.",
    "multi-word mob line generalizes the whole name",
  );
  const re = new RegExp(toJsRegexSource(built), "i");
  ok(
    re.test("a hill giant slashes YOU for 112 points of damage."),
    "generalized pattern matches a different (lowercase) mob",
  );
  ok(
    re.test("Lord Nagafen slashes YOU for 600 points of damage."),
    "generalized pattern matches a different (multi-word) mob",
  );
  // Round-trips back into the builder.
  const hit = recognizePattern(built);
  eq(hit?.template.id, "contains", "generalized pattern reopens as W16");
  eq(
    hit ? hit.template.build(hit.params, hit.variantIx) : "",
    built,
    "generalized pattern rebuilds byte-for-byte",
  );
}

// W16 sentence reflects the generalize toggles (report item #1b).
{
  const w16 = TEMPLATES.find((t) => t.id === "contains");
  ok(w16 !== undefined, "W16 exists");
  const s = w16?.sentence({
    text: "Baron Telyx V`Zher slashes YOU for 20 points of damage.",
    position: "start",
    anyNumbers: true,
    anyName: true,
  });
  ok(
    Boolean(s && s.includes("(any name)") && s.includes("(any number)")),
    `W16 sentence shows the toggles: ${s}`,
  );
  const sOff = w16?.sentence({
    text: "Baron slashes YOU for 20 points.",
    position: "start",
    anyNumbers: false,
    anyName: false,
  });
  ok(
    Boolean(sOff && !sOff.includes("(any")),
    "W16 sentence stays literal with toggles off",
  );
}

// W16 quick-create smart defaults (report item #9).
{
  const w16 = TEMPLATES.find((t) => t.id === "contains");
  const p = w16?.fromLine("Baron Telyx V`Zher slashes YOU for 20 points of damage.");
  eq(p?.["anyNumbers"], true, "fromLine pre-enables anyNumbers on digit lines");
  eq(p?.["anyName"], true, "fromLine pre-enables anyName for a leading mob name");
  const p2 = w16?.fromLine("You have gained a level!");
  eq(p2?.["anyName"], false, "fromLine leaves anyName off for You-lines");
  eq(p2?.["anyNumbers"], false, "fromLine leaves anyNumbers off without digits");
  // Default Speak is the short name, not the 60-char raw line.
  const acts = p ? w16?.defaultActions(p) : undefined;
  const speak =
    acts && acts[0] && "Speak" in acts[0] ? acts[0].Speak.template : "";
  ok(
    speak === "slashes YOU for 20 points of damage",
    `W16 default Speak drops the mob name: "${speak}"`,
  );
}

// ---------------------------------------------------------------------------
// Quick-create suggestions
// ---------------------------------------------------------------------------

const SUGGEST: { line: string; template: string }[] = [
  { line: "Torvin tells you, 'inc mez'", template: "tell" },
  { line: "Guard Hann told you, 'go away'", template: "npc-tell" },
  { line: "Vibarn begins casting Clinging Darkness.", template: "enemy-cast" },
  { line: "You begin casting Walking Sleep.", template: "my-cast" },
  { line: "Your Walking Sleep spell has worn off of Baron Telyx V`Zher.", template: "worn-off" },
  { line: "A soldier of V`Zher has been slain by Nyasha!", template: "slain" },
  { line: "You died.", template: "i-die" },
  { line: "You are stunned!", template: "stun" },
  { line: "You have been summoned!", template: "summoned" },
  { line: "Baron Telyx V`Zher has become ENRAGED.", template: "enrage" },
  { line: "A willowisp resisted your Vampiric Embrace!", template: "resist-out" },
  { line: "You resist a necro initiate's Clinging Darkness!", template: "resist-in" },
  { line: "You feel yourself starting to appear.", template: "invis-drop" },
  { line: "Baron Telyx V`Zher's Healing spell is interrupted.", template: "interrupted" },
  { line: "Torvin has been mesmerized.", template: "mez" },
  // W17 chat channels ("says," and "says out of character," verified in
  // fixtures/sample_session.txt; others are the standard classic forms).
  { line: "Torvin tells the group, 'inc mez on the left'", template: "chat" },
  { line: "Torvin tells the guild, 'raid at 8'", template: "chat" },
  {
    line: "Gloldus says out of character, 'WTS Enchanted Fine Steel Morning Star +4 10p'",
    template: "chat",
  },
  { line: "Torvin shouts, 'TRAIN to zone!'", template: "chat" },
  { line: "You looted 4 platinum, 7 gold from a corpse.", template: "contains" },
];

for (const s of SUGGEST) {
  const hit = suggestTemplateFromLine(s.line);
  eq(hit.template.id, s.template, `suggest "${s.line}"`);
}

{
  const hit = suggestTemplateFromLine("Vibarn begins casting Clinging Darkness.");
  eq(hit.params["spells"], ["Clinging Darkness"], "suggest fills the W3 spell");
  const built = hit.template.build(hit.params);
  eq(
    built,
    "^(\\w[\\w`' ]*) begins casting (Clinging Darkness)\\.",
    "suggested W3 pattern",
  );
  ok(
    new RegExp(toJsRegexSource(built), "i").test(
      "Vibarn begins casting Clinging Darkness.",
    ),
    "suggested W3 pattern matches the source line",
  );
}

// Every suggested pattern must match its own source line.
for (const s of SUGGEST) {
  const hit = suggestTemplateFromLine(s.line);
  const built = hit.template.build(hit.params);
  const expanded = expandPatternJs(built, "Nyasha");
  ok(
    new RegExp(toJsRegexSource(expanded), "i").test(s.line),
    `suggested pattern matches its line: ${s.line} -> ${built}`,
  );
}

// W17 channel detection from quick-create.
{
  const hit = suggestTemplateFromLine("Torvin tells the group, 'inc mez on the left'");
  eq(hit.params["channel"], "group", "chat suggest detects the group channel");
  const ooc = suggestTemplateFromLine(
    "Gloldus says out of character, 'WTS Enchanted Fine Steel Morning Star +4 10p'",
  );
  eq(ooc.params["channel"], "ooc", "chat suggest detects the OOC channel");
}

// Every template supplies a canonical example line, and literal-ish
// templates' examples match their own canonical any-pattern.
for (const t of TEMPLATES) {
  if (t.id === "contains") continue; // example mirrors the text param
  const params: TemplateParams = {};
  for (const def of t.params) {
    if (def.kind === "seg") params[def.key] = def.options[0].value;
    else if (def.kind === "toggle") params[def.key] = false;
    else if (def.kind === "spells") params[def.key] = [];
    else params[def.key] = "";
  }
  const example = t.exampleLine(params);
  ok(example.length > 0, `template ${t.id} has an example line`);
  if (t.id === "my-cast" || t.id === "worn-off") {
    continue; // empty required spell param -> pattern is intentionally hollow
  }
  const built = t.build(params, 0);
  const expanded = expandPatternJs(built, "Nyasha");
  ok(
    new RegExp(toJsRegexSource(expanded), "i").test(example),
    `template ${t.id} example matches its canonical pattern: ${example} -> ${built}`,
  );
}

// ---------------------------------------------------------------------------
// Golden corpus (spec §8): every pattern in triggers/curated + generated.
// Runs only under node (bundle with --platform=node from app/); skipped
// when the pack files are unreachable.
// ---------------------------------------------------------------------------

interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: string): string;
}

let fsMod: FsLike | null = null;
try {
  // @ts-ignore -- node builtin; this project ships no @types/node
  fsMod = (await import("node:fs")) as unknown as FsLike;
} catch {
  fsMod = null;
}

if (fsMod) {
  const fs = fsMod;
  const root = ["../triggers", "triggers", "../../triggers"].find((r) =>
    fs.existsSync(`${r}/curated`),
  );
  if (root) {
    let total = 0;
    let recognized = 0;
    for (const dir of ["curated", "generated"]) {
      for (const f of fs.readdirSync(`${root}/${dir}`)) {
        if (!f.endsWith(".json")) continue;
        const pack = JSON.parse(
          fs.readFileSync(`${root}/${dir}/${f}`, "utf8"),
        ) as { triggers: { pattern: string }[] };
        for (const t of pack.triggers) {
          total += 1;
          const hit = recognizePattern(t.pattern);
          if (hit && hit.template.build(hit.params, hit.variantIx) === t.pattern) {
            recognized += 1;
          }
        }
      }
    }
    const pct = (recognized / total) * 100;
    ok(total >= 1600, `golden corpus loaded (${total} pack triggers)`);
    ok(
      pct >= 98,
      `golden corpus round-trips >= 98% in builder mode (got ${recognized}/${total} = ${pct.toFixed(1)}%)`,
    );
    console.log(
      `golden corpus: ${recognized}/${total} recognized (${pct.toFixed(1)}%)`,
    );
  } else {
    console.log("golden corpus: triggers/ packs not found from cwd — skipped");
  }
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  // Throwing makes node exit non-zero (no @types/node in this project, so
  // process.exit is off-limits to keep tsc clean).
  throw new Error(`${failures}/${checks} checks FAILED`);
}
console.log(`ok — ${checks} checks passed`);
