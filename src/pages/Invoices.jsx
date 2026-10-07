import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
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
  ArrowLeft,
  FileText,
  GitBranch,
} from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import AttachmentsEditor, { attachmentsOf } from "../components/AttachmentsEditor";
import ImageStrip from "../components/ImageStrip";
import "../components/ImageAttachment.css";
import { formatDate } from "../utils/date";
import DatePicker from "../components/DatePicker";
import "./Model.css";
import "./Invoices.css";
 
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

// The drill-down this tab was showing, kept across a browser refresh.
const DRILL_KEY = "vector_invoices_drill";
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
  attachments: [],
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
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
 
  // ---------- Invoice list loading/error state ----------
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState("");
 
  // ---------- Card drill-down: phase -> invoice -> line items ----------
  const [phaseCards, setPhaseCards] = useState([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsError, setCardsError] = useState("");
  // A refresh must land on the same drill-down: phase cards -> invoice cards
  // -> table. sessionStorage is per tab, so a second tab keeps its own place.
  const [selectedPhase, setSelectedPhase] = useState(() => readDrill(DRILL_KEY)?.phase ?? null);
  const [selectedInvoice, setSelectedInvoice] = useState(() => readDrill(DRILL_KEY)?.invoice ?? null);

  useEffect(() => {
    writeDrill(
      DRILL_KEY,
      selectedPhase || selectedInvoice
        ? { phase: selectedPhase, invoice: selectedInvoice }
        : null
    );
  }, [selectedPhase, selectedInvoice]);

  // Clicking "Invoices" in the sidebar re-opens the phase card grid.
  useEffect(() => {
    const resetDrill = () => {
      setSelectedPhase(null);
      setSelectedInvoice(null);
    };
    window.addEventListener("vector:invoices-reset", resetDrill);
    return () => window.removeEventListener("vector:invoices-reset", resetDrill);
  }, []);
  const [filterOptions, setFilterOptions] = useState({});
 
  const [modalOpen, setModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [closing, setClosing] = useState(false);
  const [formValues, setFormValues] = useState(emptyInvoiceForm);
  const [itemDrafts, setItemDrafts] = useState([]);
  // One set of files for the whole invoice number, shared by every item line.
  const [invoiceAttachments, setInvoiceAttachments] = useState([]);
  const lastItemRef = useRef(null);
  const initialFormValuesRef = useRef(emptyInvoiceForm);
// Item blocks count as unsaved work too, now that Edit uses them as well.
const initialItemDraftsRef = useRef([]);
const initialAttachmentsRef = useRef([]);
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
 
  // ---------- Card grid (one card per phase) that opens the drill-down ----------
  const fetchPhaseCards = useCallback(async () => {
    setCardsLoading(true);
    setCardsError("");
    try {
      const res = await api.get(`${API_BASE_URL}/invoices/groups`);
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

  // ---------- Fetch Invoices from the backend (initial load + post-save refresh) ----------
  const fetchInvoices = useCallback(async ({ silent = false, targetPage } = {}) => {
    // Line items only exist once a phase card and an invoice card were opened.
    if (!selectedPhase || !selectedInvoice) return;
    if (!silent) setRowsLoading(false);
    setRowsError("");
    const pageToFetch = targetPage ?? page;
    try {
      // Card scope first, then the toolbar's PageFilter.  The API accepts
      // repeated filterField/filterValue pairs and matches them ignoring case.
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);
      const pairs = [
        ["phase", selectedPhase],
        ["invoice", selectedInvoice],
      ];
      if (pageFilter.field && pageFilter.value !== "") {
        pairs.push([pageFilter.field, String(pageFilter.value)]);
      }
      pairs.forEach(([field, value]) => {
        params.append("filterField", field);
        params.append("filterValue", value);
      });

      const res = await api.get(`${API_BASE_URL}/invoices?${params.toString()}`);
      if (!res.data.success) {
        throw new Error(res.data.message || "Failed to load Invoices");
      }
      setRows(res.data.invoices || []);
      setFilterOptions(res.data.filterOptions || {});
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
  }, [page, pageSize, query, pageFilter, selectedPhase, selectedInvoice]);

  const scopeKey = `${selectedPhase || ""}::${selectedInvoice || ""}`;
  const filterKey = `${query.trim()}::${pageFilter.field}::${pageFilter.value}`;

  // Scope / filter / page-size changes all refetch; a changed scope or filter
  // also jumps back to page 1 so the user never lands on an empty page.
  useEffect(() => {
    if (!selectedPhase || !selectedInvoice) return;
    setPage(1);
    fetchInvoices({ targetPage: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, filterKey, pageSize]);

  useEffect(() => {
    if (!selectedPhase || !selectedInvoice) return;
    fetchInvoices({ targetPage: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const resetFilters = () => {
    setQuery("");
    setPageFilter({ field: "", value: "" });
    setPage(1);
    setSelectMode(false);
    setSelectedIds(new Set());
    setMenuOpen(false);
  };

  // Drill-down order: phase -> invoice -> line items.
  const openPhase = (phase) => {
    setSelectedPhase(phase);
    setSelectedInvoice(null);
    resetFilters();
  };

  const openInvoice = (invoice) => {
    setSelectedInvoice(invoice);
    resetFilters();
  };

  const backFromInvoice = () => {
    setSelectedInvoice(null);
    resetFilters();
  };

  const backFromPhase = () => {
    setSelectedInvoice(null);
    setSelectedPhase(null);
    resetFilters();
  };

  // Mutations refresh the phase cards, and the table too when it is open.
  const refreshData = useCallback(
    async (opts) => {
      await fetchPhaseCards();
      if (selectedPhase && selectedInvoice && opts) await fetchInvoices(opts);

      // The open view modal keeps its own copy, so a file deleted from the
      // attachment manager would still be listed there.
      if (viewOpen && viewRow?.id) {
        try {
          const res = await api.get(`${API_BASE_URL}/invoices/${viewRow.id}`);
          if (res.data?.success) setViewRow(res.data.invoice);
        } catch {
          /* the modal keeps its copy if the refresh fails */
        }
      }
    },
    [fetchPhaseCards, fetchInvoices, selectedPhase, selectedInvoice, viewOpen, viewRow]
  );

  // A save anywhere on this scope arrives as a WebSocket notice: refresh the
  // phase cards and, when a drill-down is open, the table beneath it.  The
  // view modal refreshes its own copy (handled above), but nothing runs while
  // a form or a bulk delete is in progress.
  useRealtime(["invoices"], () => refreshData({ silent: true }), {
    guard: () => !(modalOpen || saving || bulkDeleting),
  });

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
 
  // Search and PageFilter now run on the server (so paging and counts describe
  // the same rows), but keep this local pass as a cheap double-check: it also
  // makes the case-insensitive comparison identical to the API's.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, INVOICE_FILTER_FIELDS);
    });
  }, [query, rows, pageFilter]);
 
  // The PageFilter dropdown draws its options from the whole collection, so a
  // narrow page never makes the other values disappear.
  const filterOptionRows = useMemo(() => {
    const byField = {};
    Object.entries(filterOptions).forEach(([field, values]) => {
      byField[field] = (values || []).map((value) => ({ [field]: value }));
    });
    return byField;
  }, [filterOptions]);
 
const openAddModal = () => {
    setIsEditMode(false);
    initialFormValuesRef.current = emptyInvoiceForm;
    initialItemDraftsRef.current = [];
    initialAttachmentsRef.current = [];
    setFormValues(emptyInvoiceForm);
    setItemDrafts([]);
    setInvoiceAttachments([]);
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
      attachments: attachmentsOf(row),
    };
    initialFormValuesRef.current = initialValues;
    setFormValues(initialValues);
    // Edit uses the same item blocks as Add, so the saved line becomes Item 1
    // and "Add item" can extend the invoice with further lines.
    const savedLine = {
      id: row.id,
      po: initialValues.po,
      code: initialValues.code,
      desc: initialValues.desc,
      qtyInv: initialValues.qtyInv,
      qtyRecv: initialValues.qtyRecv,
      verifiedBy: initialValues.verifiedBy,
    };
    setItemDrafts([savedLine]);
    initialItemDraftsRef.current = [savedLine];
    setInvoiceAttachments(initialValues.attachments);
    initialAttachmentsRef.current = initialValues.attachments;
    setFormError("");
    setClosing(false);
    setModalOpen(true);

    // List rows only advertise that files exist.  Fetch them so the editor shows
    // the current attachments - otherwise saving would wipe what never loaded.
    if (row?.hasImage && row?.id) {
      api
        .get(`${API_BASE_URL}/invoices/${row.id}`)
        .then((res) => {
          if (!res.data?.success) return;
          const files = attachmentsOf(res.data.invoice);
          if (!files.length) return;
          setInvoiceAttachments(files);
          initialAttachmentsRef.current = files;
          setFormValues((current) =>
            current.id === row.id ? { ...current, attachments: files } : current
          );
          initialFormValuesRef.current = { ...initialFormValuesRef.current, attachments: files };
        })
        .catch(() => {
          /* attachments are optional; the rest of the form still works */
        });
    }
  };
 
  const requestClose = async (skipConfirmation = false) => {
    if (closing) return;
    const dirty =
      JSON.stringify(formValues) !== JSON.stringify(initialFormValuesRef.current) ||
      JSON.stringify(itemDrafts) !== JSON.stringify(initialItemDraftsRef.current) ||
      JSON.stringify(invoiceAttachments) !== JSON.stringify(initialAttachmentsRef.current);
    if (skipConfirmation !== true && dirty) {
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
      setItemDrafts([]);
      setInvoiceAttachments([]);
      setFormError("");
      setIsEditMode(false);
    }, 220);
  };
 
  const handleFormChange = (event) => {
    const { name, value } = event.target;
    // Editing clears a stale "cannot save yet" banner instead of leaving it
    // sitting above fields that are already correct.
    setFormError("");
    // The files belong to one invoice number, so a new number starts without
    // them instead of silently inheriting the previous invoice's files.
    if (name === "invoice" && value.trim() !== String(formValues.invoice || "").trim()) {
      setInvoiceAttachments([]);
    }
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

  // Item codes belong to the PO picked inside each item block, so the option
  // list is derived per item rather than from the (now unused) header PO.
const itemCodeOptionsForPo = useCallback((po) => invoicePoLines
    .filter((line) => line.po === po && line.code)
    .map((line) => ({ value: line.code, label: line.desc ? `${line.code}  ${line.desc}` : line.code })),
  [invoicePoLines]);

  const handlePhaseSelect = (value) => {
    const phase = boqPhases.find((item) => `${item.modelId}::${item.phaseId}` === value);
    setFormError("");
    setFormValues((prev) => ({ ...prev, modelId: phase?.modelId || "", phaseId: phase?.phaseId || "",
      phase: phase?.phaseName || "" }));
    // Existing items point at PO lines of the previous phase.
    setItemDrafts([]);
  };

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };
 
  // ---------- View modal open/close ----------
  const openView = (row) => {
    setViewRow(row);
    setViewClosing(false);
    setViewOpen(true);
    setMenuOpen(false);

    // List rows only advertise that files exist; pull them for the preview.
    if (row?.hasImage && row?.id) {
      api
        .get(`${API_BASE_URL}/invoices/${row.id}`)
        .then((res) => {
          if (!res.data?.success) return;
          const files = attachmentsOf(res.data.invoice);
          if (!files.length) return;
          setViewRow((current) =>
            current && current.id === row.id ? { ...current, attachments: files } : current
          );
        })
        .catch(() => {
          /* attachments are optional; the rest of the modal still works */
        });
    }
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
  // ---------- Item blocks (one per invoice line, added on demand) ----------

  const addItemDraft = () => {
    setItemDrafts((previous) => [...previous, nextInvoiceLineForm(formValues)]);
    window.requestAnimationFrame(() => {
      lastItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const removeItemDraft = (index) => {
    setItemDrafts((previous) => previous.filter((_, position) => position !== index));
  };

  // The field name is passed explicitly: the inputs use indexed `name`
  // attributes (qtyInv-0) which must not leak into the stored draft.
  const handleItemChange = (index, field, value) => {
    setFormError("");
    setItemDrafts((previous) =>
      previous.map((draft, position) => (position === index ? { ...draft, [field]: value } : draft))
    );
  };

  // Item Code and Description are driven by the PO line picked in the block.
  const handleItemPoSelect = (index, po) => {
    setFormError("");
    setItemDrafts((previous) =>
      previous.map((draft, position) =>
        position === index ? { ...draft, po, code: "", desc: "" } : draft
      )
    );
  };

  const handleItemDraftCodeSelect = (index, code) => {
    const item = invoicePoLines.find(
      (line) => line.po === itemDrafts[index]?.po && line.code === code
    );
    setItemDrafts((previous) =>
      previous.map((draft, position) =>
        position === index ? { ...draft, code, desc: item?.desc || "" } : draft
      )
    );
  };

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

    // Editing keeps the Add form's shape: header above, one block per line below.
    // A block that was loaded from the server is updated; a block added with
    // "Add item" is posted as a new line of the same invoice.
    if (isEditMode) {
      if (!itemDrafts.length) {
        reportSaveBlocked('Add at least one item with the "Add item" button in the header.');
        return;
      }

      const header = {
        invoice: formValues.invoice,
        date: formValues.date,
        modelId: formValues.modelId,
        phaseId: formValues.phaseId,
        phase: formValues.phase,
      };
      const lines = itemDrafts.map((draft) => ({ ...draft, ...header }));
      for (let index = 0; index < lines.length; index += 1) {
        const error = validateInvoiceForm(lines[index]);
        if (error) {
          reportSaveBlocked(`Item ${index + 1}: ${error}`);
          return;
        }
      }

      setSaving(true);
      setFormError("");
      try {
        let added = 0;
        for (const line of lines) {
          const res = line.id
            ? await api.put(`${API_BASE_URL}/invoices/${line.id}`, line)
            : await api.post(`${API_BASE_URL}/invoices`, line);
          if (!res.data.success) throw new Error(res.data.message || "Failed to save Invoice");
          if (!line.id) added += 1;
        }

        // The files belong to the invoice number, not to a single line.
        if (invoiceAttachments.length) {
          const headerRes = await api.post(`${API_BASE_URL}/invoices/header`, {
            invoice: formValues.invoice,
            date: formValues.date,
            phase: formValues.phase,
            attachments: invoiceAttachments,
          });
          if (!headerRes.data.success) {
            throw new Error(headerRes.data.message || "Failed to save invoice attachments");
          }
        }

        setSaving(false);
        requestClose(true);
        await swalSuccess(
          "Invoice Updated",
          added
            ? `The invoice was updated and ${added} new line${added === 1 ? "" : "s"} added.`
            : "The Invoice has been updated successfully."
        );
        await refreshData({ silent: true, targetPage: page });
      } catch (err) {
        setSaving(false);
        reportSaveBlocked(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
      }
      return;
    }

    if (!itemDrafts.length) {
      reportSaveBlocked('Add at least one item with the "Add item" button in the header.');
      return;
    }

    // Every line carries the invoice header plus its own item fields.  The
    // header is merged last, on purpose: a draft created before the header was
    // filled in holds empty `invoice`/`date`/`phase` keys, and letting those win
    // wiped the header out of every line.
    const header = {
      invoice: formValues.invoice,
      date: formValues.date,
      modelId: formValues.modelId,
      phaseId: formValues.phaseId,
      phase: formValues.phase,
    };
    const lines = itemDrafts.map((draft) => ({ ...draft, ...header }));
    for (let index = 0; index < lines.length; index += 1) {
      const error = validateInvoiceForm(lines[index]);
      if (error) {
        reportSaveBlocked(`Item ${index + 1}: ${error}`);
        return;
      }
    }

    setSaving(true);
    setFormError("");

    try {
      for (const line of lines) {
        const res = await api.post(`${API_BASE_URL}/invoices`, line);
        if (!res.data.success) throw new Error(res.data.message || "Failed to save Invoice");
      }

      // The invoice's files are stored once against its number, not on each
      // of its item lines.
      if (invoiceAttachments.length) {
        const headerRes = await api.post(`${API_BASE_URL}/invoices/header`, {
          invoice: formValues.invoice,
          date: formValues.date,
          phase: formValues.phase,
          attachments: invoiceAttachments,
        });
        if (!headerRes.data.success) {
          throw new Error(headerRes.data.message || "Failed to save invoice attachments");
        }
      }

      setSaving(false);

      if (startAnother) {
        const nextValues = nextInvoiceLineForm(formValues);
        initialFormValuesRef.current = nextValues;
        setFormValues(nextValues);
        setItemDrafts([]);
        setInvoiceAttachments([]);
      } else {
        requestClose(true);
      }

      await swalSuccess(
        "Invoice Saved",
        `${lines.length} invoice line${lines.length === 1 ? "" : "s"} saved successfully.`
      );

      // A new invoice number (or a different phase) is not part of the open
      // table, so the view steps back to the phase cards where it now lives.
      const sameScope =
        !selectedInvoice ||
        (String(formValues.invoice).trim().toLowerCase() ===
          String(selectedInvoice).trim().toLowerCase() &&
          String(formValues.phase).trim().toLowerCase() ===
            String(selectedPhase).trim().toLowerCase());

      if (!sameScope) {
        setSelectedInvoice(null);
        setSelectedPhase(null);
        resetFilters();
        await fetchPhaseCards();
        return;
      }

      await refreshData({ silent: true, targetPage: page });
    } catch (err) {
      setSaving(false);
      reportSaveBlocked(extractErrorMessage(err, "Something went wrong while saving. Please try again."));
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
      await refreshData({ silent: true, targetPage: rows.length === 1 && page > 1 ? page - 1 : page });
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
      await refreshData({ silent: true, targetPage: rows.length === deletedCount && page > 1 ? page - 1 : page });
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
 
  const selectedPhaseCard = useMemo(
    () =>
      phaseCards.find(
        (card) => String(card.phase).toLowerCase() === String(selectedPhase || "").toLowerCase()
      ) || null,
    [phaseCards, selectedPhase]
  );
 
  const viewTitle = !selectedPhase
    ? "Invoices"
    : !selectedInvoice
      ? selectedPhase
      : `${selectedPhase} · ${selectedInvoice}`;
 
  return (
    <div className="invoices-page">
      <div className="invoices-toolbar">
        <div className="invoices-toolbar-left">
          {selectedPhase && (
            <button
              type="button"
              className="invoices-back-btn"
              onClick={selectedInvoice ? backFromInvoice : backFromPhase}
            >
              <ArrowLeft size={16} /> Back
            </button>
          )}
          <h2 className="model-heading invoices-heading">{viewTitle}</h2>
        </div>
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
              {/* Adding an invoice must work from any drill-down level. */}
              <button type="button" className="invoices-add-btn" onClick={openAddModal}>
                <Plus size={18} />
                Add Invoice
              </button>
              {selectedInvoice && (
                <button type="button" className="invoices-delete-btn" onClick={toggleSelectMode}>
                  <Trash2 size={16} /> Delete
                </button>
              )}
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
                  {selectedInvoice && (
                    <button type="button" className="invoices-menu-item" onClick={toggleSelectMode}>
                      <Trash2 size={16} /> Delete
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
 
      {!selectedPhase ? (
        cardsLoading ? (
          <div className="invoices-loading">
            <Loader2 size={28} className="spin" />
            <span>Loading phase cards...</span>
          </div>
        ) : cardsError ? (
          <div className="invoices-load-error">
            <div className="invoices-load-error-actions">
              <span>{cardsError}</span>
              <button type="button" className="invoices-btn-secondary" onClick={fetchPhaseCards}>
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          </div>
        ) : phaseCards.length === 0 ? (
          <div className="invoices-empty-state">
            <span>No Invoices yet. Click "Add Invoice" to create the first record.</span>
          </div>
        ) : (
          <div className="model-grid">
            {phaseCards.map((card) => (
              <button
                key={card.phase}
                type="button"
                className="model-card invoices-card"
                onClick={() => openPhase(card.phase)}
              >
                <div className="model-card-heading-row">
                  <div className="model-card-icon">
                    <GitBranch size={18} />
                  </div>
                  <span className="model-card-name">{card.phase}</span>
                </div>
                {card.date && <span className="model-card-time">{formatDate(card.date)}</span>}
                <span className="invoices-card-meta">
                  {card.rowCount} line{card.rowCount === 1 ? "" : "s"} · {card.invoices.length}{" "}
                  invoice{card.invoices.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        )
      ) : !selectedInvoice ? (
        selectedPhaseCard && selectedPhaseCard.invoices.length > 0 ? (
          <div className="model-grid">
            {selectedPhaseCard.invoices.map((invoice) => (
              <button
                key={invoice.invoice}
                type="button"
                className="model-card invoices-card"
                onClick={() => openInvoice(invoice.invoice)}
              >
                <div className="model-card-heading-row">
                  <div className="model-card-icon">
                    <FileText size={18} />
                  </div>
                  <span className="model-card-name">{invoice.invoice}</span>
                </div>
                {invoice.date && <span className="model-card-time">{formatDate(invoice.date)}</span>}
                <span className="invoices-card-meta">
                  {invoice.rowCount} line{invoice.rowCount === 1 ? "" : "s"}
                  {invoice.po ? ` · PO ${invoice.po}` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="invoices-empty-state">
            <span>No invoices found for phase {selectedPhase}.</span>
          </div>
        )
      ) : (
      <>
      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <SearchBar value={query} onChange={setQuery} placeholder="Search Invoices..." />
            <PageFilter rows={filterOptionRows} fields={INVOICE_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          </div>
          <div className="table-controls-right">
            <ImageStrip
              rows={filteredRows}
              endpoint={`${API_BASE_URL}/invoices/images`}
              updateEndpoint={`${API_BASE_URL}/invoices`}
              attachmentsEndpoint={`${API_BASE_URL}/invoices/attachments`}
              labelOf={(row) => `${row.invoice || "Invoice"} · ${row.code || ""}`.trim()}
              scopeLabel="Invoice"
              onChanged={() => refreshData({ silent: true, targetPage: page })}
              onError={setRowsError}
            />
            <ExportPdfButton
              mode="table"
              title="Invoices"
              columns={columns}
              rows={filteredRows}
            />
          </div>
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
              <div className="modal-header-actions">
                {/* In the header, so adding a line never needs a scroll. */}
                <button
                  type="button"
                  className="invoices-add-item-btn"
                  onClick={addItemDraft}
                  disabled={saving}
                  title="Add another item to this invoice"
                >
                  <Plus size={15} /> Add item
                </button>
                <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
                  <X size={22} />
                </button>
              </div>
            </div>
 
            <form
              className="invoices-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
            >
              {formError && <div className="invoices-form-error">{formError}</div>}

              {/* ---- Invoice header: shared by every item below ---- */}
              <div className="invoices-form-grid invoices-header-grid">
                <label className="invoices-field">
                  <span>Invoice No <span className="invoices-required-asterisk">*</span></span>
                  <input
                    name="invoice"
                    value={formValues.invoice}
                    onChange={handleFormChange}
                    placeholder="e.g. INV-2201"
                    readOnly={isEditMode}
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
                    disabled={isEditMode}
                  />
                </label>
              </div>

              {/* ---- Items: one card per line, the same in Add and Edit ---- */}
              <>
                  <div className="invoices-items-bar">
                    <span className="invoices-items-bar-label">
                      Items
                      <span className="invoices-items-count">{itemDrafts.length}</span>
                    </span>
                  </div>

                  {itemDrafts.length === 0 && (
                    <div className="invoices-items-empty">No items yet — use the &ldquo;Add item&rdquo; button in the header above.</div>
                  )}

                  {itemDrafts.map((draft, index) => (
                    <section
                      className="boq-item-card"
                      key={`item-${index}`}
                      ref={index === itemDrafts.length - 1 ? lastItemRef : null}
                    >
                      <div className="boq-item-card-header">
                        <span className="boq-item-number">
                          Item {index + 1}
                          {draft.code ? ` · ${draft.code}` : ""}
                        </span>
                        <div className="boq-item-card-actions">
                          {/* A line that already exists is only removed from
                              the table, never silently dropped by the form. */}
                          {!(isEditMode && draft.id) && (
                            <button
                              type="button"
                              className="icon-btn boq-item-remove"
                              onClick={() => removeItemDraft(index)}
                              aria-label={`Remove item ${index + 1}`}
                              title="Remove this item"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="invoices-form-grid">
                        <label className="invoices-field">
                          <span>PO No <span className="invoices-required-asterisk">*</span></span>
                          <SearchableSelect
                            options={poOptions}
                            value={draft.po}
                            onChange={(po) => handleItemPoSelect(index, po)}
                            placeholder={formValues.phaseId ? "Select PO No" : "Select Phase first"}
                            disabled={!formValues.phaseId}
                            loading={invoicePoLinesLoading}
                            emptyMessage={invoicePoLinesError || "No PO numbers found for this phase"}
                          />
                        </label>

                        <label className="invoices-field">
                          <span>Item Code <span className="invoices-required-asterisk">*</span></span>
                          <SearchableSelect
                            options={itemCodeOptionsForPo(draft.po)}
                            value={draft.code}
                            onChange={(code) => handleItemDraftCodeSelect(index, code)}
                            placeholder={draft.po ? "Select Item Code" : "Select PO No first"}
                            disabled={!draft.po}
                            loading={invoicePoLinesLoading}
                            emptyMessage={invoicePoLinesError || "No item codes found for this PO"}
                          />
                        </label>

                        <label className="invoices-field invoices-field-span2">
                          <span>Item Description <span className="invoices-required-asterisk">*</span></span>
                          <input
                            name={`desc-${index}`}
                            value={draft.desc}
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
                            name={`qtyInv-${index}`}
                            value={draft.qtyInv}
                            onChange={(event) => handleItemChange(index, "qtyInv", event.target.value)}
                            placeholder="e.g. 100"
                          />
                        </label>

                        <label className="invoices-field">
                          <span>Qty Received <span className="invoices-required-asterisk">*</span></span>
                          <input
                            type="number"
                            min="0"
                            name={`qtyRecv-${index}`}
                            value={draft.qtyRecv}
                            onChange={(event) => handleItemChange(index, "qtyRecv", event.target.value)}
                            placeholder="e.g. 100"
                          />
                        </label>

                        <label className="invoices-field">
                          <span>Verified By <span className="invoices-required-asterisk">*</span></span>
                          <input
                            name={`verifiedBy-${index}`}
                            value={draft.verifiedBy}
                            onChange={(event) => handleItemChange(index, "verifiedBy", event.target.value)}
                            placeholder="e.g. A. Sharma"
                          />
                        </label>
                      </div>
                    </section>
                  ))}

                  {/* One attachments section for the whole invoice number, not
                      one per item line. */}
                  <div className="invoices-level-attachments">
                    <AttachmentsEditor
                      files={invoiceAttachments}
                      onChange={setInvoiceAttachments}
                      label="Attach invoice files"
                      uploadEndpoint={`${API_BASE_URL}/invoices/attachments/upload`}
                      compact
                      disabled={saving}
                    />
                  </div>
              </>
            </form>
 
            <div className="modal-footer">
              <button type="button" className="invoices-btn-secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              {/* Not disabled by an "is the form complete" check: a greyed-out
                  button just does nothing when a field is missing. handleSave
                  reports what is missing instead. */}
              <button
                type="button"
                className="invoices-btn-primary"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {saving ? "Saving..." : isEditMode ? "Update" : "Save & Close"}
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

              {attachmentsOf(viewRow).length > 0 && (
                <section className="invoices-details-section">
                  <h3>Attachments</h3>
                  <AttachmentsEditor compact readOnly files={attachmentsOf(viewRow)} />
                </section>
              )}
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
 
