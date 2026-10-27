import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useDashboardDeepLink from "../components/useDashboardDeepLink";
import ActiveFilterChips from "../components/ActiveFilterChips";
import BackToDashboard from "../components/BackToDashboard";
import { createPortal } from "react-dom";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import Swal from "sweetalert2";
import { useHeaderSearch } from "../context/HeaderSearch";
import {
  Plus,
  X,
  Save,
  Upload,
  Loader2,
  RefreshCw,
  Trash2,
  Check,
  MoreVertical,
  Pencil,
  ArrowLeft,
  ExternalLink,
  FileText,
  Undo2,
} from "lucide-react";
import FilterModal from "../components/FilterModal";
import StatusDropdown from "../components/StatusDropdown";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import DateRangeFilter from "../components/DateRangeFilter";
import "./DefectiveUnits.css";

const PAGE_SIZE = 10;

// ---------- Inlined SweetAlert2 theme (same look as Daily Production /
// Invoices  rounded popup, fade+scale, auto-closing-on-success) ----------
const SWAL_THEME = {
  customClass: { popup: "swal-vector-popup" },
  showClass: { popup: "swal-pop-in" },
  hideClass: { popup: "swal-pop-out" },
};

const swalConfirm = ({ title, text, confirmText = "Yes, delete it", danger = false }) =>
  Swal.fire({
    title,
    text,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: "Cancel",
    // Irreversible actions get a red confirm; Cancel stays focused so a stray
    // Enter or Esc cannot destroy a file.
    confirmButtonColor: danger ? "var(--color-danger-text)" : "var(--accent)",
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
  { key: "date", label: "Date Reported", isDate: true },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial No", mono: true },
  { key: "part", label: "Defective Part" },
  { key: "problem", label: "Problem Identified" },
  { key: "status", label: "Status" },
];
const DEFECT_FILTER_FIELDS = columns.filter((column) => ["make", "model", "part", "status"].includes(column.key));

// Flat list of every field shown in the "View Details" popup, in order.
const DETAIL_FIELDS = [
  { key: "date", label: "Date Reported", isDate: true },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial No" },
  { key: "part", label: "Defective Part" },
  { key: "problem", label: "Problem Identified" },
  { key: "observations", label: "Observations" },
  { key: "solution", label: "Solution Provided" },
  { key: "scratches", label: "Any Scratches Found" },
  { key: "dent", label: "Any Dent Found" },
  { key: "status", label: "Status" },
];

const STATUS_OPTIONS = ["Open", "In Progress", "Under Review", "Resolved", "Closed"];

const emptyDefectForm = {
  id: null,
  date: "",
  make: "",
  model: "",
  serial: "",
  part: "",
  problem: "",
  observations: "",
  solution: "",
  scratches: "",
  dent: "",
  attachment: [], // File objects staged for upload
  status: "Open",
};

const REQUIRED_FIELDS = [
  { name: "date", label: "Date Reported" },
  { name: "make", label: "Make" },
  { name: "model", label: "Model" },
  { name: "serial", label: "Serial No" },
  { name: "part", label: "Defective Part" },
  { name: "problem", label: "Problem Identified" },
  { name: "observations", label: "Observations" },
  { name: "solution", label: "Solution Provided" },
  { name: "scratches", label: "Any Scratches Found" },
  { name: "dent", label: "Any Dent Found" },
  { name: "status", label: "Status" },
];

function validateDefectForm(values) {
  const missing = REQUIRED_FIELDS.filter(
    ({ name }) => !String(values[name] ?? "").trim()
  );

  if (missing.length) {
    return `Please fill in: ${missing.map((field) => field.label).join(", ")}.`;
  }

  return null;
}

// ---- Helpers for the View Details popup ----

function formatDetailValue(value) {
  if (value === null || value === undefined) return "Not Provided";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not Provided";
  const str = String(value).trim();
  return str ? str : "Not Provided";
}

// The stored value is either a full download URL or a bare Storage object
// path, so the label is derived from the URL's path with any query string,
// `%2F` escape and UUID dropped - otherwise every file reads as "9d9c1d42e...".
function attachmentLabel(url, fallback = "Attachment") {
  const path = String(url || "").split(/[?#]/)[0];
  const tail = path.split("/").filter(Boolean).pop() || "";
  let name = tail;
  try {
    name = decodeURIComponent(tail);
  } catch {
    /* keep the raw segment when it is not valid percent-encoding */
  }
  // Storage blobs are named "<uuid>.<ext>", so drop the uuid stem and keep the
  // extension; otherwise fall back to the whole segment.
  const withoutStem = name.replace(/^[0-9a-f]{16,}\./i, "");
  return withoutStem || name || fallback;
}

function normalizeImages(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { url: item, name: attachmentLabel(item) };
      }
      if (typeof File !== "undefined" && item instanceof File) {
        return { url: URL.createObjectURL(item), name: item.name, objectUrl: true };
      }
      if (typeof item === "object") {
        const url = item.url || item.path || item.src || "";
        if (!url) return null;
        return {
          url,
          name: item.name || item.filename || attachmentLabel(url),
          inlineData: typeof item.data === "string" ? item.data : "",
        };
      }
      return null;
    })
    .filter(Boolean);
}

