# Legends Companion — Product Review & Ranked Roadmap

*Synthesized 2026-07-03 from three completed research streams: competitor gap analysis (38 findings across EQLogParser, BasaBots EQL, GINA, PQ Companion, cactbot/WeakAuras/Details!/arcdps ecosystems), community demand mining (~28 findings from official EQ forums, RedGuides, P99, EQLP GitHub issues), and a hands-on read-only self-audit (code + CLI replay + 12 fresh screenshots, commit 627cc54). Launch deadline: EverQuest Legends full launch **July 28, 2026** — 25 days out.*

---

## 1. Executive Summary

**Where the app genuinely leads the field:**

- **The trigger content moat is real and unmatched.** 1,647 spell-DB-generated triggers in 50 packs (verified on disk) vs BasaBots' advertised 1,300+, and EQLogParser has *zero* Legends-specific packs — players are hand-porting EQLP via YouTube tutorials right now (Community: EQLP-install tutorial finding). No incumbent can regenerate level-scaled buff durations and threat-categorized enemy casts from the game's own spell DB quickly.
- **Spam discipline is a measurable differentiator nobody else has.** 10.3 spoken alerts/hr verified on a real 84k-line log; raiders today hand-engineer null-sound hacks to fight alert fatigue (Community: alert-fatigue finding). No competitor measures this at all.
- **Onboarding UX beats the incumbent's #1 complaint.** Trigger setup complexity is the top EQLP onboarding complaint (EQLP GitHub #71, #238); the plain-English template editor with spell autocomplete and test-against-a-line directly answers it. The prior UX audit's fixes all verifiably landed (Audit: trigger-flow finding).
- **Positioning is clean and marketable:** log-only/zero ban risk vs BasaBots' memory reading and cheat-forum provenance; ~10MB Tauri + MIT vs EQ Nag's ridiculed 8GB Electron install and opaque repo; a possible Linux build for the P99-style crowd nobody serves.
- **Engine performance is a solved problem:** ~1M lines/s parse, ~340k lines/s full-library trigger replay, 100% classification on the fixture. Publish these numbers — latency skepticism is a documented adoption objection (Community: latency finding).
- **Pet handling already exceeds EQLP** (open issues #234, #179 there; possessive auto-detect + /pet leader learning here). Market it explicitly.

**Weaknesses that matter, honestly:**

1. **It has never shipped and cannot update itself.** No published installer, no auto-updater (Audit). For a game patching weekly through launch month, this is the single largest existential risk: a launch-day log-format tweak silently degrades every install with no fix path.
2. **First-run is a dead end for anyone who isn't the developer.** Hardcoded `eqlog_Nyasha_oggok.txt` default, no log auto-discovery, no `/log on` guidance, no filename→character derivation (Audit blockers 1–2).
3. **The meters story over-promises.** No fight history at all — completed fights are *actively discarded* (`meters.rs:64` drains and keeps one); healers/tanks invisible despite the tracker collecting the data; raid DPS is biased toward the log owner because fights only open on your involvement. "Post the parse" is EQ culture; a biased or amnesiac meter is worse than none.
4. **Zero error observability.** eprintln-only warnings in a windowed app, silent tail-session death, silent config/profile resets, no app log file. At launch scale this is the #1 support-burden generator (Audit).
5. **No sharing ecosystem.** The decisive lesson from WeakAuras/wago.io, GINA/GimaLink, and EQLP Quick Share: whoever owns trigger distribution owns the community. GINA is dying, EQLP has no Legends content, BasaBots is closed and paid — the seat is empty for ~4 more weeks.

**Bottom line:** the alerting core is launch-grade and differentiated; the wrapper around it (distribution, onboarding, observability, sharing) is not yet a public product. The next 25 days should be spent almost entirely on the wrapper, not on new analysis features.

---

## 2. Scorecard vs Competitors

Legend: ●● strong / ● present / ◐ partial / ○ absent / ✕ structurally can't (or won't)

