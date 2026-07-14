import {
  discoverLogs,
  dropsZones,
  dropsSearchItems,
  getTriggerTree,
  refdbMobSearch,
  refdbRecipeSearch,
  spellsSearch,
} from "../api";
import {
  tradeskillName,
  type DiscoveredLog,
  type DropZone,
  type DropItemRow,
  eventKind,
  type LogLinePayload,
  type MobRow,
  type RecipeRef,
  type SpellRow,
  type TriggerTreeEntry,
} from "../types";
import { loadQuestCatalog, searchQuests, type QuestRecord } from "./quests";

export type GlobalSearchGroupId =
  | "logs"
  | "items"
  | "mobs"
  | "quests"
  | "spells"
  | "abilities"
  | "recipes"
  | "triggers"
  | "characters";

export type GlobalSearchTab =
  | "live"
  | "drops"
  | "mobs"
  | "quests"
  | "spells"
  | "recipes"
  | "triggers"
  | "settings";

export type GlobalSearchAction =
  | {
      kind: "open-tab-search";
      tab: Exclude<GlobalSearchTab, "settings">;
      query: string;
      /** Exact result selected in global search; destination tabs use it to
       * open the detail row after their async search resolves. */
      targetId?: number | string;
      /** Explicit unsourced item selections must bypass Drops' source filter. */
      revealUnsourced?: boolean;
      /** Spells tab only: land on the Abilities segment (abilities are the
       *  is_ability half of the same tab, not a tab of their own). */
      isAbility?: boolean;
    }
  | {
      kind: "open-character-log";
      tab: "settings";
      path: string;
      character: string;
      server: string;
    }
  | {
      kind: "open-trigger";
      tab: "triggers";
      triggerId: string;
      query: string;
    };

export interface GlobalSearchResult {
  id: string;
  group: GlobalSearchGroupId;
  title: string;
  subtitle: string;
  meta: string[];
  action: GlobalSearchAction;
}

export interface GlobalSearchGroup {
  id: GlobalSearchGroupId;
  title: string;
  results: GlobalSearchResult[];
  total?: number;
}

export interface GlobalSearchResponse {
  query: string;
  groups: GlobalSearchGroup[];
}

export interface GlobalSearchOptions {
  /** Max rows requested from each backend search. */
  limitPerGroup?: number;
  /** Reference-data era cap. Existing tabs use 3 for "Everything". */
  eraMax?: number;
  /** Current long zone name from `You have entered ...`, used as a ranking hint. */
  currentZone?: string | null;
}

export interface RecentLogEntry {
  path: string;
  character: string;
  server: string;
  modifiedTs: number | null;
  lastOpenedTs: number;
}

const RECENT_LOGS_KEY = "eqlogs.globalSearch.recentLogs.v1";
const RECENT_LOG_LIMIT = 12;
const RECENT_LINE_LIMIT = 600;
const DEFAULT_LIMIT = 5;
let recentLineSeq = 0;
const recentLines: ({ id: number } & LogLinePayload)[] = [];
let zoneCache: DropZone[] | null = null;

const GROUP_TITLES: Record<GlobalSearchGroupId, string> = {
  logs: "Recent log lines",
  items: "Items / drops",
  mobs: "Mobs",
  quests: "Quests",
  spells: "Spells",
  abilities: "Abilities",
  recipes: "Recipes",
  triggers: "Triggers",
  characters: "Characters / logs",
};

