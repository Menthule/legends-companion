#!/usr/bin/env python3
"""Generate trigger packs from the extracted spell data (stdlib only).

Reads <repo>/fixtures/local/spell_summary.json (produced by
extract_spells.py — run that first if the file is missing) and writes:

  triggers/generated/enemy-casts.json
      "<mob> begins casting <spell>." alerts, grouped by danger category
      with merged alternations. Tier-1 categories (Gate, Complete Heal,
      death touch = Cazic Touch, fears, charms, mezzes, dispels, dragon
      breath AoEs, Avatar, Gravity Flux) default on; everything else —
      including trash-mob spam like minor heals, Harm Touch, Tainted
      Breath and lifetaps — present but default off (spam-audited
      against fixtures/local/eqlog_full.txt).

  triggers/generated/buffs-<class>.json  (x16, lowercase class names)
      Per-class buff duration timers: one "You begin casting <Spell>."
      StartTimer trigger per castable beneficial duration spell (>= 30 s,
      non-permanent), duration estimated at level 50 (capped), warn at
      min(10 s, 15%). Each StartTimer carries duration_formula +
      duration_cap_ticks so the engine can rescale the duration to the
      profile's level, and lane "buff" so the bar lands on the buffs
      overlay. Plus deduplicated wear-off Speak triggers — ONE
      per distinct wear-off message, named after the alphabetically-first
      colliding castable spell (unless WEAR_OFF_LIKELY overrides the
      name), placed in the file of that trigger's first class, default
      off when the message is shared by more than three spells (too
      ambiguous to voice).

  triggers/generated/debuffs-<class>.json  (x16)
      Per-class enemy-effect timers: one "You begin casting <Spell>."
      StartTimer trigger (lane "enemy") per castable detrimental duration
      spell (>= 12 s, non-permanent), same level-rescaling metadata as the
      buff packs — plus ONE wear-off companion per spell wired to the
      Legends "Your <Spell> spell has worn off of <target>." line:
      CancelTimer (drops the countdown early on mez break / mob death) and
      an Alerts-overlay re-announce with explicit severity. Cast-start lines carry no target, so v1
      keys enemy timers by spell name only (two mobs mezzed with the same
      spell share one bar; the first wear-off cancels it). ALL enemy timers
      default-ON: a bar only starts when YOU cast that exact spell, and
      triggers are class/loadout-gated, so enabling them creates no clutter
      and is exactly what a DoT/debuff tracker is for. Worn-off companions
      are always on too (harmless when the cast is off) and a structural
      check asserts every cast timer has one, so a started bar always clears.
      (class, spell) pairs already covered by curated cast timers (enchanter
      mez trio, shaman Walking Sleep) are skipped entirely so the same cast
      never starts two bars.

The curated packs in triggers/curated/ are hand-maintained — this script
does not touch them. Patterns avoid lookarounds entirely (the real engine
is Rust `regex`, which has none); only plain alternation, anchors, and
non-capturing groups are used.

Usage:
    python3 generate_packs.py [--summary PATH] [--out-dir PATH]
"""

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Lowercase keys as used in spell_summary.json -> exact class name strings
# from the schema contract (and file order for wear-off placement).
CLASSES = [
    ("warrior", "Warrior"), ("cleric", "Cleric"), ("paladin", "Paladin"),
    ("ranger", "Ranger"), ("shadowknight", "ShadowKnight"), ("druid", "Druid"),
    ("monk", "Monk"), ("bard", "Bard"), ("rogue", "Rogue"),
    ("shaman", "Shaman"), ("necromancer", "Necromancer"), ("wizard", "Wizard"),
    ("magician", "Magician"), ("enchanter", "Enchanter"),
    ("beastlord", "Beastlord"), ("berserker", "Berserker"),
]
CLASS_NAME = dict(CLASSES)
CLASS_ORDER = [lc for lc, _ in CLASSES]
# Named so the timer engine can select a rank timing variant without creating
# one trigger per rank. `rank` is absent for the base spell.
RANK_SUFFIX = r"(?: (?P<rank>[IVXLCDM]+))?"

