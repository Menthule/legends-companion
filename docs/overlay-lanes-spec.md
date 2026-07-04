# Overlay lanes: separate buff-timer and enemy-effect overlays

User requirement (2026-07-03): buff expirations and effects-on-enemies (DoTs,
mez/root/snare) must live on SEPARATE overlays, not mixed into the alerts
overlay.

## Windows

Four overlays (all transparent/click-through/position-persisted like today):

| label            | shows                                            |
|------------------|--------------------------------------------------|
| overlay-alerts   | text alerts only (trigger DisplayText, deaths…)  |
| overlay-buffs    | YOUR buff countdown bars (beneficial self casts) |
| overlay-target   | effects you put ON ENEMIES: DoTs, mez, root,     |
|                  | snare, debuffs — grouped per target when known   |
| overlay-meter    | compact DPS meter (unchanged)                    |

Add to: tauri.conf.json windows, capabilities windows list, OVERLAY_LABELS,
overlayState defaults (both new ones default ON), Settings toggles, Dashboard
eye/arrange handling, mock backdrops.

## Timer lanes (engine + packs)

1. `Action::StartTimer` gains optional `lane: "buff" | "enemy" | "other"`
   (serde default "other" — additive). `ActiveTimer` carries it;
   `TimerFire`/`TimerPayload` expose it; frontend routes bars by lane.
2. Lane inference fallback when the field is absent: trigger category
   starting with `buffs/` → buff; category containing `/cc` or
   `Enemy` or debuff-generated packs → enemy; else other.
3. Generator changes (tools/spelldata):
   - buffs-*.json StartTimer actions get `lane: "buff"`.
   - NEW generated pack family `debuffs-<class>.json`: detrimental spells
     with duration castable by the class → cast-start timer with
     `lane: "enemy"`, plus early-cancel wired to the Legends wear-off line
     `Your <Spell> spell has worn off of (.+).` (CancelTimer + re-announce).
     Default-enabled only for CC (mez/root/snare) + class-defining DoTs;
     rest available but off (spam audit gate applies).
4. Per-target labels: timer NAME templates may include captures; for
   debuff timers started from the wear-off-with-target trigger pair, name
   as `<Spell> — ${1}` when a target capture exists. Cast-start lines have
   no target; v1 keys enemy timers by spell name only (documented gap:
   two mobs mezzed with the same spell share one bar; wear-off-of-target
   cancels on the first drop).

## Frontend

- OverlayAlerts loses its timer section (alerts only, max 5, unchanged
  styling).
- New OverlayBuffs: DESIGN.md timer-bar spec, sorted by remaining asc,
  warn state per spec.
- New OverlayTarget: same bars but grouped under a small target-name
  header when the name is known; "(target)" group otherwise.
- Dashboard "Active Timers" panel splits into two stacked sections (Buffs /
  On enemies) driven by the same lane field.
- Mock mode: mock driver emits lanes so all four overlays demo standalone.

## Sequencing

Implement AFTER the legends-companion-integration workflow merges (it owns
app/** and the engine right now). One agent pass + screenshot verify +
spam re-audit is sufficient; the engine lane field is additive.
