# Timers — design & implementation plan

Status: IMPLEMENTED (0.3.0 candidate). Supersedes the "Camps" respawn feature.
P1–P3 built and verified in WSL (cargo test --workspace, tsc, vite build, and
a browser mock-mode run of both the Timers tab and the unified overlay). The
Windows Tauri build is done by the maintainer. P4 (killer-less `X died.` kills,
variance windows, skip-spawn) remains optional/future.

This turns the existing camp-respawn feature into a first-class **Timers**
surface: a sidebar tab, a renamed unified overlay, kill-detected rare respawn
timers that self-correct via the game's own `- a rare creature -` consider
tag, one-tap manual tracking for placeholder cycles, and user-created custom
timers (get-off-at-X, egg timers, ability cooldowns).

Nothing in this feature writes to `drops.sqlite` — the DB stays pure
read-only reference data (it is wholesale-replaced on every data update, so
anything written into it would be wiped). **All user/session state lives in
localStorage**, alongside the existing camp store, so the overlay picks it up
through the same `storage`-event sync it already uses.

---

## 1. Why this exists (the bug that started it)

"A ghoul sentinel" is a rare in Lower Guk, but the app never starts a camp
timer for it. Root cause: the timer gate (`FightsTab.startCampTimer`) requires
the mob DB's `named` flag, which is computed at data-build time
(`tools/dropdata/build_drops_db.py::is_named_mob`) purely from the classic EQ
naming convention — lowercase article = trash, proper name = rare. Legends
breaks that heuristic: it has lowercase-article rares like `a ghoul sentinel`
(`named = 0` in the DB), so they're filtered out.

But the game tells us directly. Since the June 2017 EQ update (and in Legends),
the consider line tags rares:

```
A ghoul sentinel - a rare creature - scowls at you, ready to attack -- ... (Lvl: 42)
```

Today that line is **swallowed** by the parser's spam filter — `is_system()`
returns true for anything containing `(Lvl: ` (parser.rs ~913). So the one
authoritative rare signal never reaches the app. Fixing that is the backbone
of this feature: parse the consider line, learn which mobs are rare, and let
that override the DB's naming-convention guess.

---

## 2. Research digest (what other EQ tools do)

Sourced from a deep-research pass over GINA, EQLogParser, QuarmTool, EqTool,
pq-companion, Zeal, GamTextTriggers, and P99/TAKP wikis. Design-relevant
findings:

**Kill detection is multi-form and lossy.**
- Tools start respawn timers from `slain` log lines and can *only* time a kill
  they actually witnessed in the log ("if you were too far away to see the
  'slain' message, there's no way to know the npc is dead" — QuarmTool).
- Robust tools match several forms: your own kill (`You have slain X!`), a
  groupmate's (`Bob has slain a gnoll!`), the passive form
  (`a gnoll has been slain by Bob!`), and the **killer-less** `a gnoll died.`
  form — without the last, DoT/swarm kills never emit a kill event
  (pq-companion). EqTool falls back to exp/faction messages when `slain` is
  missed.

**Respawn timing = base + optional variance window, not one fixed number.**
- Dungeon zones have a default zone-wide respawn: Lower Guk **28:00**,
  Nagafen's Lair 22:00, Old Sebilis 27:00, Karnor's 27:00. Classic outdoor
  zones overwhelmingly use **6:40 (400s)**. Legends Lower Guk is also 28:00.
- Individual mobs deviate from the zone default, so a tool can't rely on one
  number per zone — use per-mob data (which we already have in
  `npc_zones.respawn_secs`).
- Raid targets are expressed as base ± variance (Lord Nagafen 3d ±12h; Cazel
  7.5h ±2.75h). Model long timers as an **earliest→latest window**, not a
  single instant. Skip-spawn (window roughly doubles per missed repop) exists
  but is out of scope for v1.

**Placeholder cycles are handled manually, everywhere.** No log-only tool
auto-attributes a PH kill to a rare's spawn point (logs can't disambiguate
which of five identically-named mobs died at which spot). GamTextTriggers,
EQTool, and QuarmTool all rely on **user-supplied durations / manual timers**
for PH tracking. Our "recent kills → tap to track" design is exactly this
pattern — it makes the player the attribution step, which is the only reliable
option.

**Custom-timer UX conventions.**
- GINA: timers are attached to triggers (`Use Timer`), fixed H:M:S duration,
  labels interpolate tokens (`{C}` = character, regex `${1}`/`${name}` =
  captures), and a **retrigger policy** (restart the single instance / spawn a
  new instance per target / leave it running).
