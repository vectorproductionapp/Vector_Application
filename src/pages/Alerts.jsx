import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import Swal from "sweetalert2";
import {
  BellRing, CalendarDays, Clock3, FileSpreadsheet, FileUp, Loader2, Mail, Plus, RefreshCw, Save, Trash2, Users, X,
} from "lucide-react";
import api from "../components/Api";
import DatePicker from "../components/DatePicker";
import confirmRemove from "../utils/confirmRemove";
import "./Alerts.css";
 
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
 
const WORKING_DAYS = [
  { value: 0, short: "Mon", label: "Monday" },
  { value: 1, short: "Tue", label: "Tuesday" },
  { value: 2, short: "Wed", label: "Wednesday" },
  { value: 3, short: "Thu", label: "Thursday" },
  { value: 4, short: "Fri", label: "Friday" },
  { value: 5, short: "Sat", label: "Saturday" },
  { value: 6, short: "Sun", label: "Sunday" },
];
 
const EMPTY_SETTINGS = { enabled: false, weekly_enabled: false, weekly_send_day: 0, recipients: [], send_time: "09:00", weekly_send_time: "09:00", working_days: [0, 1, 2, 3, 4, 5], holidays: [] };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
 
function errorText(error, fallback) {
  return error?.response?.data?.message || error?.message || fallback;
}
 
// "2026-10-23" -> "23 Oct 2026"
function formatDay(iso) {
  const [year, month, day] = String(iso || "").slice(0, 10).split("-");
  if (!year || !month || !day) return iso || "";
  return `${day} ${SHORT_MONTHS[Number(month) - 1] || ""} ${year}`;
}
 
function formatDateTime(iso) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  });
}
 
