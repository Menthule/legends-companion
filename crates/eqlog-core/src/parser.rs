//! Line parser: raw log line -> `ParsedLine`.
//!
//! Design notes:
//! - The fixed-width 27-char timestamp prefix (`[Thu Jul 02 23:32:46 2026] `)
//!   is parsed manually (month-name lookup + days-from-civil epoch math, naive
//!   local time, no timezone).
//! - Classification uses cheap substring/prefix gates before touching any
//!   regex — this runs on every line during combat bursts.
//! - All regexes are compiled once in [`Parser::new`].

use crate::events::{ChatChannel, Entity, Event, HitFlags, LogLine, MissKind, ParsedLine};
use regex::Regex;

/// Melee verbs as they appear in third person (`X slashes Y for ...`).
const MELEE_VERBS_3P: &str = "hits|slashes|pierces|crushes|bashes|kicks|punches|cleaves|strikes|bites|claws|shoots|backstabs|gores|mauls|smashes|slams|slices|rends|stings|frenzies on";
/// Melee verbs in the first-person form (`You crush Y for ...`).
const MELEE_VERBS_YOU: &str = "hit|slash|pierce|crush|bash|kick|punch|cleave|strike|bite|claw|shoot|backstab|gore|maul|smash|slam|slice|rend|sting|frenzy on";

struct Regexes {
    // Melee
    melee_hit_you: Regex,
    melee_hit: Regex,
    melee_miss_you: Regex,
    melee_miss: Regex,
    // Spell damage
    spell_damage: Regex,
    taken_you: Regex,
    taken_from_your: Regex,
    taken: Regex,
    taken_unattributed: Regex,
    non_melee: Regex,
    // Heals
    heal: Regex,
    // Casting
    cast_begin: Regex,
    cast_sing: Regex,
    interrupted_your: Regex,
    interrupted: Regex,
    fizzle_your: Regex,
    fizzle: Regex,
    // Resists / buffs
    resisted_your: Regex,
    resisted: Regex,
    resist_you: Regex,
    worn_off: Regex,
    // Deaths
    slain_by: Regex,
    slain_you: Regex,
    died: Regex,
    // Loot / rolls
    loot_bracketed: Regex,
    loot_sold: Regex,
    loot_create: Regex,
    roll_one_line: Regex,
    roll_announce: Regex,
    roll_result: Regex,
    // Chat
    chat_tells_you: Regex,
    chat_told_you: Regex,
    chat_you_told: Regex,
    chat_group: Regex,
    chat_you_group: Regex,
    chat_guild: Regex,
    chat_you_guild: Regex,
    chat_numbered: Regex,
    chat_shout: Regex,
    chat_auction: Regex,
    chat_ooc: Regex,
    chat_you_ooc: Regex,
    chat_say: Regex,
    chat_you_say: Regex,
    // Misc
    xp: Regex,
    level_up: Regex,
    faction: Regex,
    zone: Regex,
    location: Regex,
    // System noise recognizers
    sys_flavor: Regex,
}

/// Parses log lines into typed events. Construct once, reuse (compiles
/// regexes).
pub struct Parser {
    re: Regexes,
}

