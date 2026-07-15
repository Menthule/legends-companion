# Patch Notes

## 3.0.2 - Inventory, Ranked Timers & Achievement Moments

### Inventory Workspace
- Inventory is now a permanent character-and-server database built from `/output inventory`, covering carried items, equipment, bank, shared bank, key rings, hoard, and personal depot when those windows are included in the export.
- Search, sort, and filter by storage area or evidence-based status, including Needed, Possible quest use, Watched, Recipe component, Extra quantity, and No known use.
- Compare exports to see added, removed, moved, and quantity-changed items, with exported free-slot capacity for each observed storage area.
- Add or remove item watches directly, mark items to Keep, Move, Sell, Trade, or Review, attach cleanup notes, and work through a persistent cleanup queue.
- Expanded inventory rows now show locations, quest evidence, planned or in-progress quest status, item stats, drop sources, vendors, and recipe links without leaving Inventory.
- Currency balances retain measurement history and estimate gains per hour after two samples.

### Quests & Item Evidence
- `Hide owned rewards` now checks the final rewarded item, including ranked and Exaltation name variants, even when the quest was opened directly from Global Search.
- Only quests marked Planned or In progress reserve required materials; unclassified quest links remain visible as Possible quest use instead of incorrectly marking every related item Needed.
- Quest-item source claims now distinguish corroborated data, documented Legends sources, classic-only references, ruleset differences, conflicts, and unresolved items.
- Expanded source coverage and corrected links make more required items traceable from Quests into Drops and their detailed reference records.

### Ranked Timers & Spell Icons
- Diagnostics can scan the active log for ranked spells you actually cast, surface timers whose observed duration differs, and apply a clean observed value or a manual duration/cast-time override.
- Ranked timer actions remain visible while reviewing evidence, with clear states for needs update, collecting, inconsistent, and current.
- Spell-gem extraction and mapping now align with the Legends client; icons persist through trigger refreshes and update on active timer bars.
- Buff, debuff, target, cast, skill-damage, resist, and failure alerts use clearer icon-backed presentation, and resisted spells are removed from the target timer lane.

### Achievement Moments & Responsiveness
- Achievement log events now flow through a typed, configurable trigger into Impact with an animated achievement seal; overlay, sound, text, color, duration, and speech remain trigger actions rather than hardcoded presentation.
- Expensive search bars now debounce their filtering and database requests while keeping typed text immediate, reducing input lag across Triggers, Quests, Inventory, Macros, Live, Session, Diagnostics, database views, and autocomplete controls.

## 3.0.1 - Watched Kills

### Watch Goals
- Add kill goals directly from a mob or attach an exact mob name and required count to any quest.
- Manage watched drops and kills together from Session, with detailed kill progress and auto-remove controls in Mobs and Quests.
- Existing item-only watch files migrate automatically to the shared item-and-kill watch format.

### Trigger-Driven Impact
- Editable event-source triggers recognize raw loot and kill lines, then emit structured watch observations; log wording can be updated from the trigger library without changing application code.
- Observed deaths for watched mobs now emit a structured `watched-kill` trigger event; no mob names or quest rules are hardcoded.
- The default trigger sends a large RIP tombstone and mob name to Impact with sound, while the trigger editor controls the overlay, text, style, color, duration, sound, and TTS.
- Watched loot and watched kills use the same typed event -> watch match -> trigger -> actions pipeline.
- Watched loot now opens an original generated fantasy chest with a configurable glow burst, reward particles, and reduced-motion treatment.

### Timer Icons
- Buff, debuff, ability, and custom timer bars now reserve an EverQuest-style icon slot beside the progress bar.
- Spell timers use their configured spell-gem artwork, while custom glyphs and a restrained fallback keep every row aligned.

## 3.0 - Career History, Sessions & Watched Loot

### Career History
- Legends Companion now builds a permanent, character-specific career database from your EverQuest log history.
- Import existing logs from Settings > General > Career History. The initial import runs in the background and leaves the original log files untouched.
- Future sessions update automatically when log tailing starts. Incremental imports only process new data and prevent duplicate history.
- The new Career view includes lifetime sessions, play time, XP, AA, kills, deaths, loot, level progression, zones, coin, and skill-up totals.
- Review historical trends, level timelines, individual sessions, kills by mob, and observed loot from each mob.
- Career data can be reset and rebuilt from the original logs at any time.