- EQLogParser: four timer types — **stopwatch (counts up)**, short,
  **countdown**, **repeating (auto-restarts)**; can set duration from a
  captured timestamp; **end-early** patterns cancel a running timer when a
  later line matches; a "warn with time remaining" threshold fires an early
  heads-up.
- Zeal / QuarmTool / EqTool: quick-add from a compact syntax
  (`StartTimer-30`, `Timer Start <name> <minutes>`, or caret-delimited
  `action^name^regex^secs^color`).

**Overlay UX conventions.**
- Sort by absolute expiry (WeakAuras sorts on `expirationTime`), current-zone
  first then most-imminent.
- Color-state by fraction remaining: e.g. calm >50%, warning ~20%, urgent
  <20%, then a green **"POP/UP"** state held for a ~60s grace window before the
  row auto-prunes. Threshold color-switch below N seconds is the standard
  warning cue.
- Long durations formatted compactly (`Hh Mm`, `Nd Nh`); per-row manual
  dismiss.

---

## 3. Feature scope

1. **Rename Camps → Timers** across the app: new **Timers** tab in the Log nav
   group, and the existing camp/respawn overlay becomes the unified **Timer
   overlay** showing *all* timer kinds (rares + custom) together.
2. **Consider-line rare detection** (parser): learn rares from
   `- a rare creature -` and override the DB's `named` guess. Fixes the ghoul
   sentinel and every mob like it, permanently and self-correcting.
3. **Zone-aware rare list**: on `ZoneEnter`, load the current zone's known
   rares (from `refdb_zone_info`) so the tab shows what's campable here and
   their respawn times, before anything is killed.
4. **Auto respawn timers on rare kills**: killing a known rare (DB `named` OR
   learned-rare) starts/resets its countdown, labeled and zoned.
5. **Recent-kills strip → one-tap track**: last N kills, each with an "add"
   button that arms a timer using that mob's own respawn time — the manual PH
   solution.
6. **Custom/personal timers**: user-created countdowns (get-off-at-HH:MM, egg
   timers, ability cooldowns) with quick-add, optional repeat, optional TTS at
   pop.
7. **Unified overlay**: rares + custom in one list, sorted by imminence with
   the color-state + POP-grace UX above; current-zone rares prioritized.

---

## 4. Data model (localStorage — nothing touches sqlite)

Evolve `app/src/lib/campTimers.ts` into `app/src/lib/timers.ts` with a single
unified model. Keep a one-time migration that reads the old
`eqlogs.campTimers.v1` array and imports it as `kind: "respawn"` timers.

```ts
export type TimerKind = "respawn" | "custom";

export interface Timer {
  id: string;               // stable id (uuid-ish; generate without Date.now in shared code)
  kind: TimerKind;
  label: string;            // mob name or user label
  zoneShort: string | null; // respawn timers carry their zone; custom = null (global)
  zoneLong: string | null;
  startedAt: number;        // wall-clock ms the countdown anchors to
  durationSecs: number;     // base countdown length
  varianceSecs: number;     // ± window (raid mobs); 0 = fixed (default for dungeon rares)
  repeat: boolean;          // custom repeating timer re-arms itself on pop
  ttsOnPop: boolean;        // speak at pop? respawn default false (visual only), custom user-choice
  announced: boolean;       // pop already announced (persisted so reload never repeats)
  source: "auto" | "manual";// auto = kill-detected rare; manual = tracked kill / custom
}

export const TIMERS_KEY = "eqlogs.timers.v1";
export const TIMER_CAP = 30;

// Learned rares: mob names seen conned as "a rare creature" (lowercased).
export const LEARNED_RARES_KEY = "eqlogs.learnedRares.v1"; // string[] (Set on load)

// Keep the existing toggle key for back-compat.
export const CAMP_RARES_ONLY_KEY = "eqlogs.camp.raresOnly";
```

Derived view (evolve `activeCampTimers`): compute `dueAt`, `remainingSecs`,
`progress`, and for variance timers a `windowEndsAt = dueAt + varianceSecs*1000`
so the overlay can render an earliest→latest band. Keep the ~30s grace after
`dueAt` (or after `windowEndsAt` when variance is set) before pruning.

