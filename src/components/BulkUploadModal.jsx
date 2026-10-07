import React, { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import * as XLSX from "xlsx";
import "./BulkUploadModal.css";

/*
 * Reusable "upload an Excel/CSV" flow for the list-based forms (PO Details,
 * Invoices, BOQ, ...):
 *
 *  1. download a pre-filled template, so a valid file is one download away;
 *  2. pick a .xlsx / .xls / .csv file - the header row is matched by name, so
 *     "PO No.", "po no" and "PO_NUMBER" all resolve to the same column;
 *  3. every data row is normalised by `normalizeRow`, which reports what is
 *     wrong instead of failing the whole file;
 *  4. the caller decides what to do with the good rows (`onImport`).
 */

export const normalizeHeader = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Excel serial / Date / "DD-MM-YYYY" / "YYYY-MM-DD" -> "YYYY-MM-DD". */
export function parseDateCell(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return "";
    return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  }
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return text;
}

export function readWorkbook(file) {
  const isCsv = /\.csv$/i.test(file.name);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = event.target?.result;
        resolve(
          XLSX.read(isCsv ? data : new Uint8Array(data), {
            type: isCsv ? "string" : "array",
            cellDates: true,
          })
        );
      } catch {
        reject(new Error("This file could not be read. Please upload a valid .xlsx, .xls or .csv file."));
      }
    };
    reader.onerror = () => reject(new Error("Unable to read the selected file."));
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

const columnLetter = (index) => {
  let out = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/**
 * SheetJS cannot write Excel data validation, so the list is injected into the
 * generated sheet XML directly.  `showErrorMessage="0"` keeps the cell
 * editable: an existing value can be picked from the dropdown, and a brand new
 * one can still be typed (which is what creates a new phase, for instance).
 */
/** `XLSX.write` can hand back an ArrayBuffer or an Array-like, but CFB and
 *  Blob both need real bytes. */
const asBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && value.buffer && typeof value.byteLength === "number") {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  }
  if (value && typeof value.length === "number") return Uint8Array.from(value);
  return new Uint8Array(0);
};

function addListValidations(buffer, validations) {
  if (!validations.length || !XLSX.CFB?.read) return asBytes(buffer);
  try {
    const zip = XLSX.CFB.read(asBytes(buffer), { type: "array" });
    const entry = zip.FileIndex.find((file) => /(^|\/)sheet1\.xml$/.test(file.name));
    if (!entry) return asBytes(buffer);
    let xml = new TextDecoder().decode(asBytes(entry.content));

    const items = validations
      .map(
        (item) =>
          `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="0" sqref="${item.range}">` +
          `<formula1>${item.sheet}!$${item.column}$2:$${item.column}$${item.lastRow}</formula1>` +
          `</dataValidation>`
      )
      .join("");
    const block = `<dataValidations count="${validations.length}">${items}</dataValidations>`;

    // dataValidations has a fixed position in the worksheet schema: it must come
    // before hyperlinks / printOptions / pageMargins / ignoredErrors.
    let at = xml.search(
      /<(hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|ignoredErrors|drawing|legacyDrawing)\b/
    );
    if (at === -1) at = xml.indexOf("</worksheet>");
    if (at === -1) return asBytes(buffer);
    xml = xml.slice(0, at) + block + xml.slice(at);

    entry.content = new TextEncoder().encode(xml);
    entry.size = entry.content.length;
    return XLSX.CFB.write(zip, { fileType: "zip", type: "array", compression: true });
  } catch {
    // A missing dropdown must never stop the download.
    return asBytes(buffer);
  }
}

