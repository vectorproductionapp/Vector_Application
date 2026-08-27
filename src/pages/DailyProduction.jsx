import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
 
import { createPortal } from "react-dom";
import api from "../components/Api";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
 
import Swal from "sweetalert2";
 
import {
 
  Plus,
 
  X,
 
  Save,
 
  Loader2,
 
  RefreshCw,
 
  Trash2,
 
  Check,
 
  MoreVertical,
 
  Pencil,
  FileDown,
  FileText,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Expand,
  Minimize2,
 
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
 
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
 
import ExportPdfButton from "../components/ExportPdfButton";
import { exportQcReportToPdf, prepareQcReportPdf } from "../utils/exportPdf";
 
import DataTable from "../components/DataTable";
 
import StatusDropdown from "../components/StatusDropdown";
import { useAuth } from "../context/Auth";
import { useThemeColors } from "../context/ThemeContext";
 
import "./DailyProduction.css";
 
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const VECTOR_LOGO_URL = `${process.env.PUBLIC_URL || ""}/images/vector.png`;
const VECTOR_PDF_LOGO_URL = `${process.env.PUBLIC_URL || ""}/images/vector-pdf.png`;
const PAGE_SIZE = 10;
 
const ASSEMBLY_STAGE_OPTIONS = ["In Production", "Semi Finished", "Completed"];
 
const QC_STATUS_OPTIONS = ["Passed", "Under Inspection", "Pending", "Failed"];
 
const PACKAGING_STATUS_OPTIONS = ["Pending", "In Progress", "Packed"];

const QC_INSPECTION_ITEMS = [
  { key: "acVoltage230V", number: "1", description: "AC Voltage 230V", method: "Multimeter" },
  { key: "outputLow170V", number: "2", description: "Output low 170V", method: "Multimeter + Variac" },
  { key: "outputHigh250V", number: "3", description: "Output high 250V", method: "Multimeter + Variac" },
  { key: "frequency50Hz", number: "4", description: "Frequency 50Hz", method: "Multimeter" },
  { key: "ledInputOn", number: "5a", description: "LED indication — Input on", method: "Visual Inspection" },
  { key: "ledOutputOn", number: "5b", description: "LED indication — Output on", method: "Visual Inspection" },
  { key: "ledOutputLow", number: "5c", description: "LED indication — Output low", method: "Visual Inspection" },
  { key: "ledOutputHigh", number: "5d", description: "LED indication — Output high", method: "Visual Inspection" },
  { key: "inputFuse10A", number: "6", description: "Input Fuse - 10 A", method: "Visual + Continuity test" },
  { key: "frontPanelLcd", number: "7", description: "Front Panel LCD Display", method: "Visual Inspection" },
  { key: "parameterLeds", number: "8", description: "Ensure all parameter LEDs are glowing", method: "Visual Inspection" },
  { key: "loadRun", number: "9", description: "Run machine for 4 hrs without load and 1 hr with load", method: "Input Load Source" },
  { key: "individualPort", number: "10", description: "Individual Port ON/OFF", method: "Visual + Physical Inspection" },
  { key: "schedulingOutlets", number: "11", description: "Scheduling Outlets", method: "Visual + Physical Inspection" },
  { key: "cutoffAlert", number: "12", description: "High/Low Cut-off Alert", method: "Visual Inspection" },
  { key: "temperatureAlert", number: "13", description: "Temperature Alert", method: "Visual Inspection" },
  { key: "wattageLogs", number: "14", description: "Overall Wattage Reading / logs", method: "Visual Inspection" },
  { key: "deviceDiscovery", number: "15", description: "Device discovery tool test", method: "Visual Inspection" },
];

const createEmptyQcInspection = (checkedBy = "") => ({
  inspectionDate: new Date().toISOString().slice(0, 10),
  checkedBy,
  verifiedBy: "",
  authorizedBy: "",
  checks: Object.fromEntries(QC_INSPECTION_ITEMS.map((item) => [item.key, ""])),
});

function normalizeQcInspection(report, checkedBy = "") {
  const source = report && typeof report === "object" ? report : {};
  const empty = createEmptyQcInspection(checkedBy);
  return {
    ...empty,
    ...source,
    checkedBy: source.checkedBy || checkedBy || "",
    checks: { ...empty.checks, ...(source.checks || {}) },
  };
}

function isQcInspectionComplete(report) {
  if (!report || typeof report !== "object") return false;
  if (!["inspectionDate", "checkedBy", "verifiedBy"].every((field) => String(report[field] || "").trim())) {
    return false;
  }
  return QC_INSPECTION_ITEMS.every((item) => report.checks?.[item.key] === "Passed");
}

function validateQcInspection(report) {
  const missingFields = [
    ["inspectionDate", "QC Inspection Date"],
    ["checkedBy", "Checked By"],
    ["verifiedBy", "Verified By"],
  ].filter(([key]) => !String(report?.[key] || "").trim());
  if (missingFields.length) return `Please fill in: ${missingFields.map(([, label]) => label).join(", ")}.`;
  const incomplete = QC_INSPECTION_ITEMS.filter((item) => !report?.checks?.[item.key]);
  if (incomplete.length) return `Complete all QC checks (${incomplete.length} remaining).`;
  return null;
}

function normalizeQcFailureHistory(history) {
  return Array.isArray(history) ? history.filter((entry) => entry && typeof entry === "object") : [];
}

function getFailedQcItems(report) {
  return QC_INSPECTION_ITEMS.filter((item) => report?.checks?.[item.key] === "Failed");
}

function getFailureEntryItems(entry) {
  const listedKeys = Array.isArray(entry?.failedChecks)
    ? entry.failedChecks.map((item) => typeof item === "string" ? item : item?.key).filter(Boolean)
    : [];
  const keys = listedKeys.length
    ? listedKeys
    : QC_INSPECTION_ITEMS.filter((item) => entry?.checks?.[item.key] === "Failed").map((item) => item.key);
  return keys.map((key) => QC_INSPECTION_ITEMS.find((item) => item.key === key)).filter(Boolean);
}

function buildQcFailureEntry(report) {
  const failedAt = new Date().toISOString();
  return {
    id: failedAt,
    failedAt,
    inspectionDate: report.inspectionDate,
    checkedBy: String(report.checkedBy || "").trim(),
    verifiedBy: String(report.verifiedBy || "").trim(),
    authorizedBy: String(report.authorizedBy || "").trim(),
    failedChecks: getFailedQcItems(report).map((item) => item.key),
    checks: { ...(report.checks || {}) },
  };
}

function formatQcFailureDate(value) {
  if (!value) return "Date and time unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
 
// ---------- Inlined SweetAlert2 theme (previously lived in
 
// ../utils/swalTheme, pulled in here directly so this page has no
 
// dependency on that extra file). Same rounded-popup, fade+scale,
 
// auto-closing-on-success look, styled via the .swal-vector-popup /
 
// .swal-pop-in / .swal-pop-out classes already defined in
 
// DailyProduction.css. ----------
 
const SWAL_THEME = {
 
  customClass: { popup: "swal-vector-popup" },
 
  showClass: { popup: "swal-pop-in" },
 
  hideClass: { popup: "swal-pop-out" },
 
};
 
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
 
    ...SWAL_THEME,
 
  });
 
const swalSuccess = (title, text) =>
 
  Swal.fire({
 
    title,
 
    text,
 
    icon: "success",
 
    confirmButtonColor: "var(--accent)",
 
    timer: 2400,
 
    timerProgressBar: true,
 
    ...SWAL_THEME,
 
  });
 
const swalError = (title, text) =>
 
  Swal.fire({
 
    title,
 
    text,
 
    icon: "error",
 
    confirmButtonColor: "var(--accent)",
 
    ...SWAL_THEME,
 
  });
 
const columns = [
 
  { key: "date", label: "Date", isDate: true },
 
  { key: "phase", label: "Phase" },
 
  { key: "model", label: "Model" },
 
  { key: "qty", label: "Quantity" },

  { key: "serial", label: "Serial Number", mono: true },

  { key: "stage", label: "Assembling Stage" },

  { key: "assembledBy", label: "Assembled By" },
 
  { key: "qc", label: "QC Status" },

  { key: "qcBy", label: "QC Done By" },
 
  { key: "packagingStatus", label: "Packaging Status" },
 
  { key: "packagedBy", label: "Packaged By" },
 
  { key: "remarks", label: "Remarks" },
 
  { key: "stockStatus", label: "Stock Status" },
 
];
const PRODUCTION_FILTER_FIELDS = columns.filter((column) => [
  "model", "phase", "stage", "assembledBy", "qc", "qcBy", "packagingStatus", "packagedBy", "stockStatus",
].includes(column.key));
 