// "09:30" -> "09:30 AM"
function formatTime(value) {
  const [hours, minutes] = String(value || "").split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value || "";
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${String(hours % 12 || 12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
 
// Holiday files: Excel/CSV with a date column and a description column. The
// date may be a real Excel date, ISO text, or DD-MM-YYYY / DD/MM/YYYY.
function normalizeImportedDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = String(value || "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(text);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (text && !Number.isNaN(parsed.getTime())) return normalizeImportedDate(parsed);
  return "";
}
 
function sameSettings(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
 
export default function Alerts() {
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [saved, setSaved] = useState(EMPTY_SETTINGS);
  const [status, setStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayDescription, setHolidayDescription] = useState("");
  const [importing, setImporting] = useState(false);
  const [weeklySchedule, setWeeklySchedule] = useState(null);
  const [weeklyScheduleError, setWeeklyScheduleError] = useState("");
 
  const dirty = !sameSettings(settings, saved);
 
  const applyResponse = useCallback((data) => {
    const next = { ...EMPTY_SETTINGS, ...(data.settings || {}) };
    setSettings(next);
    setSaved(next);
    setStatus(data.status || {});
  }, []);
 
  const loadWeeklySchedule = useCallback(async () => {
    try {
      const response = await api.get(`${API_BASE_URL}/alerts/weekly-stock-report/status`, { __vectorNoCache: true });
      if (!response.data.success) throw new Error(response.data.message);
      setWeeklySchedule(response.data.schedule);
      setWeeklyScheduleError("");
    } catch (error) {
      setWeeklyScheduleError(errorText(error, "Failed to load the weekly email schedule."));
    }
  }, []);
 
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await api.get(`${API_BASE_URL}/alerts/daily-report/settings`, { __vectorNoCache: true });
      if (!response.data.success) throw new Error(response.data.message);
      applyResponse(response.data);
    } catch (error) {
      setLoadError(errorText(error, "Failed to load the alert settings."));
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);
 
  useEffect(() => {
    load();
  }, [load]);
 
  useEffect(() => {
    loadWeeklySchedule();
  }, [loadWeeklySchedule]);
 
  // Leaving with unsaved changes would silently drop them, so a click on the
  // sidebar (or Logout) is held back and the app's own dialog asks first.
  // A browser reload/close is not intercepted: browsers only allow their own
  // built-in prompt there, which cannot be styled.
  const saveRef = useRef(null);
  const bypassRef = useRef(false);
  useEffect(() => {
    if (!dirty) return undefined;
    const intercept = async (event) => {
      const trigger = event.target.closest?.(".nav-item, .logout-btn");
      if (!trigger || bypassRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const result = await Swal.fire({
        title: "Unsaved changes",
        text: "You changed the alert settings but did not save them.",
        icon: "warning",
        showCancelButton: true,
        showDenyButton: true,
        confirmButtonText: "Save & leave",
        denyButtonText: "Leave without saving",
        cancelButtonText: "Stay",
        confirmButtonColor: "var(--accent)",
        denyButtonColor: "var(--color-danger, #b42318)",
        cancelButtonColor: "var(--bg-surface-alt)",
        reverseButtons: true,
        customClass: { popup: "swal-vector-popup" },
      });
      if (result.isDismissed) return;
      if (result.isConfirmed && !(await saveRef.current?.())) return;
      bypassRef.current = true;
      trigger.click();
      bypassRef.current = false;
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);
 
  const update = (field, value) => setSettings((previous) => ({ ...previous, [field]: value }));
  const flash = (type, text) => setNotice({ type, text });
 
  const save = async (override) => {
    const payload = override || settings;
    setSaving(true);
    setNotice(null);
    try {
      const response = await api.put(`${API_BASE_URL}/alerts/daily-report/settings`, payload, { __vectorSuppressBusy: true });
      if (!response.data.success) throw new Error(response.data.message);
      applyResponse(response.data);
      await loadWeeklySchedule();
      flash("success", "Settings saved.");
      return true;
    } catch (error) {
      flash("error", errorText(error, "The settings could not be saved."));
      return false;
    } finally {
      setSaving(false);
    }
  };
 
  saveRef.current = () => save();
 
  // Recipients, holidays and the on/off switch save the moment they change,
  // so a refresh never loses them. Only that part is sent, merged onto the
  // last *saved* settings, so an unsaved edit to the send time or working days
  // is neither saved by accident nor thrown away.
  //
  // Saves run one at a time, and each builds its change from the newest saved
  // settings (`savedRef`). Two quick deletes used to both start from the same
  // old list, so the second save put the first deleted item back.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const queueRef = useRef(Promise.resolve());
  const [pending, setPending] = useState(() => new Set());
 
  const savePatch = (buildPatch, successText, pendingKey = "") => {
    if (pendingKey) setPending((current) => new Set(current).add(pendingKey));
    const run = async () => {
      const patch = buildPatch(savedRef.current);
      if (!patch) return false;
      setSaving(true);
      try {
        const response = await api.put(
          `${API_BASE_URL}/alerts/daily-report/settings`,
          { ...savedRef.current, ...patch },
          { __vectorSuppressBusy: true }
        );
        if (!response.data.success) throw new Error(response.data.message);
        const stored = { ...EMPTY_SETTINGS, ...(response.data.settings || {}) };
        savedRef.current = stored;
        setSaved(stored);
        setStatus(response.data.status || {});
        await loadWeeklySchedule();
        setSettings((previous) => {
          const next = { ...previous };
          Object.keys(patch).forEach((key) => { next[key] = stored[key]; });
          return next;
        });
        flash("success", successText);
        return true;
      } catch (error) {
        flash("error", errorText(error, "The change could not be saved."));
        return false;
      } finally {
        setSaving(false);
        if (pendingKey) {
          setPending((current) => {
            const next = new Set(current);
            next.delete(pendingKey);
            return next;
          });
        }
      }
    };
    const result = queueRef.current.then(run, run);
    queueRef.current = result;
    return result;
  };
 
  const toggleEnabled = async () => {
    const enabled = !saved.enabled;
    if (enabled && !saved.recipients.length) {
      flash("error", "Add at least one recipient before turning the daily email on.");
      return;
    }
    await savePatch(() => ({ enabled }), enabled ? "Daily email turned on." : "Daily email turned off.");
  };
 
  const toggleWeeklyEnabled = async () => {
    const weekly_enabled = !saved.weekly_enabled;
    if (weekly_enabled && !saved.recipients.length) {
      flash("error", "Add at least one recipient before turning the weekly email on.");
      return;
    }
    await savePatch(
      () => ({ weekly_enabled }),
      weekly_enabled ? "Weekly email turned on." : "Weekly email turned off."
    );
  };
 
  const addRecipient = async () => {
    const email = emailInput.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_PATTERN.test(email)) {
      flash("error", `"${email}" is not a valid email address.`);
      return;
    }
    if (saved.recipients.includes(email)) {
      flash("error", `${email} is already a recipient.`);
      return;
    }
    setEmailInput("");
    const ok = await savePatch(
      (latest) => (latest.recipients.includes(email) ? null : { recipients: [...latest.recipients, email] }),
      `${email} added.`,
      `recipient:${email}`
    );
    if (!ok) setEmailInput((current) => current || email);
  };
 
  const removeRecipient = async (email) => {
    if (pending.has(`recipient:${email}`)) return;
    const remaining = saved.recipients.filter((item) => item !== email);
    const turnsOffDaily = !remaining.length && saved.enabled;
    const turnsOffWeekly = !remaining.length && saved.weekly_enabled;
    const disabledEmails = [
      ...(turnsOffDaily ? ["daily"] : []),
      ...(turnsOffWeekly ? ["weekly"] : []),
    ];
    const confirmed = await confirmRemove({
      title: "Remove this recipient?",
      text: disabledEmails.length
        ? `${email} is the only recipient, so the ${disabledEmails.join(" and ")} email${disabledEmails.length > 1 ? "s" : ""} will be turned off.`
        : `${email} will stop receiving the daily report.`,
      confirmText: "Remove recipient",
    });
    if (!confirmed) return;
    await savePatch((latest) => {
      const left = latest.recipients.filter((item) => item !== email);
      // No one left to email: the alert cannot stay on.
      return left.length ? { recipients: left } : {
        recipients: left,
        enabled: false,
        weekly_enabled: false,
      };
    }, `${email} removed.`, `recipient:${email}`);
  };
 
  const toggleDay = (value) => {
    const current = settings.working_days || [];
    update("working_days", current.includes(value)
      ? current.filter((day) => day !== value)
      : [...current, value].sort((a, b) => a - b));
  };
 
  const addHoliday = async () => {
    if (!holidayDate) {
      flash("error", "Pick the holiday date first.");
      return;
    }
    if (!holidayDescription.trim()) {
      flash("error", "Enter the holiday name.");
      return;
    }
    if (saved.holidays.some((holiday) => holiday.date === holidayDate)) {
      flash("error", `${formatDay(holidayDate)} is already in the calendar.`);
      return;
    }
    const entry = { date: holidayDate, description: holidayDescription.trim() };
    setHolidayDate("");
    setHolidayDescription("");
    const ok = await savePatch(
      (latest) => (latest.holidays.some((holiday) => holiday.date === entry.date)
        ? null
        : { holidays: [...latest.holidays, entry].sort((a, b) => a.date.localeCompare(b.date)) }),
      `${entry.description} added to the calendar.`,
      `holiday:${entry.date}`
    );
    if (!ok) {
      setHolidayDate((current) => current || entry.date);
      setHolidayDescription((current) => current || entry.description);
    }
  };
 
  const removeHoliday = async (holiday) => {
    if (pending.has(`holiday:${holiday.date}`)) return;
    const confirmed = await confirmRemove({
      title: "Remove this holiday?",
      text: `${holiday.description} (${formatDay(holiday.date)}) will become a normal working day.`,
      confirmText: "Remove holiday",
    });
    if (!confirmed) return;
    await savePatch(
      (latest) => ({ holidays: latest.holidays.filter((item) => item.date !== holiday.date) }),
      `${holiday.description} removed.`,
      `holiday:${holiday.date}`
    );
  };
 
  const importHolidays = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setNotice(null);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
      const imported = rows.map((row) => {
        const entries = Object.entries(row);
        const dateValue = entries.find(([key]) => /date|day/i.test(key))?.[1] ?? entries[0]?.[1];
        const description = entries.find(([key]) => /description|holiday|occasion|name|festival/i.test(key))?.[1] ?? entries[1]?.[1];
        return { date: normalizeImportedDate(dateValue), description: String(description || "Holiday").trim() };
      }).filter((holiday) => holiday.date);
      if (!imported.length) throw new Error("No rows with a valid date were found. Use columns named Date and Description.");
      await savePatch(
        (latest) => {
          const merged = new Map(latest.holidays.map((holiday) => [holiday.date, holiday]));
          imported.forEach((holiday) => merged.set(holiday.date, holiday));
          return { holidays: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)) };
        },
        `${imported.length} holiday(s) imported and saved.`
      );
    } catch (error) {
      flash("error", errorText(error, "The holiday file could not be read."));
    } finally {
      setImporting(false);
    }
  };
 
  const holidaysByYear = useMemo(() => {
    const groups = {};
    settings.holidays.forEach((holiday) => {
      const year = holiday.date.slice(0, 4);
      (groups[year] = groups[year] || []).push(holiday);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [settings.holidays]);
 
  if (loading) {
    return (
      <div className="alerts-state">
        <Loader2 size={28} className="spin" />
        <span>Loading alert settings...</span>
      </div>
    );
  }
 
  if (loadError) {
    return (
      <div className="alerts-state alerts-state-error">
        <span>{loadError}</span>
        <button type="button" className="alerts-btn alerts-btn-primary" onClick={load}>
          <RefreshCw size={15} /> Retry
        </button>
      </div>
    );
  }
 
  const workingDayNames = WORKING_DAYS.filter((day) => settings.working_days.includes(day.value)).map((day) => day.short);
  const weeklyScheduleActive = Boolean(
    weeklySchedule?.enabled && saved.weekly_enabled && saved.recipients.length
  );
  const weeklyScheduleStatus = weeklyScheduleError
    ? weeklyScheduleError
    : !weeklySchedule
      ? "Loading weekly schedule..."
      : !weeklySchedule.enabled
        ? "Disabled by server configuration"
        : !saved.weekly_enabled
          ? "Weekly report is disabled"
          : !saved.recipients.length
            ? "Add recipients to enable weekly reports"
            : "Enabled · moves to the next working day when needed";
  const lastStatusText = status.lastStatus === "sent"
    ? `Sent ${formatDateTime(status.lastSentAt)} (report for ${formatDay(status.lastReportDate)})`
    : status.lastStatus === "failed"
      ? `Last send failed: ${status.lastError || "unknown error"}`
      : "Not sent yet";
 
  return (
    <div className="alerts-page">
      <header className="alerts-hero">
        <div className="alerts-hero-main">
          <span className="alerts-hero-icon"><BellRing size={22} /></span>
          <div>
            <span className="alerts-eyebrow">Automation</span>
            <h2>Daily director report</h2>
            <p>One email a day with the previous working day&apos;s production and the overall totals.</p>
          </div>
        </div>
        <div className="alerts-hero-actions">
          <button
            type="button"
            className={`alerts-switch${settings.enabled ? " is-on" : ""}`}
            role="switch"
            aria-checked={settings.enabled}
            onClick={toggleEnabled}
            disabled={saving}
            aria-label={`Daily report ${settings.enabled ? "enabled" : "disabled"}`}
          >
            <span className="alerts-switch-track"><span className="alerts-switch-thumb" /></span>
            <span>Daily report {settings.enabled ? "enabled" : "disabled"}</span>
          </button>
          <button
            type="button"
            className={`alerts-switch${settings.weekly_enabled ? " is-on" : ""}`}
            role="switch"
            aria-checked={settings.weekly_enabled}
            onClick={toggleWeeklyEnabled}
            disabled={saving}
            aria-label={`Weekly report ${settings.weekly_enabled ? "enabled" : "disabled"}`}
          >
            <span className="alerts-switch-track"><span className="alerts-switch-thumb" /></span>
            <span>Weekly report {settings.weekly_enabled ? "enabled" : "disabled"}</span>
          </button>
          <button type="button" className="alerts-btn alerts-btn-primary" onClick={() => save()} disabled={saving || !dirty}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            Save Settings
          </button>
        </div>
      </header>
 
      {dirty && (
        <div className="alerts-notice alerts-notice-warn">
          <span>You have unsaved changes. Click <b>Save Settings</b> to apply them.</span>
        </div>
      )}
      {notice && (
        <div className={`alerts-notice alerts-notice-${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
 
      <section className="alerts-overview">
        <article className={`alerts-stat${saved.enabled ? " is-on" : " is-off"}`}>
          <span className="alerts-stat-icon"><BellRing size={18} /></span>
          <div>
            <small>Daily report</small>
            <strong>{saved.enabled ? "Enabled" : "Disabled"}</strong>
            <em title={lastStatusText}>{lastStatusText}</em>
          </div>
        </article>
        <article className="alerts-stat">
          <span className="alerts-stat-icon"><Users size={18} /></span>
          <div>
            <small>Recipients</small>
            <strong>{saved.recipients.length}</strong>
            <em title={saved.recipients.length ? saved.recipients.join(", ") : "No recipients configured"}>
              {saved.recipients.length ? saved.recipients.slice(0, 2).join(", ") + (saved.recipients.length > 2 ? "…" : "") : "No recipients yet"}
            </em>
          </div>
        </article>
        <article className="alerts-stat">
          <span className="alerts-stat-icon"><Clock3 size={18} /></span>
          <div>
            <small>Daily send time</small>
            <strong>{formatTime(saved.send_time)} <b className="alerts-tag">IST</b></strong>
            <em title={`Daily report working days: ${workingDayNames.join(", ") || "No working days"}`}>
              {workingDayNames.join(", ") || "No working days"}
            </em>
          </div>
        </article>
        <article className="alerts-stat">
          <span className="alerts-stat-icon"><CalendarDays size={18} /></span>
          <div>
            <small>Next daily email</small>
            <strong>{status.nextSendAt ? formatDateTime(status.nextSendAt) : "—"}</strong>
            <em title={status.nextSendAt ? `Next daily report: ${formatDateTime(status.nextSendAt)} IST. Covers ${formatDay(status.nextReportDate)}.` : saved.enabled ? "No working day is scheduled in the next 60 days." : "Enable the daily report to schedule it."}>
              {status.nextSendAt ? `Covers ${formatDay(status.nextReportDate)}` : saved.enabled ? "No working day ahead" : "Enable daily report to schedule"}
            </em>
          </div>
        </article>
        <article className={`alerts-stat alerts-stat-weekly${weeklyScheduleActive ? " is-on" : " is-off"}`}>
          <span className="alerts-stat-icon"><FileSpreadsheet size={18} /></span>
          <div>
            <small>Next weekly stock email</small>
            <strong>{weeklySchedule?.nextSendAt ? formatDateTime(weeklySchedule.nextSendAt) : "—"}</strong>
            <em title={`${WORKING_DAYS[saved.weekly_send_day]?.label || "Monday"} at ${formatTime(saved.weekly_send_time)} IST. ${weeklyScheduleStatus}`}>
              {weeklySchedule
                ? `${WORKING_DAYS[saved.weekly_send_day]?.label || "Monday"} · ${formatTime(saved.weekly_send_time)} IST · ${weeklyScheduleStatus}`
                : weeklyScheduleStatus}
            </em>
          </div>
        </article>
      </section>
 
      <div className="alerts-grid">
        <section className="alerts-card">
          <div className="alerts-card-head">
            <span className="alerts-card-icon"><Mail size={18} /></span>
            <div>
              <h3>Email recipients</h3>
              <p>Everyone listed here receives the daily report. Changes save immediately.</p>
            </div>
          </div>
          <div className="alerts-input-row">
            <input
              type="email"
              className="alerts-input"
              placeholder="director@company.com"
              value={emailInput}
              onChange={(event) => setEmailInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") addRecipient(); }}
              aria-label="Recipient email"
            />
            <button type="button" className="alerts-btn alerts-btn-outline alerts-btn-square" onClick={addRecipient} aria-label="Add recipient">
              <Plus size={18} />
            </button>
          </div>
          {settings.recipients.length ? (
            <ul className="alerts-list alerts-recipient-list">
              {settings.recipients.map((email) => (
                <li key={email} className={pending.has(`recipient:${email}`) ? "is-pending" : undefined}>
                  <span>{email}</span>
                  <button type="button" onClick={() => removeRecipient(email)} disabled={pending.has(`recipient:${email}`)} aria-label={`Remove ${email}`}>
                    {pending.has(`recipient:${email}`) ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="alerts-empty">No recipients yet. Add an email address above.</p>
          )}
        </section>
 
        <section className="alerts-card">
          <div className="alerts-card-head">
            <span className="alerts-card-icon"><Clock3 size={18} /></span>
            <div>
              <h3>Schedule</h3>
              <p>Daily email follows the selected working days. The weekly stock email uses the weekday selected below. Both use India time.</p>
            </div>
          </div>
          <div className="alerts-time-grid">
            <label className="alerts-field">
              <span>Daily send time</span>
              <input
                type="time"
                className="alerts-input alerts-time"
                value={settings.send_time}
                onChange={(event) => update("send_time", event.target.value)}
              />
            </label>
            <label className="alerts-field">
              <span>Weekly stock report send time</span>
              <input
                type="time"
                className="alerts-input alerts-time"
                value={settings.weekly_send_time}
                onChange={(event) => update("weekly_send_time", event.target.value)}
              />
              <small>Separate time · India time</small>
            </label>
          </div>
          <label className="alerts-field">
            <span>Weekly stock email day</span>
            <select
              className="alerts-input"
              value={settings.weekly_send_day}
              onChange={(event) => update("weekly_send_day", Number(event.target.value))}
            >
              {WORKING_DAYS.map((day) => (
                <option key={day.value} value={day.value}>{day.label}</option>
              ))}
            </select>
            <small>Save Settings to apply. If the selected day is not a working day or is a holiday, it moves to the next working day.</small>
          </label>
          <div className="alerts-field">
            <span>Working days</span>
            <small>Days not selected, and holidays, get no email. The report always covers the previous working day.</small>
            <div className="alerts-days" role="group" aria-label="Working days">
              {WORKING_DAYS.map((day) => {
                const selected = settings.working_days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    className={`alerts-day${selected ? " is-selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => toggleDay(day.value)}
                    title={day.label}
                  >
                    <b>{day.short}</b>
                    <span>{day.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
 
      <section className="alerts-card">
        <div className="alerts-card-head">
          <span className="alerts-card-icon"><CalendarDays size={18} /></span>
          <div>
            <h3>Holiday calendar</h3>
            <p>No email is sent on these dates, and they are skipped when choosing the day a report covers. Changes save immediately.</p>
          </div>
        </div>
 
        <div className="alerts-holiday-entry">
          <div className="alerts-holiday-manual">
            <span className="alerts-sub">Add manually</span>
            <div className="alerts-holiday-row">
              <DatePicker value={holidayDate} onChange={setHolidayDate} ariaLabel="Holiday date" />
              <input
                type="text"
                className="alerts-input"
                placeholder="Holiday name, e.g. Diwali"
                value={holidayDescription}
                onChange={(event) => setHolidayDescription(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addHoliday(); }}
                aria-label="Holiday name"
              />
              <button type="button" className="alerts-btn alerts-btn-outline" onClick={addHoliday}>
                <Plus size={16} /> Add holiday
              </button>
            </div>
          </div>
          <div className="alerts-divider"><span>OR</span></div>
          <div>
            <span className="alerts-sub">Import in bulk</span>
            <div className="alerts-import">
              <label className={`alerts-btn alerts-btn-outline${importing ? " is-busy" : ""}`}>
                {importing ? <Loader2 size={16} className="spin" /> : <FileUp size={16} />}
                {importing ? "Importing..." : "Upload holiday file"}
                <input type="file" hidden accept=".xlsx,.xls,.csv" onChange={importHolidays} disabled={importing} />
              </label>
              <small>Excel or CSV with <b>Date</b> and <b>Description</b> columns.</small>
            </div>
          </div>
        </div>
 
        {holidaysByYear.length ? holidaysByYear.map(([year, holidays]) => (
          <div key={year} className="alerts-year">
            <span className="alerts-sub">{year} · {holidays.length} holiday{holidays.length === 1 ? "" : "s"}</span>
            <div className="alerts-chips">
              {holidays.map((holiday) => (
                <div key={holiday.date} className={`alerts-chip${pending.has(`holiday:${holiday.date}`) ? " is-pending" : ""}`}>
                  <div>
                    <strong><CalendarDays size={12} /> {formatDay(holiday.date)}</strong>
                    <small>{holiday.description}</small>
                  </div>
                  <button type="button" onClick={() => removeHoliday(holiday)} disabled={pending.has(`holiday:${holiday.date}`)} aria-label={`Remove ${holiday.description}`}>
                    {pending.has(`holiday:${holiday.date}`) ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )) : <p className="alerts-empty">No holidays yet.</p>}
      </section>
 
    </div>
  );
}
 
 