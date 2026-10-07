import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import Swal from "sweetalert2";
import { Plus, X, Save, Loader2, RefreshCw, Trash2, Check, MoreVertical, Pencil, Upload, Download, ArrowLeft, FileText, GitBranch, AlertTriangle } from "lucide-react";
import * as XLSX from "xlsx";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import AttachmentsEditor, { attachmentsOf } from "../components/AttachmentsEditor";
import { applyColumnFormulas, applyDateColumnFormats, toDateCellDate } from "../components/BulkUploadModal";
import ImageStrip from "../components/ImageStrip";
import "../components/ImageAttachment.css";
import StatusDropdown from "../components/StatusDropdown";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import { fmtINR } from "../data/mockData";
import "./PODetails.css";
import "./Model.css";

// ---- Themed SweetAlert2 helpers (brand colors, shared across pages) ----
const swalConfirm = ({ title, text, confirmText = "Yes, delete it" }) =>
  Swal.fire({
    title,
    text,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: "Cancel",
    confirmButtonColor: "var(--accent)",
    cancelButtonColor: "var(--bg-surface-alt)",
    reverseButtons: true,
    focusCancel: true,
    customClass: {
      container: "po-swal-container",
      popup: "swal-vector-popup",
    },
  });

const swalSuccess = (title, text) =>
  Swal.fire({
    title,
    text,
    icon: "success",
    confirmButtonColor: "var(--accent)",
    timer: 2200,
    timerProgressBar: true,
    customClass: {
      container: "po-swal-container",
      popup: "swal-vector-popup",
    },
  });

const swalError = (title, text) =>
  Swal.fire({
    title,
    text,
    icon: "error",
    confirmButtonColor: "var(--accent)",
    customClass: {
      container: "po-swal-container",
      popup: "swal-vector-popup",
    },
  });

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

// The drill-down this tab was showing, kept across a browser refresh.
const DRILL_KEY = "vector_po_drill";
const readDrill = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null") || null;
  } catch {
    return null;
  }
};
const writeDrill = (key, value) => {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
};
const PAGE_SIZE = 10;

// GST rates differ per product, so every row carries its own percentage.
const formatGstRate = (value) =>
  value === null || value === undefined || String(value).trim() === ""
    ? ""
    : `${value}%`;

// Basic Price = Qty x Unit Rate.  Derived here rather than stored, so it stays
// correct even for rows saved before the column existed.
const poBasicPrice = (row) => {
  const qty = Number(row?.qty);
  const rate = Number(row?.rate);
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) return 0;
  return Math.round(qty * rate * 100) / 100;
};

const columns = [
  { key: "phase", label: "Phase" },
  { key: "po", label: "PO No", mono: true },
  { key: "supplier", label: "Supplier" },
  { key: "date", label: "PO Date", isDate: true },
  { key: "code", label: "Item Code", mono: true },
  { key: "desc", label: "Item Description" },
  { key: "qty", label: "Qty Ordered" },
  { key: "rate", label: "Unit Rate", format: fmtINR },
  { key: "gstRate", label: "GST %", format: formatGstRate },
  // Basic Price = Qty x Unit Rate, the pre-GST figure the row's GST sits on.
  { key: "basicPrice", label: "Basic Price", render: (row) => fmtINR(poBasicPrice(row)), format: (value, row) => fmtINR(poBasicPrice(row) || value) },
  { key: "gst", label: "GST Price", format: fmtINR },
  { key: "value", label: "Total incl. GST", format: fmtINR },
  { key: "status", label: "Status" },
];
const PO_FILTER_FIELDS = columns.filter((column) =>
  ["phase", "po", "supplier", "code", "status"].includes(column.key)
);

// Supplier names are shared across pages, so the list is fetched once and
// reused (same module-level cache BOQ uses).
let suppliersCache = null;
let suppliersRequest = null;

const STATUS_OPTIONS = [
  "Pending",
  "In Progress",
  "Approved",
  "Completed",
];

// ---- Excel bulk upload ------------------------------------------------
// Columns of the downloadable template.  Every one of them maps to a field
// the backend requires on POST /po-details, so a filled template is always
// a valid PO payload (GST / PO Value are recomputed server-side).
// Excel users type money as "1200", "1,200", "₹1,200", "1200/-" or paste
// text with non-breaking spaces; raw arithmetic on those strings gives
// #VALUE!.  excelNum cleans the cell text and returns a number (or "" when
// it cannot be parsed), and excelGst normalises the GST cell (18, 18% or
// 0.18 all mean 18%) with 18% as the default.
const excelNum = (token) =>
  `IFERROR(VALUE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${token}&"",UNICHAR(160),""),"₹",""),"INR",""),"Rs.",""),"Rs","")," ",""),",",""),"/-","")),"")`;
const excelGst = (token) => {
  const n = excelNum(token);
  return `IFERROR(IF(${n}>=1,${n}/100,${n}),0.18)`;
};
const BULK_COLUMNS = [
  { key: "phase", label: "Phase" },
  { key: "po", label: "PO No" },
  { key: "supplier", label: "Supplier" },
  { key: "date", label: "PO Date", isDate: true },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "qty", label: "Qty Ordered" },
  { key: "rate", label: "Unit Rate" },
  { key: "gstRate", label: "GST %" },
  // Basic Price / GST Price / Total incl. GST, calculated in Excel from Unit
  // Rate + GST % + Qty Ordered (blank GST means 18%) - the same three figures
  // the table and the cards show.  Hidden from the import preview and ignored
  // when the file is parsed.
  {
    key: "basicPrice",
    label: "Basic Price (INR)",
    required: false,
    hidden: true,
    formula: `IFERROR(IF(OR(${excelNum("{rate}")}="",${excelNum("{qty}")}=""),"",ROUND(${excelNum("{rate}")}*${excelNum("{qty}")},2)),"")`,
  },
  {
    key: "gstPrice",
    label: "GST Price (INR)",
    required: false,
    hidden: true,
    formula: `IFERROR(IF(${excelNum("{basicPrice}")}="","",ROUND(${excelNum("{basicPrice}")}*${excelGst("{gstRate}")},2)),"")`,
  },
  {
    key: "totalInclGst",
    label: "Total incl. GST (INR)",
    required: false,
    hidden: true,
    formula: `IFERROR(IF(${excelNum("{basicPrice}")}="","",ROUND(${excelNum("{basicPrice}")}+${excelNum("{gstPrice}")},2)),"")`,
  },
  { key: "expectedDeliveryDate", label: "Expected Delivery Date", isDate: true },
  { key: "status", label: "Status" },
];

// Optional columns: files saved before these columns existed still upload and
// simply fall back to the default GST slab / a blank supplier.  The three
// calculated columns are never required either - they are written by Excel.
const BULK_OPTIONAL_COLUMNS = new Set([
  "supplier",
  "gstRate",
  "basicPrice",
  "gstPrice",
  "totalInclGst",
]);

const BULK_COLUMN_NOTES = {
  phase: ["BOQ phase name exactly as shown in the app (e.g. phase-1).", "phase-1"],
  po: ["Purchase order number (e.g. PO-4521).", "PO-4521"],
  supplier: ["Supplier / vendor name for the PO. Optional.", "Steel Authority"],
  date: ["PO date. Click the cell for the date picker, or type 2026-08-20 (ISO works everywhere).", "2026-08-05"],
  code: ["BOQ item code (e.g. ITM-074).", "ITM-074"],
  desc: ["Description of the item being ordered.", "LED"],
  qty: ["Quantity ordered, numbers only.", "10"],
  rate: ["Price per unit, numbers only.", "7"],
  gstRate: ["GST percentage for this line, 0-100. Optional — blank means 18%.", "18"],
  basicPrice: [
    "Calculated automatically = Qty Ordered x Unit Rate (before GST). Do not type in this column.",
    "70",
  ],
  gstPrice: [
    "Calculated automatically = Basic Price x GST % (blank GST uses 18%). Do not type in this column.",
    "12.6",
  ],
  totalInclGst: [
    "Calculated automatically = Basic Price + GST Price. Do not type in this column.",
    "82.6",
  ],
  expectedDeliveryDate: [
    "Expected delivery date. Click the cell for the date picker, or type 2026-08-20 (ISO works everywhere).",
    "2026-08-20",
  ],
  status: [`One of: ${STATUS_OPTIONS.join(", ")}.`, "Pending"],
};

// Header cells are normalised (lower-case, letters/digits only) before they
// are matched, so "PO No.", "po no" and "PO_NUMBER" all resolve to `po`.
const BULK_HEADER_ALIASES = {
  phase: "phase",
  phasename: "phase",
  po: "po",
  pono: "po",
  ponumber: "po",
  purchaseorder: "po",
  purchaseorderno: "po",
  supplier: "supplier",
  suppliername: "supplier",
  vendorname: "supplier",
  vendor: "supplier",
  date: "date",
  podate: "date",
  code: "code",
  itemcode: "code",
  desc: "desc",
  description: "desc",
  itemdescription: "desc",
  qty: "qty",
  quantity: "qty",
  qtyordered: "qty",
  rate: "rate",
  unitrate: "rate",
  gst: "gstRate",
  gstrate: "gstRate",
  gstpercent: "gstRate",
  gstpercentage: "gstRate",
  gstslab: "gstRate",
  taxrate: "gstRate",
  // Files exported before the Basic Price / GST Price / Total rename still
  // carry the old calculated headers; they are ignored on import either way.
  basicprice: "basicPrice",
  gstprice: "gstPrice",
  materialcost: "totalInclGst",
  materialcostunit: "totalInclGst",
  materialcostinr: "totalInclGst",
  materialcostinclgst: "totalInclGst",
  linecost: "totalInclGst",
  totalforqtyinclgst: "totalInclGst",
  totalinclg: "totalInclGst",
  total: "totalInclGst",
  expecteddelivery: "expectedDeliveryDate",
  expecteddeliverydate: "expectedDeliveryDate",
  deliverydate: "expectedDeliveryDate",
  status: "status",
};

const BULK_FILE_NAME = "po-details-template.xlsx";

function normalizeHeader(cell) {
  return String(cell ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  // Round-trip through a real Date so values like 31-02-2026 are rejected.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Accepts Date objects (Excel date cells), Excel serial numbers and the text
 * formats the app itself renders (DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY...).
 * Returns "YYYY-MM-DD" or null when the value cannot be read as a date.
 */
function parseBulkDate(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 1 || value > 2958465) return null;
    const asUtc = new Date(Math.round((value - 25569) * 86400000));
    if (Number.isNaN(asUtc.getTime())) return null;
    return `${asUtc.getUTCFullYear()}-${pad2(asUtc.getUTCMonth() + 1)}-${pad2(asUtc.getUTCDate())}`;
  }

  const text = String(value).trim();

  let parts = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (parts) return toIsoDate(parts[1], parts[2], parts[3]);

  parts = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (parts) {
    let day = Number(parts[1]);
    let month = Number(parts[2]);
    // The app renders dates as DD-MM-YYYY, but fall back to MM-DD-YYYY when
    // the value only makes sense that way (e.g. 05-13-2026).
    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }
    return toIsoDate(parts[3], month, day);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  }
  return null;
}

function findBulkHeaderRow(matrix) {
  const scanLimit = Math.min(matrix.length, 10);
  let bestIndex = -1;
  let bestHits = 0;

  for (let index = 0; index < scanLimit; index += 1) {
    const hits = (matrix[index] || []).filter(
      (cell) => BULK_HEADER_ALIASES[normalizeHeader(cell)]
    ).length;
    if (hits >= 6) return index;
    if (hits > bestHits) {
      bestHits = hits;
      bestIndex = index;
    }
  }

  // A partially correct header (e.g. the user deleted a column) still beats
  // a generic "no header row" error: parsing it reports exactly which
  // columns are missing.
  return bestHits >= 2 ? bestIndex : -1;
}

