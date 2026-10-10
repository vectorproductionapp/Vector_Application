import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from "lucide-react";
import { formatDate } from "../utils/date";
import { isBlankValue, isSortableColumn, nextSort, sortRows } from "../utils/tableSort";
import "./DataTable.css";

// An empty cell looks like a broken row, so every blank value renders as a
// dash instead of nothing at all.  Numbers keep their 0, and React nodes from
// a `render` function are never touched.
const EMPTY_CELL = "-";

const cellContent = (column, row) => {
  const value = column.render
    ? column.render(row)
    : column.format
      ? column.format(row[column.key])
      : column.isDate
        ? formatDate(row[column.key], "")
        : row[column.key];
  return isBlankValue(value) ? EMPTY_CELL : value;
};

export default function DataTable({ columns, rows, onViewDetails, onSortChange }) {
  const [sort, setSort] = useState({ key: null, direction: null });
  const sortedRows = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  // Report the active sort so the page can export its file in this same order.
  // The callback is held in a ref so an inline arrow function cannot retrigger
  // the effect on every render.
  const onSortChangeRef = useRef(onSortChange);
  onSortChangeRef.current = onSortChange;
  useEffect(() => {
    onSortChangeRef.current?.(sort);
  }, [sort]);

  if (!rows.length) {
    return <div className="data-table-empty">No matching rows.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = isSortableColumn(c);
              const active = sortable && sort.key === c.key && Boolean(sort.direction);
              const Indicator = active
                ? sort.direction === "asc" ? ArrowUp : ArrowDown
                : ArrowUpDown;
              return (
                <th
                  key={c.key}
                  aria-sort={sortable ? (active ? (sort.direction === "asc" ? "ascending" : "descending") : "none") : undefined}
                  className={active ? "data-table-th-sorted" : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="data-table-sort-btn"
                      onClick={() => setSort((current) => nextSort(current, c.key))}
                      title={active
                        ? sort.direction === "asc"
                          ? "Sorted ascending - click for descending"
                          : "Sorted descending - click to clear"
                        : "Click to sort"}
                    >
                      <span>{c.label}</span>
                      <Indicator size={13} aria-hidden="true" className="data-table-sort-icon" />
                    </button>
                  ) : c.label}
                </th>
              );
            })}
            {onViewDetails && <th className="data-table-actions-col">Details</th>}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const value = cellContent(c, r);
                return (
                  <td key={c.key} className={c.mono ? "mono" : ""}>
                    {value === EMPTY_CELL ? (
                      <span className="cell-empty" title="No value">{EMPTY_CELL}</span>
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
              {onViewDetails && (
                <td className="data-table-actions-col">
                  <button
                      type="button"
                      className="data-table-view-btn"
                      onClick={() => onViewDetails(r)}
                      aria-label="View Details"
                    >
                      <Eye size={16} /> View
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