function saveWorkbook(buffer, fileName) {
  const blob = new Blob([asBytes(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// How many rows get the auto-calculation formulas in a fresh template.
const FORMULA_ROW_COUNT = 200;

/**
 * Writes Excel formulas into the auto-calculated columns (GST per unit,
 * material cost per unit, line total ...).  A column carries a `formula`
 * string whose `{key}` tokens become that row's cell for the referenced
 * column, so entering Unit Rate and GST % fills the rest exactly like the
 * app does.  The values are never imported back - the columns exist only so
 * the sheet calculates while it is being filled in.
 */
export function applyColumnFormulas(sheet, columns, rowCount = FORMULA_ROW_COUNT) {
  const formulaColumns = (columns || []).filter((column) => column.formula);
  if (!formulaColumns.length || !sheet || !sheet["!ref"] || rowCount < 1) return sheet;

  const letters = {};
  (columns || []).forEach((column, index) => {
    letters[column.key] = columnLetter(index);
  });

  formulaColumns.forEach((column) => {
    const letter = letters[column.key];
    if (!letter) return;
    // OOXML stores the formula without a leading "="; SheetJS writes `f`
    // verbatim into <f>...</f>, so strip it here or Excel sees "==IF(...)".
    const body = String(column.formula || "").replace(/^=/, "");
    for (let row = 1; row <= rowCount; row += 1) {
      const excelRow = row + 1;
      const formula = body.replace(/\{(\w+)\}/g, (match, key) =>
        letters[key] ? `${letters[key]}${excelRow}` : match
      );
      sheet[`${letter}${excelRow}`] = { t: "n", f: formula, z: "#,##0.00" };
    }
  });

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  range.e.r = Math.max(range.e.r, rowCount);
  range.e.c = Math.max(range.e.c, columns.length - 1);
  sheet["!ref"] = XLSX.utils.encode_range(range);
  return sheet;
}

/** Excel writes dates as text unless the cell is a real date, and a text cell
 *  has no date picker. This turns a column's values into date cells with a
 *  DD-MM-YYYY number format. */
const EXCEL_DATE_FORMAT = "DD-MM-YYYY";

/** A real Date for a template cell, so Excel stores it as a date (and offers
 *  its date picker) instead of text. */
export const toDateCellDate = (value) => toExcelDate(value) || "";

const toExcelDate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  // Midday UTC keeps the displayed day from shifting west of Greenwich.
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12));
  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) return new Date(Date.UTC(+match[3], +match[1] - 1, +match[2], 12));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Re-types every filled cell of a date column as a real Excel date. */
export function applyDateColumnFormats(sheet, columns, seedRow = null) {
  if (!sheet || !sheet["!ref"]) return;
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  columns.forEach((column, index) => {
    if (!column.isDate) return;
    const letter = columnLetter(index);
    for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
      const address = `${letter}${row + 1}`;
      const cell = sheet[address];
      if (!cell || cell.f) continue;
      const date = toExcelDate(cell.v);
      if (!date) continue;
      sheet[address] = { t: "d", v: date, z: EXCEL_DATE_FORMAT };
    }
  });
}

/**
 * Downloads a template: a "Rows" sheet with the header row and, when the page
 * already has records, those records as-is - so the file can be edited and
 * uploaded back. The help/example text lives on a separate "Instructions"
 * sheet, and any column given in `dropdowns` gets an Excel dropdown on a
 * "Lists" sheet.
 */