### Sessions & Combat
- Session is now the central performance workspace, with consistent navigation between the last fight, current session, and a selected previous or baseline session.
- Compare XP/hour, AA/hour, motes/hour, DPS, total damage, kills, deaths, downtime, routes, camps, and top skills at a glance.
- Fight details now separate player damage from enemy damage and show the attacks, spells, and abilities used by both sides.
- Damage shields, pets, martial abilities such as Kick and Flying Kick, and enemy damage sources are now attributed correctly.
- Fights remains the historical encounter browser while Session focuses on progression, efficiency, and build comparisons.

### Quests, Inventory & Reference Data
- Added a bundled quest catalog, including Plane of Sky class quests.
- Quest progress can be checked against EverQuest `/output inventory` files.
- Filter for quests that are ready to complete or hide quests whose final reward is already owned.
- Required items show known drop locations, while reward tooltips expose item details before turn-in.
- Quest items, mobs, drops, spells, abilities, and rewards now cross-link directly to their detailed database pages.

### Watched Loot
- Star individual items from Drops or add required items directly from a quest.
- Add every missing requirement for a quest to the watch list in one action.
- Each watch supports a required quantity and can automatically remove itself once enough copies have been looted.
- Exact personal loot matches trigger a large Impact alert with an animated treasure chest and the looted item name.
- Watched loot uses the normal trigger system, so its overlay, sound, speech, and presentation can be customized without separate hardcoded parsing.

### Triggers, Alerts & Timers
- Triggers now follow a scalable `Trigger -> Actions` model.
- A single match can send independently configured output to multiple overlays and TTS, while timer, sound, and webhook actions remain dedicated action types.
- Overlay-specific controls cover text, color, size, icons, duration, and other presentation settings.
- Removed the old hardcoded proc-alert pipeline; spells, skills, procs, loot, and custom log events now flow through triggers.
- Added spell-gem icon support, clearer severity defaults, trigger-library updates, and portable trigger import/export.
- Added rank-aware spell timing profiles and manual duration controls for spell ranks, custom timers, and private-instance respawns.

### Quality of Life
- Global Search results now open the selected mob, item, spell, quest, or ability directly.
- Added session export, improved trigger sharing, verified pet macros, clearer zone controls, and a Welcome Back summary.
- Improved parser attribution for multi-word skills, enemy attacks, pets, damage shields, replayed history, and older saved fights.

## 0.2.5 - Insights, Search & Alert Discipline

### Fixes (review pass)
- Fixed a parser regression where mobs whose names end in eagle/tiger/dragon (e.g. `A giant eagle strikes ...`) were split into a wrong attacker plus a monk-skill verb, corrupting fight history and meter attribution.
- Miss lines for multi-word skills (`You try to eagle strike ...`) now parse the full verb, so skill accuracy (Acc%) counts misses instead of always reading 100%.
- Plain `strike(s)`/`claw(s)` auto-attack swings no longer fire skill proc alerts (a pet clawing every combat round used to flood the alerts overlay); the deliberate Eagle Strike / Tiger Claw skills still alert.
- Timers again auto-loads the current zone's rares on zoning even when `Auto zone change` is off (that toggle only governs the Database tabs' filters).
- Replayed log history at session start no longer pops the global search from old Hail lines and no longer double-counts XP/kills/deaths into the live Insights session.
- With `Auto zone change` on, manually picking a different zone in Drops/Mobs now sticks instead of snapping back to the live zone; the filter follows only actual zone changes.
- Fight detail view again splits pet damage rows for fights recorded before the pet-damage field existed.
- The XP overlay's level-progress bar and the Fights tab's `To level` kills/time estimate work again: progress persists across restarts once a ding anchors it.

