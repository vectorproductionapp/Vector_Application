import React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import "./ListPagination.css";

// "Show N per page" choices. Every list endpoint accepts `?limit=<n>` and caps
// it at 100, so all of these are honoured by the backend.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// Builds the numbered page buttons, e.g. [1, 2, 3, "gap", 8].
export function buildPageList(currentPage, totalPages) {
  if (totalPages <= 1) return [1];
  const wanted = new Set([1, totalPages]);
  for (let p = currentPage - 1; p <= currentPage + 1; p += 1) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }
  if (currentPage <= 3) {
    for (let p = 1; p <= 3; p += 1) {
      if (p <= totalPages) wanted.add(p);
    }
  }
  if (currentPage >= totalPages - 2) {
    for (let p = totalPages - 2; p <= totalPages; p += 1) {
      if (p >= 1) wanted.add(p);
    }
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const items = [];
  let previous = 0;
  sorted.forEach((pageNumber) => {
    if (previous && pageNumber - previous > 1) items.push("gap");
    items.push(pageNumber);
    previous = pageNumber;
  });
  return items;
}

// Shared footer for every paginated list: "Showing X–Y of N rows" + numbered
// pager + "Show [n] per page" selector. Paging is done by the backend
// (`?page=` / `?limit=`), so changing either value triggers a fresh request.
export default function ListPagination({
  page = 1,
  pageSize = 10,
  totalPages = 1,
  totalCount = 0,
  rowCount = 0,
  onPageChange,
  onPageSizeChange,
}) {
  const safeTotalPages = Math.max(1, totalPages || 1);

  const goToPage = (nextPage) => {
    const clamped = Math.min(Math.max(nextPage, 1), safeTotalPages);
    if (clamped === page || !onPageChange) return;
    onPageChange(clamped);
  };

  const handlePageSizeChange = (event) => {
    const next = Number(event.target.value);
    if (!PAGE_SIZE_OPTIONS.includes(next) || next === pageSize) return;
    onPageSizeChange?.(next);
  };

  const firstRow = rowCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = (page - 1) * pageSize + rowCount;

  return (
    <div className="pg-root">
      <div className="pg-row">
        <p className="pg-hint">
          Showing {firstRow}–{lastRow} of {totalCount} rows
        </p>

        <div className="pg-controls">
          <button
            type="button"
            className="pg-btn pg-edge"
            onClick={() => goToPage(1)}
            disabled={page === 1}
            aria-label="First page"
          >
            <ChevronsLeft size={16} />
          </button>

          <button
            type="button"
            className="pg-btn pg-nav"
            onClick={() => goToPage(page - 1)}
            disabled={page === 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </button>

          {buildPageList(page, safeTotalPages).map((item, index) =>
            item === "gap" ? (
              <span key={`pg-gap-${index}`} className="pg-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                className={`pg-btn pg-num${item === page ? " active" : ""}`}
                onClick={() => goToPage(item)}
                aria-label={`Page ${item}`}
                aria-current={item === page ? "page" : undefined}
              >
                {item}
              </button>
            )
          )}

          <button
            type="button"
            className="pg-btn pg-nav"
            onClick={() => goToPage(page + 1)}
            disabled={page >= safeTotalPages}
            aria-label="Next page"
          >
            <ChevronRight size={16} />
          </button>

          <button
            type="button"
            className="pg-btn pg-edge"
            onClick={() => goToPage(safeTotalPages)}
            disabled={page >= safeTotalPages}
            aria-label="Last page"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        <label className="pg-size">
          <span>Show</span>
          <select
            className="pg-size-select"
            value={pageSize}
            onChange={handlePageSizeChange}
            aria-label="Rows per page"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span>per page</span>
        </label>
      </div>
    </div>
  );
}
