# Trigger Editor UX Review — Round 2 Synthesis

Synthesized from three parallel review streams (all hands-on against the built app in mock mode):
**NAIVE-USER** (5 tasks role-played end-to-end, screenshots `ter2-nu-*`), **EXPERT/COMPETITIVE**
(corpus audit of all 1,647 pack triggers + GINA/WeakAuras/EQLogParser comparison, screenshots
`ter2-pr-*`), and **INTERACTION DETAIL** (CDP-driven keyboard/focus/error-path stress pass).

## Verdict

The redesign's core bets pay off: the sentence preview, the labeled-capture test box, and the
16-template flow are real aids, not decoration — all three streams built working triggers in 2–6
interactions (versus ~10 fields in GINA), the naive user completed all five tasks, and the
builder↔advanced round-trip survived every stress test on user-authored triggers. Its biggest
remaining weakness is that **the editor still fails silently**: validation errors render off-screen,
the W16 "Anyone" toggle produces a trigger that can never fire for anyone else, uncommitted
combobox text is discarded on Save, and Escape destroys a full modal's work — every one of these
leaves the user believing they succeeded when they didn't. A close second: the app's flagship
content, 1,647 pack triggers, has no path into the editor at all, so the most common post-install
intent ("this pack trigger is almost right, tweak it") dead-ends.

## Ranked improvements

Severity ranking weighs (a) whether the user ends up with a silently-broken or duplicated trigger,
(b) whether work is destroyed, (c) how many users hit it. Tiers: **QUICK WIN** = hours,
**MEDIUM** = about a day, **STRUCTURAL** = multi-day.

### Tier 1 — silent wrong results & work destruction (fix before anything else)

**1. Fix W16 "Anyone, not just X" to generalize the full mob name, and make the sentence reflect the toggles.** — QUICK WIN (S)
`LEAD_NAME_RE = /^[A-Z][a-z]+/` (`app/src/lib/triggerTemplates.ts:181`) replaces only the first
word: "Baron Telyx V`Zher slashes YOU…" becomes `^(\w+) Telyx V`Zher slashes…`, so the trigger
matches essentially nobody else — the direct opposite of the toggle's promise — and for lowercase
mobs ("a hill giant hits YOU") the toggle is a silent no-op. Meanwhile W16's `sentence()` (~:1134)
ignores `anyNumbers`/`anyName`, so the preview still shows the literal name after both toggles are
on, reading as "the toggle did nothing". Extend the matcher to the full mob shape
(`(\w[\w`' ]*)` up to the verb) and format the sentence as "(any name) slashes YOU for (any
number)…". Evidence: NAIVE #1 + #4 (worst defect found in the naive run).

**2. Scroll the save-validation error into view (or render it at the footer).** — QUICK WIN (S)
Independently found by two streams: the single `.ted-error` banner renders at the top of a ~700px
card (`TriggerEditor.tsx:1077`), measured at −575px when Save is clicked from the footer — Save
appears to do nothing, and naive users conclude the app is broken. Minimum: `scrollIntoView` +
focus on `setError`; better: duplicate the message next to the Save button or inline per-field.
Evidence: NAIVE #3, INTERACTION #2 (both verified live).

**3. Stop Escape in the spell combobox from closing the whole quick modal.** — QUICK WIN (S)
SpellCombo's Escape handler (`TriggerEditor.tsx` ~:260) closes the popup but never
`stopPropagation()`; `QuickTriggerModal.tsx:21-27` listens on window and unconditionally
`onClose()` — dismissing a suggestion popup, the single most standard combobox gesture, unmounts
the modal and destroys everything typed. Evidence: INTERACTION #1 (verified live).

**4. Commit pending combobox text on blur/Save, or block Save while text is uncommitted.** — QUICK WIN (S)
Typing "Ice Comet" into W3's spell box and clicking Save (no Enter) silently produces
`^(\w[\w`' ]*) begins casting (.+)\.$` — an any-spell-any-mob spam trigger — while the box still
visibly contains "Ice Comet". The easiest way for a naive user to ship a spam trigger. Evidence:
NAIVE #2 (pattern verified from the saved tree row).

**5. Add dirty-state guards to every discard path.** — MEDIUM (M)
Three verified silent-discard paths: scrim mousedown (`QuickTriggerModal.tsx:40-42`), window
Escape, and `openEditor()`/`editorNonce++` (`TriggersTab.tsx:322`) resetting a half-finished edit
when the user clicks Add trigger or another row's Edit. One confirm-if-dirty guard covers all of
them; a `dirty` ref already exists (currently autofill-only). Evidence: INTERACTION #4.

### Tier 2 — the library and the templates