### Alerts / Audio
- New global silence hotkey `Ctrl+Alt+S` — cuts speech and drops queued alerts even while the game has focus (the in-app Esc-Esc still works when the companion is focused).
- New master `Mute all alert audio` switch in Settings > General for sessions where voice should stay off (previews still play; the one-shot Silence is unchanged).
- Warn/alarm alert pills now scale with the Alert text size setting instead of overriding it (warn no longer renders smaller than info at defaults).
- Alarm-tier alerts stay on screen 8s (warn 6s, info 4s) and can no longer be pushed off the overlay by a burst of routine alerts.

### Quality of life
- The pet name learned from the pet leader command is now saved to the character (Settings > pets), so pet damage attribution survives restarts.
- New `Copy recap` button in Insights — copies a postable text summary of the session (duration, zones, XP and rate, kills/deaths, top mob, top source, best camp pace). Works for previous sessions too.

### UI / UX
- Simplified the top bar into identity, search, live status, Session menu, and Overlays menu.
- Moved parser-health noise out of the top bar and into diagnostics.
- Added trigger library filters for all, my triggers, enabled, TTS, alerts, timers, and disabled triggers.
- Added a clearer `+ Trigger` starter flow before the full trigger builder.
- Reworked the Triggers toolbar so search is primary, imports live in an Import menu, `+ Trigger` sits on the right, and the tree has Expand all / Collapse all controls.
- Patch Notes are now visible inside the app and expand to the available window.

### Coach / Diagnostics
- Added a Diagnostics tab for parser health, active-log confidence, recent unrecognized lines, and effect alert debug.
- Renamed the Coach nav item to Insights and gave it a session-oriented icon.
- Moved Diagnostics near Settings and gave it a dedicated diagnostics icon.
- Split Insights into focused sections: Overview, Damage, Pets, XP / Zones, and NPC History.
- Reworked Insights around player questions: what you killed, what did your damage, whether the camp/difficulty is efficient, and what build pieces contributed.
- Simplified the Insights header so session controls live in Current Context instead of the top summary card.
- Renamed the Insights Session tab to Overview and reorganized it as a player-facing session report.
- Added Previous Sessions to Insights so ended sessions are summarized by time, zone, XP, kills, deaths, and top mob.
- Reworked Insights around a Viewing Context selector so Current Session and Previous Sessions drive the summary and tabs.
- Folded live session controls into the Viewing Context band instead of showing a separate controls card.
- Compacted the Viewing Context band into a toolbar-style row and made AFK auto-reset off by default for new Insights settings.
- Added best-effort instance difficulty detection from log lines that mention difficulty, tier, or instance D1-D5.
- Standardized search input styling so text and search fields share the same dark surface, sizing, placeholder color, and focus state across views.
- Moved the Live Zone filter to the top bar so it applies across views instead of feeling owned by Drops or Mobs.
- Reworked the Insights context header into a compact session bar with aligned session, zone, difficulty, and AFK controls.
- Global Search now only applies current-zone boosting when the top-level Live Zone option is on.
- Overlay controls now open directly to Settings > Overlays.
- Merged live log status and Live Zone follow into one compact Live menu in the top bar.
- Renamed the Live Zone control to `Auto zone change` and moved it into a switch-style Live feature row for future live-context options.
- Added `Auto zone change` to Settings > General as the persistent home for the same live-context preference.
- Top-bar popovers now dismiss when clicking outside them or pressing Escape.
- Improved the Pets tab empty state to explain when no pet damage is parsing and point users to pet leader/configuration setup.
- Meter overlay now splits attributed pet damage into its own pet row, matching the main Meters and Fight History views.
- Changed proc/skill/spell Insights from per-line debug rows to aggregate session totals.
- Improved pet Insights so pet damage and pet-only sources are shown separately from player damage.
- Reused the same pet-session summary logic across Insights so current and completed fights report pet damage consistently.
- Insights now accumulates pet damage across completed fights instead of only showing the current fight snapshot.
- Session efficiency now shows an overall row plus per-zone/per-difficulty rows for the current session.
- Added an Insights `Start new session` action that resets current session aggregates without deleting fight history or NPC notes.
- Session Insights now includes a Zones / Camps table.
- Added Smart Session rollover for Insights, which can start a fresh session after a configurable idle gap.
- Removed the placeholder Build notes tab from Insights until gear/proc/focus data can be made actionable.
- Diagnostics can copy unrecognized lines, create a trigger from a line, and copy a parser-health bundle.
- Scoped Insights settings by character and active loadout.
- Changed session difficulty to a dropdown with an Unknown default.
- Improved active-character detection so prompts require a fresh, meaningfully newer log.

