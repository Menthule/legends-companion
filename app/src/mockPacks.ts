// AUTO-GENERATED sample of the real trigger packs (triggers/curated + generated)
// for mock mode - a trimmed but representative slice of the v2 library so the
// Triggers tab tree demos in a plain browser. Regenerate by re-sampling the packs.

import type { TriggerSource } from "./types";

export interface MockPackTrigger {
  id: string;
  name: string;
  pattern: string;
  category: string;
  classes: string[];
  defaultEnabled: boolean;
  source: TriggerSource;
}

export const MOCK_PACK_TRIGGERS: MockPackTrigger[] = [
  {
    "id": "universal/survival/summoned",
    "name": "Summoned",
    "pattern": "^You have been summoned!",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/enraged",
    "name": "Mob enraged",
    "pattern": "^(.+) has become ENRAGED\\.",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/enrage-over",
    "name": "Enrage over",
    "pattern": "^(.+) is no longer enraged\\.",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/you-died",
    "name": "You died",
    "pattern": "^You died\\.",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/slain-by",
    "name": "Slain by",
    "pattern": "^You have been slain by (.+)!",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/ally-slain",
    "name": "Player slain nearby",
    "pattern": "^([A-Z][a-z]+) has been slain by (.+)!",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/invis-dropping",
    "name": "Invis dropping",
    "pattern": "^You feel yourself starting to appear\\.",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/invis-gone",
    "name": "Invis gone",
    "pattern": "^You (appear\\.|become visible\\.)",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/encumbered",
    "name": "Encumbered",
    "pattern": "^You are encumbered!",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/stunned",
    "name": "Stunned",
    "pattern": "^You are stunned!",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/survival/stun-over",
    "name": "Stun over",
    "pattern": "^You are no longer stunned\\.",
    "category": "Universal/Survival",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/cc/mez-broken",
    "name": "Mez broken",
    "pattern": "^(.+) has been awakened(?: by (.+))?\\.$",
    "category": "Universal/Crowd Control",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/social/tell",
    "name": "Tell received",
    "pattern": "^(\\w+) tells you,",
    "category": "Universal/Social",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/social/gm-tell",
    "name": "GM tell received",
    "pattern": "^\\[GM\\] (\\w+) tells you,",
    "category": "Universal/Social",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/progress/level-up",
    "name": "Level up",
    "pattern": "^You have gained a level!",
    "category": "Universal/Progress",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/progress/rez",
    "name": "Resurrection experience",
    "pattern": "^You regain some experience from resurrection\\.",
    "category": "Universal/Progress",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/combat/resist-out",
    "name": "Your spell resisted",
    "pattern": "^(.+) resisted your (.+)!",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "universal/combat/resist-in",
    "name": "You resisted a spell",
    "pattern": "^You resist (.+)!",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/combat/rampage",
    "name": "Mob rampage",
    "pattern": "^(.+) begins to rampage\\.",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/combat/interrupt",
    "name": "Cast interrupted (anyone)",
    "pattern": "^(.+)'s (.+) spell is interrupted\\.",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/combat/fizzle-other",
    "name": "Cast fizzled (anyone)",
    "pattern": "^(.+)'s (.+) spell fizzles!",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/combat/npc-healed",
    "name": "Target healed itself",
    "pattern": "^(.+) healed (?:him|her|it)self for (\\d+) \\((\\d+)\\) hit points by (.+)\\.",
    "category": "Universal/Combat",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/utility/hungry",
    "name": "Hungry",
    "pattern": "^You are hungry\\.",
    "category": "Universal/Utility",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/utility/thirsty",
    "name": "Thirsty",
    "pattern": "^You are thirsty\\.",
    "category": "Universal/Utility",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/social/fallen",
    "name": "Someone fell down (FD social)",
    "pattern": "^(.+) has fallen to the ground\\.",
    "category": "Universal/Social",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/progress/skill-up",
    "name": "Skill up",
    "pattern": "^You have become better at (.+)!",
    "category": "Universal/Progress",
    "classes": [],
    "defaultEnabled": false,
    "source": "curated"
  },
  {
    "id": "universal/social/group-invite",
    "name": "Group/raid invite",
    "pattern": "^(\\w+) invites you to join a (group|raid)",
    "category": "Universal/Social",
    "classes": [],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "enemy-casts/gate",
    "name": "Enemy cast: Gate",
    "pattern": "^(.+) (?:begins casting Gate|begins to cast the gate spell)\\.$",
    "category": "Enemy Casts/Gate",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/heals",
    "name": "Enemy cast: Heals",
    "pattern": "^(.+) begins casting (Complete Heal)\\.$",
    "category": "Enemy Casts/Heals",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/death-touch",
    "name": "Enemy cast: Death Touch",
    "pattern": "^(.+) begins casting (Cazic Touch)\\.$",
    "category": "Enemy Casts/Death Touch",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/fear",
    "name": "Enemy cast: Fear",
    "pattern": "^(.+) begins casting (Terrorize Animal|Chase the Moon|Panic the Dead|Inspire Fear|Wave of Fear|Dragon Roar|Invoke Fear|Panic|Fear)\\.$",
    "category": "Enemy Casts/Fear",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/charm",
    "name": "Enemy cast: Charm",
    "pattern": "^(.+) begins casting (Boltran's Agacerie|Cajoling Whispers|Beguile Animals|Dominate Undead|Thrall of Bones|Beguile Undead|Call of Karana|Cajole Undead|Charm Animals|Enslave Death|Beguile|Dictate|Allure|Charm)\\.$",
    "category": "Enemy Casts/Charm",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/mesmerize",
    "name": "Enemy cast: Mesmerize",
    "pattern": "^(.+) begins casting (Sathir's Mesmerization|Mesmerizing Breath|Glamour of Kintaz|Mesmerization|Walking Sleep|Mesmerize|Enthrall|Entrance|Rapture|Dazzle)\\.$",
    "category": "Enemy Casts/Mesmerize",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/dispel",
    "name": "Enemy cast: Dispel",
    "pattern": "^(.+) begins casting (Pillage Enchantment|Strip Enchantment|Taper Enchantment|Neutralize Magic|Nullify Magic|Cancel Magic|Recant Magic|Annul Magic)\\.$",
    "category": "Enemy Casts/Dispel",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/breath-aoe",
    "name": "Enemy cast: Breath AoE",
    "pattern": "^(.+) begins casting (Frost Breath|Fire Breath|Lava Breath|Ice Breath)\\.$",
    "category": "Enemy Casts/Breath AoE",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/avatar",
    "name": "Enemy cast: Avatar",
    "pattern": "^(.+) begins casting (Avatar Power|Avatar Snare)\\.$",
    "category": "Enemy Casts/Avatar",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/gravity-flux",
    "name": "Enemy cast: Gravity Flux",
    "pattern": "^(.+) begins casting (Gravity Flux)\\.$",
    "category": "Enemy Casts/Gravity Flux",
    "classes": [],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "enemy-casts/heals-other",
    "name": "Enemy cast: Heals (minor)",
    "pattern": "^(.+) begins casting (Superior Healing|Greater Healing|Kragg's Salve|Light Healing|Minor Healing|Lay on Hands|Chloroblast|Healing)\\.$",
    "category": "Enemy Casts/Heals (minor)",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/harm-touch",
    "name": "Enemy cast: Harm Touch",
    "pattern": "^(.+) begins casting (Harm Touch)\\.$",
    "category": "Enemy Casts/Harm Touch",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/poison-breath",
    "name": "Enemy cast: Poison Breath",
    "pattern": "^(.+) begins casting (Tainted Breath)\\.$",
    "category": "Enemy Casts/Poison Breath",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/lifetap",
    "name": "Enemy cast: Lifetap",
    "pattern": "^(.+) begins casting (Cancelling of Life|Deadly Lifetap|Drain Spirit|Siphon Life|Drain Soul|Life Leech|Spirit Tap|Lifespike|Lifedraw|Lifetap)\\.$",
    "category": "Enemy Casts/Lifetap",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/root-snare",
    "name": "Enemy cast: Root & Snare",
    "pattern": "^(.+) begins casting (Atol's Spectral Shackles|Cascading Darkness|Devouring Darkness|Engulfing Darkness|Clinging Darkness|Dooming Darkness|Enveloping Roots|Paralyzing Earth|Engorging Roots|Engulfing Roots|Bonds of Force|Grasping Roots|Tangling Weeds|Ensnare|Instill|Fetter|Snare|Root)\\.$",
    "category": "Enemy Casts/Root & Snare",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/stun",
    "name": "Enemy cast: Stun",
    "pattern": "^(.+) begins casting (Markar's Clash|Sound of Force|Tishan's Clash|Color Shift|Color Slant|Color Flux|Color Skew|Holy Might|Force|Stun)\\.$",
    "category": "Enemy Casts/Stun",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/debuff",
    "name": "Enemy cast: Debuff",
    "pattern": "^(.+) begins casting (Surge of Enfeeblement|Scent of Darkness|Insipid Weakness|Scent of Terris|Siphon Strength|Listless Power|Scent of Dusk|Incapacitate|Malaisement|Tashanian|Malosini|Tashania|Cripple|Malaise|Tashani|Malosi)\\.$",
    "category": "Enemy Casts/Debuff",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/self-buff",
    "name": "Enemy cast: Self-Buff",
    "pattern": "^(.+) begins casting (Shield of Brambles|Shield of Thistles|Skin like Diamond|Shield of Spikes|Shield of Barbs|Skin like Steel|Shield of Fire|Skin like Rock)\\.$",
    "category": "Enemy Casts/Self-Buff",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "enemy-casts/any",
    "name": "Enemy cast: anything",
    "pattern": "^(.+) begins casting (.+)\\.$",
    "category": "Enemy Casts/Other",
    "classes": [],
    "defaultEnabled": false,
    "source": "generated"
  },
  {
    "id": "class/enchanter/cc/mez-landed",
    "name": "Mez landed",
    "pattern": "^(.+) has been mesmerized\\.$",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter",
      "Bard"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/mesmerize-timer",
    "name": "Mesmerize duration",
    "pattern": "^You begin casting Mesmerize(?: (?P<rank>[IVXLCDM]+))?\\.$",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/enthrall-timer",
    "name": "Enthrall duration",
    "pattern": "^You begin casting Enthrall(?: (?P<rank>[IVXLCDM]+))?\\.$",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/entrance-timer",
    "name": "Entrance duration",
    "pattern": "^You begin casting Entrance(?: (?P<rank>[IVXLCDM]+))?\\.$",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/mez-worn-target",
    "name": "Mez worn off target",
    "pattern": "^Your (?P<spell>Mesmerize|Enthrall|Entrance)(?: (?P<rank>[IVXLCDM]+))? spell has worn off(?: of (?P<target>.+))?\\.$",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter",
      "Bard"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/charm-broken",
    "name": "Charm broke",
    "pattern": "^Your charm spell has worn off\\.",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter",
      "Bard",
      "Druid",
      "Necromancer"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/cc/root-landed",
    "name": "Root landed",
    "pattern": "^(.+)'s feet adhere to the ground\\.",
    "category": "Class/Enchanter/Crowd Control",
    "classes": [
      "Enchanter",
      "Wizard"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/debuffs/tash-landed",
    "name": "Tash landed",
    "pattern": "^(.+) glances nervously about\\.",
    "category": "Class/Enchanter/Debuffs",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/buffs/clarity-on",
    "name": "Clarity on you",
    "pattern": "^A soft breeze slips through your mind\\.",
    "category": "Class/Enchanter/Buffs",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/buffs/clarity-fading",
    "name": "Clarity fading",
    "pattern": "^The soft breeze fades\\.",
    "category": "Class/Enchanter/Buffs",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/buffs/rune-fading",
    "name": "Rune gone",
    "pattern": "^Your shielding fades\\.",
    "category": "Class/Enchanter/Buffs",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/enchanter/buffs/haste-landed",
    "name": "Haste landed",
    "pattern": "^(.+) begins to move with wonderous rapidity\\.",
    "category": "Class/Enchanter/Buffs",
    "classes": [
      "Enchanter",
      "Shaman"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/monk/fd/fallen-self",
    "name": "You hit the ground (FD)",
    "pattern": "^{C} has fallen to the ground\\.",
    "category": "Class/Monk/Feign Death",
    "classes": [
      "Monk",
      "ShadowKnight",
      "Necromancer"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/monk/fd/fd-broken-by-spell",
    "name": "FD broken by spell",
    "pattern": "^You are no longer feigning death, because a spell hit you\\.",
    "category": "Class/Monk/Feign Death",
    "classes": [
      "Monk",
      "ShadowKnight",
      "Necromancer"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/monk/abilities/mend-success",
    "name": "Mend success",
    "pattern": "^You mend your wounds and heal some damage\\.",
    "category": "Class/Monk/Abilities",
    "classes": [
      "Monk"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/monk/abilities/mend-failed",
    "name": "Mend failed",
    "pattern": "^You have failed to mend your wounds\\.",
    "category": "Class/Monk/Abilities",
    "classes": [
      "Monk"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/monk/abilities/mend-worsened",
    "name": "Mend worsened wounds",
    "pattern": "^You have worsened your wounds\\.",
    "category": "Class/Monk/Abilities",
    "classes": [
      "Monk"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/cleric/heals/ch-self-timer",
    "name": "Complete Heal cast timer",
    "pattern": "^You begin casting Complete Heal\\.",
    "category": "Class/Cleric/Heals",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "class/cleric/heals/ch-chain",
    "name": "Complete Heal chain (others)",
    "pattern": "^(\\w+) begins casting Complete Heal\\.$",
    "category": "Class/Cleric/Heals",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "curated"
  },
  {
    "id": "buffs/enchanter/cast/aanya-s-quickening",
    "name": "Buff timer: Aanya's Quickening",
    "pattern": "^You begin casting Aanya's Quickening\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/adorning-grace",
    "name": "Buff timer: Adorning Grace",
    "pattern": "^You begin casting Adorning Grace\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/alacrity",
    "name": "Buff timer: Alacrity",
    "pattern": "^You begin casting Alacrity\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/augment",
    "name": "Buff timer: Augment",
    "pattern": "^You begin casting Augment\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/augmentation",
    "name": "Buff timer: Augmentation",
    "pattern": "^You begin casting Augmentation\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/bedlam",
    "name": "Buff timer: Bedlam",
    "pattern": "^You begin casting Bedlam\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/berserker-spirit",
    "name": "Buff timer: Berserker Spirit",
    "pattern": "^You begin casting Berserker Spirit\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/berserker-strength",
    "name": "Buff timer: Berserker Strength",
    "pattern": "^You begin casting Berserker Strength\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/bind-sight",
    "name": "Buff timer: Bind Sight",
    "pattern": "^You begin casting Bind Sight\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/enchanter/cast/boon-of-the-clear-mind",
    "name": "Buff timer: Boon of the Clear Mind",
    "pattern": "^You begin casting Boon of the Clear Mind\\.$",
    "category": "Buffs/Enchanter/Timers",
    "classes": [
      "Enchanter"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/aegis",
    "name": "Buff timer: Aegis",
    "pattern": "^You begin casting Aegis\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/aegolism",
    "name": "Buff timer: Aegolism",
    "pattern": "^You begin casting Aegolism\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/ancient-gift-of-aegolism",
    "name": "Buff timer: Ancient: Gift of Aegolism",
    "pattern": "^You begin casting Ancient: Gift of Aegolism\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/ancient-high-priest-s-bulwark",
    "name": "Buff timer: Ancient: High Priest's Bulwark",
    "pattern": "^You begin casting Ancient: High Priest's Bulwark\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/armor-of-faith",
    "name": "Buff timer: Armor of Faith",
    "pattern": "^You begin casting Armor of Faith\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  },
  {
    "id": "buffs/cleric/cast/blessed-armor-of-the-risen",
    "name": "Buff timer: Blessed Armor of the Risen",
    "pattern": "^You begin casting Blessed Armor of the Risen\\.$",
    "category": "Buffs/Cleric/Timers",
    "classes": [
      "Cleric"
    ],
    "defaultEnabled": true,
    "source": "generated"
  }
];
