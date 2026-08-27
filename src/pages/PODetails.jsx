import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../components/Api";
import Swal from "sweetalert2";
import { Plus, X, Save, Loader2, RefreshCw, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Trash2, Check, MoreVertical, Pencil } from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import StatusDropdown from "../components/StatusDropdown";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import { fmtINR } from "../data/mockData";
import "./PODetails.css";

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
const PAGE_SIZE = 10;

const columns = [
  { key: "phase", label: "Phase" },
  { key: "po", label: "PO No", mono: true },
  { key: "date", label: "PO Date", isDate: true },
  { key: "code", label: "Item Code", mono: true },
  { key: "desc", label: "Item Description" },
  { key: "qty", label: "Qty Ordered" },
  { key: "rate", label: "Unit Rate", format: fmtINR },
  { key: "gst", label: "GST 18%", format: fmtINR },
  { key: "value", label: "PO Value", format: fmtINR },
  { key: "status", label: "Status" },
];
const PO_FILTER_FIELDS = columns.filter((column) => ["phase", "po", "code", "status"].includes(column.key));

const STATUS_OPTIONS = [
  "Pending",
  "In Progress",
  "Approved",
  "Completed",
];

const PO_DETAIL_FIELDS = [
  { key: "phase", label: "Phase" },
  { key: "po", label: "PO No", editable: true },
  { key: "date", label: "PO Date", isDate: true, editable: true },
  { key: "code", label: "Item Code" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "desc", label: "Item Description" },
  { key: "qty", label: "Qty Ordered", editable: true, isNumber: true },
  { key: "rate", label: "Unit Rate", isCurrency: true, editable: true, isNumber: true },
  { key: "gst", label: "GST 18%", isCurrency: true },
  { key: "value", label: "PO Value", isCurrency: true },
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
  date: "",
  code: "",
  make: "",
  model: "",
  desc: "",
  qty: "",
  rate: "",
  expectedDeliveryDate: "",
  status: "",
};

// A PO commonly contains more than one item.  Retain its shared details
// while clearing the item-specific fields for the next entry.
const nextPoLineForm = (values) => ({
  ...emptyPoForm,
  modelId: values.modelId,
  phaseId: values.phaseId,
  phase: values.phase,
  po: values.po,
  date: values.date,
  expectedDeliveryDate: values.expectedDeliveryDate,
  status: values.status,
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

  return null;
}

function validateEditForm(values) {
  if (!String(values.po ?? "").trim()) return "PO No cannot be empty.";
  if (!String(values.date ?? "").trim()) return "PO Date cannot be empty.";
  if (!String(values.qty ?? "").trim()) return "Qty Ordered cannot be empty.";
  if (Number.isNaN(Number(values.qty))) return "Qty Ordered must be a number.";
  if (!String(values.rate ?? "").trim()) return "Unit Rate cannot be empty.";
  if (Number.isNaN(Number(values.rate))) return "Unit Rate must be a number.";
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
  const raw = row[field.key];
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return "Not Provided";
  }
  if (field.isDate) return formatDateDisplay(raw);
  if (field.isCurrency) return fmtINR(raw);
  return String(raw);
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
    date: toDateInputValue(row.date),
    qty: row.qty ?? "",
    rate: row.rate ?? "",
    status: row.status || "",
    expectedDeliveryDate: toDateInputValue(row.expectedDeliveryDate),
  };
}

function calculatePoAmounts(qty, rate) {
  if (String(qty ?? "").trim() === "" || String(rate ?? "").trim() === "") {
    return null;
  }

  const numericQty = Number(qty);
  const numericRate = Number(rate);
  if (!Number.isFinite(numericQty) || !Number.isFinite(numericRate)) return null;

  const subtotal = numericQty * numericRate;
  const gst = Math.round(subtotal * 0.18 * 100) / 100;
  return { gst, value: Math.round((subtotal + gst) * 100) / 100 };
}