export function downloadTemplate({ fileName, columns, notes = {}, dataRows = [], dropdowns = {} }) {
  const headers = columns.map((column) => column.label);
  const widths = columns.map((column) => ({
    wch: Math.min(42, Math.max(12, (notes[column.key]?.[0] || column.label).length + 6)),
  }));

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  sheet["!cols"] = widths;
  // Blank templates get a full block of ready-made formula rows; an export of
  // existing records keeps its rows and is topped up to the same minimum.
  applyColumnFormulas(sheet, columns, Math.max(dataRows.length, FORMULA_ROW_COUNT));
  applyDateColumnFormats(sheet, columns);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Rows");

  const help = columns.map((column) => [
    column.label,
    notes[column.key]?.[0] || "",
    notes[column.key]?.[1] || "",
  ]);
  const helpSheet = XLSX.utils.aoa_to_sheet([
    ["Column", "What to enter", "Example"],
    ...help,
    [],
    ["Note", "Click a date cell for Excel's date picker, or type the date as 2026-08-20 - ISO is read the same way in every locale.", ""],
  ]);
  helpSheet["!cols"] = [{ wch: 24 }, { wch: 52 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(book, helpSheet, "Instructions");

  // One list column per dropdown, all on a single "Lists" sheet.
  const listColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => Array.isArray(dropdowns[column.key]?.values) && dropdowns[column.key].values.length);
  const validations = [];
  if (listColumns.length) {
    const tallest = Math.max(...listColumns.map(({ column }) => dropdowns[column.key].values.length));
    const listRows = [listColumns.map(({ column }) => dropdowns[column.key].label || column.label)];
    for (let row = 0; row < tallest; row += 1) {
      listRows.push(listColumns.map(({ column }) => dropdowns[column.key].values[row] ?? ""));
    }
    const listSheet = XLSX.utils.aoa_to_sheet(listRows);
    listSheet["!cols"] = listColumns.map(({ column }) => ({ wch: Math.min(40, column.label.length + 8) }));
    XLSX.utils.book_append_sheet(book, listSheet, "Lists");

    listColumns.forEach(({ column, index }) => {
      validations.push({
        sheet: "Lists",
        column: columnLetter(index),
        range: `${columnLetter(index)}2:${columnLetter(index)}2000`,
        lastRow: listRows.length,
      });
    });
  }

  const buffer = XLSX.write(book, { type: "array", bookType: "xlsx" });
  saveWorkbook(addListValidations(buffer, validations), fileName);
}

/** First row that names at least half of the required columns. */
function findHeaderRow(matrix, columns, aliases) {
  const required = columns.filter((column) => column.required !== false).map((column) => column.key);
  return matrix.findIndex((cells) => {
    const found = new Set(
      (cells || [])
        .map((cell) => aliases[normalizeHeader(cell)])
        .filter(Boolean)
    );
    return required.filter((key) => found.has(key)).length >= Math.ceil(required.length / 2);
  });
}

export function parseBulkWorkbook({ workbook, columns, aliases, optionalKeys, normalizeRow }) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The selected file has no readable sheet.");

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  const headerIndex = findHeaderRow(matrix, columns, aliases);
  if (headerIndex === -1) {
    throw new Error(`No header row found. The file must contain these columns: ${columns
      .map((column) => column.label)
      .join(", ")}.`);
  }

  const columnMap = {};
  (matrix[headerIndex] || []).forEach((cell, columnIndex) => {
    const key = aliases[normalizeHeader(cell)];
    if (key && columnMap[key] === undefined) columnMap[key] = columnIndex;
  });

  const missing = columns
    .filter((column) => column.required !== false && !(optionalKeys || new Set()).has(column.key))
    .filter((column) => columnMap[column.key] === undefined)
    .map((column) => column.label);
  if (missing.length) throw new Error(`Missing column(s): ${missing.join(", ")}.`);

  const rows = [];
  const issues = [];
  const entries = [];
  for (let index = headerIndex + 1; index < matrix.length; index += 1) {
    const raw = matrix[index] || [];
    if (raw.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")) continue;

    const draft = {};
    columns.forEach((column) => {
      draft[column.key] = raw[columnMap[column.key]];
    });
    // The template ships a help row and an example row; neither is data.
    if (index === headerIndex + 1 && columns.every((column) => !draft[column.key])) continue;

    const { row, problems } = normalizeRow(draft);
    // Every data row is kept, problems included: the preview can correct a bad
    // row instead of dropping it.
    entries.push({ line: index + 1, draft, row, problems });
    if (problems.length) issues.push({ row: index + 1, message: problems.join("; ") });
    else rows.push(row);
  }

  if (!rows.length && !issues.length) {
    throw new Error(
      "No data rows were found below the header row. The file you chose contains only the header row — " +
        "save your changes in Excel first (Ctrl+S, or File → Download a copy if you are editing online), " +
        "then upload that saved file."
    );
  }
  return { rows, issues, entries };
}

const fmtCell = (value, field) => {
  if (value === null || value === undefined || value === "") return "";
  if (field?.isNumber) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : String(value);
  }
  return String(value);
};