MIN_BUFF_DURATION_SECS = 30
MIN_DEBUFF_DURATION_SECS = 12  # 2 ticks — captures short real DoTs (Ignite
# Bones, Fire); admits bard songs too (user opted in 2026-07-04), which is
# fine now that enemy timers only produce a bar when the spell is actually cast.
PERMANENT_FORMULA = 50
WEAR_OFF_AMBIGUOUS_ABOVE = 3  # shared by > 3 spells -> default off

# Wear-off collisions where the spell everyone actually has is NOT the
# alphabetically-first castable one: message -> spell name to announce.
# Keeps default-on collision triggers from voicing the wrong spell (and
# lets the curated packs use byte-identical patterns so the engine's
# fire-dedupe collapses the pair).
WEAR_OFF_LIKELY = {
    "The spirit of wolf leaves you.": "Spirit of Wolf",
}

# Invisibility-type buffs all share ONE timer named "Invisibility". Every
# classic invis is a random-duration effect (duration formula 3), so a
# per-spell countdown lies — invis breaks whenever the game decides. A single
# shared bar that CANCELS on the drop lines ("You feel yourself starting to
# appear." / "You appear." and each variant's own wear-off message) is far more
# useful; losing the exact variant name on the bar is an acceptable tradeoff.
# "See Invisible" is detection of OTHER players' invis, NOT self-invis — it must
# never be grouped or renamed.
INVIS_TIMER_NAME = "Invisibility"
INVIS_RX = re.compile(
    r"invisib|camouflage|gather shadows|cloak of shadow|shroud of stealth|"
    r"natural invisibility|vampyre invisibility",
    re.I,
)
SEE_INVIS_RX = re.compile(r"see invis", re.I)


def is_invis_spell(name):
    """True for self-invisibility buffs (which share the 'Invisibility' timer),
    excluding the 'See Invisible' detection line."""
    return bool(INVIS_RX.search(name)) and not SEE_INVIS_RX.search(name)

# ---------------------------------------------------------------------------
# Enemy-cast danger taxonomy (curated name lists, intersected with the spell
# data so typos fail loudly). Sources: docs/research-triggers.md digest +
# spells seen live in fixtures/local/eqlog_full.txt.
# ---------------------------------------------------------------------------
TIER1_GROUPS = [
    # (slug, category leaf, spell names). Gate is special-cased below.
    # Tier-1 heals = Complete Heal ONLY: the minor heal lines fired 409
    # times in the 6.3-active-hour fixture log (every trash self-heal) and
    # live in the default-off "heals-other" tier-2 group instead.
    ("heals", "Heals", [
        "Complete Heal",
    ]),
    # True death touch only. Harm Touch is a common trash-SK (and player
    # pet) cast — 116 fires in the fixture log — and Cancelling of Life is
    # a lifetap per the research taxonomy; both are tier-2.
    ("death-touch", "Death Touch", [
        "Cazic Touch",
    ]),
    ("fear", "Fear", [
        "Fear", "Invoke Fear", "Inspire Fear", "Panic", "Panic the Dead",
        "Wave of Fear", "Dragon Roar", "Terrorize Animal", "Chase the Moon",
    ]),
    ("charm", "Charm", [
        "Charm", "Beguile", "Cajoling Whispers", "Allure",
        "Boltran's Agacerie", "Charm Animals", "Beguile Animals",
        "Call of Karana", "Beguile Undead", "Dominate Undead",
        "Cajole Undead", "Thrall of Bones", "Enslave Death", "Dictate",
    ]),
    ("mesmerize", "Mesmerize", [
        "Mesmerize", "Mesmerization", "Sathir's Mesmerization",
        "Mesmerizing Breath", "Enthrall", "Entrance", "Dazzle",
        "Walking Sleep", "Rapture", "Glamour of Kintaz",
    ]),
    ("dispel", "Dispel", [
        "Cancel Magic", "Nullify Magic", "Annul Magic", "Neutralize Magic",
        "Taper Enchantment", "Strip Enchantment", "Pillage Enchantment",
        "Recant Magic",
    ]),
    # Genuine dragon breath AoEs only. Tainted Breath (a low-level
    # single-target poison DoT that trash snakes/shamans spam — all 64
    # breath fires in the fixture log) lives in tier-2 "poison-breath".
    ("breath-aoe", "Breath AoE", [
        "Lava Breath", "Frost Breath", "Ice Breath", "Fire Breath",
    ]),
    ("avatar", "Avatar", ["Avatar Power", "Avatar Snare"]),
    ("gravity-flux", "Gravity Flux", ["Gravity Flux"]),
]

