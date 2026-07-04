# Trigger editor redesign spec (from UX review agent)

All research is in — codebase, verified Legends line formats, spell data, sound manifest, and the external UX research. Here is the complete redesign spec.

---

# Trigger Authoring Redesign Spec — EQLogs

READ-ONLY review complete. Sources: `app/src/components/QuickTriggerModal.tsx`, `app/src/components/TriggersTab.tsx`, `app/src/types.ts`, `app/src/styles.css`, `triggers/default.json`, `crates/eqlog-triggers/src/engine.rs`, `docs/research-triggers.md` (LEGENDS-VERIFIED section treated as authoritative), `TRIGGERS_PLAN.md`, `DESIGN.md`, `fixtures/local/spell_summary.json`, `assets/sounds/manifest.json`, plus web research on GINA, EQLogParser, BasaBots EQL, and rule-builder UX.

## 0. Current state and pain points

- `TriggersTab.tsx` editor is a flat grid of raw fields: "Pattern (regex, {C} = character name)", "Speak (TTS, ${1} = capture group)". A user must already know regex, the token syntax, and the exact Legends line format to author anything. It also silently limits triggers to one action of each kind (`fromEditor`) and has no pattern validation at all — an invalid regex is only discovered as an engine warning at tail time.
- `QuickTriggerModal.tsx` is better (live match preview, generalize toggles) but still leads with a raw regex field, supports only one action, has no sound action, and its preview only tests against the originating line (not editable).
- The engine (`engine.rs`) already supports everything a friendly builder needs: `{C}/{S}/{N}` pattern tokens, `${1}`/`${name}`/`{C}`/`{TS}` action templates, multiple actions per trigger, timer restart-by-name. The UI just doesn't surface it.

## 1. Research takeaways applied

- **GINA**: plain search text is the default; "Use Regular Expressions" is a per-trigger opt-in, and `{C}`/`{S}`/`{N}` tokens give wildcard power without regex. Timer config is its own panel with explicit restart semantics and "end early" sub-conditions. Notification inputs are gated by their checkboxes.
- **EQLogParser**: `Pattern` + `UseRegex` flag, `EndEarlyPattern`, `WarningSeconds`, GINA-compatible tokens; property-grid layout is documented as *less* beginner-friendly — avoid its density, keep GINA's sectioning.
- **BasaBots EQL**: plain-English sections + a "try-it box" — paste a real log line, see the match, and preview *what it will say/play*, not just highlight spans.
- **Rule-builder canon** (Gmail filters, Zapier/IFTTT, ui-patterns.com): sentence framing ("When X happens → Do Y"), value inputs that morph to the selected criterion, test-before-commit, per-row add/remove for actions, inline non-blocking validation (warn on "no match against sample", error only on invalid regex).

## 2. Architecture

One new shared component, **`TriggerEditor`**, used by both entry points:

- **Quick create** (Live tab): `QuickTriggerModal` becomes a thin `.modal` wrapper (widen `.modal` to 640px for this dialog) passing `initialLine: string`.
- **Add/Edit** (Triggers tab): replaces the `editor-grid` block inside the existing `.card.editor`, passing `initial: Trigger | null`.

Two mutually exclusive When-modes:

- **Builder mode**: template dropdown + parameter controls. The pattern is *derived* — never hand-edited.
- **Advanced mode**: raw pattern field + case-insensitive switch. Reached via the "Advanced" disclosure, via the last dropdown item ("Custom pattern (regex)…"), or automatically when an existing trigger's pattern is not recognized by any template parser.

**Round-trip contract (hard requirement)**: builder state serializes to the *existing* `Trigger` JSON (`app/src/types.ts` / `crates/eqlog-triggers/src/model.rs`) with **zero schema changes**. No builder metadata is stored. Re-opening a trigger runs template recognizers over the pattern string; a template claims a pattern only if rebuilding from the parsed params reproduces the pattern byte-for-byte (see §8). Unrecognized triggers open directly in Advanced mode with everything else (name, category, actions, test box) still fully functional — actions round-trip trivially because action rows map 1:1 onto the `actions` array in order.