### XP
- XP/hour and time-per-level now require at least two recent XP events before showing a rate.
- Recent XP total still displays from one gain, but rate and ETA stay blank until there is enough sample data.

### Fights
- Fixed a startup race where Fight History could show `database failed to open` before the backend finished opening `fights.db`.
- Added app-log confirmation when fight history opens successfully.
- Renamed the lower fight panels to Kills, Effects, Recaps, Loot, Rolls, and XP instead of presenting them as session insights.
- XP estimates now wait for an actual ding anchor instead of asking the user to manually enter a level percent.

### Timers
- Moved New Custom Timer to the top of Timers.
- Timers now follows the top-level Live Zone setting when loading the current zone's rares.

### Triggers
- Refactored trigger outputs around a scalable `Trigger -> Actions` model. A generic Overlay action now selects an open overlay destination and carries template-expanded fields plus destination-specific presentation settings; one match can fan out to several independently configured overlays and TTS.
- Added an overlay registry that defines each destination's editor fields, presentation controls, defaults, and runtime adapter. Alerts and Impact now use the shared `trigger-overlay` event while legacy DisplayText/Impact actions remain compatible.
- Trigger action events now capture their trigger identity directly instead of reconstructing ownership from action counts, preventing mixed or skipped actions from being attributed to the wrong trigger.
- Editing an advanced timer now preserves fields the compact editor does not expose, including lane, cast lead-in, repeat/stopwatch behavior, and warning/expiry text and sounds.
- Live rows already support creating a trigger from a specific log line with `+ Trigger`.
- Trigger creation now supports a simpler intent-first path for alerts, TTS, timers, sounds, and proc/skill/spell-style alerts.
- Bundled trigger rows now say `Customize` when creating an editable user copy.
- Customized bundled trigger copies now have a Revert action to remove the custom copy and fall back to the bundled default.
- Trigger rows with loadout overrides now have Reset, which clears enabled, TTS, and alert overrides back to default.
- New loadouts default to names based on their class combination when classes are known.

### Reference Data
- Added an opt-in `Live zone` filter for Drops and Mobs. When enabled, zone filters follow the zone detected from the live log.
- Expanded database records now include external follow-up links for Legends web search, P99 wiki, and ZAM.
- Spell scroll and recipe component source hints now prefer sources in the current Live Zone before falling back to the best overall source.
- Item and spell database links now use direct ZAM item/spell pages when the app has the EverQuest ID.

### Macros
- Added a macro name field that fills common placeholders like Tankname, Leadername, Draggername, Dragger, Alice, Bob, and Clericname before copying.
- Macro cards and command rows now show their source links.

### Overlays
- Top-bar Arrange overlays no longer permanently enables overlays that were previously hidden.
- Settings > Overlays now starts with quick actions for Show all, Hide all, and Arrange/Lock overlays.

## 0.2.4 - Companion Foundation

### Live Log
- Live parsed log feed with filtering, mine-only mode, archive search, pause/resume, and trigger creation from log lines.
- Global search across logs, mobs, drops, spells, abilities, recipes, triggers, and characters.
- Hail-driven search and NPC memory capture for dialogue.

### Combat
- Damage meters, fight history, skill breakdowns, pet damage split, healing, and damage-taken views.
- Proc, skill, and spell alert support with optional TTS.
- Casting outcome tracking for landed, resisted, fizzled, and interrupted casts.

### Timers / Overlays
- Alert, buff, target, meter, XP, stance, respawn, and on-others overlays.
- Camp respawn timers with zone support and named/rare tracking.
- Click-through overlay lock and arrange mode.

### Triggers
- Bundled trigger packs with per-character loadouts.
- Per-trigger TTS and alert channel overrides.
- GINA import, share strings, custom trigger editing, and trigger tree controls.

### Reference Data
- Drops, mobs, recipes, spells, abilities, spell scrolls, vendors, and zone reference views.
- Cross-links between combat/fight data and reference database tabs.
