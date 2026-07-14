// Quests reference tab: browse the bundled community quest catalog with
// inventory-aware readiness checks (via /output inventory exports). Chrome
// follows the shared Database-tab conventions: .card drops-card head,
// drops-controls with SearchSelect zone + global ClassFilterButton/EraSelect
// (the era ceiling also scopes the drop-source/reward lookups below),
// error-banner errors, Empty states, and the standard Pager. Filtering and
// paging are client-side — the catalog is a local JSON module, not sqlite.

import { useEffect, useMemo, useRef, useState } from "react";
import { dropsQuestItemReferences, getConfig, inventoryDiscover, inventoryImport, pickInventoryFile } from "../api";
import {
  matchQuestRequirements,
  isQuestReady,
  loadQuestCatalog,
  normalizeQuestName,
  questDropSourceSummary,
  questItemDetailLines,
  searchQuests,
  type InventorySnapshot,
  type QuestCatalog,
  type QuestRecord,
} from "../lib/quests";
import {
  onInventoryChanged,
  rememberInventoryPath,
  rememberInventorySnapshot,
  savedInventoryPath,
  savedInventorySnapshot,
} from "../lib/inventoryStore";
import {
  classMaskFullNames,
  useClassMask,
  useEraMax,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { ClassFilterButton, EraSelect } from "./RefFilters";
import { SearchSelect } from "./SearchSelect";
import Empty from "./Empty";
import Pager from "./Pager";
import type { QuestItemReference } from "../types";

const PAGE_SIZE = 50;

function serverFromLogPath(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? "";
  return /^eqlog_[^_]+_(.+)\.txt$/i.exec(filename)?.[1] ?? "";
}

/** Loose class-name compare: "Shadow Knight" (catalog) === "ShadowKnight" (mask). */
function normClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Match the live in-game zone name against the catalog's zone strings. */
function resolveQuestZone(liveZone: string, zones: string[]): string {
  const q = normClassName(liveZone);
  if (!q) return "";
  return (
    zones.find((z) => normClassName(z) === q) ??
    zones.find((z) => normClassName(z).includes(q) || q.includes(normClassName(z))) ??
    ""
  );
}

export default function QuestsTab({
  character,
  searchRequest,
}: {
  character: string;
  searchRequest?: { query: string; seq: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [inventory, setInventory] = useState<InventorySnapshot | null>(() => savedInventorySnapshot(character));
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [catalog, setCatalog] = useState<QuestCatalog | null>(null);
  const [itemReferences, setItemReferences] = useState<Map<string, QuestItemReference>>(new Map());
  const [referenceError, setReferenceError] = useState("");
  const [eraMax] = useEraMax();
  const [classMask] = useClassMask();
  const [liveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const inputRef = useRef<HTMLInputElement>(null);
  const inventoryStale = inventory != null && Date.now() - inventory.sourceModifiedMs > 24 * 60 * 60 * 1000;

  useEffect(() => {
    void loadQuestCatalog().then(setCatalog);
  }, []);

  const loadInventory = async (forceBrowse = false) => {
    setInventoryLoading(true);
    setInventoryError("");
    try {
      if (forceBrowse) {
        const path = await pickInventoryFile();
        if (!path) return;
        const snapshot = await inventoryImport(path);
        rememberInventoryPath(character, path);
        rememberInventorySnapshot(character, snapshot);
        setInventory(snapshot);
        return;
      }
      const remembered = savedInventoryPath(character);
      if (remembered) {
        try {
          const snapshot = await inventoryImport(remembered);
          rememberInventorySnapshot(character, snapshot);
          setInventory(snapshot);
          return;
        } catch {
          // Fall through to install-folder discovery.
        }
      }
      const config = await getConfig();
      const snapshot = await inventoryDiscover({
        logPath: config.logPath,
        character: character || config.characterName,
        server: serverFromLogPath(config.logPath),
      });
      if (!snapshot) {
        setInventoryError("No inventory export was found. Run /output inventory in game, then refresh.");
        return;
      }
      setInventory(snapshot);
      rememberInventoryPath(character || config.characterName, snapshot.sourcePath);
      rememberInventorySnapshot(character || config.characterName, snapshot);
    } catch (error) {
      setInventoryError(String(error));
    } finally {
      setInventoryLoading(false);
    }
  };

  useEffect(() => {
    setInventory(savedInventorySnapshot(character));
    void loadInventory();
  }, [character]);

  // Cross-window sync: another window refreshed the inventory export.
  useEffect(() => {
    return onInventoryChanged((remote) => {
      if (remote) setInventory(savedInventorySnapshot(character));
    });
  }, [character]);

  useEffect(() => {
    if (!inventory) setReadyOnly(false);
  }, [inventory]);

  // Deep-link (e.g. a quest giver clicked elsewhere): clean lookup.
  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
    setPage(0);
    inputRef.current?.focus();
  }, [searchRequest?.seq]);

  const zones = useMemo(
    () => [...new Set((catalog?.quests ?? []).map((quest) => quest.zone).filter(Boolean))].sort(),
    [catalog],
  );

  // Follow the live zone only when it CHANGES (zoning, or toggle flipped on):
  // a manual pick in the zone dropdown must stick, not snap back.
  const liveZoneMatch = useMemo(
    () => resolveQuestZone(liveZoneName, zones),
    [liveZoneName, zones],
  );
  const appliedLiveZone = useRef<string | null>(null);
  useEffect(() => {
    if (!liveZoneEnabled || !liveZoneMatch) {
      appliedLiveZone.current = null;
      return;
    }
    if (appliedLiveZone.current === liveZoneMatch) return;
    appliedLiveZone.current = liveZoneMatch;
    if (zone !== liveZoneMatch) {
      setZone(liveZoneMatch);
      setPage(0);
    }
  }, [liveZoneEnabled, liveZoneMatch, zone]);

  // Global class mask ("any of the checked") against the catalog's class
  // tags. Quests tagged "All Classes" match any selection; quests with no
  // documented class only show when no class filter is set (old behavior).
  const selectedClasses = useMemo(
    () => classMaskFullNames(classMask).map(normClassName),
    [classMask],
  );
  const filteredQuests = useMemo(() => {
    const matches = searchQuests(query, { zone, limit: catalog?.quests.length ?? 1 }, catalog?.quests ?? []);
    if (selectedClasses.length === 0) return matches;
    return matches.filter((quest) =>
      quest.classes.some((value) => {
        const name = normClassName(value);
        return name === "allclasses" || selectedClasses.includes(name);
      }),
    );
  }, [query, zone, selectedClasses, catalog]);
  const readyCount = useMemo(
    () => filteredQuests.filter((quest) => isQuestReady(quest, inventory)).length,
    [filteredQuests, inventory],
  );
  const results = useMemo(
    () => (readyOnly ? filteredQuests.filter((quest) => isQuestReady(quest, inventory)) : filteredQuests),
    [filteredQuests, inventory, readyOnly],
  );
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const pageRows = useMemo(
    () => results.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [results, safePage],
  );
  // Drop-source/reward lookups only cover the visible page.
  const referenceNames = useMemo(
    () => [...new Set(pageRows.flatMap((quest) => [
      ...quest.requirements.map((requirement) => requirement.itemName),
      ...quest.rewards,
    ]).filter(Boolean))],
    [pageRows],
  );
  const referenceKey = referenceNames.join("\u0000");

  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      setReferenceError("");
      void dropsQuestItemReferences(referenceNames, eraMax)
        .then((references) => {
          if (!stale) {
            setItemReferences(new Map(references.map((reference) => [normalizeQuestName(reference.queryName), reference])));
          }
        })
        .catch((error) => {
          if (!stale) setReferenceError(String(error));
        });
    }, 120);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [referenceKey, eraMax]);

  function clearAll() {
    setQuery("");
    setZone("");
    setReadyOnly(false);
    setPage(0);
  }

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">Quests</span>
        <span className="hint">
          Community quest catalog — drop locations and reward stats use the
          bundled classic reference database.
        </span>
      </div>
      <div className="drops-controls">
        <input
          ref={inputRef}
          type="search"
          placeholder="Quest, giver, item, or reward…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          aria-label="Search quests"
        />
        <div className="mobs-zone">
          <SearchSelect
            value={zone}
            anyLabel="Any zone"
            options={zones.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              setZone(value);
              setPage(0);
            }}
          />
        </div>
        <ClassFilterButton />
        <EraSelect />
        <label className="quest-ready-filter" title={inventory ? "Show quests with every required item available" : "Load an inventory export to filter ready quests"}>
          <input
            type="checkbox"
            checked={readyOnly}
            disabled={!inventory}
            onChange={(event) => {
              setReadyOnly(event.target.checked);
              setPage(0);
            }}
          />
          <span>Ready</span>
          {inventory && <strong>{readyCount}</strong>}
        </label>
        {(query !== "" || zone !== "" || readyOnly) && (
          <button className="ghost small" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {inventoryError && <div className="error-banner">{inventoryError}</div>}
      {referenceError && <div className="error-banner">{referenceError}</div>}

      <div className="quest-inventory-bar">
        <div>
          <span>Inventory</span>
          <strong>{inventory ? `${inventory.items.length} owned item types` : "No export loaded"}</strong>
          {inventory && (
            <small>
              {new Date(inventory.sourceModifiedMs).toLocaleString()} · {inventory.sourcePath}
            </small>
          )}
          {inventoryStale && <small className="warning-text">This export is over 24 hours old. Refresh it in game for accurate checkmarks.</small>}
        </div>
        <button className="ghost small" disabled={inventoryLoading} onClick={() => void loadInventory()}>
          {inventoryLoading ? "Reading…" : "Refresh"}
        </button>
        <button className="ghost small" disabled={inventoryLoading} onClick={() => void loadInventory(true)}>
          Browse
        </button>
      </div>

      {catalog === null ? (
        <div className="hint">Loading quest catalog…</div>
      ) : results.length === 0 ? (
        <Empty
          title="No matches"
          body={
            readyOnly
              ? "No quests are fully ready with the current inventory export — uncheck Ready, or refresh the export in game."
              : "No quests match these filters — try clearing the zone or class filter, or widening the search."
          }
        />
      ) : (
        <>
          <section className="quest-results" aria-live="polite">
            {pageRows.map((quest) => (
              <QuestRow key={quest.id} quest={quest} inventory={inventory} itemReferences={itemReferences} />
            ))}
          </section>
          <Pager
            count={`${results.length} quest${results.length === 1 ? "" : "s"} · ${catalog.quests.length} in catalog`}
            page={safePage}
            pages={pages}
            onPage={setPage}
          />
        </>
      )}

      {catalog && (
        <footer className="quest-attribution">
          {`${catalog.attribution} Content is ${catalog.license}. Catalog revision generated ${new Date(catalog.generatedAt).toLocaleDateString()}.`}
        </footer>
      )}
    </div>
  );
}

