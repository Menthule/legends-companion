// Shared Database-tab pagination footer: total count on the left, then
// "‹ Prev  page / pages  Next ›" once there is more than one page. All four
// reference tabs (Drops/Mobs/Recipes/Spells) render this identically.

export default function Pager({
  count,
  page,
  pages,
  onPage,
}: {
  /** Fully formed total-count label ("123 items", "1 recipe"). */
  count: string;
  /** Zero-based current page. */
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="drops-pager">
      <span className="hint num">{count}</span>
      {pages > 1 && (
        <>
          <button
            className="ghost small"
            disabled={page === 0}
            onClick={() => onPage(Math.max(0, page - 1))}
          >
            ‹ Prev
          </button>
          <span className="hint num">
            {page + 1} / {pages}
          </span>
          <button
            className="ghost small"
            disabled={page + 1 >= pages}
            onClick={() => onPage(page + 1)}
          >
            Next ›
          </button>
        </>
      )}
    </div>
  );
}
