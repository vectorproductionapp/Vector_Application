import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../components/Api";
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
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import "./Invoices.css";
 
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const PAGE_SIZE = 10;
 
// ---------- Inlined SweetAlert2 theme (same look as Daily Production 
// rounded popup, fade+scale, auto-closing-on-success  styled via the
// .swal-vector-popup / .swal-pop-in / .swal-pop-out classes already
// defined globally). ----------
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
  { key: "phase", label: "Phase" },
  { key: "invoice", label: "Invoice No", mono: true },
  { key: "date", label: "Invoice Date", isDate: true },
  { key: "po", label: "PO No", mono: true },
  { key: "code", label: "Item Code", mono: true },
  { key: "desc", label: "Item Description" },
  { key: "qtyInv", label: "Qty Invoiced" },
  { key: "qtyRecv", label: "Qty Received" },
  { key: "verifiedBy", label: "Verified By" },
];
const INVOICE_FILTER_FIELDS = columns.filter((column) => ["phase", "date", "po", "verifiedBy"].includes(column.key));
 
// Fields shown in the View modal (mirrors DailyProduction's DETAIL_FIELDS).
const DETAIL_FIELDS = [
  { key: "phase", label: "Phase" },
  { key: "invoice", label: "Invoice No" },
  { key: "date", label: "Invoice Date", isDate: true },
  { key: "po", label: "PO No" },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "qtyInv", label: "Qty Invoiced" },
  { key: "qtyRecv", label: "Qty Received" },
  { key: "verifiedBy", label: "Verified By" },
];
 
const emptyInvoiceForm = {
  id: null,
  invoice: "",
  date: "",
  modelId: "",
  phaseId: "",
  phase: "",
  po: "",
  code: "",
  desc: "",
  qtyInv: "",
  qtyRecv: "",
  verifiedBy: "",
};

// Keep the selected invoice and PO context while preparing the next item.
const nextInvoiceLineForm = (values) => ({
  ...emptyInvoiceForm,
  invoice: values.invoice,
  date: values.date,
  modelId: values.modelId,
  phaseId: values.phaseId,
  phase: values.phase,
  po: values.po,
  verifiedBy: values.verifiedBy,
});
 
const REQUIRED_FIELDS = [
  { name: "invoice", label: "Invoice No" },
  { name: "date", label: "Invoice Date" },
  { name: "phase", label: "Phase" },
  { name: "po", label: "PO No" },
  { name: "code", label: "Item Code" },
  { name: "desc", label: "Item Description" },
  { name: "qtyInv", label: "Qty Invoiced" },
  { name: "qtyRecv", label: "Qty Received" },
  { name: "verifiedBy", label: "Verified By" },
];
 
