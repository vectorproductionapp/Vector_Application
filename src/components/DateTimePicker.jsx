import React from "react";
import DatePicker from "./DatePicker";

export default function DateTimePicker({ value, onChange }) {
  const [date = "", time = ""] = String(value || "").split("T");
  const updateDate = (nextDate) => onChange(nextDate ? `${nextDate}T${time || "00:00"}` : "");
  const updateTime = (event) => onChange(date ? `${date}T${event.target.value}` : "");
  return (
    <div className="app-date-time-picker">
      <DatePicker value={date} onChange={updateDate} ariaLabel="Select date" />
      <input type="time" className="modal-input" value={time} onChange={updateTime} aria-label="Select time" />
    </div>
  );
}
