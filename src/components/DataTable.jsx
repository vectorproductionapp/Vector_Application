import React from "react";
import { Eye } from "lucide-react";
import { formatDate } from "../utils/date";
import "./DataTable.css";

// An empty cell looks like a broken row, so every blank value renders as a
// dash instead of nothing at all.  Numbers keep their 0, and React nodes from
// a `render` function are never touched.
const EMPTY_CELL = "-";

const isEmptyCell = (value) =>
  value === null ||
  value === undefined ||
  (typeof value !== "object" && String(value).trim() === "");

const cellContent = (column, row) => {
  const value = column.render
    ? column.render(row)
    : column.format
      ? column.format(row[column.key])
      : column.isDate
        ? formatDate(row[column.key], "")
        : row[column.key];
  return isEmptyCell(value) ? EMPTY_CELL : value;
};

export default function DataTable({ columns, rows, onViewDetails }) {
  if (!rows.length) {
    return <div className="data-table-empty">No matching rows.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            {onViewDetails && <th className="data-table-actions-col">Details</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
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
