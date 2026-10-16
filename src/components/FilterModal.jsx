import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Filter, X } from "lucide-react";
import { SearchableSelect } from "./SearchBar";
import "./FilterModal.css";

// The searchable-select panels portal to <body>, so they need a z-index above
// the modal backdrop to stay clickable.
const SELECT_PANEL_Z = 130000;

function readFieldValue(row, field) {
  const raw = field?.getValue ? field.getValue(row) : row?.[field?.key];
  if (Array.isArray(raw)) return raw.map((value) => String(value ?? "").trim()).filter(Boolean);
  return String(raw ?? "").trim();
}

// Every filterable field is always present in the object; "" means "All".
export function emptyFilters(fields = []) {
  return fields.reduce((accumulator, field) => ({ ...accumulator, [field.key]: "" }), {});
}

export function countActiveFilters(filters = {}) {
  return Object.values(filters).filter((value) => String(value ?? "") !== "").length;
}

// Trimmed and case-insensitive, exactly like every backend `_row_matches`
// helper, so a client-side check can never hide a row the server would keep.
function sameValue(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/**
 * True when a row satisfies every selected filter. Fields left on "All" are
 * ignored, so an empty filter object matches everything.
 */
export function matchesFilters(row, filters = {}, fields = []) {
  return fields.every((field) => {
    const selected = filters?.[field.key];
    if (String(selected ?? "") === "") return true;
    const rowValue = readFieldValue(row, field);
    return Array.isArray(rowValue) ? rowValue.some((item) => sameValue(item, selected)) : sameValue(rowValue, selected);
  });
}

/**
 * Builds the repeated `filterField` / `filterValue` query pairs the list
 * endpoints accept, skipping fields left on "All".
 */
export function toFilterParams(filters = {}, fields = []) {
  const params = new URLSearchParams();
  fields.forEach((field) => {
    const selected = filters?.[field.key];
    if (String(selected ?? "") === "") return;
    params.append("filterField", field.key);
    params.append("filterValue", String(selected));
  });
  return params;
}

export default function FilterModal({
  rows = [],
  fields = [],
  options,
  value = {},
  onChange,
  label = "Filter",
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const activeCount = countActiveFilters(value);

  // Server-paged lists hand in `options` built from the whole collection, so a
  // narrow page never hides a value the user could have picked. Pages that
  // filter in the browser fall back to the rows they already hold.
  const optionsByField = useMemo(() => {
    const result = {};
    fields.forEach((field) => {
      const supplied = options?.[field.key];
      if (Array.isArray(supplied)) {
        result[field.key] = supplied;
        return;
      }
      const unique = new Set();
      rows.forEach((row) => {
        const rowValue = readFieldValue(row, field);
        if (Array.isArray(rowValue)) rowValue.forEach((item) => unique.add(item));
        else if (rowValue !== "") unique.add(rowValue);
      });
      result[field.key] = Array.from(unique).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
    return result;
  }, [fields, options, rows]);

  const openModal = useCallback(() => {
    // Drafting keeps the table untouched until Apply is pressed.
    setDraft({ ...emptyFilters(fields), ...value });
    setOpen(true);
  }, [fields, value]);

  const closeModal = useCallback(() => setOpen(false), []);

  const apply = () => {
    const applied = {};
    fields.forEach((field) => {
      const selected = String(draft[field.key] ?? "");
      if (selected !== "") applied[field.key] = selected;
    });
    onChange?.(applied);
    setOpen(false);
  };

  const reset = () => {
    onChange?.({});
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return undefined;
    const handleEscape = (event) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [closeModal, open]);

  const draftActive = countActiveFilters(draft);

  return (
    <div className="filter-modal-root">
      <button
        type="button"
        className={`filter-modal-trigger${activeCount ? " active" : ""}`}
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Filter size={15} />
        {label}
        {activeCount > 0 && <span className="filter-modal-count">{activeCount}</span>}
      </button>

      {open && createPortal(
        <div className="filter-modal-overlay" onClick={closeModal}>
          <div
            className="filter-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={label}
          >
            <div className="filter-modal-header">
              <span className="filter-modal-heading">
                <Filter size={16} />
                {label}
              </span>
              <button type="button" className="filter-modal-close" onClick={closeModal} aria-label="Close filter">
                <X size={18} />
              </button>
            </div>

            <div className="filter-modal-body">
              {fields.map((field) => (
                <div className="filter-modal-field" key={field.key}>
                  <span className="filter-modal-label">{field.label}</span>
                  <SearchableSelect
                    value={draft[field.key] || ""}
                    onChange={(nextValue) => setDraft((current) => ({ ...current, [field.key]: nextValue }))}
                    options={[
                      { value: "", label: "All" },
                      ...(optionsByField[field.key] || []).map((option) => ({ value: option, label: option })),
                    ]}
                    placeholder="All"
                    panelZIndex={SELECT_PANEL_Z}
                  />
                </div>
              ))}
            </div>

            <div className="filter-modal-footer">
              <button type="button" className="filter-modal-reset" onClick={reset} disabled={!draftActive && !activeCount}>
                Reset
              </button>
              <button type="button" className="filter-modal-apply" onClick={apply}>
                Apply
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}