impl Parser {
    pub fn new() -> Self {
        let re = Regexes {
            melee_hit_you: Regex::new(&format!(
                r"^You (?P<v>{MELEE_VERBS_YOU}) (?P<t>.+?) for (?P<n>\d+) points? of damage\.$"
            ))
            .unwrap(),
            melee_hit: Regex::new(&format!(
                r"^(?P<a>.+?) (?P<v>{MELEE_VERBS_3P}) (?P<t>.+?) for (?P<n>\d+) points? of damage\.$"
            ))
            .unwrap(),
            // The verb is one word except "frenzy on" (the miss form is the
            // infinitive after "try/tries to", matching the hit-side verb
            // lists); leftmost-first alternation prefers the two-word form.
            melee_miss_you: Regex::new(
                r"^You try to (?P<v>frenzy on|\S+) (?P<t>.+?), but (?P<rest>.+)!$",
            )
            .unwrap(),
            melee_miss: Regex::new(
                r"^(?P<a>.+?) tries to (?P<v>frenzy on|\S+) (?P<t>.+?), but (?P<rest>.+)!$",
            )
            .unwrap(),
            spell_damage: Regex::new(
                r"^(?P<c>.+?) hit (?P<t>.+?) for (?P<n>\d+) points? of (?:\w+) damage by (?P<s>.+)\.$",
            )
            .unwrap(),
            taken_you: Regex::new(
                r"^You have taken (?P<n>\d+) damage from (?P<s>.+) by (?P<src>.+?)\.$",
            )
            .unwrap(),
            taken_from_your: Regex::new(
                r"^(?P<t>.+?) has taken (?P<n>\d+) damage from your (?P<s>.+)\.$",
            )
            .unwrap(),
            taken: Regex::new(
                r"^(?P<t>.+?) has taken (?P<n>\d+) damage from (?P<s>.+) by (?P<src>.+?)\.$",
            )
            .unwrap(),
            taken_unattributed: Regex::new(
                r"^(?P<t>.+?) ha(?:s|ve) taken (?P<n>\d+) damage by (?P<s>.+)\.$",
            )
            .unwrap(),
            non_melee: Regex::new(
                r"^(?P<t>.+?) (?:is|are) \w+ by (?P<src>.+) for (?P<n>\d+) points? of non-melee damage[.!]$",
            )
            .unwrap(),
            heal: Regex::new(
                r"^(?P<h>.+?) healed (?P<t>.+?)(?P<ot> over time)? for (?P<n>\d+)(?: \((?P<p>\d+)\))? hit points(?: by (?P<s>[^.]+))?\.$",
            )
            .unwrap(),
            cast_begin: Regex::new(r"^(?P<c>.+?) begins casting (?P<s>.+)\.$").unwrap(),
            cast_sing: Regex::new(r"^(?P<c>.+?) begins? singing (?P<s>.+)\.$").unwrap(),
            interrupted_your: Regex::new(r"^Your (?P<s>.+) spell is interrupted\.$").unwrap(),
            interrupted: Regex::new(r"^(?P<c>.+?)'s (?P<s>.+) spell is interrupted\.$").unwrap(),
            fizzle_your: Regex::new(r"^Your (?P<s>.+) spell fizzles!$").unwrap(),
            fizzle: Regex::new(r"^(?P<c>.+?)'s (?P<s>.+) spell fizzles!$").unwrap(),
            resisted_your: Regex::new(r"^(?P<t>.+?) resisted your (?P<s>.+)!$").unwrap(),
            resisted: Regex::new(r"^(?P<t>.+?) resisted (?P<c>.+?)'s (?P<s>.+)!$").unwrap(),
            resist_you: Regex::new(r"^You resist (?P<c>.+?)'s (?P<s>.+)!$").unwrap(),
            worn_off: Regex::new(
                r"^Your (?P<pet>pet's )?(?P<s>.+?) spell has worn off(?: of (?P<w>[^.]+))?\.$",
            )
            .unwrap(),
            slain_by: Regex::new(r"^(?P<v>.+?) ha(?:s|ve) been slain by (?P<k>.+)!$").unwrap(),
            slain_you: Regex::new(r"^You have slain (?P<v>.+)!$").unwrap(),
            died: Regex::new(r"^(?P<v>.+) died\.$").unwrap(),
            loot_bracketed: Regex::new(
                r"^--(?P<l>.+?) ha(?:s|ve) looted (?P<i>.+) from (?P<c>.+)\.--$",
            )
            .unwrap(),
            loot_sold: Regex::new(
                r"^You looted (?P<i>.+?) from (?P<c>.+?) and (?:sold it for .+|stored it in .+)$",
            )
            .unwrap(),
            loot_create: Regex::new(r"^You looted (?P<i>.+?) from (?P<c>.+?) to create .+$")
                .unwrap(),
            roll_one_line: Regex::new(
                r"^\*\*A Magic Die is rolled by (?P<r>\S+)\.\s*(?:\*\*)?It could have been any number from (?P<min>\d+) to (?P<max>\d+), but this time it turned up a (?P<res>\d+)\.$",
            )
            .unwrap(),
            roll_announce: Regex::new(r"^\*\*A Magic Die is rolled by (?P<r>\S+)\.$").unwrap(),
            roll_result: Regex::new(
                r"^\*\*It could have been any number from (?P<min>\d+) to (?P<max>\d+), but this time it turned up a (?P<res>\d+)\.$",
            )
            .unwrap(),
            chat_tells_you: Regex::new(r"^(?P<sp>\S+) tells you, '(?P<t>.*)'$").unwrap(),
            chat_told_you: Regex::new(r"^(?P<sp>.+?) told you, '(?P<t>.*)'$").unwrap(),
            chat_you_told: Regex::new(r"^You told (?P<to>\S+?),? '(?P<t>.*)'$").unwrap(),
            chat_group: Regex::new(r"^(?P<sp>\S+) tells the group, '(?P<t>.*)'$").unwrap(),
            chat_you_group: Regex::new(r"^You tell your party, '(?P<t>.*)'$").unwrap(),
            chat_guild: Regex::new(r"^(?P<sp>\S+) tells the guild, '(?P<t>.*)'$").unwrap(),
            chat_you_guild: Regex::new(r"^You say to your guild, '(?P<t>.*)'$").unwrap(),
            chat_numbered: Regex::new(
                r"^(?P<sp>\S+) tells? (?P<ch>[A-Za-z][A-Za-z0-9]*):(?P<n>\d+), '(?P<t>.*)'$",
            )
            .unwrap(),
            chat_shout: Regex::new(r"^(?P<sp>\S+) shouts?, '(?P<t>.*)'$").unwrap(),
            chat_auction: Regex::new(r"^(?P<sp>\S+) auctions?, '(?P<t>.*)'$").unwrap(),
            chat_ooc: Regex::new(r"^(?P<sp>\S+) says out of character, '(?P<t>.*)'$").unwrap(),
            chat_you_ooc: Regex::new(r"^You say out of character, '(?P<t>.*)'$").unwrap(),
            chat_say: Regex::new(r"^(?P<sp>.+?) says, '(?P<t>.*)'$").unwrap(),
            chat_you_say: Regex::new(r"^You say, '(?P<t>.*)'$").unwrap(),
            xp: Regex::new(r"^You gain (?P<party>party )?experience!(?: \((?P<p>\d+(?:\.\d+)?)%\))?$")
                .unwrap(),
            level_up: Regex::new(r"^You have gained a level! Welcome to level (?P<l>\d+)!$")
                .unwrap(),
            faction: Regex::new(
                r"^Your faction standing with (?P<f>.+?) has been adjusted by (?P<d>-?\d+)\.$",
            )
            .unwrap(),
            zone: Regex::new(r"^You have entered (?P<z>.+)\.$").unwrap(),
            location: Regex::new(
                r"^Your Location is (?P<x>-?\d+(?:\.\d+)?), (?P<y>-?\d+(?:\.\d+)?), (?P<z>-?\d+(?:\.\d+)?)$",
            )
            .unwrap(),
            // Third-person spell-landing / emote flavor lines ("X staggers.",
            // "X is surrounded by darkness.", "X's blood simmers.", ...).
            // These are open-ended (one per spell), so this recognizer matches
            // predicate families observed in the real logs.
            sys_flavor: Regex::new(
                r"(?x)
                  \b(?:is|are)\ (?:surrounded|engulfed|enveloped|shrouded|cloaked|coated|consumed|pelted|bathed|embraced|covered|blinded|encased|drenched|immobilized|mesmerized|withered|struck|chilled|burned|wracked|healed|protected|caught|held|slowed|weakened)\b
                | \b(?:staggers?|winces?|yawns?|pales?|blinks|shivers|shudders|trembles|flinches|stumbles|twitches|screams|groans|sways)\b
                | \bdoubles?\ over\ in\ pain
                | \bwrithes?\ in\b
                | \bblood\ (?:simmers|boils|cools)
                | \bskin\ (?:ignites|freezes|smolders|singes|cools|turns|crawls|gleams|hardens)
                | \bsinges\ as\ the\b
                | \beyes\ gleam
                | \bfeels?\ (?:much\ |a\ little\ )?(?:better|faster|slower)
                | \bfeels\ a\ healing\ touch
                | \bgoes\ berserk
                | \bfoams\ at\ the\ mouth
                | \blets\ loose\ a\b
                | \bbody\ pulses\ with\b
                | \bbody\ spasms\b
                | \bhands\ begin\ to\ glow
                | \b(?:is|are)\ (?:entwined|imbued|quickened)\ (?:by|with)\b
                | \bskin\ (?:looks\ like|goes\ numb)
                | \bbegins\ to\ walk\ faster
                | \bhas\ been\ awakened\ by\b
                | \bhas\ fallen\ to\ the\ ground
                | \bsurges\ through\ your\ body
                | \bsurrounds\ you\.$
                | \bwashes\ over\ you\.$
                | \bcovers\ your\ hand
                | \bhead\ nods
                | \bfailed\ to\ taunt\b
                | \bhas\ captured\ .+\ attention!$
                | \bfeels?\ the\ favor
                | \blooks?\ (?:more|less|brave|sad|courageous|stronger|weaker|healthier|dexterous|agile|frightened|friendly|very)\b
                | \bfades\ away\.$
                | \bfades\.$
                | \badheres\ to\ the\ ground
                | \bhas\ been\ (?:poisoned|diseased|mesmerized|struck\ by\ lightning)\b
                | \banimates\ an?\ undead\ servant
                | \bglances\ nervously\ about
                | \bmovements?\ slow\ as\b
                | \bwounds\ (?:begin|stop|turn|disappear)\b
                | \bbursts\ into\ flame
                | \bshrinks\.$
                | \bin\ the\ grip\ of\b
                | \bbegins\ to\ (?:regenerate|glow|shrink|grow|shine)\b
                | \bregains?\ concentration
                | \bmagical\ skin\ absorbs\b
                | \bliving\ shield!$
                | \bceases\ protecting\b
                | \bwas\ partially\ successful\ in\ capturing\b
                | \bcompleted\ achievement:
                | \bpain\ of\ a\ thousand\ stings
                | \bis\ tormented\ by\b
                | \bstops\ bleeding
                | \bwither\ away\.$
                ",
            )
            .unwrap(),
        };
        Parser { re }
    }

