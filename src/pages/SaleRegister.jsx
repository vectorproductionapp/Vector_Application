import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import useDashboardDeepLink from "../components/useDashboardDeepLink";
import BackToDashboard from "../components/BackToDashboard";
import Swal from "sweetalert2";
import { createPortal } from "react-dom";
import { Plus, X, Save, Loader2, Pencil, Trash2, MoreVertical, Check, FileText, ArrowLeft } from "lucide-react";
import { SearchableSelect } from "../components/SearchBar";
import DateRangeFilter from "../components/DateRangeFilter";
import { useHeaderSearch } from "../context/HeaderSearch";
import GlobalSearchResults from "../components/GlobalSearchResults";
import FilterModal, { countActiveFilters, toFilterParams } from "../components/FilterModal";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import CardPagination, { useCardPagination } from "../components/CardPagination";
import StatusDropdown from "../components/StatusDropdown";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import { fmtINR } from "../data/mockData";
import { formatDate } from "../utils/date";
import { sortRows } from "../utils/tableSort";
import DatePicker from "../components/DatePicker";
import "./SaleRegister.css";
import "../components/StatusDropdown.css";

// Point this at wherever your backend is running/deployed.
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const SALES_API_URL = `${API_BASE_URL}/sales`;
const PAGE_SIZE = 10;

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
      container: "sale-swal-container",
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
      container: "sale-swal-container",
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
      container: "sale-swal-container",
      popup: "swal-vector-popup",
    },
  });