function normalizeBulkRow(draft) {
  const problems = [];
  const text = {};

  BULK_COLUMNS.forEach((column) => {
    const raw = draft[column.key];
    text[column.key] = raw === null || raw === undefined ? "" : String(raw).trim();
  });

  ["phase", "po", "code", "desc", "status"].forEach((key) => {
    if (!text[key]) {
      const column = BULK_COLUMNS.find((item) => item.key === key);
      problems.push(`${column.label} is empty`);
    }
  });

  const date = parseBulkDate(draft.date);
  if (!text.date) problems.push("PO Date is empty");
  else if (!date) problems.push("PO Date is not a valid date");

  const expectedDeliveryDate = parseBulkDate(draft.expectedDeliveryDate);
  if (!text.expectedDeliveryDate) problems.push("Expected Delivery Date is empty");
  else if (!expectedDeliveryDate) problems.push("Expected Delivery Date is not a valid date");

  const readNumber = (key) => {
    const column = BULK_COLUMNS.find((item) => item.key === key);
    if (!text[key]) {
      problems.push(`${column.label} is empty`);
      return null;
    }
    const parsed = Number(text[key].replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
      problems.push(`${column.label} must be a number`);
      return null;
    }
    return parsed;
  };

  const qty = readNumber("qty");
  const rate = readNumber("rate");

  let gstRate = null;
  if (text.gstRate) {
    const parsed = Number(text.gstRate.replace(/,/g, "").replace(/%$/, ""));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      problems.push("GST % must be a number between 0 and 100");
    } else {
      gstRate = parsed;
    }
  }

  const status =
    STATUS_OPTIONS.find((option) => option.toLowerCase() === text.status.toLowerCase()) ||
    text.status;

  return {
    row: {
      phase: text.phase,
      po: text.po,
      supplier: text.supplier,
      date: date || text.date,
      code: text.code,
      desc: text.desc,
      qty: qty === null ? text.qty : qty,
      rate: rate === null ? text.rate : rate,
      ...(gstRate === null ? {} : { gstRate }),
      expectedDeliveryDate: expectedDeliveryDate || text.expectedDeliveryDate,
      status,
    },
    problems,
  };
}

function readBulkWorkbook(file) {
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
      } catch (err) {
        reject(new Error("This file could not be read. Please upload a valid .xlsx, .xls or .csv file."));
      }
    };

    reader.onerror = () => reject(new Error("Unable to read the selected file."));

    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

/** Parse the first worksheet into `{ rows, issues }`. */
function parseBulkWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The selected file has no readable sheet.");

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

  const headerIndex = findBulkHeaderRow(matrix);
  if (headerIndex === -1) {
    throw new Error(
      `No header row found. The file must start with these columns: ${BULK_COLUMNS
        .map((column) => column.label)
        .join(", ")}.`
    );
  }

  const columnMap = {};
  (matrix[headerIndex] || []).forEach((cell, columnIndex) => {
    const key = BULK_HEADER_ALIASES[normalizeHeader(cell)];
    if (key && columnMap[key] === undefined) columnMap[key] = columnIndex;
  });

  const missingHeaders = BULK_COLUMNS.filter(
    (column) => !BULK_OPTIONAL_COLUMNS.has(column.key) && columnMap[column.key] === undefined
  ).map((column) => column.label);
  if (missingHeaders.length) {
    throw new Error(`Missing column(s): ${missingHeaders.join(", ")}.`);
  }

const rows = [];
    const issues = [];
    const entries = [];

    for (let index = headerIndex + 1; index < matrix.length; index += 1) {
      const raw = matrix[index] || [];
      if (raw.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")) {
        continue;
      }

      const draft = {};
      BULK_COLUMNS.forEach((column) => {
        draft[column.key] = raw[columnMap[column.key]];
      });

      const { row, problems } = normalizeBulkRow(draft);
      // Every data row is kept, problems included: the preview can correct a
      // bad row instead of dropping it.
      entries.push({ line: index + 1, draft, row, problems });
      if (problems.length) issues.push({ row: index + 1, message: problems.join("; ") });
      else rows.push(row);
    }

  if (!rows.length && !issues.length) {
    throw new Error("No data rows were found below the header row.");
  }

  return { rows, issues, entries };
}


const PO_DETAIL_FIELDS = [
  { key: "phase", label: "Phase" },
  { key: "po", label: "PO No", editable: true },
  { key: "supplier", label: "Supplier", editable: true, isSupplier: true },
  { key: "date", label: "PO Date", isDate: true, editable: true },
  { key: "code", label: "Item Code" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "desc", label: "Item Description", wide: true },
  { key: "qty", label: "Qty Ordered", editable: true, isNumber: true },
  { key: "rate", label: "Unit Rate", isCurrency: true, editable: true, isNumber: true },
  { key: "gstRate", label: "GST %", editable: true, isNumber: true, isPercent: true },
  { key: "basicPrice", label: "Basic Price", isCurrency: true },
  { key: "gst", label: "GST Price", isCurrency: true },
  { key: "value", label: "Total incl. GST", isCurrency: true },
  { key: "status", label: "Status", editable: true, isStatus: true },
];

const DELIVERY_DETAIL_FIELDS = [
  { key: "expectedDeliveryDate", label: "Expected Delivery Date", isDate: true, editable: true },
];

const emptyPoForm = {
  phase: "",
  modelId: "",
  phaseId: "",
  po: "",
  supplier: "",
  date: "",
  code: "",
  make: "",
  model: "",
  desc: "",
  qty: "",
  rate: "",
  gstRate: "18",
  expectedDeliveryDate: "",
  status: "",
  attachments: [],
};

// A PO commonly contains more than one item.  Retain its shared details
// while clearing the item-specific fields for the next entry.
const nextPoLineForm = (values) => ({
  ...emptyPoForm,
  modelId: values.modelId,
  phaseId: values.phaseId,
  phase: values.phase,
  po: values.po,
  supplier: values.supplier,
  date: values.date,
  gstRate: values.gstRate || emptyPoForm.gstRate,
  expectedDeliveryDate: values.expectedDeliveryDate,
  status: values.status,
  // Attachments belong to a single line, so the next one starts without any.
  attachments: [],
});

const REQUIRED_FIELDS = [
  { name: "phase", label: "Phase" },
  { name: "po", label: "PO No" },
  { name: "date", label: "PO Date" },
  { name: "code", label: "Item Code" },
  { name: "desc", label: "Item Description" },
  { name: "qty", label: "Qty Ordered" },
  { name: "rate", label: "Unit Rate" },
  { name: "expectedDeliveryDate", label: "Expected Delivery Date" },
  { name: "status", label: "Status" },
];

function validatePoForm(values) {
  const missing = REQUIRED_FIELDS.filter(
    ({ name }) => !String(values[name] ?? "").trim()
  );

  if (missing.length) {
    return `Please fill in: ${missing.map((field) => field.label).join(", ")}.`;
  }

  if (values.qty && Number.isNaN(Number(values.qty))) {
    return "Qty Ordered must be a number.";
  }

  if (values.rate && Number.isNaN(Number(values.rate))) {
    return "Unit Rate must be a number.";
  }

  if (String(values.gstRate ?? "").trim() !== "") {
    const gstRate = Number(values.gstRate);
    if (!Number.isFinite(gstRate)) return "GST % must be a number.";
    if (gstRate < 0 || gstRate > 100) return "GST % must be between 0 and 100.";
  }

  return null;
}

function formatDateDisplay(value) {
  return formatDate(value, "Not Provided");
}

function toDateInputValue(value) {
  if (!value) return "";
  const str = String(value);
  return str.length >= 10 ? str.slice(0, 10) : str;
}

function formatDetailValue(field, row) {
        // Basic Price is derived, never stored on the record.
        if (field.key === "basicPrice") return fmtINR(poBasicPrice(row));
        const raw = row[field.key];
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return "Not Provided";
  }
  if (field.isDate) return formatDateDisplay(raw);
  if (field.isCurrency) return fmtINR(raw);
  if (field.isPercent) return `${raw}%`;
  return String(raw);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

function extractErrorMessage(err, fallback) {
  if (err?.response?.data?.message) return err.response.data.message;
  if (err?.message === "Network Error") {
    return "Can't reach the server. Please check your connection and try again.";
  }
  if (err?.code === "ECONNABORTED") {
    return "The request timed out. Please try again.";
  }
  return err?.message || fallback;
}

function getRowId(row) {
  return row?._id || row?.id || null;
}

function buildEditForm(row) {
  return {
    po: row.po ?? "",
    supplier: row.supplier ?? "",
    date: toDateInputValue(row.date),
    qty: row.qty ?? "",
    rate: row.rate ?? "",
    gstRate: row.gstRate ?? "",
    status: row.status || "",
    expectedDeliveryDate: toDateInputValue(row.expectedDeliveryDate),
    attachments: attachmentsOf(row),
  };
}

// Edit shows one item block per line, like the Add form, so the line's own
// fields live in a draft instead of the flat edit form above.
function buildEditLineDraft(row) {
  return {
    id: getRowId(row) || null,
    code: row?.code ?? "",
    make: row?.make ?? "",
    model: row?.model ?? "",
    desc: row?.desc ?? "",
    qty: row?.qty ?? "",
    rate: row?.rate ?? "",
    gstRate: row?.gstRate ?? "",
    status: row?.status || "",
    expectedDeliveryDate: toDateInputValue(row?.expectedDeliveryDate),
  };
}

const emptyEditLineDraft = {
  id: null,
  code: "",
  make: "",
  model: "",
  desc: "",
  qty: "",
  rate: "",
  gstRate: "",
  status: "",
  expectedDeliveryDate: "",
};

// One item block has to satisfy the same rules the Add form enforces on a line.
function validateEditLine(draft, label) {
  if (!String(draft.code ?? "").trim()) return `${label}: Item Code cannot be empty.`;
  if (!String(draft.desc ?? "").trim()) return `${label}: Item Description cannot be empty.`;
  if (!String(draft.qty ?? "").trim()) return `${label}: Qty Ordered cannot be empty.`;
  if (Number.isNaN(Number(draft.qty))) return `${label}: Qty Ordered must be a number.`;
  if (!String(draft.rate ?? "").trim()) return `${label}: Unit Rate cannot be empty.`;
  if (Number.isNaN(Number(draft.rate))) return `${label}: Unit Rate must be a number.`;
  if (String(draft.gstRate ?? "").trim() !== "") {
    const gstRate = Number(draft.gstRate);
    if (!Number.isFinite(gstRate)) return `${label}: GST % must be a number.`;
    if (gstRate < 0 || gstRate > 100) return `${label}: GST % must be between 0 and 100.`;
  }
  if (!String(draft.expectedDeliveryDate ?? "").trim()) {
    return `${label}: Expected Delivery Date cannot be empty.`;
  }
  if (!String(draft.status ?? "").trim()) return `${label}: Status cannot be empty.`;
  return null;
}

function calculatePoAmounts(qty, rate, gstRate = "") {
  if (String(qty ?? "").trim() === "" || String(rate ?? "").trim() === "") {
    return null;
  }

  const numericQty = Number(qty);
  const numericRate = Number(rate);
  if (!Number.isFinite(numericQty) || !Number.isFinite(numericRate)) return null;

  // Blank rate falls back to the default GST slab the form starts with.
  const numericGstRate =
    String(gstRate ?? "").trim() === "" ? 18 : Number(gstRate);
  if (!Number.isFinite(numericGstRate)) return null;

  const subtotal = numericQty * numericRate;
  const gst = Math.round(subtotal * numericGstRate) / 100;
  return { gst, value: Math.round((subtotal + gst) * 100) / 100 };
}