**6. Add "Duplicate to my triggers" on curated/generated rows.** — QUICK WIN (S)
`renderEntry()` (`TriggersTab.tsx:588-608`) only renders Edit/Delete when `userIndex !== null`,
so 1,647 of 1,657 on-screen triggers have zero editor entry point — no edit, no read-only view,
no copy. This also strands the round-trip investment: `recognizePattern()` would open most curated
triggers beautifully, but no user can reach that state. A ghost button calling
`openEditor({index:null, trigger:{...e}})` is nearly free and turns the pack library into a
template gallery (the WeakAuras/EQLogParser model). Evidence: EXPERT #4, NAIVE #7 — found
independently by both.

**7. Add the trailing-`$` template variants so the pack library round-trips.** — MEDIUM (M)
Corpus audit: only 1,187/1,647 (72%) shipped patterns reopen in builder mode. The failure is
concentrated and cheap: 224 wear-off patterns differ from W5's build output only by a trailing
`$`, and ~208 anchored literals miss W16 for the same reason (W4 already has a `$` variant, which
is why 1,134 generated triggers recognize). Add the variants, then widen the spec §8 acceptance
criterion from "the 10 default.json triggers" to "every pattern in triggers/curated +
triggers/generated" as a golden-corpus test. Matters via share-string/pack imports today, and
becomes critical once #6 ships. Evidence: EXPERT #1 (reproducible audit script).

**8. Add a W17 "Someone says <text> in <channel>" template.** — MEDIUM (M)
The most common trigger genre in GINA culture — raid callouts in group/guild/say/ooc — has no
template; the naive user fell back to W16 and hit the line-start trap, and W16-anywhere false-fires
on combat spam (keyword "root" matches `'s feet adhere…`). Builds `tells the group, '…'` etc. with
sender as capture 1; fits the existing param-morph machinery. Prerequisite: verify Legends channel
line formats from a real log (only tell formats are in the LEGENDS-VERIFIED research section).
Evidence: EXPERT #2, NAIVE #6.

**9. Smarter quick-create defaults from the Live tab.** — MEDIUM (M)
`W16.fromLine` hardcodes `anyNumbers:false` and prefills Speak with the entire raw combat line, so
the 2-click path yields a trigger that fires only on *exactly 48 damage* and TTS-reads a 60-char
sentence — while the test box shows green against the seeding line, giving false confidence.
Pre-enable `anyNumbers` when the message contains digits, pre-enable name generalization for a
leading capitalized non-You name, and default Speak to the suggested short name (the
pre-redesign QuickTriggerModal had this intelligence; GINA tokenizes digits automatically).
Evidence: EXPERT #3; compounds NAIVE #1.

**10. Scroll the editor into view (and focus Name) on Edit/open.** — QUICK WIN (S)
Clicking Edit on a row deep in the tree opens the editor at −2,568px with zero visible change —
Edit looks broken. Same fix location as focus management: after mount, `scrollIntoView` the
`.card.editor` and focus the Name field. Evidence: INTERACTION #3 (measured live).

**11. Focus management in the quick modal: autofocus + focus trap.** — MEDIUM (M)
Modal opens with focus on BODY; 92 tab stops of fully-operable background UI precede the modal's
first control despite `aria-modal="true"` (worse than no aria-modal for screen readers). Card
editor has the milder form (8 stops from Add trigger to Name). Evidence: INTERACTION #5.

### Tier 3 — confidence, feedback, and spam prevention

**12. Reveal the saved trigger: expand + scroll + highlight, or name its location in the toast.** — QUICK WIN (S)
After Save the tree shows its top and the new trigger lands invisibly under a collapsed group
(e.g. Custom › Combat › Enemy Casts), findable only via search — from both the card and modal
paths. "Saved to Custom › Combat › Enemy Casts" in the toast is the cheap version. Evidence:
NAIVE #8.