export default function BulkUploadModal({
  open,
  onClose,
  title = "Bulk upload",
  description = "",
  fileName = "bulk-upload-template.xlsx",
  columns,
  aliases,
  optionalKeys,
  notes,
  dropdowns,
  normalizeRow,
  previewFields,
  importLabel = "Add rows",
  existingRows = [],
  existingRowLabel = "record",
  onImport,
}) {
const inputRef = useRef(null);
  // One entry per data row: the raw draft plus what `normalizeRow` made of it.
  // Editing patches the draft and re-runs the same normalization, so corrected
  // rows get the same checks and derived values as rows read from the file.
  const [entries, setEntries] = useState([]);
  const [editingLine, setEditingLine] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const readyRows = useMemo(
    () => entries.filter((entry) => !entry.problems.length).map((entry) => entry.row),
    [entries]
  );
  const issues = useMemo(
    () =>
      entries
        .filter((entry) => entry.problems.length)
        .map((entry) => ({ row: entry.line, message: entry.problems.join("; ") })),
    [entries]
  );

  const reset = useCallback(() => {
    setEntries([]);
    setEditingLine(null);
    setError("");
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const updateEntry = (line, field, value) => {
    setEntries((previous) =>
      previous.map((entry) => {
        if (entry.line !== line) return entry;
        const draft = { ...entry.draft, [field]: value };
        const { row, problems } = normalizeRow(draft);
        return { ...entry, draft, row, problems };
      })
    );
  };

  const deleteEntry = (line) => {
    setEntries((previous) => previous.filter((entry) => entry.line !== line));
    setEditingLine((current) => (current === line ? null : current));
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setEntries([]);
    setEditingLine(null);
    try {
      const workbook = await readWorkbook(file);
      const parsed = parseBulkWorkbook({ workbook, columns, aliases, optionalKeys, normalizeRow });
      setEntries(parsed.entries);
    } catch (err) {
      setError(err?.message || "That file could not be read.");
      // Clear the picker so the corrected file can be chosen again, even if it
      // keeps the same name.
      if (event.target) event.target.value = "";
    } finally {
      setBusy(false);
    }
  };

  const fields = useMemo(
    () => (previewFields || columns).filter((field) => !field.hidden),
    [previewFields, columns]
  );

  if (!open) return null;

  const handleImport = () => {
    if (!readyRows.length) return;
    onImport?.(readyRows);
    reset();
    onClose?.();
  };

  return createPortal(
    <div className="bulk-overlay" onClick={() => { reset(); onClose?.(); }}>
      <div
        className="bulk-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="bulk-header">
          <div className="bulk-heading">
            <span className="bulk-heading-icon">
              <Upload size={20} />
            </span>
            <div className="bulk-heading-text">
              <h2>{title}</h2>
              {description && <p>{description}</p>}
            </div>
          </div>
          <button
            type="button"
            className="bulk-close"
            onClick={() => { reset(); onClose?.(); }}
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </header>

        <div className="bulk-body">
          <p className="bulk-section-title">Choose Excel File</p>

          <div className="bulk-file-box">
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFile}
              disabled={busy}
            />
          </div>

          {busy && (
            <p className="bulk-reading">
              <Loader2 size={13} className="spin" /> Reading&hellip;
            </p>
          )}

          {error && (
            <div className="bulk-error">
              <AlertTriangle size={15} /> {error}
            </div>
          )}

          {entries.length > 0 && (
            <div className="bulk-summary">
              <span>
                <strong>{readyRows.length}</strong> row{readyRows.length === 1 ? "" : "s"} ready to add
              </span>
              {issues.length > 0 && (
                <span className="bulk-summary-issues">
                  {issues.length} row{issues.length === 1 ? "" : "s"} will be skipped
                </span>
              )}
              <span className="bulk-summary-hint">
                Use Edit to correct a cell or Delete to drop a row - both re-check the row before it is added.
              </span>
            </div>
          )}

          {issues.length > 0 && (
            <ul className="bulk-issue-list">
              {issues.slice(0, 6).map((issue) => (
                <li key={`${issue.row}-${issue.message}`}>
                  Row {issue.row}: {issue.message}
                </li>
              ))}
              {issues.length > 6 && <li>&hellip;and {issues.length - 6} more</li>}
            </ul>
          )}

          {entries.length > 0 && (
            <div className="bulk-preview">
              <table>
                <thead>
                  <tr>
                    <th className="bulk-index-head">S.No.</th>
                    {fields.map((field) => (
                      <th key={field.key}>{field.label}</th>
                    ))}
                    <th className="bulk-actions-head">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, 50).map((entry, index) => {
                    const editing = editingLine === entry.line;
                    return (
                      <tr
                        key={entry.line}
                        className={entry.problems.length ? "bulk-row-invalid" : editing ? "bulk-row-editing" : ""}
                      >
                        <td className="bulk-index" data-label="S.No.">
                          {index + 1}
                          {entry.problems.length > 0 && (
                            <AlertTriangle
                              size={13}
                              className="bulk-row-warning"
                              aria-label={entry.problems.join("; ")}
                            />
                          )}
                        </td>
                        {fields.map((field) => (
                          <td key={field.key} data-label={field.label}>
                            {editing ? (
                              <input
                                className="bulk-cell-input"
                                type={field.isNumber ? "number" : "text"}
                                value={entry.draft[field.key] ?? ""}
                                onChange={(event) =>
                                  updateEntry(entry.line, field.key, event.target.value)
                                }
                                aria-label={`${field.label} for row ${index + 1}`}
                              />
                            ) : (
                              fmtCell(entry.row[field.key], field)
                            )}
                          </td>
                        ))}
                        <td className="bulk-row-actions" data-label="Actions">
                          <button
                            type="button"
                            className="bulk-row-btn"
                            onClick={() => setEditingLine(editing ? null : entry.line)}
                            aria-label={editing ? `Done editing row ${index + 1}` : `Edit row ${index + 1}`}
                            title={editing ? "Done" : "Edit this row"}
                          >
                            {editing ? <Check size={14} /> : <Pencil size={14} />}
                          </button>
                          <button
                            type="button"
                            className="bulk-row-btn danger"
                            onClick={() => deleteEntry(entry.line)}
                            aria-label={`Delete row ${index + 1}`}
                            title="Remove this row"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {entries.length > 50 && (
                <p className="bulk-preview-hint">Showing the first 50 of {entries.length} rows.</p>
              )}
            </div>
          )}

          <p className="bulk-hint">
            Accepts .xlsx or .xls. Column names are matched loosely, so
            &ldquo;Item Code&rdquo;, &ldquo;item_code&rdquo; and &ldquo;ItemCode&rdquo; all work.
            {existingRows.length > 0
              ? ` The downloaded file already contains the current ${existingRows.length} ${existingRowLabel}${existingRows.length === 1 ? "" : "s"} - edit them and upload the file back to update them.`
              : ""}{" "}
            Use &ldquo;Export Excel template&rdquo; if you have not filled the file in yet.
          </p>
        </div>

        <footer className="bulk-footer">
          <button
            type="button"
            className="bulk-btn secondary"
            onClick={() => downloadTemplate({ fileName, columns, notes, dataRows: existingRows, dropdowns })}
          >
            <Download size={16} /> Export Excel template
          </button>
          <button
            type="button"
            className="bulk-btn primary"
            onClick={handleImport}
            disabled={!readyRows.length || busy}
          >
            <Upload size={16} /> {importLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
