import React from "react";
import { X } from "lucide-react";

/**
 * Names the filters that are currently applied.
 *
 * The FilterModal trigger only shows a *count*, which is not enough to explain
 * a table that arrived already filtered - especially when the filter was set
 * by a dashboard card rather than by the user. Each chip shows the field's
 * label and the selected value, and can be cleared on its own.
 */
export default function ActiveFilterChips({ fields = [], value = {}, onChange }) {
  const active = fields.filter(
    (field) => String(value?.[field.key] ?? "").trim() !== ""
  );
  if (!active.length) return null;

  const clearOne = (key) => {
    const next = { ...value };
    delete next[key];
    onChange?.(next);
  };

  return (
    <div className="filter-chip-row" role="status" aria-label="Active filters">
      {active.map((field) => {
        const selected = String(value[field.key] ?? "").trim();
        return (
          <span className="filter-chip" key={field.key}>
            <span className="filter-chip-label">{field.label}</span>
            <span className="filter-chip-value">{selected}</span>
            <button
              type="button"
              className="filter-chip-clear"
              onClick={() => clearOne(field.key)}
              aria-label={`Clear ${field.label} filter`}
              title={`Clear ${field.label}`}
            >
              <X size={13} />
            </button>
          </span>
        );
      })}
    </div>
  );
}