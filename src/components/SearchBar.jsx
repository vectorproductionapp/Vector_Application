import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X, ChevronDown, Loader2 } from "lucide-react";
import "./SearchBar.css";
 
// ---- Plain text search bar (used in toolbars, tables, etc.) ----
export default function SearchBar({ value, onChange, placeholder = "Search..." }) {
  return (
    <div className="search-bar">
      <Search size={15} className="search-bar-icon" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
      />
      {value && (
        <button
          type="button"
          className="search-bar-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
 
// ---- Searchable dropdown select (used for BOQ-driven Phase / Item Code fields) ----
export function SearchableSelect({
  options = [],
  value,
  onChange,
  placeholder = "Select...",
  disabled = false,
  loading = false,
  emptyMessage = "No options available",
  actionOption,
  allowCustomValue = false,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [menuPosition, setMenuPosition] = useState(null);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
  }, []);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportPadding = 12;
    const gap = 6;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(150, Math.min(300, openUp ? spaceAbove - gap : spaceBelow - gap));

    setMenuPosition({
      left: rect.left,
      width: rect.width,
      maxHeight,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    });
  }, []);
 
  useEffect(() => {
    function handleClickOutside(e) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target) &&
        !panelRef.current?.contains(e.target)
      ) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [close]);
 
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, close]);
 
  const selectedOption = options.find((opt) => opt.value === value);
 
  const filteredOptions = search.trim()
    ? options.filter((opt) => opt.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;
 
  const handleSelect = (opt) => {
    onChange(opt.value);
    close();
    triggerRef.current?.focus();
  };

  const customValue = search.trim();
  const displayValue = selectedOption?.label || value;
 
  return (
    <div className={`searchable-select${disabled ? " disabled" : ""}`} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="searchable-select-trigger"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={displayValue ? "" : "searchable-select-placeholder"}>
          {loading ? "Loading..." : displayValue || placeholder}
        </span>
        {loading ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <ChevronDown size={15} className={`searchable-select-chevron${open ? " open" : ""}`} />
        )}
      </button>
 
      {open && !disabled && menuPosition && createPortal(
        <div className="searchable-select-panel" ref={panelRef} style={menuPosition}>
          <div className="searchable-select-search">
            <Search size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
            />
          </div>
 
          <div className="searchable-select-options">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-empty">{emptyMessage}</div>
            ) : (
              filteredOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={`searchable-select-option${opt.value === value ? " selected" : ""}`}
                  onClick={() => handleSelect(opt)}
                >
                  {opt.label}
                </button>
              ))
            )}
          </div>
          {allowCustomValue && customValue && !options.some((opt) => opt.value.toLowerCase() === customValue.toLowerCase()) && (
            <button
              type="button"
              className="searchable-select-action"
              onClick={() => handleSelect({ value: customValue, label: customValue })}
            >
              Use “{customValue}”
            </button>
          )}
          {actionOption && (
            <button
              type="button"
              className="searchable-select-action"
              onClick={() => handleSelect(actionOption)}
            >
              {actionOption.label}
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
 