export async function globalSearch(
  rawQuery: string,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResponse> {
  const query = rawQuery.trim();
  const limit = Math.max(1, options.limitPerGroup ?? DEFAULT_LIMIT);
  const eraMax = options.eraMax ?? 3;
  const zoneHint = await resolveZoneHint(options.currentZone);

  if (!query) {
    return { query, groups: emptyGroups() };
  }

  const [
    items,
    mobs,
    quests,
    spells,
    abilities,
    recipes,
    triggers,
    logs,
  ] = await Promise.all([
    searchItems(query, limit, eraMax, zoneHint),
    searchMobs(query, limit, eraMax, zoneHint),
    searchQuestRecords(query, limit),
    searchSpells(query, false, limit),
    searchSpells(query, true, limit),
    searchRecipes(query, limit),
    searchTriggers(query, limit),
    searchLogs(query, limit),
  ]);

  return {
    query,
    groups: [
      group("logs", searchRecentLogLines(query, Math.max(limit, 8)), recentLines.length),
      group("items", items.rows, items.total),
      group("mobs", mobs.rows, mobs.total),
      group("quests", quests.rows, quests.total),
      group("spells", spells.rows, spells.total),
      group("abilities", abilities.rows, abilities.total),
      group("recipes", recipes.rows, recipes.total),
      group("triggers", triggers.rows, triggers.total),
      group("characters", logs.rows, logs.total),
    ],
  };
}

export function pushRecentLogLine(line: LogLinePayload): void {
  recentLines.push({ ...line, id: ++recentLineSeq });
  if (recentLines.length > RECENT_LINE_LIMIT) {
    recentLines.splice(0, recentLines.length - RECENT_LINE_LIMIT);
  }
}

export function searchRecentLogLines(query: string, limit = 8): GlobalSearchResult[] {
  const q = normalize(query);
  if (!q) return [];
  return recentLines
    .filter((line) => normalize(line.message).includes(q))
    .slice(-limit)
    .reverse()
    .map((line) => ({
      id: `line:${line.id}`,
      group: "logs",
      title: line.message,
      subtitle: new Date(line.ts * 1000).toLocaleTimeString(),
      meta: [eventKind(line.event)],
      action: { kind: "open-tab-search", tab: "live", query },
    }));
}

export function pushRecentLog(
  log: DiscoveredLog | Omit<RecentLogEntry, "lastOpenedTs">,
): RecentLogEntry[] {
  const entry: RecentLogEntry = {
    path: log.path,
    character: log.character,
    server: log.server,
    modifiedTs: log.modifiedTs,
    lastOpenedTs: Date.now(),
  };
  const key = normalize(entry.path);
  const next = [entry, ...loadRecentLogs().filter((e) => normalize(e.path) !== key)]
    .filter((e) => e.path.trim().length > 0)
    .slice(0, RECENT_LOG_LIMIT);
  saveRecentLogs(next);
  return next;
}

export function searchRecentLogs(query: string, limit = RECENT_LOG_LIMIT): RecentLogEntry[] {
  const q = normalize(query);
  const entries = loadRecentLogs();
  if (!q) return entries.slice(0, limit);
  return entries
    .filter((e) =>
      [e.character, e.server, e.path].some((part) => normalize(part).includes(q)),
    )
    .slice(0, limit);
}

async function searchItems(
  query: string,
  limit: number,
  eraMax: number,
  zoneHint: ZoneHint | null,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  const run = (zone: string) => dropsSearchItems({
    query,
    eraMax,
    onlySourced: false,
    slotMask: 0,
    classMask: 0,
    zone,
    effectType: "",
    effectName: "",
    sort: "name",
    descending: false,
    limit,
    offset: 0,
  });
  try {
    const [zoneRes, allRes] = await Promise.all([
      zoneHint ? run(zoneHint.shortName).catch(() => null) : Promise.resolve(null),
      run(""),
    ]);
    const rows = mergeResults(
      zoneRes?.rows.map((row) => itemResult(row, zoneHint)) ?? [],
      allRes.rows.map((row) => itemResult(row, null)),
    ).slice(0, limit);
    return { total: Math.max(allRes.total, zoneRes?.total ?? 0), rows };
  } catch {
    return { total: 0, rows: [] };
  }
}

async function searchMobs(
  query: string,
  limit: number,
  eraMax: number,
  zoneHint: ZoneHint | null,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  const run = (zone: string) => refdbMobSearch({
    query,
    eraMax,
    minLevel: 0,
    maxLevel: 0,
    zone,
    limit,
    offset: 0,
  });
  try {
    const [zoneRes, allRes] = await Promise.all([
      zoneHint ? run(zoneHint.shortName).catch(() => null) : Promise.resolve(null),
      run(""),
    ]);
    const rows = mergeResults(
      zoneRes?.rows.map((row) => mobResult(row, zoneHint)) ?? [],
      allRes.rows.map((row) => mobResult(row, null)),
    ).slice(0, limit);
    return { total: Math.max(allRes.total, zoneRes?.total ?? 0), rows };
  } catch {
    return { total: 0, rows: [] };
  }
}

async function searchQuestRecords(
  query: string,
  limit: number,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  const catalog = await loadQuestCatalog();
  const matches = searchQuests(query, { limit: 5000 }, catalog.quests);
  return { total: matches.length, rows: matches.slice(0, limit).map(questResult) };
}

async function searchSpells(
  query: string,
  isAbility: boolean,
  limit: number,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  return spellsSearch({
    query,
    isAbility,
    classes: "",
    maxLevel: 0,
    sort: "name",
    descending: false,
    limit,
    offset: 0,
  })
    .then((res) => ({
      total: res.total,
      rows: res.rows.map((row) => spellResult(row, isAbility)),
    }))
    .catch(() => ({ total: 0, rows: [] }));
}

async function searchRecipes(
  query: string,
  limit: number,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  return refdbRecipeSearch({
    query,
    tradeskill: 0,
    maxTrivial: 0,
    limit,
    offset: 0,
  })
    .then((res) => ({
      total: res.total,
      rows: res.rows.map(recipeResult),
    }))
    .catch(() => ({ total: 0, rows: [] }));
}

async function searchTriggers(
  query: string,
  limit: number,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  return getTriggerTree()
    .then((entries) => {
      const matches = entries.filter((entry) => triggerMatches(entry, query));
      return {
        total: matches.length,
        rows: matches.slice(0, limit).map(triggerResult),
      };
    })
    .catch(() => ({ total: 0, rows: [] }));
}

async function searchLogs(
  query: string,
  limit: number,
): Promise<{ rows: GlobalSearchResult[]; total: number }> {
  const [recent, discovered] = await Promise.all([
    Promise.resolve(searchRecentLogs(query, limit)),
    discoverLogs().catch(() => []),
  ]);
  const merged = mergeLogs(recent, discovered)
    .filter((log) =>
      [log.character, log.server, log.path].some((part) =>
        normalize(part).includes(normalize(query)),
      ),
    )
    .slice(0, limit);
  return { total: merged.length, rows: merged.map(logResult) };
}

function itemResult(row: DropItemRow, zoneHint: ZoneHint | null): GlobalSearchResult {
  const inCurrentZone =
    !!zoneHint && normalize(row.topZone ?? "") === normalize(zoneHint.longName);
  const effects = [
    inCurrentZone && "Current zone",
    row.procName && `Proc: ${row.procName}`,
    row.clickName && `Click: ${row.clickName}`,
    row.wornName && `Worn: ${row.wornName}`,
    row.focusName && `Focus: ${row.focusName}`,
  ].filter(isString);
  return {
    id: `item:${row.id}`,
    group: "items",
    title: row.name,
    subtitle: row.topNpc
      ? `Best drop: ${row.topNpc}${row.topZone ? ` in ${row.topZone}` : ""}`
      : row.sources > 0
        ? `${row.sources} known drop source${row.sources === 1 ? "" : "s"}`
        : "Item reference",
    meta: effects,
    action: itemNavigationAction(row),
  };
}

export function itemNavigationAction(
  row: Pick<DropItemRow, "id" | "name" | "sources">,
): Extract<GlobalSearchAction, { kind: "open-tab-search" }> {
  return {
    kind: "open-tab-search",
    tab: "drops",
    query: row.name,
    targetId: row.id,
    revealUnsourced: row.sources === 0,
  };
}

function mobResult(row: MobRow, zoneHint: ZoneHint | null): GlobalSearchResult {
  const inCurrentZone =
    !!zoneHint && normalize(row.topZone ?? "") === normalize(zoneHint.longName);
  return {
    id: `mob:${row.id}`,
    group: "mobs",
    title: row.name,
    subtitle: [
      row.level > 0 ? `Level ${row.level}` : "",
      row.topZone ?? "",
    ].filter(Boolean).join(" · "),
    meta: [
      inCurrentZone ? "Current zone" : "",
      row.named ? "Named" : "",
      row.merchant ? "Merchant" : "",
      row.lootCount > 0 ? `${row.lootCount} loot` : "",
    ].filter(Boolean),
    action: { kind: "open-tab-search", tab: "mobs", query: row.name, targetId: row.id },
  };
}

function questResult(row: QuestRecord): GlobalSearchResult {
  return {
    id: `quest:${row.id}`,
    group: "quests",
    title: row.name,
    subtitle: [row.zone, row.givers[0] ? `Giver: ${row.givers[0]}` : ""].filter(Boolean).join(" · "),
    meta: [
      row.classes.join(" / "),
      row.requirements.length > 0 ? `${row.requirements.length} required items` : "",
    ].filter(Boolean),
    action: { kind: "open-tab-search", tab: "quests", query: row.name, targetId: row.id },
  };
}

function spellResult(row: SpellRow, isAbility: boolean): GlobalSearchResult {
  const groupId = isAbility ? "abilities" : "spells";
  return {
    id: `${groupId}:${row.id}`,
    group: groupId,
    title: row.name,
    subtitle: row.classesStr ?? (isAbility ? "Ability" : "Spell"),
    meta: [
      row.mana > 0 ? `${row.mana} mana` : "",
      row.endurance > 0 ? `${row.endurance} endurance` : "",
      row.beneficial ? "Beneficial" : "",
    ].filter(Boolean),
    action: {
      kind: "open-tab-search",
      tab: "spells",
      query: row.name,
      targetId: row.id,
      isAbility,
    },
  };
}

function recipeResult(row: RecipeRef): GlobalSearchResult {
  return {
    id: `recipe:${row.id}`,
    group: "recipes",
    title: row.name,
    subtitle: tradeskillName(row.tradeskill),
    meta: [row.trivial > 0 ? `Trivial ${row.trivial}` : "No fail"].filter(Boolean),
    action: { kind: "open-tab-search", tab: "recipes", query: row.name, targetId: row.id },
  };
}

function triggerResult(row: TriggerTreeEntry): GlobalSearchResult {
  return {
    id: `trigger:${row.id}`,
    group: "triggers",
    title: row.name,
    subtitle: row.category ?? "Uncategorized",
    meta: [
      row.source,
      row.effectiveEnabled ? "Enabled" : "Disabled",
      row.speaks ? "TTS" : "",
      row.shows ? "Alert" : "",
      row.timer ? "Timer" : "",
    ].filter(Boolean),
    action: {
      kind: "open-trigger",
      tab: "triggers",
      triggerId: row.id,
      query: row.name,
    },
  };
}

function logResult(row: RecentLogEntry): GlobalSearchResult {
  return {
    id: `log:${row.path}`,
    group: "characters",
    title: row.character || "Unknown character",
    subtitle: row.server || "Unknown server",
    meta: [row.path],
    action: {
      kind: "open-character-log",
      tab: "settings",
      path: row.path,
      character: row.character,
      server: row.server,
    },
  };
}

function triggerMatches(row: TriggerTreeEntry, query: string): boolean {
  const q = normalize(query);
  return [
    row.name,
    row.category ?? "",
    row.pattern,
    row.source,
    row.classes.join(" "),
  ].some((part) => normalize(part).includes(q));
}

function group(
  id: GlobalSearchGroupId,
  results: GlobalSearchResult[],
  total?: number,
): GlobalSearchGroup {
  return { id, title: GROUP_TITLES[id], results, total };
}

function emptyGroups(): GlobalSearchGroup[] {
  return (Object.keys(GROUP_TITLES) as GlobalSearchGroupId[]).map((id) =>
    group(id, []),
  );
}

function mergeLogs(
  recent: RecentLogEntry[],
  discovered: DiscoveredLog[],
): RecentLogEntry[] {
  const out: RecentLogEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: RecentLogEntry) => {
    const key = normalize(entry.path);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  recent.forEach(add);
  discovered.forEach((log) =>
    add({
      path: log.path,
      character: log.character,
      server: log.server,
      modifiedTs: log.modifiedTs,
      lastOpenedTs: log.modifiedTs ?? 0,
    }),
  );
  return out;
}

interface ZoneHint {
  shortName: string;
  longName: string;
}

async function resolveZoneHint(zone: string | null | undefined): Promise<ZoneHint | null> {
  const q = normalize(zone ?? "");
  if (!q) return null;
  const zones = await loadZones();
  const match =
    zones.find((z) => normalize(z.longName) === q) ??
    zones.find((z) => normalize(z.shortName) === q) ??
    zones.find((z) => normalize(z.longName).includes(q) || q.includes(normalize(z.longName)));
  return match ? { shortName: match.shortName, longName: match.longName } : null;
}

async function loadZones(): Promise<DropZone[]> {
  if (zoneCache) return zoneCache;
  zoneCache = await dropsZones().catch(() => []);
  return zoneCache;
}

function mergeResults<T extends GlobalSearchResult>(preferred: T[], fallback: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of [...preferred, ...fallback]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function loadRecentLogs(): RecentLogEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_LOGS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentLogEntry).slice(0, RECENT_LOG_LIMIT);
  } catch {
    return [];
  }
}

function saveRecentLogs(entries: RecentLogEntry[]): void {
  try {
    localStorage.setItem(RECENT_LOGS_KEY, JSON.stringify(entries));
  } catch {
    // Recent logs are only a convenience cache.
  }
}

function isRecentLogEntry(value: unknown): value is RecentLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    typeof entry.character === "string" &&
    typeof entry.server === "string" &&
    (typeof entry.modifiedTs === "number" || entry.modifiedTs === null) &&
    typeof entry.lastOpenedTs === "number"
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function isString(value: string | null | false): value is string {
  return typeof value === "string" && value.length > 0;
}