export default function PODetails() {
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);

  // Card drill-down, mirroring Models -> Phases -> table:
  // PO cards first, then the phases inside one PO, then the line-item table.
  const [phaseCards, setPhaseCards] = useState([]);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsError, setCardsError] = useState("");
  // A refresh must land on the same drill-down: phase cards -> PO cards ->
  // table, so the selection lives in this tab's sessionStorage.
  const [selectedPo, setSelectedPo] = useState(() => readDrill(DRILL_KEY)?.po ?? null);
  const [selectedPhase, setSelectedPhase] = useState(() => readDrill(DRILL_KEY)?.phase ?? null);

  useEffect(() => {
    writeDrill(
      DRILL_KEY,
      selectedPo || selectedPhase ? { po: selectedPo, phase: selectedPhase } : null
    );
  }, [selectedPo, selectedPhase]);

  // Clicking "PO Details" in the sidebar re-opens the phase card grid.
  useEffect(() => {
    const resetDrill = () => {
      setSelectedPo(null);
      setSelectedPhase(null);
    };
    window.addEventListener("vector:po-reset", resetDrill);
    return () => window.removeEventListener("vector:po-reset", resetDrill);
  }, []);

  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPoValue, setTotalPoValue] = useState(0);
  const [totalPoValueExclGst, setTotalPoValueExclGst] = useState(0);
  const [totalPoGst, setTotalPoGst] = useState(0);
  const [filterOptions, setFilterOptions] = useState({});

  const [modalOpen, setModalOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyPoForm);
  const [itemDrafts, setItemDrafts] = useState([]);
  // One set of files for the whole PO, stored on the PO record itself.
  const [poAttachments, setPoAttachments] = useState([]);
  const lastItemRef = useRef(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const [boqPhases, setBoqPhases] = useState([]);
  const [boqPhasesLoading, setBoqPhasesLoading] = useState(false);
  const [boqPhasesError, setBoqPhasesError] = useState("");

  const [boqItems, setBoqItems] = useState([]);
  const [boqItemsLoading, setBoqItemsLoading] = useState(false);
  const [boqItemsError, setBoqItemsError] = useState("");

  const [suppliers, setSuppliers] = useState([]);

  const [detailsRow, setDetailsRow] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsClosing, setDetailsClosing] = useState(false);

  const [detailsEditMode, setDetailsEditMode] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  // Edit mirrors the Add form: the PO header in `editForm`, one item block per
  // line below it.
  const [detailsItemDrafts, setDetailsItemDrafts] = useState([]);
  const detailsInitialDraftsRef = useRef([]);
  const detailsLastItemRef = useRef(null);

  const previewDetailsRow = useMemo(() => {
    if (!detailsRow || !detailsEditMode) return detailsRow;

    const totals = calculatePoAmounts(editForm.qty, editForm.rate, editForm.gstRate);
    return {
      ...detailsRow,
      qty: editForm.qty,
      rate: editForm.rate,
      gstRate: editForm.gstRate,
      ...(totals || {}),
    };
  }, [detailsRow, detailsEditMode, editForm.qty, editForm.rate, editForm.gstRate]);

  const [updatingStatusId, setUpdatingStatusId] = useState(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadClosing, setUploadClosing] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  // One entry per spreadsheet row (raw draft + what normalizeBulkRow made of
  // it), so the preview can correct or drop a row before it is uploaded.  The
  // ready rows and the issue list are both derived from it.
  const [uploadEntries, setUploadEntries] = useState([]);
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const openDetails = (row) => {
    setDetailsRow(row);
    setEditForm(buildEditForm(row));
    setDetailsEditMode(false);
    setDetailsError("");
    setDetailsClosing(false);
    setDetailsOpen(true);

    // List rows only advertise that files exist; pull them for the modal so the
    // preview is there and saving the form cannot drop what it did not load.
    if (row?.hasImage && row?.id) {
      api
        .get(`${API_BASE_URL}/po-details/${row.id}`)
        .then((res) => {
          if (!res.data?.success) return;
          const files = attachmentsOf(res.data.po);
          if (!files.length) return;
          setDetailsRow((current) =>
            current && current.id === row.id ? { ...current, attachments: files } : current
          );
          setEditForm((current) => ({ ...current, attachments: files }));
        })
        .catch(() => {
          /* attachments are optional; the rest of the modal still works */
        });
    }
  };

  const closeDetails = useCallback(() => {
    if (detailsClosing) return;
    setDetailsClosing(true);
    setTimeout(() => {
      setDetailsOpen(false);
      setDetailsClosing(false);
      setDetailsRow(null);
      setEditForm({});
      setDetailsItemDrafts([]);
      detailsInitialDraftsRef.current = [];
      setDetailsEditMode(false);
      setDetailsError("");
    }, 200);
  }, [detailsClosing]);

  const requestCloseDetails = useCallback(async () => {
    if (detailsClosing) return;
    const dirty =
      detailsEditMode &&
      (JSON.stringify(editForm) !== JSON.stringify(buildEditForm(detailsRow)) ||
        JSON.stringify(detailsItemDrafts) !== JSON.stringify(detailsInitialDraftsRef.current));
    if (dirty) {
      const result = await Swal.fire({ title: "Discard unsaved changes?", text: "Your PO Detail changes will be lost unless you save them.", icon: "warning", showCancelButton: true, confirmButtonText: "Discard changes", cancelButtonText: "Keep editing", reverseButtons: true, customClass: { popup: "swal-vector-popup" } });
      if (!result.isConfirmed) return;
    }
    closeDetails();
  }, [detailsClosing, detailsEditMode, editForm, detailsItemDrafts, detailsRow, closeDetails]);

  useEffect(() => {
    if (!detailsOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") {
        if (detailsEditMode) {
          setDetailsEditMode(false);
          setEditForm(buildEditForm(detailsRow));
          setDetailsItemDrafts([]);
          detailsInitialDraftsRef.current = [];
          setDetailsError("");
        } else {
          requestCloseDetails();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [detailsOpen, detailsEditMode, detailsRow, requestCloseDetails]);

  // The phase grid (one card per phase) that opens the drill-down.
  const fetchPhaseCards = useCallback(async () => {
    setCardsLoading(true);
    setCardsError("");
    try {
      const res = await api.get(`${API_BASE_URL}/po-details/groups`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load phase cards");
      }
      setPhaseCards(res.data.phases || []);
    } catch (err) {
      setCardsError(extractErrorMessage(err, "Failed to load phase cards."));
    } finally {
      setCardsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPhaseCards();
  }, [fetchPhaseCards]);

  // Supplier suggestions for the PO form; the field still accepts a typed
  // supplier when the list cannot load.
  useEffect(() => {
    let cancelled = false;
    const loadSuppliers = async () => {
      try {
        if (!suppliersCache) {
          suppliersRequest ||= api
            .get(`${API_BASE_URL}/suppliers`, { __vectorBackground: true })
            .then((response) => {
              if (!response.data.success) {
                throw new Error(response.data.message || "Failed to load suppliers");
              }
              suppliersCache = response.data.suppliers || [];
              return suppliersCache;
            })
            .finally(() => {
              suppliersRequest = null;
            });
          await suppliersRequest;
        }
        if (!cancelled) setSuppliers(suppliersCache || []);
      } catch {
        // ignore - the select still accepts custom values
      }
    };
    loadSuppliers();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPoDetails = useCallback(async ({ silent = false, targetPage } = {}) => {
    // Line items only exist once a PO card and a phase card were opened.
    if (!selectedPo || !selectedPhase) return;
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;
    try {
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);

      // Card scope first, then the toolbar's PageFilter.  The API accepts
      // repeated filterField/filterValue pairs and matches them ignoring case,
      // so `po-12` / `PO-12` and `pending` / `Pending` behave the same.
      const pairs = [
        ["po", selectedPo],
        ["phase", selectedPhase],
      ];
      if (pageFilter.field && pageFilter.value !== "") {
        pairs.push([pageFilter.field, String(pageFilter.value)]);
      }
      pairs.forEach(([field, value]) => {
        params.append("filterField", field);
        params.append("filterValue", value);
      });

      const res = await api.get(`${API_BASE_URL}/po-details?${params.toString()}`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load PO Details");
      }
      setRows(res.data.poDetails || []);

      // Server-computed over the whole filtered set, so the badge always
      // matches the card scope plus whatever the search box/PageFilter select.
      setTotalPoValue(Number(res.data.totals?.poValue) || 0);
      setTotalPoValueExclGst(Number(res.data.totals?.poValueExclGst) || 0);
      setTotalPoGst(Number(res.data.totals?.poGst) || 0);
      setFilterOptions(res.data.filterOptions || {});

      const pagination = res.data.pagination;
      if (pagination) {
        setTotalPages(pagination.totalPages || 1);
        setTotalCount(pagination.totalCount || 0);
        if (pagination.page !== pageToFetch) setPage(pagination.page);
      }
    } catch (err) {
      setRowsError(extractErrorMessage(err, "Failed to load PO Details."));
    } finally {
      if (!silent) setRowsLoading(false);
    }
  }, [page, pageSize, query, pageFilter, selectedPo, selectedPhase]);

  // Scope (PO card / phase card) and toolbar filters both come from the API,
  // so changing either restarts at page 1 instead of showing an empty page.
  const filterKey = `${query.trim()}|${pageFilter.field || ""}|${pageFilter.value ?? ""}`;
  const scopeKey = `${selectedPo || ""}::${selectedPhase || ""}`;
  const prevFilterKeyRef = useRef(filterKey);
  const prevScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    const scopeChanged = prevScopeKeyRef.current !== scopeKey;
    prevScopeKeyRef.current = scopeKey;
    const filtersChanged = prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;

    if (!selectedPo || !selectedPhase) return;

    const restarting = scopeChanged || filtersChanged;
    if (restarting && page !== 1) {
      setPage(1);
      return;
    }
    fetchPoDetails({ targetPage: restarting ? 1 : page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filterKey, scopeKey]);

  // Mutations refresh the phase cards, and the table too when it is open.
  const refreshData = useCallback(async (opts) => {
    await fetchPhaseCards();
    if (selectedPo && selectedPhase && opts) await fetchPoDetails(opts);

    // An open details modal holds its own copy of the record, so a file deleted
    // from the attachment manager would otherwise still be listed there.
    if (detailsOpen && detailsRow?.id && !detailsEditMode) {
      try {
        const res = await api.get(`${API_BASE_URL}/po-details/${detailsRow.id}`);
        if (res.data?.success) {
          setDetailsRow(res.data.po);
          setEditForm(buildEditForm(res.data.po));
        }
      } catch {
        /* the modal keeps its copy if the refresh fails */
      }
    }
  }, [fetchPhaseCards, fetchPoDetails, selectedPo, selectedPhase, detailsOpen, detailsRow, detailsEditMode]);

  // A save anywhere on this scope arrives as a WebSocket notice: refresh the
  // phase cards and, when a drill-down is open, the table beneath it.  Nothing
  // runs while a form is open, so a background change never yanks rows away.
  useRealtime(["po_details"], () => refreshData({ silent: true }), {
    guard: () => !(modalOpen || detailsEditMode || detailsSaving),
  });

  const resetFilters = () => {
    setQuery("");
    setPageFilter({ field: "", value: "" });
    setPage(1);
    setSelectMode(false);
    setSelectedIds(new Set());
    setMenuOpen(false);
  };

  // Drill-down order: phase -> PO -> line items, so opening a PO keeps the
  // phase it belongs to as the scope.
  const openPhase = (phase) => {
    setSelectedPhase(phase);
    setSelectedPo(null);
    resetFilters();
  };

  const openPo = (po) => {
    setSelectedPo(po);
    resetFilters();
  };

  // From the line-item table back to the PO list of the current phase.
  const backFromPo = () => {
    setSelectedPo(null);
    resetFilters();
  };

  // From the PO list back to every phase.
  const backFromPhase = () => {
    setSelectedPo(null);
    setSelectedPhase(null);
    resetFilters();
  };

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const loadBoqPhases = useCallback(async () => {
    setBoqPhasesLoading(true);
    setBoqPhasesError("");
    try {
      const [phaseRes, modelRes] = await Promise.all([
        api.get(`${API_BASE_URL}/boq/phases`, { __vectorBackground: true }),
        api.get(`${API_BASE_URL}/models`, { __vectorBackground: true }),
      ]);
      if (!phaseRes.data.success) {
        throw new Error(phaseRes.data.message || "Failed to load phases");
      }
      if (!modelRes.data.success) {
        throw new Error(modelRes.data.message || "Failed to load models");
      }
      const activeModelIds = new Set((modelRes.data.models || []).map((model) => model.id));
      const phases = (phaseRes.data.phases || []).filter((phase) => activeModelIds.has(phase.modelId));
      setBoqPhases(phases);
      return phases;
    } catch (err) {
      setBoqPhasesError(extractErrorMessage(err, "Failed to load phases"));
      return [];
    } finally {
      setBoqPhasesLoading(false);
    }
  }, []);

  // Both the Create PO modal and the Excel upload modal need the phase list.
  useEffect(() => {
    if (!modalOpen && !uploadOpen) return;
    loadBoqPhases();
  }, [modalOpen, uploadOpen, loadBoqPhases]);

  const getBoqItems = useCallback(async (modelId, phaseId) => {
    const res = await api.get(
      `${API_BASE_URL}/models/${modelId}/phases/${phaseId}/boq`,
      { __vectorBackground: true }
    );
    if (!res.data.success) {
      throw new Error(res.data.message || "Failed to load BOQ items");
    }
    // The BOQ endpoint paginates `rows` for tables but also returns the
    // complete list in `allRows`. Item-code selection must use every BOQ
    // item in the selected phase, not just the first page (10 by default).
    return res.data.boq?.allRows || res.data.boq?.rows || [];
  }, []);

  const fetchBoqItems = useCallback(async (modelId, phaseId) => {
    setBoqItemsLoading(true);
    setBoqItemsError("");
    setBoqItems([]);
    try {
      setBoqItems(await getBoqItems(modelId, phaseId));
    } catch (err) {
      setBoqItemsError(extractErrorMessage(err, "Failed to load BOQ items"));
      setBoqItems([]);
    } finally {
      setBoqItemsLoading(false);
    }
  }, [getBoqItems]);

  const phaseOptions = useMemo(
    () =>
      boqPhases.map((p) => ({
        value: `${p.modelId}::${p.phaseId}`,
        label: p.modelName ? `${p.modelName} — ${p.phaseName}` : p.phaseName,
      })),
    [boqPhases]
  );

  const itemCodeOptions = useMemo(
    () =>
      boqItems
        .filter((item) => item.code)
        .map((item) => ({
          value: item.code,
          label: item.desc ? `${item.code} — ${item.desc}` : item.code,
        })),
    [boqItems]
  );

  const handlePhaseSelect = (compositeValue) => {
    const found = boqPhases.find(
      (p) => `${p.modelId}::${p.phaseId}` === compositeValue
    );

    setFormError("");

    // A different phase means different BOQ items, so any item blocks already
    // added are cleared - their item codes would not exist in the new phase.
    setItemDrafts([]);

    // The files belonged to that other phase's PO, so they go as well.
    setPoAttachments([]);

    setFormValues((prev) => ({
      ...prev,
      phase: found ? found.phaseName : "",
      modelId: found ? found.modelId : "",
      phaseId: found ? found.phaseId : "",
    }));

    setBoqItems([]);
    setBoqItemsError("");

    if (found) {
      fetchBoqItems(found.modelId, found.phaseId);
    }
  };

  const handleItemCodeSelect = (index, code) => {
    const found = boqItems.find((item) => item.code === code);
    setFormError("");
    // A BOQ line without its own GST slab falls back to the 18% default.
    const boqGstRate =
      found?.gstRate === null || found?.gstRate === undefined || String(found.gstRate).trim() === ""
        ? "18"
        : found.gstRate;
    setItemDrafts((previous) =>
      previous.map((draft, position) =>
        position === index
          ? {
              ...draft,
              code,
              // The BOQ item carries the approved make, model, description,
              // GST slab and rate, so they land on the line and stay editable.
              make: found?.make || "",
              model: found?.model || "",
              desc: found?.desc || "",
              gstRate: boqGstRate,
              rate: found?.rate ?? "",
            }
          : draft
      )
    );
    // First item picked also fills an empty supplier, since one PO usually has
    // a single vendor.
    const boqSupplier = found?.vendor || found?.supplier || "";
    if (boqSupplier) {
      setFormValues((prev) => (prev.supplier ? prev : { ...prev, supplier: boqSupplier }));
    }
  };

  // Case-insensitive field filter: users type "pending" or "Pending" freely.
  // The API applies the same rule, so this local pass stays a safe double-check.
  const matchesPoPageFilter = (row, filter) => {
    if (!filter?.field || filter.value === "") return true;
    const field = PO_FILTER_FIELDS.find((item) => item.key === filter.field);
    if (!field) return true;
    return (
      String(row[field.key] ?? "").trim().toLowerCase() ===
      String(filter.value).trim().toLowerCase()
    );
  };

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPoPageFilter(row, pageFilter);
    });
  }, [query, rows, pageFilter]);

  // PageFilter builds its value dropdown from `rows`, which are now filtered
  // server-side.  Feed it one synthetic row per distinct value (from the API's
  // whole-collection `filterOptions`) so the list never shrinks while filtered.
  const filterOptionRows = useMemo(
    () =>
      PO_FILTER_FIELDS.flatMap((field) =>
        (filterOptions[field.key] || []).map((value) => ({ [field.key]: value }))
      ),
    [filterOptions]
  );

  const openModal = () => {
    setFormValues(emptyPoForm);
    setItemDrafts([]);
    setPoAttachments([]);
    setFormError("");
    setClosing(false);
    setBoqItems([]);
    setBoqItemsError("");
    setModalOpen(true);
    setMenuOpen(false);
  };

  const requestClose = (skipConfirmation = false) => {
    if (closing) return;
    const touched =
      JSON.stringify(formValues) !== JSON.stringify(emptyPoForm) ||
      itemDrafts.length > 0 ||
      poAttachments.length > 0;
    if (skipConfirmation !== true && touched) {
      Swal.fire({ title: "Discard unsaved changes?", text: "Your PO Detail changes will be lost unless you save them.", icon: "warning", showCancelButton: true, confirmButtonText: "Discard changes", cancelButtonText: "Keep editing", confirmButtonColor: "var(--accent)", cancelButtonColor: "var(--bg-surface-alt)", reverseButtons: true, focusCancel: true, customClass: { popup: "swal-vector-popup" } })
        .then((result) => { if (result.isConfirmed) closeModal(); });
      return;
    }
    closeModal();
  };

  const closeModal = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      setModalOpen(false);
      setClosing(false);
      setFormValues(emptyPoForm);
      setItemDrafts([]);
      setPoAttachments([]);
      setFormError("");
      setBoqItems([]);
      setBoqItemsError("");
    }, 220);
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    // Editing clears a stale "cannot save yet" banner instead of leaving it
    // sitting above fields that are already correct.
    setFormError("");
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  // ---------- Item blocks (one per PO line, added on demand) ----------

  const addItemDraft = () => {
    // Seeded from the current header so the new block is not full of empty
    // header values; the header still wins at save time.
    setItemDrafts((previous) => [
      ...previous,
      nextPoLineForm({ ...formValues, gstRate: "18" }),
    ]);
    // Bring the new block into view; the form is the scroll container.  "start"
    // puts the whole new item on screen instead of only its top edge, which is
    // what "nearest" did on short viewports.
    window.requestAnimationFrame(() => {
      lastItemRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  const removeItemDraft = (index) => {
    setItemDrafts((previous) => previous.filter((_, position) => position !== index));
  };

  // The field name is passed explicitly: the inputs use indexed `name`
  // attributes (qty-0) which must not leak into the stored draft.
  const handleItemChange = (index, field, value) => {
    setFormError("");
    setItemDrafts((previous) =>
      previous.map((draft, position) => (position === index ? { ...draft, [field]: value } : draft))
    );
  };

  const handleItemDateChange = (index, field, value) => {
    setFormError("");
    setItemDrafts((previous) =>
      previous.map((draft, position) => (position === index ? { ...draft, [field]: value } : draft))
    );
  };

  const itemTotals = (draft) => calculatePoAmounts(draft?.qty, draft?.rate, draft?.gstRate);

  const itemSubtotal = (draft, totals) =>
    totals ? Math.round(Number(draft.qty) * Number(draft.rate) * 100) / 100 : null;

  // A save attempt that cannot go through has to say why, in a popup: the
  // inline error sits at the top of a long scrolling form, so it is easy to
  // never see and the click looks like it did nothing.
  const reportSaveBlocked = (message) => {
    setFormError(message);
    Swal.fire({
      title: "Cannot save yet",
      text: message,
      icon: "warning",
      confirmButtonText: "OK",
      confirmButtonColor: "var(--accent)",
      customClass: { popup: "swal-vector-popup" },
    });
  };

  const handleSave = async (startAnother = false) => {
    if (saving) return;

    if (!itemDrafts.length) {
      reportSaveBlocked('Add at least one item with the "Add item" button in the header.');
      return;
    }

    // Every line carries the PO header plus its own item fields.  The header is
    // merged last, on purpose: a draft created before the header was filled in
    // holds empty `phase`/`po`/`date` keys, and letting those win wiped the
    // header out of every line.
    const header = {
      phase: formValues.phase,
      modelId: formValues.modelId,
      phaseId: formValues.phaseId,
      po: formValues.po,
      supplier: formValues.supplier,
      date: formValues.date,
    };
    const lines = itemDrafts.map((draft) => ({ ...draft, ...header }));
    for (let index = 0; index < lines.length; index += 1) {
      const error = validatePoForm(lines[index]);
      if (error) {
        reportSaveBlocked(`Item ${index + 1}: ${error}`);
        return;
      }
    }

    setSaving(true);
    setFormError("");

    try {
      for (const line of lines) {
        const res = await api.post(`${API_BASE_URL}/po-details`, {
          ...line,
          status: line.status || null,
        });
        if (!res.data.success) {
          throw new Error(res.data.message || "Failed to save PO Detail");
        }
      }

      // The PO's files are stored once on the PO itself, not on every item line.
      if (poAttachments.length) {
        const headerRes = await api.post(`${API_BASE_URL}/po-details/header`, {
          modelId: formValues.modelId,
          phaseId: formValues.phaseId,
          phase: formValues.phase,
          po: formValues.po,
          date: formValues.date,
          supplier: formValues.supplier,
          attachments: poAttachments,
        });
        if (!headerRes.data.success) {
          throw new Error(headerRes.data.message || "Failed to save PO attachments");
        }
      }

      // A new PO number (or a different phase) is not part of the open table,
      // so the view steps back to the phase cards where the new PO now lives.
      const sameScope =
        !selectedPo ||
        (String(formValues.po).trim().toLowerCase() === String(selectedPo).trim().toLowerCase() &&
          String(formValues.phase).trim().toLowerCase() ===
            String(selectedPhase).trim().toLowerCase());

      if (startAnother) {
        setFormValues(emptyPoForm);
        setItemDrafts([]);
        setPoAttachments([]);
        setBoqItems([]);
        setBoqItemsError("");
      } else {
        requestClose(true);
      }

      await swalSuccess(
        "PO Saved",
        `${lines.length} PO line${lines.length === 1 ? "" : "s"} saved successfully.`
      );

      if (!sameScope) {
        setSelectedPo(null);
        setSelectedPhase(null);
        resetFilters();
        await fetchPhaseCards();
        return;
      }

      if (page === 1) {
        await refreshData({ silent: true, targetPage: 1 });
      } else {
        setPage(1);
      }
    } catch (err) {
      reportSaveBlocked(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  // ---------- Excel bulk upload ----------
  const resetUpload = () => {
    setUploadFile(null);
    setUploadEntries([]);
    setUploadNotice("");
    setUploading(false);
  };

  const closeUpload = () => {
    if (uploadClosing) return;
    setUploadClosing(true);
    setTimeout(() => {
      setUploadOpen(false);
      setUploadClosing(false);
      resetUpload();
    }, 220);
  };

  const requestCloseUpload = () => {
    if (uploadClosing) return;
    if (uploadFile) {
      Swal.fire({
        title: "Discard selected file?",
        text: "The parsed rows will be lost unless you upload them.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "Discard",
        cancelButtonText: "Keep editing",
        confirmButtonColor: "var(--accent)",
        cancelButtonColor: "var(--bg-surface-alt)",
        reverseButtons: true,
        focusCancel: true,
        customClass: { container: "po-swal-container", popup: "swal-vector-popup" },
      }).then((result) => {
        if (result.isConfirmed) closeUpload();
      });
      return;
    }
    closeUpload();
  };

  const openUpload = () => {
    resetUpload();
    setUploadClosing(false);
    setUploadOpen(true);
    setMenuOpen(false);
  };

  const handleUploadFileChange = async (event) => {
    const file = event.target.files?.[0] || null;

    setUploadFile(file);
    setUploadEntries([]);
    setUploadNotice("");

    if (!file) return;

    try {
      const workbook = await readBulkWorkbook(file);
      const { rows, entries } = parseBulkWorkbook(workbook);
      setUploadEntries(entries);
      if (!rows.length) {
        setUploadNotice("No valid rows found yet — fix the rows listed below, or delete them here.");
      }
    } catch (err) {
      setUploadNotice(err?.message || "Unable to read this file.");
    }
  };

  // Delete in the preview. Editing is handled by the page's own Edit dialog, so
  // a row is either dropped here or corrected there - never half-edited.
  const deleteUploadEntry = (line) => {
    setUploadEntries((previous) => previous.filter((entry) => entry.line !== line));
  };

  // The two counters always describe what would be uploaded right now.
  const uploadReadyRows = useMemo(
    () => uploadEntries.filter((entry) => !entry.problems.length).map((entry) => entry.row),
    [uploadEntries]
  );
  const uploadLiveIssues = useMemo(
    () =>
      uploadEntries
        .filter((entry) => entry.problems.length)
        .map((entry) => ({ row: entry.line, message: entry.problems.join("; ") })),
    [uploadEntries]
  );

  const handleExportTemplate = () => {
    const headers = BULK_COLUMNS.map((column) => column.label);

    // A date typed into a General-formatted cell stays text, and a text cell
    // has no date picker.  One real date per date column gives those columns
    // Excel's date format; the example row is what the user overwrites.
    const example = { date: "05-08-2026", expectedDeliveryDate: "20-08-2026" };
    const exampleRow = BULK_COLUMNS.map((column) =>
      column.isDate ? toDateCellDate(example[column.key]) : ""
    );

    const templateSheet = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
    templateSheet["!cols"] = [16, 14, 22, 14, 14, 32, 14, 14, 10, 20, 30, 30, 24, 16].map((wch) => ({ wch }));
    // GST per Unit, Basic Price, GST Price and Total incl. GST fill themselves
    // in Excel as soon as Unit Rate and GST % are typed.
    applyColumnFormulas(templateSheet, BULK_COLUMNS, 200);
    applyDateColumnFormats(templateSheet, BULK_COLUMNS, exampleRow);

    const notesSheet = XLSX.utils.aoa_to_sheet([
      ["Column", "Description", "Example"],
      ...BULK_COLUMNS.map((column) => {
        const [description, example] = BULK_COLUMN_NOTES[column.key];
        return [column.label, description, example];
      }),
      [],
      ["Note", "Fill one row per PO line. Completely blank rows are ignored.", ""],
      [
        "Note",
        "PO Date and Expected Delivery Date ship as real Excel dates: click a cell for the date picker, or type the date as 2026-08-20 (ISO works in every locale). 05-08-2026, 05/08/2026 and Excel date cells are accepted too.",
        "",
      ],
      [
        "Note",
        "Need the picker on every row? Copy the example date cell and paste it down the column, or select the column and set Format Cells to Date (DD-MM-YYYY).",
        "",
      ],
      [
        "Note",
        "GST per Unit, Material Cost per Unit incl. GST and Total for Qty incl. GST calculate themselves from Unit Rate, GST % and Qty (blank GST means 18%).",
        "",
      ],
      ["Note", "Rows that fail validation are reported instead of being uploaded.", ""],
    ]);
    notesSheet["!cols"] = [{ wch: 26 }, { wch: 76 }, { wch: 20 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, templateSheet, "PO Template");
    XLSX.utils.book_append_sheet(workbook, notesSheet, "Instructions");
    XLSX.writeFile(workbook, BULK_FILE_NAME);
  };

  // Fills modelId/phaseId and the BOQ-owned fields (make, model, description,
  // unit rate) when the spreadsheet's phase + item code match a BOQ line —
  // the same auto-fill the Create PO form performs. Always best effort: a row
  // that cannot be matched still uploads with the values typed in the sheet.
  const enrichBulkRows = useCallback(async (rows) => {
    if (!rows.length) return rows;

    try {
      const phases = boqPhases.length ? boqPhases : await loadBoqPhases();
      if (!phases.length) return rows;

      const phasesByName = new Map();
      phases.forEach((phase) => {
        const key = String(phase.phaseName || "").trim().toLowerCase();
        if (!key) return;
        if (!phasesByName.has(key)) phasesByName.set(key, []);
        phasesByName.get(key).push(phase);
      });

      const itemsByPhase = new Map();
      const enriched = [];

      for (const row of rows) {
        const candidates = phasesByName.get(String(row.phase || "").trim().toLowerCase()) || [];
        if (candidates.length !== 1) {
          enriched.push(row);
          continue;
        }

        const phase = candidates[0];
        const cacheKey = `${phase.modelId}::${phase.phaseId}`;
        if (!itemsByPhase.has(cacheKey)) {
          itemsByPhase.set(cacheKey, await getBoqItems(phase.modelId, phase.phaseId).catch(() => []));
        }

        const item = (itemsByPhase.get(cacheKey) || []).find(
          (candidate) =>
            candidate.code &&
            String(candidate.code).trim().toLowerCase() === String(row.code).trim().toLowerCase()
        );

        const pick = (fromBoq, fromSheet) => {
          const value = fromBoq === null || fromBoq === undefined ? "" : String(fromBoq).trim();
          return value === "" ? fromSheet : value;
        };

        const boqRate =
          item?.rate === null || item?.rate === undefined || String(item.rate).trim() === ""
            ? NaN
            : Number(item.rate);

        const boqGstRate =
          item?.gstRate === null || item?.gstRate === undefined || String(item.gstRate).trim() === ""
            ? null
            : Number(item.gstRate);

        enriched.push({
          ...row,
          modelId: phase.modelId,
          phaseId: phase.phaseId,
          make: pick(item?.make, ""),
          model: pick(item?.model, ""),
          desc: pick(item?.desc, row.desc),
          supplier: pick(item?.vendor ?? item?.supplier, row.supplier),
          // The sheet wins; otherwise the BOQ line's own slab, else the default.
          gstRate: row.gstRate === null || row.gstRate === undefined
            ? (Number.isFinite(boqGstRate) ? boqGstRate : 18)
            : row.gstRate,
          rate: Number.isFinite(boqRate) ? boqRate : row.rate,
        });
      }

      return enriched;
    } catch (err) {
      return rows;
    }
  }, [boqPhases, loadBoqPhases, getBoqItems]);

  const showUploadIssues = (title, message, issues) =>
    Swal.fire({
      title,
      html: `${escapeHtml(message)}<ul class="po-upload-issue-list">${issues
        .slice(0, 6)
        .map((issue) => `<li>Row ${escapeHtml(issue.row)}: ${escapeHtml(issue.message)}</li>`)
        .join("")}${
        issues.length > 6 ? `<li>⬦and ${issues.length - 6} more</li>` : ""
      }</ul>`,
      icon: "warning",
      confirmButtonText: "OK",
      confirmButtonColor: "var(--accent)",
      customClass: { container: "po-swal-container", popup: "swal-vector-popup" },
    });

  const handleBulkUpload = async () => {
    if (uploading || !uploadReadyRows.length) return;

    setUploading(true);

    try {
      const rows = await enrichBulkRows(uploadReadyRows);
      const res = await api.post(`${API_BASE_URL}/po-details/bulk`, { rows });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to upload PO Details");
      }

      const createdCount = res.data.createdCount ?? res.data.created?.length ?? 0;
      const errors = res.data.errors || [];

      closeUpload();

      await refreshData(page === 1 ? { silent: true, targetPage: 1 } : null);
      if (page !== 1) setPage(1);

      if (errors.length) {
        await showUploadIssues(
          "Some rows were skipped",
          `${createdCount} PO Detail(s) created. ${errors.length} row(s) could not be created:`,
          errors
        );
      } else {
        await swalSuccess(
          "Upload complete",
          `${createdCount} PO Detail(s) created from the spreadsheet.`
        );
      }
    } catch (err) {
      const data = err?.response?.data;
      const errors = data?.errors;
      if (Array.isArray(errors) && errors.length) {
        await showUploadIssues("Upload failed", data.message || "No PO Details were created:", errors);
      } else {
        await swalError("Upload failed", extractErrorMessage(err, "Unable to upload the PO Details."));
      }
    } finally {
      setUploading(false);
    }
  };

  const startEditingDetails = () => {
    if (!detailsRow) return;
    const savedLine = buildEditLineDraft(detailsRow);
    setEditForm(buildEditForm(detailsRow));
    setDetailsItemDrafts([savedLine]);
    detailsInitialDraftsRef.current = [savedLine];
    setDetailsError("");
    setDetailsEditMode(true);
    // Item codes, their BOQ rates and the make/model they carry come from the
    // phase this line belongs to.
    if (detailsRow.modelId && detailsRow.phaseId) {
      fetchBoqItems(detailsRow.modelId, detailsRow.phaseId);
    }
  };

  const cancelEditingDetails = () => {
    if (detailsRow) {
      setEditForm(buildEditForm(detailsRow));
      const savedLine = buildEditLineDraft(detailsRow);
      setDetailsItemDrafts([savedLine]);
      detailsInitialDraftsRef.current = [savedLine];
    }
    setDetailsError("");
    setDetailsEditMode(false);
  };

  const handleEditFormChange = (event) => {
    const { name, value } = event.target;
    setDetailsError("");
    setEditForm((prev) => ({ ...prev, [name]: value }));
  };

  // ---------- Edit item blocks (same shape as the Add form) ----------

  const handleDetailsItemChange = (index, field, value) => {
    setDetailsError("");
    setDetailsItemDrafts((previous) =>
      previous.map((draft, position) =>
        position === index ? { ...draft, [field]: value } : draft
      )
    );
  };

  const handleDetailsItemDateChange = (index, field, value) => {
    handleDetailsItemChange(index, field, value);
  };

  const handleDetailsItemCodeSelect = (index, code) => {
    const found = boqItems.find((item) => item.code === code);
    setDetailsError("");
    setDetailsItemDrafts((previous) =>
      previous.map((draft, position) => {
        if (position !== index) return draft;
        const boqGstRate =
          found?.gstRate === null || found?.gstRate === undefined || String(found.gstRate).trim() === ""
            ? draft.gstRate || "18"
            : found.gstRate;
        return {
          ...draft,
          code,
          make: found?.make || "",
          model: found?.model || "",
          desc: found?.desc || "",
          rate: found?.rate ?? draft.rate,
          gstRate: boqGstRate,
        };
      })
    );
  };

  const addDetailsItemDraft = () => {
    setDetailsItemDrafts((previous) => [...previous, { ...emptyEditLineDraft }]);
    window.requestAnimationFrame(() => {
      detailsLastItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const removeDetailsItemDraft = (index) => {
    setDetailsItemDrafts((previous) => previous.filter((_, position) => position !== index));
  };

  const handleSaveDetails = async () => {
    if (!detailsRow || detailsSaving) return;

    if (!detailsItemDrafts.length) {
      setDetailsError('Add at least one item with the "Add item" button in the header.');
      return;
    }

    const id = getRowId(detailsRow);
    if (!id) {
      setDetailsError("Missing record identifier; cannot save changes.");
      return;
    }

    if (!String(editForm.po ?? "").trim()) {
      setDetailsError("PO No cannot be empty.");
      return;
    }
    if (!String(editForm.date ?? "").trim()) {
      setDetailsError("PO Date cannot be empty.");
      return;
    }

    for (let index = 0; index < detailsItemDrafts.length; index += 1) {
      const error = validateEditLine(detailsItemDrafts[index], `Item ${index + 1}`);
      if (error) {
        setDetailsError(error);
        return;
      }
    }

    const originalForm = buildEditForm(detailsRow);
    // PO header travels with the record, exactly like the Add form merges it
    // into every line it posts.
    const header = {
      phase: detailsRow.phase,
      modelId: detailsRow.modelId,
      phaseId: detailsRow.phaseId,
      po: editForm.po.trim(),
      supplier: editForm.supplier.trim(),
      date: editForm.date,
    };
    const attachmentsChanged =
      JSON.stringify(editForm.attachments || []) !== JSON.stringify(originalForm.attachments || []);

    setDetailsSaving(true);
    setDetailsError("");

    try {
      const savedLine = detailsItemDrafts.find((draft) => draft.id) || detailsItemDrafts[0];
      let added = 0;

      for (const draft of detailsItemDrafts) {
        const line = { ...draft, ...header };
        if (draft.id) {
          // Only the saved record is updated, and only with what changed.
          const payload = {};
          if (line.po !== detailsRow.po) payload.po = line.po;
          if (line.supplier !== (detailsRow.supplier || "")) payload.supplier = line.supplier;
          if (line.date !== toDateInputValue(detailsRow.date)) payload.date = line.date;
          if (String(line.code) !== String(detailsRow.code || "")) {
            payload.code = line.code;
            payload.make = line.make;
            payload.model = line.model;
            payload.desc = line.desc;
          }
          if (String(line.qty) !== String(detailsRow.qty ?? "")) payload.qty = line.qty;
          if (String(line.rate) !== String(detailsRow.rate ?? "")) payload.rate = line.rate;
          if (String(line.gstRate) !== String(detailsRow.gstRate ?? "")) payload.gstRate = line.gstRate;
          if (line.status !== (detailsRow.status || "")) payload.status = line.status || null;
          if (line.expectedDeliveryDate !== toDateInputValue(detailsRow.expectedDeliveryDate)) {
            payload.expectedDeliveryDate = line.expectedDeliveryDate || null;
          }
          if (Object.keys(payload).length) {
            const res = await api.put(`${API_BASE_URL}/po-details/${draft.id}`, payload);
            if (!res.data.success) {
              throw new Error(res.data.message || "Failed to update PO Detail");
            }
          }
        } else {
          // A block added with "Add item" is a new line of the same PO.
          const res = await api.post(`${API_BASE_URL}/po-details`, {
            ...line,
            id: undefined,
            status: line.status || null,
          });
          if (!res.data.success) {
            throw new Error(res.data.message || "Failed to save PO Detail");
          }
          added += 1;
        }
      }

      // The PO's files live on the header document, so one update carries them.
      if (attachmentsChanged) {
        const res = await api.put(`${API_BASE_URL}/po-details/${savedLine.id || id}`, {
          attachments: editForm.attachments || [],
        });
        if (!res.data.success) {
          throw new Error(res.data.message || "Failed to update PO attachments");
        }
      }

      setDetailsItemDrafts([]);
      detailsInitialDraftsRef.current = [];
      setDetailsEditMode(false);
      await swalSuccess(
        "PO Detail Updated",
        added
          ? `The PO was updated and ${added} new line${added === 1 ? "" : "s"} added.`
          : "The PO Detail has been updated successfully."
      );

      // A renamed PO number leaves the open table, so step back to the cards.
      if (header.po !== (detailsRow.po || "")) {
        setSelectedPo(null);
        setPage(1);
        await fetchPhaseCards();
      }

      // One refresh covers the open popup copy, the table beneath it, and the
      // top phase cards - no page reload needed.
      await refreshData({ silent: true, targetPage: page });
    } catch (err) {
      const message = extractErrorMessage(err, "Failed to update PO Detail.");
      setDetailsError(message);
      await swalError("Update failed", message);
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleStatusChange = useCallback(async (row, newStatus) => {
    const id = getRowId(row);
    if (!id || updatingStatusId) return;

    const previousStatus = row.status || "";
    if (newStatus === previousStatus) return;

    setUpdatingStatusId(id);
    setRows((prev) =>
      prev.map((r) => (getRowId(r) === id ? { ...r, status: newStatus } : r))
    );

    try {
      const res = await api.put(`${API_BASE_URL}/po-details/${id}`, {
        status: newStatus || null,
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to update status");
      }
      swalSuccess("Status updated", `Status changed to "${newStatus}".`);
    } catch (err) {
      setRows((prev) =>
        prev.map((r) => (getRowId(r) === id ? { ...r, status: previousStatus } : r))
      );
      swalError("Update failed", extractErrorMessage(err, "Failed to update status."));
    } finally {
      setUpdatingStatusId(null);
    }
  }, [updatingStatusId]);

  const toggleSelectMode = () => {
    setSelectMode((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelectOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const currentPageIds = useMemo(
    () => rows.map(getRowId).filter(Boolean),
    [rows]
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === currentPageIds.length && currentPageIds.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(currentPageIds));
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    const result = await swalConfirm({
      title: "Delete selected PO(s)?",
      text: `Delete ${selectedIds.size} selected PO(s)? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setDeleting(true);

    try {
      const res = await api.post(`${API_BASE_URL}/po-details/bulk-delete`, {
        ids: Array.from(selectedIds),
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to delete PO Details");
      }
      const deletedCount = res.data.deleted?.length || 0;
      const failedCount = res.data.failed?.length || 0;
      setSelectMode(false);
      setSelectedIds(new Set());
      setMenuOpen(false);
      await refreshData({ targetPage: page });
      if (failedCount > 0) {
        swalError("Some PO Details were not deleted", `${deletedCount} removed, ${failedCount} failed.`);
      } else {
        swalSuccess("PO Details deleted", `${deletedCount} PO(s) removed from the backend.`);
      }
    } catch (err) {
      const message = extractErrorMessage(err, "Failed to delete PO Details.");
      swalError("Delete failed", message);
    } finally {
      setDeleting(false);
    }
  };

  const allSelected = currentPageIds.length > 0 && selectedIds.size === currentPageIds.length;

  const tableColumns = useMemo(() => {
    const base = columns.map((c) => {
      if (c.key !== "status") return c;
      return {
        ...c,
        render: (row) => {
          const id = getRowId(row);
          const isUpdating = updatingStatusId === id;
          return (
            <div className="status-cell">
              <StatusDropdown
                value={row.status || ""}
                options={STATUS_OPTIONS}
                disabled={isUpdating}
                onChange={(e) => handleStatusChange(row, e.target.value)}
                placeholder="Select status"
              />
              {isUpdating && <Loader2 size={14} className="spin status-spinner" />}
            </div>
          );
        },
      };
    });

    if (!selectMode) return base;

    const selectColumn = {
      key: "__select",
      label: "",
      render: (row) => {
        const id = getRowId(row);
        return (
          <input
            type="checkbox"
            className="po-row-checkbox"
            checked={selectedIds.has(id)}
            onChange={() => toggleSelectOne(id)}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
          />
        );
      },
    };

    return [selectColumn, ...base];
  }, [updatingStatusId, handleStatusChange, selectMode, selectedIds]);

  const phaseSelectValue =
    formValues.modelId && formValues.phaseId
      ? `${formValues.modelId}::${formValues.phaseId}`
      : "";

  const itemCodeDisabled = !formValues.phaseId;
  // Editing an existing line needs a phase on the record to load its BOQ items.
  const detailsItemCodeDisabled = !detailsRow?.phaseId;
  const itemCodeEmptyMessage = boqItemsError
    ? boqItemsError
    : "No BOQ items found for this phase.";

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  // Live GST / PO Value preview for the Add PO form — the rate is per line.
  const supplierOptions = useMemo(
    () => suppliers.map((supplier) => ({ value: supplier, label: supplier })),
    [suppliers]
  );

  // Same master-list maintenance as BOQ: fix a mistyped name or drop one.
  const applySupplierList = (nextList) => {
    suppliersCache = nextList;
    setSuppliers(nextList);
  };

  const handleEditSupplier = async (option) => {
    const { value: newName } = await Swal.fire({
      title: "Edit supplier name",
      input: "text",
      inputValue: option.value,
      showCancelButton: true,
      confirmButtonText: "Save name",
      cancelButtonText: "Cancel",
      confirmButtonColor: "var(--accent)",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      inputValidator: (value) => (!value || !value.trim() ? "Supplier name cannot be empty" : null),
      customClass: { popup: "swal-vector-popup" },
    });
    if (!newName) return;

    const trimmed = newName.trim();
    if (trimmed.toLowerCase() === option.value.toLowerCase()) return;

    try {
      const response = await api.put(`${API_BASE_URL}/suppliers`, {
        oldName: option.value,
        newName: trimmed,
      });
      if (!response.data.success) {
        throw new Error(response.data.message || "Failed to rename supplier");
      }
      applySupplierList(
        (suppliersCache || [])
          .map((name) => (name.toLowerCase() === option.value.toLowerCase() ? trimmed : name))
          .sort((a, b) => a.localeCompare(b))
      );
      await swalSuccess("Supplier renamed", `"${option.value}" is now "${trimmed}".`);
    } catch (err) {
      await swalError(
        "Rename failed",
        err?.response?.data?.message || err?.message || "Failed to rename supplier."
      );
    }
  };

  const handleDeleteSupplier = async (option) => {
    const confirmed = await Swal.fire({
      title: `Delete "${option.value}"`,
      text: "It disappears from the supplier list. PO lines already saved keep the name they were saved with.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, delete it",
      cancelButtonText: "Cancel",
      confirmButtonColor: "var(--accent)",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      focusCancel: true,
      customClass: { popup: "swal-vector-popup" },
    });
    if (!confirmed.isConfirmed) return;

    try {
      const response = await api.delete(`${API_BASE_URL}/suppliers`, {
        data: { name: option.value },
      });
      if (!response.data.success) {
        throw new Error(response.data.message || "Failed to delete supplier");
      }
      applySupplierList(
        (suppliersCache || []).filter(
          (name) => name.toLowerCase() !== option.value.toLowerCase()
        )
      );
      await swalSuccess("Supplier deleted", `"${option.value}" was removed from the list.`);
    } catch (err) {
      await swalError(
        "Delete failed",
        err?.response?.data?.message || err?.message || "Failed to delete supplier."
      );
    }
  };

  const selectedPhaseCard = useMemo(
    () =>
      phaseCards.find(
        (card) => String(card.phase).toLowerCase() === String(selectedPhase || "").toLowerCase()
      ) || null,
    [phaseCards, selectedPhase]
  );

  const viewTitle = !selectedPhase
    ? "PO Details"
    : !selectedPo
      ? selectedPhase
      : `${selectedPhase} · PO ${selectedPo}`;

  return (
    <div className="po-page">
      <div className="po-toolbar">
        <div className="po-toolbar-left">
          {selectedPhase && (
            <button
              type="button"
              className="po-back-btn"
              onClick={selectedPo ? backFromPo : backFromPhase}
            >
              <ArrowLeft size={16} /> Back
            </button>
          )}
          <h2 className="model-heading po-heading">{viewTitle}</h2>
        </div>
        <div className="po-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="po-add-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="po-add-btn"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
              >
                <Trash2 size={16} />
                {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </button>
              <button type="button" className="po-add-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="po-add-btn" onClick={openModal}>
                <Plus size={18} />
                Create PO
              </button>
              <button type="button" className="po-upload-btn" onClick={openUpload}>
                <Upload size={16} /> Bulk Upload
              </button>
              {selectedPhase && (
                <button type="button" className="po-delete-btn" onClick={toggleSelectMode}>
                  <Trash2 size={16} /> Delete
                </button>
              )}
            </>
          )}
        </div>

        <div className="po-kebab-wrapper" ref={menuRef}>
          <button
            type="button"
            className="po-kebab-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="More actions"
          >
            <MoreVertical size={20} />
          </button>

          {menuOpen && (
            <div className="po-kebab-menu">
              {selectMode ? (
                <>
                  <button type="button" className="po-menu-item" onClick={toggleSelectAll}>
                    <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    className="po-menu-item"
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || deleting}
                  >
                    <Trash2 size={16} />
                    {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
                  </button>
                  <button type="button" className="po-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="po-menu-item" onClick={openModal}>
                    <Plus size={16} /> Create PO
                  </button>
                  <button type="button" className="po-menu-item" onClick={openUpload}>
                    <Upload size={16} /> Bulk Upload
                  </button>
                  {selectedPhase && (
                    <button type="button" className="po-menu-item" onClick={toggleSelectMode}>
                      <Trash2 size={16} /> Delete
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {successMessage && (
        <div className="po-success-banner" role="status">
          {successMessage}
        </div>
      )}

      {!selectedPhase ? (
        cardsLoading ? (
          <div className="po-loading">
            <Loader2 size={28} className="spin" />
            <span>Loading phase cards...</span>
          </div>
        ) : cardsError ? (
          <div className="po-load-error">
            <div className="po-load-error-actions">
              <span>{cardsError}</span>
              <button type="button" className="po-btn-secondary" onClick={fetchPhaseCards}>
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          </div>
        ) : phaseCards.length === 0 ? (
          <div className="po-empty-state">
            <span>No PO Details yet. Click "Create PO" to add the first record.</span>
          </div>
        ) : (
          <div className="model-grid">
            {phaseCards.map((card) => (
              <button
                key={card.phase}
                type="button"
                className="model-card po-card"
                onClick={() => openPhase(card.phase)}
              >
                <div className="model-card-heading-row">
                  <div className="model-card-icon">
                    <GitBranch size={18} />
                  </div>
                  <span className="model-card-name">{card.phase}</span>
                </div>
                {card.date && <span className="model-card-time">{formatDate(card.date)}</span>}
                <div className="po-card-totals">
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">Basic Price</span>
                    <span className="po-card-total-amount">{fmtINR(Number(card.totalValueExclGst) || 0)}</span>
                  </span>
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">GST Price</span>
                    <span className="po-card-total-amount">{fmtINR(Number(card.totalGst) || 0)}</span>
                  </span>
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">Phase Total incl. GST</span>
                    <span className="model-card-total-value">{fmtINR(card.totalValue)}</span>
                  </span>
                </div>
                <span className="po-card-meta">
                  {card.rowCount} line{card.rowCount === 1 ? "" : "s"} · {card.pos.length} PO
                  {card.pos.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        )
      ) : !selectedPo ? (
        selectedPhaseCard && selectedPhaseCard.pos.length > 0 ? (
          <div className="model-grid">
            {selectedPhaseCard.pos.map((po) => (
              <button
                key={po.po}
                type="button"
                className="model-card po-card"
                onClick={() => openPo(po.po)}
              >
                <div className="model-card-heading-row">
                  <div className="model-card-icon">
                    <FileText size={18} />
                  </div>
                  <span className="model-card-name">{po.po}</span>
                </div>
                {po.date && <span className="model-card-time">{formatDate(po.date)}</span>}
                <div className="po-card-totals">
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">Basic Price</span>
                    <span className="po-card-total-amount">{fmtINR(Number(po.totalValueExclGst) || 0)}</span>
                  </span>
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">GST Price</span>
                    <span className="po-card-total-amount">{fmtINR(Number(po.totalGst) || 0)}</span>
                  </span>
                  <span className="po-card-total-row">
                    <span className="model-card-total-label">PO Total incl. GST</span>
                    <span className="model-card-total-value">{fmtINR(po.totalValue)}</span>
                  </span>
                </div>
                <span className="po-card-meta">
                  {po.rowCount} line{po.rowCount === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="po-empty-state">
            <span>No POs found for phase {selectedPhase}.</span>
          </div>
        )
      ) : (
        <>
          <div className="panel">
            <div className="table-controls-row">
              <div className="table-controls-primary">
                <SearchBar value={query} onChange={setQuery} placeholder="Search PO Details..." />
                <PageFilter rows={filterOptionRows} fields={PO_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
              </div>
              <div className="table-controls-right">
                <span className="table-total">
<span className="table-total-label">Total</span>
                  <span className="table-total-value">
                    {fmtINR(totalPoValueExclGst)}{" "}
                    <span className="table-total-scope">(Basic Price)</span>
                  </span>
                  <span className="table-total-scope">|</span>
                  <span className="table-total-value">
                    {fmtINR(totalPoGst)}{" "}
                    <span className="table-total-scope">(GST Price)</span>
                  </span>
                  <span className="table-total-scope">|</span>
                  <span className="table-total-value">
                    {fmtINR(totalPoValue)}{" "}
                    <span className="table-total-scope">(Total incl. GST)</span>
                  </span>
                </span>
                <ImageStrip
                  rows={filteredRows}
                  endpoint={`${API_BASE_URL}/po-details/images`}
                  updateEndpoint={`${API_BASE_URL}/po-details`}
                  attachmentsEndpoint={`${API_BASE_URL}/po-details/attachments`}
                  labelOf={(row) => `${row.po || "PO"} · ${row.code || ""}`.trim()}
                  scopeLabel="PO"
                  onChanged={() => refreshData({ silent: true, targetPage: page })}
                  onError={setRowsError}
                />
                <ExportPdfButton
                  mode="table"
                  title={`${selectedPo} ${selectedPhase}`}
                  columns={columns}
                  rows={filteredRows}
                  fileName={`${selectedPo}-${selectedPhase}`}
                />
              </div>
            </div>

            {rowsLoading ? (
              <div className="po-loading">
                <Loader2 size={28} className="spin" />
                <span>Loading PO Details...</span>
              </div>
            ) : rowsError ? (
              <div className="po-load-error">
                <div className="po-load-error-actions">
                  <span>{rowsError}</span>
                  <button
                    type="button"
                    className="po-btn-secondary"
                    onClick={() => fetchPoDetails({ targetPage: page })}
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="po-empty-state">
                <span>No PO lines for this phase yet. Click "Create PO" to add one.</span>
              </div>
            ) : (
              <DataTable columns={tableColumns} rows={filteredRows} onViewDetails={openDetails} />
            )}
          </div>

          {!rowsLoading && !rowsError && rows.length > 0 && (
            <>
              {/* <div className="table-total-outside">
                <span className="table-total-label">Total PO Value</span>
                <span className="table-total-value">{fmtINR(totalPoValue)}</span>
                <span className="table-total-scope">
                  {selectedPhase} · {selectedPo} · {totalCount} row
                  {totalCount === 1 ? "" : "s"}
                </span>
              </div> */}

              <ListPagination
                page={page}
                pageSize={pageSize}
                totalPages={totalPages}
                totalCount={totalCount}
                rowCount={rows.length}
                onPageChange={setPage}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          )}
        </>
      )}

      {/* ---- Add PO Modal ---- */}
      {modalOpen && createPortal(
        <div className={`modal-overlay${closing ? " closing" : ""}`} onClick={requestClose}>
          <div
            className={`modal-container po-entry-modal${closing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Add PO Details"
          >
            <div className="modal-header">
              <h2>Add PO Details</h2>
              {/* Adding a line never needs a scroll: the control sits in the
                  header, which stays put while the form scrolls. */}
              <div className="modal-header-actions">
                <button
                  type="button"
                  className="po-add-item-btn"
                  onClick={addItemDraft}
                  disabled={saving}
                  title="Add another item to this PO"
                >
                  <Plus size={15} /> Add item
                </button>
                <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                  <X size={22} />
                </button>
              </div>
            </div>

            <form
              className="po-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="po-form-error">{formError}</div>}

              {/* ---- PO header: shared by every item below ---- */}
              <div className="po-form-grid po-header-grid">
                <label className="po-field">
                  <span>Phase <span className="po-required-asterisk">*</span></span>
                  <SearchableSelect
                    options={phaseOptions}
                    value={phaseSelectValue}
                    onChange={handlePhaseSelect}
                    placeholder="Select Phase"
                    loading={boqPhasesLoading}
                    emptyMessage={boqPhasesError || "No phases found in BOQ"}
                  />
                </label>

                <label className="po-field">
                  <span>PO No <span className="po-required-asterisk">*</span></span>
                  <input
                    name="po"
                    value={formValues.po}
                    onChange={handleFormChange}
                    placeholder="e.g. PO-4521"
                  />
                </label>

                <label className="po-field">
                  <span>Supplier</span>
                  <SearchableSelect
                    options={supplierOptions}
                    value={formValues.supplier}
                    onChange={(supplier) =>
                      setFormValues((prev) => ({ ...prev, supplier: supplier || "" }))
                    }
                    placeholder="Select or enter supplier"
                    emptyMessage="Type a supplier name to add it"
                    allowCustomValue
                    onEditOption={handleEditSupplier}
                    onDeleteOption={handleDeleteSupplier}
                  />
                </label>

                <label className="po-field">
                  <span>PO Date <span className="po-required-asterisk">*</span></span>
                  <DatePicker value={formValues.date} onChange={(date) => setFormValues((prev) => ({ ...prev, date }))} ariaLabel="Select PO date" />
                </label>
              </div>

              {/* ---- Items: added one at a time, like adding a passenger ---- */}
              <div className="po-items-bar">
                <span className="po-items-bar-label">
                  Items
                  <span className="po-items-count">{itemDrafts.length}</span>
                </span>
              </div>

              {itemDrafts.length === 0 && (
                <div className="po-items-empty">No items yet — use the &ldquo;Add item&rdquo; button in the header above.</div>
              )}

              {itemDrafts.map((draft, index) => {
                const totals = itemTotals(draft);
                const subtotal = itemSubtotal(draft, totals);
                return (
                  <section className="boq-item-card" key={`item-${index}`} ref={index === itemDrafts.length - 1 ? lastItemRef : null}>
                    <div className="boq-item-card-header">
                      <span className="boq-item-number">
                        Item {index + 1}
                        {draft.code ? ` · ${draft.code}` : ""}
                      </span>
                      <div className="boq-item-card-actions">                        <button
                          type="button"
                          className="icon-btn boq-item-remove"
                          onClick={() => removeItemDraft(index)}
                          aria-label={`Remove item ${index + 1}`}
                          title="Remove this item"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    <div className="po-form-grid">
                      <label className="po-field">
                        <span>Item Code <span className="po-required-asterisk">*</span></span>
                        <SearchableSelect
                          options={itemCodeOptions}
                          value={draft.code}
                          onChange={(code) => handleItemCodeSelect(index, code)}
                          placeholder={itemCodeDisabled ? "Select Phase first" : "Select Item Code"}
                          disabled={itemCodeDisabled}
                          loading={boqItemsLoading}
                          emptyMessage={itemCodeEmptyMessage}
                        />
                        {!itemCodeDisabled && !boqItemsLoading && boqItems.length === 0 && (
                          <span className="po-field-helper error">
                            No BOQ items found for this phase.
                          </span>
                        )}
                      </label>

                      <label className="po-field">
                        <span>Make</span>
                        <input name={`make-${index}`} value={draft.make} readOnly disabled placeholder="Auto-filled from BOQ" />
                      </label>

                      <label className="po-field">
                        <span>Model</span>
                        <input name={`model-${index}`} value={draft.model} readOnly disabled placeholder="Auto-filled from BOQ" />
                      </label>

                      <label className="po-field">
                        <span>Qty Ordered <span className="po-required-asterisk">*</span></span>
                        <input
                          type="number"
                          min="0"
                          name={`qty-${index}`}
                          value={draft.qty}
                          onChange={(event) => handleItemChange(index, "qty", event.target.value)}
                          placeholder="e.g. 10"
                        />
                      </label>

                      <label className="po-field">
                        <span>Unit Rate <span className="po-required-asterisk">*</span></span>
                        <input
                          type="number"
                          name={`rate-${index}`}
                          value={draft.rate}
                          readOnly
                          disabled={!draft.code}
                          placeholder={!draft.code ? "Select Item Code first" : "Auto-filled from BOQ"}
                        />
                      </label>

                      <label className="po-field">
                        <span>GST %</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          name={`gstRate-${index}`}
                          value={draft.gstRate}
                          onChange={(event) => handleItemChange(index, "gstRate", event.target.value)}
                          placeholder="e.g. 18"
                        />
                      </label>

                      <label className="po-field po-field-span2">
                        <span>Item Description <span className="po-required-asterisk">*</span></span>
                        <input
                          name={`desc-${index}`}
                          value={draft.desc}
                          readOnly
                          disabled
                          placeholder="Auto-filled from BOQ"
                        />
                      </label>

                      <label className="po-field">
                        <span>Expected Delivery Date <span className="po-required-asterisk">*</span></span>
                        <DatePicker
                          value={draft.expectedDeliveryDate}
                          onChange={(date) => handleItemDateChange(index, "expectedDeliveryDate", date)}
                          ariaLabel={`Select expected delivery date for item ${index + 1}`}
                        />
                      </label>

                      <label className="po-field">
                        <span>Status <span className="po-required-asterisk">*</span></span>
                        <StatusDropdown
                          name={`status-${index}`}
                          value={draft.status}
                          options={STATUS_OPTIONS}
                          onChange={(event) => handleItemChange(index, "status", event.target.value)}
                          placeholder="Select status"
                        />
                      </label>
                    </div>

                    {totals && (
                      <div className="po-form-totals">
                        <span className="po-form-totals-item">
                          Subtotal: <strong>{fmtINR(subtotal)}</strong>
                        </span>
                        <span className="po-form-totals-item">
                          GST ({draft.gstRate || 18}%): <strong>{fmtINR(totals.gst)}</strong>
                        </span>
                        <span className="po-form-totals-item po-form-totals-final">
                          PO Value: <strong>{fmtINR(totals.value)}</strong>
                        </span>
                      </div>
                    )}

                  </section>
                );
              })}

              {/* One attachments section for the whole PO, not one per item. */}
              <div className="po-item-attachments po-level-attachments">
                <AttachmentsEditor
                  files={poAttachments}
                  onChange={setPoAttachments}
                  label="PO attachments"
                  uploadEndpoint={`${API_BASE_URL}/po-details/attachments/upload`}
                  compact
                  disabled={saving}
                />
              </div>
            </form>

            <div className="modal-footer">
              <button type="button" className="po-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              {/* Not disabled by an "is the form complete" check: a greyed-out
                  button just does nothing when a field is missing. handleSave
                  reports what is missing instead. */}
              <button
                type="button"
                className="po-btn-primary"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : "Save & Close"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ---- Bulk Upload (Excel) Modal ---- */}
      {uploadOpen && createPortal(
        <div className={`modal-overlay${uploadClosing ? " closing" : ""}`} onClick={requestCloseUpload}>
          <div
            className={`modal-container po-upload-modal${uploadClosing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Upload Excel File"
          >
            <div className="modal-header po-upload-header">
              <div className="po-upload-heading">
                <span className="po-upload-heading-icon">
                  <Upload size={20} />
                </span>
                <div className="po-upload-heading-text">
                  <h2>Upload Excel File</h2>
                  <p>Upload the completed PO Details template for validation.</p>
                </div>
              </div>
              <button type="button" className="modal-close" onClick={requestCloseUpload} aria-label="Close">
                <X size={22} />
              </button>
            </div>

            <div className="po-upload-body">
              <p className="po-upload-section-title">Choose Excel File</p>

              <div className="po-upload-file-box">
                <input
                  id="po-bulk-upload-input"
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleUploadFileChange}
                  disabled={uploading}
                />
              </div>

              {uploadNotice && <div className="po-form-error">{uploadNotice}</div>}

              {uploadFile && !uploadNotice && (
                <div className="po-upload-summary">
                  <span>
                    <strong>{uploadReadyRows.length}</strong> row(s) ready to upload
                  </span>
                  {uploadLiveIssues.length > 0 && (
                    <span className="po-upload-summary-issues">
                      {uploadLiveIssues.length} row(s) will be skipped
                    </span>
                  )}
                  <span className="po-upload-summary-hint">
                    Edit opens that PO line in its own Edit dialog; Delete drops it. Untouched rows are uploaded
                    as they are.
                  </span>
                </div>
              )}

              {uploadLiveIssues.length > 0 && (
                <ul className="po-upload-issue-list">
                  {uploadLiveIssues.slice(0, 6).map((issue, index) => (
                    <li key={`${issue.row}-${index}`}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                  {uploadLiveIssues.length > 6 && <li>⬦and {uploadLiveIssues.length - 6} more</li>}
                </ul>
              )}

              {uploadEntries.length > 0 && (
                <div className="po-upload-preview">
                  <table>
                    <thead>
                      <tr>
                        <th className="po-upload-index-head">S.No.</th>
                        {BULK_COLUMNS.filter((column) => !column.hidden).map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                        <th className="po-upload-actions-head">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uploadEntries.slice(0, 50).map((entry, index) => (
                        <tr
                          key={entry.line}
                          className={entry.problems.length ? "po-upload-row-invalid" : ""}
                        >
                          <td className="po-upload-index" data-label="S.No.">
                            {index + 1}
                            {entry.problems.length > 0 && (
                              <AlertTriangle
                                size={13}
                                className="po-upload-row-warning"
                                aria-label={entry.problems.join("; ")}
                              />
                            )}
                          </td>
                          {BULK_COLUMNS.filter((column) => !column.hidden).map((column) => (
                            <td key={column.key} data-label={column.label}>
                              {String(entry.row[column.key] ?? "")}
                            </td>
                          ))}
                          <td className="po-upload-row-actions" data-label="Actions">
                            <button
                              type="button"
                              className="po-upload-row-btn"
                              onClick={() => {
                                // Hand the line to the page's own Edit dialog,
                                // exactly as opening it from the table would.
                                closeUpload();
                                setUploadNotice("");
                                openDetails(entry.row);
                                startEditingDetails();
                              }}
                              disabled={uploading || entry.problems.length > 0}
                              aria-label={`Edit row ${index + 1}`}
                              title={entry.problems.length ? "Fix this row in the file first" : "Edit this PO line"}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="po-upload-row-btn danger"
                              onClick={() => deleteUploadEntry(entry.line)}
                              disabled={uploading}
                              aria-label={`Delete row ${index + 1}`}
                              title="Remove this row"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {uploadEntries.length > 50 && (
                    <p className="po-upload-preview-hint">
                      Showing the first 50 of {uploadEntries.length} rows.
                    </p>
                  )}
                </div>
              )}

              <p className="po-upload-hint">
                GST per Unit, Material Cost per Unit incl. GST and Total for Qty incl. GST calculate
                themselves in the exported template from Unit Rate, GST % and Qty (blank means 18%).
                Use "Export Excel template" if you have not filled the file in yet.
              </p>
            </div>

            <div className="modal-footer">
              <button type="button" className="po-btn-secondary" onClick={handleExportTemplate}>
                <Download size={16} /> Export Excel template
              </button>
              <button
                type="button"
                className="po-btn-primary"
                onClick={handleBulkUpload}
                disabled={uploading || !uploadReadyRows.length}
              >
                {uploading ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ---- View / Edit PO Details Popup ---- */}
      {detailsOpen && detailsRow && createPortal(
        <div
          className={`po-details-overlay${detailsClosing ? " closing" : ""}`}
          onClick={requestCloseDetails}
        >
          <div
            className={`po-details-container${detailsClosing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="PO Details"
          >
            <div className="po-details-header">
              <div>
                <h2>{detailsEditMode ? "Edit PO Details" : "PO Details"}</h2>
                <p className="boq-form-subtitle">
                  {[detailsRow.phase, detailsRow.po].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="po-details-header-actions">
                {!detailsEditMode && (
                  <button
                    type="button"
                    className="po-details-edit-btn"
                    onClick={startEditingDetails}
                    aria-label="Edit PO Details"
                  >
                    <Pencil size={15} />
                    Edit
                  </button>
                )}
                {detailsEditMode && (
                  <button
                    type="button"
                    className="po-add-item-btn"
                    onClick={addDetailsItemDraft}
                    disabled={detailsSaving}
                    title="Add another item to this PO"
                  >
                    <Plus size={15} /> Add item
                  </button>
                )}
                <button
                  type="button"
                  className="po-details-close"
                  onClick={requestCloseDetails}
                  aria-label="Close"
                >
                  <X size={22} />
                </button>
              </div>
            </div>

            <div className="po-details-body">
              {detailsError && <div className="boq-form-error">{detailsError}</div>}

              {/* Edit mirrors the Add PO form: the PO header on top, one item
                  block per line below it. */}
              {detailsEditMode ? (
                <>
                  <div className="po-form-grid po-header-grid">
                    <label className="po-field">
                      <span>Phase</span>
                      <input
                        name="phase"
                        value={detailsRow.phase || ""}
                        readOnly
                        disabled
                      />
                    </label>

                    <label className="po-field">
                      <span>PO No <span className="po-required-asterisk">*</span></span>
                      <input
                        name="po"
                        value={editForm.po}
                        onChange={handleEditFormChange}
                        placeholder="e.g. PO-4521"
                      />
                    </label>

                    <label className="po-field">
                      <span>Supplier</span>
                      <SearchableSelect
                        options={supplierOptions}
                        value={editForm.supplier}
                        onChange={(supplier) =>
                          setEditForm((prev) => ({ ...prev, supplier: supplier || "" }))
                        }
                        placeholder="Select or enter supplier"
                        emptyMessage="Type a supplier name to add it"
                        allowCustomValue
                        onEditOption={handleEditSupplier}
                        onDeleteOption={handleDeleteSupplier}
                      />
                    </label>

                    <label className="po-field">
                      <span>PO Date <span className="po-required-asterisk">*</span></span>
                      <DatePicker
                        value={editForm.date}
                        onChange={(date) => setEditForm((prev) => ({ ...prev, date }))}
                        ariaLabel="Select PO date"
                      />
                    </label>
                  </div>

                  <div className="po-items-bar">
                    <span className="po-items-bar-label">
                      Items
                      <span className="po-items-count">{detailsItemDrafts.length}</span>
                    </span>
                  </div>

                  {detailsItemDrafts.length === 0 && (
                    <div className="po-items-empty">No items yet — use the &ldquo;Add item&rdquo; button in the header above.</div>
                  )}

                  {detailsItemDrafts.map((draft, index) => {
                    const totals = calculatePoAmounts(draft.qty, draft.rate, draft.gstRate);
                    const subtotal =
                      totals && draft.qty !== "" && draft.rate !== ""
                        ? Math.round(Number(draft.qty) * Number(draft.rate) * 100) / 100
                        : null;
                    return (
                      <section
                        className="boq-item-card"
                        key={`edit-item-${index}`}
                        ref={index === detailsItemDrafts.length - 1 ? detailsLastItemRef : null}
                      >
                        <div className="boq-item-card-header">
                          <span className="boq-item-number">
                            Item {index + 1}
                            {draft.code ? ` · ${draft.code}` : ""}
                          </span>
                          <div className="boq-item-card-actions">
                            {/* A line already on the server is removed from
                                the table, never dropped by the form. */}
                            {!draft.id && (
                              <button
                                type="button"
                                className="icon-btn boq-item-remove"
                                onClick={() => removeDetailsItemDraft(index)}
                                aria-label={`Remove item ${index + 1}`}
                                title="Remove this item"
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="po-form-grid">
                          <label className="po-field">
                            <span>Item Code <span className="po-required-asterisk">*</span></span>
                            <SearchableSelect
                              options={itemCodeOptions}
                              value={draft.code}
                              onChange={(code) => handleDetailsItemCodeSelect(index, code)}
                              placeholder={detailsItemCodeDisabled ? "No phase on this record" : "Select Item Code"}
                              disabled={detailsItemCodeDisabled}
                              loading={boqItemsLoading}
                              emptyMessage={itemCodeEmptyMessage}
                            />
                          </label>

                          <label className="po-field">
                            <span>Make</span>
                            <input name={`make-${index}`} value={draft.make} readOnly disabled placeholder="Auto-filled from BOQ" />
                          </label>

                          <label className="po-field">
                            <span>Model</span>
                            <input name={`model-${index}`} value={draft.model} readOnly disabled placeholder="Auto-filled from BOQ" />
                          </label>

                          <label className="po-field">
                            <span>Qty Ordered <span className="po-required-asterisk">*</span></span>
                            <input
                              type="number"
                              min="0"
                              name={`qty-${index}`}
                              value={draft.qty}
                              onChange={(event) => handleDetailsItemChange(index, "qty", event.target.value)}
                              placeholder="e.g. 10"
                            />
                          </label>

                          <label className="po-field">
                            <span>Unit Rate <span className="po-required-asterisk">*</span></span>
                            <input
                              type="number"
                              name={`rate-${index}`}
                              value={draft.rate}
                              readOnly
                              disabled={!draft.code}
                              placeholder={!draft.code ? "Select Item Code first" : "Auto-filled from BOQ"}
                            />
                          </label>

                          <label className="po-field">
                            <span>GST %</span>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="any"
                              name={`gstRate-${index}`}
                              value={draft.gstRate}
                              onChange={(event) => handleDetailsItemChange(index, "gstRate", event.target.value)}
                              placeholder="e.g. 18"
                            />
                          </label>

                          <label className="po-field po-field-span2">
                            <span>Item Description <span className="po-required-asterisk">*</span></span>
                            <input
                              name={`desc-${index}`}
                              value={draft.desc}
                              readOnly
                              disabled
                              placeholder="Auto-filled from BOQ"
                            />
                          </label>

                          <label className="po-field">
                            <span>Expected Delivery Date <span className="po-required-asterisk">*</span></span>
                            <DatePicker
                              value={draft.expectedDeliveryDate}
                              onChange={(date) => handleDetailsItemDateChange(index, "expectedDeliveryDate", date)}
                              ariaLabel={`Select expected delivery date for item ${index + 1}`}
                            />
                          </label>

                          <label className="po-field">
                            <span>Status <span className="po-required-asterisk">*</span></span>
                            <StatusDropdown
                              name={`status-${index}`}
                              value={draft.status}
                              options={STATUS_OPTIONS}
                              onChange={(event) => handleDetailsItemChange(index, "status", event.target.value)}
                              placeholder="Select status"
                            />
                          </label>
                        </div>

                        {totals && (
                          <div className="po-form-totals">
                            <span className="po-form-totals-item">
                              Subtotal: <strong>{fmtINR(subtotal)}</strong>
                            </span>
                            <span className="po-form-totals-item">
                              GST ({draft.gstRate || 18}%): <strong>{fmtINR(totals.gst)}</strong>
                            </span>
                            <span className="po-form-totals-item po-form-totals-final">
                              PO Value: <strong>{fmtINR(totals.value)}</strong>
                            </span>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </>
              ) : (
                <>
                  <section className="po-details-section">
                    <h3>PO Details</h3>
                    <div className="po-details-grid">
                      {PO_DETAIL_FIELDS.map((field) => (
                        <React.Fragment key={field.key}>
                          <div className="po-details-label">{field.label}</div>
                          <div className="po-details-value">
                            {formatDetailValue(field, previewDetailsRow)}
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </section>

                  <section className="po-details-section">
                    <h3>Delivery Details</h3>
                    <div className="po-details-grid">
                      {DELIVERY_DETAIL_FIELDS.map((field) => (
                        <React.Fragment key={field.key}>
                          <div className="po-details-label">{field.label}</div>
                          <div className="po-details-value">
                            {formatDetailValue(field, detailsRow)}
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </section>
                </>
              )}

              {(detailsEditMode || attachmentsOf(detailsRow).length > 0) && (
                detailsEditMode ? (
                  <div className="boq-item-card">
                    <div className="boq-item-card-header">
                      <span className="boq-item-number">Attachments</span>
                    </div>
                    <AttachmentsEditor
                      compact
                      readOnly={false}
                      files={editForm.attachments || []}
                      onChange={(attachments) =>
                        setEditForm((prev) => ({ ...prev, attachments: attachments || [] }))
                      }
                      label="Attach PO files"
                      uploadEndpoint={`${API_BASE_URL}/po-details/attachments/upload`}
                      disabled={detailsSaving}
                    />
                  </div>
                ) : (
                  <section className="po-details-section">
                    <h3>Attachments</h3>
                    <AttachmentsEditor
                      compact
                      readOnly
                      files={attachmentsOf(detailsRow)}
                      onChange={(attachments) =>
                        setEditForm((prev) => ({ ...prev, attachments: attachments || [] }))
                      }
                      label="Attach PO files"
                      uploadEndpoint={`${API_BASE_URL}/po-details/attachments/upload`}
                      disabled={detailsSaving}
                    />
                  </section>
                )
              )}
            </div>

            <div className="po-details-footer">
              {detailsEditMode ? (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={cancelEditingDetails}
                    disabled={detailsSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="create-btn"
                    onClick={handleSaveDetails}
                    disabled={detailsSaving}
                  >
                    {detailsSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                    {detailsSaving ? "Saving..." : "Save Changes"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={requestCloseDetails}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
