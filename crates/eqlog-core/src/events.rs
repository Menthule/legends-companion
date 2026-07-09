//! The shared event contract. Everything downstream (fights, triggers, CLI,
//! Tauri app) consumes these types. Changes must be additive: new variants and
//! new optional fields are fine; renaming or removing breaks other modules.

use serde::{Deserialize, Serialize};

/// A raw log line split into its fixed-width timestamp and message.
/// EQ format: `[Thu Jul 02 23:32:46 2026] <message>` — 27-char prefix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogLine {
    /// Seconds since Unix epoch, parsed from the bracketed local timestamp.
    pub timestamp: i64,
    /// The message portion (everything after the `] `).
    pub message: String,
}

/// Who performed/received an action. "You"/"YOU"/"your" forms are normalized
/// to `Entity::You`; everything else keeps its raw name (pets included, e.g.
/// "Torvin`s warder" — pet→owner attribution happens in the fight tracker, not
/// the parser).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Entity {
    You,
    Named(String),
}

impl Entity {
    pub fn name<'a>(&'a self, you: &'a str) -> &'a str {
        match self {
            Entity::You => you,
            Entity::Named(n) => n,
        }
    }
}

/// Trailing hit annotations like `(Critical)`, `(Lucky Critical)`,
/// `(Strikethrough)`, `(Riposte)`, `(Rampage)`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HitFlags {
    pub critical: bool,
    pub lucky: bool,
    pub strikethrough: bool,
    pub riposte: bool,
    pub rampage: bool,
    pub other: Vec<String>,
}

/// How a melee attack failed to land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MissKind {
    Miss,
    Dodge,
    Parry,
    Riposte,
    Block,
    Absorb,
    Invulnerable,
}

/// Chat channel classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatChannel {
    Say,
    Tell,
    Group,
    Guild,
    Shout,
    Ooc,
    Auction,
    /// Numbered channel, e.g. `NewPlayers:1`, `General1:2`.
    Numbered {
        name: String,
        number: u32,
    },
}

/// A classified log event. `Unclassified` is the catch-all; the parser's
/// coverage metric is the fraction of lines that land in a real variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Event {
    /// `You crush a Teir`Dal rogue for 22 points of damage.` /
    /// `A Teir`Dal ranger slashes YOU for 2 points of damage.`
    MeleeHit {
        attacker: Entity,
        target: Entity,
        verb: String,
        amount: u64,
        flags: HitFlags,
    },
    /// `Vibarn tries to pierce X, but misses!` / `... but X parries!`
    MeleeMiss {
        attacker: Entity,
        target: Entity,
        verb: String,
        kind: MissKind,
    },
    /// Direct spell damage with attribution:
    /// `Vibarn hit a Teir`Dal shadowknight for 12 points of magic damage by Lifespike.`
    SpellDamage {
        caster: Entity,
        target: Entity,
        amount: u64,
        spell: Option<String>,
        flags: HitFlags,
    },
    /// Incoming spell damage: `You have taken 11 damage from Cancelling of
    /// Life by a Teir`Dal shadowknight.`
    SpellDamageTaken {
        target: Entity,
        source: Entity,
        spell: String,
        amount: u64,
    },
    /// DoT/damage-shield style: `X is tormented by YOUR frost for 9 points of
    /// non-melee damage.` / `X is pierced by Torvin's thorns for 1 point of
    /// non-melee damage.` / `YOU are pierced by a Teir`Dal ranger's thorns...`
    NonMeleeDamage {
        /// Owner of the effect when attributable ("YOUR frost" → You,
        /// "Torvin's thorns" → Torvin).
        source: Option<Entity>,
        target: Entity,
        /// Effect description, e.g. "frost", "thorns".
        effect: String,
        amount: u64,
    },
    /// `Fllint healed Foob for 11820 hit points by Blessing...` /
    /// `Vibarn healed itself for 12 (14) hit points by Lifespike.`
    Heal {
        healer: Entity,
        target: Entity,
        amount: u64,
        /// The `(potential)` figure when overheal syntax is present.
        potential: Option<u64>,
        over_time: bool,
        spell: Option<String>,
        flags: HitFlags,
    },
    /// `You begin casting Lifedraw.` / `X begins casting Shield of Thistles.`
    CastBegin { caster: Entity, spell: String },
    /// `Your <spell> is interrupted.` and stun-blocked casts.
    CastInterrupted { caster: Entity, spell: Option<String> },
    /// `Torvin's Flame Lick spell fizzles!` / `Your <spell> spell fizzles!`
    /// (additive variant — added by the parser module)
    CastFizzled { caster: Entity, spell: Option<String> },
    /// `A Teir`Dal ranger resisted your Engulfing Darkness!`
    Resisted { target: Entity, caster: Entity, spell: String },
    /// `Your Tangling Weeds spell has worn off.` (owner is whoever's buff)
    WornOff { spell: String, owner: Option<Entity> },
    /// A buff that failed to land because a conflicting buff already held the
    /// slot — the game's own authoritative stacking verdict (P11).
    /// `Your Protect spell did not take hold. (Blocked by Spirit Armor.)` /
    /// `Your Protect spell did not take hold on Vibarn. (Blocked by Spirit Armor.)`
    BuffBlocked {
        spell: String,
        blocker: String,
        /// You (self-buff) or the ally the buff was cast on.
        target: Entity,
    },
    /// `X has been slain by Y!` / `You have slain X!` / `You died.`
    Slain { victim: Entity, killer: Option<Entity> },
    /// `--You have looted a Backpack from a greater skeleton's corpse.--`
    Loot {
        looter: Entity,
        item: String,
        quantity: u32,
        corpse: Option<String>,
    },
    /// `**A Magic Die is rolled by X. ... turned up a 42.`
    Roll { roller: String, min: u32, max: u32, result: u32 },
    /// Any player chat: `Vheden tells NewPlayers:1, 'text'`, tells, says…
    Chat { channel: ChatChannel, speaker: Entity, text: String },
    /// `You gain experience! (2.429%)` / `You gain party experience! (0.5%)`
    XpGain { percent: f64, party: bool },
    /// `You have gained a level! Welcome to level 16!`
    LevelUp { level: u32 },
    /// `Your faction standing with Befallen Inhabitants has been adjusted by -1.`
    Faction { faction: String, delta: i64 },
    /// `You have entered New Sebilis Expedition.`
    ZoneEnter { zone: String },
    /// `LOADING, PLEASE WAIT...`
    Loading,
    /// `You are stunned!` / `You are no longer stunned.`
    Stunned { active: bool },
    /// `Your Location is -2006.63, -622.13, 93.81`
    Location { x: f64, y: f64, z: f64 },
    /// Consider ("con") line: `<name> - a rare creature - scowls at you, ready
    /// to attack -- ... (Lvl: 42)`. `rare` is true when the "- a rare creature
    /// -" tag is present — the game's authoritative rare/named marker. Legends
    /// breaks the classic naming convention (lowercase-article mobs like "a
    /// ghoul sentinel" can be rare), so this tag is the reliable signal. The
    /// leading sentence-capitalized article on `target` is left as-is; match
    /// case-insensitively downstream.
    Consider { target: String, rare: bool, level: Option<u32> },
    /// Recognized but uninteresting (e.g. "Auto attack is on.") — kept
    /// distinct from Unclassified so coverage stats stay honest.
    System,
    /// The parser did not recognize this line.
    Unclassified,
}

/// A fully parsed line: timestamp + classification + the original text
/// (triggers match on raw message text; meters consume the typed event).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedLine {
    pub line: LogLine,
    pub event: Event,
}
