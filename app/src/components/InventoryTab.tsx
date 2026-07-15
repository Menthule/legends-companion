import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebouncedValue } from "../hooks";
import {
  dropsItemSources,
  dropsSearchItems,
  getConfig,
  inventoryDatabase,
  inventoryDiscover,
  inventoryImport,
  inventoryRecipeUsage,
  inventoryRemoveCurrency,
  inventorySetCurrency,
  inventorySetDisposition,
  inventorySetKeep,
  inventorySetQuestStatus,
  pickInventoryFile,
  refdbItemRecipes,
  refdbItemVendors,
} from "../api";
import {
  aggregateInventory,
  classifyInventoryItem,
  currencyRate,
  inventoryCapacity,
  inventoryChanges,
  inventoryDelta,
  questUsesForItem,
  type InventoryDatabase,
  type InventoryDisposition,
  type InventoryDispositionAction,
  type InventoryEvidence,
  type InventoryRow,
  type QuestProgressStatus,
} from "../lib/inventory";
import { openDrops, openQuests } from "../lib/deepLinks";
import { loadQuestCatalog, type QuestRecord } from "../lib/quests";
import {
  addManualWatch,
  isWishlisted,
  loadWishlist,
  onWishlistChanged,
  removeWatchedItem,
  watchRemainingQuantity,
} from "../lib/wishlist";
import { rememberInventoryPath, rememberInventorySnapshot } from "../lib/inventoryStore";
import { useEraMax } from "../lib/refFilters";
import type { DropItemRow, DropSource, ItemRecipes, ItemVendor } from "../types";
import Empty from "./Empty";

type View = "all" | "changes" | "quest" | "duplicates" | "cleanup" | "currencies";
type Sort = "name" | "quantity" | "storage" | "status";

const CURRENCY_SUGGESTIONS = [
  "Jaka Wind Runes", "Kala Wind Runes", "Lena Wind Runes",
  "Motes of Infinitesimal Potential", "Motes of Lesser Potential",
  "Motes of Minor Potential", "Motes of Potential",
];

const INVENTORY_STATUSES: InventoryEvidence[] = [
  "Needed",
  "Extra quantity",
  "Keep",
  "Equipped",
  "Watched",
  "Recipe component",
  "Possible quest use",
  "Completed quests only",
  "No known use",
];

const DISPOSITION_OPTIONS: Array<{ value: InventoryDispositionAction | ""; label: string }> = [
  { value: "", label: "No cleanup action" },
  { value: "keep", label: "Keep" },
  { value: "move", label: "Move" },
  { value: "sell", label: "Sell" },
  { value: "trade", label: "Trade" },
  { value: "review", label: "Review" },
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

function DispositionEditor({
  value,
  onSave,
}: {
  value: InventoryDisposition | undefined;
  onSave(action: InventoryDispositionAction | "", note: string): Promise<void>;
}) {
  const [action, setAction] = useState<InventoryDispositionAction | "">(value?.action ?? "");
  const [note, setNote] = useState(value?.note ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAction(value?.action ?? "");
    setNote(value?.note ?? "");
  }, [value]);

  const dirty = action !== (value?.action ?? "") || note !== (value?.note ?? "");
  return (
    <div className="inventory-disposition-editor">
      <select value={action} onChange={(event) => setAction(event.target.value as InventoryDispositionAction | "")} aria-label="Cleanup action">
        {DISPOSITION_OPTIONS.map((option) => <option key={option.value || "none"} value={option.value}>{option.label}</option>)}
      </select>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note" aria-label="Cleanup note" />
      <button className="ghost small" disabled={!dirty || saving} onClick={() => {
        setSaving(true);
        void onSave(action, note).finally(() => setSaving(false));
      }}>{saving ? "Saving..." : "Save"}</button>
    </div>
  );
}

