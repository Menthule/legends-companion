import type { DropItemRow, QuestItemReference } from "../types";

export interface QuestAcquisitionSource {
  kind: string;
  npcNames: string[];
  zone?: string | null;
  location?: string | null;
  chance?: number | null;
  sourceCode?: string | null;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  sourcePageId?: number | null;
  sourceRevisionId?: number | null;
  sourceRevisionAt?: string | null;
  verification?: string | null;
  authorityId?: string | null;
  scope?: string | null;
  completeness?: "partial" | "exhaustive" | null;
}

export type QuestSourceStatus =
  | "corroborated"
  | "documented"
  | "classic-only"
  | "scope-difference"
  | "conflict"
  | "unresolved";

export interface QuestSourceValidation {
  status: QuestSourceStatus;
  label: string;
  legendsAuthorityCount: number;
  legendsDocumentCount: number;
  classicSourceCount: number;
}

export interface QuestRequirement {
  itemName: string;
  itemId: number | null;
  quantity: number;
  choiceGroup: string | null;
  sourcePageTitle?: string | null;
  acquisitionSources?: QuestAcquisitionSource[];
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
        // Class tags: catalog pseudo-classes ("Kael Armor", "Repeatable
        // Turn-in") are only reachable by text — the global 16-class filter
        // can't select them.
        ...quest.classes,
        ...quest.requirements.map((row) => row.itemName),
        ...quest.rewards,
      ].some((value) => normalizeQuestName(value).includes(wanted));
    })
    .slice(0, Math.max(1, options.limit ?? 100));
}

