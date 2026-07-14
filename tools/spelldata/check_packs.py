#!/usr/bin/env python3
"""Self-check for the trigger pack library (stdlib only, exit 0 = pass).

Validates every pack under triggers/curated/ and triggers/generated/:

  * JSON parses; pack shape is {name, triggers[]}.
  * Every trigger has name/pattern/actions; optional v2 fields (id, classes,
    default_enabled, source) are well-formed; class names are the 16 exact
    contract strings; source is one of generated/curated/user/gina.
  * Trigger ids are unique across the whole library.
  * Every pattern compiles under Python `re` after expanding the {C} token
    the way the Rust engine does (smoke check only — Rust `regex` is the
    real engine, which is why lookarounds and backreferences are banned
    outright here).
  * Action objects match the Rust Action enum encoding exactly.
  * Counts: generated buff cast-timers and wear-off triggers are re-derived
    from fixtures/local/spell_summary.json and must match the packs;
    curated pack sizes are pinned.
  * Spot-verification: a handful of patterns must match real lines from
    fixtures/local/eqlog_full.txt (skipped when the fixture is absent).

Usage:  python3 tools/spelldata/check_packs.py
"""

import glob
import json
import os
import re
import sys
from collections import defaultdict

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRIGGERS = os.path.join(REPO_ROOT, "triggers")
SUMMARY = os.path.join(REPO_ROOT, "fixtures", "local", "spell_summary.json")
LOG = os.path.join(REPO_ROOT, "fixtures", "local", "eqlog_full.txt")

VALID_CLASSES = {
    "Warrior", "Cleric", "Paladin", "Ranger", "ShadowKnight", "Druid",
    "Monk", "Bard", "Rogue", "Shaman", "Necromancer", "Wizard", "Magician",
    "Enchanter", "Beastlord", "Berserker",
}
VALID_SOURCES = {"generated", "curated", "user", "gina"}
LOOKAROUND = ("(?=", "(?!", "(?<")

# Pinned curated pack sizes (update when curating new triggers).
EXPECTED_CURATED = {
    "universal.json": 48, "warrior.json": 2, "cleric.json": 2,
    "paladin.json": 2, "ranger.json": 2, "shadowknight.json": 2,
    "druid.json": 2, "monk.json": 5, "bard.json": 1, "rogue.json": 4,
    "shaman.json": 3, "necromancer.json": 2, "wizard.json": 1,
    "magician.json": 1, "enchanter.json": 12, "beastlord.json": 1,
    "berserker.json": 1, "impact.json": 3, "skills.json": 13,
}

# Patterns that must match at least one line of the real Legends log
# (trigger id -> known-present substring to pre-filter candidate lines).
SPOT_CHECKS = {
    "universal/combat/interrupt": "spell is interrupted",
    "universal/cc/mez-broken": "has been awakened",
    "class/enchanter/cc/mez-landed": "has been mesmerized",
    # (root-landed's cast-on-other form isn't in this log — only the
    # cast-on-you "Your feet adhere to the ground." appears — so Tash
    # stands in as the enchanter debuff spot-check.)
    "class/enchanter/debuffs/tash-landed": "glances nervously about",
    "class/monk/abilities/mend-success": "You mend your wounds",
    "class/druid/buffs/sow-gone": "spirit of wolf leaves you",
    "class/shaman/cc/walking-sleep-worn": "Walking Sleep spell has worn off",
    "enemy-casts/heals-other": "begins casting Light Healing",
    "enemy-casts/harm-touch": "begins casting Harm Touch",
    "enemy-casts/lifetap": "begins casting Cancelling of Life",
    "enemy-casts/any": "begins casting",
}

FAILURES = []


def fail(msg):
    FAILURES.append(msg)
    print(f"FAIL: {msg}", file=sys.stderr)


VALID_LANES = {"buff", "enemy", "other"}
VALID_SEVERITIES = {"info", "warn", "alarm"}