export default function PODetails() {
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);

  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyPoForm);
  const [savedNewLines, setSavedNewLines] = useState([]);
  const [editingSavedId, setEditingSavedId] = useState(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const [boqPhases, setBoqPhases] = useState([]);
  const [boqPhasesLoading, setBoqPhasesLoading] = useState(false);
  const [boqPhasesError, setBoqPhasesError] = useState("");

  const [boqItems, setBoqItems] = useState([]);
  const [boqItemsLoading, setBoqItemsLoading] = useState(false);
  const [boqItemsError, setBoqItemsError] = useState("");

  const [detailsRow, setDetailsRow] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsClosing, setDetailsClosing] = useState(false);

  const [detailsEditMode, setDetailsEditMode] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState("");

  const previewDetailsRow = useMemo(() => {
    if (!detailsRow || !detailsEditMode) return detailsRow;

    const totals = calculatePoAmounts(editForm.qty, editForm.rate);
    return {
      ...detailsRow,
      qty: editForm.qty,
      rate: editForm.rate,
      ...(totals || {}),
    };
  }, [detailsRow, detailsEditMode, editForm.qty, editForm.rate]);

  const [updatingStatusId, setUpdatingStatusId] = useState(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

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

  const openDetails = (row) => {
    setDetailsRow(row);
    setEditForm(buildEditForm(row));
    setDetailsEditMode(false);
    setDetailsError("");
    setDetailsClosing(false);
    setDetailsOpen(true);
  };

  const closeDetails = useCallback(() => {
    if (detailsClosing) return;
    setDetailsClosing(true);
    setTimeout(() => {
      setDetailsOpen(false);
      setDetailsClosing(false);
      setDetailsRow(null);
      setEditForm({});
      setDetailsEditMode(false);
      setDetailsError("");
    }, 200);
  }, [detailsClosing]);

  const requestCloseDetails = useCallback(async () => {
    if (detailsClosing) return;
    if (detailsEditMode && JSON.stringify(editForm) !== JSON.stringify(buildEditForm(detailsRow))) {
      const result = await Swal.fire({ title: "Discard unsaved changes?", text: "Your PO Detail changes will be lost unless you save them.", icon: "warning", showCancelButton: true, confirmButtonText: "Discard changes", cancelButtonText: "Keep editing", reverseButtons: true, customClass: { popup: "swal-vector-popup" } });
      if (!result.isConfirmed) return;
    }
    closeDetails();
  }, [detailsClosing, detailsEditMode, editForm, detailsRow, closeDetails]);

  useEffect(() => {
    if (!detailsOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") {
        if (detailsEditMode) {
          setDetailsEditMode(false);
          setEditForm(buildEditForm(detailsRow));
          setDetailsError("");
        } else {
          requestCloseDetails();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [detailsOpen, detailsEditMode, detailsRow, requestCloseDetails]);

  const fetchPoDetails = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;
    try {
      const res = await api.get(`${API_BASE_URL}/po-details`, {
        params: { page: pageToFetch, limit: PAGE_SIZE },
      });
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load PO Details");
      }
      setRows(res.data.poDetails || []);

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
  }, [page]);

  useEffect(() => {
    fetchPoDetails({ targetPage: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;

    (async () => {
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
        if (!cancelled) {
          const activeModelIds = new Set((modelRes.data.models || []).map((model) => model.id));
          setBoqPhases((phaseRes.data.phases || []).filter((phase) => activeModelIds.has(phase.modelId)));
        }
      } catch (err) {
        if (!cancelled) {
          setBoqPhasesError(extractErrorMessage(err, "Failed to load phases"));
        }
      } finally {
        if (!cancelled) setBoqPhasesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [modalOpen]);

  const fetchBoqItems = useCallback(async (modelId, phaseId) => {
    setBoqItemsLoading(true);
    setBoqItemsError("");
    setBoqItems([]);
    try {
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
      setBoqItems(res.data.boq?.allRows || res.data.boq?.rows || []);
    } catch (err) {
      setBoqItemsError(extractErrorMessage(err, "Failed to load BOQ items"));
      setBoqItems([]);
    } finally {
      setBoqItemsLoading(false);
    }
  }, []);

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

    setFormValues((prev) => ({
      ...prev,
      phase: found ? found.phaseName : "",
      modelId: found ? found.modelId : "",
      phaseId: found ? found.phaseId : "",
      code: "",
      make: "",
      model: "",
      desc: "",
      rate: "",
    }));

    setBoqItems([]);
    setBoqItemsError("");

    if (found) {
      fetchBoqItems(found.modelId, found.phaseId);
    }
  };

  const handleItemCodeSelect = (code) => {
    const found = boqItems.find((item) => item.code === code);
    setFormValues((prev) => ({
      ...prev,
      code,
      make: found?.make || "",
      model: found?.model || "",
      desc: found?.desc || "",
      rate: found?.rate ?? "",
    }));
  };

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, PO_FILTER_FIELDS);
    });
  }, [query, rows, pageFilter]);

  const openModal = () => {
    setFormValues(emptyPoForm);
    setSavedNewLines([]);
    setEditingSavedId(null);
    setFormError("");
    setClosing(false);
    setBoqItems([]);
    setBoqItemsError("");
    setModalOpen(true);
    setMenuOpen(false);
  };

  const requestClose = (skipConfirmation = false) => {
    if (closing) return;
    if (skipConfirmation !== true && JSON.stringify(formValues) !== JSON.stringify(emptyPoForm)) {
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
      setSavedNewLines([]);
      setEditingSavedId(null);
      setFormError("");
      setBoqItems([]);
      setBoqItemsError("");
    }, 220);
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async (addNew = false) => {
    if (saving) return;

    // After one or more lines were saved with "Save & Add New", the editor
    // below is intentionally blank.  There is nothing left to validate in
    // that case; simply close the completed PO popup.
    const currentLineIsBlank = !formValues.code && !formValues.desc && !formValues.qty;
    if (!addNew && !editingSavedId && savedNewLines.length > 0 && currentLineIsBlank) {
      requestClose(true);
      return;
    }

    const error = validatePoForm(formValues);
    if (error) {
      setFormError(error);
      return;
    }

    setSaving(true);
    setFormError("");

    try {
      const payload = { ...formValues, status: formValues.status || null };

      const res = editingSavedId
        ? await api.put(`${API_BASE_URL}/po-details/${editingSavedId}`, payload)
        : await api.post(`${API_BASE_URL}/po-details`, payload);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to save PO Detail");
      }

      if (addNew) {
        const savedLine = res.data.po || { ...formValues, id: editingSavedId };
        setSavedNewLines((previous) => [...previous.filter((line) => line.id !== editingSavedId), savedLine]);
        setFormValues(nextPoLineForm(formValues));
        setEditingSavedId(null);
        await swalSuccess("PO Detail Saved", "Enter the next item below.");
      } else {
        requestClose(true);
        await swalSuccess("PO Detail Saved", "The PO Detail has been saved successfully.");
      }

      if (page === 1) {
        await fetchPoDetails({ silent: true, targetPage: 1 });
      } else {
        setPage(1);
      }
    } catch (err) {
      setFormError(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
    } finally {
      setSaving(false);
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
      await api.delete(`${API_BASE_URL}/po-details/${line.id}`);
      setSavedNewLines((previous) => previous.filter((item) => item.id !== line.id));
      if (editingSavedId === line.id) {
        setEditingSavedId(null);
        setFormValues(nextPoLineForm(line));
      }
    } catch (err) {
      setFormError(extractErrorMessage(err, "Unable to delete this saved PO Detail."));
    }
  };

  const startEditingDetails = () => {
    if (!detailsRow) return;
    setEditForm(buildEditForm(detailsRow));
    setDetailsError("");
    setDetailsEditMode(true);
  };

  const cancelEditingDetails = () => {
    if (detailsRow) setEditForm(buildEditForm(detailsRow));
    setDetailsError("");
    setDetailsEditMode(false);
  };

  const handleEditFormChange = (event) => {
    const { name, value } = event.target;
    setEditForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSaveDetails = async () => {
    if (!detailsRow || detailsSaving) return;

    const validationError = validateEditForm(editForm);
    if (validationError) {
      setDetailsError(validationError);
      return;
    }

    const id = getRowId(detailsRow);
    if (!id) {
      setDetailsError("Missing record identifier; cannot save changes.");
      return;
    }

    const original = buildEditForm(detailsRow);
    const payload = {};

    if (editForm.po !== original.po) payload.po = editForm.po.trim();
    if (editForm.date !== original.date) payload.date = editForm.date;
    if (String(editForm.qty) !== String(original.qty)) payload.qty = editForm.qty;
    if (String(editForm.rate) !== String(original.rate)) payload.rate = editForm.rate;
    if (editForm.status !== original.status) payload.status = editForm.status || null;
    if (editForm.expectedDeliveryDate !== original.expectedDeliveryDate) {
      payload.expectedDeliveryDate = editForm.expectedDeliveryDate || null;
    }

    if (Object.keys(payload).length === 0) {
      closeDetails();
      return;
    }

    setDetailsSaving(true);
    setDetailsError("");

    try {
      const res = await api.put(`${API_BASE_URL}/po-details/${id}`, payload);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to update PO Detail");
      }

      setDetailsEditMode(false);
      await swalSuccess("PO Detail Updated", "The PO Detail has been updated successfully.");

      const updatedRes = await api.get(`${API_BASE_URL}/po-details/${id}`);
      if (updatedRes.data.success) {
        const updatedRow = updatedRes.data.po;
        setDetailsRow(updatedRow);
        setEditForm(buildEditForm(updatedRow));
        setRows((prev) => prev.map((r) => (getRowId(r) === id ? updatedRow : r)));
      } else {
        await fetchPoDetails({ silent: true, targetPage: page });
      }
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
      await fetchPoDetails({ targetPage: page });
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
  const itemCodeEmptyMessage = boqItemsError
    ? boqItemsError
    : "No BOQ items found for this phase.";

  const goToPage = (nextPage) => {
    const clamped = Math.min(Math.max(nextPage, 1), totalPages);
    if (clamped === page) return;
    setPage(clamped);
  };

  return (
    <div className="po-page">
      <div className="po-toolbar">
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
              <button type="button" className="po-delete-btn" onClick={toggleSelectMode}>
                <Trash2 size={16} /> Delete
              </button>
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
                  <button type="button" className="po-menu-item" onClick={toggleSelectMode}>
                    <Trash2 size={16} /> Delete
                  </button>
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

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <SearchBar value={query} onChange={setQuery} placeholder="Search PO Details..." />
            <PageFilter rows={rows} fields={PO_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          </div>
          <ExportPdfButton
            mode="table"
            title="PO Details"
            columns={columns}
            rows={filteredRows}
          />
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
            <span>No PO Details yet. Click "Add PO" to create the first record.</span>
          </div>
        ) : (
          <DataTable columns={tableColumns} rows={filteredRows} onViewDetails={openDetails} />
        )}
      </div>

      {!rowsLoading && !rowsError && rows.length > 0 && (
        <div className="po-pagination">
          <p className="po-hint">
            Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
            {"–"}
            {(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows
          </p>

          <div className="po-pagination-controls">
            <button
              type="button"
              className="po-page-btn po-page-edge"
              onClick={() => goToPage(1)}
              disabled={page === 1}
              aria-label="First page"
            >
              <ChevronsLeft size={16} />
            </button>

            {page > 1 && (
              <button
                type="button"
                className="po-page-btn po-page-nav"
                onClick={() => goToPage(page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
                Prev
              </button>
            )}

            <span className="po-page-current" key={page}>{page}</span>

            {page < totalPages && (
              <button
                type="button"
                className="po-page-btn po-page-nav"
                onClick={() => goToPage(page + 1)}
                aria-label="Next page"
              >
                Next
                <ChevronRight size={16} />
              </button>
            )}

            <button
              type="button"
              className="po-page-btn po-page-edge"
              onClick={() => goToPage(totalPages)}
              disabled={page === totalPages}
              aria-label="Last page"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
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
              <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                <X size={22} />
              </button>
            </div>

            <form
              className="po-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="po-form-error">{formError}</div>}

              {savedNewLines.map((line, index) => (
                <section className="boq-item-card" key={`${line.po}-${line.code}-${index}`}>
                  {(() => {
                    const editingThisLine = editingSavedId === line.id;
                    const values = editingThisLine ? formValues : line;
                    return <>
                  <div className="boq-item-card-header">
                    <span className="boq-item-number">PO Detail {index + 1} — {editingThisLine ? "Editing" : "Saved"}</span>
                    <div className="boq-item-card-actions">
                      <button type="button" className="boq-item-save" onClick={() => editingThisLine ? handleSave(true) : editSavedLine(line)}><Pencil size={14} /> {editingThisLine ? "Save changes" : "Edit"}</button>
                      <button type="button" className="icon-btn boq-item-remove" onClick={() => deleteSavedLine(line)} aria-label={`Delete PO Detail ${index + 1}`}><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="po-form-grid">
                    <label className="po-field"><span>Phase</span><input name="phase" value={values.phase} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field"><span>PO No</span><input name="po" value={values.po} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field"><span>PO Date</span><input name="date" value={values.date} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field"><span>Item Code</span><input name="code" value={values.code} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field po-field-span2"><span>Item Description</span><input name="desc" value={values.desc} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field"><span>Qty Ordered</span><input name="qty" value={values.qty} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                    <label className="po-field"><span>Unit Rate</span><input name="rate" value={values.rate} onChange={handleFormChange} readOnly={!editingThisLine} /></label>
                  </div>
                    </>;
                  })()}
                </section>
              ))}

              {savedNewLines.length > 0 && <div className="po-new-line-heading"><span>{editingSavedId ? "Edit PO Detail" : "New PO Detail"}</span></div>}

              {!editingSavedId && <div className="po-form-grid">
                <label className="po-field">
                  <span>Phase</span>
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
                  <span>PO No</span>
                  <input
                    name="po"
                    value={formValues.po}
                    onChange={handleFormChange}
                    placeholder="e.g. PO-4521"
                  />
                </label>

                <label className="po-field">
                  <span>PO Date</span>
                  <DatePicker value={formValues.date} onChange={(date) => setFormValues((prev) => ({ ...prev, date }))} ariaLabel="Select PO date" />
                </label>

                <label className="po-field">
                  <span>Item Code</span>
                  <SearchableSelect
                    options={itemCodeOptions}
                    value={formValues.code}
                    onChange={handleItemCodeSelect}
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
                  <input
                    name="make"
                    value={formValues.make}
                    readOnly
                    disabled
                    placeholder="Auto-filled from BOQ"
                  />
                </label>

                <label className="po-field">
                  <span>Model</span>
                  <input
                    name="model"
                    value={formValues.model}
                    readOnly
                    disabled
                    placeholder="Auto-filled from BOQ"
                  />
                </label>

                <label className="po-field po-field-span2">
                  <span>Item Description</span>
                  <input
                    name="desc"
                    value={formValues.desc}
                    readOnly
                    disabled
                    placeholder="Auto-filled from BOQ"
                  />
                </label>

                <label className="po-field">
                  <span>Qty Ordered</span>
                  <input
                    type="number"
                    min="0"
                    name="qty"
                    value={formValues.qty}
                    onChange={handleFormChange}
                    placeholder="e.g. 10"
                  />
                </label>

                <label className="po-field">
                  <span>Unit Rate</span>
                  <input
                    type="number"
                    name="rate"
                    value={formValues.rate}
                    readOnly
                    disabled={!formValues.code}
                    placeholder={!formValues.code ? "Select Item Code first" : "Auto-filled from BOQ"}
                  />
                </label>

                <label className="po-field">
                  <span>Expected Delivery Date</span>
                  <DatePicker value={formValues.expectedDeliveryDate} onChange={(expectedDeliveryDate) => setFormValues((prev) => ({ ...prev, expectedDeliveryDate }))} ariaLabel="Select expected delivery date" />
                </label>

                <label className="po-field">
                  <span>Status</span>
                  <StatusDropdown
                    name="status"
                    value={formValues.status}
                    options={STATUS_OPTIONS}
                    onChange={handleFormChange}
                    placeholder="Select status"
                  />
                </label>
              </div>}
            </form>

            <div className="modal-footer">
              <button type="button" className="po-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="po-btn-secondary" onClick={() => handleSave(true)} disabled={saving}>
                {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                {saving ? "Saving..." : "Save & Add New"}
              </button>
              <button type="button" className="po-btn-primary" onClick={() => handleSave(false)} disabled={saving}>
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : "Save All & Close"}
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
              <h2>PO Details</h2>
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
              {detailsError && <div className="po-form-error">{detailsError}</div>}

              <section className="po-details-section">
                <h3>PO Details</h3>
                <div className="po-details-grid">
                  {PO_DETAIL_FIELDS.map((field) => (
                    <React.Fragment key={field.key}>
                      <div className="po-details-label">{field.label}</div>
                      <div className="po-details-value">
                        {detailsEditMode && field.editable ? (
                          field.isStatus ? (
                            <StatusDropdown
                              name="status"
                              value={editForm.status}
                              options={STATUS_OPTIONS}
                              onChange={handleEditFormChange}
                              placeholder="Select status"
                            />
                          ) : (
                            field.isDate ? (
                              <DatePicker value={editForm[field.key] ?? ""} onChange={(date) => setEditForm((prev) => ({ ...prev, [field.key]: date }))} ariaLabel={`Select ${field.label}`} />
                            ) : (
                              <input type={field.isNumber ? "number" : "text"} className="po-details-edit-input" name={field.key} value={editForm[field.key] ?? ""} onChange={handleEditFormChange} />
                            )
                          )
                        ) : (
                          formatDetailValue(field, previewDetailsRow)
                        )}
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
                        {detailsEditMode && field.editable ? (
                          <DatePicker value={editForm[field.key] ?? ""} onChange={(date) => setEditForm((prev) => ({ ...prev, [field.key]: date }))} ariaLabel={`Select ${field.label}`} />
                        ) : (
                          formatDetailValue(field, detailsRow)
                        )}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </section>
            </div>

            <div className="po-details-footer">
              {detailsEditMode ? (
                <>
                  <button
                    type="button"
                    className="po-btn-secondary"
                    onClick={cancelEditingDetails}
                    disabled={detailsSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="po-details-close-btn"
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
                  className="po-btn-secondary"
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