// ---- Full Sale Register columns. The table scrolls horizontally so all
// dispatch, invoice, warranty, and financial details remain available. ----
const columns = [
  { key: "clientPoDate", label: "Client PO Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "poNo", label: "Client PO No", mono: true },
  { key: "client", label: "Client Name" },
  { key: "clientContact", label: "Client Contact", mono: true },
  { key: "location", label: "Location" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial No", mono: true },
  { key: "qty", label: "Qty" },
  { key: "unitCost", label: "Unit Cost", format: (value) => value === "" || value === null || value === undefined ? "—" : fmtINR(value) },
  { key: "gstRate", label: "GST Rate", format: (value) => value === "" || value === null || value === undefined ? "—" : `${value}%` },
  { key: "value", label: "PO Value", format: (value) => value === "" || value === null || value === undefined ? "—" : fmtINR(value) },
  { key: "invoiceNumber", label: "Invoice Number", mono: true },
  { key: "invoiceDate", label: "Invoice Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "warrantyPeriod", label: "Warranty Period", format: (value) => value ? `${value} Year${Number(value) === 1 ? "" : "s"}` : "—" },
  { key: "warrantyStartDate", label: "Warranty Start Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "warrantyEndDate", label: "Warranty End Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "expectedDispatchDate", label: "Expected Dispatch Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "actualDispatchDate", label: "Actual Dispatch Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "endUserClient", label: "End Customer Name", format: (value) => value || "—" },
  { key: "endUserLocation", label: "End Customer Location", format: (value) => value || "—" },
  { key: "endUserPoNo", label: "End Customer PO No", format: (value) => value || "—" },
  { key: "endUserPoDate", label: "End Customer PO Date", format: (value) => value ? formatDateDisplay(value) : "—" },
  { key: "dispatch", label: "Dispatch Status", format: (value) => value || "—" },
];
// The Filter modal offers the fields a user picks a single value from. End User
// fields sit alongside the client ones because a sale carries both, and users
// narrow by either without having to read the row first.
//
// `dispatch` is listed explicitly rather than filtered out of `columns`: it is a
// row field the table shows inside the detail popup, not a visible column, so
// deriving the list from `columns` dropped it. That made the dashboard's "Sold
// Units" card deep-link (?field=dispatch&value=Delivered) fail validation and
// open the register unfiltered.
const SALE_FILTER_FIELDS = [
  ...columns.filter((column) =>
    ["client", "location", "model", "endUserClient", "endUserLocation"].includes(column.key)
  ),
  { key: "dispatch", label: "Dispatch Status" },
];

// Date columns the toolbar range can narrow. The endpoint takes the column name
// as `dateField`, so switching this select retargets the same two pickers.
//
// Only the dates a user actually fills in are offered. The table has no `date`
// column - the backend derives it from Client PO Date, so listing it here would
// just be a second name for the same value - and the warranty dates are
// computed from the invoice date, so they cannot be filtered independently.
const SALE_DATE_COLUMNS = [
  { key: "clientPoDate", label: "Client PO Date" },
  { key: "endUserPoDate", label: "End Customer PO Date" },
  { key: "expectedDispatchDate", label: "Expected Dispatch Date" },
  { key: "actualDispatchDate", label: "Actual Dispatch Date" },
  { key: "invoiceDate", label: "Invoice Date" },
];

// A sale leaves the warehouse once it is delivered, so that is the final state
// this register offers.  Sales saved before the rename still carry "Dispatched";
// the dropdown keeps showing that stored value so old rows stay readable.
const DISPATCH_OPTIONS = ["Pending", "Processing", "Delivered"];
// Current Indian GST rate structure: Nil, 5%, 18%, and the 40% special rate
// for specified luxury/demerit goods and services.
const GST_RATE_OPTIONS = [0, 5, 18, 28];

// ---- Warranty Period options (in years) ----
const WARRANTY_YEAR_OPTIONS = [1, 2, 3, 4, 5];

// ---- View popup field groups ----
// `editable: true` fields become inputs in edit mode. `autoComputed: true`
// fields are never directly editable  they're derived live from other
// fields while editing (see the warranty-sync effect below).
const EXISTING_DETAIL_FIELDS = [
  { key: "date", label: "Date", isDate: true, editable: true, type: "date" },
  { key: "poNo", label: "Client PO No", editable: true },
  { key: "client", label: "Client Name", editable: true },
  { key: "clientContact", label: "Client Contact", editable: true, type: "tel" },
  { key: "location", label: "Location", editable: true },
  { key: "model", label: "Model", editable: true },
  { key: "serialNumbers", label: "Serial Nos", editable: true },
  { key: "qty", label: "Qty", editable: true, type: "number" },
  { key: "value", label: "PO Value (incl. GST)", isCurrency: true, autoComputed: true },
];

const DISPATCH_DETAIL_FIELDS = [
  { key: "clientPoDate", label: "Client PO Date", isDate: true, editable: true, type: "date" },
  { key: "expectedDispatchDate", label: "Expected Dispatch Date", isDate: true, editable: true, type: "date" },
  { key: "actualDispatchDate", label: "Actual Dispatch Date", isDate: true, editable: true, type: "date" },
  { key: "dispatch", label: "Dispatch Status", editable: true, type: "select" },
  { key: "invoiceNumber", label: "Invoice Number", editable: true },
  { key: "invoiceDate", label: "Invoice Date", isDate: true, editable: true, type: "date" },
];

const WARRANTY_DETAIL_FIELDS = [
  { key: "warrantyPeriod", label: "Warranty Period", isWarrantyYears: true, editable: true, type: "select" },
  { key: "warrantyStartDate", label: "Warranty Start Date", isDate: true, autoComputed: true },
  { key: "warrantyEndDate", label: "Warranty End Date", isDate: true, autoComputed: true },
];

const FINANCIAL_DETAIL_FIELDS = [
  { key: "unitCost", label: "Unit Cost", isCurrency: true, editable: true, type: "number" },
  { key: "gstRate", label: "GST Rate", editable: true, type: "select" },
];

const END_USER_DETAIL_FIELDS = [
  { key: "endUserClient", label: "End Customer Name", editable: true },
  { key: "endUserLocation", label: "End Customer Location", editable: true },
  { key: "endUserPoNo", label: "End Customer PO No", editable: true },
  { key: "endUserPoDate", label: "End Customer PO Date", isDate: true, editable: true, type: "date" },
  
];

// Fields shared by every line of one Client PO. Editing them from the PO card
// writes the new value to each of that PO's sale lines, so the card and the
// table inside it stay in agreement.
const PO_CARD_EDIT_FIELDS = [
  { key: "clientPoDate", label: "Client PO Date", type: "date" },
  { key: "poNo", label: "Client PO No" },
  { key: "client", label: "Client Name" },
  { key: "location", label: "Location" },
  ...END_USER_DETAIL_FIELDS.map(({ key, label, type }) => ({ key, label, type })),
];

const emptySaleForm = {
  poNo: "",
  client: "",
  clientContact: "",
  location: "",
  modelId: "",
  model: "",
  serial: "",
  serialNumbers: [""],
  qty: "",
  dispatch: "Pending",
  value: "",
  date: "",
  clientPoDate: "",
  expectedDispatchDate: "",
  actualDispatchDate: "",
  invoiceNumber: "",
  invoiceDate: "",
  unitCost: "",
  gstRate: "",
  warrantyPeriod: "",
  warrantyStartDate: "",
  warrantyEndDate: "",
  endUserClient: "",
  endUserLocation: "",
  endUserPoDate: "",
  endUserPoNo: "",
};

const REQUIRED_FIELDS = [
  { name: "poNo", label: "Client PO No" },
  { name: "clientPoDate", label: "Client PO Date" },
  { name: "client", label: "Client Name" },
  { name: "clientContact", label: "Client Contact" },
  { name: "location", label: "Location" },
  { name: "model", label: "Model" },
  { name: "qty", label: "Qty" },
  { name: "dispatch", label: "Dispatch Status" },
  { name: "unitCost", label: "Unit Cost" },
  { name: "gstRate", label: "GST Rate" },
  { name: "value", label: "PO Value" },
  { name: "invoiceNumber", label: "Invoice Number" },
  { name: "invoiceDate", label: "Invoice Date" },
  { name: "warrantyPeriod", label: "Warranty Period" },
  { name: "warrantyStartDate", label: "Warranty Start Date" },
  { name: "expectedDispatchDate", label: "Expected Dispatch Date" },
  { name: "actualDispatchDate", label: "Actual Dispatch Date" },
];

function validateSaleForm(values, { validateSerials = true } = {}) {
  const missing = REQUIRED_FIELDS.filter(
    ({ name }) => !String(values[name] ?? "").trim()
  );

  if (missing.length) {
    return `Please fill in: ${missing.map((field) => field.label).join(", ")}.`;
  }

  if (!/^\d{10}$/.test(String(values.clientContact))) {
    return "Client Contact must contain exactly 10 digits.";
  }

  if (values.qty && Number.isNaN(Number(values.qty))) {
    return "Qty must be a number.";
  }

  if (validateSerials) {
    const qty = Number(values.qty);
    const serialNumbers = Array.isArray(values.serialNumbers) ? values.serialNumbers : [];
    if (!Number.isInteger(qty) || qty < 1) return "Qty must be a whole number greater than zero.";
    if (serialNumbers.length !== qty) return `Please enter exactly ${qty} Serial Number(s).`;
    if (serialNumbers.some((serial) => !String(serial).trim())) return "Every Serial Number is required.";
    if (new Set(serialNumbers.map((serial) => String(serial).trim().toLowerCase())).size !== serialNumbers.length) {
      return "Duplicate Serial Numbers are not allowed.";
    }
  }

  if (values.value && Number.isNaN(Number(values.value))) {
    return "PO Value must be a number.";
  }

  if (values.unitCost && Number.isNaN(Number(values.unitCost))) {
    return "Unit Cost must be a number.";
  }

  return null;
}

function serialFieldsChanged(values, original) {
  if (!original) return true;
  const currentSerials = (values.serialNumbers || []).map((value) => String(value).trim());
  const originalSerials = (original.serialNumbers || []).map((value) => String(value).trim());
  return Number(values.qty) !== Number(original.qty) || JSON.stringify(currentSerials) !== JSON.stringify(originalSerials);
}

function calculatePoValue(unitCost, qty, gstRate) {
  if ([unitCost, qty, gstRate].some((value) => String(value ?? "").trim() === "")) return "";

  const cost = Number(unitCost);
  const quantity = Number(qty);
  const gst = Number(gstRate);
  if (![cost, quantity, gst].every(Number.isFinite) || cost < 0 || quantity < 0 || gst < 0) return "";

  return (cost * quantity * (1 + gst / 100)).toFixed(2);
}

// Converts any stored date value (ISO timestamp, "YYYY-MM-DD", etc.) into
// the "YYYY-MM-DD" shape a <input type="date"> needs.
function toDateInputValue(value) {
  if (!value) return "";
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

// ---- Warranty calculation helpers ----
// Warranty Start Date is auto-set to equal the Invoice Date (the date the
// sale was invoiced), since that's the date warranty coverage begins.
// Warranty End Date = Invoice Date + Warranty Period (years), minus one day,
// so that coverage expires at 23:59 on the day *before* the anniversary.
// Example: 08-10-2026 + 3 years -> expires 07-10-2029 23:59, not 08-10-2029.
// All arithmetic is done in UTC because the date strings are "YYYY-MM-DD",
// which `new Date()` parses as UTC midnight; using the local setters would
// shift the result by a day in timezones behind UTC.
function shiftDate(dateStr, { years = 0, days = 0 } = {}) {
  if (!dateStr) return "";
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return "";
  const result = new Date(parsed.getTime());
  if (years) result.setUTCFullYear(result.getUTCFullYear() + Number(years));
  if (days) result.setUTCDate(result.getUTCDate() + Number(days));
  if (Number.isNaN(result.getTime())) return "";
  return result.toISOString().slice(0, 10);
}

function addYearsToDate(dateStr, years) {
  if (!dateStr || !years) return "";
  return shiftDate(dateStr, { years });
}

// Exported so an eventual "Edit Sale" flow can reuse the exact same logic.
export function calculateWarrantyDates(invoiceDate, warrantyPeriod) {
  const warrantyStartDate = invoiceDate || "";
  const anniversary =
    invoiceDate && warrantyPeriod ? addYearsToDate(invoiceDate, warrantyPeriod) : "";
  const warrantyEndDate = anniversary ? shiftDate(anniversary, { days: -1 }) : "";
  return { warrantyStartDate, warrantyEndDate };
}

// ---- View popup formatting helpers ----
function formatDateDisplay(value) {
  return formatDate(value, "Not Provided");
}

function formatDetailValue(field, row) {
  const raw = row[field.key];
  if (field.key === "serialNumbers") {
    const values = Array.isArray(row.serialNumbers) ? row.serialNumbers : String(row.serial || "").split(",").map((value) => value.trim()).filter(Boolean);
    return values.length ? values.join("\n") : "Not Provided";
  }
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return "Not Provided";
  }
  if (field.isDate) return formatDateDisplay(raw);
  if (field.isCurrency) return fmtINR(raw);
  if (field.isWarrantyYears) {
    const n = Number(raw);
    return Number.isFinite(n) ? `${n} Year${n === 1 ? "" : "s"}` : String(raw);
  }
  return String(raw);
}

// Builds the edit-mode form state from a row, converting dates into the
// "YYYY-MM-DD" shape <input type="date"> expects.
function buildEditValues(row, isCustomerSale = false) {
  if (!row) return {};
  return {
    date: toDateInputValue(row.date || row.clientPoDate),
    poNo: row.poNo || "",
    client: row.client || "",
    clientContact: row.clientContact || "",
    location: row.location || "",
    modelId: row.modelId || "",
    model: row.model || "",
    serial: row.serial || "",
    serialNumbers: Array.isArray(row.serialNumbers) && row.serialNumbers.length
      ? row.serialNumbers
      : (row.serial ? String(row.serial).split(",").map((value) => value.trim()).filter(Boolean) : []),
    qty: row.qty ?? "",
    value: row.value ?? "",
    clientPoDate: toDateInputValue(row.clientPoDate),
    expectedDispatchDate: toDateInputValue(row.expectedDispatchDate),
    actualDispatchDate: toDateInputValue(row.actualDispatchDate),
    dispatch: row.dispatch || "Pending",
    invoiceNumber: row.invoiceNumber || "",
    invoiceDate: toDateInputValue(row.invoiceDate),
    unitCost: row.unitCost ?? "",
    gstRate: row.gstRate ?? "",
    warrantyPeriod: row.warrantyPeriod ?? "",
    warrantyStartDate: toDateInputValue(row.warrantyStartDate),
    warrantyEndDate: toDateInputValue(row.warrantyEndDate),
    endUserClient: row.endUserClient || "",
    endUserLocation: row.endUserLocation || "",
    endUserPoDate: toDateInputValue(row.endUserPoDate),
    endUserPoNo: row.endUserPoNo || "",
  };
}

function getRowId(row) {
  return row?._id || row?.id || null;
}

// Renders either the read-only formatted value or, in edit mode, the right
// input type for that field (text / number / date / select).
function serialOptionsForIndex(options, selectedSerials, currentIndex) {
  const selectedElsewhere = new Set(
    (selectedSerials || [])
      .filter((_, index) => index !== currentIndex)
      .map((serial) => String(serial).trim().toLowerCase())
      .filter(Boolean)
  );
  return options.filter((option) => !selectedElsewhere.has(String(option.value).toLowerCase()));
}

function renderDetailField(
  field,
  row,
  editValues,
  onChange,
  isEditing,
  modelOptions = [],
  modelsLoading = false,
  serialOptions = [],
  serialsLoading = false
) {
  if (isEditing && field.autoComputed) {
    const raw = editValues[field.key];
    return (
      <div className="sale-details-value sale-details-value-computed">
        {raw === "" || raw === null || raw === undefined
          ? "Not Provided"
          : field.isCurrency
            ? fmtINR(raw)
            : field.isDate
              ? formatDateDisplay(raw)
              : String(raw)}
      </div>
    );
  }

  if (!isEditing || !field.editable) {
    return <div className="sale-details-value">{formatDetailValue(field, row)}</div>;
  }

  const value = editValues[field.key] ?? "";

  if (field.isDate) {
    return <DatePicker value={value} onChange={(date) => onChange({ target: { name: field.key, value: date } })} ariaLabel={`Select ${field.label}`} popoverZIndex={130000} />;
  }

  if (field.key === "model") {
    return (
      <SearchableSelect
        options={modelOptions}
        value={value}
        onChange={(model) => onChange({ target: { name: "model", value: model } })}
        placeholder="Select Model"
        loading={modelsLoading}
        emptyMessage="No Models found"
      />
    );
  }

  if (field.key === "serialNumbers") {
    const serialNumbers = Array.isArray(editValues.serialNumbers) ? editValues.serialNumbers : [];
    return (
      <div className="sale-serial-edit-list">
        {serialNumbers.map((serial, index) => (
          <SearchableSelect
            key={index}
            options={serialOptionsForIndex(serialOptions, serialNumbers, index)}
            value={serial}
            onChange={(selectedSerial) => onChange({ target: { name: `serialNumbers.${index}`, value: selectedSerial } })}
            placeholder={`Select Serial No ${index + 1}`}
            disabled={!editValues.model || serialsLoading}
            loading={serialsLoading}
            emptyMessage="No in-stock serials for this model"
          />
        ))}
      </div>
    );
  }

  if (field.type === "select") {
    if (field.key === "dispatch") {
      return (
        <StatusDropdown
          name={field.key}
          value={value}
          options={DISPATCH_OPTIONS}
          onChange={onChange}
          placeholder="Select dispatch status"
        />
      );
    }

    if (field.key === "warrantyPeriod") {
      return (
        <StatusDropdown
          name={field.key}
          value={value}
          options={WARRANTY_YEAR_OPTIONS}
          onChange={onChange}
          placeholder="Select warranty period"
          formatLabel={(y) => `${y} Year${y > 1 ? "s" : ""}`}
        />
      );
    }

    if (field.key === "gstRate") {
      return (
        <StatusDropdown
          name={field.key}
          value={value === "" ? "" : Number(value)}
          options={GST_RATE_OPTIONS}
          onChange={onChange}
          placeholder="Select GST rate"
          formatLabel={(rate) => rate === 0 ? "Nil (0%)" : `${rate}%`}
        />
      );
    }
  }

  return (
    <input
      className="sale-details-edit-input"
      type={field.type === "number" ? "number" : field.type === "tel" ? "tel" : "text"}
      name={field.key}
      value={value}
      onChange={onChange}
      min={field.type === "number" ? 0 : undefined}
      inputMode={field.type === "tel" ? "numeric" : undefined}
      pattern={field.type === "tel" ? "[0-9]{10}" : undefined}
      maxLength={field.type === "tel" ? 10 : undefined}
    />
  );
}

export default function SaleRegister() {
  const [query] = useHeaderSearch("sale-register", "Search Sale Register...");
  // One entry per filterable field; a missing key means "All" for that field.
  const [rowFilters, setRowFilters] = useState({});

  // A dashboard KPI card can deep-links here with `?field=<key>&value=<v>` to
  // open the register already narrowed (e.g. Sold Units -> dispatch=Delivered).
  const arrivedFromDashboard = useDashboardDeepLink(
    SALE_FILTER_FIELDS,
    (patch) => setRowFilters((prev) => ({ ...prev, ...patch }))
  );
  const [filterOptions, setFilterOptions] = useState({});
  const [rows, setRows] = useState([]);
  // Every sale matching the active search/filters/date range, not just the page
  // on screen. Used only by the export so a filtered export is complete.
  const [exportRows, setExportRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
const [totalCount, setTotalCount] = useState(0);
  // Money/qty totals for the whole filtered result set, not just this page.
  const [salesTotals, setSalesTotals] = useState(null);
  // ---------- Selected PO No filter (card click to show PO details) ----------
  const [selectedPoNo, setSelectedPoNo] = useState("");
  // PO card edit: { poNo, original, values } while the dialog is open.
  const [poEdit, setPoEdit] = useState(null);
  const [poEditSaving, setPoEditSaving] = useState(false);
  const [poEditError, setPoEditError] = useState("");
  // ---------- Client PO Date range filter ----------
  // Draft values live in the pickers; Apply promotes them to the applied values
  // the request is built from.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [appliedFromDate, setAppliedFromDate] = useState("");
  const [appliedToDate, setAppliedToDate] = useState("");
  const [dateRangeError, setDateRangeError] = useState("");
  // Which date column the two pickers narrow. Kept separate from the applied
  // values so switching columns mid-edit does not refetch.
  const [dateColumn, setDateColumn] = useState("clientPoDate");

  useEffect(() => {
    setDateRangeError(
      fromDate && toDate && toDate < fromDate ? "End Date cannot be earlier than Start Date." : ""
    );
  }, [fromDate, toDate]);

  const isDateRangeActive = Boolean(appliedFromDate || appliedToDate);

  // The pickers are labelled with whichever column the select is pointing at, so
  // it is always obvious which date the range is about to narrow.
  const activeDateColumnLabel =
    SALE_DATE_COLUMNS.find((option) => option.key === dateColumn)?.label || "Client PO Date";

  const [modalOpen, setModalOpen] = useState(false);
  const [customerSaleParent, setCustomerSaleParent] = useState(null);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptySaleForm);
  const initialFormValuesRef = useRef(emptySaleForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const [availableSerials, setAvailableSerials] = useState([]);
  const [serialsLoading, setSerialsLoading] = useState(false);
  const [serialsError, setSerialsError] = useState("");
  const [editAvailableSerials, setEditAvailableSerials] = useState([]);
  const [editSerialsLoading, setEditSerialsLoading] = useState(false);
  const modelOptions = useMemo(
    () => models.map((model) => ({ value: model.name, label: model.name })),
    [models]
  );
  const availableSerialOptions = useMemo(
    () => availableSerials.map((unit) => ({ value: unit.serial, label: unit.serial })),
    [availableSerials]
  );
  const editAvailableSerialOptions = useMemo(
    () => editAvailableSerials.map((unit) => ({ value: unit.serial, label: unit.serial })),
    [editAvailableSerials]
  );

  // ---- Date range filter state ----

  // ---- View Details popup state ----
  const [detailsRow, setDetailsRow] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsClosing, setDetailsClosing] = useState(false);

  // ---- View Details EDIT MODE state ----
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [editValues, setEditValues] = useState({});
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [customerSaleDetailsParent, setCustomerSaleDetailsParent] = useState(null);

  // ---- Bulk-select / delete state (same pattern as BOQ / PO Details) ----
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  // ---- Mobile kebab menu state ----
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadModels = async () => {
      try {
        setModelsError("");
        const response = await api.get(`${API_BASE_URL}/models`);
        if (!response.data.success) throw new Error(response.data.message || "Failed to load models");
        if (!cancelled) setModels(response.data.models || []);
      } catch (error) {
        if (!cancelled) {
          setModels([]);
          setModelsError(error.response?.data?.message || error.message || "Failed to load models");
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };

    loadModels();
    return () => { cancelled = true; };
  }, []);

  const loadAvailableSerials = useCallback(async ({ modelId = "", model = "", excludeSaleId = "", editing = false } = {}) => {
    const setLoading = editing ? setEditSerialsLoading : setSerialsLoading;
    const setOptions = editing ? setEditAvailableSerials : setAvailableSerials;
    if (!modelId && !model) {
      setOptions([]);
      if (!editing) setSerialsError("");
      return;
    }

    setLoading(true);
    if (!editing) setSerialsError("");
    try {
      const response = await api.get(`${API_BASE_URL}/sales/available-serials`, {
        params: { modelId: modelId || undefined, model: model || undefined, excludeSaleId: excludeSaleId || undefined },
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to load serial numbers");
      setOptions(response.data.serials || []);
    } catch (error) {
      setOptions([]);
      if (!editing) setSerialsError(error.response?.data?.message || error.message || "Failed to load serial numbers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    loadAvailableSerials({ modelId: formValues.modelId, model: formValues.model, excludeSaleId: getRowId(customerSaleParent) });
  }, [modalOpen, formValues.modelId, formValues.model, customerSaleParent, loadAvailableSerials]);

  useEffect(() => {
    if (!isEditingDetails || !detailsRow) return;
    loadAvailableSerials({
      modelId: editValues.modelId,
      model: editValues.model,
      excludeSaleId: getRowId(detailsRow),
      editing: true,
    });
  }, [isEditingDetails, detailsRow, editValues.modelId, editValues.model, loadAvailableSerials]);

  const openDetails = (row) => {
    setCustomerSaleDetailsParent(null);
    setDetailsRow(row);
    setEditValues(buildEditValues(row));
    setIsEditingDetails(false);
    setDetailsError("");
    setDetailsClosing(false);
    setDetailsOpen(true);
  };

  const requestCloseDetails = useCallback(async (skipConfirmation = false) => {
    if (detailsClosing) return;
    if (skipConfirmation !== true && isEditingDetails && JSON.stringify(editValues) !== JSON.stringify(buildEditValues(detailsRow))) {
      const result = await swalConfirm({
        title: "Discard unsaved changes?",
        text: "Your sale changes will be lost unless you save them.",
        confirmText: "Discard changes",
      });
      if (!result.isConfirmed) return;
    }
    setDetailsClosing(true);
    setTimeout(() => {
      setDetailsOpen(false);
      setDetailsClosing(false);
      setDetailsRow(null);
      setIsEditingDetails(false);
      setEditValues({});
      setDetailsError("");
      setCustomerSaleDetailsParent(null);
    }, 200);
  }, [detailsClosing, isEditingDetails, editValues, detailsRow]);

  useEffect(() => {
    if (!detailsOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") requestCloseDetails();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [detailsOpen, requestCloseDetails]);

  const startEditDetails = () => {
    if (!detailsRow) return;
    setEditValues(buildEditValues(detailsRow));
    setDetailsError("");
    setIsEditingDetails(true);
  };

  const cancelEditDetails = () => {
    setEditValues(buildEditValues(detailsRow));
    setDetailsError("");
    setIsEditingDetails(false);
  };

  const handleEditChange = (event) => {
    const { name, value } = event.target;
    if (name.startsWith("serialNumbers.")) {
      const index = Number(name.split(".")[1]);
      setEditValues((prev) => {
        const serialNumbers = [...(prev.serialNumbers || [])];
        serialNumbers[index] = value;
        return { ...prev, serialNumbers, serial: serialNumbers.join(", ") };
      });
      return;
    }
    setEditValues((prev) => {
      const nextValue = name === "clientContact" ? value.replace(/\D/g, "").slice(0, 10) : value;
      const next = { ...prev, [name]: nextValue };
      if (name === "model") {
        const selectedModel = models.find((model) => model.name === value);
        next.modelId = selectedModel?.id || "";
        const qty = Math.max(0, Number(prev.qty) || 0);
        next.serialNumbers = Array.from({ length: qty }, () => "");
        next.serial = "";
      }
      if (name === "qty") {
        const qty = Math.max(0, Number(value) || 0);
        next.serialNumbers = [...(prev.serialNumbers || [])].slice(0, qty);
        while (next.serialNumbers.length < qty) next.serialNumbers.push("");
        next.serial = next.serialNumbers.join(", ");
      }
      if (["unitCost", "qty", "gstRate"].includes(name)) {
        next.value = calculatePoValue(next.unitCost, next.qty, next.gstRate);
      }
      return next;
    });
  };

  // ---- Keep Warranty Start/End Date in sync while editing ----
  // Auto-calc source: Invoice Date (see note above calculateWarrantyDates()).
  useEffect(() => {
    if (!isEditingDetails) return;
    setEditValues((prev) => {
      const { warrantyStartDate, warrantyEndDate } = calculateWarrantyDates(
        prev.invoiceDate,
        prev.warrantyPeriod
      );
      if (
        prev.warrantyStartDate === warrantyStartDate &&
        prev.warrantyEndDate === warrantyEndDate
      ) {
        return prev;
      }
      return { ...prev, warrantyStartDate, warrantyEndDate };
    });
  }, [isEditingDetails, editValues.invoiceDate, editValues.warrantyPeriod]);

  const handleSaveDetails = async () => {
    if (!detailsRow || detailsSaving) return;

    const id = getRowId(detailsRow);
    if (!id) {
      setDetailsError("Missing record identifier; cannot save changes.");
      return;
    }

    const error = validateSaleForm(editValues, {
      validateSerials: serialFieldsChanged(editValues, detailsRow),
    });
    if (error) {
      setDetailsError(error);
      return;
    }

    setDetailsSaving(true);
    setDetailsError("");

    try {
      const res = await api.put(customerSaleDetailsParent ? `/sales/${id}/customer-sale` : `/sales/${id}`, {
          ...editValues,
          date: editValues.date || editValues.clientPoDate,
          warrantyPeriod: editValues.warrantyPeriod ? Number(editValues.warrantyPeriod) : "",
      });
      const payload = res.data;
      if (!payload.success) {
        throw new Error(payload.message || "Unable to update sale");
      }

      const { success, message, ...updatedRow } = payload;

      if (customerSaleDetailsParent) {
        setRows((prev) => prev.map((row) => getRowId(row) === id ? { ...row, customerSale: payload.customerSale } : row));
        setDetailsRow((prev) => ({ ...prev, ...payload.customerSale }));
        requestCloseDetails(true);
        swalSuccess("Customer sale updated", "The customer sale has been updated successfully.");
        return;
      }

      setRows((prev) =>
        prev.map((r) => (getRowId(r) === id ? { ...r, ...updatedRow } : r))
      );
      setDetailsRow((prev) => ({ ...prev, ...updatedRow }));
      requestCloseDetails(true);
      swalSuccess("Sale updated", "The sale has been updated successfully.");
    } catch (err) {
      const msg = err.message || "Failed to update sale. Please try again.";
      setDetailsError(msg);
      swalError("Update failed", msg);
    } finally {
      setDetailsSaving(false);
    }
  };

  // ---- Fetch existing sales from the backend on mount ----
  const fetchRows = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setLoading(false);
    setLoadError("");
    const pageToFetch = targetPage ?? page;

    try {
      // Search and PageFilter run on the server. Filtering here instead used to
      // match only the rows the API had just paged back, so a search or a
      // dropdown selection silently missed every other page.
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);
      toFilterParams(rowFilters, SALE_FILTER_FIELDS).forEach((value, key) => params.append(key, value));

      // Date range over the selected column. This page carries many dates per sale,
      // so the column being narrowed is named explicitly rather than guessed.
      if (isDateRangeActive) {
        params.set("dateField", dateColumn);
        if (appliedFromDate) {
          params.append("filterField", "dateFrom");
          params.append("filterValue", appliedFromDate);
        }
        if (appliedToDate) {
          params.append("filterField", "dateTo");
          params.append("filterValue", appliedToDate);
        }
      }

      const res = await api.get(`${SALES_API_URL}?${params.toString()}`);
      const data = res.data;
      if (!data.success) {
        throw new Error(data.message || `Server responded with ${res.status}`);
      }
      setRows(data.sales || []);
      // Falls back to the page when an older backend omits the full set.
      setExportRows(data.allRows || data.sales || []);
      setFilterOptions(data.filterOptions || {});
      // Totals cover every matching sale, so they still read correctly while the
      // user sits on page 2+.
      setSalesTotals(data.totals || null);
      const pagination = data.pagination;
      if (pagination) {
        setTotalPages(pagination.totalPages || 1);
        setTotalCount(pagination.totalCount || 0);
        if (pagination.page !== pageToFetch) setPage(pagination.page);
      } else {
        setTotalPages(1);
        setTotalCount(data.sales?.length || 0);
      }
    } catch (err) {
      setLoadError("Could not load data");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, pageSize, query, rowFilters, isDateRangeActive, appliedFromDate, appliedToDate, dateColumn]);

  // Changing a filter has to restart at page 1, otherwise narrowing the result
  // set leaves the user parked on a page that no longer exists.
  const filterKey = `${query.trim()}|${JSON.stringify(rowFilters)}|${dateColumn}:${appliedFromDate}:${appliedToDate}`;
  const prevFilterKeyRef = useRef(filterKey);

  useEffect(() => {
    const filtersChanged = prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;
    if (filtersChanged && page !== 1) {
      setPage(1);
      return;
    }
    fetchRows({ targetPage: filtersChanged ? 1 : page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filterKey]);

  // Sale writes arrive as a WebSocket notice and refresh the table quietly.
  // Skipped while the add/edit form or the details editor is open.
  useRealtime(["sales"], () => fetchRows({ silent: true }), {
    guard: () => !(modalOpen || saving || isEditingDetails || detailsSaving || poEdit || poEditSaving),
  });

  // The API already applied the search and PageFilter to the whole register, so
  // the server response is authoritative. Re-filtering here would only risk
  // hiding a row the server matched whenever the two key lists drift apart.
  // Every sale line matching the search/filters (the server sends the whole
  // set as `allRows`), not just the table's current page. The PO cards are
  // built from it so a PO whose lines sit on page 2+ still gets a card, and an
  // opened PO lists all of its lines.
  const allMatchingRows = exportRows.length ? exportRows : rows;
  const filteredRows = useMemo(() => {
    if (!selectedPoNo) return rows;
    return allMatchingRows.filter((row) => row.poNo && row.poNo.toString() === selectedPoNo);
  }, [rows, allMatchingRows, selectedPoNo]);

  // One card per Client PO No, the way PO Details lists its POs. Rows are built
  // from the server page the table shows, so each card totals exactly the lines
  // that table can list for that PO - clicking the card never promises more.
  //
  // The money split mirrors the backend (`_calculate_po_value` plus the totals
  // loop in salesregister.py): base = unitCost * qty, gst is the tax slice of
  // that base, and the inclusive figure is the stored `value`.
  const poCards = useMemo(() => {
    const cards = [];
    const byPoNo = new Map();

    allMatchingRows.forEach((row) => {
      const raw = row.poNo === null || row.poNo === undefined ? "" : String(row.poNo).trim();
      const poNo = raw || "—";
      let card = byPoNo.get(poNo);
      if (!card) {
        card = { poNo, clientPoDate: "", client: "", endUserClient: "", endUserPoNo: "", qty: 0, base: 0, gst: 0, total: 0, rowCount: 0 };
        byPoNo.set(poNo, card);
        cards.push(card);
      }
      const unitCost = Number(row.unitCost) || 0;
      const qty = Number(row.qty) || 0;
      const base = unitCost * qty;
      card.qty += qty;
      card.base += base;
      card.gst += (base * (Number(row.gstRate) || 0)) / 100;
      card.total += Number(row.value) || 0;
      card.rowCount += 1;
      if (!card.clientPoDate && row.clientPoDate) card.clientPoDate = row.clientPoDate;
      if (!card.client && row.client) card.client = row.client;
      if (!card.endUserClient && row.endUserClient) card.endUserClient = row.endUserClient;
      if (!card.endUserPoNo && row.endUserPoNo) card.endUserPoNo = row.endUserPoNo;
    });

    return cards;
  }, [allMatchingRows]);
  const { pageItems: pagedPoCards, pagerProps: poCardPager } = useCardPagination(poCards, filterKey);

  const samePoNo = (row, poNo) => String(row?.poNo ?? "").trim() === String(poNo ?? "").trim();

  const openPoEdit = (card) => {
    const source = allMatchingRows.find((row) => samePoNo(row, card.poNo === "—" ? "" : card.poNo)) || {};
    const values = Object.fromEntries(
      PO_CARD_EDIT_FIELDS.map(({ key }) => [key, source[key] ?? ""])
    );
    setPoEditError("");
    setPoEdit({ poNo: card.poNo === "—" ? "" : card.poNo, original: values, values });
  };

  const closePoEdit = () => {
    if (poEditSaving) return;
    setPoEdit(null);
    setPoEditError("");
  };

  // Writes the changed PO fields to every sale line of that PO. The card only
  // totals the current page, so all of the PO's lines are fetched first; a PO
  // whose lines span pages is still updated in full.
  const savePoEdit = async () => {
    if (!poEdit || poEditSaving) return;
    const changes = Object.fromEntries(
      PO_CARD_EDIT_FIELDS
        .map(({ key }) => key)
        .filter((key) => String(poEdit.values[key] ?? "").trim() !== String(poEdit.original[key] ?? "").trim())
        .map((key) => [key, String(poEdit.values[key] ?? "").trim()])
    );
    if (!Object.keys(changes).length) {
      setPoEditError("No changes to update.");
      return;
    }
    if ("poNo" in changes && !changes.poNo) {
      setPoEditError("Client PO No cannot be empty.");
      return;
    }

    setPoEditSaving(true);
    setPoEditError("");
    try {
      const lookup = await api.get(SALES_API_URL, {
        params: { q: poEdit.poNo, page: 1, limit: 100, _fresh: Date.now() },
      });
      const found = [...(lookup.data?.allRows || []), ...(lookup.data?.sales || [])];
      const byId = new Map();
      found.filter((row) => samePoNo(row, poEdit.poNo)).forEach((row) => {
        const id = getRowId(row);
        if (id) byId.set(id, row);
      });
      if (!byId.size) throw new Error(`No sale lines found for Client PO ${poEdit.poNo}.`);

      for (const id of byId.keys()) {
        const res = await api.put(`${SALES_API_URL}/${id}`, changes);
        if (!res.data?.success) throw new Error(res.data?.message || "Failed to update the sale line.");
      }

      // Keep an opened PO open under its new number.
      if ("poNo" in changes && selectedPoNo === poEdit.poNo) setSelectedPoNo(changes.poNo);
      setPoEditSaving(false);
      setPoEdit(null);
      await fetchRows({ silent: true });
      await swalSuccess(
        "PO Updated",
        `${byId.size} sale line${byId.size === 1 ? "" : "s"} of this PO ${byId.size === 1 ? "was" : "were"} updated.`
      );
    } catch (err) {
      setPoEditSaving(false);
      setPoEditError(err?.response?.data?.message || err?.message || "Could not update this PO.");
      // Lines saved before a failure are already changed, so refresh to show them.
      fetchRows({ silent: true });
    }
  };

  const filtersActive = Boolean(query.trim()) || countActiveFilters(rowFilters) > 0 || isDateRangeActive;

  // New records are stored one document per serial. This expansion remains
  // for legacy combined records and supplies only the selected serial to the
  // edit form so saving it can split the old document safely.
  const expandSerials = useMemo(
    () => (list) => list.flatMap((row) => {
      const serialNumbers = Array.isArray(row.serialNumbers) && row.serialNumbers.length
        ? row.serialNumbers
        : String(row.serial || "").split(",").map((value) => value.trim()).filter(Boolean);
      if (serialNumbers.length <= 1) return [{ ...row, serial: serialNumbers[0] || row.serial || "" }];
      const perUnitValue = Number(row.value || 0) / serialNumbers.length;
      return serialNumbers.map((serial) => ({
        ...row,
        serial,
        serialNumbers: [serial],
        qty: 1,
        value: perUnitValue,
      }));
    }),
    []
  );

  const serialDisplayRows = useMemo(() => expandSerials(filteredRows), [expandSerials, filteredRows]);
  // Export covers the whole result set by default, but once a PO card is open the
  // user is looking at one PO, so the file follows the table instead of silently
  // dumping every other PO as well.
  const exportDisplayRows = useMemo(
    () => expandSerials(selectedPoNo ? filteredRows : exportRows),
    [expandSerials, filteredRows, exportRows, selectedPoNo]
  );

  // Which column header the user sorted by. DataTable owns the interaction and
  // reports it back, so the export can be written in the order on screen.
  const [tableSort, setTableSort] = useState(null);

  const exportTableRows = useMemo(
    () => sortRows(exportDisplayRows, columns, tableSort),
    [exportDisplayRows, tableSort]
  );

  // Server-computed over every sale that matches the active search/PageFilter, so
  // the Total box describes the whole result set rather than just the ten rows
  // currently on screen.  Null means "nothing to report", which hides that part.
  //
  // Once a PO card is open the server figure would cover the whole register while
  // the table lists one PO, so the card's own totals take over and the box keeps
  // describing exactly what is on screen.
  const tableTotals = useMemo(() => {
    if (selectedPoNo) {
      const card = poCards.find((entry) => entry.poNo === selectedPoNo);
      if (!card) return { totalQty: null, totalBasic: null, totalGst: null, totalInclGst: null };
      return {
        totalQty: card.qty > 0 ? card.qty : null,
        totalBasic: card.base > 0 ? card.base : null,
        totalGst: card.gst > 0 ? card.gst : null,
        totalInclGst: card.total > 0 ? card.total : null,
      };
    }
    const totals = salesTotals;
    const qty = Number(totals?.qty) || 0;
    const base = Number(totals?.base) || 0;
    const gst = Number(totals?.gst) || 0;
    const total = Number(totals?.total) || 0;
    return {
      totalQty: qty > 0 ? qty : null,
      totalBasic: base > 0 ? base : null,
      totalGst: gst > 0 ? gst : null,
      totalInclGst: total > 0 ? total : null,
    };
  }, [salesTotals, selectedPoNo, poCards]);

  const openModal = () => {
    setFormValues(emptySaleForm);
    initialFormValuesRef.current = emptySaleForm;
    setFormError("");
    setClosing(false);
    setModalOpen(true);
    setAvailableSerials([]);
    setSerialsError("");
    setMenuOpen(false);
    setCustomerSaleParent(null);
  };

  const requestClose = async (skipConfirmation = false) => {
    if (closing) return;
    if (skipConfirmation !== true && JSON.stringify(formValues) !== JSON.stringify(initialFormValuesRef.current)) {
      const result = await swalConfirm({
        title: "Discard unsaved changes?",
        text: "Your sale changes will be lost unless you save them.",
        confirmText: "Discard changes",
      });
      if (!result.isConfirmed) return;
    }
    setClosing(true);
    setTimeout(() => {
      setModalOpen(false);
      setClosing(false);
      setFormValues(emptySaleForm);
      setFormError("");
      setCustomerSaleParent(null);
    }, 220);
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => {
      const nextValue = name === "clientContact" ? value.replace(/\D/g, "").slice(0, 10) : value;
      const next = { ...prev, [name]: nextValue };
      if (name === "qty") {
        const qty = Math.max(0, Number(value) || 0);
        next.serialNumbers = [...(prev.serialNumbers || [])].slice(0, qty);
        while (next.serialNumbers.length < qty) next.serialNumbers.push("");
        next.serial = next.serialNumbers.join(", ");
      }
      if (["unitCost", "qty", "gstRate"].includes(name)) {
        next.value = calculatePoValue(next.unitCost, next.qty, next.gstRate);
      }
      return next;
    });
  };

  const handleModelChange = (modelName) => {
    const selectedModel = models.find((model) => model.name === modelName);
    setFormValues((prev) => {
      const qty = Math.max(0, Number(prev.qty) || 0);
      return {
        ...prev,
        modelId: selectedModel?.id || "",
        model: modelName,
        serial: "",
        serialNumbers: Array.from({ length: qty }, () => ""),
      };
    });
  };

  const handleSerialNumberChange = (index, value) => {
    setFormValues((prev) => {
      const serialNumbers = [...(prev.serialNumbers || [])];
      serialNumbers[index] = value;
      return { ...prev, serialNumbers, serial: serialNumbers.join(", ") };
    });
  };

  // ---- Keep Warranty Start/End Date in sync with Invoice Date + Warranty Period ----
  // Auto-calc source: Invoice Date (see note above calculateWarrantyDates()).
  useEffect(() => {
    setFormValues((prev) => {
      const { warrantyStartDate, warrantyEndDate } = calculateWarrantyDates(
        prev.invoiceDate,
        prev.warrantyPeriod
      );
      if (
        prev.warrantyStartDate === warrantyStartDate &&
        prev.warrantyEndDate === warrantyEndDate
      ) {
        return prev;
      }
      return { ...prev, warrantyStartDate, warrantyEndDate };
    });
  }, [formValues.invoiceDate, formValues.warrantyPeriod]);

  const handleSave = async () => {
    // Guard against duplicate submissions from rapid double-clicks.
    if (saving) return;

    const error = validateSaleForm(formValues);
    if (error) {
      setFormError(error);
      return;
    }

    setSaving(true);
    setFormError("");

    try {
      const payloadToSave = {
          ...formValues,
          date: formValues.date || formValues.clientPoDate,
          // Persist warranty period as a number of years, per spec.
          warrantyPeriod: formValues.warrantyPeriod ? Number(formValues.warrantyPeriod) : "",
      };
      const res = customerSaleParent
        ? await api.put(`/sales/${getRowId(customerSaleParent)}/customer-sale`, payloadToSave)
        : await api.post("/sales", payloadToSave);
      const payload = res.data;
      if (!payload.success) {
        throw new Error(payload.message || "Unable to save sale");
      }

      // The blueprint returns { success, message, id, ...fields, createdAt, updatedAt } flat 
      // pull out just the row fields for the table, same pattern as DefectiveUnits.
      await fetchRows({ targetPage: customerSaleParent ? page : 1, silent: true });
      if (!customerSaleParent) setPage(1);
      requestClose(true);
      swalSuccess(customerSaleParent ? "Customer sale saved" : "Sale saved", customerSaleParent ? "The customer sale has been saved successfully." : "The sale has been saved successfully.");
    } catch (err) {
      const msg = err.message || "Something went wrong while saving. Please try again.";
      setFormError(msg);
      swalError("Save failed", msg);
    } finally {
      setSaving(false);
    }
  };

  // ---- Bulk-select helpers ----
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
    () => filteredRows.map(getRowId).filter(Boolean),
    [filteredRows]
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === currentPageIds.length && currentPageIds.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(currentPageIds));
    }
  };

  const allSelected = currentPageIds.length > 0 && selectedIds.size === currentPageIds.length;

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    const result = await swalConfirm({
      title: "Delete selected sale(s)?",
      text: `Delete ${selectedIds.size} selected sale(s)? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setDeleting(true);

    try {
      const res = await api.post("/sales/bulk-delete", { ids: Array.from(selectedIds) });
      const data = res.data;
      if (!data.success) {
        throw new Error(data.message || "Unable to delete sales");
      }

      const deletedCount = selectedIds.size;
      await fetchRows({ targetPage: page, silent: true });
      setSelectMode(false);
      setSelectedIds(new Set());
      setMenuOpen(false);
      swalSuccess("Sales deleted", `${deletedCount} sale(s) removed.`);
    } catch (err) {
      swalError("Delete failed", err.message || "Failed to delete selected sales.");
    } finally {
      setDeleting(false);
    }
  };

  // Table columns with a checkbox column prepended only while selectMode
  // is active  mirrors the PO Details / BOQ pattern.
  const tableColumns = useMemo(() => {
    if (!selectMode) return columns;

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

    return [selectColumn, ...columns];
  }, [selectMode, selectedIds]);

  return (
    <div className="sales-page">
      <BackToDashboard visible={arrivedFromDashboard} />
      <div className="sales-toolbar">
        <div className="sales-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="sale-add-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="sale-add-btn"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
              >
                <Trash2 size={16} />
                {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </button>
              <button type="button" className="sale-add-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <ExportPdfButton
                mode="table"
                title="Sale Register"
                columns={columns}
                rows={exportTableRows}
                fileName="sale-register"
              />
              <button type="button" className="sale-add-btn" onClick={openModal}>
                <Plus size={18} />
                Add Sale
              </button>
              <button type="button" className="sale-delete-btn" onClick={toggleSelectMode}>
                <Trash2 size={16} /> Delete
              </button>
            </>
          )}
        </div>

        <div className="sales-kebab-wrapper" ref={menuRef}>
          <button
            type="button"
            className="sales-kebab-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="More actions"
          >
            <MoreVertical size={20} />
          </button>

          {menuOpen && (
            <div className="sales-kebab-menu">
              {selectMode ? (
                <>
                  <button type="button" className="sales-menu-item" onClick={toggleSelectAll}>
                    <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    className="sales-menu-item"
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || deleting}
                  >
                    <Trash2 size={16} />
                    {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
                  </button>
                  <button type="button" className="sales-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  {/* `.sales-toolbar-actions` is hidden below 640px, so the
                      export lives here too or mobile would lose it entirely. */}
                  <div className="sales-menu-export" onClick={() => setMenuOpen(false)}>
                    <ExportPdfButton
                      title="Sale Register"
                      columns={columns}
                      rows={exportTableRows}
                      fileName="sale-register"
                    />
                  </div>
                  <button type="button" className="sales-menu-item" onClick={openModal}>
                    <Plus size={16} /> Add Sale
                  </button>
                  <button type="button" className="sales-menu-item" onClick={toggleSelectMode}>
                    <Trash2 size={16} /> Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {selectedPoNo ? (
        <div className="po-toolbar-left sales-po-drill">
          <button type="button" className="po-back-btn" onClick={() => setSelectedPoNo("")}>
            <ArrowLeft size={16} /> Back
          </button>
          <h2 className="model-heading po-heading">Client PO {selectedPoNo}</h2>
        </div>
      ) : poCards.length > 0 ? (
        <>
        <div className="model-grid">
          {pagedPoCards.map((card) => (
            <button
              key={card.poNo}
              type="button"
              className="model-card po-card"
              onClick={() => setSelectedPoNo(card.poNo)}
            >
              {/* A span, not a button: the card itself is a button. */}
              <span
                className="model-card-edit"
                onClick={(e) => {
                  e.stopPropagation();
                  openPoEdit(card);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    openPoEdit(card);
                  }
                }}
                aria-label={`Edit PO ${card.poNo}`}
                title="Edit PO details"
              >
                <Pencil size={14} />
              </span>
              <div className="model-card-heading-row">
                <div className="model-card-icon">
                  <FileText size={18} />
                </div>
                <span className="model-card-name">{card.poNo}</span>
              </div>
              <div className="po-card-details">
                <span className="po-card-detail-row">
                  <span className="po-card-detail-label">PO Date</span>
                  <span className="po-card-detail-value">
                    {card.clientPoDate ? formatDateDisplay(card.clientPoDate) : "—"}
                  </span>
                </span>
                <span className="po-card-detail-row">
                  <span className="po-card-detail-label">Client Name</span>
                  <span className="po-card-detail-value">{card.client || "—"}</span>
                </span>
                {/* End Customer Name / PO No hidden on the cards (still in the
                    table and details). Uncomment to show them again.
                <span className="po-card-detail-row">
                  <span className="po-card-detail-label">End Customer Name</span>
                  <span className="po-card-detail-value">{card.endUserClient || "—"}</span>
                </span>
                <span className="po-card-detail-row">
                  <span className="po-card-detail-label">End Customer PO No</span>
                  <span className="po-card-detail-value">{card.endUserPoNo || "—"}</span>
                </span>
                */}
              </div>
              <div className="po-card-totals">
                <span className="po-card-total-row">
                  <span className="model-card-total-label">Qty</span>
                  <span className="po-card-total-amount">{card.qty}</span>
                </span>
                <span className="po-card-total-row">
                  <span className="model-card-total-label">Basic Price</span>
                  <span className="po-card-total-amount">{fmtINR(card.base)}</span>
                </span>
                <span className="po-card-total-row">
                  <span className="model-card-total-label">GST Price</span>
                  <span className="po-card-total-amount">{fmtINR(card.gst)}</span>
                </span>
                <span className="po-card-total-row">
                  <span className="model-card-total-label">PO Total incl. GST</span>
                  <span className="model-card-total-value">{fmtINR(card.total)}</span>
                </span>
              </div>
              <span className="po-card-meta">
                {card.rowCount} line{card.rowCount === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
        <CardPagination {...poCardPager} />
        </>
      ) : null}

      {/* Search from the PO cards also lists every matching sale line
          (serial, invoice no, model...); View opens its Client PO. */}
      {!selectedPoNo && (
        <GlobalSearchResults
          query={query}
          noun="sale lines"
          columns={columns}
          load={async (q) => {
            const res = await api.get(`${API_BASE_URL}/sales`, { params: { q, page: 1, limit: 100 }, __vectorNoCache: true });
            if (!res.data.success) throw new Error(res.data.message || "Search failed");
            return { rows: res.data.sales || [], total: res.data.pagination?.totalCount };
          }}
          onOpen={(row) => { if (row.poNo) setSelectedPoNo(String(row.poNo)); }}
        />
      )}

      {/* The card grid is the first level, so the table only appears once a PO is
          opened. PO Details swaps between the two the same way. */}
      {selectedPoNo ? (
        <>
      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <FilterModal rows={rows} options={filterOptions} fields={SALE_FILTER_FIELDS} value={rowFilters} onChange={setRowFilters} />
            <DateRangeFilter
              fromDate={fromDate}
              toDate={toDate}
              onChangeFrom={setFromDate}
              onChangeTo={setToDate}
              onApply={(nextFrom, nextTo) => {
                setAppliedFromDate(nextFrom);
                setAppliedToDate(nextTo);
              }}
              onClear={() => {
                setFromDate("");
                setToDate("");
                setAppliedFromDate("");
                setAppliedToDate("");
              }}
              error={dateRangeError}
              column={dateColumn}
              columns={SALE_DATE_COLUMNS}
              onChangeColumn={setDateColumn}
              startLabel={`From ${activeDateColumnLabel}`}
              endLabel={`To ${activeDateColumnLabel}`}
            />
          </div>
          <div className="table-controls-right">
            {tableTotals.totalBasic !== null || tableTotals.totalGst !== null || tableTotals.totalInclGst !== null ? (
              <span className="table-total">
                <span className="table-total-label">Total</span>
                {tableTotals.totalQty !== null && (
                  <span className="table-total-value">
                    {tableTotals.totalQty}
                    <span className="table-total-scope">(Qty)</span>
                  </span>
                )}
                {tableTotals.totalQty !== null && (tableTotals.totalBasic !== null || tableTotals.totalGst !== null || tableTotals.totalInclGst !== null) && <span className="table-total-scope">|</span>}
                {tableTotals.totalBasic !== null && (
                  <span className="table-total-value">
                    {tableTotals.totalBasic.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span className="table-total-scope">(Basic Price)</span>
                  </span>
                )}
                {tableTotals.totalBasic !== null && tableTotals.totalGst !== null && <span className="table-total-scope">|</span>}
                {tableTotals.totalGst !== null && (
                  <span className="table-total-value">
                    {tableTotals.totalGst.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span className="table-total-scope">(GST Price)</span>
                  </span>
                )}
                {(tableTotals.totalBasic !== null || tableTotals.totalGst !== null) && tableTotals.totalInclGst !== null && <span className="table-total-scope">|</span>}
                {tableTotals.totalInclGst !== null && (
                  <span className="table-total-value">
                    {tableTotals.totalInclGst.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span className="table-total-scope">(Total incl. GST)</span>
                  </span>
                )}
              </span>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="sales-loading">
            <Loader2 size={32} className="spin" />
            Loading sale register...
          </div>
        ) : loadError ? (
          <div className="sales-load-error">{loadError}</div>
        ) : filteredRows.length === 0 ? (
          <div className="sales-date-empty">
            {selectedPoNo
              ? `No sales recorded for Client PO ${selectedPoNo}.`
              : filtersActive
                ? `No sales match the current search, filter or ${activeDateColumnLabel} range.`
                : "No sales recorded yet. Click \"Add Sale\" to create the first one."}
          </div>
        ) : (
          <DataTable columns={tableColumns} rows={serialDisplayRows} onSortChange={setTableSort} onViewDetails={openDetails} />
        )}
      </div>

      {!loading && !loadError && filteredRows.length > 0 && !selectedPoNo && (
        <ListPagination
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          totalCount={totalCount}
          rowCount={rows.length}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
        />
      )}
        </>
      ) : null}

      {/* ---- Add Sale Modal ---- */}
      {poEdit && createPortal(
        <div className="modal-overlay po-edit-overlay" onClick={closePoEdit}>
          <div
            className="modal-container po-edit-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Edit PO ${poEdit.poNo}`}
          >
            <div className="modal-header">
              <h2>Edit PO {poEdit.poNo}</h2>
              <button type="button" className="modal-close" onClick={closePoEdit} aria-label="Close" disabled={poEditSaving}>
                <X size={22} />
              </button>
            </div>
            <form
              className="sale-form"
              onSubmit={(e) => {
                e.preventDefault();
                savePoEdit();
              }}
            >
              {poEditError && <div className="sale-form-error">{poEditError}</div>}
              <div className="sale-form-section-title">PO Details (applied to every line of this PO)</div>
              <div className="sale-form-grid">
                {PO_CARD_EDIT_FIELDS.map((field) => (
                  <label className="sale-field" key={field.key}>
                    <span>{field.label}</span>
                    {field.type === "date" ? (
                      <DatePicker
                        value={poEdit.values[field.key] || ""}
                        onChange={(value) => setPoEdit((prev) => ({ ...prev, values: { ...prev.values, [field.key]: value } }))}
                        ariaLabel={`Select ${field.label.toLowerCase()}`}
                        popoverZIndex={130000}
                      />
                    ) : (
                      <input
                        value={poEdit.values[field.key] || ""}
                        onChange={(e) => {
                          const { value } = e.target;
                          setPoEdit((prev) => ({ ...prev, values: { ...prev.values, [field.key]: value } }));
                        }}
                      />
                    )}
                  </label>
                ))}
              </div>
            </form>
            <div className="modal-footer">
              <button type="button" className="sale-btn-secondary" onClick={closePoEdit} disabled={poEditSaving}>
                Cancel
              </button>
              <button type="button" className="sale-btn-primary" onClick={savePoEdit} disabled={poEditSaving}>
                {poEditSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {poEditSaving ? "Updating..." : "Update"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {modalOpen && createPortal(
        <div
          className={`modal-overlay${closing ? " closing" : ""}`}
          onClick={requestClose}
        >
          <div
            className={`modal-container${closing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={customerSaleParent ? "Add Customer Sale" : "Add Sale"}
          >
            <div className="modal-header">
              <h2>{customerSaleParent ? "Add Customer Sale" : "Add Sale"}</h2>
              <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                <X size={22} />
              </button>
            </div>

            <form
              className="sale-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="sale-form-error">{formError}</div>}
              {customerSaleParent ? (
                <>
                  <div className="sale-form-section-title">End Customer Details</div>
                  <div className="sale-form-grid">
                    {END_USER_DETAIL_FIELDS.map((field) => (
                      <label className="sale-field" key={field.key}>
                        <span>{field.label}</span>
                        {field.type === "date" ? (
                          <DatePicker
                            value={formValues[field.key]}
                            onChange={(value) => setFormValues((prev) => ({ ...prev, [field.key]: value }))}
                            ariaLabel={`Select ${field.label.toLowerCase()}`}
                            popoverZIndex={130000}
                          />
                        ) : (
                          <input
                            type={field.type || "text"}
                            value={formValues[field.key] || ""}
                            onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            placeholder={field.placeholder}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="sale-form-section-title">Client Information</div>
                  <div className="sale-form-grid">
                    <label className="sale-field">
                      <span>Client PO Date</span>
                      <DatePicker value={formValues.clientPoDate} onChange={(clientPoDate) => setFormValues((prev) => ({ ...prev, clientPoDate }))} ariaLabel="Select client PO date" popoverZIndex={130000} />
                    </label>
                    <label className="sale-field">
                      <span>Client PO No</span>
                      <input name="poNo" value={formValues.poNo} onChange={handleFormChange} placeholder="e.g. PO-4521" />
                    </label>
                    <label className="sale-field">
                      <span>Client Name</span>
                      <input name="client" value={formValues.client} onChange={handleFormChange} placeholder="e.g. Acme Pvt Ltd" />
                    </label>
                    <label className="sale-field">
                      <span>Location</span>
                      <input name="location" value={formValues.location} onChange={handleFormChange} placeholder="e.g. Chennai" />
                    </label>
                  </div>
                </>
              )}
              <div className="sale-form-grid">
                <label className="sale-field">
                  <span>Model</span>
                  <SearchableSelect
                    options={modelOptions}
                    value={formValues.model}
                    onChange={handleModelChange}
                    placeholder="Select Model"
                    loading={modelsLoading}
                    emptyMessage={modelsError || "No Models found"}
                  />
                </label>



                <label className="sale-field">
                  <span>Client Contact</span>
                  <input
                    type="tel"
                    name="clientContact"
                    value={formValues.clientContact}
                    onChange={handleFormChange}
                    inputMode="numeric"
                    pattern="[0-9]{10}"
                    maxLength={10}
                    placeholder="e.g. 1234567890"
                  />
                </label>
                <label className="sale-field">
                  <span>Unit Cost</span>
                  <input
                    type="number"
                    min="0"
                    name="unitCost"
                    value={formValues.unitCost}
                    onChange={handleFormChange}
                    placeholder="e.g. 250000"
                  />
                </label>
                 <label className="sale-field">
                  <span>Qty</span>
                  <input
                    type="number"
                    min="0"
                    name="qty"
                    value={formValues.qty}
                    onChange={handleFormChange}
                    placeholder="e.g. 10"
                  />
                </label>
                <label className="sale-field">
                  <span>GST Rate</span>
                  <StatusDropdown
                    name="gstRate"
                    value={formValues.gstRate === "" ? "" : Number(formValues.gstRate)}
                    options={GST_RATE_OPTIONS}
                    onChange={handleFormChange}
                    placeholder="Select GST rate"
                    formatLabel={(rate) => rate === 0 ? "Nil (0%)" : `${rate}%`}
                  />
                </label>
                <label className="sale-field">
                  <span>PO Value (incl. GST)</span>
                  <input
                    type="number"
                    min="0"
                    name="value"
                    value={formValues.value}
                    readOnly
                    placeholder="Calculated from Unit Cost, Qty & GST"
                    title="Calculated as Unit Cost × Qty × (1 + GST rate)"
                  />
                </label>
              </div>
              <div className="sale-form-section-title">Financial Details</div>
              <div className="sale-form-grid">
                
                 <label className="sale-field">
                  <span>Invoice Date</span>
                  <DatePicker value={formValues.invoiceDate} onChange={(invoiceDate) => setFormValues((prev) => ({ ...prev, invoiceDate }))} ariaLabel="Select invoice date" popoverZIndex={130000} />
                </label>
               
               
                <label className="sale-field">
                  <span>Invoice Number</span>
                  <input
                    name="invoiceNumber"
                    value={formValues.invoiceNumber}
                    onChange={handleFormChange}
                    placeholder="e.g. INV-2026-0142"
                  />
                </label>
               
                 <label className="sale-field sale-serial-field">
                  <span>Serial Numbers</span>
                  <div className="sale-serial-input-list">
                    {(formValues.serialNumbers || []).map((serial, index) => (
                      <SearchableSelect
                        key={index}
                        options={serialOptionsForIndex(availableSerialOptions, formValues.serialNumbers, index)}
                        value={serial}
                        onChange={(selectedSerial) => handleSerialNumberChange(index, selectedSerial)}
                        placeholder={`Select Serial No ${index + 1}`}
                        disabled={!formValues.model || serialsLoading}
                        loading={serialsLoading}
                        emptyMessage={serialsError || "No in-stock serials for this model"}
                      />
                    ))}
                  </div>
                </label>
              </div>

              <div className="sale-form-section-title">Warranty Details</div>
              <div className="sale-form-grid">
                <label className="sale-field">
                  <span>Warranty Period</span>
                  <StatusDropdown
                    name="warrantyPeriod"
                    value={formValues.warrantyPeriod}
                    options={WARRANTY_YEAR_OPTIONS}
                    onChange={handleFormChange}
                    placeholder="Select warranty period"
                    formatLabel={(y) => `${y} Year${y > 1 ? "s" : ""}`}
                  />
                </label>

                <label className="sale-field">
                  <span>Warranty Start Date</span>
                  <div title="Automatically set to the Invoice Date"><DatePicker value={formValues.warrantyStartDate} onChange={() => {}} disabled ariaLabel="Warranty start date" /></div>
                </label>

                <label className="sale-field">
                  <span>Warranty End Date</span>
                  <div title="Automatically calculated as Invoice Date + Warranty Period, ending the day before the anniversary"><DatePicker value={formValues.warrantyEndDate} onChange={() => {}} disabled ariaLabel="Warranty end date" /></div>
                </label>
              </div>
              <div className="sale-form-section-title">Dispatch Details</div>
              <div className="sale-form-grid">
                <label className="sale-field">
                  <span>Expected Dispatch Date</span>
                  <DatePicker value={formValues.expectedDispatchDate} onChange={(expectedDispatchDate) => setFormValues((prev) => ({ ...prev, expectedDispatchDate }))} ariaLabel="Select expected dispatch date" popoverZIndex={130000} />
                </label>

                <label className="sale-field">
                  <span>Actual Dispatch Date</span>
                  <DatePicker value={formValues.actualDispatchDate} onChange={(actualDispatchDate) => setFormValues((prev) => ({ ...prev, actualDispatchDate }))} ariaLabel="Select actual dispatch date" popoverZIndex={130000} />
                </label>
                <label className="sale-field">
                  <span>Dispatch Status</span>
                  <StatusDropdown
                    name="dispatch"
                    value={formValues.dispatch}
                    options={DISPATCH_OPTIONS}
                    onChange={handleFormChange}
                    placeholder="Select dispatch status"
                  />
                </label>
              </div>

              <div className="sale-form-section-title">End Customer Details</div>
              <div className="sale-form-grid">
                {END_USER_DETAIL_FIELDS.map((field) => (
                  <label className="sale-field" key={field.key}>
                    <span>{field.label}</span>
                    {field.type === "date" ? (
                      <DatePicker
                        value={formValues[field.key]}
                        onChange={(value) => setFormValues((prev) => ({ ...prev, [field.key]: value }))}
                        ariaLabel={`Select ${field.label.toLowerCase()}`}
                        popoverZIndex={130000}
                      />
                    ) : (
                      <input
                        type={field.type || "text"}
                        value={formValues[field.key] || ""}
                        onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                      />
                    )}
                  </label>
                ))}
              </div>
            </form>

            <div className="modal-footer">
              <button type="button" className="sale-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="sale-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ---- View / Edit Sale Details Popup ---- */}
      {detailsOpen && detailsRow && createPortal(
        <div
          className={`sale-details-overlay${detailsClosing ? " closing" : ""}`}
          onClick={requestCloseDetails}
        >
          <div
            className={`sale-details-container${detailsClosing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sale Details"
          >
            <div className="sale-details-header">
              <h2>{isEditingDetails ? (customerSaleDetailsParent ? "Edit Customer Sale" : "Edit Sale") : (customerSaleDetailsParent ? "Customer Sale Details" : "Sale Details")}</h2>
              <div className="sale-details-header-actions">
                {!isEditingDetails && (
                  <button
                    type="button"
                    className="sale-details-edit-btn"
                    onClick={startEditDetails}
                    aria-label="Edit"
                  >
                    <Pencil size={15} />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  className="sale-details-close"
                  onClick={requestCloseDetails}
                  aria-label="Close"
                >
                  <X size={22} />
                </button>
              </div>
            </div>

            <div className="sale-details-body">
              {detailsError && <div className="sale-form-error">{detailsError}</div>}

              <section className="sale-details-section">
                <h3>Sale Details</h3>
                <div className="sale-details-grid">
                  {EXISTING_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="sale-details-label">{field.label}</div>
                      {renderDetailField(
                        field,
                        detailsRow,
                        editValues,
                        handleEditChange,
                        isEditingDetails,
                        modelOptions,
                        modelsLoading,
                        editAvailableSerialOptions,
                        editSerialsLoading
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </section>

              <section className="sale-details-section">
                <h3>Dispatch Details</h3>
                <div className="sale-details-grid">
                  {DISPATCH_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="sale-details-label">{field.label}</div>
                      {renderDetailField(field, detailsRow, editValues, handleEditChange, isEditingDetails)}
                    </React.Fragment>
                  ))}
                </div>
              </section>

              <section className="sale-details-section">
                <h3>End Customer Details</h3>
                <div className="sale-details-grid">
                  {END_USER_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="sale-details-label">{field.label}</div>
                      {renderDetailField(field, detailsRow, editValues, handleEditChange, isEditingDetails)}
                    </React.Fragment>
                  ))}
                </div>
              </section>

              <section className="sale-details-section">
                <h3>Warranty Details</h3>
                <div className="sale-details-grid">
                  {WARRANTY_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="sale-details-label">{field.label}</div>
                      {renderDetailField(field, detailsRow, editValues, handleEditChange, isEditingDetails)}
                    </React.Fragment>
                  ))}
                </div>
              </section>

              <section className="sale-details-section">
                <h3>Financial Details</h3>
                <div className="sale-details-grid">
                  {FINANCIAL_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="sale-details-label">{field.label}</div>
                      {renderDetailField(field, detailsRow, editValues, handleEditChange, isEditingDetails)}
                    </React.Fragment>
                  ))}
                </div>
              </section>
            </div>

            <div className="sale-details-footer">
              {isEditingDetails ? (
                <>
                  <button
                    type="button"
                    className="sale-btn-secondary"
                    onClick={cancelEditDetails}
                    disabled={detailsSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="sale-details-close-btn"
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
                  className="sale-btn-secondary"
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