TIER2_GROUPS = [
    ("heals-other", "Heals (minor)", [
        "Superior Healing", "Greater Healing", "Healing", "Light Healing",
        "Minor Healing", "Chloroblast", "Kragg's Salve", "Lay on Hands",
    ]),
    ("harm-touch", "Harm Touch", ["Harm Touch"]),
    ("poison-breath", "Poison Breath", [
        "Tainted Breath", "Poison Breath", "Noxious Breath",
    ]),
    ("lifetap", "Lifetap", [
        "Lifetap", "Lifespike", "Deadly Lifetap", "Life Leech", "Lifedraw",
        "Siphon Life", "Spirit Tap", "Drain Soul", "Drain Spirit",
        "Cancelling of Life",
    ]),
    ("root-snare", "Root & Snare", [
        "Root", "Grasping Roots", "Enveloping Roots", "Engulfing Roots",
        "Engorging Roots", "Ensnare", "Snare", "Enstill", "Instill",
        "Paralyzing Earth", "Fetter", "Bonds of Force",
        "Atol's Spectral Shackles", "Tangling Weeds", "Clinging Darkness",
        "Engulfing Darkness", "Dooming Darkness", "Cascading Darkness",
        "Devouring Darkness",
    ]),
    ("stun", "Stun", [
        "Stun", "Holy Might", "Sound of Force", "Tishan's Clash",
        "Markar's Clash", "Color Flux", "Color Shift", "Color Skew",
        "Color Slant", "Force",
    ]),
    ("debuff", "Debuff", [
        "Tashan", "Tashani", "Tashania", "Tashanian", "Malaise",
        "Malaisement", "Malosi", "Malosini", "Cripple", "Incapacitate",
        "Listless Power", "Insipid Weakness", "Siphon Strength",
        "Surge of Enfeeblement", "Scent of Dusk", "Scent of Darkness",
        "Scent of Terris",
    ]),
    ("self-buff", "Self-Buff", [
        "Skin like Rock", "Skin like Steel", "Skin like Diamond",
        "Shield of Thistles", "Shield of Barbs", "Shield of Brambles",
        "Shield of Spikes", "Shield of Fire",
    ]),
]


# ---------------------------------------------------------------------------
# Debuff-pack policy (overlay-lanes spec, docs/overlay-lanes-spec.md).
# ---------------------------------------------------------------------------

# Crowd control the player casts: mez / root / snare. Cast timers for these
# default ON (losing track of a mez gets people killed). Curated name lists,
# intersected with the spell data so typos fail loudly.
CC_SPELLS = {
    # mez
    "Mesmerize", "Enthrall", "Entrance", "Dazzle", "Mesmerization",
    "Sathir's Mesmerization", "Rapture", "Glamour of Kintaz", "Walking Sleep",
    # root
    "Root", "Grasping Roots", "Enveloping Roots", "Engulfing Roots",
    "Engorging Roots", "Enstill", "Instill", "Paralyzing Earth", "Fetter",
    "Bonds of Force", "Atol's Spectral Shackles", "Immobilize",
    # snare (incl. the necro/SK darkness snare-DoT line)
    "Snare", "Ensnare", "Tangling Weeds", "Clinging Darkness",
    "Engulfing Darkness", "Dooming Darkness", "Cascading Darkness",
    "Devouring Darkness",
}

# Keep the timer/wear-off taxonomy aligned with enemy-cast groups. Charm,
# fear, and stun are CC too even though the original timer list only covered
# mez/root/snare.
CC_ENEMY_CAST_SLUGS = {"fear", "charm", "mesmerize", "root-snare", "stun"}
CC_SPELLS |= {
    spell
    for slug, _leaf, spells in (*TIER1_GROUPS, *TIER2_GROUPS)
    if slug in CC_ENEMY_CAST_SLUGS
    for spell in spells
}

