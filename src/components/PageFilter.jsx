import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Filter, X } from "lucide-react";
import { SearchableSelect } from "./SearchBar";
import "./PageFilter.css";

export const EMPTY_PAGE_FILTER = Object.freeze({ field: "", value: "" });

function readFieldValue(row, field) {
  const raw = field?.getValue ? field.getValue(row) : row?.[field?.key];
  if (Array.isArray(raw)) return raw.map((value) => String(value ?? "").trim()).filter(Boolean);
  return String(raw ?? "").trim();
}

export function matchesPageFilter(row, filter, fields) {
  if (!filter?.field || filter.value === "") return true;
  const field = fields.find((item) => item.key === filter.field);
  if (!field) return true;
  const rowValue = readFieldValue(row, field);
  if (Array.isArray(rowValue)) return rowValue.includes(filter.value);
  return rowValue === filter.value;
}

export default function PageFilter({ rows = [], fields = [], value, onChange, label = "Filter" }) {
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const selectedField = fields.find((field) => field.key === value?.field);
  const active = Boolean(value?.field && value?.value !== "");

  const options = useMemo(() => {
    if (!selectedField) return [];
    const unique = new Set();
    rows.forEach((row) => {
      const rowValue = readFieldValue(row, selectedField);
      if (Array.isArray(rowValue)) rowValue.forEach((item) => unique.add(item));
      else if (rowValue !== "") unique.add(rowValue);
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [rows, selectedField]);

  const updatePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = Math.min(300, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - panelWidth - 12);
    const openUp = window.innerHeight - rect.bottom < 300 && rect.top > 300;
    setPanelPosition({
      width: panelWidth,
      left,
      ...(openUp ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
    });
  }, []);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (event.target.closest?.(".searchable-select-panel")) return;
      if (!rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  const clear = () => onChange({ field: "", value: "" });

  return (
    <div className="page-filter" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`page-filter-trigger${active ? " active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Filter size={15} />
        {label}
        {active && <span className="page-filter-count">1</span>}
      </button>

      {open && panelPosition && createPortal(
        <div ref={panelRef} className="page-filter-panel" style={panelPosition} role="dialog" aria-label={`${label} records`}>
          <div className="page-filter-heading">
            <strong>{label} records</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close filter">
              <X size={15} />
            </button>
          </div>

          <div className="page-filter-field">
            <span>Field</span>
            <SearchableSelect
              value={value?.field || ""}
              onChange={(field) => onChange({ field, value: "" })}
              options={[
                { value: "", label: "Select field" },
                ...fields.map((field) => ({ value: field.key, label: field.label })),
              ]}
              placeholder="Select field"
            />
          </div>

          <div className="page-filter-field">
            <span>Value</span>
            <SearchableSelect
              value={value?.value || ""}
              disabled={!selectedField}
              onChange={(filterValue) => onChange({ field: value.field, value: filterValue })}
              options={[
                { value: "", label: "All values" },
                ...options.map((option) => ({ value: option, label: option })),
              ]}
              placeholder="All values"
            />
          </div>

          <button type="button" className="page-filter-clear" onClick={clear} disabled={!value?.field && !value?.value}>
            Clear filter
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