// Fields shown in the View modal (mirrors PODetails' PO_DETAIL_FIELDS).
 
const DETAIL_FIELDS = [
 
  { key: "date", label: "Date", isDate: true },
 
  { key: "model", label: "Model" },
 
  { key: "phase", label: "Phase" },
 
  { key: "stage", label: "Assembly Stage" },

  { key: "assembledBy", label: "Assembled By" },
 
 
  { key: "serial", label: "Serial Number" },
 
  { key: "qty", label: "Quantity" },
 
  { key: "qc", label: "QC Status" },

  { key: "qcBy", label: "QC Done By" },
 
  { key: "packagingStatus", label: "Packaging Status" },
 
  { key: "packagedBy", label: "Packaged By" },
 
  { key: "stockStatus", label: "Stock Status" },
 
  { key: "remarks", label: "Remarks" },

  { key: "qcReport", label: "QC Report" },
 
];
 
const emptyAssemblyForm = {
 
  id: null,
 
  modelId: "",
 
  model: "",
 
  phaseId: "",
 
  phase: "",
 
  stage: "",

  assembledBy: "",
  assembledById: "",
 
 
  serial: "",
  serialNumbers: [""],
 
 
  date: "",
 
  qty: "",
 
  qc: "",
 
  qcBy: "",
  qcById: "",
 
  packagingStatus: "",
 
  packagedBy: "",
  packagedById: "",

  qcInspection: {},
  qcFailureHistory: [],
 
  remarks: "",
 
};

const ASSEMBLY_UPDATE_FIELDS = [
  "modelId", "model", "phaseId", "phase", "stage", "assembledBy", "assembledById",
  "serial", "date", "qty", "remarks", "qc", "qcBy", "qcById",
  "packagingStatus", "packagedBy", "packagedById", "qcInspection",
  "qcFailureHistory",
];

function assemblyValuesMatch(currentValue, originalValue) {
  if (
    (currentValue && typeof currentValue === "object") ||
    (originalValue && typeof originalValue === "object")
  ) {
    return JSON.stringify(currentValue ?? {}) === JSON.stringify(originalValue ?? {});
  }
  return String(currentValue ?? "") === String(originalValue ?? "");
}

function buildAssemblyUpdatePayload(currentValues, originalValues) {
  return Object.fromEntries(
    ASSEMBLY_UPDATE_FIELDS
      .filter((field) => !assemblyValuesMatch(currentValues[field], originalValues?.[field]))
      .map((field) => [field, currentValues[field]])
  );
}
 
const REQUIRED_FIELDS = [
 
  { name: "modelId", label: "Model" },
 
  { name: "phaseId", label: "Phase" },
 
  { name: "stage", label: "Assembly Stage" },

  { name: "assembledBy", label: "Assembled By" },

  { name: "qty", label: "Quantity" },
 
 
  { name: "serial", label: "Serial Number" },

  { name: "date", label: "Date" },

  // { name: "qc", label: "QC Status" },
 
  // { name: "qcBy", label: "QC Done By" },
 
  // { name: "packagingStatus", label: "Packaging Status" }
 
];
 
function validateAssemblyForm(values, { validateSerialList = true } = {}) {
 
  const missing = REQUIRED_FIELDS.filter(
 
    ({ name }) => !String(values[name] ?? "").trim()
 
  );
 
  if (missing.length) {
 
    return `Please fill in: ${missing.map((field) => field.label).join(", ")}.`;
 
  }
 
  if (!Number.isFinite(Number(values.qty)) || Number(values.qty) <= 0) {

    return "Quantity must be greater than zero.";
 
  }
  if (values.qc && values.stage !== "Completed") {
    return "Complete assembly before updating QC.";
  }
  if (values.qc === "Passed" && !isQcInspectionComplete(values.qcInspection)) {
    return "Complete the QC inspection report before marking QC as Passed.";
  }
  if (
    values.packagingStatus &&
    (values.qc !== "Passed" || !isQcInspectionComplete(values.qcInspection))
  ) {
    return "Complete and pass the QC inspection before selecting Packaging Status.";
  }
  if (validateSerialList) {
    const quantity = Number(values.qty);
    const serialNumbers = Array.isArray(values.serialNumbers) ? values.serialNumbers : [];
    if (serialNumbers.length !== quantity || serialNumbers.some((serial) => !String(serial).trim())) {
      return `Please enter ${quantity} Serial Number${quantity === 1 ? "" : "s"}.`;
    }
    if (new Set(serialNumbers.map((serial) => String(serial).trim().toLowerCase())).size !== serialNumbers.length) {
      return "Duplicate Serial Numbers are not allowed.";
    }
  }
 
  return null;
 
}
 
function formatDetailValue(field, row) {
 
  const raw = row?.[field.key];
 
  if (raw === null || raw === undefined || String(raw).trim() === "") {
 
    return "Not Provided";
 
  }
 
  return field.isDate ? formatDate(raw, "Not Provided") : String(raw);
 
}
 
// ---------- Friendly error extraction for network/API failures ----------
 
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
 
 
 