`isRare(name)` = DB `named === 1` **OR** the learned-rares set contains
`name.toLowerCase()`. This is the single gate that replaces the current
`info.named !== 1` check.

---

## 5. Parser change (eqlog-core — WSL-testable, the one Rust edit that matters)

Add a typed consider event and intercept it **before** `is_system()` swallows
it.

In `crates/eqlog-core/src/events.rs`:

```rust
/// `X - a rare creature - scowls at you, ready to attack -- ... (Lvl: 42)`
/// and the non-rare form without the tag. `rare` drives rare-learning.
Consider { target: String, rare: bool, level: Option<u32> },
```

In `crates/eqlog-core/src/parser.rs::classify`, add a match arm **above** the
`if self.is_system(m) { return Event::System; }` line (~575). Gate cheaply on
`m.contains("(Lvl: ")` and one of the con verbs (`scowls`, `glares`, `regards`,
`considers`, `judges`, `looks`, `kindly`, `ready to attack`). Remember: the
`regex` crate has **no lookarounds** — parse by splitting on `" - "` /
`" -- "` and scanning for the literal `a rare creature`, don't use `(?=`.

- `target` = the leading name, with a leading `A `/`An `/`The ` (sentence-start
  capitalization) normalized to lowercase so it matches DB/slain names
  (`a ghoul sentinel`). Player-shaped single-capitalized-word targets should
  still parse but won't match a mob later — that's fine.
- `rare` = the message contains `- a rare creature -`.
- `level` = parse the `(Lvl: N)` integer if present.

Add a unit test in the parser test module with the real line:
`A ghoul sentinel - a rare creature - scowls at you, ready to attack -- it appears to be quite formidable. (Lvl: 42)`
→ `Consider { target: "a ghoul sentinel", rare: true, level: Some(42) }`.
Keep `cargo test --workspace` green.

**Do not** rename or remove any existing `is_system` behavior — only add the
earlier interception. This is additive; con lines the app doesn't care about
still fall through to `Event::System`.

---

## 6. Frontend changes (app/src — React + TS)

### 6a. `lib/timers.ts` (evolve campTimers.ts)
Model above + `load/save`, `activeTimers(now)`, `isRare`, learned-rares
load/save/add, and the v1→unified migration. Keep the pure helpers free of
`Date.now()` where the file is imported by overlay windows (pass `now` in, as
`activeCampTimers` already does).

### 6b. Event wiring
The parsed feed reaches every mounted component as the `log-line` Tauri event
(`useTauriEvent<LogLinePayload>("log-line", ...)`) and tabs stay CSS-hidden but
mounted — so **TimersTab subscribes independently**, exactly like FightsTab
does today. Handle three events:

- `Consider`: if `rare`, add `target` to learned-rares (persist). Cheap, deduped.
- `ZoneEnter`: resolve long→short (the `zones` table has both columns; add a
  tiny `refdb_zone_for_long(long)` command or a `zonesList()` lookup) and load
  that zone's rares via `refdbZoneInfo(short)` into the tab's "this zone"
  section.
- `Slain` (victim = `Named`, not "You", not a player-shaped groupmate name, not
  during catch-up — reuse FightsTab's existing guards): push onto the
  recent-kills strip; if `isRare(victim)`, auto-start/reset its respawn timer
  using `refdbRespawnFor(victim)`.

To avoid double-counting, **move the camp-timer + kill-tally logic out of
FightsTab into TimersTab** (or a shared `useTimers()` hook) and have FightsTab
render a read-only summary if it still needs one. Don't leave both writing the
timer store.

### 6c. `components/TimersTab.tsx` (new)
Sections, top to bottom:
1. **Active timers** — live countdowns (respawn + custom interleaved), soonest
   first, current-zone rares prioritized; per-row dismiss; variance timers show
   a window. Same visual language as the overlay.
2. **This zone's rares** — from `refdbZoneInfo`; each row shows respawn time and
   an "arm" button (start the timer manually even without a kill, for when you
   arrive mid-camp). Learned-but-not-in-DB rares surface here too.
3. **Recent kills** — last ~10 `Slain` victims, each with a **Track** button
   that arms a timer from that mob's respawn time. This is the placeholder
   workflow: kill whatever popped, tap Track.
   - **Decision — Track/Arm use that mob's own `npc_zones.respawn_secs`** (the
     per-mob DB value), not the zone-wide default. If a mob's value is missing
     the row still lists it, but Track is disabled with a "no respawn data"
     note rather than guessing. (A later phase may add a zone-default fallback
     and an editable duration — see P4 — but v1 ships with per-mob DB time
     only.)
