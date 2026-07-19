import type { EqEvent, LogLinePayload } from "../types";

export interface HighlightCandidate {
  key: string;
  text: string;
  amount?: number;
  detail?: string;
  icon?: string;
  color?: string;
  important?: boolean;
  /** Override the normal burst window. Periodic damage uses the EQ tick
   * cadence so one card can accumulate for the life of the DoT. */
  aggregateMs?: number;
  /** Keep periodic cards alive long enough for the next server tick. */
  ttlMs?: number;
  periodic?: boolean;
}

export const DOT_AGGREGATE_MS = 7_500;

const SKILL_VERBS = new Set([
  "kick",
  "bash",
  "slam",
  "cleave",
  "backstab",
  "eagle strike",
  "tiger claw",
  "dragon punch",
  "tail rake",
  "flying kick",
  "round kick",
  "frenzy",
  "smite",
  "reave",
]);

function entityIsYou(value: unknown): boolean {
  return value === "You";
}

function entityName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "Named" in value) {
    return String((value as { Named: unknown }).Named);
  }
  return "";
}

function data(event: EqEvent, kind: string): Record<string, unknown> | null {
  if (typeof event !== "object" || event === null || !(kind in event)) return null;
  return event[kind] ?? null;
}

function flagsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function title(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function specialFlag(flags: Record<string, unknown>): string | null {
  const other = Array.isArray(flags.other) ? flags.other.map(String) : [];
  const ranked = [
    "Crippling Blow",
    "Double Bow Shot",
    "Flurry",
    "Wild Rampage",
  ];
  for (const wanted of ranked) {
    const found = other.find((value) => value.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
  }
  if (flags.rampage === true) return "Rampage";
  if (flags.strikethrough === true) return "Strikethrough";
  if (flags.riposte === true && flags.critical === true) return "Riposte Critical";
  return other[0] ?? null;
}

/** Stateful, presentation-neutral selector for the default Notable feed. */
export class HighlightEvaluator {
  private best = new Map<string, number>();
  private owners = new Set(["you"]);

  setOwners(characterName: string, pets: readonly string[] = []): void {
    this.owners = new Set(
      ["You", characterName, ...pets]
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  private isOwned(value: unknown): boolean {
    return this.owners.has(entityName(value).trim().toLowerCase());
  }

  evaluate(line: LogLinePayload): HighlightCandidate[] {
    const out: HighlightCandidate[] = [];
    const melee = data(line.event, "MeleeHit");
    if (melee && entityIsYou(melee.attacker)) {
      const verb = String(melee.verb ?? "hit").toLowerCase();
      const amount = Number(melee.amount ?? 0);
      const flags = flagsOf(melee.flags);
      const special = specialFlag(flags);
      if (special && special !== "Crippling Blow") {
        out.push({
          key: `special:${special.toLowerCase()}`,
          text: special,
          amount,
          detail: title(verb),
          color: "#ffd166",
          important: true,
        });
      }
      if (SKILL_VERBS.has(verb) && amount > 0) {
        const key = `skill:${verb}`;
        const previous = this.best.get(key) ?? 0;
        this.best.set(key, Math.max(previous, amount));
        if (previous > 0 && amount > previous) {
          out.push({
            key: `${key}:best`,
            text: `${title(verb)} best`,
            amount,
            detail: "New session record",
            color: "#7ee787",
            important: true,
          });
        }
      }
    }

    const spell = data(line.event, "SpellDamage");
    if (spell && this.isOwned(spell.caster)) {
      const name = String(spell.spell ?? "Spell damage").trim() || "Spell damage";
      const amount = Number(spell.amount ?? 0);
      const flags = flagsOf(spell.flags);
      const key = `spell:${name.toLowerCase()}`;
      const previous = this.best.get(key) ?? 0;
      this.best.set(key, Math.max(previous, amount));
      out.push({
        key,
        text: name,
        amount,
        detail:
          flags.critical === true
            ? "Critical"
            : previous > 0 && amount > previous
              ? "New best"
              : undefined,
        icon: `spell-name:${name}`,
        color: flags.critical === true ? "#ffb454" : "#8bd5ff",
        // The first direct hit of a DoT normally precedes its first six-second
        // tick. Keeping the card through that cadence lets the tick join the
        // original hit instead of starting a second total.
        ttlMs: DOT_AGGREGATE_MS,
      });
    }

    const dot = data(line.event, "SpellDamageTaken");
    if (dot && this.isOwned(dot.source) && !entityIsYou(dot.target)) {
      const name = String(dot.spell ?? "Damage over time").trim() || "Damage over time";
      const amount = Number(dot.amount ?? 0);
      if (amount > 0) {
        out.push({
          key: `spell:${name.toLowerCase()}`,
          text: name,
          amount,
          detail: "DoT tick",
          icon: `spell-name:${name}`,
          color: "#b7a4ff",
          aggregateMs: DOT_AGGREGATE_MS,
          ttlMs: DOT_AGGREGATE_MS,
          periodic: true,
        });
      }
    }

    const periodic = data(line.event, "NonMeleeDamage");
    if (periodic && this.isOwned(periodic.source) && !entityIsYou(periodic.target)) {
      const name = String(periodic.effect ?? "Periodic damage").trim() || "Periodic damage";
      const amount = Number(periodic.amount ?? 0);
      if (amount > 0) {
        out.push({
          key: `effect:${name.toLowerCase()}`,
          text: title(name),
          amount,
          detail: "Periodic tick",
          color: "#b7a4ff",
          aggregateMs: DOT_AGGREGATE_MS,
          ttlMs: DOT_AGGREGATE_MS,
          periodic: true,
        });
      }
    }

    const heal = data(line.event, "Heal");
    if (heal && entityIsYou(heal.healer) && heal.over_time !== true) {
      const name = String(heal.spell ?? "Heal").trim() || "Heal";
      const amount = Number(heal.amount ?? 0);
      const flags = flagsOf(heal.flags);
      const key = `heal:${name.toLowerCase()}`;
      const previous = this.best.get(key) ?? 0;
      this.best.set(key, Math.max(previous, amount));
      const newBest = previous > 0 && amount > previous;
      if (flags.critical === true || newBest) {
        out.push({
          key,
          text: name,
          amount,
          detail: flags.critical === true ? "Critical heal" : "New heal best",
          icon: `spell-name:${name}`,
          color: "#7ee787",
          important: true,
        });
      }
    }

    const aa = data(line.event, "AaPointGain");
    if (aa) {
      out.push({
        key: "progress:aa-point",
        text: "Ability point",
        amount: Number(aa.points ?? 1),
        detail: `${Number(aa.balance ?? 0)} available`,
        color: "#c9a7ff",
        important: true,
      });
    }

    const skill = data(line.event, "SkillUp");
    if (skill) {
      const value = Number(skill.value ?? 0);
      if (value > 0 && value % 25 === 0) {
        const name = String(skill.skill ?? "Skill");
        out.push({
          key: `milestone:${name.toLowerCase()}`,
          text: `${name} milestone`,
          amount: value,
          detail: "Skill",
          color: "#f2c14e",
          important: true,
        });
      }
    }

    const unlock = /^You have gained the ability to use (.+)\.$/.exec(line.message);
    if (unlock) {
      out.push({
        key: `unlock:${unlock[1].toLowerCase()}`,
        text: "Ability unlocked",
        detail: unlock[1],
        color: "#c9a7ff",
        important: true,
      });
    }
    return out;
  }
}