def check_action(where, action):
    if not isinstance(action, dict) or len(action) != 1:
        fail(f"{where}: action must be a single-variant object: {action!r}")
        return
    kind, body = next(iter(action.items()))
    if kind in ("Speak", "DisplayText"):
        if set(body) != {"template"} or not isinstance(body["template"], str):
            fail(f"{where}: bad {kind} body {body!r}")
    elif kind == "Overlay":
        if set(body) - {"overlay", "fields", "config"} or \
                not isinstance(body.get("overlay"), str) or \
                not isinstance(body.get("fields"), dict) or \
                not isinstance(body.get("config", {}), dict):
            fail(f"{where}: bad Overlay body {body!r}")
            return
        if body["overlay"] == "alerts":
            severity = body.get("config", {}).get("severity")
            if severity not in VALID_SEVERITIES:
                fail(f"{where}: Alerts Overlay needs severity info/warn/alarm")
    elif kind == "PlaySound":
        if set(body) != {"path"} or not isinstance(body["path"], str):
            fail(f"{where}: bad PlaySound body {body!r}")
    elif kind == "CancelTimer":
        if set(body) != {"name"} or not isinstance(body["name"], str) or \
                not body["name"]:
            fail(f"{where}: bad CancelTimer body {body!r}")
    elif kind == "StartTimer":
        if not {"name", "duration_secs"} <= set(body) or \
                set(body) - {"name", "duration_secs", "warn_at_secs",
                             "duration_formula", "duration_cap_ticks",
                             "lane", "cast_time_secs", "mode", "repeat_secs",
                             "stopwatch", "warn_text", "expire_text",
                             "warn_sound", "expire_sound"}:
            fail(f"{where}: bad StartTimer keys {sorted(body)}")
            return
        lane = body.get("lane")
        if lane is not None and lane not in VALID_LANES:
            fail(f"{where}: bad lane {lane!r}")
        if not isinstance(body["name"], str) or \
                not isinstance(body["duration_secs"], int) or \
                body["duration_secs"] <= 0:
            fail(f"{where}: bad StartTimer values {body!r}")
        warn = body.get("warn_at_secs")
        if warn is not None and (not isinstance(warn, int) or warn < 0):
            fail(f"{where}: bad warn_at_secs {warn!r}")
        # Optional level-scaling metadata: formula and cap travel together.
        formula = body.get("duration_formula")
        cap = body.get("duration_cap_ticks")
        if (formula is None) != (cap is None):
            fail(f"{where}: duration_formula and duration_cap_ticks must "
                 f"be set together {body!r}")
        for key, val in (("duration_formula", formula),
                         ("duration_cap_ticks", cap)):
            if val is not None and (not isinstance(val, int) or val < 0):
                fail(f"{where}: bad {key} {val!r}")
    else:
        fail(f"{where}: unknown action variant {kind!r}")


def expand_tokens(pattern):
    """Mimic the engine's pre-compile token expansion for the smoke check."""
    out = pattern
    for tok, rep in (("{C}", "Testchar"), ("{c}", "Testchar"),
                     ("{S}", "(.+)"), ("{N}", r"(\d+)")):
        out = out.replace(tok, rep)
    out = re.sub(r"\{[SsNn]\d+\}", "(.+)", out)
    return out


def load_pack(path):
    with open(path, encoding="utf-8") as f:
        pack = json.load(f)
    if not isinstance(pack.get("name"), str) or \
            not isinstance(pack.get("triggers"), list):
        fail(f"{path}: pack must be {{name, triggers[]}}")
        return None
    return pack


