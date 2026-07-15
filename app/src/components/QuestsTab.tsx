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
  hasOwnedQuestReward,
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
import {
  addQuestKillWatch,
  addQuestWatches,
  loadWatchedKills,
  loadWishlist,
  onWishlistChanged,
  questGoal,
  reconcileWishlistInventory,
  removeQuestWatch,
  removeQuestKillWatch,
  removeQuestWatches,
} from "../lib/wishlist";

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
  searchRequest?: { query: string; seq: number; targetId?: string } | null;
}) {
  const [query, setQuery] = useState("");
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [zone, setZone] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [hideOwnedRewards, setHideOwnedRewards] = useState(false);
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
  const [, bumpWatches] = useState(0);
  const watchRevision = loadWishlist()
    .flatMap((item) => item.goals.map((goal) => `${item.key}:${goal.id}`))
    .concat(loadWatchedKills().flatMap((kill) =>
      kill.goals.map((goal) => `kill:${kill.key}:${goal.id}:${goal.remainingQuantity}`)))
    .join("|");

  useEffect(() => onWishlistChanged(() => bumpWatches((value) => value + 1)), []);

  useEffect(() => {
    if (inventory) void reconcileWishlistInventory(inventory).catch(() => {});
  }, [inventory, watchRevision]);

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
    if (!inventory) {
      setReadyOnly(false);
      setHideOwnedRewards(false);
    }
  }, [inventory]);

  // Deep-link (e.g. a quest giver clicked elsewhere): clean lookup.
  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
    setSelectedQuestId(searchRequest.targetId ?? null);
    setPage(0);
    if (!searchRequest.targetId) inputRef.current?.focus();
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
    if (selectedQuestId) {
      const selected = catalog?.quests.find((quest) => quest.id === selectedQuestId);
      return selected ? [selected] : [];
    }
    const matches = searchQuests(query, { zone, limit: catalog?.quests.length ?? 1 }, catalog?.quests ?? []);
    if (selectedClasses.length === 0) return matches;
    return matches.filter((quest) =>
      quest.classes.some((value) => {
        const name = normClassName(value);
        return name === "allclasses" || selectedClasses.includes(name);
      }),
    );
  }, [query, zone, selectedClasses, selectedQuestId, catalog]);
  const readyCount = useMemo(
    () => filteredQuests.filter((quest) => isQuestReady(quest, inventory)).length,
    [filteredQuests, inventory],
  );
  const results = useMemo(() => {
    // A global-search selection is an explicit request for this quest; local
    // filters must not make the destination disappear after navigation.
    if (selectedQuestId) return filteredQuests;
    let next = readyOnly
      ? filteredQuests.filter((quest) => isQuestReady(quest, inventory))
      : filteredQuests;
    if (hideOwnedRewards) {
      next = next.filter((quest) => !hasOwnedQuestReward(quest, inventory));
    }
    return next;
  }, [filteredQuests, hideOwnedRewards, inventory, readyOnly, selectedQuestId]);
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
    setSelectedQuestId(null);
    setZone("");
    setReadyOnly(false);
    setHideOwnedRewards(false);
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
            setSelectedQuestId(null);
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
        <label className="quest-ready-filter" title={inventory ? "Hide quests when a documented final reward is already in your inventory" : "Load an inventory export to hide owned rewards"}>
          <input
            type="checkbox"
            checked={hideOwnedRewards}
            disabled={!inventory}
            onChange={(event) => {
              setHideOwnedRewards(event.target.checked);
              setPage(0);
            }}
          />
          <span>Hide owned rewards</span>
        </label>
        {(query !== "" || zone !== "" || readyOnly || hideOwnedRewards) && (
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
              : hideOwnedRewards
                ? "Every matching quest has a documented reward already in this inventory — uncheck Hide owned rewards to include them."
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
  const groupedRequirements = [...requirements.reduce((groups, requirement) => {
    const key = normalizeQuestName(requirement.itemName);
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += requirement.quantity;
      existing.owned = Math.max(existing.owned, requirement.owned);
      existing.satisfied = existing.owned >= existing.quantity;
    } else {
      groups.set(key, { ...requirement });
    }
    return groups;
  }, new Map<string, (typeof requirements)[number]>()).values()];
  const completed = groupedRequirements.filter((requirement) => requirement.satisfied).length;
  const missing = groupedRequirements.filter((requirement) => !requirement.satisfied);
  const questKillGoals = loadWatchedKills().flatMap((kill) =>
    kill.goals
      .filter((goal) => goal.source.kind === "quest" && goal.source.questId === quest.id)
      .map((goal) => ({ kill, goal })),
  );
  const watchedCount = groupedRequirements.filter((requirement) => questGoal(requirement.itemName, quest.id)).length
    + questKillGoals.length;
  const hasUnwatchedMissing = missing.some((requirement) => !questGoal(requirement.itemName, quest.id));
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [killFormOpen, setKillFormOpen] = useState(false);
  const [killName, setKillName] = useState("");
  const [killQuantity, setKillQuantity] = useState(1);

  const watchMissing = async () => {
    setWatchBusy(true);
    setWatchError("");
    try {
      await addQuestWatches(missing.map((requirement) => ({
        itemName: requirement.itemName,
        questId: quest.id,
        questName: quest.name,
        requiredQuantity: requirement.quantity,
        ownedQuantity: requirement.owned,
        autoRemove: true,
      })));
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const removeAll = async () => {
    setWatchBusy(true);
    setWatchError("");
    try {
      await removeQuestWatches(quest.id);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const toggleRequirement = async (
    requirement: (typeof requirements)[number],
    watched: boolean,
  ) => {
    setWatchBusy(true);
    setWatchError("");
    try {
      if (watched) {
        await removeQuestWatch(requirement.itemName, quest.id);
      } else {
        await addQuestWatches([{
          itemName: requirement.itemName,
          questId: quest.id,
          questName: quest.name,
          requiredQuantity: requirement.quantity,
          ownedQuantity: requirement.owned,
          autoRemove: true,
        }]);
      }
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const addKillGoal = async () => {
    const mobName = killName.trim();
    if (!mobName) return;
    setWatchBusy(true);
    setWatchError("");
    try {
      await addQuestKillWatch({
        mobName,
        questId: quest.id,
        questName: quest.name,
        requiredQuantity: killQuantity,
        observedQuantity: 0,
        autoRemove: true,
      });
      setKillName("");
      setKillQuantity(1);
      setKillFormOpen(false);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  const removeKillGoal = async (mobName: string) => {
    setWatchBusy(true);
    setWatchError("");
    try {
      await removeQuestKillWatch(mobName, quest.id);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };
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
            <div className="quest-watch-actions">
              <span>{inventory ? `${completed}/${groupedRequirements.length} ready` : `${groupedRequirements.length} items`}</span>
              {missing.length > 0 && hasUnwatchedMissing && (
                <button className="ghost small" disabled={watchBusy} onClick={() => void watchMissing()}>
                  Watch missing ({missing.length})
                </button>
              )}
              {watchedCount > 0 && (
                <button className="ghost small" disabled={watchBusy} onClick={() => void removeAll()}>
                  Remove watches
                </button>
              )}
            </div>
          </div>
          {requirements.map((requirement, index) => {
            const grouped = groupedRequirements.find((candidate) =>
              normalizeQuestName(candidate.itemName) === normalizeQuestName(requirement.itemName)) ?? requirement;
            const watched = questGoal(grouped.itemName, quest.id) !== null;
            return (
            <div className={`quest-requirement-row${grouped.satisfied ? " complete" : ""}`} key={`${requirement.itemName}:${index}`}>
              <input type="checkbox" checked={grouped.satisfied} readOnly disabled />
              <span>{requirement.itemName}</span>
              <strong>{inventory ? `${grouped.owned}/${grouped.quantity}` : `x${grouped.quantity}`}</strong>
              <button
                className={`quest-watch-toggle${watched ? " on" : ""}`}
                title={watched
                  ? `Stop watching ${requirement.itemName} for this quest`
                  : grouped.satisfied
                    ? `${requirement.itemName} is already available`
                    : `Watch ${requirement.itemName} for this quest`}
                aria-label={watched ? `Stop watching ${requirement.itemName}` : `Watch ${requirement.itemName}`}
                aria-pressed={watched}
                disabled={watchBusy || (grouped.satisfied && !watched)}
                onClick={() => void toggleRequirement(grouped, watched)}
              >
                {watched ? "★" : "☆"}
              </button>
              {requirement.locations.length > 0 && <small>Owned: {requirement.locations.join(", ")}</small>}
              <small className="quest-drop-source">
                Drops: {questDropSourceSummary(itemReferences.get(normalizeQuestName(requirement.itemName)))}
              </small>
            </div>
            );
          })}
        </div>
      )}
      <div className="quest-kill-goals">
        <div className="quest-requirements-head">
          <strong>Required kills</strong>
          <button
            className="ghost small"
            disabled={watchBusy}
            onClick={() => setKillFormOpen((open) => !open)}
          >
            {killFormOpen ? "Cancel" : "+ Kill goal"}
          </button>
        </div>
        {questKillGoals.map(({ kill, goal }) => (
          <div className="quest-kill-goal-row" key={`${kill.key}:${goal.id}`}>
            <span>{kill.name}</span>
            <strong>{goal.ownedQuantity}/{goal.requiredQuantity} observed</strong>
            <button
              className="quest-watch-toggle on"
              title={`Stop watching kills of ${kill.name} for this quest`}
              aria-label={`Stop watching kills of ${kill.name}`}
              disabled={watchBusy}
              onClick={() => void removeKillGoal(kill.name)}
            >
              ★
            </button>
          </div>
        ))}
        {killFormOpen && (
          <div className="quest-kill-goal-form">
            <input
              type="text"
              value={killName}
              placeholder="Exact mob name"
              aria-label="Mob name"
              onChange={(event) => setKillName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addKillGoal();
              }}
            />
            <label>
              Count
              <input
                type="number"
                min={1}
                value={killQuantity}
                onChange={(event) => setKillQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
              />
            </label>
            <button className="primary small" disabled={watchBusy || !killName.trim()} onClick={() => void addKillGoal()}>
              Add
            </button>
          </div>
        )}
        {watchError && <div className="quest-watch-error">{watchError}</div>}
      </div>
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