// One attachment tile. Images render as a thumbnail; if the browser cannot
// load them (a legacy Storage URL without a download token returns 403) the
// tile degrades to a labelled file card instead of a broken-image glyph.
function AttachmentThumb({ file, onOpen }) {
  const [failed, setFailed] = useState(false);
  const looksLikeImage = /\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i.test(file.url || "") || (file.inlineData || "").startsWith("data:image/");
  const showImage = looksLikeImage && !failed;

  return (
    <button
      type="button"
      className={`details-modal-image-thumb${showImage ? "" : " is-file"}`}
      onClick={onOpen}
      aria-label={`Preview ${file.name}`}
      title={file.name}
    >
      {showImage ? (
        <img src={file.url || file.inlineData} alt={file.name} onError={() => setFailed(true)} />
      ) : (
        <span className="details-modal-image-fallback">
          <FileText size={18} aria-hidden="true" />
          <span className="details-modal-image-fallback-name">{file.name}</span>
        </span>
      )}
    </button>
  );
}

// Full-screen preview body. Renders the image when the browser can load it and
// otherwise explains why it cannot and offers the raw file, so a Storage object
// that needs a download token is still reachable.
function LightboxBody({ file }) {
  const [failed, setFailed] = useState(false);
  const looksLikeImage = /\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i.test(file.url || "") || (file.inlineData || "").startsWith("data:image/");

  if (!looksLikeImage || failed) {
    return (
      <div className="details-modal-lightbox-fallback">
        <FileText size={44} aria-hidden="true" />
        <p className="details-modal-lightbox-fallback-name">{file.name}</p>
        <p className="details-modal-lightbox-fallback-hint">
          This file cannot be shown inline. Use &ldquo;Open in new tab&rdquo; to view or
          download it.
        </p>
      </div>
    );
  }

  return <img src={file.url || file.inlineData} alt={file.name} onError={() => setFailed(true)} />;
}

// `URL.createObjectURL` must not run on every render - each call mints a new
// blob URL that the browser then has to reclaim. Caching per File keeps the
// same URL for the lifetime of that selection.
const stagedObjectUrls = new WeakMap();

function stagedObjectUrl(file) {
  if (!file || typeof URL?.createObjectURL !== "function") return "";
  let url = stagedObjectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    stagedObjectUrls.set(file, url);
  }
  return url;
}

// ---- Helpers for the Date Range filter ----

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