# Class-defining DoTs: cast timers default ON for these (class, spell) pairs
# only — the bread-and-butter DoTs a player of that class re-applies every
# fight. Everything else detrimental is generated but default OFF (spam
# audit gate). Lowercase class keys as in spell_summary.json.
DEFAULT_ON_DOTS = {
    "necromancer": [
        "Disease Cloud", "Infectious Cloud", "Heat Blood", "Boil Blood",
        "Heart Flutter", "Asystole", "Vampiric Curse", "Scourge",
        "Venom of the Snake", "Envenomed Bolt", "Splurt", "Bond of Death",
    ],
    "shaman": [
        "Sicken", "Affliction", "Plague", "Scourge", "Tainted Breath",
        "Envenomed Breath", "Venom of the Snake", "Envenomed Bolt",
    ],
    "druid": [
        "Stinging Swarm", "Creeping Crud", "Drones of Doom",
        "Drifting Death", "Flame Lick", "Immolate",
    ],
    "shadowknight": [
        "Disease Cloud", "Heat Blood", "Heart Flutter",
    ],
    "enchanter": [
        "Suffocating Sphere", "Choke", "Suffocate", "Gasping Embrace",
    ],
    "ranger": [
        "Flame Lick", "Immolate",
    ],
    "beastlord": [
        "Sicken", "Tainted Breath", "Envenomed Breath",
    ],
}

# (class, spell) cast timers the curated packs already own — skipped here so
# one cast never starts two bars. The mez timers share the exact cast
# pattern; base Root is covered by the curated target-keyed root-landed
# trigger ("<mob>'s feet adhere...") for the classes it applies to.
CURATED_COVERED = {
    ("enchanter", "Mesmerize"),
    ("enchanter", "Enthrall"),
    ("enchanter", "Entrance"),
    ("shaman", "Walking Sleep"),
    ("enchanter", "Root"),
    ("wizard", "Root"),
}


def rx_escape(name: str) -> str:
    """Escape regex metacharacters only (unlike re.escape, leaves spaces,
    apostrophes, backticks, hyphens alone so the output stays valid for the
    Rust regex crate)."""
    # Legends log text is inconsistent around possessives: spell data uses
    # apostrophes, while some client strings render the same names with
    # backticks. Treat them as equivalent in generated trigger patterns.
    out = []
    for ch in name:
        if ch in "'`":
            out.append("['`]")
        elif ch in r".^$*+?()[]{}|\\":
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def spell_rx(name: str) -> str:
    """Spell-name regex for generated client log lines.

    Legends now appends roman rank suffixes to many spell cast/wear-off
    messages ("Togor's Insects VII") while spell data and timer names remain
    keyed by the base spell name. Generated trigger patterns capture the suffix
    as `rank` for exact timing resolution but keep the base timer identity.
    """
    return rx_escape(name) + RANK_SUFFIX


def cast_start_rx(cls: str, name: str) -> str:
    """Cast-start log line for a spell as cast by class `cls`.

    Legends bards SING every spell — the log reads "You begin singing <song>."
    (see the parser's cast_sing rule and its cast_begin_bard_song test), never
    "casting" — so a bard-cast timer keyed to "You begin casting" never fires.
    All other classes cast. Note this keys off the CLASS, not the bard-song
    twist-window flag (which is False for memmed songs like Kelin's Lucid
    Lullaby), because a spell shared by a bard and a caster is sung by the bard
    and cast by the caster.
    """
    verb = "singing" if cls == "bard" else "casting"
    return rf"^You begin {verb} {spell_rx(name)}\.$"


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "x"


def alternation(names) -> str:
    # Longest-first keeps prefixes from shadowing (harmless with the \.$
    # anchor, but cheap insurance).
    return "|".join(rx_escape(n) for n in sorted(set(names), key=lambda n: (-len(n), n)))


def trigger(tid, name, pattern, actions, category, classes=(), default_enabled=True,
            comments=None):
    t = {
        "id": tid,
        "name": name,
        "pattern": pattern,
        "enabled": True,
        "default_enabled": default_enabled,
        "source": "generated",
        "category": category,
        "actions": actions,
    }
    if classes:
        t["classes"] = list(classes)
    if comments:
        t["comments"] = comments
    return t


def speak(template):
    return {"Speak": {"template": template}}


def alert(template, severity="info"):
    """Alerts-overlay action with an explicit bundled presentation default."""
    if severity not in {"info", "warn", "alarm"}:
        raise ValueError(f"invalid alert severity: {severity}")
    return {
        "Overlay": {
            "overlay": "alerts",
            "fields": {"text": template},
            "config": {"severity": severity},
        }
    }