function QuestRow({
  quest,
  inventory,
  itemReferences,
}: {
  quest: QuestRecord;
  inventory: InventorySnapshot | null;
  itemReferences: Map<string, QuestItemReference>;
}) {
  const requirements = matchQuestRequirements(quest.requirements, inventory);
  const completed = requirements.filter((requirement) => requirement.satisfied).length;
  return (
    <article className="quest-row-card">
      <header>
        <div>
          <h3>{quest.name}</h3>
          <span>{[quest.zone, ...quest.classes].filter(Boolean).join(" · ") || "General quest"}</span>
        </div>
        {quest.id.startsWith("sky:") && <span className="quest-sky-badge">Plane of Sky</span>}
      </header>
      {quest.summary && <p>{quest.summary}</p>}
      <div className="quest-meta-line">
        <span>Giver</span><strong>{quest.givers.join(" / ") || "Not documented"}</strong>
        {quest.minimumLevel != null && <><span>Level</span><strong>{quest.minimumLevel}+</strong></>}
      </div>
      {requirements.length > 0 && (
        <div className="quest-requirements">
          <div className="quest-requirements-head">
            <strong>Required items</strong>
            <span>{inventory ? `${completed}/${requirements.length} ready` : `${requirements.length} items`}</span>
          </div>
          {requirements.map((requirement, index) => (
            <label className={requirement.satisfied ? "complete" : ""} key={`${requirement.itemName}:${index}`}>
              <input type="checkbox" checked={requirement.satisfied} readOnly disabled />
              <span>{requirement.itemName}</span>
              <strong>{inventory ? `${requirement.owned}/${requirement.quantity}` : `x${requirement.quantity}`}</strong>
              {requirement.locations.length > 0 && <small>Owned: {requirement.locations.join(", ")}</small>}
              <small className="quest-drop-source">
                Drops: {questDropSourceSummary(itemReferences.get(normalizeQuestName(requirement.itemName)))}
              </small>
            </label>
          ))}
        </div>
      )}
      {quest.rewards.length > 0 && (
        <div className="quest-rewards">
          <span>Rewards</span>
          <div className="quest-reward-items">
            {quest.rewards.map((reward, index) => (
              <RewardItem
                key={`${reward}:${index}`}
                name={reward}
                reference={itemReferences.get(normalizeQuestName(reward))}
              />
            ))}
          </div>
        </div>
      )}
      <footer>
        <span>Source revision {quest.sourceRevisionId} · {new Date(quest.sourceRevisionAt).toLocaleDateString()}</span>
        <a href={quest.sourceUrl} target="_blank" rel="noreferrer">Open source</a>
      </footer>
    </article>
  );
}

function RewardItem({ name, reference }: { name: string; reference?: QuestItemReference }) {
  const lines = questItemDetailLines(reference?.item ?? null);
  return (
    <span className="quest-reward-item" tabIndex={0}>
      {name}
      <span className="quest-item-tip" role="tooltip">
        <strong>{reference?.item?.name ?? name}</strong>
        {lines.map((line) => <span key={line}>{line}</span>)}
        <span className="quest-item-tip-source">Drops: {questDropSourceSummary(reference)}</span>
      </span>
    </span>
  );
}
