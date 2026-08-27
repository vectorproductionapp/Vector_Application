import React, { useCallback, useEffect, useState, useRef } from "react";
import api from "../components/Api";
import Swal from "sweetalert2";
import { Plus, ArrowLeft, GitBranch, Pencil, Trash2, X, Check, MoreVertical } from "lucide-react";
import CreateEntityModal from "../components/CreateEntityModal";
import BOQ from "./Boq";
import "./Phase.css";

// An empty base URL uses the development proxy. This keeps the Item Code
// catalogue available even when REACT_APP_API_BASE_URL is not configured.
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

// ---- Themed SweetAlert2 helpers (brand colors, shared style across pages) ----
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

export default function Phase({ model, onBack, readOnly = false }) {
  const [showModal, setShowModal] = useState(false);
  const [phases, setPhases] = useState([]);
  const [activePhase, setActivePhase] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [itemCodes, setItemCodes] = useState([]);
  const [selectedItemCode, setSelectedItemCode] = useState("");
  const [itemCodesLoading, setItemCodesLoading] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const loadPhases = useCallback(async () => {
    setLoading(false);
    setError("");

    try {
      const response = await api.get(`${API_BASE_URL}/models/${model.id}/phases`);
      if (response.data.success) {
        setPhases(response.data.phases || []);
      } else {
        setError(response.data.message || "Failed to load phases");
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load phases");
    } finally {
      setLoading(false);
    }
  }, [model.id]);

  useEffect(() => {
    loadPhases();
  }, [loadPhases]);

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

  const handleCreatePhase = async ({ name }) => {
    try {
      const response = await api.post(`${API_BASE_URL}/models/${model.id}/phases`, {
        name,
      });
      if (response.data.success) {
        await loadPhases();
        swalSuccess("Phase created", `"${name}" has been created.`);
        return true;
      }

      const message = response.data.message || "Failed to create phase";
      setError(message);
      swalError("Create failed", message);
      return false;
    } catch (err) {
      const message = err.response?.data?.message || "Failed to create phase";
      setError(message);
      swalError("Create failed", message);
      return false;
    }
  };

  const handleRenamePhase = async (p) => {
    const { value: newName } = await Swal.fire({
      title: "Rename Phase",
      input: "text",
      inputLabel: "New name",
      inputValue: p.name,
      showCancelButton: true,
      confirmButtonColor: "var(--accent)",
      cancelButtonColor: "var(--bg-surface-alt)",
      confirmButtonText: "Rename",
      cancelButtonText: "Cancel",
      reverseButtons: true,
      inputValidator: (value) => {
        if (!value?.trim()) return "Name cannot be empty";
      },
      customClass: { popup: "swal-vector-popup" },
    });
    if (!newName || newName.trim() === p.name) return;

    try {
      const res = await api.put(
        `${API_BASE_URL}/models/${model.id}/phases/${p.id}`,
        { name: newName.trim() }
      );
      if (res.data.success) {
        await loadPhases();
        swalSuccess("Phase renamed", `"${p.name}" â†’ "${newName.trim()}"`);
      } else {
        swalError("Rename failed", res.data.message || "Failed to rename phase");
      }
    } catch (err) {
      swalError("Rename failed", err.response?.data?.message || "Something went wrong");
    }
  };

  const openModal = () => {
    setError("");
    setSelectedItemCode("");
    setShowModal(true);
    setMenuOpen(false);
    loadItemCodes();
  };

  const loadItemCodes = async () => {
    setItemCodesLoading(true);
    setError("");
    try {
      const response = await api.get(`${API_BASE_URL}/item-codes`, { __vectorBackground: true });
      if (!response.data.success) throw new Error(response.data.message || "Failed to load Item Codes");
      // Do not create a code merely by opening this dialog. The user can
      // deliberately select “Create New Item Code” from the dropdown.
      setItemCodes(response.data.itemCodes || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to load Item Codes");
    } finally {
      setItemCodesLoading(false);
    }
  };

  const createNewItemCode = async () => {
    setError("");
    setItemCodesLoading(true);
    try {
      const response = await api.post(`${API_BASE_URL}/item-codes/generate`);
      if (!response.data.success) throw new Error(response.data.message || "Failed to generate Item Code");
      const created = response.data.itemCode;
      setItemCodes((current) => [...current, created].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })));
      setSelectedItemCode(created.code);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to generate Item Code");
    } finally {
      setItemCodesLoading(false);
    }
  };

  const itemCodeOptions = itemCodes.map((item) => ({ value: item.code, label: item.code }));

  const toggleSelectMode = () => {
    setError("");
    setSelectMode((prev) => !prev);
    setSelectedIds(new Set());
    // menu stays open so the new options (Select All / Delete / Cancel) show right away
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

  const toggleSelectAll = () => {
    if (selectedIds.size === phases.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(phases.map((p) => p.id)));
    }
  };

  const handleCardClick = (p) => {
    if (selectMode) {
      toggleSelectOne(p.id);
    } else {
      setActivePhase(p);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    const result = await swalConfirm({
      title: "Delete selected phases?",
      text: `Delete ${selectedIds.size} selected phase(s), including their BOQs, PO details, and invoices? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setDeleting(true);
    setError("");

    try {
      const response = await api.post(
        `${API_BASE_URL}/models/${model.id}/phases/bulk-delete`,
        { ids: Array.from(selectedIds) }
      );
      if (response.data.success) {
        const deletedCount = selectedIds.size;
        await loadPhases();
        setSelectMode(false);
        setSelectedIds(new Set());
        setMenuOpen(false);
        swalSuccess("Phases deleted", `${deletedCount} phase(s) removed.`);
      } else {
        const message = response.data.message || "Failed to delete phases";
        setError(message);
        swalError("Delete failed", message);
      }
    } catch (err) {
      const message = err.response?.data?.message || "Failed to delete phases";
      setError(message);
      swalError("Delete failed", message);
    } finally {
      setDeleting(false);
    }
  };

  // Show BOQ page for the selected phase
  if (activePhase) {
    return (
      <BOQ
        model={model}
        phase={activePhase}
        modelId={model.id}
        phaseId={activePhase.id}
        readOnly={readOnly}
        onBack={() => setActivePhase(null)}
      />
    );
  }

  const allSelected = phases.length > 0 && selectedIds.size === phases.length;

  return (
    <div className={`phase-page${readOnly ? " model-readonly" : ""}`}>
      <div className="phase-toolbar">
        <div className="phase-toolbar-left">
          <button type="button" className="back-btn" onClick={onBack}>
            <ArrowLeft size={16} /> Back
          </button>
          <h2 className="model-heading">{model.name} - Phases</h2>
        </div>

        {/* Full buttons - visible on desktop, hidden on mobile via CSS */}
        <div className="model-toolbar-actions">
          {selectMode ? (
            <>
              <button type="button" className="create-btn" onClick={toggleSelectAll}>
                <Check size={16} /> {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="create-btn"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting}
              >
                <Trash2 size={16} />
                {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
              </button>
              <button type="button" className="create-btn" onClick={toggleSelectMode}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="create-btn" onClick={openModal}>
                <Plus size={16} /> Create Phase
              </button>
              <button type="button" className="delete-button" onClick={toggleSelectMode}>
                <Trash2 size={16} /> Delete
              </button>
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
                    onClick={handleDeleteSelected}
                    disabled={selectedIds.size === 0 || deleting}
                  >
                    <Trash2 size={16} />
                    {deleting ? "Deleting..." : `Delete (${selectedIds.size})`}
                  </button>
                  <button type="button" className="model-menu-item" onClick={toggleSelectMode}>
                    <X size={16} /> Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="model-menu-item" onClick={openModal}>
                    <Plus size={16} /> Create Phase
                  </button>
                  <button type="button" className="delete-button" onClick={toggleSelectMode}>
                    <Trash2 size={16} /> Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="model-error">{error}</p>}
      {loading && <p className="page-loading">Loading phases...</p>}

      <div className="model-grid">
        {phases.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`model-card${selectMode ? " model-card-select-mode" : ""}${selectMode && selectedIds.has(p.id) ? " model-card-selected" : ""}`}
            onClick={() => handleCardClick(p)}
          >
            {selectMode && (
              <input
                type="checkbox"
                className="model-card-checkbox"
                checked={selectedIds.has(p.id)}
                onChange={() => toggleSelectOne(p.id)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {!selectMode && <span
              className="model-card-edit"
              onClick={(e) => {
                e.stopPropagation();
                handleRenamePhase(p);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); handleRenamePhase(p); } }}
              aria-label="Rename phase"
            >
              <Pencil size={14} />
            </span>}
            <div className="model-card-heading-row">
              <div className="model-card-icon">
                <GitBranch size={18} />
              </div>
              <span className="model-card-name">{p.name}</span>
            </div>
            {p.date && (
              <span className="model-card-time">
                {new Date(p.date).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            )}
          </button>
        ))}
      </div>

      {showModal && (
        <CreateEntityModal
          title="Create Phase"
          namePlaceholder="e.g. Phase 1"
          onClose={() => setShowModal(false)}
          onCreate={handleCreatePhase}
          showTiming={false}
        />
      )}
    </div>
  );
}