## 3. Layout (DESIGN.md-consistent)

Vertical single-column flow inside the card/modal, sections separated by `--hairline` rules, headers in the existing `.section-title` style (11px uppercase, `.08em` tracking, `--ink-muted`). No tabs — the whole trigger reads top-to-bottom as a sentence. System sans, 13px base, 8px radii, hairline borders, accent `#3987e5`, 150–200ms ease-out on section expand/collapse, `prefers-reduced-motion` respected. No emoji in chrome.

```
[ Name ........................ ] [ Category ............ ]   (two .field inputs, 2:1 flex)
──────────────────────────────────────────────────────────
WHEN                                    [ Advanced ▸ ]        (.section-title row, ghost toggle right)
[ template select ▾ ..................................... ]
[ param controls — morph to template ...................... ]
"When any player sends you a tell"                            (derived sentence, --ink-2, 12px)
──────────────────────────────────────────────────────────
THEN
┌ row ─ [ Speak      ▾ ] [ text input ..................] [Remove]
│        chips:  (sender’s name) (my character) (time)
├ row ─ [ Play sound ▾ ] [ Tell — soft glass ding ▾ ] [▸ Preview] [Remove]
└ [ + Add action ]   (ghost button)
──────────────────────────────────────────────────────────
TEST                        (open + prefilled in quick modal; Triggers tab starts collapsed but auto-expands on first WHEN input, seeded with the template's example line — §6)
[ paste-a-log-line input .................................. ]
● Pattern matches this line          (reuse .qt-preview ok/miss/err)
captures:  1 sender = "Torvin"                                  (small table, tabular-nums row numbers)
Will say:  “tell from Torvin”                                   (one line per action, --ink-2)
──────────────────────────────────────────────────────────
[x] Enabled            (spacer)            [Cancel] [Save trigger]   (existing .editor-foot)
```

CSS: new classes prefixed `ted-` (`.ted-section`, `.ted-sentence`, `.ted-action-row`, `.ted-chips`, `.ted-chip`, `.ted-captures`). Chips: pill buttons, `--surface-raised` background, 1px `--border`, 11px text in `--ink-2`, 3px 8px padding, full radius; hover ring in accent. Action rows: flex, kind `<select>` fixed 130px, controls flex-1, hairline top border between rows. Reuse `.field`, `.seg`, `.check-row`, `.qt-line`, `.qt-preview`, `.editor-foot` as-is.

**Name/Category auto-fill**: each template supplies `suggestName(params)` and `defaultCategory`; both fields show suggestions until the user hand-edits them (track a `dirty` flag exactly like `patternOverride` today).

## 4. "When…" — template registry

Dropdown of 16 templates + "Custom pattern (regex)…" as the last item. Param controls render beneath and morph per template: text inputs (with an optional "my character" chip that inserts the literal token `{C}` — the engine expands it, `engine.rs::expand_pattern`), spell comboboxes, and `.seg` toggles for begins/ends pairs.

**Spell picker**: an autocomplete combobox over spell names from `fixtures/local/spell_summary.json` (2,037 player-castable at ≤60; 59,114 total rows with dupes — dedupe by name). The data exists but is not app-accessible yet — see §9. Filter as-you-type, show max 20 results, allow free text (Legends spells not in data). W3's spell param is **multi-select** (chips of chosen spells) building a capturing alternation, which is exactly the starter pack's "Dangerous enemy cast" shape.

Notation for the table — define once:

```
MOB  = (\w[\w`' ]*)          # mob/player name capture (matches starter pack)
esc(x) = regex-escaped literal, except a literal "{C}" chip value passes through unescaped
```

| # | "When…" label | Params | Canonical pattern (built) | Captures → chips | Default category |
|---|---|---|---|---|---|
| W1 | Someone sends me a tell | from (text, default "anyone") | any: `^(\w+) tells you,` · specific: `^(esc(from)) tells you,` | 1 = sender's name | Social |
| W2 | An NPC says something to me | npc (optional) | `^MOB told you,` (literal in group when specified) | 1 = NPC's name | Social |
| W3 | A mob begins casting a spell | caster (optional), spells (multi-select or "any spell") | any/any: `^MOB begins casting (.+)\.$` · spells: `^MOB begins casting (A\|B)\.` (each alternative esc'd; caster group becomes literal-in-parens when specified) | 1 = caster, 2 = spell name | Combat/Enemy Casts |
| W4 | I begin casting a spell | spell (required, castable picker) | `^You begin casting esc(spell)\.` (no capture — round-trips starter) | — | Combat |
| W5 | My spell wears off | spell (picker), "names a target" toggle | bare: `^Your esc(spell) spell has worn off` · with-target: `^Your esc(spell) spell has worn off of (.+)\.` | with-target: 1 = target | Combat |
| W6 | Something is slain | victim (opt), killer (opt; accepts {C} chip) | `^MOB has been slain by MOB!` (literals in parens when specified) | 1 = victim, 2 = killer | Combat |
| W7 | I die | — | v0: `^(?:You died\.\|You have been slain by (.+)!)` · v1 (legacy): `^You died\.` | 1 = killer (may be empty) | Combat/Defense |
| W8 | I am stunned / stun wears off | which: begins\|ends (.seg) | `^You are stunned!` · `^You are no longer stunned\.` | — | Combat/Defense |
| W9 | I am summoned | — | `^You have been summoned!` | — | Combat/Defense |
| W10 | A mob becomes enraged / calms | which: begins\|ends | `^MOB has become ENRAGED\.` · `^MOB is no longer enraged\.` | 1 = mob | Combat/Defense |
| W11 | A mob resists my spell | spell (optional picker) | `^MOB resisted your (.+)!` (spell literal-in-parens when specified) · legacy variant: `resisted your (.+)!` (unanchored, no caster group) | 1 = resister, 2 = spell (legacy: 1 = spell) | Combat/Offense |
| W12 | I resist a spell | — | `^You resist MOB's (.+)!` | 1 = caster, 2 = spell | Combat/Defense |
| W13 | My invisibility is dropping | "also match full break" toggle | `^You feel yourself starting to appear` · toggled: `^(?:You feel yourself starting to appear\|You appear\.\|You become visible\.)` | — | Utility |
| W14 | A spell cast is interrupted | caster (optional) | `^MOB's (.+) spell is interrupted\.` | 1 = caster, 2 = spell | Combat/Enemy Casts |
| W15 | Someone is mesmerized / wakes up | which: mesmerized\|awakened | `^MOB has been mesmerized\.` · `^MOB has been awakened(?: by MOB)?\.` | 1 = target, (awakened) 2 = breaker | Combat/Crowd Control |
| W16 | A line contains specific text | text (required), position .seg anywhere\|line-start, "match any numbers", "match any leading name" | `buildPattern(message, anyNumbers, anyName)` (now in the template lib). anyName generalizes the FULL leading name — multi-word ("Baron Telyx V`Zher") and lowercase-article mobs ("a hill giant") — to the MOB capture, boundary-detected at a known third-person verb; single capitalized word is the fallback. Variants: bit 0 = trailing `$` (generated packs), bit 1 = legacy `(\w+)` head (round-trip only, never newly built). Position defaults to "anywhere" for hand-typed text; quick-create from a real line sets "start" (review-2 ruling C). | 1 = name (when anyName) | Custom |
| W17 | Someone says something in chat | channel .seg say\|group\|guild\|ooc\|shout\|auction, from (text, default anyone), message-contains (text, optional) | any: `^(\w+) <phrase>, '(.+)'` · with text: `^(sender) <phrase>, '(.*esc(text).*)'` — phrases: `says` / `tells the group` / `tells the guild` / `says out of character` / `shouts` / `auctions` (`says,` and `says out of character,` verified in fixtures/sample_session.txt; the rest are the standard classic third-person forms) | 1 = sender's name, 2 = the message | Social |
| — | Custom pattern (regex)… | switches to Advanced mode | user-typed | numbered groups | Custom |

