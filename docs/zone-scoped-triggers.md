# Zone-scoped trigger activation

Reduce alert spam by limiting triggers (or whole packs) to the zones where they
matter — the log-only equivalent of EQ Nag's zone-conditional activation. A
Sebilis debuff pack stays silent in the Plane of Knowledge; a boss pack only
speaks in its raid zone.

## How it works (engine — shipped, tested)

The trigger engine tracks the **current zone**, learned from the client's own
`You have entered <zone>.` lines (`Event::ZoneEnter`, already parsed by
`eqlog-core`). A trigger with a non-empty **zone scope** fires only while the
current zone matches; an unscoped trigger fires everywhere, exactly as before.

- **Matching is case-insensitive substring.** A scope entry `"Sebilis"` matches
  the log's full zone name `"New Sebilis Expedition"`. Keep entries short and
  distinctive.
- **Unknown location = quiet.** Until the first `You have entered …` line is
  seen, the current zone is `None` and zone-scoped triggers do not fire. On a
  live session you establish it by zoning once; after a mid-session restart the
  catch-up replay re-seeds it from the log tail (`process_traced` runs on every
  replayed line — only the *sink* is suppressed during catch-up, so zone
  tracking still happens).
- **Zoning out re-mutes.** Enemy-lane timers are already reaped on zone change
  (P17); zone-scoped triggers simply stop matching once you leave.

### Two ways to set a scope

1. **Pack-authored** — a trigger ships with its own scope:

   ```json
   { "name": "Trakanon breath", "pattern": "...",
     "zones": ["Sebilis"], "actions": [ ... ] }
   ```

   This is how a shared/community pack can describe itself as zone-specific.

2. **Per-loadout override** — the user scopes a trigger *or a whole category
   branch* without editing pack files, via `Loadout.zone_scopes`
   (`<trigger-id or category-path-prefix>` → list of zone substrings). Same
   most-specific-wins resolution as `overrides` (exact id, then longest path
   prefix). A matching entry **replaces** the trigger's pack-authored `zones`:

   ```json
   "zone_scopes": {
     "Class/Enchanter/Debuffs": ["Sebilis", "Chardok"]
   }
   ```

   An empty list (`[]`) scopes the branch to *no* zone — a way to mute a whole
   pack everywhere without deleting it.

Both are honored automatically by `TriggerEngine::new_with_profile`, which the
live tail session already builds the engine through. No new wiring is needed
for the feature to work end-to-end from hand-edited profile JSON.

### Code

- `model.rs` — `Trigger.zones: Vec<String>`, `Loadout.zone_scopes: BTreeMap<String, Vec<String>>` (both serde-optional, backward compatible).
- `profile.rs` — `zone_scope_for(trigger, loadout)` resolves the effective scope.
- `engine.rs` — `TriggerEngine.current_zone`, `note_zone()` (updates it on `ZoneEnter`), a fire-time gate in `process_traced`, and `current_zone()` getter. `new_with_profile` applies the loadout override.
- Tests: `profile::tests::zone_scope_*` (unit) and `engine_tests.rs::zone_scoped_*` / `loadout_zone_scope_overrides_pack_zones` (integration).

## Follow-up: dashboard UI (Windows-only — not built in WSL)

The engine feature is complete and shipping-ready via JSON; the remaining work
is a UI to edit scopes without hand-editing files. Build on Windows:

- **Trigger editor / group row** (`app/src/components/TriggersTab.tsx`,
  `TriggerEditor.tsx`): a small "Zones" field on a trigger or category group —
  comma-separated zone substrings — that writes into the active loadout's
  `zone_scopes` map (keyed by the trigger id or the category path). Mirror how
  the enable and speak/alert channel overrides already round-trip through
  `library.rs`.
- **Tauri command** (`app/src-tauri/src/library.rs`): add a
  `set_zone_scope(trigger_or_prefix, zones)` alongside the existing override
  setters; persist via the same profile-save path; rebuild the live engine so
  the change takes effect without a restart (the override setters already do
  this — reuse that rebuild path).
- **Live-zone affordance**: the engine now exposes `current_zone()`. Surface it
  on the Live tab / status bar and offer a one-click "scope this trigger to my
  current zone" using it. Nice-to-have, high discoverability.
- **Suggestions**: the app already ships a zone list (Database → zone almanac);
  autocomplete the Zones field from it so users pick real names.

No id/override keys change, so this is purely additive — existing profiles load
unchanged and unscoped triggers behave exactly as they do today.