def start_timer(name, duration_secs, warn_at_secs,
                duration_formula=None, duration_cap_ticks=None, lane=None,
                cast_time_secs=None):
    body = {"name": name, "duration_secs": duration_secs,
            "warn_at_secs": warn_at_secs}
    if cast_time_secs:
        # Cast-start triggers fire before the effect exists; the engine adds
        # this lead-in so expiry lands on the true wear-off moment.
        body["cast_time_secs"] = int(math.ceil(cast_time_secs))
    if duration_formula is not None:
        # Level-scaling metadata: the engine recomputes duration_secs from
        # the formula/cap at the profile's level (TRIGGERS_PLAN section C).
        body["duration_formula"] = duration_formula
        body["duration_cap_ticks"] = duration_cap_ticks
    if lane is not None:
        # Overlay lane routing ("buff" | "enemy" | "other"); absent lanes
        # fall back to the engine's category/id inference.
        body["lane"] = lane
    return {"StartTimer": body}


def cancel_timer(name):
    return {"CancelTimer": {"name": name}}


def build_enemy_casts(all_names):
    triggers = []

    def group_trigger(slug, leaf, names, tier1):
        present = [n for n in names if n in all_names]
        missing = sorted(set(names) - set(present))
        if missing:
            print(f"warning: enemy-cast group {slug}: not in spell data, "
                  f"dropped: {missing}", file=sys.stderr)
        if not present:
            raise SystemExit(f"enemy-cast group {slug} is empty")
        pat = rf"^(.+) begins casting ({alternation(present)}){RANK_SUFFIX}\.$"
        severity = "warn" if slug in CC_ENEMY_CAST_SLUGS else "info"
        act = speak("${1} casting ${2}") if tier1 else alert(
            "${1} casting ${2}", severity)
        return trigger(
            f"enemy-casts/{slug}",
            f"Enemy cast: {leaf}",
            pat,
            [act],
            f"Enemy Casts/{leaf}",
            default_enabled=tier1,
            comments=f"Merged alternation over {len(present)} spell names: "
                     + ", ".join(sorted(present)),
        )

    # Gate gets both the named-cast form and the classic hardcoded string
    # "%1 begins to cast the gate spell." (eqstr 1038) — both exist in Legends.
    triggers.append(trigger(
        "enemy-casts/gate",
        "Enemy cast: Gate",
        r"^(.+) (?:begins casting Gate|begins to cast the gate spell)\.$",
        [speak("${1} casting gate")],
        "Enemy Casts/Gate",
        default_enabled=True,
        comments="Matches both the Legends named form and the classic "
                 "'begins to cast the gate spell.' string (eqstr 1038).",
    ))
    for slug, leaf, names in TIER1_GROUPS:
        triggers.append(group_trigger(slug, leaf, names, tier1=True))
    for slug, leaf, names in TIER2_GROUPS:
        triggers.append(group_trigger(slug, leaf, names, tier1=False))
    # Catch-all: every named enemy cast. Off by default — spammy, but lets
    # users see everything a mob winds up.
    triggers.append(trigger(
        "enemy-casts/any",
        "Enemy cast: anything",
        r"^(.+) begins casting (.+)\.$",
        [alert("${1} casting ${2}", "info")],
        "Enemy Casts/Other",
        default_enabled=False,
        comments="Catch-all for any named cast. Overlay only; enable for "
                 "recon, not for everyday play.",
    ))
    return {"name": "Generated enemy casts", "triggers": triggers}


def eligible_buffs(spells):
    return [
        s for s in spells
        if s["beneficial"] and s["classes"]
        and s["duration_formula"] != PERMANENT_FORMULA
        and s["duration_secs_estimate"] >= MIN_BUFF_DURATION_SECS
    ]


