import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Swal from "sweetalert2";
import { createPortal } from "react-dom";
import { Plus, X, Save, Loader2, Pencil, Trash2, MoreVertical, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import StatusDropdown from "../components/StatusDropdown";
import api from "../components/Api";
import { fmtINR } from "../data/mockData";
import { formatDate } from "../utils/date";
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
  { key: "dispatch", label: "Dispatch Status" },
];
const SALE_FILTER_FIELDS = columns.filter((column) => ["client", "location", "model", "dispatch"].includes(column.key));

const DISPATCH_OPTIONS = ["Pending", "Processing", "Dispatched", "Delivered", "Cancelled"];
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
// Warranty End Date = Invoice Date + Warranty Period (years).
function addYearsToDate(dateStr, years) {
  if (!dateStr || !years) return "";
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return "";
  const result = new Date(parsed.getTime());
  result.setFullYear(result.getFullYear() + Number(years));
  if (Number.isNaN(result.getTime())) return "";
  return result.toISOString().slice(0, 10);
}

// Exported so an eventual "Edit Sale" flow can reuse the exact same logic.
export function calculateWarrantyDates(invoiceDate, warrantyPeriod) {
  const warrantyStartDate = invoiceDate || "";
  const warrantyEndDate =
    invoiceDate && warrantyPeriod ? addYearsToDate(invoiceDate, warrantyPeriod) : "";
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
function buildEditValues(row) {
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
    return <DatePicker value={value} onChange={(date) => onChange({ target: { name: field.key, value: date } })} ariaLabel={`Select ${field.label}`} />;
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
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

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

  const openCustomerSale = (row) => {
    setCustomerSaleParent(row);
    setFormValues(emptySaleForm);
    initialFormValuesRef.current = emptySaleForm;
    setFormError("");
    setClosing(false);
    setModalOpen(true);
  };

  const openCustomerSaleDetails = (row) => {
    if (!row.customerSale) return;
    const customerSale = { ...row.customerSale, id: getRowId(row) };
    setCustomerSaleDetailsParent(row);
    setDetailsRow(customerSale);
    setEditValues(buildEditValues(customerSale));
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
      const res = await api.get(SALES_API_URL, {
        params: { page: pageToFetch, limit: PAGE_SIZE, search: query.trim() },
      });
      const data = res.data;
      if (!data.success) {
        throw new Error(data.message || `Server responded with ${res.status}`);
      }
      setRows(data.sales || []);
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
  }, [page, query]);

  useEffect(() => {
    fetchRows({ targetPage: page });
  }, [fetchRows, page]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesSearch =
        !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));

      if (!matchesSearch) return false;
      return matchesPageFilter(row, pageFilter, SALE_FILTER_FIELDS);
    });
  }, [query, rows, pageFilter]);

  // New records are stored one document per serial. This expansion remains
  // for legacy combined records and supplies only the selected serial to the
  // edit form so saving it can split the old document safely.
  const serialDisplayRows = useMemo(() => filteredRows.flatMap((row) => {
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
  }), [filteredRows]);

  const openModal = () => {
    setFormValues(emptySaleForm);
    initialFormValuesRef.current = emptySaleForm;
    setFormError("");
    setClosing(false);
    setModalOpen(true);
    setAvailableSerials([]);
    setSerialsError("");
    setMenuOpen(false);
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

  const goToPage = (nextPage) => {
    const clamped = Math.min(Math.max(nextPage, 1), totalPages);
    if (clamped === page) return;
    setPage(clamped);
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
    const customerSalesColumn = {
      key: "customerSalesAction",
      label: "O2K Sales",
      render: (row) => row.customerSale ? (
        <button type="button" className="data-table-view-btn" onClick={() => openCustomerSaleDetails(row)}>
          <Pencil size={16} /> View
        </button>
      ) : (
        <button type="button" className="data-table-view-btn" onClick={() => openCustomerSale(row)}>
          <Plus size={16} /> Add Sales
        </button>
      ),
    };
    if (!selectMode) return [...columns, customerSalesColumn];

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

    return [selectColumn, ...columns, customerSalesColumn];
  }, [selectMode, selectedIds]);

  return (
    <div className="sales-page">
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

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <SearchBar value={query} onChange={setQuery} placeholder="Search Sale Register..." />
            <PageFilter rows={rows} fields={SALE_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          </div>
          {!loading && !loadError && (
            <ExportPdfButton
              mode="table"
              title="Sale Register"
              columns={columns}
              rows={serialDisplayRows}
            />
          )}
        </div>

        {loading ? (
          <div className="sales-loading">
            <Loader2 size={32} className="spin" />
            Loading sale register...
          </div>
        ) : loadError ? (
          <div className="sales-load-error">{loadError}</div>
        ) : rows.length === 0 ? (
          <div className="sales-date-empty">
            No sales recorded yet. Click "Add Sale" to create the first one.
          </div>
        ) : (
          <DataTable columns={tableColumns} rows={serialDisplayRows} onViewDetails={openDetails} />
        )}
      </div>

      {!loading && !loadError && rows.length > 0 && (
        <div className="sales-pagination">
          <p className="sales-hint">
            Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
            {"–"}
            {(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows
          </p>

          <div className="sales-pagination-controls">
            <button
              type="button"
              className="sales-page-btn sales-page-edge"
              onClick={() => goToPage(1)}
              disabled={page === 1}
              aria-label="First page"
            >
              <ChevronsLeft size={16} />
            </button>

            {page > 1 && (
              <button
                type="button"
                className="sales-page-btn sales-page-nav"
                onClick={() => goToPage(page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
                Prev
              </button>
            )}

            <span className="sales-page-current" key={page}>{page}</span>

            {page < totalPages && (
              <button
                type="button"
                className="sales-page-btn sales-page-nav"
                onClick={() => goToPage(page + 1)}
                aria-label="Next page"
              >
                Next
                <ChevronRight size={16} />
              </button>
            )}

            <button
              type="button"
              className="sales-page-btn sales-page-edge"
              onClick={() => goToPage(totalPages)}
              disabled={page === totalPages}
              aria-label="Last page"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ---- Add Sale Modal ---- */}
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
              <div className="sale-form-section-title">Client Information</div>
              <div className="sale-form-grid">
                <label className="sale-field">
                  <span>Client PO Date</span>
                  <DatePicker value={formValues.clientPoDate} onChange={(clientPoDate) => setFormValues((prev) => ({ ...prev, clientPoDate }))} ariaLabel="Select client PO date" />
                </label>

                <label className="sale-field">
                  <span>Client PO No</span>
                  <input
                    name="poNo"
                    value={formValues.poNo}
                    onChange={handleFormChange}
                    placeholder="e.g. PO-4521"
                  />
                </label>

                <label className="sale-field">
                  <span>Client Name</span>
                  <input
                    name="client"
                    value={formValues.client}
                    onChange={handleFormChange}
                    placeholder="e.g. Acme Pvt Ltd"
                  />
                </label>

                <label className="sale-field">
                  <span>Location</span>
                  <input
                    name="location"
                    value={formValues.location}
                    onChange={handleFormChange}
                    placeholder="e.g. Chennai"
                  />
                </label>

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
                  <DatePicker value={formValues.invoiceDate} onChange={(invoiceDate) => setFormValues((prev) => ({ ...prev, invoiceDate }))} ariaLabel="Select invoice date" />
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
                  <div title="Automatically calculated from Invoice Date + Warranty Period"><DatePicker value={formValues.warrantyEndDate} onChange={() => {}} disabled ariaLabel="Warranty end date" /></div>
                </label>
              </div>
              <div className="sale-form-section-title">Dispatch Details</div>
              <div className="sale-form-grid">
                <label className="sale-field">
                  <span>Expected Dispatch Date</span>
                  <DatePicker value={formValues.expectedDispatchDate} onChange={(expectedDispatchDate) => setFormValues((prev) => ({ ...prev, expectedDispatchDate }))} ariaLabel="Select expected dispatch date" />
                </label>

                <label className="sale-field">
                  <span>Actual Dispatch Date</span>
                  <DatePicker value={formValues.actualDispatchDate} onChange={(actualDispatchDate) => setFormValues((prev) => ({ ...prev, actualDispatchDate }))} ariaLabel="Select actual dispatch date" />
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
            </form>

            <div className="modal-footer">
              <button type="button" className="sale-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="sale-btn-primary" onClick={handleSave} disabled={saving || Boolean(validateSaleForm(formValues))}>
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
