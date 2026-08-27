import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./StatusDropdown.css";

const statusClass = "status-dropdown";

export default function StatusDropdown({
  name,
  value,
  options,
  onChange,
  placeholder = "Select",
  disabled = false,
  formatLabel,
  menuClassName = "",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const listRef = useRef(null);
  const triggerRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState(null);

  const selectedLabel = formatLabel
    ? options.find((o) => o === value) !== undefined
      ? formatLabel(value)
      : ""
    : value || "";

  const close = useCallback(() => setIsOpen(false), []);

  const toggle = () => {
    if (!disabled) setIsOpen((prev) => !prev);
  };

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportPadding = 12;
    const gap = 6;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(280, openUp ? spaceAbove - gap : spaceBelow - gap));

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
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        !listRef.current?.contains(e.target)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, close]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const selectedEl = listRef.current.querySelector(`.${statusClass}-option.selected`);
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen]);

  const handleSelect = (option) => {
    const syntheticEvent = {
      target: { name, value: option },
    };
    onChange(syntheticEvent);
    close();
    triggerRef.current?.focus();
  };

  const handleOptionKeyDown = (e, option) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect(option);
    }
  };

  return (
    <div className={statusClass} ref={dropdownRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`${statusClass}-trigger${isOpen ? " open" : ""}`}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span>{selectedLabel || placeholder}</span>
        <svg
          className={`${statusClass}-chevron`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && menuPosition && createPortal(
        <ul
          className={`${statusClass}-list${menuClassName ? ` ${menuClassName}` : ""}`}
          ref={listRef}
          role="listbox"
          style={menuPosition}
        >
          {options.map((option) => {
            const isSelected = option === value;
            return (
              <li
                key={option}
                className={`${statusClass}-option${isSelected ? " selected" : ""}`}
                onClick={() => handleSelect(option)}
                onKeyDown={(e) => handleOptionKeyDown(e, option)}
                tabIndex={0}
                role="option"
                aria-selected={isSelected}
              >
                {formatLabel ? formatLabel(option) : option}
              </li>
            );
          })}
        </ul>,
        document.body
      )}
    </div>
  );
}
