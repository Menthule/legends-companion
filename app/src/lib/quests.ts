import type { DropItemRow, QuestItemReference } from "../types";

export interface QuestRequirement {
  itemName: string;
  itemId: number | null;
  quantity: number;
  choiceGroup: string | null;
}

export interface QuestRecord {
  id: string;
  name: string;
  summary: string;
  zone: string;
  classes: string[];
  minimumLevel: number | null;
  givers: string[];
  aliases: string[];
  requirements: QuestRequirement[];
  rewards: string[];
  repeatable: boolean | null;
  notes: string;
  sourceLabel: string;
  sourceUrl: string;
  sourcePageId: number;
  sourceRevisionId: number;
  sourceRevisionAt: string;
  verification: string;
}

export interface QuestCatalog {
  schemaVersion: number;
  generatedAt: string;
  license: string;
  attribution: string;
  source: string;
  sourcePageCount: number;
  skyAudit: { questCount: number; classes: string[]; sourcePages: string[] };
  quests: QuestRecord[];
}

export interface InventoryItemSnapshot {
  itemId: number | null;
  name: string;
  names: string[];
  quantity: number;
  locations: string[];
}

export interface InventorySnapshot {
  sourcePath: string;
  sourceModifiedMs: number;
  importedAtMs: number;
  rowCount: number;
  skippedRows: number;
  items: InventoryItemSnapshot[];
}

export interface RequirementMatch extends QuestRequirement {
  owned: number;
  satisfied: boolean;
  matchedBy: "id" | "name" | null;
  locations: string[];
}

let catalogPromise: Promise<QuestCatalog> | null = null;

export function loadQuestCatalog(): Promise<QuestCatalog> {
  if (!catalogPromise) {
    catalogPromise = import("../data/quests.json").then((module) => module.default as QuestCatalog);
  }
  return catalogPromise;
}

export function normalizeQuestName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`']/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeInventoryItem(value: string): string {
  let result = value.trim();
  result = result.replace(/\s+\+\d+\s*$/i, "");
  result = result.replace(/\s+\([^()]+\)\s*$/i, "");
  return normalizeQuestName(result);
}

export function questsForGiver(
  giver: string,
  zone = "",
  records: QuestRecord[],
): QuestRecord[] {
  const wanted = normalizeQuestName(giver).replace(/^(?:a|an|the)\s+/, "");
  const zoneNorm = normalizeQuestName(zone);
  return records
    .filter((quest) => [...quest.givers, ...quest.aliases].some((name) =>
      normalizeQuestName(name).replace(/^(?:a|an|the)\s+/, "") === wanted,
    ))
    .sort((left, right) => {
      const leftZone = zoneNorm && normalizeQuestName(left.zone) === zoneNorm ? 1 : 0;
      const rightZone = zoneNorm && normalizeQuestName(right.zone) === zoneNorm ? 1 : 0;
      return rightZone - leftZone || left.name.localeCompare(right.name);
    });
}

export function searchQuests(
  query: string,
  options: { zone?: string; className?: string; limit?: number } = {},
  records: QuestRecord[],
): QuestRecord[] {
  const wanted = normalizeQuestName(query);
  const zone = normalizeQuestName(options.zone ?? "");
  const className = normalizeQuestName(options.className ?? "");
  return records
    .filter((quest) => !zone || normalizeQuestName(quest.zone) === zone)
    .filter((quest) => !className || quest.classes.some((value) => normalizeQuestName(value) === className))
    .filter((quest) => {
      if (!wanted) return true;
      return [
        quest.name,
        quest.summary,
        quest.zone,
        ...quest.givers,
        ...quest.aliases,
        ...quest.requirements.map((row) => row.itemName),
        ...quest.rewards,
      ].some((value) => normalizeQuestName(value).includes(wanted));
    })
    .slice(0, Math.max(1, options.limit ?? 100));
}

export function matchQuestRequirements(
  requirements: QuestRequirement[],
  snapshot: InventorySnapshot | null,
): RequirementMatch[] {
  return requirements.map((requirement) => {
    if (!snapshot) {
      return { ...requirement, owned: 0, satisfied: false, matchedBy: null, locations: [] };
    }
    const requirementName = normalizeInventoryItem(requirement.itemName);
    const matches = snapshot.items.filter((item) => {
      if (requirement.itemId != null && item.itemId === requirement.itemId) return true;
      return [item.name, ...item.names].some((name) => normalizeInventoryItem(name) === requirementName);
    });
    const matchedBy = requirement.itemId != null && matches.some((item) => item.itemId === requirement.itemId)
      ? "id"
      : matches.length > 0 ? "name" : null;
    const owned = matches.reduce((sum, item) => sum + item.quantity, 0);
    return {
      ...requirement,
      owned,
      satisfied: owned >= requirement.quantity,
      matchedBy,
      locations: [...new Set(matches.flatMap((item) => item.locations))].sort(),
    };
  });
}

export function questDropSourceSummary(reference: QuestItemReference | undefined): string {
  if (!reference?.item) return "No matching item in the classic reference database.";
  if (reference.sources.length === 0) {
    return "No known mob drop; may be quested, crafted, sold, or Legends-specific.";
  }
  const shown = reference.sources.slice(0, 2).map((source) => {
    const chance = source.chance >= 1 ? `${Math.round(source.chance)}%` : `${source.chance.toFixed(1)}%`;
    const zone = source.zoneLong === "Plane of Air" ? "Plane of Sky" : source.zoneLong;
    return `${source.npc} · ${zone ?? "unknown zone"} (${chance})`;
  });
  const remaining = reference.item.sources - shown.length;
  return `${shown.join("; ")}${remaining > 0 ? `; +${remaining} more` : ""}`;
}

export function questItemDetailLines(item: DropItemRow | null): string[] {
  if (!item) return ["No item details in the classic reference database."];
  const lines: string[] = [];
  const stats = [
    item.ac ? `AC ${item.ac}` : "",
    item.hp ? `HP ${item.hp}` : "",
    item.mana ? `Mana ${item.mana}` : "",
    item.astr ? `STR ${item.astr}` : "",
    item.asta ? `STA ${item.asta}` : "",
    item.aagi ? `AGI ${item.aagi}` : "",
    item.adex ? `DEX ${item.adex}` : "",
    item.awis ? `WIS ${item.awis}` : "",
    item.aint ? `INT ${item.aint}` : "",
    item.acha ? `CHA ${item.acha}` : "",
  ].filter(Boolean);
  if (stats.length > 0) lines.push(stats.join(" · "));
  if (item.damage > 0) lines.push(`${item.damage} damage · ${item.delay} delay`);
  if (item.haste > 0) lines.push(`Haste ${item.haste}%`);
  if (item.procName) lines.push(`Proc: ${item.procName}`);
  if (item.clickName) lines.push(`Click: ${item.clickName}`);
  if (item.wornName) lines.push(`Worn: ${item.wornName}`);
  if (item.focusName) lines.push(`Focus: ${item.focusName}`);
  if (item.reqlevel > 0) lines.push(`Required level ${item.reqlevel}`);
  const flags = [item.noDrop ? "NO DROP" : "", item.loregroup ? "LORE" : ""].filter(Boolean);
  if (flags.length > 0) lines.push(flags.join(" · "));
  return lines.length > 0 ? lines : ["No combat stats recorded."];
}
