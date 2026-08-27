import React from "react";
import { Eye } from "lucide-react";
import { formatDate } from "../utils/date";
import "./DataTable.css";

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
              {columns.map((c) => (
                <td key={c.key} className={c.mono ? "mono" : ""}>
                  {c.render ? c.render(r) : c.format ? c.format(r[c.key]) : c.isDate ? formatDate(r[c.key]) : r[c.key]}
                </td>
              ))}
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
