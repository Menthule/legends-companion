import { useEffect, useMemo, useState } from "react";
import { getConfig, inventoryDiscover, inventoryImport, pickInventoryFile } from "../api";
import {
  matchQuestRequirements,
  loadQuestCatalog,
  searchQuests,
  type InventorySnapshot,
  type QuestCatalog,
  type QuestRecord,
} from "../lib/quests";

const INVENTORY_PATH_KEY = "eqlogs.inventory.path.v1";
const INVENTORY_SNAPSHOT_KEY = "eqlogs.inventory.snapshot.v1";

function serverFromLogPath(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? "";
  return /^eqlog_[^_]+_(.+)\.txt$/i.exec(filename)?.[1] ?? "";
}

function savedInventoryPath(character: string): string {
  try {
    const rows = JSON.parse(localStorage.getItem(INVENTORY_PATH_KEY) ?? "{}") as Record<string, string>;
    return rows[character.toLowerCase()] ?? "";
  } catch {
    return "";
  }
}

function rememberInventoryPath(character: string, path: string): void {
  try {
    const rows = JSON.parse(localStorage.getItem(INVENTORY_PATH_KEY) ?? "{}") as Record<string, string>;
    rows[character.toLowerCase()] = path;
    localStorage.setItem(INVENTORY_PATH_KEY, JSON.stringify(rows));
  } catch {
    // Best-effort convenience; automatic discovery remains available.
  }
}

function savedInventorySnapshot(character: string): InventorySnapshot | null {
  try {
    const rows = JSON.parse(localStorage.getItem(INVENTORY_SNAPSHOT_KEY) ?? "{}") as Record<string, InventorySnapshot>;
    return rows[character.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function rememberInventorySnapshot(character: string, snapshot: InventorySnapshot): void {
  try {
    const rows = JSON.parse(localStorage.getItem(INVENTORY_SNAPSHOT_KEY) ?? "{}") as Record<string, InventorySnapshot>;
    rows[character.toLowerCase()] = snapshot;
    localStorage.setItem(INVENTORY_SNAPSHOT_KEY, JSON.stringify(rows));
  } catch {
    // The current in-memory snapshot remains usable if persistence is unavailable.
  }
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
  const [className, setClassName] = useState("");
  const [inventory, setInventory] = useState<InventorySnapshot | null>(() => savedInventorySnapshot(character));
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [catalog, setCatalog] = useState<QuestCatalog | null>(null);
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

  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
  }, [searchRequest?.seq]);

  const zones = useMemo(
    () => [...new Set((catalog?.quests ?? []).map((quest) => quest.zone).filter(Boolean))].sort(),
    [catalog],
  );
  const classes = useMemo(
    () => [...new Set((catalog?.quests ?? []).flatMap((quest) => quest.classes).filter(Boolean))].sort(),
    [catalog],
  );
  const results = useMemo(
    () => searchQuests(query, { zone, className, limit: 150 }, catalog?.quests ?? []),
    [query, zone, className, catalog],
  );

  return (
    <div className="quests-page">
      <section className="quest-toolbar-band">
        <div className="quest-search-row">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Quest, giver, item, or reward"
            aria-label="Search quests"
            autoFocus
          />
          <select value={zone} onChange={(event) => setZone(event.target.value)} aria-label="Quest zone">
            <option value="">All zones</option>
            {zones.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={className} onChange={(event) => setClassName(event.target.value)} aria-label="Quest class">
            <option value="">All classes</option>
            {classes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <span className="hint">{catalog ? `${results.length} shown · ${catalog.quests.length} quests` : "Loading catalog..."}</span>
        </div>
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
            {inventoryError && <small className="error-text">{inventoryError}</small>}
          </div>
          <button className="ghost small" disabled={inventoryLoading} onClick={() => void loadInventory()}>
            {inventoryLoading ? "Reading..." : "Refresh"}
          </button>
          <button className="ghost small" disabled={inventoryLoading} onClick={() => void loadInventory(true)}>
            Browse
          </button>
        </div>
      </section>

      <section className="quest-results" aria-live="polite">
        {results.map((quest) => <QuestRow key={quest.id} quest={quest} inventory={inventory} />)}
        {results.length === 0 && (
          <div className="quest-empty">No quests match these filters.</div>
        )}
      </section>

      <footer className="quest-attribution">
        {catalog ? `${catalog.attribution} Content is ${catalog.license}. Catalog revision generated ${new Date(catalog.generatedAt).toLocaleDateString()}.` : "Loading quest attribution..."}
      </footer>
    </div>
  );
}

function QuestRow({ quest, inventory }: { quest: QuestRecord; inventory: InventorySnapshot | null }) {
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
              {requirement.locations.length > 0 && <small>{requirement.locations.join(", ")}</small>}
            </label>
          ))}
        </div>
      )}
      {quest.rewards.length > 0 && (
        <div className="quest-rewards"><span>Rewards</span><strong>{quest.rewards.join(" / ")}</strong></div>
      )}
      <footer>
        <span>Source revision {quest.sourceRevisionId} · {new Date(quest.sourceRevisionAt).toLocaleDateString()}</span>
        <a href={quest.sourceUrl} target="_blank" rel="noreferrer">Open source</a>
      </footer>
    </article>
  );
}