W5 additionally carries a variant 2 — the generated packs' optional-target shape with a trailing
anchor, `^Your esc(spell) spell has worn off(?: of (.+))?\.$` — so the wear-off pack round-trips.

All line formats above are from the LEGENDS-VERIFIED section of `docs/research-triggers.md` (enemy casts are named; wear-off includes target; three-perspective resists; `told you,` vs `tells you,`; named interrupts; awakened-by). W3 note: when "Gate" is selected, show an inline hint that the classic string `begins to cast the gate spell.` (ESTR 1038) also exists and is covered by the curated pack — do not generate the double-form alternation in v1.

**W4 smart default**: selecting a spell prefills a Start-timer action row — name = spell name, duration = that spell's `duration_secs_estimate` from spell_summary, warn-at = max(6s, ~10%) — mirroring the "Mez cast timer" starter (Walking Sleep 48s / warn 6). User can delete the row.

**Constraint (important)**: the Rust `regex` crate has **no lookaround/backreferences**. The builder must never emit them, and there is no "exclude my own kills" option on W6 — offer the killer/victim `{C}` chip instead. Document this in the Advanced-mode hint.

## 5. "Then…" — action rows

Replace both the one-of-each grid (TriggersTab) and the either/or `.seg` (QuickTriggerModal) with an ordered list of action rows mapping 1:1 to `Trigger.actions`. Kind select per row: **Speak**, **Play sound**, **Show text**, **Start timer**. "+ Add action" appends; any mix/duplicates allowed (the engine iterates the whole array). Each template supplies a default first row (e.g. W1 → Speak "tell from " + sender chip = `tell from ${1}`; W3 → Speak `${2} incoming`).

- **Speak** — text input + chip row. Chips are generated from the selected template's capture metadata with friendly labels ("sender's name" → inserts `${1}`, "spell name" → `${2}`), plus always-available "my character" (`{C}`) and "timestamp" (`{TS}`). Chips insert the raw token at the caret — the input always shows the true stored template (no rich-text masking), the friendliness comes from labeled chips plus the rendered "Will say:" preview in the Test section. In Advanced mode chips fall back to generic "capture 1/2/…" labels.
- **Play sound** — `<select>` populated from `assets/sounds/manifest.json` (already exists: 11 entries — Alert, Warning, Danger, Tell, Timer end, Success, Death, Tick, Gong, Chime 2, Chime 3; option text = `label — description first clause`), plus "Custom file…" opening the existing `@tauri-apps/plugin-dialog` picker. A "Preview" ghost-small button plays the sound. Stores the resolved path in `PlaySound.path`; a saved path matching a manifest entry re-selects it on edit, otherwise the select shows "Custom: <basename>". Backend needs two small commands (§9).
- **Show text** — text input + same chip row; hint "appears on the alerts overlay for 4s".
- **Start timer** — Timer name (chips allowed — the engine template-expands timer names, so `${2}` makes a per-spell bar); **Duration** input accepting `90` or `1:30` (parse to `duration_secs`; echo the value back **in words** — "= 10 seconds", never a bare "0:10" that reads as ten minutes); **Warn before end** select: none / 5s / 10s / custom seconds (`warn_at_secs`). Hint under name: "A new match with the same timer name restarts the bar." **"End early when…"** is live (`CancelTimer` is fully wired in the engine): it holds a wear-off line picker (W5-style spell combobox) and on save generates a companion trigger `{name: "<name> — end early", pattern: <W5 pattern>, actions:[{CancelTimer:{name}}], category: same}`.

Validation on Save (inline, in the existing error-banner pattern): at least one action row; non-empty text for Speak/Show; positive duration for timers; warn < duration.

