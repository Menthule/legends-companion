import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getConfig,
  inventoryDatabase,
  inventoryDiscover,
  inventoryImport,
  inventoryRecipeUsage,
  inventoryRemoveCurrency,
  inventorySetCurrency,
  inventorySetKeep,
  inventorySetQuestStatus,
  pickInventoryFile,
} from "../api";
import {
  aggregateInventory,
  classifyInventoryItem,
  inventoryDelta,
  questUsesForItem,
  type InventoryDatabase,
  type InventoryEvidence,
  type InventoryRow,
  type QuestProgressStatus,
} from "../lib/inventory";
import { openDrops, openQuests } from "../lib/deepLinks";
import { loadQuestCatalog, type QuestRecord } from "../lib/quests";
import { isWishlisted, onWishlistChanged } from "../lib/wishlist";
import { rememberInventoryPath, rememberInventorySnapshot } from "../lib/inventoryStore";
import Empty from "./Empty";

type View = "all" | "quest" | "duplicates" | "cleanup" | "currencies";
type Sort = "name" | "quantity" | "storage" | "status";

const CURRENCY_SUGGESTIONS = [
  "Jaka Wind Runes", "Kala Wind Runes", "Lena Wind Runes",
  "Motes of Infinitesimal Potential", "Motes of Lesser Potential",
  "Motes of Minor Potential", "Motes of Potential",
];

function serverFromLogPath(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? "";
  return /^eqlog_[^_]+_(.+)\.txt$/i.exec(filename)?.[1] ?? "";
}

function relativeTime(ms: number): string {
  if (!ms) return "Unknown time";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}

function statusClass(status: InventoryEvidence): string {
  return status.toLowerCase().replaceAll(" ", "-");
}