export function questsRequiringItem(
  itemName: string,
  records: QuestRecord[],
): QuestRecord[] {
  const wanted = normalizeInventoryItem(itemName);
  if (!wanted) return [];
  return records
    .filter((quest) => quest.requirements.some(
      (requirement) => normalizeInventoryItem(requirement.itemName) === wanted,
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
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

export function isQuestReady(
  quest: Pick<QuestRecord, "requirements">,
  snapshot: InventorySnapshot | null,
): boolean {
  if (!snapshot || quest.requirements.length === 0) return false;
  return matchQuestRequirements(quest.requirements, snapshot).every((requirement) => requirement.satisfied);
}

/** True when the inventory already contains at least one documented final
 * quest reward. Required turn-in materials deliberately do not participate:
 * owning those means the quest is in progress, not obsolete. */
export function hasOwnedQuestReward(
  quest: Pick<QuestRecord, "rewards">,
  snapshot: InventorySnapshot | null,
): boolean {
  if (!snapshot || quest.rewards.length === 0) return false;
  const ownedNames = new Set(
    snapshot.items.flatMap((item) => [item.name, ...item.names]).map(normalizeInventoryItem),
  );
  return quest.rewards.some((reward) => ownedNames.has(normalizeInventoryItem(reward)));
}

/** Apply inventory-specific quest visibility after text/class/deep-link
 * selection. Keeping this separate prevents a selected quest from bypassing
 * Ready or Hide owned rewards filters. */
export function filterQuestsByInventory(
  quests: QuestRecord[],
  snapshot: InventorySnapshot | null,
  options: { readyOnly: boolean; hideOwnedRewards: boolean },
): QuestRecord[] {
  return quests.filter((quest) =>
    (!options.readyOnly || isQuestReady(quest, snapshot))
    && (!options.hideOwnedRewards || !hasOwnedQuestReward(quest, snapshot)),
  );
}

function acquisitionSourceSummary(source: QuestAcquisitionSource): string {
  const npcNames = source.npcNames.map((name) => name.trim()).filter(Boolean);
  const zone = source.zone?.trim() === "Plane of Air" ? "Plane of Sky" : source.zone?.trim();
  const location = source.location?.trim();
  const kind = source.kind.trim().toLowerCase();
  const readableKind = kind.replace(/[-_]+/g, " ");
  const kindLabel = kind && kind !== "mob" && kind !== "mob-drop"
    ? `${readableKind.charAt(0).toUpperCase()}${readableKind.slice(1)}: `
    : "";
  const details = [
    npcNames.join(", "),
    zone,
    location && location !== zone ? location : "",
  ].filter(Boolean);
  const fallback = source.sourceLabel?.trim() || "Legends source";
  const chance = typeof source.chance === "number" && Number.isFinite(source.chance)
    ? ` (${source.chance >= 1 ? Math.round(source.chance) : source.chance.toFixed(1)}%)`
    : "";
  return `${kindLabel}${details.join(" · ") || fallback}${chance}`;
}

interface ComparableSourceClaim {
  authority: string;
  scope: string;
  kind: string;
  exhaustive: boolean;
  npcs: Set<string>;
  zones: Set<string>;
}

function sourceToken(value: string): string {
  return normalizeQuestName(value).replace(/^(?:a|an|the)\s+/, "");
}

function sourceAuthority(source: QuestAcquisitionSource): string {
  if (source.authorityId?.trim()) return source.authorityId.trim().toLowerCase();
  if (source.sourceLabel?.trim()) return source.sourceLabel.trim().toLowerCase();
  if (source.sourceUrl) {
    try {
      return new URL(source.sourceUrl).hostname.toLowerCase();
    } catch {
      // A malformed provenance URL should not create a second authority.
    }
  }
  return "legends-catalog";
}

function catalogClaim(source: QuestAcquisitionSource): ComparableSourceClaim {
  const zone = source.zone === "Plane of Air" ? "Plane of Sky" : source.zone;
  return {
    authority: sourceAuthority(source),
    scope: source.scope?.trim().toLowerCase() || "everquest-legends",
    kind: source.kind.trim().toLowerCase(),
    exhaustive: source.completeness === "exhaustive",
    npcs: new Set(source.npcNames.map(sourceToken).filter(Boolean)),
    zones: new Set(zone ? [sourceToken(zone)] : []),
  };
}

function classicClaim(reference: QuestItemReference): ComparableSourceClaim {
  return {
    authority: "projecteq-classic-reference",
    scope: "classic-reference",
    kind: "mob-drop",
    exhaustive: false,
    npcs: new Set(reference.sources.map((source) => sourceToken(source.npc)).filter(Boolean)),
    zones: new Set(reference.sources
      .map((source) => source.zoneLong === "Plane of Air" ? "Plane of Sky" : source.zoneLong)
      .filter((zone): zone is string => Boolean(zone))
      .map(sourceToken)),
  };
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function claimsAgree(left: ComparableSourceClaim, right: ComparableSourceClaim): boolean {
  if (left.npcs.size > 0 && right.npcs.size > 0) return intersects(left.npcs, right.npcs);
  return left.zones.size > 0 && right.zones.size > 0 && intersects(left.zones, right.zones);
}

export function questSourceValidation(
  reference: QuestItemReference | undefined,
  acquisitionSources: QuestAcquisitionSource[] = [],
): QuestSourceValidation {
  const catalogClaims = acquisitionSources.map(catalogClaim);
  const authorityCount = new Set(catalogClaims.map((claim) => claim.authority)).size;
  const classic = reference?.sources.length ? classicClaim(reference) : null;
  let independentlyAgreed = false;
  let conflict = false;

  for (let leftIndex = 0; leftIndex < catalogClaims.length; leftIndex += 1) {
    const left = catalogClaims[leftIndex];
    if (
      classic
      && (left.kind === "mob-drop" || left.kind === "zone-drop")
      && claimsAgree(left, classic)
    ) independentlyAgreed = true;
    for (let rightIndex = leftIndex + 1; rightIndex < catalogClaims.length; rightIndex += 1) {
      const right = catalogClaims[rightIndex];
      if (left.authority === right.authority) continue;
      if (claimsAgree(left, right)) independentlyAgreed = true;
      if (
        left.scope === right.scope
        && left.kind === right.kind
        && left.exhaustive
        && right.exhaustive
        && left.npcs.size > 0
        && right.npcs.size > 0
        && !claimsAgree(left, right)
      ) {
        conflict = true;
      }
    }
  }

  const comparableCatalogClaims = catalogClaims.filter((claim) => claim.npcs.size > 0 || claim.zones.size > 0);
  const scopeDifference = Boolean(
    classic
    && comparableCatalogClaims.length > 0
    && comparableCatalogClaims.some((claim) => claim.kind === "mob-drop" || claim.kind === "zone-drop")
    && !comparableCatalogClaims
      .filter((claim) => claim.kind === "mob-drop" || claim.kind === "zone-drop")
      .some((claim) => claimsAgree(claim, classic)),
  );
  let status: QuestSourceStatus;
  if (conflict) status = "conflict";
  else if (independentlyAgreed) status = "corroborated";
  else if (scopeDifference) status = "scope-difference";
  else if (catalogClaims.length > 0) status = "documented";
  else if (classic) status = "classic-only";
  else status = "unresolved";

  const labels: Record<QuestSourceStatus, string> = {
    corroborated: "Corroborated",
    documented: "Legends documented",
    "classic-only": "Classic reference only",
    "scope-difference": "Legends/classic differ",
    conflict: "Sources conflict",
    unresolved: "No documented source",
  };
  return {
    status,
    label: labels[status],
    legendsAuthorityCount: authorityCount,
    legendsDocumentCount: acquisitionSources.length,
    classicSourceCount: reference?.sources.length ?? 0,
  };
}

export function questDropSourceSummary(
  reference: QuestItemReference | undefined,
  acquisitionSources: QuestAcquisitionSource[] = [],
): string {
  let classicSummary = "";
  if (reference?.sources.length) {
    const shown = reference.sources.slice(0, 2).map((source) => {
      const chance = source.chance >= 1 ? `${Math.round(source.chance)}%` : `${source.chance.toFixed(1)}%`;
      const zone = source.zoneLong === "Plane of Air" ? "Plane of Sky" : source.zoneLong;
      return `${source.npc} · ${zone ?? "unknown zone"} (${chance})`;
    });
    const remaining = reference.item ? reference.item.sources - shown.length : 0;
    classicSummary = `${shown.join("; ")}${remaining > 0 ? `; +${remaining} more` : ""}`;
  }
  const catalogSources = [...new Set(acquisitionSources
    .map(acquisitionSourceSummary)
    .filter(Boolean))];
  let legendsSummary = "";
  if (catalogSources.length) {
    const shown = catalogSources.slice(0, 2);
    const remaining = catalogSources.length - shown.length;
    legendsSummary = `${shown.join("; ")}${remaining > 0 ? `; +${remaining} more` : ""}`;
  }
  if (legendsSummary && classicSummary) return `Legends: ${legendsSummary} | Classic: ${classicSummary}`;
  if (legendsSummary) return `Legends: ${legendsSummary}`;
  if (classicSummary) return `Classic: ${classicSummary}`;
  if (!reference?.item) return "No matching item in the classic reference database.";
  return "No known mob drop; may be quested, crafted, sold, or Legends-specific.";
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