function InventoryReferenceDetail({ row, eraMax }: { row: InventoryRow; eraMax: number }) {
  const [item, setItem] = useState<DropItemRow | null>(null);
  const [sources, setSources] = useState<DropSource[]>([]);
  const [vendors, setVendors] = useState<ItemVendor[]>([]);
  const [recipes, setRecipes] = useState<ItemRecipes>({ usedIn: [], makes: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void dropsSearchItems({
      query: row.name, eraMax, onlySourced: false, slotMask: 0, classMask: 0,
      zone: "", effectType: "", effectName: "", sort: "name", descending: false,
      limit: 12, offset: 0,
    }).then(async (result) => {
      const exact = result.rows.find((candidate) => candidate.id === row.itemId)
        ?? result.rows.find((candidate) => candidate.name.localeCompare(row.name, undefined, { sensitivity: "accent" }) === 0)
        ?? null;
      if (!exact) return { exact, sources: [], vendors: [], recipes: { usedIn: [], makes: [] } as ItemRecipes };
      const [nextSources, nextVendors, nextRecipes] = await Promise.all([
        dropsItemSources(exact.id, eraMax),
        refdbItemVendors(exact.id, eraMax),
        refdbItemRecipes(exact.id),
      ]);
      return { exact, sources: nextSources, vendors: nextVendors, recipes: nextRecipes };
    }).then((result) => {
      if (cancelled) return;
      setItem(result.exact);
      setSources(result.sources);
      setVendors(result.vendors);
      setRecipes(result.recipes);
    }).catch(() => {
      if (!cancelled) setItem(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [eraMax, row.itemId, row.name]);

  if (loading) return <div className="inventory-reference"><h4>Item reference</h4><p>Loading item details...</p></div>;
  if (!item) return <div className="inventory-reference"><h4>Item reference</h4><p>No exact match in the bundled reference database.</p></div>;
  const flags = [item.magic ? "MAGIC" : "", item.loregroup ? "LORE" : "", item.noDrop ? "NO DROP" : ""].filter(Boolean);
  const stats = [
    item.ac ? `AC ${item.ac}` : "", item.hp ? `HP ${item.hp}` : "", item.mana ? `Mana ${item.mana}` : "",
    item.damage ? `DMG ${item.damage}` : "", item.delay ? `Delay ${item.delay}` : "", item.haste ? `Haste ${item.haste}%` : "",
    item.reqlevel ? `Required ${item.reqlevel}` : "", ...flags,
  ].filter(Boolean);
  return (
    <div className="inventory-reference">
      <h4>Item reference</h4>
      <div className="inventory-reference-stats">{stats.length > 0 ? stats.map((stat) => <span key={stat}>{stat}</span>) : <span>No combat stats</span>}</div>
      <div className="inventory-reference-columns">
        <div><strong>Sources</strong>{sources.length > 0 ? sources.slice(0, 4).map((source) => <p key={`${source.npc}-${source.zone}`}><span>{source.npc}</span><small>{source.zoneLong ?? source.zone ?? "Unknown zone"}{source.chance > 0 ? ` - ${source.chance.toFixed(1)}%` : ""}</small></p>) : <p>No known drop source.</p>}</div>
        <div><strong>Vendors</strong>{vendors.length > 0 ? vendors.slice(0, 4).map((vendor) => <p key={`${vendor.npc}-${vendor.zone}`}><span>{vendor.npc}</span><small>{vendor.zoneLong ?? vendor.zone ?? "Unknown zone"}</small></p>) : <p>No known vendor.</p>}</div>
        <div><strong>Recipes</strong>{recipes.usedIn.length + recipes.makes.length > 0 ? <><p>Used in {recipes.usedIn.length}</p><p>Makes {recipes.makes.length}</p></> : <p>No recipe links.</p>}</div>
      </div>
    </div>
  );
}

export default function InventoryTab({ character }: { character: string }) {
  const [eraMax] = useEraMax();
  const [database, setDatabase] = useState<InventoryDatabase | null>(null);
  const [server, setServer] = useState("");
  const [quests, setQuests] = useState<QuestRecord[]>([]);
  const [recipes, setRecipes] = useState<Map<number, number>>(new Map());
  const [query, setQuery] = useState("");
  const searchQuery = useDebouncedValue(query);
  const [storage, setStorage] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | InventoryEvidence>("all");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [watchRevision, bumpWatches] = useState(0);
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
  const dispositionByKey = useMemo(
    () => new Map((database?.dispositions ?? []).map((value) => [value.itemKey, value])),
    [database?.dispositions],
  );
  const analyzed = useMemo(() => rows.map((row) => {
    const questUses = questUsesForItem(row, quests, progress);
    const recipeUses = row.itemId == null ? 0 : recipes.get(row.itemId) ?? 0;
    const status = classifyInventoryItem({
      row, questUses, recipeUses,
      keep: (database?.keepKeys.includes(row.key) ?? false) || dispositionByKey.get(row.key)?.action === "keep",
      watched: isWishlisted(row.name),
    });
    return { row, questUses, recipeUses, status };
  }), [database?.keepKeys, dispositionByKey, progress, quests, recipes, rows, watchRevision]);
  const storages = useMemo(() => [...new Set(rows.flatMap((row) => row.storages))].sort(), [rows]);
  const visible = useMemo(() => {
    const wanted = searchQuery.trim().toLowerCase();
    const filtered = analyzed
      .filter(({ row }) => storage === "all" || row.storages.includes(storage))
      .filter(({ status }) => statusFilter === "all" || status === statusFilter)
      .filter(({ row, questUses }) => !wanted || [
        row.name, ...row.locations, ...questUses.map((use) => use.quest.name),
      ].some((value) => value.toLowerCase().includes(wanted)))
      .filter(({ row, questUses, status }) => {
        if (view === "quest") return questUses.length > 0;
        if (view === "duplicates") return row.quantity > 1 || row.entries.length > 1;
        if (view === "cleanup") return dispositionByKey.has(row.key) || status === "Extra quantity" || status === "Completed quests only" || status === "No known use";
        return true;
      });
    return filtered.sort((left, right) => {
      if (sort === "quantity") return right.row.quantity - left.row.quantity || left.row.name.localeCompare(right.row.name);
      if (sort === "storage") return left.row.storages.join().localeCompare(right.row.storages.join()) || left.row.name.localeCompare(right.row.name);
      if (sort === "status") return left.status.localeCompare(right.status) || left.row.name.localeCompare(right.row.name);
      return left.row.name.localeCompare(right.row.name);
    });
  }, [analyzed, dispositionByKey, searchQuery, sort, statusFilter, storage, view]);
  const delta = inventoryDelta(database?.entries ?? [], database?.previousEntries ?? []);
  const changes = useMemo(
    () => inventoryChanges(database?.entries ?? [], database?.previousEntries ?? []),
    [database?.entries, database?.previousEntries],
  );
  const capacity = useMemo(() => inventoryCapacity(database?.storageSlots ?? []), [database?.storageSlots]);
  const watchedByName = useMemo(
    () => new Map(loadWishlist().map((item) => [item.key, item])),
    [watchRevision],
  );
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

  const toggleWatch = async (row: InventoryRow) => {
    if (isWishlisted(row.name)) await removeWatchedItem(row.name);
    else await addManualWatch(row.name, 1, true);
    bumpWatches((value) => value + 1);
  };

  const setDisposition = async (row: InventoryRow, action: InventoryDispositionAction | "", note: string) => {
    await inventorySetDisposition(character, server, row.key, action, note.trim());
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
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | InventoryEvidence)} aria-label="Inventory status">
            <option value="all">All statuses</option>
            {INVENTORY_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
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

      {capacity.length > 0 && <div className="inventory-capacity" aria-label="Storage capacity">
        <span className="inventory-capacity-label">Exported capacity</span>
        {capacity.map((area) => <div key={area.storage}>
          <strong>{area.free}</strong><span> / {area.total} free</span><small>{area.storage.replaceAll("-", " ")}</small>
        </div>)}
      </div>}

      <nav className="inventory-views" aria-label="Inventory views">
        {(["all", "changes", "quest", "duplicates", "cleanup", "currencies"] as View[]).map((value) => (
          <button key={value} className={view === value ? "active" : ""} onClick={() => setView(value)}>
            {value === "quest" ? "Quest items" : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      {view === "changes" ? (
        !database?.current ? <Empty title="Import your inventory" body="Two inventory exports are needed before changes can be compared." />
          : (database?.history.length ?? 0) < 2 ? <Empty title="Take another snapshot" body="Run /output inventory again later, then Refresh to see additions, removals, moves, and quantity changes." />
            : changes.length === 0 ? <Empty title="No inventory changes" body="The current and previous exports contain the same items, quantities, and locations." />
              : <div className="inventory-changes" role="table" aria-label="Inventory changes">
                <div className="inventory-change-row head"><span>Item</span><span>Change</span><span>Before</span><span>Now</span><span>Locations</span></div>
                {changes.map((change) => <div className="inventory-change-row" key={change.key}>
                  <strong>{change.name}</strong>
                  <span>{change.kinds.join(", ")}</span>
                  <span>{change.beforeQuantity}</span>
                  <span className={change.difference > 0 ? "positive" : change.difference < 0 ? "negative" : ""}>{change.quantity} {change.difference !== 0 && <small>({change.difference > 0 ? "+" : ""}{change.difference})</small>}</span>
                  <span>{change.locations.join(", ") || change.beforeLocations.join(", ")}</span>
                </div>)}
              </div>
      ) : view === "currencies" ? (
        <section className="inventory-currencies">
          <div className="inventory-currency-note">Currencies are not included by <code>/output inventory</code>. Add each current balance periodically to build history and estimate its gain rate.</div>
          <div className="inventory-currency-form">
            <input list="inventory-currency-names" value={currencyName} onChange={(event) => setCurrencyName(event.target.value)} placeholder="Currency name" aria-label="Currency name" />
            <datalist id="inventory-currency-names">{CURRENCY_SUGGESTIONS.map((name) => <option key={name} value={name} />)}</datalist>
            <input type="number" min="0" value={currencyQuantity} onChange={(event) => setCurrencyQuantity(event.target.value)} aria-label="Currency quantity" />
            <button className="primary" onClick={() => void saveCurrency()}>Add balance</button>
          </div>
          <div className="inventory-currency-list">
            {(database?.currencies ?? []).map((currency) => {
              const history = (database?.currencyHistory ?? []).filter((sample) => sample.name.toLowerCase() === currency.name.toLowerCase());
              const rate = currencyRate(history);
              return <div className="inventory-currency-row" key={currency.name}>
                <strong>{currency.name}</strong>
                <span>{currency.quantity.toLocaleString()}</span>
                <small>{rate ? `${rate.gained >= 0 ? "+" : ""}${rate.gained} over ${rate.hours.toFixed(1)}h - ${rate.perHour.toFixed(1)}/hr` : `Updated ${relativeTime(currency.updatedAtMs)}`}</small>
                <details><summary>History</summary><div>{history.slice(0, 8).map((sample) => <span key={sample.id}><time>{new Date(sample.measuredAtMs).toLocaleString()}</time><strong>{sample.quantity.toLocaleString()}</strong></span>)}</div></details>
                <button className="ghost small" onClick={() => void inventoryRemoveCurrency(character, server, currency.name).then(load)}>Remove</button>
              </div>;
            })}
          </div>
        </section>
      ) : !database?.current ? (
        <Empty title="Import your inventory" body="Run /output inventory in EverQuest, then use Refresh. Open Hoard and Personal Depot before exporting to include them." />
      ) : visible.length === 0 ? (
        <Empty title="No matching items" body="Clear a filter or choose another inventory view." />
      ) : (
        <>
        {view === "cleanup" && (database?.dispositions.length ?? 0) > 0 && <section className="inventory-cleanup-queue">
          <div><strong>Cleanup queue</strong><span>{database?.dispositions.length} saved action{database?.dispositions.length === 1 ? "" : "s"}</span></div>
          {DISPOSITION_OPTIONS.filter((option) => option.value).map((option) => {
            const assigned = database?.dispositions.filter((item) => item.action === option.value) ?? [];
            if (assigned.length === 0) return null;
            return <div className="inventory-cleanup-group" key={option.value}>
              <strong>{option.label}</strong>
              {assigned.map((item) => {
                const row = rows.find((candidate) => candidate.key === item.itemKey);
                return <span key={item.itemKey}><b>{row?.name ?? item.itemKey}</b><small>{row?.locations.join(", ") || "Not in current snapshot"}{item.note ? ` - ${item.note}` : ""}</small></span>;
              })}
            </div>;
          })}
        </section>}
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
                <div><h4>Quest evidence</h4>{questUses.length === 0 ? <p>No requirement in the bundled quest catalog.</p> : questUses.map((use) => <p key={use.quest.id}><button className="text-button" onClick={() => openQuests(use.quest.name)}>{use.quest.name}</button><span>needs {use.required}</span><select value={use.status} onChange={(event) => void setQuestStatus(use.quest.id, event.target.value as QuestProgressStatus)}><option value="unknown">Not set</option><option value="planned">Planned</option><option value="in-progress">In progress</option><option value="completed">Completed</option><option value="ignored">Ignored</option></select></p>)}</div>
                <div className="inventory-detail-actions">
                  <button className="ghost small" onClick={() => openDrops(row.name)}>Open full details</button>
                  <button className="ghost small" onClick={() => void toggleKeep(row)}>{database.keepKeys.includes(row.key) ? "Remove Keep" : "Mark Keep"}</button>
                  <button className="ghost small" onClick={() => void toggleWatch(row)}>{isWishlisted(row.name) ? "Remove watch" : "Watch next"}</button>
                  {isWishlisted(row.name) && <small>{watchRemainingQuantity(watchedByName.get(row.name.trim().toLowerCase().replace(/\s+/g, " ")) ?? { goals: [] })} still watched.</small>}
                  <DispositionEditor value={dispositionByKey.get(row.key)} onSave={(action, note) => setDisposition(row, action, note)} />
                  <small>{recipeUses > 0 ? `Used by ${recipeUses} known recipes.` : "No recipe component match."} Cleanup labels are evidence, not deletion advice.</small>
                </div>
                <InventoryReferenceDetail row={row} eraMax={eraMax} />
              </div>}
            </div>;
          })}
        </div>
        </>
      )}
    </div>
  );
}
