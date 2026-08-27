import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import api from "../components/Api";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import { Plus, Pencil, Trash2, ArrowLeft, ClipboardList, X, Save, Loader2, MoreVertical, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import DataTable from "../components/DataTable";
import ExportPdfButton from "../components/ExportPdfButton";
import { fmtINR } from "../data/mockData";
import "../components/CreateEntityModal.css";
import "./Model.css";
import "./Boq.css";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const PAGE_SIZE = 10;

// These catalogues are shared by every BOQ editor opened in this browser tab.
// They change rarely, so reusing them avoids a Firestore request every time a
// user opens Edit BOQ.
let itemCodesCache = null;
let itemCodesRequest = null;
let suppliersCache = null;
let suppliersRequest = null;
const CREATE_NEW_ITEM_CODE = "__create_new_item_code__";

// ---- Themed SweetAlert2 helpers (brand colors, shared across this page) ----
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
    customClass: { popup: "swal-vector-popup" },
  });

const swalSuccess = (title, text) =>
  Swal.fire({
    title,
    text,
    icon: "success",
    confirmButtonColor: "var(--accent)",
    timer: 2200,
    timerProgressBar: true,
    customClass: { popup: "swal-vector-popup" },
  });

const swalError = (title, text) =>
  Swal.fire({
    title,
    text,
    icon: "error",
    confirmButtonColor: "var(--accent)",
    customClass: { popup: "swal-vector-popup" },
  });

const BOQ_COLUMNS = [
  { key: "phase", label: "Phase" },
  { key: "code", label: "Item Code", mono: true },
  { key: "desc", label: "Item Description" },
  { key: "make", label: "Make" },
  { key: "model", label: "Linked Model" },
  { key: "uom", label: "UOM" },
  { key: "reqQty", label: "Req. Qty / Unit" },
  { key: "minStock", label: "Min Stock (Buffer)" },
  { key: "minStockQty", label: "Min Stock Qty (Buffer)" },
  { key: "vendor", label: "Vendor" },
  { key: "rate", label: "Unit Rate (INR)", format: fmtINR },
  { key: "materialCost", label: "Material Cost / Unit (INR)", format: fmtINR },
  { key: "remarks", label: "Remarks" },
];
const BOQ_FILTER_FIELDS = BOQ_COLUMNS.filter((column) => ["phase", "make", "model", "uom", "vendor"].includes(column.key));

// Recomputes the auto-calculated fields for a single row
const withCalculatedFields = (row) => {
  const reqQty = Number(row.reqQty) || 0;
  const minStock = Number(row.minStock) || 0;
  const rate = Number(row.rate) || 0;

  return {
    ...row,
    minStockQty: reqQty && minStock ? reqQty * minStock : 0,
    materialCost: rate && reqQty ? rate * reqQty : 0,
  };
};

const emptyRow = (phaseName = "", itemCode = "", itemCodeId = "") =>
  withCalculatedFields({
    phase: phaseName,
    // A Phase Item Code is inherited so users do not have to enter it again.
    code: itemCode,
    itemCodeId,
    desc: "",
    make: "",
    model: "",
    uom: "",
    reqQty: "",
    minStock: "",
    vendor: "",
    rate: "",
    remarks: "",
  });

