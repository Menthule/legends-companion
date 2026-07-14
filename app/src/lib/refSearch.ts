// Shared Database-tab search scaffold: the debounced refdb search pipeline
// (250ms debounce, clear-on-inactive, paging, error capture) plus the
// expanded-row state every reference tab carries. Drops/Mobs/Recipes/Spells
// used to hand-roll identical copies of this; keeping it here stops the
// four tabs' search behavior from drifting.

import type { DependencyList } from "react";
import { useEffect, useRef, useState } from "react";

/** Rows per page across every Database reference tab. */
export const PAGE_SIZE = 50;

export interface RefSearchPage<Row> {
  rows: Row[];
  total: number;
}

/**
 * Debounced, paged refdb search. While `active` is false the results are
 * cleared without fetching (the tabs gate on "2+ chars typed or a filter
 * set"). `fetch` runs 250ms after the last change to `deps`/`page`; a
 * rejection lands in `error`. `page` is owned here — callers reset it via
 * `resetPaging()` (which also collapses any expanded row) when a filter
 * changes.
 */
export function useDebouncedRefSearch<Row>({
  active,
  fetch,
  deps,
}: {
  active: boolean;
  fetch: (offset: number, limit: number) => Promise<RefSearchPage<Row>>;
  /** Query/filter/sort values the search depends on (page is internal). */
  deps: DependencyList;
}) {
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const debounce = useRef<number | null>(null);
  // The fetch closure is recreated every render; keep the latest in a ref so
  // the debounce effect only re-runs when the actual search inputs change.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      if (!active) {
        setRows([]);
        setTotal(0);
        setError(null);
        return;
      }
      fetchRef
        .current(page * PAGE_SIZE, PAGE_SIZE)
        .then((res) => {
          setRows(res.rows);
          setTotal(res.total);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    }, 250);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, page, ...deps]);

  /** Back to page 0 with no row expanded — call on any filter change. */
  function resetPaging() {
    setPage(0);
    setExpanded(null);
  }

  /** Plain expand/collapse. Tabs that fetch detail imperatively on expand
   *  (Drops, Mobs) wrap `setExpanded` themselves instead. */
  function toggleExpand(id: number) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
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
    toggleExpand,
  };
}