def main():
    pack_files = sorted(
        glob.glob(os.path.join(TRIGGERS, "curated", "*.json"))
        + glob.glob(os.path.join(TRIGGERS, "generated", "*.json"))
    )
    if len(pack_files) != 19 + 33:
        fail(f"expected 52 pack files (19 curated + 33 generated: enemy-casts"
             f" + 16 buffs + 16 debuffs), found {len(pack_files)}")

    all_ids = {}
    compiled = {}          # trigger id -> compiled python regex
    counts = {}
    cast_per_class = defaultdict(int)
    wear_off_total = 0
    wear_off_off = 0
    debuff_cast_per_class = defaultdict(int)
    debuff_cast_timer_names = set()   # StartTimer names of debuff casts
    debuff_worn_total = 0
    debuff_worn_cancel_names = set()  # CancelTimer names of worn companions

    for path in pack_files:
        rel = os.path.relpath(path, TRIGGERS)
        pack = load_pack(path)
        if pack is None:
            continue
        counts[rel] = len(pack["triggers"])
        for i, t in enumerate(pack["triggers"]):
            where = f"{rel}#{i}"
            if not isinstance(t.get("name"), str) or not t["name"]:
                fail(f"{where}: missing name")
            if not isinstance(t.get("pattern"), str) or not t["pattern"]:
                fail(f"{where}: missing pattern")
                continue
            where = f"{rel}:{t.get('id', t['name'])}"
            tid = t.get("id")
            if tid is not None:
                if not isinstance(tid, str) or not re.fullmatch(r"[a-z0-9/_-]+", tid):
                    fail(f"{where}: bad id {tid!r}")
                if tid in all_ids:
                    fail(f"{where}: duplicate id (also in {all_ids[tid]})")
                all_ids[tid] = rel
            for cls in t.get("classes", []):
                if cls not in VALID_CLASSES:
                    fail(f"{where}: invalid class name {cls!r}")
            src = t.get("source", "user")
            if src not in VALID_SOURCES:
                fail(f"{where}: invalid source {src!r}")
            icon = t.get("icon")
            if icon is not None and not re.fullmatch(r"spell:\d+", icon):
                fail(f"{where}: invalid portable icon {icon!r}")
            for key in ("enabled", "default_enabled", "case_insensitive"):
                if key in t and not isinstance(t[key], bool):
                    fail(f"{where}: {key} must be bool")
            pat = t["pattern"]
            if any(la in pat for la in LOOKAROUND) or re.search(r"\\\d", pat):
                fail(f"{where}: lookaround/backreference not allowed "
                     f"(Rust regex has none): {pat}")
            try:
                rx = re.compile(expand_tokens(pat))
                if tid:
                    compiled[tid] = rx
            except re.error as e:
                fail(f"{where}: pattern does not compile: {e}: {pat}")
            actions = t.get("actions")
            if not isinstance(actions, list) or not actions:
                fail(f"{where}: actions must be a non-empty list")
                continue
            for a in actions:
                check_action(where, a)
            # Tally generated buff shapes for the count cross-check.
            if tid and tid.startswith("buffs/wear-off/"):
                wear_off_total += 1
                if t.get("default_enabled", True) is False:
                    wear_off_off += 1
            elif tid and re.match(r"buffs/[a-z]+/cast/", tid):
                cast_per_class[tid.split("/")[1]] += 1
                # Lane lint: generated buff timers route to the buffs lane.
                for a in actions:
                    if "StartTimer" in a and \
                            a["StartTimer"].get("lane") != "buff":
                        fail(f"{where}: buff cast timer must carry "
                             f"lane \"buff\"")
            elif tid and re.match(r"debuffs/[a-z]+/cast/", tid):
                debuff_cast_per_class[tid.split("/")[1]] += 1
                # Lane lint: generated enemy-effect timers route to the
                # target overlay.
                for a in actions:
                    if "StartTimer" in a:
                        if a["StartTimer"].get("lane") != "enemy":
                            fail(f"{where}: debuff cast timer must carry "
                                 f"lane \"enemy\"")
                        debuff_cast_timer_names.add(a["StartTimer"]["name"])
            elif tid and tid.startswith("debuffs/worn/"):
                debuff_worn_total += 1
                has_cancel = False
                for a in actions:
                    if "CancelTimer" in a:
                        has_cancel = True
                        debuff_worn_cancel_names.add(a["CancelTimer"]["name"])
                    if "Speak" in a:
                        fail(f"{where}: debuff worn companions must not "
                             f"speak (curated packs own wear-off TTS)")
                if not has_cancel:
                    fail(f"{where}: debuff worn companion lacks CancelTimer")

    # --- pinned curated counts
    for fname, expect in EXPECTED_CURATED.items():
        rel = os.path.join("curated", fname)
        got = counts.get(rel)
        if got != expect:
            fail(f"{rel}: expected {expect} triggers, found {got}")

    # --- re-derive generated counts from the spell data
    if os.path.exists(SUMMARY):
        with open(SUMMARY, encoding="utf-8") as f:
            spells = json.load(f)["spells"]
        elig = [s for s in spells
                if s["beneficial"] and s["classes"]
                and s["duration_formula"] != 50
                and s["duration_secs_estimate"] >= 30]
        expect_cast = len({(c, s["name"]) for s in elig for c in s["classes"]})
        got_cast = sum(cast_per_class.values())
        if got_cast != expect_cast:
            fail(f"buff cast timers: packs have {got_cast}, "
                 f"spell data implies {expect_cast}")
        expect_wear = len({s["wear_off_message"].strip() for s in elig
                           if s["wear_off_message"].strip()})
        if wear_off_total != expect_wear:
            fail(f"wear-off triggers: packs have {wear_off_total}, "
                 f"spell data implies {expect_wear}")
        if not 0 < wear_off_off < wear_off_total:
            fail(f"wear-off default-off split looks wrong: "
                 f"{wear_off_off}/{wear_off_total}")
        ec = counts.get(os.path.join("generated", "enemy-casts.json"), 0)
        if ec != 19:
            fail(f"enemy-casts.json: expected 19 merged triggers, found {ec}")

        # --- debuff packs: re-derive counts with the generator's own policy
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import generate_packs as gp
        buff_names = {s["name"] for s in gp.eligible_buffs(spells)}
        expect_pairs = {
            (c, s["name"])
            for s in gp.eligible_debuffs(spells)
            if s["name"] not in buff_names
            for c in s["classes"]
        } - gp.CURATED_COVERED
        got_dcast = sum(debuff_cast_per_class.values())
        if got_dcast != len(expect_pairs):
            fail(f"debuff cast timers: packs have {got_dcast}, "
                 f"spell data implies {len(expect_pairs)}")
        expect_worn = len({name for _, name in expect_pairs})
        if debuff_worn_total != expect_worn:
            fail(f"debuff worn companions: packs have {debuff_worn_total}, "
                 f"spell data implies {expect_worn}")
    else:
        print("note: spell_summary.json missing — skipped generated-count "
              "cross-check", file=sys.stderr)

    # --- debuff pairing: every cast timer has a worn CancelTimer companion
    unpaired = debuff_cast_timer_names - debuff_worn_cancel_names
    if unpaired:
        fail(f"debuff cast timers without a worn CancelTimer companion: "
             f"{sorted(unpaired)[:5]} (+{max(0, len(unpaired) - 5)} more)")

    # --- spot-verify patterns against the real log
    if os.path.exists(LOG):
        needles = {tid: (sub, compiled.get(tid))
                   for tid, sub in SPOT_CHECKS.items()}
        for tid, (sub, rx) in needles.items():
            if rx is None:
                fail(f"spot-check: trigger id {tid} not found in packs")
        hits = {tid: 0 for tid in needles}
        with open(LOG, encoding="latin-1") as f:
            for line in f:
                msg = line.rstrip("\r\n")
                if len(msg) > 27 and msg[0] == "[":
                    msg = msg[27:]  # strip "[Day Mon DD HH:MM:SS YYYY] "
                for tid, (sub, rx) in needles.items():
                    if rx is not None and sub in msg and rx.search(msg):
                        hits[tid] += 1
        for tid, n in hits.items():
            if needles[tid][1] is not None and n == 0:
                fail(f"spot-check: {tid} matched 0 lines of eqlog_full.txt")
            else:
                print(f"spot-check ok: {tid} matched {n} lines",
                      file=sys.stderr)
    else:
        print("note: eqlog_full.txt missing — skipped log spot-checks",
              file=sys.stderr)

    total = sum(counts.values())
    print(f"\npacks: {len(counts)}, triggers: {total}, unique ids: {len(all_ids)}")
    for rel in sorted(counts):
        print(f"  {rel:40} {counts[rel]}")
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s)", file=sys.stderr)
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