function BoqEditorModal({ phaseName, phaseItemCode = "", phaseItemCodeId = "", rows, onClose, onSave }) {
  const initialDraftRows = useMemo(
    () => rows.length ? rows.map(withCalculatedFields) : [emptyRow(phaseName, phaseItemCode, phaseItemCodeId)],
    [phaseName, phaseItemCode, phaseItemCodeId, rows]
  );
  const [draftRows, setDraftRows] = useState(initialDraftRows);
  const [savedRows, setSavedRows] = useState(initialDraftRows);
  const [closing, setClosing] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingRowIndex, setSavingRowIndex] = useState(null);
  const [error, setError] = useState("");
  const [itemCodes, setItemCodes] = useState([]);
  const [itemCodesLoading, setItemCodesLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);

  useEffect(() => {
    setDraftRows(initialDraftRows);
    setSavedRows(initialDraftRows);
  }, [initialDraftRows]);

  // The catalog endpoint also performs a safe, one-time backfill of codes
  // created by earlier versions of the BOQ form.
  useEffect(() => {
    let cancelled = false;

    const loadItemCodes = async () => {
      setItemCodesLoading(true);
      try {
        if (!itemCodesCache) {
          itemCodesRequest ||= api.get(`${API_BASE_URL}/item-codes`, { __vectorBackground: true })
            .then((response) => {
              if (!response.data.success) throw new Error(response.data.message || "Failed to load Item Codes");
              itemCodesCache = response.data.itemCodes || [];
              return itemCodesCache;
            })
            .finally(() => { itemCodesRequest = null; });
          await itemCodesRequest;
        }

        // Codes are only created from the explicit action in the dropdown.
        // This avoids reserving unused codes just by opening Add/Edit BOQ.
        if (!cancelled) setItemCodes(itemCodesCache);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || err.message || "Failed to load Item Codes");
      } finally {
        if (!cancelled) setItemCodesLoading(false);
      }
    };

    loadItemCodes();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSuppliers = async () => {
      try {
        if (!suppliersCache) {
          suppliersRequest ||= api.get(`${API_BASE_URL}/suppliers`, { __vectorBackground: true })
            .then((response) => {
              if (!response.data.success) throw new Error(response.data.message || "Failed to load suppliers");
              suppliersCache = response.data.suppliers || [];
              return suppliersCache;
            })
            .finally(() => { suppliersRequest = null; });
          await suppliersRequest;
        }
        if (!cancelled) setSuppliers(suppliersCache);
      } catch {
        // The field still accepts a new supplier if suggestions cannot load.
      }
    };
    loadSuppliers();
    return () => { cancelled = true; };
  }, []);

  const requestClose = async () => {
    if (closing || saving || confirmingClose) return;

    const hasUnsavedChanges = JSON.stringify(draftRows) !== JSON.stringify(initialDraftRows);
    if (hasUnsavedChanges) {
      setConfirmingClose(true);
      const result = await Swal.fire({
        title: "Discard unsaved BOQ changes?",
        text: "Your entered BOQ items will be lost unless you save them.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "Discard changes",
        cancelButtonText: "Keep editing",
        confirmButtonColor: "var(--accent)",
        cancelButtonColor: "var(--bg-surface-alt)",
        reverseButtons: true,
        focusCancel: true,
        customClass: { popup: "swal-vector-popup" },
      });
      setConfirmingClose(false);
      if (!result.isConfirmed) return;
    }

    setClosing(true);
    setTimeout(() => {
      onClose();
    }, 220);
  };

  const updateField = (rowIndex, key, value) => {
    setDraftRows((prev) =>
      prev.map((row, index) =>
        index === rowIndex ? withCalculatedFields({ ...row, [key]: value }) : row
      )
    );
  };

  const addRow = () => {
    // A phase code is useful as the first-row default. Additional materials
    // must be chosen independently so an existing/new code is never applied
    // accidentally to every row.
    setDraftRows((prev) => [...prev, emptyRow(phaseName)]);
  };

  const handleItemCodeSelect = async (rowIndex, value) => {
    setError("");
    if (value !== CREATE_NEW_ITEM_CODE) {
      const selected = itemCodes.find((item) => item.code === value);
      if (selected) {
        setDraftRows((prev) => prev.map((row, index) => index === rowIndex
          ? withCalculatedFields({ ...row, code: selected.code, itemCodeId: selected.id, desc: selected.desc || row.desc })
          : row
        ));
      }
      return;
    }

    setItemCodesLoading(true);
    try {
      const response = await api.post(`${API_BASE_URL}/item-codes/generate`);
      if (!response.data.success) throw new Error(response.data.message || "Failed to generate Item Code");
      const created = response.data.itemCode;
      const nextItemCodes = [...itemCodes, created].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      itemCodesCache = nextItemCodes;
      setItemCodes(nextItemCodes);
      updateField(rowIndex, "code", created.code);
      updateField(rowIndex, "itemCodeId", created.id);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to generate Item Code");
    } finally {
      setItemCodesLoading(false);
    }
  };

  const itemCodeOptions = itemCodes.map((item) => ({ value: item.code, label: item.code }));
  const supplierOptions = suppliers.map((supplier) => ({ value: supplier, label: supplier }));

  const removeRow = (rowIndex) => {
    setDraftRows((prev) => (prev.length === 1 ? prev : prev.filter((_, index) => index !== rowIndex)));
  };

  const handleSubmit = async () => {
    setError("");
    const cleaned = draftRows
      .map((row) => withCalculatedFields({ ...row, phase: row.phase || phaseName }))
      .filter((row) => row.desc.trim());

    if (!cleaned.length) {
      setError("Add at least one BOQ item");
      return;
    }

    if (cleaned.some((row) => !row.code)) {
      setError("Select an existing Item Code or create a new Item Code for every BOQ item");
      return;
    }

    setSaving(true);
    const ok = await onSave(cleaned);
    setSaving(false);
    if (!ok) {
      setError("Failed to save BOQ");
    }
  };

  const handleSaveItem = async (rowIndex) => {
    setError("");
    const row = withCalculatedFields({ ...draftRows[rowIndex], phase: draftRows[rowIndex].phase || phaseName });
    if (!row.desc.trim()) {
      setError(`Item ${rowIndex + 1} needs an item description before it can be saved.`);
      return;
    }
    if (!row.code) {
      setError(`Item ${rowIndex + 1} needs an Item Code before it can be saved.`);
      return;
    }

    const nextSavedRows = rowIndex < savedRows.length
      ? savedRows.map((savedRow, index) => index === rowIndex ? row : savedRow)
      : [...savedRows, row];

    setSavingRowIndex(rowIndex);
    const ok = await onSave(nextSavedRows, { keepEditorOpen: true });
    setSavingRowIndex(null);
    if (ok) setSavedRows(nextSavedRows);
    else setError(`Failed to save item ${rowIndex + 1}.`);
  };

  return createPortal(
    <div
      className={`modal-overlay${closing ? " closing" : ""}`}
      onClick={requestClose}
    >
      <div
        className={`modal-container${closing ? " closing" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={rows.length ? "Edit BOQ" : "Add BOQ"}
      >
        <div className="modal-header">
          <div>
            <h2>{rows.length ? "Edit BOQ" : "Add BOQ"}</h2>
            <p className="boq-form-subtitle">{phaseName}</p>
          </div>
          <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
            <X size={22} />
          </button>
        </div>

        <form
          className="boq-form-scroll"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          {error && <div className="boq-form-error">{error}</div>}

          {draftRows.map((row, rowIndex) => (
            <div className="boq-item-card" key={rowIndex}>
              <div className="boq-item-card-header">
                <span className="boq-item-number">Item {rowIndex + 1}</span>
                <div className="boq-item-card-actions">
                  <button
                    type="button"
                    className="boq-item-save"
                    onClick={() => handleSaveItem(rowIndex)}
                    disabled={saving || savingRowIndex !== null}
                  >
                    {savingRowIndex === rowIndex ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                    {savingRowIndex === rowIndex ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn boq-item-remove"
                    onClick={() => removeRow(rowIndex)}
                    disabled={draftRows.length === 1 || saving || savingRowIndex !== null}
                    aria-label={`Remove item ${rowIndex + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <div className="boq-field-grid">
                <label className="boq-field">
                  <span>Phase</span>
                  <input
                    value={row.phase ?? ""}
                    onChange={(e) => updateField(rowIndex, "phase", e.target.value)}
                    placeholder={phaseName}
                  />
                </label>

                <label className="boq-field">
                  <span>Item Code</span>
                  <SearchableSelect
                    options={itemCodeOptions}
                    value={row.code}
                    onChange={(value) => handleItemCodeSelect(rowIndex, value)}
                    placeholder="Select Item Code"
                    loading={itemCodesLoading}
                    emptyMessage="No existing Item Codes"
                    actionOption={{
                      value: CREATE_NEW_ITEM_CODE,
                      label: "+ Create New Item Code",
                    }}
                  />
                </label>

                <label className="boq-field boq-field-wide">
                  <span>Item Description</span>
                  <input
                    value={row.desc ?? ""}
                    onChange={(e) => updateField(rowIndex, "desc", e.target.value)}
                    placeholder="Describe the item"
                  />
                </label>

                <label className="boq-field">
                  <span>Make</span>
                  <input
                    value={row.make ?? ""}
                    onChange={(e) => updateField(rowIndex, "make", e.target.value)}
                  />
                </label>

                <label className="boq-field">
                  <span>Model</span>
                  <input
                    value={row.model ?? ""}
                    onChange={(e) => updateField(rowIndex, "model", e.target.value)}
                  />
                </label>

                <label className="boq-field">
                  <span>UOM</span>
                  <input
                    value={row.uom ?? ""}
                    onChange={(e) => updateField(rowIndex, "uom", e.target.value)}
                    placeholder="e.g. Nos, Kg, Mtr"
                  />
                </label>

                <label className="boq-field">
                  <span>Req. Qty / Unit</span>
                  <input
                    type="number"
                    min="0"
                    value={row.reqQty ?? ""}
                    onChange={(e) => updateField(rowIndex, "reqQty", e.target.value)}
                    placeholder="10"
                  />
                </label>

                <label className="boq-field">
                  <span>Min Stock (Buffer)</span>
                  <input
                    type="number"
                    min="0"
                    value={row.minStock ?? ""}
                    onChange={(e) => updateField(rowIndex, "minStock", e.target.value)}
                    placeholder="5"
                  />
                </label>

                <label className="boq-field">
                  <span>Min Stock Qty (Buffer)</span>
                  <input type="number" value={row.minStockQty ?? 0} readOnly disabled />
                </label>

                <label className="boq-field">
                  <span>Supplier Name</span>
                  <SearchableSelect
                    options={supplierOptions}
                    value={row.vendor ?? ""}
                    onChange={(value) => updateField(rowIndex, "vendor", value)}
                    placeholder="Select or enter supplier"
                    emptyMessage="Type a supplier name to add it"
                    allowCustomValue
                  />
                </label>

                <label className="boq-field">
                  <span>Unit Rate (INR)</span>
                  <input
                    type="number"
                    min="0"
                    value={row.rate ?? ""}
                    onChange={(e) => updateField(rowIndex, "rate", e.target.value)}
                    placeholder="450"
                  />
                </label>

                <label className="boq-field">
                  <span>Material Cost Per Unit (INR)</span>
                  <input type="number" value={row.materialCost ?? 0} readOnly disabled />
                </label>

                
              </div>
            </div>
          ))}

          <button type="button" className="link-btn boq-add-item-btn" onClick={addRow}>
            <Plus size={14} /> Add another item
          </button>
        </form>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="create-btn"
            onClick={handleSubmit}
            disabled={saving}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "Saving..." : "Save Overall"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function BOQ({ model, phase, modelId, phaseId, onBack, readOnly = false }) {
  const [boq, setBoq] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [editorOpen, setEditorOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const lastLoadKeyRef = useRef("");

  // ---- Row-level bulk-select / delete state (same pattern as Model.jsx) ----
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  const [deletingRows, setDeletingRows] = useState(false);

  const resolvedModelId = modelId || model?.id;
  const resolvedPhaseId = phaseId || phase?.id;
  const phaseItemCode = phase?.itemCode || "";
  const phaseItemCodeId = phase?.itemCodeId || "";
  const phaseName = phase?.name || "Phase";

  const loadBoq = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!resolvedModelId || !resolvedPhaseId) {
      setLoading(false);
      setError("Missing model or phase information");
      return;
    }

    if (!silent) setLoading(false);
    setError("");

    const pageToFetch = targetPage ?? page;

    try {
      const response = await api.get(
        `${API_BASE_URL}/models/${resolvedModelId}/phases/${resolvedPhaseId}/boq`,
        { params: { page: pageToFetch, limit: PAGE_SIZE } }
      );
      if (response.data.success) {
        const nextBoq = response.data.boq || null;
        setBoq(nextBoq);
        const pagination = nextBoq?.pagination;
        if (pagination) {
          setTotalPages(pagination.totalPages || 1);
          setTotalCount(pagination.totalCount || 0);
          if (pagination.page !== pageToFetch) setPage(pagination.page);
        } else {
          setTotalPages(1);
          setTotalCount(nextBoq?.rows?.length || 0);
        }
      } else {
        setError(response.data.message || "Failed to load BOQ");
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load BOQ");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, resolvedModelId, resolvedPhaseId]);

  useEffect(() => {
    const resourceKey = `${resolvedModelId || ""}:${resolvedPhaseId || ""}`;
    const resourceChanged = !lastLoadKeyRef.current
      || !lastLoadKeyRef.current.startsWith(`${resourceKey}:`);
    const targetPage = resourceChanged ? 1 : page;
    const loadKey = `${resourceKey}:${targetPage}`;

    if (resourceChanged && page !== 1) setPage(1);
    if (lastLoadKeyRef.current === loadKey) return;

    lastLoadKeyRef.current = loadKey;
    loadBoq({ targetPage });
  }, [loadBoq, page, resolvedModelId, resolvedPhaseId]);

  // Close the kebab menu when clicking outside it
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filterBoqRows = useCallback((rows) => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || BOQ_COLUMNS.some((column) => String(row[column.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, BOQ_FILTER_FIELDS);
    });
  }, [query, pageFilter]);

  // The table stays paginated, but exports must include every BOQ row that
  // matches the active search/filter across all pages.
  const filteredRows = useMemo(
    () => filterBoqRows(boq?.rows || []),
    [boq, filterBoqRows]
  );
  const exportRows = useMemo(
    () => filterBoqRows(boq?.allRows || boq?.rows || []),
    [boq, filterBoqRows]
  );

  const persistRows = useCallback(async (rows) => {
    if (boq?.id) {
      return api.put(
        `${API_BASE_URL}/models/${resolvedModelId}/phases/${resolvedPhaseId}/boq/${boq.id}`,
        { rows },
        { __vectorSuppressBusy: true }
      );
    }
      return api.post(
        `${API_BASE_URL}/models/${resolvedModelId}/phases/${resolvedPhaseId}/boq`,
        { rows },
        { __vectorSuppressBusy: true }
      );
  }, [boq, resolvedModelId, resolvedPhaseId]);

  // Create vs update messaging is decided *before* the save, since after
  // persistRows() succeeds boq.id will always be truthy either way.
  const handleSave = async (rows, { keepEditorOpen = false } = {}) => {
    const wasExisting = Boolean(boq?.id);
    try {
      await persistRows(rows);
      if (keepEditorOpen) {
        setBoq((current) => current ? {
          ...current,
          allRows: rows,
          rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        } : current);
      } else {
        await loadBoq({ targetPage: 1, silent: true });
        setPage(1);
      }
      if (!keepEditorOpen) setEditorOpen(false);
      swalSuccess(
        keepEditorOpen ? "BOQ item saved" : (wasExisting ? "BOQ updated" : "BOQ created"),
        wasExisting
          ? `The BOQ for ${phaseName} has been updated with ${rows.length} item(s).`
          : `The BOQ for ${phaseName} has been created with ${rows.length} item(s).`
      );
      return true;
    } catch (err) {
      const message = err.response?.data?.message || "Failed to save BOQ";
      setError(message);
      swalError("Save failed", message);
      return false;
    }
  };

  const openEditor = () => {
    setEditorOpen(true);
    setMenuOpen(false);
  };

  // ---- Row select-mode helpers ----
  const toggleSelectMode = () => {
    setSelectMode((prev) => !prev);
    setSelectedCodes(new Set());
    // menu stays open so the new options (Select All / Delete / Cancel) show right away
  };

  const toggleSelectOne = (code) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  // Select All only applies to rows currently visible (post-search), same
  // page-scoped convention used on other tables in the app.
  const visibleCodes = useMemo(
    () => filteredRows.map((r) => r.code).filter(Boolean),
    [filteredRows]
  );

  const toggleSelectAll = () => {
    if (selectedCodes.size === visibleCodes.length && visibleCodes.length > 0) {
      setSelectedCodes(new Set());
    } else {
      setSelectedCodes(new Set(visibleCodes));
    }
  };

  const handleDeleteSelectedRows = async () => {
    if (selectedCodes.size === 0 || !boq) return;

    const result = await swalConfirm({
      title: "Delete selected items?",
      text: `This removes ${selectedCodes.size} item(s) from the ${phaseName} BOQ. This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setDeletingRows(true);
    setError("");

    try {
      const remainingRows = (boq.allRows || boq.rows || []).filter((row) => !selectedCodes.has(row.code));
      await persistRows(remainingRows);
      await loadBoq({ targetPage: page, silent: true });
      setSelectMode(false);
      const deletedCount = selectedCodes.size;
      setSelectedCodes(new Set());
      setMenuOpen(false); // close menu only after delete actually completes
      swalSuccess("Items deleted", `${deletedCount} item(s) removed from the BOQ.`);
    } catch (err) {
      const message = err.response?.data?.message || "Failed to delete selected items";
      setError(message);
      swalError("Delete failed", message);
    } finally {
      setDeletingRows(false);
    }
  };

  const allSelected = visibleCodes.length > 0 && selectedCodes.size === visibleCodes.length;

  const goToPage = (nextPage) => {
    const clamped = Math.min(Math.max(nextPage, 1), totalPages);
    if (clamped === page) return;
    setPage(clamped);
  };

  // Table columns with a checkbox column prepended only while selectMode
  // is active.
  const tableColumns = useMemo(() => {
    if (!selectMode) return BOQ_COLUMNS;

    const selectColumn = {
      key: "__select",
      label: "",
      render: (row) => (
        <input
          type="checkbox"
          className="po-row-checkbox"
          checked={selectedCodes.has(row.code)}
          onChange={() => toggleSelectOne(row.code)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Select row"
        />
      ),
    };

    return [selectColumn, ...BOQ_COLUMNS];
  }, [selectMode, selectedCodes]);

  return (
    <div className={`boq-page${readOnly ? " model-readonly" : ""}`}>
      <div className="boq-toolbar">
        <div className="phase-toolbar-left">
          <button type="button" className="back-btn" onClick={onBack}>
            <ArrowLeft size={16} /> Back
          </button>
          <div>
            <h2 className="model-heading">{phaseName} BOQ</h2>
            <p className="boq-subtitle">
              {model?.name ? `${model.name} - ` : ""}
              Phase details and item breakdown
            </p>
          </div>
        </div>

        {/* Full buttons - visible on desktop, hidden on mobile via CSS */}
        <div className="boq-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="create-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="create-btn"
                onClick={handleDeleteSelectedRows}
                disabled={selectedCodes.size === 0 || deletingRows}
              >
                <Trash2 size={16} />
                {deletingRows ? "Deleting..." : `Delete (${selectedCodes.size})`}
              </button>
              <button type="button" className="create-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="create-btn" onClick={openEditor}>
                <Pencil size={16} />
                {boq ? "Edit BOQ" : "Add BOQ"}
              </button>
              {boq && boq.rows?.length > 0 && (
                <button type="button" className="btn-secondary" onClick={toggleSelectMode}>
                  <Trash2 size={16} /> Delete Rows
                </button>
              )}
            </>
          )}
        </div>

        {/* Kebab menu - visible on mobile, hidden on desktop via CSS */}
        <div className="model-kebab-wrapper" ref={menuRef}>
          <button
            type="button"
            className="model-kebab-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="More actions"
          >
            <MoreVertical size={20} />
          </button>

          {menuOpen && (
            <div className="model-kebab-menu">
              {selectMode ? (
                <>
                  <button type="button" className="model-menu-item" onClick={toggleSelectAll}>
                    <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    className="model-menu-item"
                    onClick={handleDeleteSelectedRows}
                    disabled={selectedCodes.size === 0 || deletingRows}
                  >
                    <Trash2 size={16} />
                    {deletingRows ? "Deleting..." : `Delete (${selectedCodes.size})`}
                  </button>
                  <button type="button" className="model-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="model-menu-item" onClick={openEditor}>
                    <Pencil size={16} />
                    {boq ? "Edit BOQ" : "Add BOQ"}
                  </button>
                  {boq && boq.rows?.length > 0 && (
                    <button type="button" className="model-menu-item" onClick={toggleSelectMode}>
                      <Trash2 size={16} /> Delete Rows
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="model-error">{error}</p>}
      {loading && <p className="page-loading">Loading BOQ...</p>}

      {!loading && !boq && (
        <div className="boq-empty">
          <ClipboardList size={34} />
          <h3>No BOQ added yet</h3>
          <p>{readOnly ? "No BOQ has been configured for this phase." : "Create the BOQ for this phase to start tracking rows."}</p>
        </div>
      )}

      {!loading && boq && (
        <>
          <div className="panel">
            <div className="table-controls-row">
              <div className="table-controls-primary">
                <SearchBar value={query} onChange={setQuery} placeholder="Search BOQ rows..." />
                <PageFilter rows={boq.rows || []} fields={BOQ_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
                <span className="boq-count">Showing {filteredRows.length} of {totalCount} rows</span>
              </div>
              <ExportPdfButton
                mode="table"
                title={`${phaseName} BOQ`}
                columns={BOQ_COLUMNS}
                rows={exportRows}
                fileName={`${phaseName}-boq`}
              />
            </div>
            <DataTable columns={tableColumns} rows={filteredRows} />
          </div>

          <div className="boq-pagination">
            <p className="boq-hint">
              Showing {filteredRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
              {"–"}
              {(page - 1) * PAGE_SIZE + filteredRows.length} of {totalCount} rows
            </p>

            <div className="boq-pagination-controls">
              <button
                type="button"
                className="boq-page-btn boq-page-edge"
                onClick={() => goToPage(1)}
                disabled={page === 1}
                aria-label="First page"
              >
                <ChevronsLeft size={16} />
              </button>

              {page > 1 && (
                <button
                  type="button"
                  className="boq-page-btn boq-page-nav"
                  onClick={() => goToPage(page - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                  Prev
                </button>
              )}

              <span className="boq-page-current" key={page}>{page}</span>

              {page < totalPages && (
                <button
                  type="button"
                  className="boq-page-btn boq-page-nav"
                  onClick={() => goToPage(page + 1)}
                  aria-label="Next page"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              )}

              <button
                type="button"
                className="boq-page-btn boq-page-edge"
                onClick={() => goToPage(totalPages)}
                disabled={page === totalPages}
                aria-label="Last page"
              >
                <ChevronsRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}

      {!readOnly && editorOpen && (
        <BoqEditorModal
          phaseName={phaseName}
          phaseItemCode={phaseItemCode}
          phaseItemCodeId={phaseItemCodeId}
          // The API paginates the table rows, but an edit replaces the
          // complete BOQ document. Give the editor every row so saving an
          // edit from page 1 cannot overwrite rows that are on page 2+.
          rows={boq?.allRows || boq?.rows || []}
          onClose={() => setEditorOpen(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