**Refire cooldown** (post-review-2 addition, APP_REVIEW/review-2 item #20): every trigger carries an optional `cooldown_secs` (`Trigger.cooldown_secs`, serde-optional, absent/0 = fire every match). The editor footer exposes it as a "Fire: every match / at most every 2 s … 5 min" select next to Enabled; nonstandard existing values render as their own option and are preserved. The engine throttles per compiled trigger on line timestamps (replay-faithful); throttled matches neither fire actions nor slide the window nor count for fire-dedupe.

## 6. Test section

- Single-line input, prefilled with the live line in quick-create (the `.qt-line` pill becomes this editable input). In the Triggers-tab editor it starts collapsed ("Test against a line ▸") but **auto-expands on the first meaningful "When…" input** (template pick, param edit, pattern edit) — the test box is the editor's best teaching feature and must not stay hidden from exactly the users authoring from scratch (review-2 ruling D). Each template supplies a canonical `exampleLine(params)` that seeds the box (and tracks param edits) until the user types their own line, so the collapsed state is a one-click "show me".
- On paste, strip the 27-char timestamp prefix if present: `^\[[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}\] ` (engine matches `parsed.line.message`, per `eqlog-core/src/parser.rs`).
- Live evaluation on every keystroke of pattern *or* test line:
  1. `expandPatternJs(pattern, characterName)` — a TS mirror of `engine.rs::expand_pattern` ({C} → escaped character name from `AppConfig.characterName` via `getConfig()`; `{S}/{S1}` → `(?<S1>.+)`; `{N}` → `(?<N1>\d+)`; repeats → non-capturing). Also translate `(?P<` → `(?<` so Rust-style named groups compile in JS.
  2. Compile `new RegExp(expanded, case_insensitive ? "i" : "")`; render the existing `.qt-preview` ok/miss/err row.
  3. On match, render a captures table (group number, friendly label from template metadata, value) and per-action rendered previews via `expandTemplateJs` (mirror of `engine.rs::expand_template`, incl. `${n}`, `${name}`, `{C}`, `{TS}`): "Will say: …", "Will show: …", "Starts timer: Walking Sleep — 0:48, warn at 0:06", "Plays: Tell".
- Keep the engine-difference hint ("Preview uses the browser regex engine; the app matches with Rust regex") — 11px, `--ink-muted`.

## 7. Advanced mode (progressive disclosure)

- "Advanced ▸" ghost toggle right-aligned in the WHEN header. Opening it in builder mode shows the derived pattern read-only first, with an "Edit pattern directly" action; the first edit switches the state to advanced (template select shows "Custom pattern (regex)") — same override semantics as today's `patternOverride`.
- Advanced reveals: raw pattern input (mono-spaced not required — keep system sans per DESIGN.md), `case_insensitive` switch, a one-line token legend (`{C}` your name · `{S1}`/`{N1}` wildcards · `${1}`/`${S1}` in action text), and the *expanded* pattern preview (post-token-expansion) in `--ink-muted`.
- "◂ Back to builder" is enabled only when the current pattern parses under §8; otherwise disabled with tooltip "This pattern doesn't match any builder template."

## 8. Round-trip algorithm (spec for `triggerTemplates.ts`)

```ts
interface TemplateDef {
  id: string;                                // "tell", "enemy-cast", ...
  label: string;                             // dropdown text
  params: ParamDef[];                        // control types + option sources
  variants: Variant[];                       // [0] = canonical for new triggers
  captures(params): CaptureChip[];           // {group, label, token}
  build(params, variantIx = 0): string;      // pattern string
  parse(pattern): {params, variantIx} | null;
  fromLine(message): params | null;          // quick-create suggestion
  suggestName(params): string;
  defaultCategory: string;
  defaultActions(params): TriggerAction[];
}
```

- `parse` = run the variant's recognizer regex over the **pattern string** (literal spans un-escaped via an `unescapeRegex` inverse of `escapeRegex`; a span equal to `{C}` is kept as the chip value), then verify `build(params, variantIx) === pattern` **exactly** — the canonical-rebuild check is the round-trip guarantee. Any mismatch → `null` → next variant → next template → Advanced mode.
- Recognizer order: specific literals first (W8, W9, W13, W7), then structured (W4, W5, W1, W2, W12, W15, W10, W14, W11, W6, W3), W16 last (it claims any fully-escaped anchored literal).
- `fromLine` powers quick-create: probe the raw message with each canonical pattern (same order); first hit pre-selects the template and fills params from its captures; no hit → W16 with `text = message`. This replaces (and subsumes) today's suggest-and-toggle logic; `buildPattern` moves into W16 unchanged.
- **Acceptance criterion (widened after review round 2)**: the golden corpus is **every pattern in `triggers/curated` + `triggers/generated`** — at least 98% must open in builder mode (currently 1,621/1,647 = 98.4%; the trailing-`$` W5/W16 variants closed the two big failure buckets). The 10 `triggers/default.json` starters remain individually pinned — Stunned/Stun over → W8, Tell received → W1, Dangerous enemy cast → W3 (legacy variant: no `$`, MOB caster, 2-spell alternation), Encumbered + Level up → W16, Spell resisted → W11 legacy variant, Mez worn off → W5, Mez cast timer → W4, You died → W7 v1. Unit-test the starter table, the corpus percentage, and `parse(build(p)) === p` for every template/variant (see `app/src/lib/triggerTemplates.test.ts`).

## 9. Data plumbing and backend deltas (flagged — outside app/src)

1. **Spell names**: extend `tools/spelldata/extract_spells.py` with an `--emit-names` output committed to `app/src/data/spell_names.json`: `{ "castable": [2,037 deduped names], "all": [deduped names of spells with cast messages, for W3] }` (~a few hundred KB worst case; combobox caps rendering at 20). `fixtures/local/` is local game data — only the generated name list ships with the app.
2. **Sounds**: Tauri commands `list_sounds() -> {label, file, path, duration_ms, description}[]` (resolve `assets/sounds/` via the Tauri resource dir; bundle the directory in `tauri.conf`) and `preview_sound(path)` (route to the existing audio thread in `app/src-tauri/src/audio.rs`, which already opens files by path).
3. **CancelTimer — SHIPPED**: `Action::CancelTimer { name }` exists in `crates/eqlog-triggers/src/model.rs` + `engine.rs` and §5's "End early when…" row is live in the editor. (The old "Phase 2 / row disabled until this lands" flag was stale — confirmed by the round-2 review's code audit.)