4. **Custom timer** — quick-add row. Support: a duration (`mm:ss`, `h:mm:ss`,
   or bare seconds), an optional label, a **repeat** toggle, and a
   **get-off-at** mode that takes a wall-clock `HH:MM` and computes the
   duration. Persist as `kind:"custom"`.
   - **Decision — custom timers speak at pop by DEFAULT** (`ttsOnPop: true`),
     plus the overlay flash; the toggle lets the user silence a specific one.
     Rationale: a custom timer is *user-created and intentional* ("get off at
     11:30" needs to actually get your attention), so it's outside the
     log-driven alert-fatigue budget — the user opts in by creating it.
     Respawn pops stay **visual-only** (see §7).

Follow `DESIGN.md` tokens (dark-first dev-tool aesthetic, no fantasy theming).

### 6d. Overlay: `overlay/OverlayRespawn.tsx` → unified Timer overlay
Rename the surface to **Timers** (keep the window/overlay id stable if renaming
it risks orphaning saved overlay positions — check `OVERLAY_RESPAWN` /
`OVERLAY_LABELS` usage before changing the id string; prefer keeping the id and
only changing the visible label). Read the unified store, render respawn +
custom rows together, sort by imminence with current-zone first. Color-state:
calm >50% remaining, warning <~33%, urgent <~15%, green **UP/POP** held ~60s
grace then pruned. Variance timers render an earliest→latest band. Keep the
existing `storage`-event sync and 1s tick.

### 6e. Dashboard nav
Add `{ id: "timers", label: "Timers", icon: <IconTimers or reuse> }` to the
**Log** group in `components/Dashboard.tsx`, a `TimersTab` page section (CSS
-hidden like the others), and the `TabId` union + `TAB_IDS`. Pick/point an
icon (a clock/stopwatch) in `overlay/Icons.tsx`.

### 6f. Settings
The Overlays sub-tab already has the rares-only toggle
(`SettingsTab.tsx` ~988). Keep it (label it "Only auto-track rare spawns").
Add, if desired, a default "speak custom timers at pop" preference.

---

## 7. Alert-fatigue budget (project convention)

Respawn pops are **visual-only** by default (the existing `announceCampRespawn`
sends to the alerts overlay, never TTS) — keep that. Only custom timers may
speak at pop, and only when the user opts in per-timer. Any change to
default-on **spoken** triggers must be spam-audited per CLAUDE.md:

```
cargo run -p eqlog-cli -- triggers fixtures/local/eqlog_full.txt \
  --char Nyasha --classes Enchanter,Cleric,Wizard --level 16
```

This feature should not change spoken alerts/hour (it adds visual timers, not
speech). Confirm the audit is unchanged and cite it if any spoken default moves.

---

## 8. Phased delivery

- **P1 — Rare detection (fixes the bug, small, WSL-testable).** Parser
  `Consider` event + unit test; learned-rares store; swap the `startCampTimer`
  gate to `isRare()`. Ship-able on its own: ghoul sentinel now gets a timer.
- **P2 — Timers tab + rename.** New `lib/timers.ts` (unified model +
  migration), `TimersTab` (active / this-zone / recent-kills / custom), nav
  entry, move kill/timer logic out of FightsTab.
- **P3 — Unified overlay.** Repurpose the respawn overlay to render both kinds
  with the color-state + POP-grace UX; zone-aware sort.
- **P4 (optional) — robustness & polish.** Killer-less `X died.` kill form for
  DoT/swarm; variance windows for raid targets; skip-spawn note; get-off-at
  wall-clock mode; repeat timers.

## 9. Hard constraints to respect (from CLAUDE.md)

- `app/src-tauri` does **not** compile in WSL — write the (minimal) Tauri/Rust
  glue carefully; the four workspace crates build & test in WSL and
  `cargo test --workspace` must stay green.
- Frontend typecheck runs from `app/`: `cd app && npx tsc --noEmit`.
- `regex` crate has **no lookarounds** — parse the con line by splitting.
- Never write to `drops.sqlite`; never name a shipped dir `data/` next to the
  exe; all user state in localStorage.
- Trigger/overlay ids are stable API — don't rename `OVERLAY_RESPAWN`'s id
  string if it would orphan saved positions; change labels, not ids.

---

## 10. Handoff prompt (paste into a fresh session / another model)

> You are implementing the **Timers** feature in the Legends Companion repo
> (Tauri v2, Rust workspace + React/TS app). Read `CLAUDE.md`,
> `docs/timers-design.md` (this file — the full spec), and `DESIGN.md` before
> writing code. Implement **Phase 1 first**, verify, then continue to P2/P3.
>
> Context you must honor: `app/src-tauri` does NOT build in WSL (Windows-only);
> the four workspace crates DO — keep `cargo test --workspace` green and run
> the frontend typecheck from `app/` (`cd app && npx tsc --noEmit`). The Rust
> `regex` crate has no lookarounds. Never write to `assets/data/drops.sqlite`
> or any bundled sqlite — all user state goes in localStorage. Don't rename
> stable ids (trigger ids, `OVERLAY_RESPAWN` overlay id) — change labels, not
> ids.
>
> **The bug:** rares like `a ghoul sentinel` (Lower Guk) get no camp timer
> because the gate in `app/src/components/FightsTab.tsx` (`startCampTimer`,
> ~L266) requires the mob DB's `named` flag, which
> `tools/dropdata/build_drops_db.py::is_named_mob` computes from the classic
> naming convention (lowercase-article = trash). Legends has lowercase-article
> rares. The game marks them in the consider line —
> `A ghoul sentinel - a rare creature - scowls at you, ready to attack ... (Lvl: 42)`
> — but the parser currently swallows all `(Lvl: ` lines as system spam
> (`crates/eqlog-core/src/parser.rs::is_system`, ~L913).
>
> **Phase 1 (do this first, it's shippable alone):**
> 1. Add `Event::Consider { target: String, rare: bool, level: Option<u32> }`
>    to `crates/eqlog-core/src/events.rs`.
> 2. In `parser.rs::classify`, add a match arm ABOVE the
>    `if self.is_system(m)` line (~L575). Gate on `m.contains("(Lvl: ")` plus a
>    con verb; parse by splitting on `" - "` / `" -- "` (NO lookarounds);
>    normalize a sentence-start `A `/`An `/`The ` on the name to lowercase so
>    it matches DB/slain names; set `rare` when the line contains
>    `a rare creature`; parse `(Lvl: N)`. Add a unit test with the real ghoul
>    sentinel line. Keep `cargo test --workspace` green.
> 3. Frontend: add a learned-rares localStorage store
>    (`eqlogs.learnedRares.v1`, a lowercased-name Set). On the `Consider`
>    event (via the existing `log-line` Tauri event), if `rare`, add the name.
> 4. Replace the `info.named !== 1` gate in `startCampTimer` with
>    `isRare(name)` = DB `named === 1` OR learned-rares has the lowercased name.
>    Verify the ghoul sentinel now starts a timer.
>
> **Phases 2–3 (per the spec above):** evolve `lib/campTimers.ts` into a
> unified `lib/timers.ts` (`Timer` model with `kind: "respawn" | "custom"`,
> variance, repeat, ttsOnPop; migrate the old `eqlogs.campTimers.v1` array);
> build `components/TimersTab.tsx` (Active / This-zone rares / Recent kills →
> one-tap Track / Custom quick-add) and add it to the **Log** nav group in
> `Dashboard.tsx`; repurpose `overlay/OverlayRespawn.tsx` into the unified
> **Timer overlay** (respawn + custom rows, sorted by imminence, current-zone
> first, color-state calm/warning/urgent → green UP with ~60s grace, variance
> band). Move the kill/timer/tally logic out of FightsTab so only one place
> writes the timer store. Wire `ZoneEnter` (long→short via the `zones` table)
> to load the current zone's rares from `refdbZoneInfo`.
>
> **Conventions:** respawn pops stay VISUAL-ONLY (never TTS) — only opt-in
> custom timers speak. Follow `DESIGN.md` tokens. This feature must not change
> spoken alerts/hour; if any spoken default moves, run and cite the trigger
> spam audit from `CLAUDE.md`. Placeholder cycles are handled by the manual
> Track button (logs can't attribute a PH kill to a rare's spawn point — this
> is the industry-standard approach, don't try to auto-solve it).
>
> Work in small, verifiable steps: after P1, run `cargo test --workspace` and
> `cd app && npx tsc --noEmit`; the Windows-only Tauri build is done by the
> maintainer, so write any `src-tauri` glue carefully and flag it for a Windows
> build.