export default function InventoryTab({ character }: { character: string }) {
  const [database, setDatabase] = useState<InventoryDatabase | null>(null);
  const [server, setServer] = useState("");
  const [quests, setQuests] = useState<QuestRecord[]>([]);
  const [recipes, setRecipes] = useState<Map<number, number>>(new Map());
  const [query, setQuery] = useState("");
  const [storage, setStorage] = useState("all");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [, bumpWatches] = useState(0);
  const [currencyName, setCurrencyName] = useState("");
  const [currencyQuantity, setCurrencyQuantity] = useState("0");

  const load = useCallback(async () => {
    const config = await getConfig();
    const nextServer = serverFromLogPath(config.logPath);
    setServer(nextServer);
    const nextCharacter = character || config.characterName;
    let next = await inventoryDatabase(nextCharacter, nextServer);
    if (!next.current && config.logPath) {
      const discovered = await inventoryDiscover({
        logPath: config.logPath, character: nextCharacter, server: nextServer,
      });
      if (discovered) next = await inventoryDatabase(nextCharacter, nextServer);
    }
    const ids = [...new Set(next.entries.flatMap((entry) => entry.itemId == null ? [] : [entry.itemId]))];
    const usage = await inventoryRecipeUsage(ids);
    setRecipes(new Map(usage.map((row) => [row.itemId, row.usedIn])));
    setDatabase(next);
  }, [character]);

  useEffect(() => {
    void Promise.all([loadQuestCatalog(), load()])
      .then(([catalog]) => setQuests(catalog.quests))
      .catch((value) => setError(String(value)));
  }, [load]);

  useEffect(() => onWishlistChanged(() => bumpWatches((value) => value + 1)), []);

  const refresh = async (browse = false) => {
    setLoading(true);
    setError("");
    try {
      const config = await getConfig();
      const nextCharacter = character || config.characterName;
      const nextServer = serverFromLogPath(config.logPath);
      if (browse) {
        const path = await pickInventoryFile();
        if (!path) return;
        const snapshot = await inventoryImport(path, nextCharacter, nextServer);
        rememberInventoryPath(nextCharacter, path);
        rememberInventorySnapshot(nextCharacter, snapshot);
      } else {
        const found = await inventoryDiscover({
          logPath: config.logPath, character: nextCharacter, server: nextServer,
        });
        if (!found) throw new Error("No inventory export found. Run /output inventory in game first.");
        rememberInventoryPath(nextCharacter, found.sourcePath);
        rememberInventorySnapshot(nextCharacter, found);
      }
      await load();
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => aggregateInventory(database?.entries ?? []), [database?.entries]);
  const progress = database?.questProgress ?? [];
  const analyzed = useMemo(() => rows.map((row) => {
    const questUses = questUsesForItem(row, quests, progress);
    const recipeUses = row.itemId == null ? 0 : recipes.get(row.itemId) ?? 0;
    const status = classifyInventoryItem({
      row, questUses, recipeUses,
      keep: database?.keepKeys.includes(row.key) ?? false,
      watched: isWishlisted(row.name),
    });
    return { row, questUses, recipeUses, status };
  }), [database?.keepKeys, progress, quests, recipes, rows]);
  const storages = useMemo(() => [...new Set(rows.flatMap((row) => row.storages))].sort(), [rows]);
  const visible = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    const filtered = analyzed
      .filter(({ row }) => storage === "all" || row.storages.includes(storage))
      .filter(({ row, questUses }) => !wanted || [
        row.name, ...row.locations, ...questUses.map((use) => use.quest.name),
      ].some((value) => value.toLowerCase().includes(wanted)))
      .filter(({ row, questUses, status }) => {
        if (view === "quest") return questUses.length > 0;
        if (view === "duplicates") return row.quantity > 1 || row.entries.length > 1;
        if (view === "cleanup") return status === "Extra quantity" || status === "Completed quests only" || status === "No known use";
        return true;
      });
    return filtered.sort((left, right) => {
      if (sort === "quantity") return right.row.quantity - left.row.quantity || left.row.name.localeCompare(right.row.name);
      if (sort === "storage") return left.row.storages.join().localeCompare(right.row.storages.join()) || left.row.name.localeCompare(right.row.name);
      if (sort === "status") return left.status.localeCompare(right.status) || left.row.name.localeCompare(right.row.name);
      return left.row.name.localeCompare(right.row.name);
    });
  }, [analyzed, query, sort, storage, view]);
  const delta = inventoryDelta(database?.entries ?? [], database?.previousEntries ?? []);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const stale = database?.current != null && Date.now() - database.current.sourceModifiedMs > 24 * 60 * 60 * 1000;
  const missingConditional = ["hoard", "personal-depot"].filter((name) => !database?.current?.sections.includes(name));

  const toggleKeep = async (row: InventoryRow) => {
    const next = !(database?.keepKeys.includes(row.key) ?? false);
    await inventorySetKeep(character, server, row.key, next);
    await load();
  };

  const setQuestStatus = async (questId: string, status: QuestProgressStatus) => {
    await inventorySetQuestStatus(character, server, questId, status);
    await load();
  };

  const saveCurrency = async () => {
    const name = currencyName.trim();
    const quantity = Number.parseInt(currencyQuantity, 10);
    if (!name || !Number.isFinite(quantity) || quantity < 0) return;
    await inventorySetCurrency(character, server, name, quantity);
    setCurrencyName("");
    setCurrencyQuantity("0");
    await load();
  };

  return (
    <div className="inventory-page">
      <header className="inventory-toolbar">
        <div className="inventory-search-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an item, location, or quest" aria-label="Search inventory" />
          <select value={storage} onChange={(event) => setStorage(event.target.value)} aria-label="Storage area">
            <option value="all">All storage</option>
            {storages.map((value) => <option key={value} value={value}>{value.replaceAll("-", " ")}</option>)}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort inventory">
            <option value="name">Sort: item</option><option value="quantity">Sort: quantity</option>
            <option value="storage">Sort: storage</option><option value="status">Sort: status</option>
          </select>
          <button className="ghost" onClick={() => void refresh(false)} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
          <button className="ghost" onClick={() => void refresh(true)} disabled={loading}>Browse</button>
        </div>
        <div className="inventory-source-row">
          <span><strong>{character || "Character"}</strong> - {database?.current ? `${relativeTime(database.current.sourceModifiedMs)} - ${database.current.rowCount} exported rows` : "No saved inventory"}</span>
          {stale && <span className="inventory-warning">Snapshot is over 24 hours old</span>}
          {database?.current && missingConditional.length > 0 && <span className="inventory-warning">Not observed: {missingConditional.join(", ")}. Open those windows before exporting.</span>}
          {(database?.history.length ?? 0) > 0 && <details className="inventory-history"><summary>Import history</summary><div>{database?.history.slice(0, 8).map((snapshot, index) => <span key={snapshot.id}><strong>{index === 0 ? "Current" : new Date(snapshot.importedAtMs).toLocaleString()}</strong>{snapshot.rowCount} rows - {snapshot.sections.length} storage areas</span>)}</div></details>}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      <div className="inventory-summary" aria-label="Inventory summary">
        <div><strong>{rows.length}</strong><span>Item types</span></div>
        <div><strong>{totalQuantity}</strong><span>Total quantity</span></div>
        <div><strong>{analyzed.filter((item) => item.questUses.length > 0).length}</strong><span>Quest items</span></div>
        <div><strong>{analyzed.filter((item) => item.row.quantity > 1 || item.row.entries.length > 1).length}</strong><span>Duplicates</span></div>
        <div><strong>{database?.history.length ?? 0}</strong><span>Snapshots</span></div>
        <div><strong>+{delta.added} / -{delta.removed}</strong><span>Since previous</span></div>
      </div>

      <nav className="inventory-views" aria-label="Inventory views">
        {(["all", "quest", "duplicates", "cleanup", "currencies"] as View[]).map((value) => (
          <button key={value} className={view === value ? "active" : ""} onClick={() => setView(value)}>
            {value === "quest" ? "Quest items" : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      {view === "currencies" ? (
        <section className="inventory-currencies">
          <div className="inventory-currency-note">Currencies are not included by <code>/output inventory</code>. Record current balances here; log gains remain separate.</div>
          <div className="inventory-currency-form">
            <input list="inventory-currency-names" value={currencyName} onChange={(event) => setCurrencyName(event.target.value)} placeholder="Currency name" aria-label="Currency name" />
            <datalist id="inventory-currency-names">{CURRENCY_SUGGESTIONS.map((name) => <option key={name} value={name} />)}</datalist>
            <input type="number" min="0" value={currencyQuantity} onChange={(event) => setCurrencyQuantity(event.target.value)} aria-label="Currency quantity" />
            <button className="primary" onClick={() => void saveCurrency()}>Add balance</button>
          </div>
          <div className="inventory-currency-list">
            {(database?.currencies ?? []).map((currency) => (
              <div key={currency.name}><strong>{currency.name}</strong><span>{currency.quantity.toLocaleString()}</span><small>Updated {relativeTime(currency.updatedAtMs)}</small><button className="ghost small" onClick={() => void inventoryRemoveCurrency(character, server, currency.name).then(load)}>Remove</button></div>
            ))}
          </div>
        </section>
      ) : !database?.current ? (
        <Empty title="Import your inventory" body="Run /output inventory in EverQuest, then use Refresh. Open Hoard and Personal Depot before exporting to include them." />
      ) : visible.length === 0 ? (
        <Empty title="No matching items" body="Clear a filter or choose another inventory view." />
      ) : (
        <div className="inventory-table" role="table">
          <div className="inventory-table-head" role="row"><span>Item</span><span>Qty</span><span>Where</span><span>Known use</span><span>Status</span></div>
          {visible.map(({ row, questUses, recipeUses, status }) => {
            const open = expanded === row.key;
            return <div className={`inventory-table-item${open ? " open" : ""}`} key={row.key}>
              <button className="inventory-table-row" onClick={() => setExpanded(open ? null : row.key)} aria-expanded={open}>
                <span className="inventory-name"><i>{open ? "v" : ">"}</i><strong>{row.name}</strong>{row.exaltation && <small>Exaltation</small>}</span>
                <strong>{row.quantity}</strong>
                <span>{row.storages.map((value) => value.replaceAll("-", " ")).join(", ")}</span>
                <span>{questUses.length > 0 ? `${questUses.length} quest${questUses.length === 1 ? "" : "s"}` : recipeUses > 0 ? `${recipeUses} recipes` : "No catalog match"}</span>
                <span><b className={`inventory-status ${statusClass(status)}`}>{status}</b></span>
              </button>
              {open && <div className="inventory-detail">
                <div><h4>Locations</h4>{row.entries.map((entry) => <p key={`${entry.ordinal}-${entry.location}`}><strong>{entry.quantity}x</strong> {entry.location} <small>{entry.storage.replaceAll("-", " ")}</small></p>)}</div>
                <div><h4>Quest evidence</h4>{questUses.length === 0 ? <p>No requirement in the bundled quest catalog.</p> : questUses.map((use) => <p key={use.quest.id}><button className="text-button" onClick={() => openQuests(use.quest.name)}>{use.quest.name}</button><span>needs {use.required}</span><select value={use.status} onChange={(event) => void setQuestStatus(use.quest.id, event.target.value as QuestProgressStatus)}><option value="unknown">Not set</option><option value="in-progress">In progress</option><option value="completed">Completed</option><option value="ignored">Ignored</option></select></p>)}</div>
                <div className="inventory-detail-actions"><button className="ghost small" onClick={() => openDrops(row.name)}>Item details</button><button className="ghost small" onClick={() => void toggleKeep(row)}>{database.keepKeys.includes(row.key) ? "Remove Keep" : "Mark Keep"}</button><small>{recipeUses > 0 ? `Used by ${recipeUses} known recipes.` : "No recipe component match."} Cleanup labels are evidence, not deletion advice.</small></div>
              </div>}
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