export default function DefectiveUnits() {
  // One search box, rendered in the global header next to the profile menu.
  const [query] = useHeaderSearch("defective-units", "Search Defective Units...");

  // One entry per filterable field; a missing key means "All" for that field.
  const [rowFilters, setRowFilters] = useState({});

  // A dashboard KPI card can deep-link here with `?field=<key>&value=<v>` to
  // open the list already narrowed.
  const arrivedFromDashboard = useDashboardDeepLink(
    DEFECT_FILTER_FIELDS,
    (patch) => setRowFilters((prev) => ({ ...prev, ...patch }))
  );
  const [rows, setRows] = useState([]);
  const [filterOptions, setFilterOptions] = useState({});

  // ---------- Defect list loading/error state ----------
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");

  // ---------- Pagination state (same pattern as Sale Register) ----------
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyDefectForm);
  const initialFormValuesRef = useRef(emptyDefectForm);
  // Attachments already stored on the record, and the subset the user has
  // marked for removal. The API is told which URLs survive the save, so a
  // removal also drops the Storage object rather than just the list entry.
  const [existingAttachments, setExistingAttachments] = useState([]);
  const [removedAttachments, setRemovedAttachments] = useState([]);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // ---------- Bulk select / delete (same pattern as Daily Production /
  // Invoices) ----------
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // ---------- Date range filter ----------
  // The pickers hold a draft; Apply promotes it to the applied values the
  // request is built from, so a half-typed date never refetches the table.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [appliedFromDate, setAppliedFromDate] = useState("");
  const [appliedToDate, setAppliedToDate] = useState("");
  const [dateRangeError, setDateRangeError] = useState("");

  // ---------- View Details popup state ----------
  const [viewRow, setViewRow] = useState(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewClosing, setViewClosing] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const openView = (row) => {
    setViewRow(row);
    setViewClosing(false);
    setViewOpen(true);
    setMenuOpen(false);
  };

  const requestCloseView = useCallback(() => {
    if (viewClosing) return;
    setViewClosing(true);
    setTimeout(() => {
      setViewOpen(false);
      setViewClosing(false);
      setViewRow(null);
      setLightboxImage(null);
    }, 200);
  }, [viewClosing]);

  // Escape key closes the lightbox first, then the details popup.
  useEffect(() => {
    if (!viewOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") {
        if (lightboxImage) {
          setLightboxImage(null);
        } else {
          requestCloseView();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [viewOpen, lightboxImage, requestCloseView]);

  const detailImages = useMemo(() => {
    if (!viewRow) return [];
    // `attachments` is what the API returns; `attachment` is the form's staging
    // field and can be an empty array, which `??` would not fall through on.
    return normalizeImages(viewRow.attachments ?? viewRow.attachment);
  }, [viewRow]);

  // ---------- Date range validation ----------
  // Declared before the fetch below, which depends on `isDateRangeActive`.
  useEffect(() => {
    setDateRangeError(
      fromDate && toDate && toDate < fromDate ? "End Date cannot be earlier than Start Date." : ""
    );
  }, [fromDate, toDate]);

  const isDateRangeActive = Boolean(appliedFromDate || appliedToDate);

  // ---------- Fetch defects from the backend (paginated, same pattern as
  // Sale Register's fetchRows) ----------
  const fetchDefects = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;

    try {
      // Search, PageFilter and the date range all go to the server so they
      // cover every defect, not just the page the API last returned.
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);
      // Date Reported range.
      if (isDateRangeActive) {
        params.set("dateField", "date");
        if (appliedFromDate) {
          params.append("filterField", "dateFrom");
          params.append("filterValue", appliedFromDate);
        }
        if (appliedToDate) {
          params.append("filterField", "dateTo");
          params.append("filterValue", appliedToDate);
        }
      }
      DEFECT_FILTER_FIELDS.forEach((field) => {
        const selected = rowFilters[field.key];
        if (String(selected ?? "") !== "") {
          params.append("filterField", field.key);
          params.append("filterValue", String(selected));
        }
      });
      const res = await api.get(`/defects?${params.toString()}`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load Defective Units");
      }
      setRows(res.data.defects || []);
      setFilterOptions(res.data.filterOptions || {});
      const pagination = res.data.pagination;
      if (pagination) {
        setTotalPages(pagination.totalPages || 1);
        setTotalCount(pagination.totalCount || 0);
        if (pagination.page !== pageToFetch) setPage(pagination.page);
      } else {
        setTotalPages(1);
        setTotalCount(res.data.defects?.length || 0);
      }
    } catch (err) {
      setRowsError(extractErrorMessage(err, "Failed to load Defective Units."));
    } finally {
      if (!silent) setRowsLoading(false);
    }
  }, [page, pageSize, query, rowFilters, isDateRangeActive, appliedFromDate, appliedToDate]);

  // Changing the search text, a PageFilter selection or the date range has to
  // restart at page 1, otherwise narrowing the result set leaves the user
  // parked on a page that no longer exists.
  const filterKey = `${query.trim()}|${JSON.stringify(rowFilters)}|${appliedFromDate}:${appliedToDate}`;
  const prevFilterKeyRef = useRef(filterKey);

  useEffect(() => {
    const filtersChanged = prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;
    if (filtersChanged && page !== 1) setPage(1);
  }, [filterKey, page]);

  useEffect(() => {
    fetchDefects({ targetPage: page });
  }, [fetchDefects, page]);

  // Defect writes arrive as a WebSocket notice and refresh the table quietly.
  // Skipped while the add/edit form or a bulk delete is running.
  useRealtime(["defectives"], () => fetchDefects({ silent: true }), {
    guard: () => !(modalOpen || saving || bulkDeleting),
  });

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  // The API already applied the search, PageFilter and date range to every
  // defect before it cut the page, so re-filtering here would only hide rows
  // the server matched (e.g. a hit that lives in Observations, which is not one
  // of the displayed columns).  The server response is authoritative.
  const filteredRows = useMemo(() => rows, [rows]);

  const openAddModal = () => {
    setIsEditMode(false);
    initialFormValuesRef.current = emptyDefectForm;
    setFormValues(emptyDefectForm);
    setExistingAttachments([]);
    setRemovedAttachments([]);
    setFormError("");
    setClosing(false);
    setModalOpen(true);
    setMenuOpen(false);
  };

  const openEditModal = (row) => {
    setIsEditMode(true);
    const initialValues = { ...emptyDefectForm, ...row, attachment: [] };
    initialFormValuesRef.current = initialValues;
    setFormValues(initialValues);
    // Seed the edit form with what is already stored so each file can be kept
    // or removed; nothing is dropped until the user removes it and saves.
    setExistingAttachments(normalizeImages(row.attachments ?? row.attachment));
    setRemovedAttachments([]);
    setFormError("");
    setClosing(false);
    setModalOpen(true);
  };

  const toggleExistingAttachment = (url) => {
    setRemovedAttachments((prev) => (
      prev.includes(url) ? prev.filter((item) => item !== url) : [...prev, url]
    ));
  };

  const removeStagedFile = async (index) => {
    const file = formValues.attachment?.[index];
    const result = await swalConfirm({
      title: "Remove this photo?",
      text: `${file?.name || "This photo"} will not be uploaded with the record.`,
      confirmText: "Remove photo",
    });
    if (!result.isConfirmed) return;
    setFormValues((prev) => ({
      ...prev,
      attachment: prev.attachment.filter((_, i) => i !== index),
    }));
  };

  const requestClose = async (skipConfirmation = false) => {
    if (closing) return;
    // A pending attachment removal counts as an unsaved change on its own.
    const dirty =
      JSON.stringify(formValues) !== JSON.stringify(initialFormValuesRef.current)
      || removedAttachments.length > 0;
    if (skipConfirmation !== true && dirty) {
      const result = await swalConfirm({
        title: "Discard unsaved changes?",
        text: "Your defective-unit changes will be lost unless you save them.",
        confirmText: "Discard changes",
      });
      if (!result.isConfirmed) return;
    }
    setClosing(true);
    setTimeout(() => {
      setModalOpen(false);
      setClosing(false);
      setFormValues(emptyDefectForm);
      setFormError("");
      setIsEditMode(false);
      setExistingAttachments([]);
      setRemovedAttachments([]);
    }, 220);
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files);
    setFormValues((prev) => ({ ...prev, attachment: files }));
  };

  // ---------- Delete a single stored attachment from the View popup ----------
  const [deletingAttachment, setDeletingAttachment] = useState(false);

  const deleteAttachment = async (file) => {
    const id = getRowId(viewRow);
    if (!id || !file?.url) return;

    const result = await swalConfirm({
      title: "Delete this attachment?",
      text: `"${file.name}" will be permanently removed from this Defective Unit. This cannot be undone.`,
      confirmText: "Yes, delete it",
      danger: true,
    });
    if (!result.isConfirmed) return;

    setDeletingAttachment(true);
    try {
      const res = await api.delete(`/defects/${id}/attachments`, { data: { urls: [file.url] } });
      if (!res.data?.success) throw new Error(res.data?.message || "Failed to delete attachment");
      const kept = normalizeImages(res.data.attachments);
      setViewRow((prev) => (prev ? { ...prev, attachments: kept } : prev));
      setLightboxImage(null);
      await fetchDefects({ targetPage: page, silent: true });
      await swalSuccess("Attachment deleted", `"${file.name}" has been removed.`);
    } catch (err) {
      await swalError("Delete failed", extractErrorMessage(err, "Failed to delete attachment."));
    } finally {
      setDeletingAttachment(false);
    }
  };

  // Edit-from-view hands off to the existing, fully-featured Add/Edit
  // form modal instead of duplicating that logic in a second form.
  const startEditFromView = () => {
    const row = viewRow;
    setViewOpen(false);
    setViewClosing(false);
    setViewRow(null);
    setLightboxImage(null);
    if (row) openEditModal(row);
  };

  // ---------- Save/Update Defect record to the backend, then refresh the
  // table. Both create and update send multipart/form-data  the
  // backend's POST /defects and PUT /defects/<id> routes both read
  // request.form and request.files, so this keeps the two requests
  // symmetric. On edit, existing attachments are preserved server-side;
  // any newly picked files here are appended to them rather than
  // replacing the list. ----------
  const handleSave = async () => {
    if (saving) return;

    const error = validateDefectForm(formValues);
    if (error) {
      setFormError(error);
      return;
    }

    setSaving(true);
    setFormError("");

    try {
      const body = new FormData();
      Object.entries(formValues).forEach(([key, value]) => {
        if (key === "attachment") {
          value.forEach((file) => body.append("attachment", file));
        } else if (key !== "id") {
          body.append(key, value);
        }
      });
      // The API keeps every listed URL and removes the rest, so an attachment
      // dropped in this form is deleted from Storage as well as from the row.
      if (isEditMode) {
        const kept = existingAttachments
          .map((file) => file.url)
          .filter((url) => !removedAttachments.includes(url));
        body.append("keepAttachments", JSON.stringify(kept));
      }

      let res;
      if (isEditMode) {
        res = await api.put(`/defects/${formValues.id}`, body);
      } else {
        res = await api.post("/defects", body);
      }

      // Storage can refuse an upload for reasons outside the app (expired or
      // disabled cloud billing, bad credentials). The record itself still saves
      // in that case, so report it as a partial success rather than a failure
      // that suggests nothing was kept.
      if (res.data?.partial) {
        setSaving(false);
        requestClose(true);
        await swalError(
          "Saved, but upload failed",
          `${res.data.message}\n\nThe record details were saved; only the new file was not stored.`
        );
        await fetchDefects({ targetPage: isEditMode ? page : 1, silent: true });
        return;
      }

      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to save Defective Unit");
      }

      setSaving(false);
      requestClose(true);

      await swalSuccess(
        isEditMode ? "Defect Updated" : "Defect Saved",
        `The Defective Unit has been ${isEditMode ? "updated" : "saved"} successfully.`
      );

      if (isEditMode) {
        await fetchDefects({ targetPage: page, silent: true });
      } else {
        await fetchDefects({ targetPage: 1, silent: true });
        setPage(1);
      }
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
      text: "Are you sure you want to delete this Defective Unit? This action cannot be undone.",
    });
    if (!result.isConfirmed) return;

    setDeletingId(id);
    try {
      const res = await api.delete(`/defects/${id}`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to delete Defective Unit");
      }
      await fetchDefects({ targetPage: page, silent: true });
      swalSuccess("Defect Deleted", "The record has been removed successfully.");
    } catch (err) {
      swalError("Delete failed", extractErrorMessage(err, "Something went wrong while deleting."));
    } finally {
      setDeletingId(null);
    }
  };

  // ---------- Bulk select / delete (mirrors Daily Production / Invoices /
  // Sale Register) ----------
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
      title: "Delete selected Defective Units?",
      text: `Delete ${selectedIds.size} selected record(s)? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setBulkDeleting(true);
    try {
      const res = await api.post("/defects/bulk-delete", {
        ids: Array.from(selectedIds),
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to delete Defective Units");
      }
      const deletedCount = selectedIds.size;
      await fetchDefects({ targetPage: page, silent: true });
      setSelectMode(false);
      setSelectedIds(new Set());
      setMenuOpen(false);
      swalSuccess("Defective Units Deleted", `${deletedCount} record(s) removed.`);
    } catch (err) {
      swalError("Delete failed", extractErrorMessage(err, "Something went wrong while deleting."));
    } finally {
      setBulkDeleting(false);
    }
  };

  // ---------- Table columns: prepend a checkbox column while in select mode ----------
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
            className="defects-row-checkbox"
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

  const formIsIncomplete = validateDefectForm(formValues) !== null;

  return (
    <div className="defects-page">
      <BackToDashboard visible={arrivedFromDashboard} />
      <div className="defects-toolbar">
        <div className="defects-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="defect-add-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="defect-add-btn"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || bulkDeleting}
              >
                <Trash2 size={16} />
                {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </button>
              <button type="button" className="defect-add-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="defect-add-btn" onClick={openAddModal}>
                <Plus size={18} />
                Add Unit
              </button>
              <button type="button" className="defect-delete-btn" onClick={toggleSelectMode}>
                <Trash2 size={16} /> Delete
              </button>
            </>
          )}
        </div>

        <div className="defects-kebab-wrapper" ref={menuRef}>
          <button
            type="button"
            className="defects-kebab-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="More actions"
          >
            <MoreVertical size={20} />
          </button>

          {menuOpen && (
            <div className="defects-kebab-menu">
              {selectMode ? (
                <>
                  <button type="button" className="defects-menu-item" onClick={toggleSelectAll}>
                    <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    className="defects-menu-item"
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || bulkDeleting}
                  >
                    <Trash2 size={16} />
                    {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
                  </button>
                  <button type="button" className="defects-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="defects-menu-item" onClick={openAddModal}>
                    <Plus size={16} /> Add Unit
                  </button>
                  <button type="button" className="defects-menu-item" onClick={toggleSelectMode}>
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
            <FilterModal rows={rows} options={filterOptions} fields={DEFECT_FILTER_FIELDS} value={rowFilters} onChange={setRowFilters} />
            <ActiveFilterChips fields={DEFECT_FILTER_FIELDS} value={rowFilters} onChange={setRowFilters} />
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
              startLabel="From Date Reported"
              endLabel="To Date Reported"
            />
          
          </div>
          {!rowsLoading && !rowsError && (
            <ExportPdfButton
              mode="table"
              title="Defective Units"
              columns={columns}
              rows={filteredRows}
            />
          )}
        </div>

        {rowsLoading ? (
          <div className="defects-loading">
            <Loader2 size={32} className="spin" />
            Loading Defective Units...
          </div>
        ) : rowsError ? (
          <div className="defects-load-error">
            <div className="defects-load-error-actions">
              <span>{rowsError}</span>
              <button
                type="button"
                className="defect-btn-secondary"
                onClick={() => fetchDefects({ targetPage: page })}
              >
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="defects-empty-state">
            <span>
              {isDateRangeActive || query.trim() || Object.values(rowFilters).some(Boolean)
                ? "No Defective Units match the current search, filters or Date Reported range."
                : 'No Defective Units yet. Click "Add Unit" to create the first record.'}
            </span>
          </div>
        ) : (
          <DataTable
            columns={tableColumns}
            rows={filteredRows}
            onViewDetails={selectMode ? undefined : openView}
            onEdit={selectMode ? undefined : openEditModal}
            onDelete={selectMode ? undefined : handleDeleteClick}
            deletingId={deletingId}
          />
        )}
      </div>

      {!rowsLoading && !rowsError && rows.length > 0 && (
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

      {/* ---------- Add/Edit Defective Unit Modal ---------- */}
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
            aria-label={isEditMode ? "Edit Defective Unit" : "Add Defective Unit"}
          >
            <div className="modal-header">
              <h2>{isEditMode ? "Edit Defective Unit" : "Add Defective Unit"}</h2>
              <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                <X size={22} />
              </button>
            </div>

            <form
              className="defect-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="defect-form-error">{formError}</div>}

              <div className="defect-form-grid">
                <label className="defect-field">
                  <span>Date Reported</span>
                  <DatePicker value={formValues.date} onChange={(date) => setFormValues((prev) => ({ ...prev, date }))} ariaLabel="Select date reported" />
                </label>

                <label className="defect-field">
                  <span>Make</span>
                  <input
                    name="make"
                    value={formValues.make}
                    onChange={handleFormChange}
                    placeholder="e.g. Bosch"
                  />
                </label>

                <label className="defect-field">
                  <span>Model</span>
                  <input
                    name="model"
                    value={formValues.model}
                    onChange={handleFormChange}
                    placeholder="e.g. GSB-13RE"
                  />
                </label>

                <label className="defect-field">
                  <span>Serial No</span>
                  <input
                    name="serial"
                    value={formValues.serial}
                    onChange={handleFormChange}
                    placeholder="SN-00123"
                  />
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Defective Part</span>
                  <input
                    name="part"
                    value={formValues.part}
                    onChange={handleFormChange}
                    placeholder="e.g. Motor winding"
                  />
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Problem Identified</span>
                  <input
                    name="problem"
                    value={formValues.problem}
                    onChange={handleFormChange}
                    placeholder="Describe the issue"
                  />
                </label>
                <label className="defect-field defect-field-span2">
                  <span>Any Scratches Found</span>

                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="scratches"
                        value="Yes"
                        checked={formValues.scratches === "Yes"}
                        onChange={handleFormChange}
                      />
                      Yes
                    </label>

                    <label className="radio-option">
                      <input
                        type="radio"
                        name="scratches"
                        value="No"
                        checked={formValues.scratches === "No"}
                        onChange={handleFormChange}
                      />
                      No
                    </label>
                  </div>
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Any Dent Found</span>

                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="dent"
                        value="Yes"
                        checked={formValues.dent === "Yes"}
                        onChange={handleFormChange}
                      />
                      Yes
                    </label>

                    <label className="radio-option">
                      <input
                        type="radio"
                        name="dent"
                        value="No"
                        checked={formValues.dent === "No"}
                        onChange={handleFormChange}
                      />
                      No
                    </label>
                  </div>
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Observations</span>
                  <input
                    name="observations"
                    value={formValues.observations}
                    onChange={handleFormChange}
                    placeholder="Any additional notes or observations"
                  />
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Solution Provided</span>
                  <input
                    name="solution"
                    value={formValues.solution}
                    onChange={handleFormChange}
                    placeholder="Describe the solution provided"
                  />
                </label>



                <label className="defect-field defect-field-span2">
                  <span>Add Attachment</span>

                  <div className="attachment-control">
                    <span className="attachment-status">
                      {formValues.attachment.length > 0
                        ? `${formValues.attachment.length} file(s) selected`
                        : "No files chosen"}
                    </span>
                    <button
                      type="button"
                      className="attachment-upload-btn"
                      onClick={() => document.getElementById("defect-attachment-input").click()}
                    >
                      <Upload size={14} />
                      Upload
                    </button>
                  </div>

                  <input
                    id="defect-attachment-input"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileChange}
                    className="attachment-hidden-input"
                  />

                  {existingAttachments.length > 0 && (
                    <div className="attachment-existing">
                      <p className="attachment-existing-title">
                        Already attached ({existingAttachments.length})
                      </p>
                      <ul className="attachment-existing-list">
                        {existingAttachments.map((file) => {
                          const marked = removedAttachments.includes(file.url);
                          return (
                            <li
                              key={file.url}
                              className={`attachment-existing-item${marked ? " is-removed" : ""}`}
                            >
                              <FileText size={15} aria-hidden="true" />
                              <span className="attachment-existing-name" title={file.name}>
                                {file.name}
                              </span>
                              <button
                                type="button"
                                className="attachment-remove-btn"
                                onClick={() => toggleExistingAttachment(file.url)}
                                aria-label={marked ? `Keep ${file.name}` : `Remove ${file.name}`}
                                title={marked ? "Keep this file" : "Remove this file"}
                              >
                                {marked ? <Undo2 size={14} /> : <Trash2 size={14} />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {removedAttachments.length > 0 && (
                        <p className="attachment-existing-note">
                          {removedAttachments.length} file(s) will be deleted when you save.
                        </p>
                      )}
                    </div>
                  )}

                  {formValues.attachment.length > 0 && (
                    <div className="image-preview">
                      {formValues.attachment.map((file, index) => (
                        <span className="image-preview-item" key={`${file.name}-${index}`}>
                          <img src={stagedObjectUrl(file)} alt={`Preview ${index + 1}`} />
                          <button
                            type="button"
                            className="image-preview-remove"
                            onClick={() => removeStagedFile(index)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </label>

                <label className="defect-field defect-field-span2">
                  <span>Status</span>
                  <StatusDropdown
                    name="status"
                    value={formValues.status}
                    options={STATUS_OPTIONS}
                    onChange={handleFormChange}
                    placeholder="Select status"
                  />
                </label>
              </div>
            </form>

            <div className="modal-footer">
              <button type="button" className="defect-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="defect-btn-primary"
                onClick={handleSave}
                disabled={saving || formIsIncomplete}
              >
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : isEditMode ? "Update" : "Save"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ---------- View Defective Unit Modal (read-only, + hand-off to Edit) ---------- */}
      {viewOpen && viewRow && createPortal(
        <div
          className={`details-modal-overlay${viewClosing ? " closing" : ""}`}
          onClick={requestCloseView}
        >
          <div
            className={`details-modal-container${viewClosing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Unit Details"
          >
            <div className="details-modal-header">
              <h2>Unit Details</h2>
              <div className="details-modal-header-actions">
                <button
                  type="button"
                  className="details-modal-edit-btn"
                  onClick={startEditFromView}
                  aria-label="Edit Defective Unit"
                >
                  <Pencil size={15} />
                  Edit
                </button>
                <button
                  type="button"
                  className="details-modal-close"
                  onClick={requestCloseView}
                  aria-label="Close"
                >
                  <X size={22} />
                </button>
              </div>
            </div>

            <div className="details-modal-body">
              <section className="details-modal-section">
                <h3 className="details-modal-section-title">Defect Details</h3>
                <div className="details-modal-grid">
                  {DETAIL_FIELDS.map(({ key, label, isDate }) => (
                    <React.Fragment key={key}>
                      <div className="details-modal-field-name">{label}</div>
                      <div className="details-modal-field-value">
                        {isDate ? formatDate(viewRow[key], "Not Provided") : formatDetailValue(viewRow[key])}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </section>

              <div className="details-modal-images-row">
                <div className="details-modal-field-name">Attachments</div>
                {detailImages.length ? (
                  <div className="details-modal-images">
                    {detailImages.map((img, idx) => (
                      <span className="details-modal-image-wrap" key={img.url || idx}>
                        <AttachmentThumb file={img} onOpen={() => setLightboxImage(img)} />
                        <button
                          type="button"
                          className="details-modal-image-delete"
                          onClick={() => deleteAttachment(img)}
                          disabled={deletingAttachment}
                          aria-label={`Delete ${img.name}`}
                          title="Delete this attachment"
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="details-modal-field-value">Not Provided</div>
                )}
              </div>
            </div>

            <div className="details-modal-footer">
              <button
                type="button"
                className="details-modal-close-btn"
                onClick={requestCloseView}
              >
                Close
              </button>
            </div>
          </div>

          {lightboxImage && (
            <div
              className="details-modal-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`Preview: ${lightboxImage.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="details-modal-lightbox-header">
                <button
                  type="button"
                  className="details-modal-lightbox-back"
                  onClick={() => setLightboxImage(null)}
                >
                  <ArrowLeft size={18} />
                  Back to details
                </button>
                <div className="details-modal-lightbox-actions">
                  <a
                    className="details-modal-lightbox-open"
                    href={lightboxImage.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={17} />
                    Open in new tab
                  </a>
                  <button
                    type="button"
                    className="details-modal-lightbox-close"
                    onClick={requestCloseView}
                    aria-label="Close file preview"
                  >
                    <X size={21} />
                  </button>
                </div>
              </div>
              <LightboxBody file={lightboxImage} />
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