| Capability area | **Legends Companion** | EQLogParser (free ceiling) | BasaBots EQL ($3/mo, memory-reading) | GINA (legacy, dying) | WeakAuras-class ceiling (WoW/FFXIV) |
|---|---|---|---|---|---|
| Trigger library for *Legends* | ●● 1,647, spell-DB-generated | ○ none | ● 1,300+ | ○ | n/a |
| Trigger editor UX (non-regex) | ●● plain-English templates | ◐ regex-first (#71 complaint) | ◐ | ◐ | ◐ (aura wizardry) |
| Trigger sharing / import strings | ◐ .gtp import only | ●● Quick Share codes + GitHub | ◐ bundled | ●● GimaLink + .gtp | ●● wago.io, 10k+ entries |
| Community pack repo / subscribe | ○ | ◐ GitHub Discussions | ◐ built-in | ● curated library | ●● Triggernometry remote repos |
| Raid-leader trigger push | ○ | ◐ | ○ | ● (most-praised Nag/GINA feature) | ●● |
| Alert spam discipline | ●● audited 10.3/hr | ○ | ○ | ○ | ◐ |
| DPS meter + overlay | ● top-5 live | ●● | ● | ○ | ●● Details! |
| Fight history / trends | ○ discarded in memory | ●● SQLite-class archive | ● ~100 parses + averages | ○ | ●● |
| Healing / tanking parse | ○ (data collected, hidden) | ●● | ● toggle | ○ | ●● |
| Per-ability drill-down | ○ | ●● | ● | ○ | ●● click-any-bar |
| Death recap / replay | ○ | ● | ○ | ○ | ●● Details! death log, oopsy |
| Paste-parse-to-chat | ○ | ●● | ◐ | ○ | ● |
| Multi-character monitoring | ○ single tail | ◐ (worse than GINA) | ○ | ●● unlimited + per-toon voice | n/a |
| Pet attribution | ●● | ◐ (open bugs #234/#179) | ◐ | ◐ | ● |
| Boss timelines / encounter modules | ○ | ○ | ○ | ○ | ●● cactbot/BigWigs (the crown jewel) |
| Respawn/camp timers from kills | ○ | ◐ | ◐ | ◐ hand-built packs | n/a |
| Quest / item / mob database | ◐ spell DB internal only | ○ | ●● flagship | ○ | ◐ |
| Live spawn map | ✕ (log-only stance) | ✕ | ●● (memory reading) | ✕ | ✕ |
| Loot / roll tracking | ◐ parsed, dropped | ●● | ● | ○ | ● |
| Chat search / who DB | ○ | ●● | ○ | ○ | n/a |
| Log hygiene (rotate/archive) | ○ | ● | ○ | ○ | n/a |
| Discord / OBS / streamer | ○ | ● webhooks + Streamer Mode | ○ | ○ | ●● OverlayPlugin WS |
| Auto-update | ○ **(never shipped)** | ● | ● | ✕ (cert died — killed the product) | ●● |
| Footprint / trust | ●● ~10MB Tauri, MIT | ◐ heavier .NET | ○ closed, memory, $ | ○ dead cert | ● |
| Ban-risk posture | ●● log-only | ●● | ○ admits memory reads | ●● | n/a |

**Reading:** Legends Companion already wins content + editor + trust; it loses today on *everything that happens after a fight ends* (history, breakdowns, sharing, export) and on *product plumbing* (shipping, updating, observability, first-run). GINA's death-by-expired-certificate is the cautionary tale for the plumbing column.

---

## 3. Ranked Roadmap

Impact key: which segment it moves (solo / group / raid / all). Effort: S (<1 day), M (2–5 days), L (1–3 weeks).

### NOW — pre-launch window (must land before July 28)

Theme: *ship, survive patch day, don't embarrass yourself on first run, plant the ecosystem flag.* Total ≈ 13–18 dev-days; feasible in 25.

**N1. Ship v0.1.0 through the release pipeline + Tauri updater — Impact: all. Effort: M.**
What: run the existing `release.yml` end-to-end now, publish a real installer, add `tauri-plugin-updater` (first-party) or minimally an update-available check against GitHub releases.
Evidence: Audit ("launch-week trap": no updater, pipeline never exercised); GINA literally died of an un-updatable cert (Community); PQ Companion/PlenBot/BasaBots all auto-update (Competitor). The game will patch log grammar during launch month — without this, every other item on this list is unreachable post-install.
Verdict: **NOW — item #1, non-negotiable.**

**N2. First-run onboarding: log auto-discovery + `/log on` guidance — Impact: all (every single new user). Effort: S–M.**
What: scan the Logs folder for `eqlog_*.txt`, default to most-recently-modified, derive character/server from filename, replace the hardcoded Nyasha default; empty-state and "file hasn't grown in N seconds" hint that says `/log on`.
Evidence: Audit blockers 1–2 (dev's own character prefilled; classic clients ship with logging OFF; user sees "Waiting for log lines" forever). This is the difference between a 5-star and a "doesn't work" first review.
Verdict: **NOW.**

**N3. Error observability bundle: app.log + UI warning surface + session-death event + atomic writes + no-silent-resets — Impact: all (and your own support load). Effort: M.**
What: rotating `app.log`; Triggers-tab badge/banner for pack-load and regex-compile warnings (today eprintln-only, invisible on Windows); emit `session-ended` so the green "Tailing" dot can't lie; temp-file+rename for config/triggers/profiles; make corrupt-profile load hard-error like triggers already do.
Evidence: Audit findings 7–10 (all verified in code). Five small fixes, one theme: at launch scale, silence is the enemy.
Verdict: **NOW.**

**N4. Fix the Windows rotation false-positive race — Impact: all raiders. Effort: S.**
What: stop treating a size mismatch between two non-atomic stats as rotation (`tail.rs:217-225`); compare creation time / file index instead.
Evidence: Audit — spurious full-log replay = TTS flood over hours of history + double-counted meters, mid-raid. Checked ~5x/sec for hours; it *will* fire for someone on launch week.
Verdict: **NOW.**

**N5. Trigger/pack export + share strings (sharing v1) — Impact: raid/officer, then all. Effort: M.**
What: serialize any trigger, pack, or loadout to a compressed base64 string (and `.gtp`-compatible export); paste-to-import with **dedupe/upsert** (also fixes the verified double-import bug, Audit finding 11). Include overlay positions in loadout bundles — an explicitly named EQLP gap (Community: overlay-sharing finding).
Evidence: The single loudest cross-stream signal. Competitor: WeakAuras strings/wago, EQLP Quick Share, GimaLink, Triggernometry repos. Community: raid-leader push is "the most-praised EQ Nag feature"; pack distribution culture is fragmented across five sites waiting for an owner. First-mover window closes when raid guilds standardize on something else.
Verdict: **NOW** (strings + export + dedupe). Server-side hosting/browser is N-tier (see X1).

**N6. Paste-parse-to-chat (clipboard export) — Impact: group/raid; cultural table stakes. Effort: S.**
What: one-click copy of a chat-length top-N fight summary ("post the parse!"), configurable format, from meter and fight history.
Evidence: Community — GamParse's defining feature, "guilds evaluate members by posted parses"; Audit — promised in PLAN.md M3, zero export code exists. Highest cultural-weight-per-line-of-code item on the list.
Verdict: **NOW.**

**N7. Fight history persistence (SQLite) + stop discarding fights — Impact: group/raid. Effort: M.**
What: fix `completed_fights().pop()` (currently drops all but the last fight per 500ms tick — AE pulls lose fights *today*); persist fights to SQLite; a simple browsable list with the existing summary. Trends/charts come later.
Evidence: Audit finding 3 (verified data-loss bug, not just a missing feature); PLAN.md M3 promised it; every competitor (EQLP, BasaBots ~100 parses, PQ Companion SQLite archive) has it. N6 needs it to be trustworthy.
Verdict: **NOW** (bug fix + persistence + list; defer charts).

**N8. Unclassified-rate health badge — Impact: all; it's your patch-day early-warning system. Effort: S.**
What: count `Event::Unclassified` in the session; Live-tab badge above a threshold ("4% of lines unrecognized — check for update").
Evidence: Audit finding 16 — when July-28+ patches change grammar, users otherwise experience "my triggers stopped working" with no signal. Pairs with N1 to close the loop: detect → notify → update.
Verdict: **NOW.**

**N9. Wire trigger identity into fired events — Impact: all trigger users. Effort: S.**
What: use the already-existing `process_traced` (`TriggerFireInfo{id,name,category}`) in `tailing.rs` so alerts/Live feed show *which* trigger fired; enables mute-this-trigger from the alert itself.
Evidence: Audit finding 12 — engine already provides it; only the plumbing drops it. Prerequisite for tiered alerts (X6) and for users self-serving spam complaints.
Verdict: **NOW.**

**N10. Pre-launch trust page: publish latency + alerts/hr + footprint numbers — Impact: adoption. Effort: S.**
What: README/download-page section: tail-to-speech latency benchmark, 10.3 alerts/hr audit, ~10MB install, MIT, log-only/no memory reads (vs BasaBots), open source (vs Nag). Also run `eqlog triggers` spam audit against a melee and a priest beta log (Audit: only a Nec/Sha log audited so far).
Evidence: Community — latency skepticism and bloat-mockery are the two documented adoption objections; the counter-positioning writes itself.
Verdict: **NOW.**

### NEXT — first month post-launch (Aug 2026)

**X1. Community pack browser / remote pack repo — Impact: all; this is the ecosystem land-grab. Effort: M.**
What: a GitHub-repo-backed pack index the app polls, one-click install/update, submissions via PR; later, ratings. Builds directly on N5's serialization.
Evidence: Competitor — Triggernometry remote repos, GimaLink, wago.io; Community — "whoever hosts the canonical Legends pack repo owns the community touchpoint." NEXT rather than NOW only because N5's paste-strings cover launch week; the repo converts momentum into a moat.
Verdict: **NEXT — first item of August.**

**X2. Healing + tanking meter modes (and fix heal attribution) — Impact: raid; healers are a wholly underserved audience. Effort: M.**
What: surface the healing/overheal/damage-taken data the tracker *already collects* (Audit finding 4: filtered out at `meters.rs:35-46`); meter mode cycle DPS/HPS/taken; fix most-recent-fight heal attribution and single-word-mob-name misclassification together (Audit finding 17). Verify exactly which heal lines Legends emits and document scope honestly (Community: healing-parse caveat).
Evidence: Competitor — EQLP/BasaBots/ESO CMX all have it; Audit — "M3 promised DPS/heal/tank; only the DPS third shipped." Message v1.0 as "DPS meter (more coming)" per the audit.
Verdict: **NEXT.**

**X3. Fix raid-meter bias: open fights on any-combatant involvement — Impact: raid; meter credibility. Effort: M (parser-noise care needed).**
What: stop requiring the log owner's involvement to open a fight (`fights.rs:519-546`); a groupmate's opening burst currently vanishes, biasing rankings toward the log owner — "the one thing a meter must not do" (Audit finding 5).
Verdict: **NEXT** (before anyone screenshots a contested parse).

**X4. Death recap (last-15s ring buffer) — Impact: raid; fastest wipe-diagnosis feature in any MMO. Effort: M.**
What: per-player ring buffer of recent events; snapshot on a death line; recap panel (last hits, heals received) + Discord-postable text.
Evidence: Competitor — Details! death logs, cactbot oopsy, EQLP death parsing. Fully log-feasible, high raid-leader love.
Verdict: **NEXT.**

**X5. Multi-character simultaneous tailing + per-toon voices + single-instance guard — Impact: boxers (large, loud EQ segment). Effort: L.**
What: tail N logs concurrently, tag events with character, per-character voice + name announcement; add `tauri-plugin-single-instance` (today two instances corrupt each other's non-atomic writes — Audit finding 20).
Evidence: Community — "where GINA still beats EQLP," loud in RedGuides boxing crowd; Competitor — GINA's headline feature. Wins an entire segment outright; L effort keeps it out of NOW.
Verdict: **NEXT.**

**X6. Tiered alert severity (info/alert/alarm) + overlay polish — Impact: raid. Effort: S–M.**
What: 3-tier visual/audio escalation keyed off existing threat categories (a Death Touch must not look like a tell — Audit finding: uniform pills); fix "(TARGET)" jargon header, timer-label clipping, "1 Deaths."
Evidence: Competitor — cactbot's escalation model; the taxonomy already exists in the packs.
Verdict: **NEXT.**

**X7. Discord webhook actions — Impact: raid batphone + camp grinders. Effort: S–M.**
What: (a) trigger action "post to webhook" (the legitimate batphone — incumbents are grey-area MQ2 or DIY Python); (b) fight-summary embed on fight end.
Evidence: Community — established demand, only grey-area satisfaction; Competitor — EQLP webhooks, PlenBot workflow culture.
Verdict: **NEXT.**

**X8. Respawn/camp timers from kill lines — Impact: solo/group; classic-audience catnip. Effort: M.**
What: auto-start a countdown overlay on "slain" lines with a per-zone/mob respawn table (crowdsource the table via X1 packs); rez/corpse-window timer on your own death if Legends has classic death rules.
Evidence: Community — dedicated GINA package exists solely for this on P99; PQ Companion proves the log-only pattern.
Verdict: **NEXT.**

**X9. Log hygiene: size display, rotation, archiving — Impact: all; universal chronic pain. Effort: S–M.**
What: show log size in Settings with warning threshold (S, could sneak into NOW); then rotate/compress/archive.
Evidence: Community — 160GB log anecdotes, logrotate hacks, "no companion owns log hygiene"; Competitor — EQLP archiving.
Verdict: **NEXT** (size warning: quick win now).

**X10. Loot log + /random roll tracker — Impact: group/raid officers. Effort: S–M.**
What: the parser already emits `Event::Loot` and `Event::Roll` and then drops them (Audit finding 19); add a loot table and per-session roll leaderboards (high/low modes).
Evidence: Competitor — EQLP, PQ Companion leaderboards; promised in own PLAN.md M4. Cheap because parsing is done.
Verdict: **NEXT.**

**X11. Per-ability drill-down in the meter — Impact: group/raid parse culture. Effort: M.**
Evidence: Competitor — Details! click-any-bar, BasaBots lifetime records, EQLP breakdowns. Needs X2/N7 foundations first.
Verdict: **NEXT (late).**

**X12. Zone-conditional pack activation — Impact: raiders/campers with big libraries. Effort: S–M.**
What: auto-enable packs on zone-in lines (already parsed); reduces spam and manual toggling.
Evidence: Community — the specifically-praised EQ Nag capability; extends the loadout system naturally.
Verdict: **NEXT.**

**X13. Batch per-line IPC emission — Impact: raid-night robustness. Effort: S.**
What: batch log-line events per 100–250ms tick like fight updates already are (Audit finding 15: per-line JSON+IPC+setState is the real burst risk, not the engine).
Verdict: **NEXT** (or NOW if a beta raid shows jank).

### LATER / SKIP — with reasoning

**L1. Encounter/boss timeline modules (cactbot-style) — LATER (Sep+). Effort: L.**
The most beloved raid feature in other MMOs, and the natural extension of the pack system — but Legends raids are *unsolved at launch*; timelines require known fights. Build the timeline engine after the first raid tier is on farm, and let X1's community repo carry per-boss packs. Doing it now would burn the pre-launch window on content that can't exist yet. Prerequisite work (N5, N9, X1) is all on the path.

**L2. OBS browser-source overlays — LATER. Effort: M.**
Real need (transparent Tauri overlays are likely invisible to OBS — Audit/Competitor), and the overlays are already React so a localhost WS server is straightforward. But streamers are a minority of a 3-week-old game's audience; revisit when Legends streaming is a thing. Cheap interim: document the Windows Capture workaround.

**L3. Neural TTS (Piper / Windows 11 natural voices) — LATER. Effort: M.**
BasaBots' headline feature; will matter for polish perception. But current TTS *works*, and voice quality never blocked GINA adoption for a decade. Do it with X5 (per-toon voices) as one audio workstream.

**L4. Quest tracking + item/mob/spell database explorer — LATER. Effort: L.**
BasaBots parity and genuinely valuable (the spell-DB path already exists), but it's a second product's worth of scope. The trigger/parse core must win first; bolting on a database explorer pre-launch dilutes both. Revisit Sept with the community repo as the data channel.

**L5. Chat search + /who player database + timer persistence across restarts — LATER. Effort: M each.**
Proven log-only features (EQLP, PQ Companion, EQAlert) with steady demand; none are launch-window-critical. Timer persistence (EQAlert-style) is the first of the three to do — losing raid buff timers to an app restart stings.

**L6. Encounter upload / web report+ranking ecosystem — LATER, deliberately. Effort: L + hosting + moderation.**
The end-game (Warcraft Logs), and nobody owns it for Legends — but it requires hosting, privacy policy, and ranking integrity work that would consume the whole window. Seed it later with "share this fight as a static web page" once fights persist (N7). Do not attempt before the meters are unbiased (X3), or the rankings will be wrong at birth.

**L7. Anonymous drop-rate crowdsourcing — LATER. Effort: L.**
BasaBots' cleverest moat and hugely valuable for a wiki-less new game, but it needs opt-in telemetry infrastructure and a privacy story. Design the opt-in with X1's repo infra; don't rush trust-sensitive features.

**L8. Threat/hate estimator — LATER. Effort: L.**
PQ Companion proves it; the spell DB helps; but it needs a hate-values table nobody has for Legends yet. Community-data problem first, feature second.

**S1. Live spawn map — SKIP.**
Not log-feasible for spawn positions; BasaBots does it by reading memory. Matching it would destroy the zero-ban-risk positioning that is the core marketing wedge. A ZlizEQMap-style /loc plotter is the only acceptable LATER variant, and only if users ask.

**S2. Localization — SKIP for now.**
Unknown whether the Legends client even localizes log lines; no evidence of EU demand yet. Re-evaluate on data.

**S3. Advanced trigger language ({COUNTER}, numeric ranges, cross-trigger state) — mostly LATER, one exception.**
Power users will hit the ceiling (EQLP #358's rampage case is real), but the plain-English editor is the differentiator — don't complicate it pre-launch. Exception worth NEXT consideration: a "trigger arms another trigger" template, which is the #358 ask expressed in the app's own idiom.

**S4. DKP/attendance suite — SKIP as a feature; do an exporter.**
eqraid.tools/OpenDKP own this well. Ship a raid-dump/loot-line export that *feeds* them (fits X10) rather than competing.

---

## 4. Quick Wins (each under a day)

User's pending trio first:

1. **Mez-breaker call-out trigger** — curated pack addition; names who broke mez (raid CC discipline; fits existing enemy/combat parsing).
2. **Banshee Aura watchdog** — curated trigger with wear-off early-cancel, per the existing DoT/CC timer pattern.
3. **Pet auto-persist** — persist learned /pet-leader names into the profile so pet intelligence survives restarts (extends Audit-praised pet system; EQLP still has this open as #234/#179).

Already-identified one-liners and small items:

4. Fix Windows rotation race (N4) — small, do immediately.
5. Atomic writes (temp+rename) for config/triggers/profiles.
6. GINA import dedupe/upsert (kills the verified double-import bug).
7. CLI `--triggers` accepts the app's own TriggerPack shape (verified failure; share `config::load_triggers` logic).
8. Trigger name in `TriggerFiredPayload` via existing `process_traced` (N9).
9. `/log on` hint in the Live empty state + "file not growing" warning.
10. Log-file size in Settings with a warning threshold.
11. Clipboard paste-parse-to-chat MVP (N6 — genuinely ~a day for a fixed format).
12. Unclassified-rate badge (N8).
13. In-app "alerts/hour" stat surfacing the spam auditor (makes the differentiator legible — Community: alert-fatigue finding).
14. "1 Deaths" → singular; timer-bar label clipping; "(TARGET)" → "Not yet targeted"; top-bar LOADOUT tooltip; seconds-unit echo in the warn-custom field (Audit polish nits).
15. DEMO watermark whenever `IS_MOCK` is active, and bump the mock library to show the real 1,647-trigger scale (Audit: demo undersells the flagship).
16. README/download-page trust block: latency, alerts/hr, ~10MB, MIT, log-only (N10).
17. Batch log-line IPC emissions per tick (X13 — small, protects raid night).

---

## Traceability note

Every roadmap claim above maps to a named finding in one of the three streams: **Competitor** = competitor-gaps stream (EQLP release notes to v2.3.55, basabots.com, pq-companion.com, cactbot, quarm.guide/GINA, wago.io, plenbot); **Community** = demand stream (official EQ forums threads 304763/240825/255399, RedGuides GINA/Nag/EQLP threads, EQLP GitHub issues #71/#133/#179/#234/#335/#358, P99 threads, eqfreelance/Fanra); **Audit** = self-audit stream (file:line references verified against commit 627cc54, CLI replays on the 84,672-line fixture, 12 screenshots). One caveat carried forward: the BasaBots "reads some game memory" quote comes from a search snippet of a 403-blocked elitepvpers thread — verify in a browser before using it in public marketing copy.
