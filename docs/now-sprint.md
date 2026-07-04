# NOW sprint — pre-launch hardening + ecosystem v1

Scope = the NOW tier of docs/APP_REVIEW.md (read it; file:line citations there
are authoritative) plus one addition. Items:

1. tail.rs rotation false-positive race (APP_REVIEW citation) — fix + test.
2. meters.rs completed-fight discard bug — fights must persist: SQLite store
   (rusqlite, bundled feature — approved new workspace dep) in eqlog-core or a
   small eqlog-store crate; app writes each completed FightSummary; new
   commands list_fights/get_fight; frontend Fights history browser (list +
   detail reusing meter table components).
3. MULTI-INSTANCE DoT TRACKING (user requirement): same spell on same-named
   mobs gets numbered instance bars. Engine: when binding "S — T" and that
   name exists, suffix " (2)", " (3)"…; each instance keeps its own expiry
   (cast-order). Wear-off-of-target / Slain{T} pops the OLDEST instance of
   the matching (spell?, name) — death pops oldest instance of EVERY spell
   bound to T (one mob died; its dots were the oldest). Your death clears
   all. Document the twin-attribution approximation in comments + a test
   with two overlapping casts on identical names.
4. First-run: command discover_logs() scanning the default Logs dir for
   eqlog_*.txt (mtime-sorted, parse character+server from filename);
   AppConfig default log_path/character become EMPTY (kill hardcoded
   Nyasha); frontend first-run state: if no config file existed, show a
   welcome card — detected logs as one-click choices, '/log on' guidance,
   link to Settings. Character auto-fills from the chosen filename.
5. Observability: append-only app.log in the config dir (rotating at 1MB,
   keep 2) capturing engine warnings, pack-load problems, tail session
   errors, auto-resume failures; "session-ended" event when the tail thread
   dies unexpectedly → frontend red banner with reason + Restart button;
   atomic config/profile writes (write temp + rename); pack-load warnings
   surface as a dismissible banner count on the Triggers tab.
6. Patch-day canary: tailing tracks unclassified-line rate (rolling 1000
   lines); emit in a periodic "tail-stats" event; topbar shows an amber
   badge when >3% with tooltip "game update may have changed log formats".
7. Trigger identity: EmitSink carries per-fire trigger id/name (engine
   process_traced already returns TriggerFireInfo — plumb a wrapper so the
   sink knows the firing trigger), "trigger-fired" payload gains
   trigger {id,name}; Live/alerts UI shows the name on hover; context
   action "Mute this trigger" → set_override(id,false).
8. Sharing v1: eqlog-triggers share module — export selected triggers /
   pack / loadout to a compressed base64 string ("LCS1:" prefix, serde_json
   + deflate) and import with id-collision dedupe (suffix -2) + summary
   dialog (count, categories, source badge "shared"); also .gtp GINA XML
   EXPORT for cross-tool sharing. Frontend: share buttons on tree groups +
   loadouts, import box in Triggers tab.
9. Paste-parse-to-chat: fight summary → clipboard in EQ-paste format
   ("You: 2761 (38.3 DPS) | Torvin: ..."), button on Meters tab + fight
   history rows. 240-char safety split.
10. Trust numbers: README section (latency, 10.3 alerts/hr audit, ~10MB,
    MIT, log-only); measure tail-to-fire latency with a bench note.

Constraint reminders: Rust regex no lookarounds; no other new deps beyond
rusqlite (bundled); tsc/clippy/tests green; spam audit must stay <=~12
spoken/hr; app/src-tauri uncompilable in WSL (write carefully, CI verifies);
do NOT touch /mnt/c; no git commands (orchestrator commits).

## Post-sprint addendum (user requests, apply immediately after merge)

11. Cast-time lead-in (DONE in tree): StartTimer.cast_time_secs; bar length =
    cast + duration so expiry matches the true wear-off.
12. PENDING/"casting..." bar state: timers with cast_time_secs > 0 start
    pending; engine ActiveTimer gains lands_at + TimerFireKind::Landed
    emitted once via due(); TimerPayload gains pendingSecs on "started" and
    a "landed" kind. Frontend: pending bars render dimmed + pulse + label
    "casting..." (no countdown numerals), flip to normal on landed; applies
    to all lanes. Interrupt/fizzle/resist cancellation already removes
    pending bars.

13. CATCH-UP GUARD (from tonight's live incident — false-rotation replayed a
    16MB log through TTS): when the tail session processes lines whose
    timestamps lag the newest-seen line time by > 30s (replay/catch-up
    mode), suppress Speak/PlaySound/StartTimer sink actions and fight-db
    writes; DisplayText suppressed too; meters may ingest. Exit catch-up
    once line timestamps are within 5s of the live clock. Emit one
    "catching up (N lines)" status event for a topbar note. Also verify
    the tail.rs fix removed file SIZE from the Windows identity check —
    size changes on every append; identity must be creation-time (+ volume
    /file index if available) only.

14. SILENCE BUTTON (from tonight's incident — no way to flush queued TTS):
    audio thread gets a generation counter (Arc<AtomicU64>); Speak/Play
    commands carry the generation at enqueue; a silence_audio command bumps
    the generation (stale queue entries dropped on receipt) and calls
    tts.stop() to cut the current utterance. Topbar speaker icon button +
    Esc-Esc double-tap shortcut. Also auto-silence when stop_tailing runs.

15. PER-SOURCE DAMAGE BREAKDOWN (user request): fights.rs per-combatant
    source map — key = melee verb ("crush"), spell name ("Lifespike"), or
    effect ("frost (damage shield)"); accumulate {total, hits, crits, max}.
    FightSummary rows gain sources: Vec<SourceRow> sorted by total desc.
    UI: meter rows become expandable (chevron; default collapsed; remember
    expanded state) — sub-rows indented per DESIGN.md: source name in ink,
    total/DPS-share/% right-aligned tabular, thin sub-bars (60% row height)
    in the combatant's series color at reduced opacity. Works on every
    combatant row (not just the player), Fights history detail included.
    Pet sources fold under the owner with a "(pet)" suffix when attribution
    is on. CLI: eqlog fights --sources flag prints the breakdown.
    OVERLAY companion for item 15: the meter overlay gains an optional "my
    sources" section — Settings toggle (locked overlay is click-through, so
    no on-overlay interaction): the player's bar is followed by up to 4
    micro-rows (12px) with their top damage sources live, same
    reduced-opacity sub-bar treatment. Other combatants stay single-row on
    the overlay; the full breakdown lives on the dashboard + Fights detail.

16. REMOVE AUTO-DETECT (user decision — manual class picking is enough):
    delete the auto-detected chip from TriggersTab, the log-watching detect
    hook, and the detect_character_classes command + its invoke_handler
    registration; keep eqlog-triggers::detect_classes + the CLI `eqlog
    detect` subcommand (harmless, useful for support). Manual class
    selects stay exactly as they are.

17. SELF-CALIBRATING RECASTS (from Mend investigation): eqstr 413/414 print
    exact remaining cooldowns on early ability presses ("You can use the
    ability %1 again in %2 minute(s) %3 seconds."). Engine: parse these
    lines (new parser event AbilityCooldown {ability, remaining_secs});
    when seen, (re)start timer "<ability> recast" with the REPORTED
    remaining time (duration-from-event, not from pack), and persist a
    learned-recast map (ability -> observed full duration inferred from
    press-time deltas) in the profile so pack recast guesses self-correct.