    /// Parse one raw line (including the `[timestamp] ` prefix).
    /// Returns `None` only for lines with no valid timestamp prefix
    /// (e.g. wrapped/garbage lines).
    pub fn parse_line(&self, raw: &str) -> Option<ParsedLine> {
        let (timestamp, message) = split_timestamp(raw)?;
        let event = self.classify(message);
        Some(ParsedLine {
            line: LogLine {
                timestamp,
                message: message.to_string(),
            },
            event,
        })
    }

    /// Classify a message (timestamp already stripped).
    fn classify(&self, m: &str) -> Event {
        // --- Chat first: quoted text can contain anything, including strings
        // that would otherwise look like combat lines.
        if m.contains(", '") || m.contains(",  '") {
            if let Some(ev) = self.try_chat(m) {
                return ev;
            }
        }

        // --- Damage / combat families, gated on cheap substrings.
        if m.contains("non-melee damage") {
            if let Some(ev) = self.try_non_melee(m) {
                return ev;
            }
        }
        if m.contains(" damage from ") {
            if let Some(ev) = self.try_spell_damage_taken(m) {
                return ev;
            }
        }
        if m.contains(" damage by ") {
            if let Some(ev) = self.try_spell_damage(m) {
                return ev;
            }
            // `Vibarn has taken 58 damage by Searing Arrow.` — spell damage
            // with no attributed caster; carried as unattributed
            // NonMeleeDamage so meters still count the damage taken.
            let (core, _flags) = strip_flags(m);
            if let Some(c) = self.re.taken_unattributed.captures(core) {
                if let Ok(amount) = c["n"].parse() {
                    return Event::NonMeleeDamage {
                        source: None,
                        target: entity(&c["t"]),
                        effect: c["s"].to_string(),
                        amount,
                    };
                }
            }
        }
        if m.contains(" point of damage") || m.contains(" points of damage") {
            if let Some(ev) = self.try_melee_hit(m) {
                return ev;
            }
        }
        if m.contains(", but ") {
            if let Some(ev) = self.try_melee_miss(m) {
                return ev;
            }
        }
        if m.contains(" healed ") {
            if let Some(ev) = self.try_heal(m) {
                return ev;
            }
        }

        // --- Casting.
        if let Some(rest) = m.strip_prefix("You begin casting ") {
            if let Some(spell) = rest.strip_suffix('.') {
                return Event::CastBegin {
                    caster: Entity::You,
                    spell: spell.to_string(),
                };
            }
        }
        if m.contains("begins casting ") {
            if let Some(c) = self.re.cast_begin.captures(m) {
                return Event::CastBegin {
                    caster: entity(&c["c"]),
                    spell: c["s"].to_string(),
                };
            }
        }
        if m.contains(" singing ") {
            if let Some(c) = self.re.cast_sing.captures(m) {
                return Event::CastBegin {
                    caster: entity(&c["c"]),
                    spell: c["s"].to_string(),
                };
            }
        }
        if m.ends_with("spell fizzles!") {
            if let Some(c) = self.re.fizzle_your.captures(m) {
                return Event::CastFizzled {
                    caster: Entity::You,
                    spell: Some(c["s"].to_string()),
                };
            }
            if let Some(c) = self.re.fizzle.captures(m) {
                return Event::CastFizzled {
                    caster: entity(&c["c"]),
                    spell: Some(c["s"].to_string()),
                };
            }
        }
        if m == "Your spell fizzles!" {
            return Event::CastFizzled {
                caster: Entity::You,
                spell: None,
            };
        }
        if m.ends_with("spell is interrupted.") {
            if let Some(c) = self.re.interrupted_your.captures(m) {
                return Event::CastInterrupted {
                    caster: Entity::You,
                    spell: Some(c["s"].to_string()),
                };
            }
            if let Some(c) = self.re.interrupted.captures(m) {
                return Event::CastInterrupted {
                    caster: entity(&c["c"]),
                    spell: Some(c["s"].to_string()),
                };
            }
        }
        if m == "Your spell is interrupted." {
            return Event::CastInterrupted {
                caster: Entity::You,
                spell: None,
            };
        }

        // --- Resists.
        if m.contains("resisted ") || m.starts_with("You resist ") {
            if let Some(c) = self.re.resisted_your.captures(m) {
                return Event::Resisted {
                    target: entity(&c["t"]),
                    caster: Entity::You,
                    spell: c["s"].to_string(),
                };
            }
            if let Some(c) = self.re.resist_you.captures(m) {
                return Event::Resisted {
                    target: Entity::You,
                    caster: entity(&c["c"]),
                    spell: c["s"].to_string(),
                };
            }
            if let Some(c) = self.re.resisted.captures(m) {
                return Event::Resisted {
                    target: entity(&c["t"]),
                    caster: entity(&c["c"]),
                    spell: c["s"].to_string(),
                };
            }
        }

        // --- Worn off.
        if m.contains(" spell has worn off") {
            if let Some(c) = self.re.worn_off.captures(m) {
                let owner = if let Some(w) = c.name("w") {
                    Some(entity(w.as_str()))
                } else if c.name("pet").is_some() {
                    Some(Entity::Named("your pet".to_string()))
                } else {
                    Some(Entity::You)
                };
                return Event::WornOff {
                    spell: c["s"].to_string(),
                    owner,
                };
            }
        }

        // --- Deaths.
        if m.contains(" slain ") || m.ends_with(" died.") || m == "You died." {
            if let Some(c) = self.re.slain_you.captures(m) {
                return Event::Slain {
                    victim: entity(&c["v"]),
                    killer: Some(Entity::You),
                };
            }
            if let Some(c) = self.re.slain_by.captures(m) {
                return Event::Slain {
                    victim: entity(&c["v"]),
                    killer: Some(entity(&c["k"])),
                };
            }
            if let Some(c) = self.re.died.captures(m) {
                return Event::Slain {
                    victim: entity(&c["v"]),
                    killer: None,
                };
            }
        }

        // --- Loot.
        if m.contains("looted ") {
            if let Some(ev) = self.try_loot(m) {
                return ev;
            }
        }

        // --- /random rolls.
        if m.starts_with("**") {
            if let Some(c) = self.re.roll_one_line.captures(m) {
                return Event::Roll {
                    roller: c["r"].to_string(),
                    min: c["min"].parse().unwrap_or(0),
                    max: c["max"].parse().unwrap_or(0),
                    result: c["res"].parse().unwrap_or(0),
                };
            }
            if self.re.roll_announce.is_match(m) {
                // Two-line roll format: the roller announcement alone carries
                // no numbers; the result line follows. Recognized noise.
                return Event::System;
            }
            if let Some(c) = self.re.roll_result.captures(m) {
                return Event::Roll {
                    roller: String::new(),
                    min: c["min"].parse().unwrap_or(0),
                    max: c["max"].parse().unwrap_or(0),
                    result: c["res"].parse().unwrap_or(0),
                };
            }
        }

        // --- Simple state lines (exact matches first — some would otherwise
        // be swallowed by broader System prefixes below).
        if m == "You are stunned!" {
            return Event::Stunned { active: true };
        }
        if m == "You are no longer stunned." {
            return Event::Stunned { active: false };
        }
        if m.starts_with("LOADING") {
            return Event::Loading;
        }
        if m.starts_with("You gain ") {
            if let Some(c) = self.re.xp.captures(m) {
                let percent = c
                    .name("p")
                    .and_then(|p| p.as_str().parse::<f64>().ok())
                    .unwrap_or(0.0);
                return Event::XpGain {
                    percent,
                    party: c.name("party").is_some(),
                };
            }
        }
        if m.starts_with("You have gained a level!") {
            if let Some(c) = self.re.level_up.captures(m) {
                return Event::LevelUp {
                    level: c["l"].parse().unwrap_or(0),
                };
            }
        }
        if m.starts_with("Your faction standing") {
            if let Some(c) = self.re.faction.captures(m) {
                return Event::Faction {
                    faction: c["f"].to_string(),
                    delta: c["d"].parse().unwrap_or(0),
                };
            }
            // Floor/ceiling: "... with X could not possibly get any worse."
            if let Some(rest) = m.strip_prefix("Your faction standing with ") {
                if let Some(f) = rest
                    .strip_suffix(" could not possibly get any worse.")
                    .or_else(|| rest.strip_suffix(" could not possibly get any better."))
                {
                    return Event::Faction {
                        faction: f.to_string(),
                        delta: 0,
                    };
                }
            }
        }
        if m.starts_with("You have entered ") {
            if let Some(c) = self.re.zone.captures(m) {
                let z = &c["z"];
                // "You have entered an area where levitation effects do not
                // function." style lines are area-rule notices, not zones.
                if z.starts_with("an area") || z.starts_with("the drowning") {
                    return Event::System;
                }
                return Event::ZoneEnter {
                    zone: z.to_string(),
                };
            }
        }
        if m.starts_with("Your Location is ") {
            if let Some(c) = self.re.location.captures(m) {
                return Event::Location {
                    x: c["x"].parse().unwrap_or(0.0),
                    y: c["y"].parse().unwrap_or(0.0),
                    z: c["z"].parse().unwrap_or(0.0),
                };
            }
        }

        // --- Recognized system noise.
        if self.is_system(m) {
            return Event::System;
        }

        Event::Unclassified
    }