def build_buff_packs(spells):
    elig = eligible_buffs(spells)

    # --- cast-start timers, deduped per (class, spell name): keep the rank
    # with the highest class level (ties: longest duration).
    best = {}
    for s in elig:
        for cls, lvl in s["classes"].items():
            key = (cls, s["name"])
            cur = best.get(key)
            if cur is None or (lvl, s["duration_secs_estimate"]) > \
                    (cur["classes"][cls], cur["duration_secs_estimate"]):
                best[key] = s

    per_class_triggers = {lc: [] for lc in CLASS_ORDER}
    used_ids = set()
    for (cls, name), s in sorted(best.items()):
        dur = s["duration_secs_estimate"]
        warn = min(10, int(dur * 0.15))
        invis = is_invis_spell(name)
        # Invis buffs all drive ONE shared "Invisibility" bar (random duration).
        timer_name = INVIS_TIMER_NAME if invis else name
        base = f"buffs/{cls}/cast/{slugify(name)}"
        tid, n = base, 2
        while tid in used_ids:
            tid, n = f"{base}-{n}", n + 1
        used_ids.add(tid)
        comments = (f"~{dur // 60}m{dur % 60:02d}s at level 50 "
                    f"(formula {s['duration_formula']}, "
                    f"cap {s['duration_cap_ticks']} ticks); the engine "
                    f"rescales to the profile's level; "
                    f"{CLASS_NAME[cls]} level {s['classes'][cls]}.")
        if invis:
            comments += (" Shares the 'Invisibility' timer (all invis is "
                         "random-duration); the bar clears on the appear / "
                         "wear-off line, not on this countdown.")
        per_class_triggers[cls].append(trigger(
            tid,
            f"Buff timer: {name}",
            cast_start_rx(cls, name),
            [start_timer(timer_name, dur, warn,
                         s["duration_formula"], s["duration_cap_ticks"],
                         lane="buff",
                         cast_time_secs=s.get("cast_time_secs"))],
            f"Buffs/{CLASS_NAME[cls]}/Timers",
            classes=[CLASS_NAME[cls]],
            default_enabled=True,
            comments=comments,
        ))

    # --- wear-off Speak triggers, one per distinct message.
    by_msg = defaultdict(list)          # msg -> eligible spells
    for s in elig:
        m = s["wear_off_message"].strip()
        if m:
            by_msg[m].append(s)
    global_share = defaultdict(int)     # msg -> collision count over ALL spells
    for s in spells:
        m = s["wear_off_message"].strip()
        if m in by_msg:
            global_share[m] += 1

    wear_ids = set()
    n_wear = 0
    for msg, group in sorted(by_msg.items()):
        names = sorted({g["name"] for g in group})
        group_invis = any(is_invis_spell(g["name"]) for g in group)
        first = names[0]                # alphabetically-first castable spell
        likely = WEAR_OFF_LIKELY.get(msg)
        if likely is not None:
            if likely not in names:
                raise SystemExit(f"WEAR_OFF_LIKELY[{msg!r}] = {likely!r} is "
                                 f"not a castable spell for that message "
                                 f"(candidates: {names})")
            first = likely
        union = sorted({c for g in group for c in g["classes"]},
                       key=CLASS_ORDER.index)
        home = union[0]
        shared = global_share[msg]
        base = f"buffs/wear-off/{slugify(first)}"
        tid, n = base, 2
        while tid in wear_ids:
            tid, n = f"{base}-{n}", n + 1
        wear_ids.add(tid)
        comments = f"Wear-off message: \"{msg}\""
        if shared > 1:
            others = ", ".join(n for n in names[:6] if n != first) \
                or "NPC-only ranks"
            named_how = ("the community-likely spell (WEAR_OFF_LIKELY)"
                         if likely is not None
                         else "the alphabetically-first castable spell")
            comments += (f" — shared by {shared} spells in spells_us_str "
                         f"({len(names)} castable; also: {others}). Named "
                         f"after {named_how}.")
        if group_invis:
            # Invis dropped: clear the shared "Invisibility" bar. Each invis
            # variant has its OWN wear-off line ("Your shadows fade.", "Your
            # skin stops tingling.", …) that the curated "You appear." triggers
            # don't all cover, so cancel here for full coverage. Default ON.
            wear_name = f"Invis cleared: {first}"
            actions = [cancel_timer(INVIS_TIMER_NAME)]
            default_en = True
            comments += " — invis wear-off: cancels the shared Invisibility timer."
        else:
            wear_name = f"Worn off: {first}"
            actions = [speak(f"{first} gone")]
            default_en = shared <= WEAR_OFF_AMBIGUOUS_ABOVE
        per_class_triggers[home].append(trigger(
            tid,
            wear_name,
            rf"^{rx_escape(msg)}$",
            actions,
            "Buffs/Wear-off",
            classes=[CLASS_NAME[c] for c in union],
            default_enabled=default_en,
            comments=comments,
        ))
        n_wear += 1

    packs = {}
    for lc in CLASS_ORDER:
        packs[f"buffs-{lc}.json"] = {
            "name": f"Generated buff timers — {CLASS_NAME[lc]}",
            "triggers": per_class_triggers[lc],
        }
    return packs, len(best), n_wear


