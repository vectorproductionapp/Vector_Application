import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate } from "../utils/date";
import "./DatePicker.css";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toLocalDate(value) {
  if (!value) return new Date();
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function DatePicker({ value, onChange, disabled = false, ariaLabel = "Select date" }) {
  const [open, setOpen] = useState(false);
  const [yearOpen, setYearOpen] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const [opensUpward, setOpensUpward] = useState(false);
  const yearListRef = useRef(null);
  const pickerRef = useRef(null);
  const [month, setMonth] = useState(() => toLocalDate(value));
  const selectedIso = String(value || "").slice(0, 10);
  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 101 }, (_, index) => currentYear - 50 + index);
  }, []);
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: first.getDay() + count }, (_, index) =>
      index < first.getDay() ? null : new Date(month.getFullYear(), month.getMonth(), index - first.getDay() + 1)
    );
  }, [month]);
  const changeMonth = (offset) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  useEffect(() => {
    if (yearOpen) yearListRef.current?.querySelector(".selected")?.scrollIntoView({ block: "center" });
  }, [yearOpen]);
  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (!pickerRef.current?.contains(event.target)) {
        setOpen(false);
        setMonthOpen(false);
        setYearOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);
  useLayoutEffect(() => {
    if (!open || !pickerRef.current) return;
    const rect = pickerRef.current.getBoundingClientRect();
    setOpensUpward(window.innerHeight - rect.bottom < 350 && rect.top > 350);
  }, [open]);
  const chooseDay = (date) => {
    onChange(toIsoDate(date));
    setOpen(false);
  };

  return (
    <div className="app-date-picker" ref={pickerRef}>
      <button type="button" className="app-date-picker-trigger" onClick={() => !disabled && setOpen((current) => !current)} aria-expanded={open} aria-label={ariaLabel} disabled={disabled}>
        <span className={selectedIso ? "" : "app-date-picker-placeholder"}>{selectedIso ? formatDate(selectedIso) : "DD/MM/YYYY"}</span>
        <CalendarDays size={17} aria-hidden="true" />
      </button>
      {open && !disabled && <div className={`app-date-picker-popover${opensUpward ? " app-date-picker-popover--up" : ""}`} role="dialog" aria-label="Calendar">
        <div className="app-date-picker-header">
          <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month"><ChevronLeft size={17} /></button>
          <div className="app-date-picker-month-year">
            <div className="app-date-picker-month-select">
              <button type="button" onClick={() => { setMonthOpen((current) => !current); setYearOpen(false); }} aria-expanded={monthOpen} aria-label="Select month">{month.toLocaleDateString("en-GB", { month: "long" })}</button>
              {monthOpen && <div className="app-date-picker-month-list" role="listbox">
                {Array.from({ length: 12 }, (_, index) => <button type="button" key={index} className={index === month.getMonth() ? "selected" : ""} onClick={() => { setMonth((current) => new Date(current.getFullYear(), index, 1)); setMonthOpen(false); }}>{new Date(2000, index, 1).toLocaleDateString("en-GB", { month: "long" })}</button>)}
              </div>}
            </div>
            <div className="app-date-picker-year-select">
              <button type="button" onClick={() => { setYearOpen((current) => !current); setMonthOpen(false); }} aria-expanded={yearOpen} aria-label="Select year">{month.getFullYear()}</button>
              {yearOpen && <div className="app-date-picker-year-list" role="listbox" ref={yearListRef}>
                {years.map((year) => <button type="button" key={year} className={year === month.getFullYear() ? "selected" : ""} onClick={() => { setMonth((current) => new Date(year, current.getMonth(), 1)); setYearOpen(false); }}>{year}</button>)}
              </div>}
            </div>
          </div>
          <button type="button" onClick={() => changeMonth(1)} aria-label="Next month"><ChevronRight size={17} /></button>
        </div>
        <div className="app-date-picker-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
        <div className="app-date-picker-days">
          {days.map((date, index) => !date ? <span key={`blank-${index}`} /> : <button type="button" key={toIsoDate(date)} onClick={() => chooseDay(date)} className={toIsoDate(date) === selectedIso ? "selected" : ""}>{date.getDate()}</button>)}
        </div>
        <div className="app-date-picker-footer"><button type="button" onClick={() => { onChange(""); setOpen(false); }}>Clear date</button></div>
      </div>}
    </div>
  );
}