    fn try_chat(&self, m: &str) -> Option<Event> {
        let r = &self.re;
        if let Some(c) = r.chat_tells_you.captures(m) {
            return Some(chat(ChatChannel::Tell, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_you_told.captures(m) {
            return Some(chat(ChatChannel::Tell, Entity::You, &c["t"]));
        }
        if let Some(c) = r.chat_told_you.captures(m) {
            return Some(chat(ChatChannel::Tell, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_group.captures(m) {
            return Some(chat(ChatChannel::Group, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_you_group.captures(m) {
            return Some(chat(ChatChannel::Group, Entity::You, &c["t"]));
        }
        if let Some(c) = r.chat_guild.captures(m) {
            return Some(chat(ChatChannel::Guild, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_you_guild.captures(m) {
            return Some(chat(ChatChannel::Guild, Entity::You, &c["t"]));
        }
        if let Some(c) = r.chat_numbered.captures(m) {
            return Some(chat(
                ChatChannel::Numbered {
                    name: c["ch"].to_string(),
                    number: c["n"].parse().unwrap_or(0),
                },
                entity(&c["sp"]),
                &c["t"],
            ));
        }
        if let Some(c) = r.chat_ooc.captures(m) {
            return Some(chat(ChatChannel::Ooc, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_you_ooc.captures(m) {
            return Some(chat(ChatChannel::Ooc, Entity::You, &c["t"]));
        }
        if let Some(c) = r.chat_shout.captures(m) {
            return Some(chat(ChatChannel::Shout, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_auction.captures(m) {
            return Some(chat(ChatChannel::Auction, entity(&c["sp"]), &c["t"]));
        }
        if let Some(c) = r.chat_you_say.captures(m) {
            return Some(chat(ChatChannel::Say, Entity::You, &c["t"]));
        }
        if let Some(c) = r.chat_say.captures(m) {
            return Some(chat(ChatChannel::Say, entity(&c["sp"]), &c["t"]));
        }
        None
    }

    fn try_melee_hit(&self, m: &str) -> Option<Event> {
        let (core, flags) = strip_flags(m);
        if let Some(c) = self.re.melee_hit_you.captures(core) {
            return Some(Event::MeleeHit {
                attacker: Entity::You,
                target: entity(&c["t"]),
                verb: c["v"].to_string(),
                amount: c["n"].parse().ok()?,
                flags,
            });
        }
        if let Some(c) = self.re.melee_hit.captures(core) {
            return Some(Event::MeleeHit {
                attacker: entity(&c["a"]),
                target: entity(&c["t"]),
                verb: c["v"].to_string(),
                amount: c["n"].parse().ok()?,
                flags,
            });
        }
        None
    }

    fn try_melee_miss(&self, m: &str) -> Option<Event> {
        let (core, _flags) = strip_flags(m);
        let (attacker, caps) = if core.starts_with("You try to ") {
            (Entity::You, self.re.melee_miss_you.captures(core)?)
        } else if core.contains(" tries to ") {
            let caps = self.re.melee_miss.captures(core)?;
            (entity(&caps["a"]), caps)
        } else {
            return None;
        };
        let rest = &caps["rest"];
        let kind = miss_kind(rest)?;
        Some(Event::MeleeMiss {
            attacker,
            target: entity(&caps["t"]),
            verb: caps["v"].to_string(),
            kind,
        })
    }

    fn try_spell_damage(&self, m: &str) -> Option<Event> {
        let (core, flags) = strip_flags(m);
        let c = self.re.spell_damage.captures(core)?;
        Some(Event::SpellDamage {
            caster: entity(&c["c"]),
            target: entity(&c["t"]),
            amount: c["n"].parse().ok()?,
            spell: Some(c["s"].to_string()),
            flags,
        })
    }

    fn try_spell_damage_taken(&self, m: &str) -> Option<Event> {
        // Trailing flags like `(Critical)` occur on DoT ticks; the contract's
        // SpellDamageTaken variant carries no flags, so they are stripped.
        let (core, _flags) = strip_flags(m);
        if let Some(c) = self.re.taken_you.captures(core) {
            return Some(Event::SpellDamageTaken {
                target: Entity::You,
                source: entity(&c["src"]),
                spell: c["s"].to_string(),
                amount: c["n"].parse().ok()?,
            });
        }
        if let Some(c) = self.re.taken_from_your.captures(core) {
            return Some(Event::SpellDamageTaken {
                target: entity(&c["t"]),
                source: Entity::You,
                spell: c["s"].to_string(),
                amount: c["n"].parse().ok()?,
            });
        }
        if let Some(c) = self.re.taken.captures(core) {
            return Some(Event::SpellDamageTaken {
                target: entity(&c["t"]),
                source: entity(&c["src"]),
                spell: c["s"].to_string(),
                amount: c["n"].parse().ok()?,
            });
        }
        None
    }

    fn try_non_melee(&self, m: &str) -> Option<Event> {
        let c = self.re.non_melee.captures(m)?;
        let src = &c["src"];
        let (source, effect) = if let Some(rest) = src.strip_prefix("YOUR ") {
            (Some(Entity::You), rest.to_string())
        } else if let Some(pos) = src.rfind("'s ") {
            (Some(entity(&src[..pos])), src[pos + 3..].to_string())
        } else {
            (None, src.to_string())
        };
        Some(Event::NonMeleeDamage {
            source,
            target: entity(&c["t"]),
            effect,
            amount: c["n"].parse().ok()?,
        })
    }

    fn try_heal(&self, m: &str) -> Option<Event> {
        let (core, flags) = strip_flags(m);
        let c = self.re.heal.captures(core)?;
        let healer = entity(&c["h"]);
        let t = &c["t"];
        let target = match t {
            "itself" | "himself" | "herself" | "themselves" => healer.clone(),
            "yourself" => Entity::You,
            _ => entity(t),
        };
        Some(Event::Heal {
            healer,
            target,
            amount: c["n"].parse().ok()?,
            potential: c.name("p").and_then(|p| p.as_str().parse().ok()),
            over_time: c.name("ot").is_some(),
            spell: c.name("s").map(|s| s.as_str().to_string()),
            flags,
        })
    }

    fn try_loot(&self, m: &str) -> Option<Event> {
        let caps = self
            .re
            .loot_bracketed
            .captures(m)
            .or_else(|| self.re.loot_sold.captures(m))
            .or_else(|| self.re.loot_create.captures(m))?;
        let looter = match caps.name("l") {
            Some(l) => entity(l.as_str()),
            None => Entity::You,
        };
        let (quantity, item) = split_item_quantity(&caps["i"]);
        let corpse = caps.name("c").map(|c| {
            let raw = c.as_str();
            raw.strip_suffix("'s corpse").unwrap_or(raw).to_string()
        });
        Some(Event::Loot {
            looter,
            item,
            quantity,
            corpse,
        })
    }

    /// Recognized-but-uninteresting lines. Kept distinct from `Unclassified`
    /// so coverage stats stay honest.
    fn is_system(&self, m: &str) -> bool {
        const PREFIXES: &[&str] = &[
            "Auto attack ",
            "You can't",
            "You cannot",
            "You can no longer",
            "You must",
            "You may not",
            "You do not",
            "You don't",
            "You need",
            "You are",
            "You feel",
            "You forget",
            "You begin",
            "You gather shadows",
            "You overcome",
            "You regain",
            "You purchased",
            "You receive",
            "You could not",
            "You have become better at",
            "You slow down",
            "You stop ",
            "You assume",
            "You attempt",
            "You haven't",
            "You have completed",
            "You have finished",
            "You are unable",
            "You gain ",
            "You memorize",
            "You will now",
            "You have been",
            "You have gained",
            "You have improved",
            "You have not",
            "You have stopped",
            "You have control",
            "You have joined",
            "You hear",
            "You lose control",
            "You mend",
            "You no longer",
            "You place the key",
            "You successfully",
            "You invite",
            "You say to your",
            "Your spell",
            "Captured ",
            "Failed to capture",
            "Failed to taunt",
            "No longer taunting",
            "Taunting attackers",
            "Chomp, chomp",
            "Glug, glug",
            "Player ",
            "Players in EverQuest",
            "Origin Location:",
            "Bind Point:",
            "Returning to",
            "Sending an invitation",
            "Request to merge",
            "Spell set ",
            "Usage:",
            "It's locked",
            "The spirit of",
            "The roots",
            "The poison",
            "The flames",
            "The swarm",
            "The tangling weeds",
            "This ",
            "That ",
            "Strength returns",
            "Lightning surges",
            "Translucent armor",
            "---",
            "You suspect",
            "Your fever",
            "Your legs",
            "Your shadows",
            "Your stomach",
            "Autoskill ",
            "The item",
            "There is ",
            "There are ",
            "Your target",
            "Your mind",
            "Your skin",
            "Your feet",
            "Your hands",
            "Your body",
            "Your wounds",
            "Your bones",
            "Your muscles",
            "Your image",
            "Your eyes",
            "Your motes",
            "It will take",
            "It takes",
            "It begins to rain",
            "It begins to snow",
            "It stops raining",
            "It stops snowing",
            "Stand close to",
            "The Marketplace",
            "The mote",
            "Targeted (",
            "Welcome to EverQuest",
            "MESSAGE OF THE DAY",
            "There are no",
            "There is no",
            "Insufficient ",
            "Beginning to ",
            "Channel ",
            "Channels:",
            "You have successfully",
            "Try attacking",
            "This corpse",
            "That is not",
        ];
        if PREFIXES.iter().any(|p| m.starts_with(p)) {
            return true;
        }
        // Consider ("con") lines: `X scowls at you, ready to attack -- ... (Lvl: 26)`
        if m.contains("(Lvl: ") {
            return true;
        }
        // Bare con/status results and item-proc readiness (no Lvl suffix):
        // "a dar ghoul knight looks ambivalent.", "Gebantik looks healthy.",
        // "Your Black Tome with Silver Runes (Exaltation) feels alive with
        // power." (item charge-ready spam, hundreds/hour with such an item).
        const SUFFIXES: &[&str] = &[
            " feels alive with power.",
            " looks ambivalent.",
            " looks healthy.",
            " looks wounded.",
            " looks very wounded.",
            " regards you indifferently.",
            " judges you amiably.",
            " kindly considers you.",
            " glares at you threateningly.",
            " scowls at you, ready to attack.",
            " looks your way apprehensively.",
            " regards you as an ally.",
            // NPC/named-mob emotes and player ability-activation flavor
            // observed live (2026-07-04); an emote CLASSIFIER is specced as
            // the durable fix — these keep the canary badge honest until then.
            "'s voice booms.",
            " simmers with fury.",
            " begins to sway!",
            " begins to bleed profusely!",
            " coats their blades in asp venom!",
            "'s eyes glow red.",
            " looks daring.",
            " gain a subdued gold glow.",
        ];
        if SUFFIXES.iter().any(|x| m.ends_with(x)) {
            return true;
        }
        if m.starts_with("A protective aura") || m.starts_with("Your speed returns") {
            return true;
        }
        // Tradeskill/UI notices and ability activations ("Grixis activates
        // Asp Venom.").
        if m.starts_with("The result of this combine")
            || m.starts_with("Aborting memorization")
            || m.contains(" cannot be moved into ")
            || (m.ends_with('.') && m.contains(" activates "))
        {
            return true;
        }
        // Group / expedition membership churn.
        const CONTAINS: &[&str] = &[
            " has joined the group",
            " has left the group",
            " has been added to",
            " has been removed from",
            " has accepted your offer",
            " is now available to you",
            " cannot be dropped, traded, or sold",
            " was injured by falling",
            " spell did not take hold",
            " has been overwritten.",
            " ZONE: ",
        ];
        if CONTAINS.iter().any(|p| m.contains(p)) {
            return true;
        }
        // Third-person spell-landing / emote flavor lines.
        if self.re.sys_flavor.is_match(m) {
            return true;
        }
        false
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

fn chat(channel: ChatChannel, speaker: Entity, text: &str) -> Event {
    Event::Chat {
        channel,
        speaker,
        text: text.to_string(),
    }
}

/// Normalize pronoun forms of the player to `Entity::You`; everything else
/// keeps its raw name exactly as logged (backticks, leading articles, ...).
fn entity(name: &str) -> Entity {
    match name {
        "You" | "YOU" | "you" | "Yourself" | "yourself" | "YOURSELF" => Entity::You,
        _ => Entity::Named(name.to_string()),
    }
}

fn miss_kind(rest: &str) -> Option<MissKind> {
    // `rest` is the clause after ", but " and before the trailing "!".
    if rest == "misses" || rest == "miss" {
        return Some(MissKind::Miss);
    }
    if rest.ends_with("dodges") || rest.ends_with("dodge") {
        return Some(MissKind::Dodge);
    }
    if rest.ends_with("parries") || rest.ends_with("parry") {
        return Some(MissKind::Parry);
    }
    if rest.ends_with("ripostes") || rest.ends_with("riposte") {
        return Some(MissKind::Riposte);
    }
    if rest.ends_with("blocks") || rest.ends_with("block") || rest.contains("blocks with") {
        return Some(MissKind::Block);
    }
    if rest.contains("absorbs the blow") {
        return Some(MissKind::Absorb);
    }
    if rest.contains("INVULNERABLE") {
        return Some(MissKind::Invulnerable);
    }
    None
}

/// Strip trailing parenthesized hit annotations — `(Critical)`,
/// `(Lucky Critical)`, `(Riposte Strikethrough Critical)`,
/// `(Double Bow Shot)`, possibly several groups — returning the core message
/// and accumulated flags. Groups containing `:` (e.g. `(Lvl: 26)`) are left
/// alone.
fn strip_flags(msg: &str) -> (&str, HitFlags) {
    let mut flags = HitFlags::default();
    let mut s = msg.trim_end();
    while s.ends_with(')') {
        let Some(open) = s.rfind(" (") else { break };
        let inner = &s[open + 2..s.len() - 1];
        if inner.contains(':') || inner.contains(')') {
            break;
        }
        // Flag groups follow a sentence terminator: "damage. (Critical)".
        let before = s[..open].trim_end();
        if !(before.ends_with('.') || before.ends_with('!')) {
            break;
        }
        let mut other: Vec<String> = Vec::new();
        for tok in inner.split_whitespace() {
            match tok {
                "Critical" => flags.critical = true,
                "Lucky" => flags.lucky = true,
                "Strikethrough" => flags.strikethrough = true,
                "Riposte" => flags.riposte = true,
                "Rampage" => flags.rampage = true,
                _ => other.push(tok.to_string()),
            }
        }
        if !other.is_empty() {
            flags.other.push(other.join(" "));
        }
        s = before;
    }
    (s, flags)
}

/// `"2 Bone Chips"` -> `(2, "Bone Chips")`; `"a Backpack"` -> `(1, "Backpack")`.
fn split_item_quantity(item: &str) -> (u32, String) {
    if let Some((head, rest)) = item.split_once(' ') {
        if let Ok(n) = head.parse::<u32>() {
            return (n, rest.to_string());
        }
        if head == "a" || head == "an" {
            return (1, rest.to_string());
        }
    }
    (1, item.to_string())
}

const MONTHS: [&[u8; 3]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];

/// Parse the fixed-width 27-char prefix `[Thu Jul 02 23:32:46 2026] ` into
/// seconds since the Unix epoch (naive local time), returning the timestamp
/// and the message slice (CR/LF trimmed).
fn split_timestamp(raw: &str) -> Option<(i64, &str)> {
    let b = raw.as_bytes();
    if b.len() < 27 || b[0] != b'[' || b[25] != b']' || b[26] != b' ' {
        return None;
    }
    if b[4] != b' '
        || b[8] != b' '
        || b[11] != b' '
        || b[14] != b':'
        || b[17] != b':'
        || b[20] != b' '
    {
        return None;
    }
    let month = MONTHS
        .iter()
        .position(|m| **m == [b[5], b[6], b[7]])
        .map(|i| i as u32 + 1)?;
    // Day may be zero- or space-padded (asctime pads with a space).
    let day = two_digit(b[9], b[10], true)?;
    let hour = two_digit(b[12], b[13], false)?;
    let minute = two_digit(b[15], b[16], false)?;
    let second = two_digit(b[18], b[19], false)?;
    let year = {
        let mut y: i64 = 0;
        for &c in &b[21..25] {
            if !c.is_ascii_digit() {
                return None;
            }
            y = y * 10 + (c - b'0') as i64;
        }
        y
    };
    if !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let ts = days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64;
    // Bytes 0..27 are all ASCII (verified above), so this slice is safe.
    let msg = raw[27..].trim_end_matches(['\r', '\n']);
    Some((ts, msg))
}

fn two_digit(hi: u8, lo: u8, allow_space_pad: bool) -> Option<u32> {
    let hi_v = if hi == b' ' && allow_space_pad {
        0
    } else if hi.is_ascii_digit() {
        (hi - b'0') as u32
    } else {
        return None;
    };
    if !lo.is_ascii_digit() {
        return None;
    }
    Some(hi_v * 10 + (lo - b'0') as u32)
}

/// Howard Hinnant's days-from-civil algorithm: days since 1970-01-01 for a
/// proleptic Gregorian date.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn epoch_math() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 7, 3), 20_637);
    }

    #[test]
    fn flag_stripping() {
        let (core, f) =
            strip_flags("You crush X for 5 points of damage. (Riposte Strikethrough Critical)");
        assert_eq!(core, "You crush X for 5 points of damage.");
        assert!(f.critical && f.riposte && f.strikethrough);
        assert!(f.other.is_empty());

        let (_, f) = strip_flags("X shoots Y for 9 points of damage. (Critical Double Bow Shot)");
        assert!(f.critical);
        assert_eq!(f.other, vec!["Double Bow Shot".to_string()]);
    }
}
