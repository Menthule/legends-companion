# Trigger research digest (verified sources for pack generation)

Distilled from multi-session research (P99/Quarm/TAKP community packs, EQEmu
string ids, Fabio's 987-trigger GINA pack) + direct verification against the
game's own data files and a real 84k-line Legends log. Strings marked [ESTR n]
are verified verbatim in Legends' eqstr_us.txt (id n). Do NOT use strings
listed under "ruled out".

## Game facts

- 16 classes: War Cle Pal Rng Shd Dru Mnk Brd Rog Shm Nec Wiz Mag Enc Bst Ber
  (same order as spells_us.txt class-level columns 36–51).
- Archetypes: Casters (Enc Mag Nec Wiz), Priests (Clr Dru Shm),
  Melee (Ber Mnk Rog War), Hybrids (Brd Bst Pal Rng SK).
- Tri-class: characters run up to 3 classes simultaneously; level cap 50.
- Legends NAMES enemy casts: "Nixor begins casting Gate." (real log). The
  classic generic "begins to cast a spell." never appears.
- No disciplines pre-Kunark. No native low-HP or group-HP log lines. No
  native pet-death line (use "<pet> has been slain by" instead).
- Loadouts: saved multi-class presets switchable in cities — enable state
  should eventually be per-loadout; per-character is fine for v1.

## LEGENDS-VERIFIED LINE FORMATS (from the real log — AUTHORITATIVE,
## override any classic-era format below when they conflict)

- OTHER PLAYERS' casts are named too: "Boza begins casting Invisibility."
  → CH chains are log-driven: `^(\w+) begins casting Complete Heal\.$`
- Wear-off INCLUDES TARGET: "Your Walking Sleep spell has worn off of Baron
  Telyx V`Zher." (also bare "Your X spell has worn off." and "Your pet's X
  spell has worn off.") → exact per-target mez/root/snare timers.
- RESISTS are modern 3-perspective, NOT classic "Your target resisted...":
  outgoing "A willowisp resisted your Vampiric Embrace!"; incoming "You
  resist a necro initiate's Clinging Darkness!"; third-party "A Teir`Dal
  ranger resisted Vibarn's Clinging Darkness!"
- INTERRUPTS are named + third-person: "Baron Telyx V`Zher's Healing spell
  is interrupted." → mob-heal-stopped confirmation trigger.
- Fizzles named: "Torvin's Blast of Frost spell fizzles!"
- Mez break WITH attacker (in log): "Baron Telyx V`Zher has been awakened by
  Nyasha."; mez land: "Torvin has been mesmerized."
- NPC heal lands with amount+spell: "Baron Telyx V`Zher healed himself for
  1016 (1345) hit points by Lay on Hands." → mob-healed alert.
- NPC tells use "told you," (player tells use "tells you,") — distinguishes
  vendor/quest text from real tells.
- FD in log: "Nyasha has fallen to the ground."
- Stance/invocation system lines exist: "You begin to change your stance.",
  "You begin reciting the recovery invocation."
- Enemy casts seen in the real log (tier-1 candidates confirmed live):
  Harm Touch, Cancelling of Life, Fear, Mesmerization, Root, Grasping Roots,
  Word of Shadow, Greater/Light/Healing, Lay on Hands, Stun, Tishan's Clash,
  Engulfing Darkness, Lifespike, Tashani, Instill, Chaos Flux.
- Classic gate special-case string also exists: "%1 begins to cast the gate
  spell." [ESTR 1038] — trigger BOTH forms for Gate.

## Universal triggers (tier 1 = default on)

Tier 1 survival:
- "You have been summoned!" [ESTR 1393] → speak "summoned"
- "%1 has become ENRAGED." [ESTR 1042] → speak "{1} enraged"; clear:
  "%1 is no longer enraged." [ESTR 1043]
- "You have been slain by %1!" / "You died." → speak
- "%1 has been slain by %2!" → groupmate-death awareness (exclude own kills)
- Invis break warning: "You feel yourself starting to appear." [ESTR 275]
  → speak "invis dropping"; also "You appear.", "You become visible."
- "You are encumbered!" [ESTR 12392]
- Mez break: "%1 has been awakened." [ESTR 8053] / "%1 has been awakened by
  %2." [ESTR 9037] → speak "{1} awake"
- Incoming tell: `^(\w+) tells you,` → speak "tell from {1}"; GM tell
  `^\[GM\] (\w+) tells you,`
- "You are no longer stunned." / "You are stunned!"
Tier 2 (present, off by default):
- Rez: "You regain some experience from resurrection." [ESTR 289]
- Resist out: "(.+) resisted your (.+)!" ; resist in: "You resist (.+)'s
  (.+)!" (Legends format — see authoritative section above)
- Mob rampage: "begins to rampage."
- Hunger/thirst: "You are hungry." [12487] / "You are thirsty." [12485]
- FD social: "%1 has fallen to the ground." [ESTR 1456]
- Skill up: "You have become better at %1!"
- Roll lines, "invites you to join a group", loot drops to ground.

## Enemy-cast danger taxonomy (pattern: `^(.+) begins casting (X)\.$`)

Tier 1 (default on): Gate; Complete Heal; death touches (Cazic Touch);
fears (Fear, Invoke Fear, Dragon Roar, Panic); charms; mezzes; dispels
(Cancel Magic, Annul Magic, Nullify Magic); breath AoEs (Lava Breath, Frost
Breath); lifetaps (Cancelling of Life — in the real log, Deadly Lifetap);
Avatar Power/Snare; Gravity Flux; Harm Touch.
Tier 2: single nukes, DoTs, root/snare, Tash/Malaise debuffs, mob self-buffs
(Skin like Rock, Shield of Thistles — both in the real log).
Generate the full list from spell data (detrimental + NPC-castable), curate
tier-1 membership by spell name list above.

## Per-class tier-1 essentials (curated; strings verified unless noted)

- ENC: charm break "Your charm spell has worn off."; mez landing countdowns:
  "%1 has been mesmerized." (Mesmerize ~24s, Dazzle collides), "has been
  enthralled." (48s), "has been entranced." (74s); root landing "'s feet
  adhere to the ground." (~3m, damage-break silent → countdown matters);
  Tash "glances nervously about."; Clarity self "A soft breeze slips through
  your mind." / fade "The soft breeze fades."; rune fade "Your shielding
  fades."; haste "begins to move with wonderous rapidity."
- CLR/DRU/SHM: root break "Your root spell has worn off."; SoW fade "The
  spirit of wolf leaves you." (spells_us_str 278); slow landed/fade per-spell;
  CH chain countdown (~10s from own cast); charm break (druid animal charm).
- NEC/SHD/MNK: FD fail/social "%1 has fallen to the ground." [1456] with {C};
  FD end "You no longer appear dead." (necro spell 366); "You are no longer
  feigning death, because a spell hit you."; pet slain via slain-line.
- WIZ/MAG: resist alert "Your target resisted the %1 spell."; mod-rod /
  damage-shield self fades per-spell; pet slain via slain-line.
- ROG: backstab "You backstab %1 for %2 points of damage." / "You try to
  backstab %1, but miss!"; hide fail "You failed to hide yourself."; evade
  emote "'You will not evade me, %1!'"
- WAR: taunt "You taunt %1 to ignore others and attack you!" / "You must
  target an NPC to taunt first."; bash-needs-shield line.
- MNK extra: Mend "You mend your wounds and heal some damage." / "You have
  failed to mend your wounds." / "You have worsened your wounds."
- PAL: Yaulp "You feel a surge of strength as you let forth a mighty yaulp.";
  Lay Hands → recast timer trigger (no reliable string).
- BRD: song fizzle "You miss a note, bringing your song to a close."; mez
  landing "%1 has been mesmerized."
- RNG: snare landing "has been ensnared." / fade "You are no longer
  ensnared."; SoW fade as above.
- SHD extra: Clinging Darkness landing "has been instilled with the dread of
  night."; Harm Touch recast timer.
- BST/BER: thin classic corpus — generate from spell data (Bst 118 spells,
  Ber 37) + universal; pet slain for Bst.

## Ruled out (do not ship)

- "You feel the need to get up." (absent from eqstr)
- "You feel yourself slow down" as SoW fade (wrong; real: "The spirit of
  wolf leaves you.")
- Necro/mage pet-death mind-fade lines (no such line)
- "You have been revealed" (non-classic)
- Warrior/monk discipline triggers (no discs pre-Kunark)

## Organization / enable model

Tree: Universal / Enemy Casts/<danger type> / Class/<class>/<category> /
Custom. Tri-state group checkboxes. Enable state stored per character,
separate from definitions (EQLogParser characterId+nodeId model). Buff
timers generated per class from spell data (807 castable buffs), durations
from formula at profile level.
