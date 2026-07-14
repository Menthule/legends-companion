// Drops research tab: search/browse the bundled classic-era item/drop
// database (ProjectEQ reference data — see tools/dropdata/build_drops_db.py)
// to find which mobs drop an item and where they spawn.
//
// Search UX: ONE smart search box. Typing matches item names AND effect
// names, and offers typed suggestions — pick "Effect: Fear (clicky)",
// "Zone: Ruins of Old Guk", "Slot: Waist", or "Class: MNK" to apply that
// as a filter chip instead of a text search. Active filters render as
// removable chips; the full select set lives in a compact "Filters"
// popover for browsing without typing. Result columns are configurable
// (persisted). The session loot log deep-links here via lib/deepLinks
// (openDrops); mob/vendor/recipe/quest names link back out the same way.

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  dropsEffects,
  dropsItemSources,
  dropsSearchItems,
  dropsZones,
  refdbItemRecipes,
  refdbItemVendors,
} from "../api";
import type {
  DropEffect,
  DropItemRow,
  DropSource,
  DropZone,
  ItemRecipes,
  ItemVendor,
  RecipeRef,
} from "../types";
import { tradeskillName } from "../types";
import {
  loadQuestCatalog,
  questsRequiringItem,
  type QuestRecord,
} from "../lib/quests";
import {
  CLASS_ABBR as CLASS_BITS,
  CLASS_FULL,
  CLASS_NAME_TO_BIT,
  resolveLiveZoneShortName,
  useClassMask,
  useEraMax,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { ClassFilterButton, EraSelect } from "./RefFilters";
import Empty from "./Empty";
import { ItemTypeIcon } from "./ItemIcons";
import Pager from "./Pager";
import ResourceLinks from "./ResourceLinks";
import { SearchSelect, SpecRow } from "./SearchSelect";
import { useDebouncedRefSearch } from "../lib/refSearch";
import { useDismissOnOutsidePointer } from "../hooks";
import { openMobs, openQuests, openRecipes } from "../lib/deepLinks";
import {
  isWishlisted,
  onWishlistChanged,
  toggleWishlist,
} from "../lib/wishlist";

const COLUMNS_KEY = "eqlogs.drops.columns.v2";

const ERA_NAMES = ["Classic", "Kunark", "Velious", "Later"];

const RACE_BITS = [
  "HUM", "BAR", "ERU", "ELF", "HIE", "DEF", "HEF", "DWF",
  "TRL", "OGR", "HFL", "GNM", "IKS", "VAH",
];
const SLOT_BITS: [number, string][] = [
  [1, "Charm"], [2 | 16, "Ear"], [4, "Head"], [8, "Face"], [32, "Neck"],
  [64, "Shoulders"], [128, "Arms"], [256, "Back"], [512 | 1024, "Wrist"],
  [2048, "Range"], [4096, "Hands"], [8192, "Primary"], [16384, "Secondary"],
  [32768 | 65536, "Fingers"], [131072, "Chest"], [262144, "Legs"],
  [524288, "Feet"], [1048576, "Waist"], [2097152, "Ammo"],
];
const ITEM_TYPES: Record<number, string> = {
  0: "1H Slashing", 1: "2H Slashing", 2: "Piercing", 3: "1H Blunt",
  4: "2H Blunt", 5: "Bow", 7: "Throwing", 8: "Shield", 10: "Armor",
  14: "Food", 15: "Drink", 17: "Light", 20: "Scroll", 21: "Potion",
  23: "Wind Instrument", 24: "Stringed Instrument", 25: "Brass Instrument",
  26: "Percussion", 27: "Arrow", 29: "Jewelry", 35: "Note",
};
const EFFECT_KIND_LABEL: Record<string, string> = {
  proc: "proc",
  click: "clicky",
  worn: "worn",
  focus: "focus",
};
const EFFECT_TYPES = [
  { value: "", label: "Any effect" },
  { value: "any", label: "Has an effect" },
  { value: "proc", label: "Proc" },
  { value: "click", label: "Clicky" },
  { value: "worn", label: "Worn" },
  { value: "focus", label: "Focus" },
  { value: "haste", label: "Haste" },
];

function decodeBits(mask: number, names: string[]): string {
  const all = (1 << names.length) - 1;
  if ((mask & all) === all) return "ALL";
  const out = names.filter((_, i) => mask & (1 << i));
  return out.length ? out.join(" ") : "NONE";
}

/** Full class names, comma-joined ("Necromancer, Monk"); ALL when every bit set. */
function decodeClassesFull(mask: number): string {
  const all = (1 << CLASS_FULL.length) - 1;
  if ((mask & all) === all) return "ALL";
  const names = CLASS_FULL.filter((n) => mask & (1 << CLASS_NAME_TO_BIT[n]));
  return names.length ? names.join(", ") : "NONE";
}

function decodeSlots(mask: number): string {
  const out = SLOT_BITS.filter(([bit]) => mask & bit).map(([, n]) => n);
  return out.join(", ");
}

function statLine(it: DropItemRow): string {
  const parts: string[] = [];
  const stat = (v: number, label: string) => {
    if (v !== 0) parts.push(`${label} ${v > 0 ? "+" : ""}${v}`);
  };
  stat(it.astr, "STR");
  stat(it.asta, "STA");
  stat(it.aagi, "AGI");
  stat(it.adex, "DEX");
  stat(it.awis, "WIS");
  stat(it.aint, "INT");
  stat(it.acha, "CHA");
  stat(it.hp, "HP");
  stat(it.mana, "MANA");
  return parts.join("  ");
}

/** First effect on the item, labeled by kind. */
function effectSummary(it: DropItemRow): string {
  if (it.procName) return `Proc: ${it.procName}`;
  if (it.clickName) return `Click: ${it.clickName}`;
  if (it.wornName) return `Worn: ${it.wornName}`;
  if (it.focusName) return `Focus: ${it.focusName}`;
  if (it.haste > 0) return `Haste ${it.haste}%`;
  return "";
}

type SortKey =
  | "name" | "source" | "zone" | "effect" | "ac" | "hp" | "mana" | "damage"
  | "delay" | "ratio" | "haste" | "reqlevel" | "weight" | "sources";

/** Every available result column; the picker chooses which render. */
interface ColDef {
  id: string;
  label: string;
  numeric: boolean;
  sort: SortKey | null;
  width: string;
  render: (it: DropItemRow) => ReactNode;
}
const ALL_COLUMNS: ColDef[] = [
  {
    id: "source", label: "Mob", numeric: false, sort: "source", width: "0.9fr",
    render: (it) => (
      <span className="drops-topsource" title={it.topNpc ?? undefined}>
        {it.topNpc ?? "—"}
        {it.sources > 1 ? (
          <span className="drops-more num"> +{it.sources - 1}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: "zone", label: "Zone", numeric: false, sort: "zone", width: "0.8fr",
    render: (it) => (
      <span className="drops-topsource" title={it.topZone ?? undefined}>
        {it.topZone ?? (it.topNpc ? "(no known spawn)" : "")}
      </span>
    ),
  },
  {
    id: "effect", label: "Effect", numeric: false, sort: "effect", width: "0.7fr",
    render: (it) => (
      <span className="drops-topsource" title={effectSummary(it) || undefined}>
        {effectSummary(it)}
      </span>
    ),
  },
  { id: "ac", label: "AC", numeric: true, sort: "ac", width: "40px",
    render: (it) => it.ac || "" },
  { id: "hp", label: "HP", numeric: true, sort: "hp", width: "44px",
    render: (it) => it.hp || "" },
  { id: "mana", label: "Mana", numeric: true, sort: "mana", width: "48px",
    render: (it) => it.mana || "" },
  { id: "damage", label: "Dmg", numeric: true, sort: "damage", width: "44px",
    render: (it) => it.damage || "" },
  { id: "delay", label: "Dly", numeric: true, sort: "delay", width: "44px",
    render: (it) => it.delay || "" },
  { id: "ratio", label: "Ratio", numeric: true, sort: "ratio", width: "52px",
    render: (it) =>
      it.damage > 0 && it.delay > 0 ? (it.damage / it.delay).toFixed(3) : "" },
  { id: "haste", label: "Haste", numeric: true, sort: "haste", width: "52px",
    render: (it) => (it.haste > 0 ? `${it.haste}%` : "") },
  { id: "reqlevel", label: "Req", numeric: true, sort: "reqlevel", width: "40px",
    render: (it) => it.reqlevel || "" },
  { id: "weight", label: "Wt", numeric: true, sort: "weight", width: "44px",
    render: (it) => (it.weight ? (it.weight / 10).toFixed(1) : "") },
  { id: "sources", label: "Srcs", numeric: true, sort: "sources", width: "44px",
    render: (it) => it.sources || "—" },
];
const DEFAULT_COLUMNS = ["source", "zone", "effect", "ac", "hp", "damage", "delay", "ratio", "sources"];

function loadColumns(): string[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const ids = JSON.parse(raw) as string[];
    return Array.isArray(ids)
      ? ids.filter((id) => ALL_COLUMNS.some((c) => c.id === id))
      : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/** A typed suggestion in the smart-search dropdown. */
interface Suggestion {
  key: string;
  label: string;
  badge: string;
  sub?: string;
  apply: () => void;
}

/** Cap the crafting chip rows — staple components sit in hundreds of
 *  recipes and a wall of chips would drown the rest of the detail. */
const MAX_RECIPE_CHIPS = 24;

/** "Used in" / "Made by" chip row — chips deep-link into the Recipes tab. */
function RecipeChips({
  label,
  recipes,
}: {
  label: string;
  recipes: RecipeRef[];
}) {
  const shown = recipes.slice(0, MAX_RECIPE_CHIPS);
  return (
    <div className="refdb-chips">
      <span className="refdb-chiplabel">{label}</span>
      {shown.map((r) => (
        <button
          key={r.id}
          className="drops-chip"
          title={`${tradeskillName(r.tradeskill)} — trivial ${r.trivial}`}
          onClick={() => openRecipes(r.name)}
        >
          {r.name}
        </button>
      ))}
      {recipes.length > shown.length && (
        <span className="hint num">+{recipes.length - shown.length} more</span>
      )}
    </div>
  );
}

export default function DropsTab({
  searchRequest,
}: {
  /** Deep-link from the session loot log: bump `seq` to re-trigger. */
  searchRequest: { query: string; seq: number; revealUnsourced?: boolean; targetId?: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [eraMax] = useEraMax();
  // Item references without a known mob source are still useful: many quest
  // turn-ins (including Plane of Sky gems) exist in the item table but PEQ's
  // classic loot graph has no source row for them. Keep them visible by
  // default; the Source filter can still narrow to confirmed mob drops.
  const [onlySourced, setOnlySourced] = useState(false);
  const [slotMask, setSlotMask] = useState(0);
  const [classMask, setClassMask] = useClassMask();
  const [zone, setZone] = useState("");
  const [liveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const [effectType, setEffectType] = useState("");
  const [effectName, setEffectName] = useState("");
  const [zones, setZones] = useState<DropZone[]>([]);
  const [effects, setEffects] = useState<DropEffect[]>([]);
  const [visibleCols, setVisibleCols] = useState<string[]>(() => loadColumns());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [sort, setSort] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [sources, setSources] = useState<DropSource[] | null>(null);
  /** Merchants selling the expanded item (null = loading). */
  const [vendors, setVendors] = useState<ItemVendor[] | null>(null);
  /** Recipes the expanded item participates in (null = loading). */
  const [recipes, setRecipes] = useState<ItemRecipes | null>(null);
  const [questUses, setQuestUses] = useState<QuestRecord[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingTargetId = useRef<number | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Re-render the star column whenever the wishlist changes — including
  // removals from the Fights-tab panel (localStorage + custom-event sync).
  const [, bumpWishlist] = useState(0);
  useEffect(() => onWishlistChanged(() => bumpWishlist((n) => n + 1)), []);

  const hasFilters =
    slotMask !== 0 ||
    classMask !== 0 ||
    zone !== "" ||
    effectType !== "" ||
    effectName !== "";
  const active = query.trim().length >= 2 || hasFilters;

  const {
    page,
    setPage,
    pages,
    total,
    rows,
    error,
    setError,
    expanded,
    setExpanded,
    resetPaging,
  } = useDebouncedRefSearch<DropItemRow>({
    active,
    fetch: (offset, limit) =>
      dropsSearchItems({
        query: query.trim(),
        eraMax,
        onlySourced,
        slotMask,
        classMask,
        zone,
        effectType,
        effectName,
        sort,
        descending,
        limit,
        offset,
      }),
    deps: [
      query, eraMax, onlySourced, slotMask, classMask, zone,
      effectType, effectName, sort, descending,
    ],
  });

  // Clicking anywhere outside a popover (or Escape) closes it — the toggle
  // button alone shouldn't be the only way out. One call per popover so each
  // dismisses independently.
  useDismissOnOutsidePointer([filtersRef], filtersOpen, () =>
    setFiltersOpen(false),
  );
  useDismissOnOutsidePointer([pickerRef], pickerOpen, () =>
    setPickerOpen(false),
  );

  useEffect(() => {
    dropsZones().then(setZones).catch(() => {});
  }, []);

  // Deep-link from the loot log: clean lookup, filters reset.
  useEffect(() => {
    if (!searchRequest) return;
    setQuery(searchRequest.query);
    pendingTargetId.current = searchRequest.targetId ?? null;
    if (searchRequest.revealUnsourced) setOnlySourced(false);
    setSlotMask(0);
    setClassMask(0);
    setZone("");
    setEffectType("");
    setEffectName("");
    setPage(0);
    setExpanded(null);
    setSuggestOpen(false);
    if (searchRequest.targetId == null) inputRef.current?.focus();
  }, [searchRequest]);

  useEffect(() => {
    const targetId = pendingTargetId.current;
    if (targetId == null || !rows.some((row) => row.id === targetId)) return;
    pendingTargetId.current = null;
    if (expanded !== targetId) toggleExpand(targetId);
  }, [rows, searchRequest?.seq]);

  // Effects respect the era filter: a Classic search shouldn't offer
  // Luclin-era focus lines. Refetch on era change; drop a selected effect
  // that no longer exists in the narrower era.
  useEffect(() => {
    dropsEffects(eraMax)
      .then((list) => {
        setEffects(list);
        setEffectName((name) =>
          name && !list.some((e) => e.name === name) ? "" : name,
        );
      })
      .catch(() => {});
  }, [eraMax]);

  // A selected zone from a later era no longer qualifies when the global
  // era ceiling narrows.
  useEffect(() => {
    setZone((zn) => {
      const zi = zones.find((z) => z.shortName === zn);
      return zi && zi.era > eraMax ? "" : zn;
    });
  }, [eraMax, zones]);

  const liveZoneShort = useMemo(
    () => resolveLiveZoneShortName(liveZoneName, zones),
    [liveZoneName, zones],
  );
  // Follow the live zone only when it CHANGES (zoning, or toggle flipped on):
  // a manual pick in the zone dropdown must stick, not snap back.
  const appliedLiveZone = useRef<string | null>(null);
  useEffect(() => {
    if (!liveZoneEnabled || !liveZoneShort) {
      appliedLiveZone.current = null;
      return;
    }
    if (appliedLiveZone.current === liveZoneShort) return;
    appliedLiveZone.current = liveZoneShort;
    if (zone !== liveZoneShort) {
      setZone(liveZoneShort);
      resetPaging();
    }
  }, [liveZoneEnabled, liveZoneShort, zone]);

  // ---- smart-search suggestions -----------------------------------------

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Suggestion[] = [];
    for (const e of effects.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6)) {
      out.push({
        key: `effect:${e.kind}:${e.name}`,
        label: e.name,
        badge: `effect · ${EFFECT_KIND_LABEL[e.kind] ?? e.kind}`,
        sub: `${e.items} item${e.items === 1 ? "" : "s"}`,
        apply: () => {
          setEffectType(e.kind);
          setEffectName(e.name);
          setQuery("");
          resetPaging();
        },
      });
    }
    for (const z of zones
      .filter((z) => z.era <= eraMax && z.longName.toLowerCase().includes(q))
      .slice(0, 4)) {
      out.push({
        key: `zone:${z.shortName}`,
        label: z.longName,
        badge: "zone",
        apply: () => {
          setZone(z.shortName);
          setQuery("");
          resetPaging();
        },
      });
    }
    for (const [bit, name] of SLOT_BITS.filter(([, n]) =>
      n.toLowerCase().startsWith(q),
    ).slice(0, 3)) {
      out.push({
        key: `slot:${name}`,
        label: name,
        badge: "slot",
        apply: () => {
          setSlotMask(bit);
          setQuery("");
          resetPaging();
        },
      });
    }
    for (const full of CLASS_FULL.filter(
      (n) =>
        n.toLowerCase().startsWith(q) ||
        CLASS_BITS[CLASS_NAME_TO_BIT[n]].toLowerCase() === q,
    ).slice(0, 3)) {
      out.push({
        key: `class:${full}`,
        label: full,
        badge: "class",
        apply: () => {
          // Functional update: the closure's `classMask` can be stale when
          // this suggestion is applied, which would drop a concurrent class
          // selection by OR-ing onto an old mask (P43).
          setClassMask((m) => m | (1 << CLASS_NAME_TO_BIT[full]));
          setQuery("");
          resetPaging();
        },
      });
    }
    return out;
  }, [query, effects, zones, eraMax]);

  // Entry 0 is always "search items for the text" (plain Enter behavior).
  const suggestCount = suggestions.length + 1;

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggestOpen || query.trim().length < 2) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIdx((i) => (i + 1) % suggestCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIdx((i) => (i - 1 + suggestCount) % suggestCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestIdx > 0) suggestions[suggestIdx - 1]?.apply();
      setSuggestOpen(false);
    } else if (e.key === "Escape") {
      setSuggestOpen(false);
    }
  }

  // ---- table interactions -------------------------------------------------

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setDescending((d) => !d);
    } else {
      setSort(key);
      // Text columns read best A-Z; numeric ones largest-first.
      setDescending(!["name", "source", "effect"].includes(key));
    }
    setPage(0);
  }

  function toggleExpand(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    setSources(null);
    setVendors(null);
    setRecipes(null);
    dropsItemSources(id, eraMax)
      .then(setSources)
      .catch((e) => setError(String(e)));
    // Sold-by + crafting are secondary detail: a failure just hides them.
    refdbItemVendors(id, eraMax)
      .then(setVendors)
      .catch(() => setVendors([]));
    refdbItemRecipes(id)
      .then(setRecipes)
      .catch(() => setRecipes({ usedIn: [], makes: [] }));
  }

  function toggleColumn(id: string) {
    setVisibleCols((prev) => {
      // Preserve ALL_COLUMNS order regardless of toggle order.
      const on = prev.includes(id)
        ? prev.filter((c) => c !== id)
        : [...prev, id];
      const ordered = ALL_COLUMNS.map((c) => c.id).filter((c) => on.includes(c));
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify(ordered));
      } catch {
        // localStorage unavailable — selection just won't persist.
      }
      return ordered;
    });
  }

  function clearAll() {
    setQuery("");
    setSlotMask(0);
    setClassMask(0);
    setZone("");
    setEffectType("");
    setEffectName("");
    setFiltersOpen(false);
    setPickerOpen(false);
    resetPaging();
  }

  const detail = useMemo(
    () => rows.find((r) => r.id === expanded) ?? null,
    [rows, expanded],
  );
  useEffect(() => {
    let stale = false;
    if (!detail) {
      setQuestUses(null);
      return;
    }
    setQuestUses(null);
    void loadQuestCatalog().then((catalog) => {
      if (!stale) setQuestUses(questsRequiringItem(detail.name, catalog.quests));
    });
    return () => {
      stale = true;
    };
  }, [detail?.id, detail?.name]);
  const shownZones = useMemo(
    () => zones.filter((z) => z.era <= eraMax || z.shortName === zone),
    [zones, eraMax, zone],
  );
  const cols = useMemo(
    () => ALL_COLUMNS.filter((c) => visibleCols.includes(c.id)),
    [visibleCols],
  );
  // Item name column is fixed; the rest follow the picker.
  const gridTemplate = `1.2fr ${cols.map((c) => c.width).join(" ")}`;

  // If the current sort column was hidden, fall back to name.
  useEffect(() => {
    if (sort !== "name" && !cols.some((c) => c.sort === sort)) {
      setSort("name");
      setDescending(false);
    }
  }, [cols, sort]);

  // ---- filter chips ---------------------------------------------------------

  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (slotMask !== 0) {
    chips.push({
      key: "slot",
      label: `Slot: ${SLOT_BITS.find(([b]) => b === slotMask)?.[1] ?? "?"}`,
      clear: () => setSlotMask(0),
    });
  }
  if (classMask !== 0) {
    chips.push({
      key: "class",
      label: `Class: ${decodeClassesFull(classMask)}`,
      clear: () => setClassMask(0),
    });
  }
  if (effectName !== "") {
    chips.push({
      key: "effect",
      label: `Effect: ${effectName}${
        effectType ? ` (${EFFECT_KIND_LABEL[effectType] ?? effectType})` : ""
      }`,
      clear: () => {
        setEffectName("");
        setEffectType("");
      },
    });
  } else if (effectType !== "") {
    chips.push({
      key: "effect",
      label: `Effect: ${
        EFFECT_TYPES.find((t) => t.value === effectType)?.label ?? effectType
      }`,
      clear: () => setEffectType(""),
    });
  }
  if (zone !== "") {
    chips.push({
      key: "zone",
      label: `Zone: ${zones.find((z) => z.shortName === zone)?.longName ?? zone}`,
      clear: () => setZone(""),
    });
  }

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">Drops research</span>
        <span className="hint">
          Classic-era reference data (ProjectEQ) — Legends drop tables and
          item stats may differ.
        </span>
      </div>
      <div className="drops-controls">
        <div className="drops-search">
          <input
            ref={inputRef}
            type="search"
            placeholder="Search items, effects, zones, slots, classes…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSuggestOpen(true);
              setSuggestIdx(0);
              resetPaging();
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
            onKeyDown={onSearchKeyDown}
          />
          {suggestOpen && query.trim().length >= 2 && (
            <div className="drops-suggest" role="listbox">
              <button
                className={`drops-suggest-row${suggestIdx === 0 ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSuggestOpen(false);
                }}
              >
                <span className="drops-suggest-label">
                  Search items for “{query.trim()}”
                </span>
                <span className="drops-badge">text</span>
              </button>
              {suggestions.map((sg, i) => (
                <button
                  key={sg.key}
                  className={`drops-suggest-row${suggestIdx === i + 1 ? " active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    sg.apply();
                    setSuggestOpen(false);
                  }}
                >
                  <span className="drops-suggest-label">{sg.label}</span>
                  {sg.sub && <span className="hint num">{sg.sub}</span>}
                  <span className="drops-badge">{sg.badge}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <ClassFilterButton />
        <EraSelect />
        <div className="drops-colpick" ref={filtersRef}>
          <button
            className="ghost small"
            onClick={() => {
              setFiltersOpen((o) => !o);
              setPickerOpen(false);
            }}
            aria-expanded={filtersOpen}
          >
            Filters{chips.length > 0 ? ` (${chips.length})` : ""} ▾
          </button>
          {filtersOpen && (
            <div className="drops-colpick-menu drops-filter-menu">
              <div className="drops-filter-section">Item</div>
              <label>
                Slot
                <select
                  value={slotMask}
                  onChange={(e) => {
                    setSlotMask(Number(e.target.value));
                    resetPaging();
                  }}
                >
                  <option value={0}>Any</option>
                  {SLOT_BITS.map(([bit, name]) => (
                    <option key={name} value={bit}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="drops-filter-section">Effect</div>
              <label>
                Kind
                <select
                  value={effectType}
                  onChange={(e) => {
                    setEffectType(e.target.value);
                    setEffectName("");
                    resetPaging();
                  }}
                >
                  {EFFECT_TYPES.map((et) => (
                    <option key={et.value} value={et.value}>
                      {et.label}
                    </option>
                  ))}
                </select>
              </label>
              {["proc", "click", "worn", "focus"].includes(effectType) && (
                <SearchSelect
                  value={effectName}
                  anyLabel={`Any ${EFFECT_KIND_LABEL[effectType] ?? effectType}`}
                  options={effects
                    .filter((ef) => ef.kind === effectType)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((ef) => ({
                      value: ef.name,
                      label: `${ef.name} (${ef.items})`,
                    }))}
                  onChange={(v) => {
                    setEffectName(v);
                    resetPaging();
                  }}
                />
              )}
              <div className="drops-filter-section">Source</div>
              <SearchSelect
                value={zone}
                anyLabel="Any zone"
                options={shownZones.map((z) => ({
                  value: z.shortName,
                  label: z.longName,
                }))}
                onChange={(v) => {
                  setZone(v);
                  resetPaging();
                }}
              />
              <label className="drops-sourced">
                <input
                  type="checkbox"
                  checked={onlySourced || zone !== ""}
                  disabled={zone !== ""}
                  onChange={(e) => {
                    setOnlySourced(e.target.checked);
                    resetPaging();
                  }}
                />
                only items with a known drop source
              </label>
              <button
                className="ghost small drops-filter-reset"
                disabled={!hasFilters}
                onClick={() => {
                  setSlotMask(0);
                  setClassMask(0);
                  setZone("");
                  setEffectType("");
                  setEffectName("");
                  setFiltersOpen(false);
                  resetPaging();
                }}
              >
                Reset all filters
              </button>
            </div>
          )}
        </div>
        <div className="drops-colpick" ref={pickerRef}>
          <button
            className="ghost small"
            onClick={() => {
              setPickerOpen((o) => !o);
              setFiltersOpen(false);
            }}
            aria-expanded={pickerOpen}
          >
            Columns ▾
          </button>
          {pickerOpen && (
            <div className="drops-colpick-menu">
              {ALL_COLUMNS.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={visibleCols.includes(c.id)}
                    onChange={() => toggleColumn(c.id)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        {(hasFilters || query) && (
          <button className="ghost small" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="drops-chips">
          {chips.map((c) => (
            <button
              key={c.key}
              className="drops-chip"
              onClick={() => {
                c.clear();
                resetPaging();
              }}
              title="Remove filter"
            >
              {c.label} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {!active ? (
        <Empty
          title="Search the drop database"
          body="Type an item or effect name — or pick a zone, slot, or class from the suggestions — to see what drops where, from which mobs, at what chance. Classic-era emulator data: a guide, not gospel."
        />
      ) : rows.length === 0 ? (
        <Empty
          title="No matches"
          body={
            onlySourced || zone !== ""
              ? "Nothing dropped matches these filters. Try widening the era, clearing a chip, or allowing items without a known drop source (Filters)."
              : "No items match that name."
          }
        />
      ) : (
        <>
          <div className="drops-table">
            <div
              className="drops-row drops-head"
              style={{ gridTemplateColumns: gridTemplate }}
              aria-hidden="true"
            >
              <button
                className={`drops-col-btn${sort === "name" ? " active" : ""}`}
                onClick={() => toggleSort("name")}
                title="Sort by name"
              >
                Item{sort === "name" ? (descending ? " ↓" : " ↑") : ""}
              </button>
              {cols.map((c) =>
                c.sort ? (
                  <button
                    key={c.id}
                    className={`drops-col-btn${c.numeric ? " num" : ""}${sort === c.sort ? " active" : ""}`}
                    onClick={() => toggleSort(c.sort as SortKey)}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}
                    {sort === c.sort ? (descending ? " ↓" : " ↑") : ""}
                  </button>
                ) : (
                  <span
                    key={c.id}
                    className={`drops-col-label${c.numeric ? " num" : ""}`}
                  >
                    {c.label}
                  </span>
                ),
              )}
            </div>
            {rows.map((it) => (
              <div key={it.id}>
                <button
                  className={`drops-row drops-item${expanded === it.id ? " active" : ""}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  onClick={() => toggleExpand(it.id)}
                >
                  <span className="drops-name">
                    <span
                      className={`drops-star${
                        isWishlisted(it.name) ? " on" : ""
                      }`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isWishlisted(it.name)}
                      aria-label={
                        isWishlisted(it.name)
                          ? `Stop tracking drops for ${it.name}`
                          : `Track drops for ${it.name}`
                      }
                      title={
                        isWishlisted(it.name)
                          ? "Tracking drops — click to remove"
                          : "Track drops for this item"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWishlist(it.name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleWishlist(it.name);
                        }
                      }}
                    >
                      {isWishlisted(it.name) ? "★" : "☆"}
                    </span>
                    <ItemTypeIcon itemtype={it.itemtype} slots={it.slots} />
                    {it.name}
                    {it.loregroup !== 0 ? (
                      <span className="drops-badge">LORE</span>
                    ) : null}
                    {it.noDrop ? (
                      <span className="drops-badge warn">NO DROP</span>
                    ) : null}
                  </span>
                  {cols.map((c) => (
                    <span key={c.id} className={c.numeric ? "num" : undefined}>
                      {c.render(it)}
                    </span>
                  ))}
                </button>
                {expanded === it.id && detail && (
                  <div className="drops-detail">
                    <div className="drops-spec">
                      {ITEM_TYPES[detail.itemtype] && (
                        <SpecRow label="Type" value={ITEM_TYPES[detail.itemtype]} />
                      )}
                      {detail.damage > 0 && (
                        <SpecRow
                          label="Damage"
                          value={`${detail.damage} dmg / ${detail.delay} dly${
                            detail.delay > 0
                              ? ` (ratio ${(detail.damage / detail.delay).toFixed(3)})`
                              : ""
                          }`}
                        />
                      )}
                      {detail.ac !== 0 && (
                        <SpecRow label="AC" value={String(detail.ac)} />
                      )}
                      {statLine(detail) && (
                        <SpecRow label="Stats" value={statLine(detail)} />
                      )}
                      {detail.haste > 0 && (
                        <SpecRow label="Haste" value={`${detail.haste}%`} />
                      )}
                      {detail.procName && (
                        <SpecRow label="Proc" value={detail.procName} />
                      )}
                      {detail.clickName && (
                        <SpecRow label="Clicky" value={detail.clickName} />
                      )}
                      {detail.wornName && (
                        <SpecRow label="Worn" value={detail.wornName} />
                      )}
                      {detail.focusName && (
                        <SpecRow label="Focus" value={detail.focusName} />
                      )}
                      {decodeSlots(detail.slots) && (
                        <SpecRow label="Slots" value={decodeSlots(detail.slots)} />
                      )}
                      <SpecRow
                        label="Classes"
                        value={decodeClassesFull(detail.classes)}
                      />
                      <SpecRow
                        label="Races"
                        value={decodeBits(detail.races, RACE_BITS)}
                      />
                      {detail.reqlevel > 0 && (
                        <SpecRow label="Req level" value={String(detail.reqlevel)} />
                      )}
                      <SpecRow
                        label="Weight"
                        value={(detail.weight / 10).toFixed(1)}
                      />
                      {(detail.magic !== 0 ||
                        detail.loregroup !== 0 ||
                        detail.noDrop !== 0 ||
                        detail.noRent !== 0) && (
                        <SpecRow
                          label="Flags"
                          value={[
                            detail.magic ? "MAGIC" : null,
                            detail.loregroup !== 0 ? "LORE" : null,
                            detail.noDrop ? "NO DROP" : null,
                            detail.noRent ? "NO RENT" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        />
                      )}
                    </div>
                    <ResourceLinks kind="item" name={detail.name} eqId={detail.id} />
                    {questUses && questUses.length > 0 && (
                      <div className="refdb-chips">
                        <span className="refdb-chiplabel">Used in quest</span>
                        {questUses.map((quest) => (
                          <button
                            key={quest.id}
                            className="drops-chip"
                            title={`Open ${quest.name} in Quests`}
                            onClick={() => openQuests(quest.name)}
                          >
                            {quest.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {sources === null ? (
                      <div className="hint">Loading sources…</div>
                    ) : sources.length === 0 ? (
                      <div className="hint">
                        No known drop sources in this era — may be quest,
                        crafted, or vendor-sold.
                      </div>
                    ) : (
                      <div className="drops-sources">
                        <div className="drops-source-row drops-source-head">
                          <span>Mob</span>
                          <span className="num">Level</span>
                          <span>Zone</span>
                          <span className="num">Chance</span>
                        </div>
                        {sources.map((s, i) => (
                          <div
                            className={`drops-source-row${
                              zone && s.zone === zone ? " hit" : ""
                            }`}
                            key={i}
                          >
                            <span>
                              <button
                                className="session-item-link"
                                title="Open in the Mobs database"
                                onClick={() => openMobs(s.npc)}
                              >
                                {s.npc}
                              </button>
                            </span>
                            <span className="num">{s.level || "—"}</span>
                            <span>
                              {s.zoneLong ?? "(no known spawn)"}
                              {s.era != null && s.era > 0 ? (
                                <span className="drops-badge">
                                  {ERA_NAMES[s.era]}
                                </span>
                              ) : null}
                            </span>
                            <span className="num">
                              {s.chance >= 1
                                ? `${Math.round(s.chance)}%`
                                : `${s.chance.toFixed(1)}%`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {vendors && vendors.length > 0 && (
                      <>
                        <div className="refdb-subhead">Sold by</div>
                        <div className="refdb-rows">
                          {vendors.map((v, i) => (
                            <div
                              className="refdb-row"
                              style={{ gridTemplateColumns: "1fr 48px 1.2fr" }}
                              key={i}
                            >
                              <span>
                                <button
                                  className="session-item-link"
                                  title="Open in the Mobs database"
                                  onClick={() => openMobs(v.npc)}
                                >
                                  {v.npc}
                                </button>
                              </span>
                              <span className="num">{v.level || "—"}</span>
                              <span>
                                {v.zoneLong ?? v.zone ?? "(unknown zone)"}
                                {v.era != null && v.era > 0 ? (
                                  <span className="drops-badge">
                                    {ERA_NAMES[v.era]}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {recipes &&
                      (recipes.usedIn.length > 0 ||
                        recipes.makes.length > 0) && (
                        <>
                          <div className="refdb-subhead">Crafting</div>
                          {recipes.usedIn.length > 0 && (
                            <RecipeChips
                              label="Used in"
                              recipes={recipes.usedIn}
                            />
                          )}
                          {recipes.makes.length > 0 && (
                            <RecipeChips
                              label="Made by"
                              recipes={recipes.makes}
                            />
                          )}
                        </>
                      )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <Pager
            count={`${total} item${total === 1 ? "" : "s"}`}
            page={page}
            pages={pages}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