**13. Save-time duplicate-pattern hint.** — QUICK WIN (S) for exact-match, MEDIUM for containment
The Add-trigger default state itself (W1 tell pattern) duplicates the enabled curated "Tell
received" — two clicks to double TTS on every tell — and the naive run unknowingly built a third
Complete Heal trigger alongside two enabled shipped ones. Non-blocking hint on save when the built
pattern equals an enabled trigger's: "'Universal/Social/Tell received' already fires on this" with
a jump link (Gmail's "X conversations match" model). Evidence: EXPERT #5, NAIVE #10 — found
independently.

**14. Echo duration units in words.** — QUICK WIN (S)
Typing "10" for a ten-minute timer yields "= 0:10" in small grey text — a plausible 10-second Camp
timer. "= 10 seconds" (and accepting "10m", which already parses) closes the trap. Evidence:
NAIVE #5; INTERACTION confirms the parser is generous, only the echo is weak.

**15. Show regex compile errors in the Advanced section itself.** — QUICK WIN (S)
With the test box collapsed (the Triggers-tab default), an unterminated group in Custom-pattern
mode shows no indicator anywhere until Save — which then fails with the off-screen banner (#2).
The existing err-state row just needs to also render under the Advanced field, or the test section
should auto-expand on compile failure. Evidence: INTERACTION #6.

**16. Auto-expand the test box on first meaningful input, and seed a canonical example line per template.** — MEDIUM (M)
The test box is the editor's best teaching feature — it caught two would-be-broken triggers in the
naive run alone — but the from-scratch flow collapses it, punishing exactly the users with no
example line in hand (quick-create opens it prefilled; the asymmetry is backwards). A static
`exampleLine` per template also makes the collapsed state a one-click "show me". Evidence:
EXPERT #7, NAIVE #6b.

**17. Detect regex-looking paste in W16 and offer to switch to Custom pattern.** — QUICK WIN (S)
Pasting `^{S1} begins to cast {S2}` into "A line contains specific text" double-escapes it into a
dead literal, with only subtle clues. GINA migrants are an explicit target audience; detect
leading `^`, `{S}`/`{N}`/`{C}` tokens, trailing `$` and hint. Evidence: INTERACTION #8.

**18. Prefill purpose-built sounds in matching templates.** — QUICK WIN (S)
The manifest ships "Tell — soft single glass ding" yet W1 prefills Speak only; the classic
ding-on-tell costs 4 extra interactions. W4's timer prefill proves per-template action
intelligence works — extend to W1 → Tell sound, W7 → Death sound (users delete unwanted rows).
Evidence: EXPERT #6.

**19. Give sound Preview real feedback (playing state, failure hint) and validate paths at save.** — MEDIUM (M)
Preview swallows all errors (`api.ts:205-218`), so a broken/missing custom sound file — the shared-
trigger case — is indistinguishable from success. Evidence: INTERACTION #7.

**20. Per-trigger refire cooldown ("at most every N s").** — STRUCTURAL (L)
No throttle exists anywhere; a quick-created combat-line trigger can machine-gun TTS several times
per second in a raid, and the only recourse is global Silence or deletion. GINA and EQLogParser
both ship lockout windows. Engine already tracks per-timer identity; a `cooldown_secs` default-0
select fits the sentence layout. Do before launch week — alert spam is the failure mode reviewers
screenshot. Evidence: EXPERT #8, amplified by #9.

**Cut as nitpicks** (real, but don't change user success): Enter/Ctrl+Enter/Escape keyboard
shortcuts in the card editor (keyboard-only authoring already works via tabbing); 38 form fields
lacking `id`/`name`; the dead `addRow('sound')` default-selection code path; raw `${1}` tokens in
prefilled Speak text (see contradiction ruling B — presentation tweak folded into #9/#18 territory,
not a standalone item).

## Where reviewers disagreed — rulings

**A. Curated-trigger edit gap: minor (NAIVE) vs. major (EXPERT).**
Ruling: **major**, ranked #6. The naive user scored it by single-task friction; the expert's frame
is right — it locks the editor out of 99.4% of the app's content and neutralizes the round-trip
investment. The fix is also the cheapest major on the list.

**B. Prefilled defaults: "teaches by example, genuinely good" (EXPERT notes) vs. "raw `${1}`/`${2}`
jargon is the first thing a new user reads" (NAIVE #9) vs. "the default state is itself a 2-click
duplicate spam trigger" (EXPERT #5).**
Ruling: **keep the prefill** — the evidence that it enables 2-click success is stronger than the
evidence it confuses (the naive user completed every task, and the test box's "Will say" rendering
resolved the tokens). Fix the two real defects around it: the duplicate hint (#13) and, cheaply,
an inline `${1} = sender's name` hint or chip-rendered token in the prefill. No standalone item.

**C. W16 default match position: NAIVE wants "Anywhere" as default for hand-typed text (their
"camp check" trigger was dead until they changed it) vs. EXPERT's warning that anywhere-matching
keywords false-fire on combat spam.**
Ruling: **both are right about different entry points.** Keep "start of line" when W16 is seeded
from a real log line (the line proves the anchor); default to "Anywhere" only for hand-typed
fragments, and treat the real cure as the W17 chat template (#8) plus test-box auto-expand (#16) —
anchoring debates disappear when the user can see the match result.

**D. Test-box collapsed default: spec-compliant (INTERACTION confirms) vs. "hides the editor's best
feature" (EXPERT).**
Ruling: the spec is what's wrong, not the implementation. The naive run is decisive — the test box
caught two broken triggers, but only because that user voluntarily opened it. Auto-expand on first
meaningful input (#16) and update the spec.

**No stream contradicted another on facts** — every overlapping finding (off-screen banner, curated
lockout, duplicate coverage, W16 toggles) was independently confirmed, which raises confidence in
the whole set. One spec-vs-code note from the expert stream worth recording: CancelTimer is fully
wired and legitimately shipped; spec §9's Phase-2 flag is stale and should be updated.
