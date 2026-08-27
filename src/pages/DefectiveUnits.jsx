import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import api from "../components/Api";
import Swal from "sweetalert2";
import {
  Plus,
  X,
  Save,
  Upload,
  Loader2,
  Calendar,
  RefreshCw,
  Trash2,
  Check,
  MoreVertical,
  Pencil,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowLeft,
  ExternalLink,
} from "lucide-react";
import SearchBar from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import StatusDropdown from "../components/StatusDropdown";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import "./DefectiveUnits.css";

const PAGE_SIZE = 10;

// ---------- Inlined SweetAlert2 theme (same look as Daily Production /
// Invoices  rounded popup, fade+scale, auto-closing-on-success) ----------
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

function normalizeImages(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { url: item, name: item.split("/").pop() || "Attachment" };
      }
      if (typeof File !== "undefined" && item instanceof File) {
        return { url: URL.createObjectURL(item), name: item.name };
      }
      if (typeof item === "object") {
        const url = item.url || item.path || item.src || "";
        if (!url) return null;
        return { url, name: item.name || item.filename || "Attachment" };
      }
      return null;
    })
    .filter(Boolean);
}

// ---- Helpers for the Date Range filter ----

// Normalizes any date-ish string to a comparable YYYY-MM-DD value.
// Handles native <input type="date"> values (already YYYY-MM-DD) as well
// as full ISO timestamps that might come back from the backend.
function toComparableDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
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

export default function DefectiveUnits() {
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);

  // ---------- Defect list loading/error state ----------
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");

  // ---------- Pagination state (same pattern as Sale Register) ----------
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyDefectForm);
  const initialFormValuesRef = useRef(emptyDefectForm);
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

  // ---------- Date range filter state ----------
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
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
    return normalizeImages(viewRow.attachment ?? viewRow.attachments);
  }, [viewRow]);

  // ---------- Fetch defects from the backend (paginated, same pattern as
  // Sale Register's fetchRows) ----------
  const fetchDefects = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;

    try {
      const res = await api.get("/defects", {
        params: { page: pageToFetch, limit: PAGE_SIZE },
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load Defective Units");
      }
      setRows(res.data.defects || []);
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
  }, [page]);

  useEffect(() => {
    fetchDefects({ targetPage: page });
  }, [fetchDefects, page]);

  const goToPage = (nextPage) => {
    const clamped = Math.min(Math.max(nextPage, 1), totalPages);
    if (clamped === page) return;
    setPage(clamped);
  };

  // ---------- Date range validation ----------
  useEffect(() => {
    if (fromDate && toDate && toDate < fromDate) {
      setDateRangeError("End Date cannot be earlier than From Date.");
    } else {
      setDateRangeError("");
    }
  }, [fromDate, toDate]);

  const handleFromDateChange = (e) => setFromDate(e.target.value);
  const handleToDateChange = (e) => setToDate(e.target.value);

  const clearDateFilter = () => {
    setFromDate("");
    setToDate("");
    setDateRangeError("");
  };

  const isDateRangeActive = Boolean(fromDate && toDate && !dateRangeError);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesSearch =
        !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));

      if (!matchesSearch) return false;
      if (!matchesPageFilter(row, pageFilter, DEFECT_FILTER_FIELDS)) return false;

      if (isDateRangeActive) {
        const rowDate = toComparableDate(row.date);
        if (!rowDate) return false;
        if (rowDate < fromDate || rowDate > toDate) return false;
      }

      return true;
    });
  }, [query, rows, pageFilter, isDateRangeActive, fromDate, toDate]);

  const showDateEmptyMessage =
    !rowsLoading && !rowsError && isDateRangeActive && filteredRows.length === 0;

  const openAddModal = () => {
    setIsEditMode(false);
    initialFormValuesRef.current = emptyDefectForm;
    setFormValues(emptyDefectForm);
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
    setFormError("");
    setClosing(false);
    setModalOpen(true);
  };

  const requestClose = async (skipConfirmation = false) => {
    if (closing) return;
    if (skipConfirmation !== true && JSON.stringify(formValues) !== JSON.stringify(initialFormValuesRef.current)) {
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

      let res;
      if (isEditMode) {
        res = await api.put(`/defects/${formValues.id}`, body);
      } else {
        res = await api.post("/defects", body);
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
            <SearchBar value={query} onChange={setQuery} placeholder="Search Defective Units..." />
            <PageFilter rows={rows} fields={DEFECT_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          
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
        ) : showDateEmptyMessage ? (
          <div className="defects-date-empty">
            No records found for the selected date range.
          </div>
        ) : rows.length === 0 ? (
          <div className="defects-empty-state">
            <span>No Defective Units yet. Click "Add Unit" to create the first record.</span>
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
        <div className="defects-pagination">
          <p className="defects-hint">
            Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
            {"–"}
            {(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows
          </p>

          <div className="defects-pagination-controls">
            <button
              type="button"
              className="defects-page-btn defects-page-edge"
              onClick={() => goToPage(1)}
              disabled={page === 1}
              aria-label="First page"
            >
              <ChevronsLeft size={16} />
            </button>

            {page > 1 && (
              <button
                type="button"
                className="defects-page-btn defects-page-nav"
                onClick={() => goToPage(page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
                Prev
              </button>
            )}

            <span className="defects-page-current" key={page}>{page}</span>

            {page < totalPages && (
              <button
                type="button"
                className="defects-page-btn defects-page-nav"
                onClick={() => goToPage(page + 1)}
                aria-label="Next page"
              >
                Next
                <ChevronRight size={16} />
              </button>
            )}

            <button
              type="button"
              className="defects-page-btn defects-page-edge"
              onClick={() => goToPage(totalPages)}
              disabled={page === totalPages}
              aria-label="Last page"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
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

                  {formValues.attachment.length > 0 && (
                    <div className="image-preview">
                      {formValues.attachment.map((file, index) => (
                        <img
                          key={index}
                          src={URL.createObjectURL(file)}
                          alt={`Preview ${index + 1}`}
                        />
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
                      <button
                        type="button"
                        key={idx}
                        className="details-modal-image-thumb"
                        onClick={() => setLightboxImage(img)}
                        aria-label={`Preview ${img.name}`}
                      >
                        <img src={img.url} alt={img.name} />
                      </button>
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
              aria-label={`Image preview: ${lightboxImage.name}`}
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
                    aria-label="Close image preview"
                  >
                    <X size={21} />
                  </button>
                </div>
              </div>
              <img src={lightboxImage.url} alt={lightboxImage.name} />
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