export default function DailyProduction() {
  const { role, name: currentUserName, userId: currentUserId } = useAuth();
  const chartTheme = useThemeColors();
  const isRegularUser = role === "user";
  const isProductionIncharge = role === "production_incharge";
  const canManageProduction = role === "admin" || role === "coadmin" || role === "production_incharge";
  const addActionLabel = isProductionIncharge ? "Assign Task" : "Add Assembly Unit";
 
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
 
  const [rows, setRows] = useState([]);
  const [productionStats, setProductionStats] = useState(null);
  const [expandedGraph, setExpandedGraph] = useState(null);
  const [graphYear, setGraphYear] = useState("all");
  const [graphMonth, setGraphMonth] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
 
  // ---------- Assembly list loading/error state ----------
 
  const [rowsLoading, setRowsLoading] = useState(false);
 
  const [rowsError, setRowsError] = useState("");
 
  const [modalOpen, setModalOpen] = useState(false);
 
  const [isEditMode, setIsEditMode] = useState(false);
 
  const [closing, setClosing] = useState(false);
 
  const [formValues, setFormValues] = useState(emptyAssemblyForm);

  const [editOriginalValues, setEditOriginalValues] = useState(null);
 
  const [formError, setFormError] = useState("");

  const [qcInspectionTarget, setQcInspectionTarget] = useState(null);
  const [qcInspectionDraft, setQcInspectionDraft] = useState(createEmptyQcInspection());
  const [qcInspectionError, setQcInspectionError] = useState("");
  const [qcInspectionSaving, setQcInspectionSaving] = useState(false);
 
  const [saving, setSaving] = useState(false);
  const [updatingTask, setUpdatingTask] = useState("");
 
  // ---------- View modal (read-only detail popup, same shape as
 
  // PODetails' details popup, with an Edit button that hands off to the
 
  // existing Add/Edit form modal) ----------
 
  const [viewRow, setViewRow] = useState(null);
 
  const [viewOpen, setViewOpen] = useState(false);
 
  const [viewClosing, setViewClosing] = useState(false);
 
  // ---------- Bulk select / delete (same pattern as PO Details) ----------
 
  const [selectMode, setSelectMode] = useState(false);
 
  const [selectedIds, setSelectedIds] = useState(new Set());
 
  const [bulkDeleting, setBulkDeleting] = useState(false);
 
  const [deletingId, setDeletingId] = useState(null);
 
  const [menuOpen, setMenuOpen] = useState(false);
 
  const menuRef = useRef(null);
 
  // ---------- Model dropdown state ----------
 
  const [models, setModels] = useState([]);
 
  const [modelsLoading, setModelsLoading] = useState(false);
 
  const [modelsError, setModelsError] = useState("");

  const [productionUsers, setProductionUsers] = useState([]);

  const [usersLoading, setUsersLoading] = useState(false);

  const [usersError, setUsersError] = useState("");
 
  // ---------- Phase dropdown state (depends on selected model) ----------
 
  const [phases, setPhases] = useState([]);
 
  const [phasesLoading, setPhasesLoading] = useState(false);
 
  const [phasesError, setPhasesError] = useState("");
 
  useEffect(() => {
 
    const handleClickOutside = (e) => {
 
      if (menuRef.current && !menuRef.current.contains(e.target)) {
 
        setMenuOpen(false);
 
      }
 
    };
 
    document.addEventListener("mousedown", handleClickOutside);
 
    return () => document.removeEventListener("mousedown", handleClickOutside);
 
  }, []);
 
  // ---------- Fetch Assembly records from the backend (initial load + post-save refresh) ----------
 
  const fetchAssemblyUnits = useCallback(async ({ silent = false, targetPage } = {}) => {
 
    if (!silent) setRowsLoading(false);
 
    setRowsError("");
 
    try {
 
      const pageToFetch = targetPage ?? page;
      const res = await api.get(`${API_BASE_URL}/assembly`, { params: { page: pageToFetch, limit: PAGE_SIZE } });
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to load Assembly Units");
 
      }
 
      setRows(res.data.assemblyUnits || []);
      const pagination = res.data.pagination;
      if (pagination) {
        setTotalPages(pagination.totalPages || 1);
        setTotalCount(pagination.totalCount || 0);
        if (pagination.page !== pageToFetch) setPage(pagination.page);
      }
 
    } catch (err) {
 
      setRowsError(extractErrorMessage(err, "Failed to load Assembly Units."));
 
    } finally {
 
      if (!silent) setRowsLoading(false);
 
    }
 
  }, [page]);
 
  useEffect(() => {
 
    fetchAssemblyUnits({ targetPage: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
 
  // ---------- Fetch Models from the existing Model Management backend ----------
 
  const fetchModels = useCallback(async () => {
 
    setModelsLoading(true);
 
    setModelsError("");
 
    try {
 
      const res = await api.get(`${API_BASE_URL}/models`);
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to load Models");
 
      }
 
      setModels(res.data.models || []);
 
    } catch (err) {
 
      setModelsError(extractErrorMessage(err, "Failed to load Models"));
 
    } finally {
 
      setModelsLoading(false);
 
    }
 
  }, []);
 
  useEffect(() => {

    fetchModels();

  }, [fetchModels]);

  const fetchProductionUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError("");
    try {
      const res = await api.get(`${API_BASE_URL}/production-users`);
      if (!res.data.success) throw new Error(res.data.message || "Failed to load users");
      setProductionUsers(res.data.users || []);
    } catch (err) {
      setUsersError(extractErrorMessage(err, "Failed to load users"));
      setProductionUsers([]);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManageProduction) fetchProductionUsers();
  }, [canManageProduction, fetchProductionUsers]);
 
  useEffect(() => {
 
    if (!modalOpen) return;
 
    fetchModels();
 
  }, [modalOpen, fetchModels]);
 
  // ---------- Fetch Phases for a given Model ----------
 
  const fetchPhases = useCallback(async (modelId) => {
 
    setPhasesLoading(true);
 
    setPhasesError("");
 
    setPhases([]);
 
    try {
 
      const res = await api.get(`${API_BASE_URL}/models/${modelId}/phases`);
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to load Phases");
 
      }
 
      setPhases(res.data.phases || []);
 
    } catch (err) {
 
      setPhasesError(extractErrorMessage(err, "Failed to load Phases"));
 
      setPhases([]);
 
    } finally {
 
      setPhasesLoading(false);
 
    }
 
  }, []);
 
  const modelOptions = useMemo(
 
    () => models.map((m) => ({ value: m.id, label: m.name })),
 
    [models]
 
  );
 
  const phaseOptions = useMemo(
 
    () => phases.map((p) => ({ value: p.id, label: p.name })),
 
    [phases]
 
  );

  const userOptions = useMemo(
    () => productionUsers.map((user) => ({ value: user.id, label: user.name })),
    [productionUsers]
  );

  const handleUserSelect = (field) => (value) => {
    const selectedUser = productionUsers.find((user) => user.id === value);
    setFormValues((prev) => ({
      ...prev,
      [field]: selectedUser?.name || "",
      [`${field}Id`]: selectedUser?.id || "",
    }));
  };
 
  const handleModelSelect = (modelId) => {
 
    const found = models.find((m) => m.id === modelId);
 
    setFormValues((prev) => ({
 
      ...prev,
 
      modelId: found ? found.id : "",
 
      model: found ? found.name : "",
 
      phaseId: "",
 
      phase: "",
 
    }));
 
    setPhases([]);
 
    setPhasesError("");
 
    if (found) {
 
      fetchPhases(found.id);
 
    }
 
  };
 
  const handlePhaseSelect = (phaseId) => {
 
    const found = phases.find((p) => p.id === phaseId);
 
    setFormValues((prev) => ({
 
      ...prev,
 
      phaseId: found ? found.id : "",
 
      phase: found ? found.name : "",
 
    }));
 
  };
 
  const filteredRows = useMemo(() => {
 
    const q = query.trim().toLowerCase();
 
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, PRODUCTION_FILTER_FIELDS);
    });
 
  }, [query, rows, pageFilter]);
 
  const openAddModal = () => {
 
    setIsEditMode(false);
    setEditOriginalValues(null);
 
    setFormValues(emptyAssemblyForm);
 
    setFormError("");
 
    setClosing(false);
 
    setPhases([]);
 
    setPhasesError("");
 
    setModalOpen(true);
 
    setMenuOpen(false);
 
  };
 
  const openEditModal = (row) => {
 
    setIsEditMode(true);

    const nextFormValues = {
 
      id: row.id,
 
      modelId: row.modelId || "",
 
      model: row.model || "",
 
      phaseId: row.phaseId || "",
 
      phase: row.phase || "",
 
      stage: row.stage || "",
      assembledBy: row.assembledBy || "",
      assembledById: row.assembledById || productionUsers.find((user) => user.name === row.assembledBy)?.id || "",
 
      unitNumber: row.unitNumber || "",
 
      serial: row.serial || "",
      serialNumbers: [row.serial || ""],
 
      technicianName: row.technicianName || "",
 
      date: row.date || "",
 
      qty: row.qty || "",
 
      qc: row.qc || "",
 
      qcBy: row.qcBy || "",
      qcById: row.qcById || productionUsers.find((user) => user.name === row.qcBy)?.id || "",
 
      packagingStatus: row.packagingStatus || "",
 
      packagedBy: row.packagedBy || "",
      packagedById: row.packagedById || productionUsers.find((user) => user.name === row.packagedBy)?.id || "",

      qcInspection: row.qcInspection || {},
      qcFailureHistory: normalizeQcFailureHistory(row.qcFailureHistory),
 
      remarks: row.remarks || "",
 
    };

    setFormValues(nextFormValues);
    setEditOriginalValues(nextFormValues);
 
    setFormError("");
 
    setClosing(false);
 
    if (row.modelId) {
 
      fetchPhases(row.modelId);
 
    } else {
 
      setPhases([]);
 
    }
 
    setPhasesError("");
 
    setModalOpen(true);
 
  };
 
  const requestClose = async (skipConfirmation = false) => {
 
    if (closing) return;

    const initialValues = isEditMode ? editOriginalValues : emptyAssemblyForm;
    if (skipConfirmation !== true && JSON.stringify(formValues) !== JSON.stringify(initialValues)) {
      const result = await swalConfirm({
        title: "Discard unsaved changes?",
        text: "Your assembly-unit changes will be lost unless you save them.",
        confirmText: "Discard changes",
      });
      if (!result.isConfirmed) return;
    }

    setClosing(true);
 
    setTimeout(() => {
 
      setModalOpen(false);
 
      setClosing(false);
 
      setFormValues(emptyAssemblyForm);
 
      setFormError("");
 
      setPhases([]);
 
      setPhasesError("");
 
      setIsEditMode(false);
      setEditOriginalValues(null);

      setQcInspectionTarget(null);
      setQcInspectionError("");
 
    }, 220);
 
  };
 
  const handleFormChange = (event) => {
 
    const { name, value } = event.target;

    if (name === "qc" && (value === "Passed" || value === "Failed")) {
      setQcInspectionDraft(normalizeQcInspection(formValues.qcInspection, formValues.qcBy || currentUserName));
      setQcInspectionError("");
      setQcInspectionTarget({ type: "form", previousQc: formValues.qc });
    }
 
    setFormValues((prev) => {
      const next = { ...prev, [name]: value };
      if (name === "qty" && !isEditMode) {
        const quantity = Math.max(0, Number(value) || 0);
        next.serialNumbers = [...(prev.serialNumbers || [])].slice(0, quantity);
        while (next.serialNumbers.length < quantity) next.serialNumbers.push("");
        next.serial = next.serialNumbers[0] || "";
      }
      if (name === "stage" && value !== "Completed") {
        next.qc = "";
        next.qcBy = "";
        next.qcById = "";
        next.qcInspection = {};
        next.packagingStatus = "";
        next.packagedBy = "";
        next.packagedById = "";
      }
      if (name === "qc" && value !== "Passed") {
        next.qcInspection = {};
        next.packagingStatus = "";
        next.packagedBy = "";
        next.packagedById = "";
      }
      return next;
    });
 
  };

  const handleSerialNumberChange = (index, value) => {
    setFormValues((prev) => {
      const serialNumbers = [...(prev.serialNumbers || [])];
      serialNumbers[index] = value.toUpperCase();
      return { ...prev, serialNumbers, serial: serialNumbers[0] || "" };
    });
  };

  const handleQcInspectionFieldChange = (event) => {
    const { name, value } = event.target;
    setQcInspectionDraft((current) => ({ ...current, [name]: value }));
    setQcInspectionError("");
  };

  const handleQcCheckChange = (key, value) => {
    setQcInspectionDraft((current) => ({
      ...current,
      checks: { ...current.checks, [key]: value },
    }));
    setQcInspectionError("");
  };

  const cancelQcInspection = () => {
    if (qcInspectionSaving) return;
    if (qcInspectionTarget?.type === "form") {
      setFormValues((current) => {
        const keepExistingPackaging = qcInspectionTarget.previousQc === "Passed" &&
          isQcInspectionComplete(current.qcInspection);
        return {
          ...current,
          qc: qcInspectionTarget.previousQc || "",
          packagingStatus: keepExistingPackaging ? current.packagingStatus : "",
          packagedBy: keepExistingPackaging ? current.packagedBy : "",
          packagedById: keepExistingPackaging ? current.packagedById : "",
        };
      });
    }
    setQcInspectionTarget(null);
    setQcInspectionError("");
  };

  const completeQcInspection = async () => {
    const error = validateQcInspection(qcInspectionDraft);
    if (error) {
      setQcInspectionError(error);
      return;
    }

    const failedItems = getFailedQcItems(qcInspectionDraft);
    const completedReport = {
      ...qcInspectionDraft,
      completedAt: new Date().toISOString(),
    };

    if (qcInspectionTarget?.type === "form") {
      if (failedItems.length) {
        const failureEntry = buildQcFailureEntry(qcInspectionDraft);
        setFormValues((current) => ({
          ...current,
          qc: "Failed",
          qcInspection: {},
          qcFailureHistory: [
            ...normalizeQcFailureHistory(current.qcFailureHistory),
            failureEntry,
          ],
          packagingStatus: "",
          packagedBy: "",
          packagedById: "",
        }));
        setQcInspectionTarget(null);
        setQcInspectionError("");
        await swalSuccess(
          "QC Failure Recorded",
          `${failedItems.length} failed check${failedItems.length === 1 ? "" : "s"} added to the history. Save the Assembly Unit to persist it.`
        );
        return;
      }
      setFormValues((current) => ({
        ...current,
        qc: "Passed",
        qcInspection: completedReport,
      }));
      setQcInspectionTarget(null);
      setQcInspectionError("");
      return;
    }

    const row = qcInspectionTarget?.row;
    if (!row?.id) return;
    setQcInspectionSaving(true);
    setUpdatingTask(`${row.id}:qc`);
    try {
      const response = failedItems.length
        ? await api.post(`${API_BASE_URL}/assembly/${row.id}/qc-failures`, {
            qcInspection: qcInspectionDraft,
          })
        : await api.put(`${API_BASE_URL}/assembly/${row.id}`, {
            qc: "Passed",
            qcInspection: completedReport,
          });
      if (!response.data.success) throw new Error(response.data.message || "Failed to save QC inspection");
      const updatedRow = response.data.assemblyUnit;
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, ...updatedRow } : item));
      setQcInspectionTarget(null);
      setQcInspectionError("");
      await swalSuccess(
        failedItems.length ? "QC Failure Logged" : "QC Inspection Completed",
        failedItems.length
          ? `${failedItems.length} failed check${failedItems.length === 1 ? "" : "s"} saved with the current date and time.`
          : "QC passed. Packaging Status is now available."
      );
    } catch (err) {
      setQcInspectionError(extractErrorMessage(err, "The QC inspection could not be saved."));
    } finally {
      setQcInspectionSaving(false);
      setUpdatingTask("");
    }
  };

  const downloadQcReportFor = async (record, setError = setFormError) => {
    if (!isQcInspectionComplete(record?.qcInspection)) {
      setError("Complete the QC inspection report before downloading the PDF.");
      return;
    }
    try {
      await exportQcReportToPdf({
        model: record.model,
        serial: record.serial,
        logoUrl: VECTOR_PDF_LOGO_URL,
        inspection: {
          ...record.qcInspection,
          items: QC_INSPECTION_ITEMS.map((item) => ({
            ...item,
            status: record.qcInspection.checks?.[item.key] || "",
          })),
        },
      });
    } catch (error) {
      setError(error?.message || "The QC report PDF could not be generated.");
    }
  };

  // ---------- View modal open/close ----------
 
  const openView = (row) => {
 
    setViewRow(row);
 
    setViewClosing(false);
 
    setViewOpen(true);
 
    setMenuOpen(false);
 
  };
 
  const requestCloseView = () => {
 
    if (viewClosing) return;
 
    setViewClosing(true);
 
    setTimeout(() => {
 
      setViewOpen(false);
 
      setViewClosing(false);
 
      setViewRow(null);
 
    }, 200);
 
  };

  const openQcReportView = (row) => {
    if (
      !isQcInspectionComplete(row?.qcInspection) &&
      normalizeQcFailureHistory(row?.qcFailureHistory).length === 0
    ) return;
    setQcInspectionDraft(normalizeQcInspection(row.qcInspection));
    setQcInspectionError("");
    setQcInspectionTarget({ type: "view", row });
  };
 
  // Edit-from-view hands off to the existing, fully-featured Add/Edit
 
  // form modal (same cascading Model -> Phase logic, same field
 
  // validation) instead of duplicating that logic in a second form.
 
  const startEditFromView = () => {
 
    const row = viewRow;
 
    setViewOpen(false);
 
    setViewClosing(false);
 
    setViewRow(null);
 
    if (row) openEditModal(row);
 
  };
 
  useEffect(() => {
 
    if (!viewOpen) return;
 
    const handleKey = (e) => {
 
      if (e.key === "Escape") requestCloseView();
 
    };
 
    window.addEventListener("keydown", handleKey);
 
    return () => window.removeEventListener("keydown", handleKey);
 
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOpen]);
 
  // ---------- Save/Update Assembly record to the backend, then refresh the table ----------
 
  const handleSave = async () => {
 
    if (saving) return;
 
    const error = validateAssemblyForm(formValues, { validateSerialList: !isEditMode });
 
    if (error) {
 
      setFormError(error);
 
      return;
 
    }
 
    setSaving(true);
 
    setFormError("");
 
    try {
 
      const payload = isEditMode
        ? buildAssemblyUpdatePayload(formValues, editOriginalValues)
        : { ...formValues };
 
      let res;
 
      if (isEditMode) {
        if (Object.keys(payload).length === 0) {
          setSaving(false);
          setFormError("No changes to update.");
          return;
        }
 
        res = await api.put(`${API_BASE_URL}/assembly/${formValues.id}`, payload);
 
      } else {
 
        res = await api.post(`${API_BASE_URL}/assembly`, payload);
 
      }
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to save Assembly Unit");
 
      }
 
      setSaving(false);
 
      requestClose(true);
 
      await swalSuccess(
 
        isEditMode ? "Assembly Unit Updated" : isProductionIncharge ? "Production Task Assigned" : "Assembly Unit Saved",
 
        `The Assembly Unit has been ${isEditMode ? "updated" : "saved"} successfully.`
 
      );
 
      await fetchAssemblyUnits({ silent: true, targetPage: page });
 
    } catch (err) {
 
      setSaving(false);
 
      setFormError(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
 
    }
 
  };
 
  // ---------- Single-row delete ----------
 
  const handleDeleteClick = async (row) => {
 
    const id = getRowId(row);
 
    if (!id) return;
 
    const result = await swalConfirm({
 
      title: "Delete this record?",
 
      text: "Are you sure you want to delete this Assembly Unit? This action cannot be undone.",
 
    });
 
    if (!result.isConfirmed) return;
 
    setDeletingId(id);
 
    try {
 
      const res = await api.delete(`${API_BASE_URL}/assembly/${id}`);
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to delete Assembly Unit");
 
      }
 
      await fetchAssemblyUnits({ silent: true, targetPage: rows.length === 1 && page > 1 ? page - 1 : page });
 
      swalSuccess("Assembly Unit Deleted", "The record has been removed successfully.");
 
    } catch (err) {
 
      swalError("Delete failed", extractErrorMessage(err, "Something went wrong while deleting."));
 
    } finally {
 
      setDeletingId(null);
 
    }
 
  };
 
  // ---------- Bulk select / delete (mirrors PO Details) ----------
 
  const toggleSelectMode = () => {
 
    setSelectMode((prev) => !prev);
 
    setSelectedIds(new Set());
 
    setMenuOpen(false);
 
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
 
  const handleDeleteSelected = async () => {
 
    if (selectedIds.size === 0) return;
 
    const result = await swalConfirm({
 
      title: "Delete selected Assembly Units?",
 
      text: `Delete ${selectedIds.size} selected Assembly Unit(s)? This cannot be undone.`,
 
    });
 
    if (!result.isConfirmed) return;
 
    setBulkDeleting(true);
 
    try {
 
      const res = await api.post(`${API_BASE_URL}/assembly/bulk-delete`, {
 
        ids: Array.from(selectedIds),
 
      });
 
      if (!res.data.success) {
 
        throw new Error(res.data.message || "Failed to delete Assembly Units");
 
      }
 
      const deletedCount = selectedIds.size;
 
      setSelectMode(false);
 
      setSelectedIds(new Set());
 
      setMenuOpen(false);
 
      await fetchAssemblyUnits({ silent: true, targetPage: rows.length === deletedCount && page > 1 ? page - 1 : page });
 
      swalSuccess("Assembly Units Deleted", `${deletedCount} record(s) removed.`);
 
    } catch (err) {
 
      swalError("Delete failed", extractErrorMessage(err, "Something went wrong while deleting."));
 
    } finally {
 
      setBulkDeleting(false);
 
    }
 
  };

  const isTaskAssignedToCurrentUser = useCallback((row, idField, nameField) => {
    const assignedId = String(row?.[idField] || "").trim();
    if (assignedId && currentUserId) return assignedId === currentUserId;
    return Boolean(
      currentUserName &&
      String(row?.[nameField] || "").trim().toLocaleLowerCase() === currentUserName.trim().toLocaleLowerCase()
    );
  }, [currentUserId, currentUserName]);

  const handleInlineTaskUpdate = useCallback(async (row, field, value) => {
    if (!row?.id) return;
    if (field === "qc" && (value === "Passed" || value === "Failed")) {
      setQcInspectionDraft(normalizeQcInspection(row.qcInspection, row.qcBy || currentUserName));
      setQcInspectionError("");
      setQcInspectionTarget({ type: "row", row });
      return;
    }
    if (row[field] === value) return;
    const updateKey = `${row.id}:${field}`;
    setUpdatingTask(updateKey);
    try {
      const response = await api.put(`${API_BASE_URL}/assembly/${row.id}`, { [field]: value });
      if (!response.data.success) throw new Error(response.data.message || "Failed to update task");
      const updatedRow = response.data.assemblyUnit;
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, ...updatedRow } : item));
      await swalSuccess("Task Updated", "Your assigned production task was updated successfully.");
    } catch (err) {
      await swalError("Update failed", extractErrorMessage(err, "The task could not be updated."));
    } finally {
      setUpdatingTask("");
    }
  }, [currentUserName]);
 
  // ---------- Table columns: prepend a checkbox column while in select mode ----------
 
  const tableColumns = useMemo(() => {
    const roleColumns = isRegularUser
      ? columns.map((column) => {
          const config = {
            stage: { options: ASSEMBLY_STAGE_OPTIONS, idField: "assembledById", nameField: "assembledBy" },
            qc: { options: QC_STATUS_OPTIONS, idField: "qcById", nameField: "qcBy" },
            packagingStatus: { options: PACKAGING_STATUS_OPTIONS, idField: "packagedById", nameField: "packagedBy" },
          }[column.key];
          if (!config) return column;
          return {
            ...column,
            render: (row) => {
              if (!isTaskAssignedToCurrentUser(row, config.idField, config.nameField)) {
                return row[column.key] || "Not assigned";
              }
              const prerequisiteMissing =
                (column.key === "qc" && row.stage !== "Completed") ||
                (column.key === "packagingStatus" && (
                  row.qc !== "Passed" || !isQcInspectionComplete(row.qcInspection)
                ));
              const updateKey = `${row.id}:${column.key}`;
              return (
                <div
                  className="production-inline-status"
                  title={prerequisiteMissing ? (column.key === "qc" ? "Complete assembly first" : "Complete the QC inspection first") : "Update your assigned task"}
                >
                  <StatusDropdown
                    name={column.key}
                    value={row[column.key] || ""}
                    options={config.options}
                    onChange={(event) => handleInlineTaskUpdate(row, column.key, event.target.value)}
                    placeholder="Select status"
                    disabled={prerequisiteMissing || updatingTask === updateKey}
                  />
                </div>
              );
            },
          };
        })
      : columns;
 
    if (!selectMode) return roleColumns;
 
    const selectColumn = {
 
      key: "__select",
 
      label: "",
 
      render: (row) => {
 
        const id = getRowId(row);
 
        return (
<input
 
            type="checkbox"
 
            className="production-row-checkbox"
 
            checked={selectedIds.has(id)}
 
            onChange={() => toggleSelectOne(id)}
 
            onClick={(e) => e.stopPropagation()}
 
            aria-label="Select row"
 
          />
 
        );
 
      },
 
    };
 
    return [selectColumn, ...roleColumns];
 
  }, [selectMode, selectedIds, isRegularUser, isTaskAssignedToCurrentUser, handleInlineTaskUpdate, updatingTask]);
 
  const phaseDisabled = !formValues.modelId;
  const qcEnabled = formValues.stage === "Completed";
  const packagingEnabled = qcEnabled && formValues.qc === "Passed" && isQcInspectionComplete(formValues.qcInspection);
  const qcReportReadOnly = qcInspectionTarget?.type === "view";
  const qcFailureHistory = normalizeQcFailureHistory(
    qcInspectionTarget?.type === "form"
      ? formValues.qcFailureHistory
      : qcInspectionTarget?.row?.qcFailureHistory
  );
  const qcFailureOnlyView = qcReportReadOnly && !isQcInspectionComplete(qcInspectionTarget?.row?.qcInspection);
  const qcDraftFailureCount = getFailedQcItems(qcInspectionDraft).length;
 
  const phaseEmptyMessage = phasesError
 
    ? phasesError
 
    : "No Phases Available for this model.";
 
  // The button is enabled once the required assembly fields are complete.
 
  // catching missing fields after the user clicks Save.
 
  const formIsIncomplete = validateAssemblyForm(formValues, { validateSerialList: !isEditMode }) !== null;
 
  useEffect(() => {
    api.get(`${API_BASE_URL}/dashboard`, { __vectorBackground: true })
      .then((response) => setProductionStats(response.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    prepareQcReportPdf(VECTOR_PDF_LOGO_URL).catch(() => {});
  }, []);

  const productionMonths = useMemo(() => {
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const assembled = names.map((month) => ({ month, units: 0 }));
    const qc = names.map((month) => ({ month, Passed: 0, Failed: 0, Pending: 0, "Under Inspection": 0 }));
    const packaged = names.map((month) => ({ month, Packed: 0, Pending: 0, "In Progress": 0 }));
    const matches = (period) => (graphYear === "all" || String(period).startsWith(graphYear)) && (graphMonth === "all" || String(period).slice(5, 7) === graphMonth);
    (productionStats?.assembledByMonth || []).forEach((item) => { if (!matches(item.period)) return; const i = Number(String(item.period).slice(5, 7)) - 1; if (i >= 0 && i < 12) assembled[i].units += Number(item.units || 0); });
    (productionStats?.qcByMonthStatus || []).forEach((item) => { if (!matches(item.period)) return; const i = Number(String(item.period).slice(5, 7)) - 1; if (i >= 0 && i < 12 && item.status in qc[i]) qc[i][item.status] += Number(item.units || 0); });
    (productionStats?.packagedByMonthStatus || []).forEach((item) => { if (!matches(item.period)) return; const i = Number(String(item.period).slice(5, 7)) - 1; if (i >= 0 && i < 12 && item.status in packaged[i]) packaged[i][item.status] += Number(item.units || 0); });
    return { assembled, qc, packaged };
  }, [productionStats, graphYear, graphMonth]);
  const graphYears = useMemo(() => Array.from(new Set(["2025", ...[
    ...(productionStats?.assembledByMonth || []),
    ...(productionStats?.qcByMonthStatus || []),
    ...(productionStats?.packagedByMonthStatus || []),
  ].map((item) => String(item.period || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))])).sort().reverse(), [productionStats]);
  const graphMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const graphFilters = <div className="production-graph-filters"><label>Year <select value={graphYear} onChange={(event) => setGraphYear(event.target.value)}><option value="all">All years</option>{graphYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label>Month <select value={graphMonth} onChange={(event) => setGraphMonth(event.target.value)}><option value="all">All months</option>{graphMonths.map((month, index) => <option key={month} value={String(index + 1).padStart(2, "0")}>{month}</option>)}</select></label><button type="button" onClick={() => { setGraphYear("all"); setGraphMonth("all"); }}>Clear</button></div>;

  return (
<div className={`production-page${isRegularUser ? " production-user-view" : ""}`}>
<section className="production-graphs">
  <div className={`production-graph${expandedGraph === "assembled" ? " production-graph-expanded" : ""}`}><div className="production-graph-heading"><h3>Monthly Units Assembled</h3><div>{graphFilters}<button className="production-graph-expand" type="button" onClick={() => setExpandedGraph(expandedGraph === "assembled" ? null : "assembled")} aria-label="Expand assembled units graph">{expandedGraph === "assembled" ? <Minimize2 size={16} /> : <Expand size={16} />}</button></div></div><ResponsiveContainer width="100%" height={expandedGraph === "assembled" ? 620 : 220}><LineChart data={productionMonths.assembled}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fill: chartTheme.axis }} /><YAxis allowDecimals={false} tick={{ fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} /><Line dataKey="units" name="Assembled units" stroke={chartTheme.accent} strokeWidth={3} /></LineChart></ResponsiveContainer></div>
  <div className={`production-graph${expandedGraph === "qc" ? " production-graph-expanded" : ""}`}><div className="production-graph-heading"><h3>Monthly QC Status</h3><div>{graphFilters}<button className="production-graph-expand" type="button" onClick={() => setExpandedGraph(expandedGraph === "qc" ? null : "qc")} aria-label="Expand QC graph">{expandedGraph === "qc" ? <Minimize2 size={16} /> : <Expand size={16} />}</button></div></div><ResponsiveContainer width="100%" height={expandedGraph === "qc" ? 620 : 220}><BarChart data={productionMonths.qc}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fill: chartTheme.axis }} /><YAxis allowDecimals={false} tick={{ fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend /><Bar dataKey="Passed" stackId="qc" fill={chartTheme.success} /><Bar dataKey="Pending" stackId="qc" fill={chartTheme.muted} /><Bar dataKey="Under Inspection" stackId="qc" fill={chartTheme.warning} /><Bar dataKey="Failed" stackId="qc" fill={chartTheme.danger} /></BarChart></ResponsiveContainer></div>
  <div className={`production-graph${expandedGraph === "packaged" ? " production-graph-expanded" : ""}`}><div className="production-graph-heading"><h3>Monthly Packaging Status</h3><div>{graphFilters}<button className="production-graph-expand" type="button" onClick={() => setExpandedGraph(expandedGraph === "packaged" ? null : "packaged")} aria-label="Expand packaging graph">{expandedGraph === "packaged" ? <Minimize2 size={16} /> : <Expand size={16} />}</button></div></div><ResponsiveContainer width="100%" height={expandedGraph === "packaged" ? 620 : 220}><BarChart data={productionMonths.packaged}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fill: chartTheme.axis }} /><YAxis allowDecimals={false} tick={{ fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend /><Bar dataKey="Pending" stackId="pack" fill={chartTheme.muted} /><Bar dataKey="In Progress" stackId="pack" fill={chartTheme.warning} /><Bar dataKey="Packed" stackId="pack" fill={chartTheme.success} /></BarChart></ResponsiveContainer></div>
</section>
<div className="production-toolbar">
        <div className="production-toolbar-actions">
 
          {selectMode ? (
<>
<button type="button" className="production-add-btn" onClick={toggleSelectAll}>
<Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
</button>
<button
 
                type="button"
 
                className="production-add-btn"
 
                onClick={handleDeleteSelected}
 
                disabled={selectedIds.size === 0 || bulkDeleting}
>
<Trash2 size={16} />
 
                {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
</button>
<button type="button" className="production-add-btn" onClick={toggleSelectMode}>
<X size={16} /> Cancel
</button>
</>
 
          ) : (
<>
<button type="button" className="production-add-btn" onClick={openAddModal}>
<Plus size={18} />
 
                {addActionLabel}
</button>
<button type="button" className="production-delete-btn" onClick={toggleSelectMode}>
<Trash2 size={16} /> Delete
</button>
</>
 
          )}
</div>
 
        <div className="production-kebab-wrapper" ref={menuRef}>
<button
 
            type="button"
 
            className="production-kebab-btn"
 
            onClick={() => setMenuOpen((prev) => !prev)}
 
            aria-label="More actions"
>
<MoreVertical size={20} />
</button>
 
          {menuOpen && (
<div className="production-kebab-menu">
 
              {selectMode ? (
<>
<button type="button" className="production-menu-item" onClick={toggleSelectAll}>
<Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
</button>
<button
 
                    type="button"
 
                    className="production-menu-item"
 
                    onClick={handleDeleteSelected}
 
                    disabled={selectedIds.size === 0 || bulkDeleting}
>
<Trash2 size={16} />
 
                    {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
</button>
<button type="button" className="production-menu-item" onClick={toggleSelectMode}>
<X size={16} /> Cancel
</button>
</>
 
              ) : (
<>
<button type="button" className="production-menu-item" onClick={openAddModal}>
<Plus size={16} /> {addActionLabel}
</button>
<button type="button" className="production-menu-item" onClick={toggleSelectMode}>
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
<SearchBar value={query} onChange={setQuery} placeholder="Search Assembly Units..." />
<PageFilter rows={rows} fields={PRODUCTION_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
</div>
<ExportPdfButton
 
            mode="table"
 
            title="Daily Production"
 
            columns={columns}
 
            rows={filteredRows}
 
          />
</div>
 
        {rowsLoading ? (
<div className="production-loading">
<Loader2 size={28} className="spin" />
<span>Loading Assembly Units...</span>
</div>
 
        ) : rowsError ? (
<div className="production-load-error">
<div className="production-load-error-actions">
<span>{rowsError}</span>
<button
 
                type="button"
 
                className="production-btn-secondary"
 
                onClick={() => fetchAssemblyUnits({ targetPage: page })}
>
<RefreshCw size={14} />
 
                Retry
</button>
</div>
</div>
 
        ) : rows.length === 0 ? (
<div className="production-empty-state">
<span>{isRegularUser ? "No production tasks are currently assigned to you." : "No Assembly Units yet. Click \"Add Assembly Unit\" to create the first record."}</span>
</div>
 
        ) : (
<DataTable
 
            columns={tableColumns}
 
            rows={filteredRows}
 
            onViewDetails={selectMode || isRegularUser ? undefined : openView}
 
            onEdit={selectMode ? undefined : openEditModal}
 
            onDelete={selectMode ? undefined : handleDeleteClick}
 
            deletingId={deletingId}
 
          />
 
        )}
</div>
 
      {!rowsLoading && !rowsError && rows.length > 0 && (
        <div className="production-pagination">
          <p className="production-hint">Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows</p>
          <div className="production-pagination-controls">
            <button type="button" className="production-page-btn" onClick={() => setPage(1)} disabled={page === 1}><ChevronsLeft size={16} /></button>
            {page > 1 && <button type="button" className="production-page-btn" onClick={() => setPage(page - 1)}><ChevronLeft size={16} /> Prev</button>}
            <span className="production-page-current" key={page}>{page}</span>
            {page < totalPages && <button type="button" className="production-page-btn" onClick={() => setPage(page + 1)}>Next <ChevronRight size={16} /></button>}
            <button type="button" className="production-page-btn" onClick={() => setPage(totalPages)} disabled={page === totalPages}><ChevronsRight size={16} /></button>
          </div>
        </div>
      )}
 
      {/* ---------- Add/Edit Assembly Unit Modal ---------- */}
 
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
 
            aria-label={isEditMode ? "Edit Assembly Unit" : isProductionIncharge ? "Assign Production Task" : "Add Assembly Unit"}
>
<div className="modal-header">
<h2>{isEditMode ? "Edit Assembly Unit" : isProductionIncharge ? "Assign Production Task" : "Add Assembly Unit"}</h2>
<button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
<X size={22} />
</button>
</div>
 
            <form
 
              className="production-form"
 
              onSubmit={(e) => {
 
                e.preventDefault();
 
                handleSave();
 
              }}
>
 
              {formError && <div className="production-form-error">{formError}</div>}
 
              <div className="production-form-grid">
                <label className="production-field">
<span>Date <span className="production-required-asterisk">*</span></span>
<DatePicker value={formValues.date} onChange={(date) => setFormValues((prev) => ({ ...prev, date }))} ariaLabel="Select assembly date" />
</label>

<label className="production-field">
<span>Model <span className="production-required-asterisk">*</span></span>
<SearchableSelect
 
                    options={modelOptions}
 
                    value={formValues.modelId}
 
                    onChange={handleModelSelect}
 
                    placeholder="Select Model"
 
                    loading={modelsLoading}
 
                    emptyMessage={modelsError || "No Models found"}
 
                  />
</label>
 
                <label className="production-field">
<span>Phase <span className="production-required-asterisk">*</span></span>
<SearchableSelect
 
                    options={phaseOptions}
 
                    value={formValues.phaseId}
 
                    onChange={handlePhaseSelect}
 
                    placeholder={phaseDisabled ? "Select Model first" : "Select Phase"}
 
                    disabled={phaseDisabled}
 
                    loading={phasesLoading}
 
                    emptyMessage={phaseEmptyMessage}
 
                  />
 
                  {!phaseDisabled && !phasesLoading && phases.length === 0 && (
<span className="production-field-helper error">
 
                      No Phases Available for this model.
</span>
 
                  )}
</label>
 
                <label className="production-field">
<span>Assembly Stage <span className="production-required-asterisk">*</span></span>
<StatusDropdown
 
                    name="stage"
 
                    value={formValues.stage}
 
                    options={ASSEMBLY_STAGE_OPTIONS}
 
                    onChange={handleFormChange}
 
                    placeholder="Select Stage"
 
                  />
</label>

                <label className="production-field">
<span>Assembled By <span className="production-required-asterisk">*</span></span>
<SearchableSelect
                    options={userOptions}
                    value={formValues.assembledById}
                    onChange={handleUserSelect("assembledBy")}
                    placeholder="Select User"
                    loading={usersLoading}
                    emptyMessage={usersError || "No users found"}
                  />
</label>
 
                <label className="production-field production-serial-field">
<span>Serial Numbers <span className="production-required-asterisk">*</span></span>
<div className="production-serial-input-list">
  {(formValues.serialNumbers || []).map((serial, index) => (
    <input key={index} value={serial} onChange={(event) => handleSerialNumberChange(index, event.target.value)} placeholder={`Serial No ${index + 1}`} />
  ))}
</div>
</label>
 
 

 
                <label className="production-field">
<span>Quantity <span className="production-required-asterisk">*</span></span>
<input
 
                    type="number"
 
                    min="1"
 
                    name="qty"
 
                    value={formValues.qty}
 
                    onChange={handleFormChange}
 
                    placeholder="e.g. 1"
 
                    required
                  />
</label>
 
                <label className="production-field">
<span>QC Status</span>
<StatusDropdown
 
                    name="qc"
 
                    value={formValues.qc}
 
                    options={QC_STATUS_OPTIONS}
 
                    onChange={handleFormChange}
 
                    placeholder={qcEnabled ? "Select QC Status" : "Complete assembly first"}
                    disabled={!qcEnabled}
 
                  />
                  {(formValues.qc === "Passed" ||
                    formValues.qc === "Failed" ||
                    normalizeQcFailureHistory(formValues.qcFailureHistory).length > 0) && (
                    <button
                      type="button"
                      className={`production-qc-report-trigger${isQcInspectionComplete(formValues.qcInspection) ? " complete" : ""}`}
                      onClick={() => {
                        setQcInspectionDraft(normalizeQcInspection(formValues.qcInspection, formValues.qcBy || currentUserName));
                        setQcInspectionError("");
                        setQcInspectionTarget({ type: "form", previousQc: formValues.qc });
                      }}
                    >
                      {isQcInspectionComplete(formValues.qcInspection) ? <Check size={14} /> : null}
                      {isQcInspectionComplete(formValues.qcInspection)
                        ? "QC report completed"
                        : normalizeQcFailureHistory(formValues.qcFailureHistory).length
                          ? `Retry QC / View ${normalizeQcFailureHistory(formValues.qcFailureHistory).length} failure log${normalizeQcFailureHistory(formValues.qcFailureHistory).length === 1 ? "" : "s"}`
                          : "Complete QC report"}
                    </button>
                  )}
</label>
 
<label className="production-field">
<span>QC Done By</span>
<SearchableSelect
                    options={userOptions}
                    value={formValues.qcById}
                    onChange={handleUserSelect("qcBy")}
                    placeholder={qcEnabled ? "Select User" : "Complete assembly first"}
                    disabled={!qcEnabled}
                    loading={usersLoading}
                    emptyMessage={usersError || "No users found"}
                  />
</label>
 
                <label className="production-field">
<span>Packaging Status</span>
<StatusDropdown
 
                    name="packagingStatus"
 
                    value={formValues.packagingStatus}
 
                    options={PACKAGING_STATUS_OPTIONS}
 
                    onChange={handleFormChange}
 
                    placeholder={packagingEnabled ? "Select Packaging Status" : "Complete QC inspection first"}
                    disabled={!packagingEnabled}
 
                  />
</label>
 
<label className="production-field">
<span>Packaged By</span>
<SearchableSelect
                    options={userOptions}
                    value={formValues.packagedById}
                    onChange={handleUserSelect("packagedBy")}
                    placeholder={packagingEnabled ? "Select User" : "Complete QC inspection first"}
                    disabled={!packagingEnabled}
                    loading={usersLoading}
                    emptyMessage={usersError || "No users found"}
                  />
</label>
 
                <label className="production-field production-field-span2">
<span>Remarks</span>
<input
 
                    name="remarks"
 
                    value={formValues.remarks}
 
                    onChange={handleFormChange}
 
                    placeholder="Enter remarks"
 
                  />
</label>
</div>
</form>
 
            <div className="modal-footer">
<button type="button" className="production-btn-secondary" onClick={requestClose} disabled={saving}>
 
                Cancel
</button>
<button
 
                type="button"
 
                className="production-btn-primary"
 
                onClick={handleSave}
 
                disabled={saving || formIsIncomplete}
>
 
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
 
                {saving ? "Saving..." : isEditMode ? "Update" : "Save"}
</button>
</div>
</div>
</div>
 
        , document.body
      )}

      {qcInspectionTarget && createPortal(
        <div className="production-qc-overlay" onClick={cancelQcInspection}>
          <section
            className="production-qc-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="production-qc-title"
          >
            <header className="production-qc-header">
              <div className="production-qc-heading">
                <img className="production-qc-logo" src={VECTOR_LOGO_URL} alt="Vector" />
                <div>
                  <span className="production-qc-kicker">Format no: VIPL/F/23</span>
                  <h2 id="production-qc-title">QC Report for Power Conditioner</h2>
                  <p>
                    {qcFailureOnlyView
                      ? "QC failure history with the recorded date and time."
                      : qcReportReadOnly
                        ? "Completed quality-control inspection report and earlier failure history."
                        : "Failed checks are saved to history. Packaging unlocks only after every item passes."}
                  </p>
                </div>
              </div>
              <button type="button" className="production-qc-close" onClick={cancelQcInspection} aria-label="Close QC report">
                <X size={20} />
              </button>
            </header>

            <div className="production-qc-body">
              {!qcFailureOnlyView && <>
                <div className="production-qc-meta-grid">
                  <label><span>Make</span><input value="Vector" readOnly /></label>
                  <label><span>Model</span><input value={(qcInspectionTarget.type === "form" ? formValues.model : qcInspectionTarget.row?.model) || ""} readOnly /></label>
                  <label><span>Serial No.</span><input value={(qcInspectionTarget.type === "form" ? formValues.serial : qcInspectionTarget.row?.serial) || ""} readOnly /></label>
                  <label>
                    <span>QC Inspection Date <b>*</b></span>
                    <DatePicker value={qcInspectionDraft.inspectionDate || ""} onChange={(inspectionDate) => setQcInspectionDraft((current) => ({ ...current, inspectionDate }))} disabled={qcReportReadOnly} ariaLabel="Select QC inspection date" />
                  </label>
                </div>

                <div className="production-qc-table-heading">
                  <div>
                    <strong>Inspection checklist</strong>
                    <span>Complete every item. Any Failed item will create a dated failure log.</span>
                  </div>
                  {!qcReportReadOnly && <button
                    type="button"
                    className="production-qc-mark-all"
                    onClick={() => setQcInspectionDraft((current) => ({
                      ...current,
                      checks: Object.fromEntries(QC_INSPECTION_ITEMS.map((item) => [item.key, "Passed"])),
                    }))}
                  >
                    <Check size={15} /> Mark all Passed
                  </button>}
                </div>

                <div className="production-qc-table-wrap">
                  <table className="production-qc-table">
                    <thead><tr><th>S.No</th><th>Description</th><th>Method of Check</th><th>Status</th></tr></thead>
                    <tbody>
                      {QC_INSPECTION_ITEMS.map((item) => (
                        <tr key={item.key}>
                          <td>{item.number}</td>
                          <td>{item.description}</td>
                          <td>{item.method}</td>
                          <td>
                            {qcReportReadOnly ? (
                              <span className="production-qc-readonly-status"><Check size={14} /> {qcInspectionDraft.checks?.[item.key] || "Not Provided"}</span>
                            ) : <StatusDropdown
                              name={item.key}
                              value={qcInspectionDraft.checks?.[item.key] || ""}
                              options={["Passed", "Failed"]}
                              onChange={(event) => handleQcCheckChange(item.key, event.target.value)}
                              placeholder="Select"
                              menuClassName="production-qc-status-list"
                            />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="production-qc-signoff-grid">
                  <label><span>Checked By <b>*</b></span><input name="checkedBy" value={qcInspectionDraft.checkedBy || ""} onChange={handleQcInspectionFieldChange} placeholder="Inspector name" readOnly={qcReportReadOnly} /></label>
                  <label><span>Verified By <b>*</b></span><input name="verifiedBy" value={qcInspectionDraft.verifiedBy || ""} onChange={handleQcInspectionFieldChange} placeholder="Verifier name" readOnly={qcReportReadOnly} /></label>
                  <label><span>Authorized By</span><input name="authorizedBy" value={qcInspectionDraft.authorizedBy || ""} onChange={handleQcInspectionFieldChange} placeholder="Optional" readOnly={qcReportReadOnly} /></label>
                </div>
              </>}

              <section className="production-qc-failure-history" aria-label="QC failure history">
                <div className="production-qc-failure-history-heading">
                  <div>
                    <strong>QC Failure History</strong>
                    <span>Each failed attempt is kept with its exact recorded date and time.</span>
                  </div>
                  <span className="production-qc-failure-count">{qcFailureHistory.length}</span>
                </div>
                {qcFailureHistory.length === 0 ? (
                  <div className="production-qc-failure-empty">No QC failures have been recorded for this unit.</div>
                ) : (
                  <div className="production-qc-failure-list">
                    {[...qcFailureHistory].reverse().map((entry, index) => {
                      const failedChecks = getFailureEntryItems(entry);
                      return (
                        <article className="production-qc-failure-entry" key={entry.id || entry.failedAt || index}>
                          <div className="production-qc-failure-entry-header">
                            <div>
                              <strong>Failed attempt {qcFailureHistory.length - index}</strong>
                              <span>{formatQcFailureDate(entry.failedAt)}</span>
                            </div>
                            <span>{failedChecks.length} failed check{failedChecks.length === 1 ? "" : "s"}</span>
                          </div>
                          <dl className="production-qc-failure-meta">
                            <div><dt>Inspection Date</dt><dd>{entry.inspectionDate || "Not Provided"}</dd></div>
                            <div><dt>Checked By</dt><dd>{entry.checkedBy || "Not Provided"}</dd></div>
                            <div><dt>Verified By</dt><dd>{entry.verifiedBy || "Not Provided"}</dd></div>
                            <div><dt>Authorized By</dt><dd>{entry.authorizedBy || "Not Provided"}</dd></div>
                          </dl>
                          <div className="production-qc-failed-checks">
                            {failedChecks.map((item) => (
                              <div key={item.key}>
                                <b>{item.number}</b>
                                <span>{item.description}</span>
                                <small>{item.method}</small>
                              </div>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              {qcInspectionError && <div className="production-qc-error" role="alert">{qcInspectionError}</div>}
            </div>

            <footer className="production-qc-footer">
              {qcReportReadOnly ? <>
                <button type="button" className="production-btn-secondary" onClick={cancelQcInspection}>Close</button>
              </> : <>
                <button type="button" className="production-btn-secondary" onClick={cancelQcInspection} disabled={qcInspectionSaving}>Cancel</button>
                <button type="button" className="production-btn-primary" onClick={completeQcInspection} disabled={qcInspectionSaving}>
                {qcInspectionSaving ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
                {qcInspectionSaving
                  ? "Saving..."
                  : qcDraftFailureCount
                    ? `Save Failure Log (${qcDraftFailureCount})`
                    : "Complete QC & Continue"}
                </button>
              </>}
            </footer>
          </section>
        </div>,
        document.body
      )}
 
      {/* ---------- View Assembly Unit Modal (read-only, + hand-off to Edit) ---------- */}
 
      {viewOpen && viewRow && createPortal(
<div
 
          className={`production-details-overlay${viewClosing ? " closing" : ""}`}
 
          onClick={requestCloseView}
>
<div
 
            className={`production-details-container${viewClosing ? " closing" : ""}`}
 
            onClick={(e) => e.stopPropagation()}
 
            role="dialog"
 
            aria-modal="true"
 
            aria-label="Assembly Unit Details"
>
<div className="production-details-header">
<h2>Assembly Unit Details</h2>
<div className="production-details-header-actions">
{canManageProduction && <button
 
                  type="button"
 
                  className="production-details-edit-btn"
 
                  onClick={startEditFromView}
 
                  aria-label="Edit Assembly Unit"
>
<Pencil size={15} />
 
                  Edit
</button>}
<button
 
                  type="button"
 
                  className="production-details-close"
 
                  onClick={requestCloseView}
 
                  aria-label="Close"
>
<X size={22} />
</button>
</div>
</div>
 
            <div className="production-details-body">
<section className="production-details-section">
<h3>Assembly Details</h3>
<div className="production-details-grid">
 
                  {DETAIL_FIELDS.map((field) => (
<React.Fragment key={field.key}>
<div className="production-details-label">{field.label}</div>
<div className="production-details-value">
 
                        {field.key === "qcReport" ? (
                          isQcInspectionComplete(viewRow.qcInspection) ? (
                            <div className="production-details-qc-actions">
                              <button type="button" className="production-details-qc-report-btn" onClick={() => openQcReportView(viewRow)}>
                                <FileText size={14} /> View QC Report
                              </button>
                              <button
                                type="button"
                                className="production-details-qc-download-btn"
                                onClick={() => downloadQcReportFor(viewRow, (message) => swalError("Download failed", message))}
                              >
                                <FileDown size={14} /> Download
                              </button>
                            </div>
                          ) : normalizeQcFailureHistory(viewRow.qcFailureHistory).length ? (
                            <button type="button" className="production-details-qc-report-btn" onClick={() => openQcReportView(viewRow)}>
                              <FileText size={14} /> View Failure Logs ({normalizeQcFailureHistory(viewRow.qcFailureHistory).length})
                            </button>
                          ) : <span className="production-details-qc-unavailable">Not Available</span>
                        ) : formatDetailValue(field, viewRow)}
</div>
</React.Fragment>
 
                  ))}
</div>
</section>
</div>
 
            <div className="production-details-footer">
<button type="button" className="production-btn-secondary" onClick={requestCloseView}>
 
                Close
</button>
</div>
</div>
</div>,
        document.body
      )}
</div>
 
  );
 
}
 
 
 