def eligible_debuffs(spells):
    return [
        s for s in spells
        if not s["beneficial"] and s["classes"]
        and s["duration_formula"] != PERMANENT_FORMULA
        and s["duration_secs_estimate"] >= MIN_DEBUFF_DURATION_SECS
    ]


def build_debuff_packs(spells):
    elig = eligible_debuffs(spells)
    all_names = {s["name"] for s in spells}

    # Curated-coverage and default-on lists must reference real spells so a
    # typo (or a data update that renames a spell) fails loudly.
    for cls, name in sorted(CURATED_COVERED):
        if name not in all_names:
            raise SystemExit(f"CURATED_COVERED: {name!r} not in spell data")
    missing_cc = sorted(CC_SPELLS - all_names)
    if missing_cc:
        print(f"warning: debuffs: CC spells not in spell data, ignored: "
              f"{missing_cc}", file=sys.stderr)
    for cls, names in sorted(DEFAULT_ON_DOTS.items()):
        gone = sorted(set(names) - all_names)
        if gone:
            print(f"warning: debuffs: DEFAULT_ON_DOTS[{cls}] not in spell "
                  f"data, ignored: {gone}", file=sys.stderr)

    # A beneficial and a detrimental spell sharing one name would put the
    # identical cast pattern in both pack families; the engine's fire-dedupe
    # would then pick one arbitrarily. Skip such names here (buffs win).
    buff_names = {s["name"] for s in eligible_buffs(spells)}

    # Cast-start timers, deduped per (class, spell name) like the buffs:
    # keep the rank with the highest class level (ties: longest duration).
    best = {}
    for s in elig:
        if s["name"] in buff_names:
            continue
        for cls, lvl in s["classes"].items():
            if (cls, s["name"]) in CURATED_COVERED:
                continue
            key = (cls, s["name"])
            cur = best.get(key)
            if cur is None or (lvl, s["duration_secs_estimate"]) > \
                    (cur["classes"][cls], cur["duration_secs_estimate"]):
                best[key] = s

    per_class_triggers = {lc: [] for lc in CLASS_ORDER}
    used_ids = set()
    worn_classes = defaultdict(set)      # spell name -> classes with a timer
    for (cls, name), s in sorted(best.items()):
        dur = s["duration_secs_estimate"]
        # Ending warnings are spoken by the app ("X ending"): reserve them
        # for CC, where the break matters instantly. DoT/debuff bars just
        # run out visually — re-dot cues by voice would be TTS spam.
        warn = min(10, int(dur * 0.15)) if name in CC_SPELLS else None
        base = f"debuffs/{cls}/cast/{slugify(name)}"
        tid, n = base, 2
        while tid in used_ids:
            tid, n = f"{base}-{n}", n + 1
        used_ids.add(tid)
        kind = "CC" if name in CC_SPELLS else (
            "class-defining DoT" if name in DEFAULT_ON_DOTS.get(cls, ())
            else "DoT/debuff")
        # Every enemy timer is default-ON. A bar only starts when YOU cast
        # that exact spell, and triggers are class/loadout-gated, so a necro
        # only ever sees necro spells — enabling them all creates no clutter
        # and is precisely what a DoT/debuff tracker is for.
        per_class_triggers[cls].append(trigger(
            tid,
            f"Enemy timer: {name}",
            cast_start_rx(cls, name),
            [start_timer(name, dur, warn,
                         s["duration_formula"], s["duration_cap_ticks"],
                         lane="enemy",
                         cast_time_secs=s.get("cast_time_secs"))],
            f"Debuffs/{CLASS_NAME[cls]}/Timers",
            classes=[CLASS_NAME[cls]],
            default_enabled=True,
            comments=f"~{dur // 60}m{dur % 60:02d}s at level 50 "
                     f"(formula {s['duration_formula']}, "
                     f"cap {s['duration_cap_ticks']} ticks); {kind}; the "
                     f"engine rescales to the profile's level; "
                     f"{CLASS_NAME[cls]} level {s['classes'][cls]}. v1 keys "
                     f"enemy timers by spell name only — two mobs under the "
                     f"same spell share one bar.",
        ))
        worn_classes[name].add(cls)

    # Wear-off companions: ONE per spell, in the first class's file with the
    # class union — CancelTimer (early break) + Alerts re-announce.
    # The Legends line names the target ("Your X spell has worn off of Y.");
    # the bare form (no target) also exists, so the target is optional.
    #
    # ALWAYS default-on: a worn-off must clear the bar the instant the effect
    # fades, and an enabled worn-off is harmless when its cast timer is off
    # (it just cancels a timer that never started). Structural guarantee below
    # asserts every cast timer has one, so a started bar can always clear.
    n_worn = 0
    for name in sorted(worn_classes):
        union = sorted(worn_classes[name], key=CLASS_ORDER.index)
        home = union[0]
        base = f"debuffs/worn/{slugify(name)}"
        tid, n = base, 2
        while tid in used_ids:
            tid, n = f"{base}-{n}", n + 1
        used_ids.add(tid)
        per_class_triggers[home].append(trigger(
            tid,
            f"Enemy timer cleared: {name}",
            rf"^Your {spell_rx(name)} spell has worn off(?: of (.+))?\.$",
            [
                cancel_timer(name),
                alert(
                    f"{name} off ${{1}}",
                    "warn" if name in CC_SPELLS else "info",
                ),
            ],
            "Debuffs/Wear-off",
            classes=[CLASS_NAME[c] for c in union],
            default_enabled=True,
            comments="Cancels the cast-start countdown early (mez break, "
                     "mob death) and re-announces on the overlay. Overlay "
                     "text only — curated packs own the spoken wear-offs.",
        ))
        n_worn += 1

    # Structural completeness: every cast-timer spell MUST have a worn-off
    # companion, so an enabled bar can always clear on fade. worn_classes is
    # populated from the same `best` set, so this can only fail if the two
    # loops drift apart — fail loudly if they ever do.
    cast_names = {name for (_cls, name) in best}
    missing_worn = sorted(cast_names - set(worn_classes))
    if missing_worn:
        raise SystemExit(
            f"worn-off completeness broken — cast timers without a clear: "
            f"{missing_worn}")

    packs = {}
    for lc in CLASS_ORDER:
        packs[f"debuffs-{lc}.json"] = {
            "name": f"Generated enemy-effect timers — {CLASS_NAME[lc]}",
            "triggers": per_class_triggers[lc],
        }
    return packs, len(best), n_worn


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--summary",
                    default=os.path.join(REPO_ROOT, "fixtures", "local",
                                         "spell_summary.json"))
    ap.add_argument("--out-dir",
                    default=os.path.join(REPO_ROOT, "triggers", "generated"))
    args = ap.parse_args()

    if not os.path.exists(args.summary):
        raise SystemExit(f"{args.summary} not found — run extract_spells.py first")
    with open(args.summary, encoding="utf-8") as f:
        summary = json.load(f)
    spells = summary["spells"]
    all_names = {s["name"] for s in spells}

    os.makedirs(args.out_dir, exist_ok=True)

    def write(fname, pack):
        path = os.path.join(args.out_dir, fname)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(pack, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"wrote {path} ({len(pack['triggers'])} triggers)", file=sys.stderr)

    enemy = build_enemy_casts(all_names)
    write("enemy-casts.json", enemy)

    buff_packs, n_cast, n_wear = build_buff_packs(spells)
    for fname, pack in buff_packs.items():
        write(fname, pack)
    print(f"buff cast timers: {n_cast}, wear-off triggers: {n_wear}",
          file=sys.stderr)

    debuff_packs, n_dcast, n_dworn = build_debuff_packs(spells)
    for fname, pack in debuff_packs.items():
        write(fname, pack)
    print(f"debuff cast timers: {n_dcast}, wear-off companions: {n_dworn}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