## 10. File inventory (for the implementing agent)

- New: `app/src/lib/triggerTemplates.ts` (registry, §8), `app/src/lib/patternJs.ts` (`escapeRegex`/`unescapeRegex`/`expandPatternJs`/`expandTemplateJs`/`stripTimestamp` + tests), `app/src/data/spell_names.json` (generated), `app/src/components/TriggerEditor.tsx` (sections; small internal components: `TemplatePicker`, `ParamControls`, `SpellCombo`, `ActionRows`, `SoundSelect`, `DurationInput`, `TokenChips`, `TestBox`).
- Modified: `QuickTriggerModal.tsx` (thin wrapper; delete its inline form; keep `buildPattern` export by re-exporting from the template lib for test continuity), `TriggersTab.tsx` (swap `editor-grid` for `TriggerEditor`; list view unchanged), `styles.css` (`.ted-*` additions).
- Backend (separate change): the two sound commands; Phase 2 `CancelTimer`.

Key gotchas already encoded above: Rust regex has no lookaround (never generate it); JS preview must translate `(?P<` → `(?<`; `case_insensitive` defaults true; actions array order is preserved; timer restart is by expanded name; the sound manifest already exists at `/home/townsendg/projects/games/everquest_legends/eqlogs/assets/sounds/manifest.json` with 11 entries.