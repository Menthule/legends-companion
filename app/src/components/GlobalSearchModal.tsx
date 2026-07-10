import { useEffect, useMemo, useRef, useState } from "react";
import {
  globalSearch,
  type GlobalSearchAction,
  type GlobalSearchGroup,
  type GlobalSearchResult,
} from "../lib/globalSearch";

interface Props {
  initialQuery: string;
  reason?: string;
  currentZone?: string | null;
  onClose(): void;
  onAction(action: GlobalSearchAction): void;
}

export default function GlobalSearchModal({
  initialQuery,
  reason,
  currentZone,
  onClose,
  onAction,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [groups, setGroups] = useState<GlobalSearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setQuery(initialQuery);
    setActive(0);
  }, [initialQuery]);

  useEffect(() => {
    const q = query.trim();
    let stale = false;
    if (q.length < 2) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const h = window.setTimeout(() => {
      void globalSearch(q, { limitPerGroup: 5, eraMax: 99, currentZone })
        .then((next) => {
          if (!stale) {
            setGroups(next.groups.filter((g) => g.results.length > 0));
            setActive(0);
          }
        })
        .catch(() => {
          if (!stale) setGroups([]);
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 140);
    return () => {
      stale = true;
      window.clearTimeout(h);
    };
  }, [query, currentZone]);

  const results = useMemo(
    () => groups.flatMap((group) => group.results),
    [groups],
  );

  function choose(row: GlobalSearchResult | undefined) {
    if (!row) return;
    onAction(row.action);
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = [
        ...card.querySelectorAll<HTMLElement>(
          'button, input, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !card.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !card.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  }

  let idx = -1;
  return (
    <div
      className="modal-scrim global-search-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal global-search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        ref={cardRef}
      >
        <div className="global-search-head">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search logs, mobs, drops, spells, triggers"
            aria-label="Global search"
          />
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        {(reason || currentZone) && (
          <div className="global-search-context">
            {[reason, currentZone ? `Current zone: ${currentZone}` : ""]
              .filter(Boolean)
              .join(" - ")}
          </div>
        )}
        <div className="global-search-results" role="listbox">
          {query.trim().length < 2 ? (
            <div className="global-search-empty">Type at least 2 characters.</div>
          ) : loading && results.length === 0 ? (
            <div className="global-search-empty">Searching...</div>
          ) : results.length === 0 ? (
            <div className="global-search-empty">No results.</div>
          ) : (
            groups.map((group) => (
              <div className="global-search-group" key={group.id}>
                <div className="global-search-group-title">
                  {group.title}
                </div>
                {group.results.map((row) => {
                  idx += 1;
                  const selected = idx === active;
                  return (
                    <button
                      type="button"
                      className={`global-search-row${selected ? " active" : ""}`}
                      key={row.id}
                      onMouseEnter={() => setActive(results.indexOf(row))}
                      onClick={() => choose(row)}
                      role="option"
                      aria-selected={selected}
                    >
                      <span className="global-search-main">
                        <span className="global-search-title">{row.title}</span>
                        {row.subtitle && (
                          <span className="global-search-subtitle">
                            {row.subtitle}
                          </span>
                        )}
                      </span>
                      {row.meta.length > 0 && (
                        <span className="global-search-meta">
                          {row.meta.join(" - ")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
