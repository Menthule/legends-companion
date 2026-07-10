# Patch Notes

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