function validateInvoiceForm(values) {
  const missing = REQUIRED_FIELDS.filter(
    ({ name }) => !String(values[name] ?? "").trim()
  );
 
  if (missing.length) {
    return `Please fill in: ${missing.map((field) => field.label).join(", ")}.`;
  }
 
  if (values.qtyInv && Number.isNaN(Number(values.qtyInv))) {
    return "Qty Invoiced must be a number.";
  }
 
  if (values.qtyRecv && Number.isNaN(Number(values.qtyRecv))) {
    return "Qty Received must be a number.";
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
 
export default function Invoices() {
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
 
  // ---------- Invoice list loading/error state ----------
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");
 
  const [modalOpen, setModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyInvoiceForm);
  const [savedNewLines, setSavedNewLines] = useState([]);
  const [editingSavedId, setEditingSavedId] = useState(null);
  const initialFormValuesRef = useRef(emptyInvoiceForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [boqPhases, setBoqPhases] = useState([]);
  const [boqPhasesLoading, setBoqPhasesLoading] = useState(false);
  const [boqPhasesError, setBoqPhasesError] = useState("");
  const [invoicePoLines, setInvoicePoLines] = useState([]);
  const [invoicePoLinesLoading, setInvoicePoLinesLoading] = useState(false);
  const [invoicePoLinesError, setInvoicePoLinesError] = useState("");
 
  // ---------- View modal (read-only detail popup, same shape as
  // Daily Production's details popup, with an Edit button that hands
  // off to the existing Add/Edit form modal) ----------
  const [viewRow, setViewRow] = useState(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewClosing, setViewClosing] = useState(false);
 
  // ---------- Bulk select / delete (same pattern as Daily Production) ----------
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
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
 
  // ---------- Fetch Invoices from the backend (initial load + post-save refresh) ----------
  const fetchInvoices = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;
    try {
      const res = await api.get(`${API_BASE_URL}/invoices`, {
        params: { page: pageToFetch, limit: PAGE_SIZE },
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load Invoices");
      }
      setRows(res.data.invoices || []);
      const pagination = res.data.pagination;
      if (pagination) {
        setTotalPages(pagination.totalPages || 1);
        setTotalCount(pagination.totalCount || 0);
        if (pagination.page !== pageToFetch) setPage(pagination.page);
      }
    } catch (err) {
      setRowsError(extractErrorMessage(err, "Failed to load Invoices."));
    } finally {
      if (!silent) setRowsLoading(false);
    }
  }, [page]);
 
  useEffect(() => {
    fetchInvoices({ targetPage: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    if (!modalOpen) return undefined;
    let cancelled = false;
    (async () => {
      setBoqPhasesLoading(true);
      setBoqPhasesError("");
      try {
        const res = await api.get(`${API_BASE_URL}/boq/phases`, { __vectorBackground: true });
        if (!res.data.success) throw new Error(res.data.message || "Failed to load phases");
        if (!cancelled) setBoqPhases(res.data.phases || []);
      } catch (err) {
        if (!cancelled) setBoqPhasesError(extractErrorMessage(err, "Failed to load phases"));
      } finally {
        if (!cancelled) setBoqPhasesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen || !formValues.modelId || !formValues.phaseId) {
      setInvoicePoLines([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setInvoicePoLinesLoading(true);
      setInvoicePoLinesError("");
      try {
        const res = await api.get(`${API_BASE_URL}/po-details/invoice-options`, {
          params: { modelId: formValues.modelId, phaseId: formValues.phaseId },
          __vectorBackground: true,
        });
        if (!res.data.success) throw new Error(res.data.message || "Failed to load PO numbers");
        if (!cancelled) setInvoicePoLines(res.data.poDetails || []);
      } catch (err) {
        if (!cancelled) setInvoicePoLinesError(extractErrorMessage(err, "Failed to load PO numbers"));
      } finally {
        if (!cancelled) setInvoicePoLinesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [modalOpen, formValues.modelId, formValues.phaseId]);
 
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, INVOICE_FILTER_FIELDS);
    });
  }, [query, rows, pageFilter]);
 
  const openAddModal = () => {
    setIsEditMode(false);
    initialFormValuesRef.current = emptyInvoiceForm;
    setFormValues(emptyInvoiceForm);
    setSavedNewLines([]);
    setEditingSavedId(null);
    setFormError("");
    setClosing(false);
    setModalOpen(true);
    setMenuOpen(false);
  };
 
  const openEditModal = (row) => {
    setIsEditMode(true);
    const initialValues = {
      id: row.id,
      invoice: row.invoice || "",
      date: row.date || "",
      modelId: row.modelId || "",
      phaseId: row.phaseId || "",
      phase: row.phase || "",
      po: row.po || "",
      code: row.code || "",
      desc: row.desc || "",
      qtyInv: row.qtyInv || "",
      qtyRecv: row.qtyRecv || "",
      verifiedBy: row.verifiedBy || "",
    };
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
        text: "Your invoice changes will be lost unless you save them.",
        confirmText: "Discard changes",
      });
      if (!result.isConfirmed) return;
    }
    setClosing(true);
    setTimeout(() => {
      setModalOpen(false);
      setClosing(false);
      setFormValues(emptyInvoiceForm);
      setSavedNewLines([]);
      setEditingSavedId(null);
      setFormError("");
      setIsEditMode(false);
    }, 220);
  };
 
  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  const phaseOptions = useMemo(() => boqPhases.map((item) => ({
    value: `${item.modelId}::${item.phaseId}`,
    label: item.modelName ? `${item.modelName}  ${item.phaseName}` : item.phaseName,
  })), [boqPhases]);

  const phaseSelectValue = formValues.modelId && formValues.phaseId
    ? `${formValues.modelId}::${formValues.phaseId}` : "";

  const poOptions = useMemo(() => [...new Map(invoicePoLines
    .filter((line) => line.po)
    .map((line) => [line.po, { value: line.po, label: line.po }])).values()], [invoicePoLines]);

  const itemCodeOptions = useMemo(() => invoicePoLines
    .filter((line) => line.po === formValues.po && line.code)
    .map((line) => ({ value: line.code, label: line.desc ? `${line.code}  ${line.desc}` : line.code })),
  [invoicePoLines, formValues.po]);

  const handlePhaseSelect = (value) => {
    const phase = boqPhases.find((item) => `${item.modelId}::${item.phaseId}` === value);
    setFormValues((prev) => ({ ...prev, modelId: phase?.modelId || "", phaseId: phase?.phaseId || "",
      phase: phase?.phaseName || "", po: "", code: "", desc: "" }));
  };

  const handlePoSelect = (po) => setFormValues((prev) => ({ ...prev, po, code: "", desc: "" }));

  const handleItemCodeSelect = (code) => {
    const item = invoicePoLines.find((line) => line.po === formValues.po && line.code === code);
    setFormValues((prev) => ({ ...prev, code, desc: item?.desc || "" }));
  };

  const goToPage = (nextPage) => {
    if (nextPage >= 1 && nextPage <= totalPages && nextPage !== page) setPage(nextPage);
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
 
  // Edit-from-view hands off to the existing, fully-featured Add/Edit
  // form modal instead of duplicating that logic in a second form.
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
 
  // ---------- Save/Update Invoice record to the backend, then refresh the table ----------
  const handleSave = async (addNew = false) => {
    if (saving) return;

    // "Save & Add New" leaves a blank next line ready for use.  If the user
    // chooses Save All & Close without entering that line, close directly;
    // every card above has already been persisted.
    const currentLineIsBlank = !formValues.code && !formValues.desc && !formValues.qtyInv && !formValues.qtyRecv;
    if (!addNew && !isEditMode && !editingSavedId && savedNewLines.length > 0 && currentLineIsBlank) {
      requestClose(true);
      return;
    }

    const error = validateInvoiceForm(formValues);
    if (error) {
      setFormError(error);
      return;
    }
 
    setSaving(true);
    setFormError("");
 
    try {
      const payload = { ...formValues };
      let res;
 
      if (isEditMode || editingSavedId) {
        res = await api.put(`${API_BASE_URL}/invoices/${isEditMode ? formValues.id : editingSavedId}`, payload);
      } else {
        res = await api.post(`${API_BASE_URL}/invoices`, payload);
      }
 
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to save Invoice");
      }
 
      setSaving(false);
      if (addNew && !isEditMode) {
        const nextValues = nextInvoiceLineForm(formValues);
        const savedLine = res.data.invoice || { ...formValues, id: editingSavedId };
        setSavedNewLines((previous) => [...previous.filter((line) => line.id !== editingSavedId), savedLine]);
        setEditingSavedId(null);
        initialFormValuesRef.current = nextValues;
        setFormValues(nextValues);
        await swalSuccess("Invoice Saved", "Enter the next item below.");
      } else {
        requestClose(true);
 
        await swalSuccess(
          isEditMode ? "Invoice Updated" : "Invoice Saved",
          `The Invoice has been ${isEditMode ? "updated" : "saved"} successfully.`
        );
      }
 
      await fetchInvoices({ silent: true, targetPage: page });
    } catch (err) {
      setSaving(false);
      setFormError(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
    }
  };

  const editSavedLine = (line) => {
    setFormValues({ ...line });
    setEditingSavedId(line.id);
    setFormError("");
  };

  const deleteSavedLine = async (line) => {
    if (!line.id) return;
    try {
      await api.delete(`${API_BASE_URL}/invoices/${line.id}`);
      setSavedNewLines((previous) => previous.filter((item) => item.id !== line.id));
      if (editingSavedId === line.id) {
        setEditingSavedId(null);
        setFormValues(nextInvoiceLineForm(line));
      }
    } catch (err) {
      setFormError(extractErrorMessage(err, "Unable to delete this saved Invoice."));
    }
  };
 
  // ---------- Single-row delete ----------
  const handleDeleteClick = async (row) => {
    const id = getRowId(row);
    if (!id) return;
 
    const result = await swalConfirm({
      title: "Delete this invoice?",
      text: "Are you sure you want to delete this Invoice? This action cannot be undone.",
    });
    if (!result.isConfirmed) return;
 
    setDeletingId(id);
    try {
      const res = await api.delete(`${API_BASE_URL}/invoices/${id}`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to delete Invoice");
      }
      await fetchInvoices({ silent: true, targetPage: rows.length === 1 && page > 1 ? page - 1 : page });
      swalSuccess("Invoice Deleted", "The record has been removed successfully.");
    } catch (err) {
      swalError("Delete failed", extractErrorMessage(err, "Something went wrong while deleting."));
    } finally {
      setDeletingId(null);
    }
  };
 
  // ---------- Bulk select / delete (mirrors Daily Production) ----------
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
      title: "Delete selected Invoices?",
      text: `Delete ${selectedIds.size} selected Invoice(s)? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;
 
    setBulkDeleting(true);
    try {
      const res = await api.post(`${API_BASE_URL}/invoices/bulk-delete`, {
        ids: Array.from(selectedIds),
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to delete Invoices");
      }
      const deletedCount = selectedIds.size;
      setSelectMode(false);
      setSelectedIds(new Set());
      setMenuOpen(false);
      await fetchInvoices({ silent: true, targetPage: rows.length === deletedCount && page > 1 ? page - 1 : page });
      swalSuccess("Invoices Deleted", `${deletedCount} record(s) removed.`);
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
            className="invoices-row-checkbox"
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
 
  // Every field is required, so the Save/Update button stays disabled
  // until the whole form is filled in, instead of only catching missing
  // fields after the user clicks Save.
  const formIsIncomplete = validateInvoiceForm(formValues) !== null;
 
  return (
    <div className="invoices-page">
      <div className="invoices-toolbar">
        <div className="invoices-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="invoices-add-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="invoices-add-btn"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || bulkDeleting}
              >
                <Trash2 size={16} />
                {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </button>
              <button type="button" className="invoices-add-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="invoices-add-btn" onClick={openAddModal}>
                <Plus size={18} />
                Add Invoice
              </button>
              <button type="button" className="invoices-delete-btn" onClick={toggleSelectMode}>
                <Trash2 size={16} /> Delete
              </button>
            </>
          )}
        </div>
 
        <div className="invoices-kebab-wrapper" ref={menuRef}>
          <button
            type="button"
            className="invoices-kebab-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="More actions"
          >
            <MoreVertical size={20} />
          </button>
 
          {menuOpen && (
            <div className="invoices-kebab-menu">
              {selectMode ? (
                <>
                  <button type="button" className="invoices-menu-item" onClick={toggleSelectAll}>
                    <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    className="invoices-menu-item"
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || bulkDeleting}
                  >
                    <Trash2 size={16} />
                    {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
                  </button>
                  <button type="button" className="invoices-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="invoices-menu-item" onClick={openAddModal}>
                    <Plus size={16} /> Add Invoice
                  </button>
                  <button type="button" className="invoices-menu-item" onClick={toggleSelectMode}>
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
            <SearchBar value={query} onChange={setQuery} placeholder="Search Invoices..." />
            <PageFilter rows={rows} fields={INVOICE_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          </div>
          <ExportPdfButton
            mode="table"
            title="Invoices"
            columns={columns}
            rows={filteredRows}
          />
        </div>
 
        {rowsLoading ? (
          <div className="invoices-loading">
            <Loader2 size={28} className="spin" />
            <span>Loading Invoices...</span>
          </div>
        ) : rowsError ? (
          <div className="invoices-load-error">
            <div className="invoices-load-error-actions">
              <span>{rowsError}</span>
              <button
                type="button"
                className="invoices-btn-secondary"
                onClick={() => fetchInvoices({ targetPage: page })}
              >
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="invoices-empty-state">
            <span>No Invoices yet. Click "Add Invoice" to create the first record.</span>
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
        <div className="invoices-pagination">
          <p className="invoices-hint">Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows</p>
          <div className="invoices-pagination-controls">
            <button type="button" className="invoices-page-btn" onClick={() => goToPage(1)} disabled={page === 1} aria-label="First page"><ChevronsLeft size={16} /></button>
            {page > 1 && <button type="button" className="invoices-page-btn" onClick={() => goToPage(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /> Prev</button>}
            <span className="invoices-page-current" key={page}>{page}</span>
            {page < totalPages && <button type="button" className="invoices-page-btn" onClick={() => goToPage(page + 1)} aria-label="Next page">Next <ChevronRight size={16} /></button>}
            <button type="button" className="invoices-page-btn" onClick={() => goToPage(totalPages)} disabled={page === totalPages} aria-label="Last page"><ChevronsRight size={16} /></button>
          </div>
        </div>
      )}
 
      {/* ---------- Add/Edit Invoice Modal ---------- */}
      {modalOpen && createPortal(
        <div
          className={`modal-overlay${closing ? " closing" : ""}`}
          onClick={requestClose}
        >
          <div
            className={`modal-container invoice-entry-modal${closing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={isEditMode ? "Edit Invoice" : "Add Invoice"}
          >
            <div className="modal-header">
              <h2>{isEditMode ? "Edit Invoice" : "Add Invoice"}</h2>
              <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                <X size={22} />
              </button>
            </div>
 
            <form
              className="invoices-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="invoices-form-error">{formError}</div>}

              {savedNewLines.map((line, index) => (
                <section className="boq-item-card" key={`${line.invoice}-${line.po}-${line.code}-${index}`}>
                  {(() => {
                    const editingThisLine = editingSavedId === line.id;
                    const values = editingThisLine ? formValues : line;
                    return <>
                  <div className="boq-item-card-header">
                    <span className="boq-item-number">Invoice Detail {index + 1} — {editingThisLine ? "Editing" : "Saved"}</span>
                    <div className="boq-item-card-actions">
                      <button type="button" className="boq-item-save" onClick={() => editingThisLine ? handleSave(true) : editSavedLine(line)}><Pencil size={14} /> {editingThisLine ? "Save changes" : "Edit"}</button>
                      <button type="button" className="icon-btn boq-item-remove" onClick={() => deleteSavedLine(line)} aria-label={`Delete Invoice Detail ${index + 1}`}><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="invoices-form-grid">
                    <label className="invoices-field"><span>Invoice No</span><input name="invoice" value={values.invoice} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>Invoice Date</span><input name="date" value={values.date} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>Phase</span><input name="phase" value={values.phase} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>PO No</span><input name="po" value={values.po} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>Item Code</span><input name="code" value={values.code} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field invoices-field-span2"><span>Item Description</span><input name="desc" value={values.desc} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>Qty Invoiced</span><input name="qtyInv" value={values.qtyInv} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="invoices-field"><span>Qty Received</span><input name="qtyRecv" value={values.qtyRecv} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                  </div>
                    </>;
                  })()}
                </section>
              ))}

              {savedNewLines.length > 0 && <div className="po-new-line-heading"><span>{editingSavedId ? "Edit Invoice Detail" : "New Invoice Detail"}</span></div>}

              {!editingSavedId && <div className="invoices-form-grid">
                <label className="invoices-field">
                  <span>Invoice No <span className="invoices-required-asterisk">*</span></span>
                  <input
                    name="invoice"
                    value={formValues.invoice}
                    onChange={handleFormChange}
                    placeholder="e.g. INV-2201"
                  />
                </label>
 
                <label className="invoices-field">
                  <span>Invoice Date <span className="invoices-required-asterisk">*</span></span>
                  <DatePicker value={formValues.date} onChange={(date) => setFormValues((prev) => ({ ...prev, date }))} ariaLabel="Select invoice date" />
                </label>
 
                <label className="invoices-field">
                  <span>Phase <span className="invoices-required-asterisk">*</span></span>
                  <SearchableSelect
                    options={phaseOptions}
                    value={phaseSelectValue}
                    onChange={handlePhaseSelect}
                    placeholder="Select Phase"
                    loading={boqPhasesLoading}
                    emptyMessage={boqPhasesError || "No phases found in BOQ"}
                  />
                </label>

                <label className="invoices-field">
                  <span>PO No <span className="invoices-required-asterisk">*</span></span>
                  <SearchableSelect
                    options={poOptions}
                    value={formValues.po}
                    onChange={handlePoSelect}
                    placeholder={formValues.phaseId ? "Select PO No" : "Select Phase first"}
                    disabled={!formValues.phaseId}
                    loading={invoicePoLinesLoading}
                    emptyMessage={invoicePoLinesError || "No PO numbers found for this phase"}
                  />
                </label>

                <label className="invoices-field">
                  <span>Item Code <span className="invoices-required-asterisk">*</span></span>
                  <SearchableSelect
                    options={itemCodeOptions}
                    value={formValues.code}
                    onChange={handleItemCodeSelect}
                    placeholder={formValues.po ? "Select Item Code" : "Select PO No first"}
                    disabled={!formValues.po}
                    loading={invoicePoLinesLoading}
                    emptyMessage={invoicePoLinesError || "No item codes found for this PO"}
                  />
                </label>
 
                <label className="invoices-field invoices-field-span2">
                  <span>Item Description <span className="invoices-required-asterisk">*</span></span>
                  <input
                    name="desc"
                    value={formValues.desc}
                    readOnly
                    disabled
                    placeholder="Auto-filled from selected item code"
                  />
                </label>
 
                <label className="invoices-field">
                  <span>Qty Invoiced <span className="invoices-required-asterisk">*</span></span>
                  <input
                    type="number"
                    min="0"
                    name="qtyInv"
                    value={formValues.qtyInv}
                    onChange={handleFormChange}
                    placeholder="e.g. 100"
                  />
                </label>
 
                <label className="invoices-field">
                  <span>Qty Received <span className="invoices-required-asterisk">*</span></span>
                  <input
                    type="number"
                    min="0"
                    name="qtyRecv"
                    value={formValues.qtyRecv}
                    onChange={handleFormChange}
                    placeholder="e.g. 100"
                  />
                </label>
 
                <label className="invoices-field">
                  <span>Verified By <span className="invoices-required-asterisk">*</span></span>
                  <input
                    name="verifiedBy"
                    value={formValues.verifiedBy}
                    onChange={handleFormChange}
                    placeholder="e.g. A. Sharma"
                  />
                </label>
              </div>}
            </form>
 
            <div className="modal-footer">
              <button type="button" className="invoices-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              {!isEditMode && (
                <button
                  type="button"
                  className="invoices-btn-secondary"
                  onClick={() => handleSave(true)}
                  disabled={saving || formIsIncomplete}
                >
                  {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                  {saving ? "Saving..." : "Save & Add New"}
                </button>
              )}
              <button
                type="button"
                className="invoices-btn-primary"
                onClick={() => handleSave(false)}
                disabled={saving || formIsIncomplete}
              >
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : isEditMode ? "Update" : "Save All & Close"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
 
      {/* ---------- View Invoice Modal (read-only, + hand-off to Edit) ---------- */}
      {viewOpen && viewRow && createPortal(
        <div
          className={`invoices-details-overlay${viewClosing ? " closing" : ""}`}
          onClick={requestCloseView}
        >
          <div
            className={`invoices-details-container${viewClosing ? " closing" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Invoice Details"
          >
            <div className="invoices-details-header">
              <h2>Invoice Details</h2>
              <div className="invoices-details-header-actions">
                <button
                  type="button"
                  className="invoices-details-edit-btn"
                  onClick={startEditFromView}
                  aria-label="Edit Invoice"
                >
                  <Pencil size={15} />
                  Edit
                </button>
                <button
                  type="button"
                  className="invoices-details-close"
                  onClick={requestCloseView}
                  aria-label="Close"
                >
                  <X size={22} />
                </button>
              </div>
            </div>
 
            <div className="invoices-details-body">
              <section className="invoices-details-section">
                <h3>Invoice Details</h3>
                <div className="invoices-details-grid">
                  {DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="invoices-details-label">{field.label}</div>
                      <div className="invoices-details-value">
                        {formatDetailValue(field, viewRow)}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </section>
            </div>
 
            <div className="invoices-details-footer">
              <button type="button" className="invoices-btn-secondary" onClick={requestCloseView}>
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
 
