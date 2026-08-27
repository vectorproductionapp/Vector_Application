import React, { useEffect, useState, useRef } from "react";
import api from "../components/Api";
import Swal from "sweetalert2";
import { Plus, Layers, Pencil, Trash2, X, Check, MoreVertical } from "lucide-react";
import CreateEntityModal from "../components/CreateEntityModal";
import Phase from "./Phase";
import { useAuth } from "../context/Auth";
import "./Model.css";

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

export default function Model() {
  const { role } = useAuth();
  const canManageModels = role === "admin";
  const [models, setModels] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [activeModel, setActiveModel] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const loadModels = async () => {
    setLoading(false);
    setError("");

    try {
      const response = await api.get(`${API_BASE_URL}/models`, { __vectorSuppressLoader: true });
      if (response.data.success) {
        setModels(response.data.models || []);
      } else {
        setError(response.data.message || "Failed to load models");
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load models");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

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

  const handleCreateModel = async ({ name }) => {
    const normalizedName = name.trim().toLowerCase();
    if (models.some((model) => model.name?.trim().toLowerCase() === normalizedName)) {
      setError("Model already exists");
      swalError("Model already exists", `A model named "${name}" already exists.`);
      return false;
    }

    try {
      const response = await api.post(`${API_BASE_URL}/models`, { name });
      if (response.data.success) {
        await loadModels();
        swalSuccess("Model created", `"${name}" has been created.`);
        return true;
      } else {
        const message = response.data.message || "Failed to create model";
        setError(message);
        swalError("Create failed", message);
        return false;
      }
    } catch (err) {
      const message = err.response?.data?.message || "Failed to create model";
      setError(message);
      swalError("Create failed", message);
      return false;
    }
  };

  const handleRenameModel = async (m) => {
    const { value: newName } = await Swal.fire({
      title: "Rename Model",
      input: "text",
      inputLabel: "New name",
      inputValue: m.name,
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
    if (!newName || newName.trim() === m.name) return;

    try {
      const res = await api.put(`${API_BASE_URL}/models/${m.id}`, { name: newName.trim() });
      if (res.data.success) {
        await loadModels();
        swalSuccess("Model renamed", `"${m.name}" â†’ "${newName.trim()}"`);
      } else {
        swalError("Rename failed", res.data.message || "Failed to rename model");
      }
    } catch (err) {
      swalError("Rename failed", err.response?.data?.message || "Something went wrong");
    }
  };

  const openModal = () => {
    setError("");
    setShowModal(true);
    setMenuOpen(false); // closes menu since a modal opens instead
  };

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
    if (selectedIds.size === models.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(models.map((m) => m.id)));
    }
    // menu stays open so you can immediately hit Delete next
  };

  const handleCardClick = (m) => {
    if (selectMode) {
      toggleSelectOne(m.id);
    } else {
      setActiveModel(m);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    const result = await swalConfirm({
      title: "Delete selected models?",
      text: `Delete ${selectedIds.size} selected model(s), including all phases, BOQs, PO details, and invoices? This cannot be undone.`,
    });
    if (!result.isConfirmed) return;

    setDeleting(true);
    setError("");

    try {
      const response = await api.post(`${API_BASE_URL}/models/bulk-delete`, {
        ids: Array.from(selectedIds),
      });
      if (response.data.success) {
        const deletedCount = response.data.deleted?.length || 0;
        const failedCount = response.data.failed?.length || 0;
        await loadModels();
        setSelectMode(false);
        setSelectedIds(new Set());
        setMenuOpen(false); // close menu only after delete actually completes
        if (failedCount > 0) {
          swalError("Some models were not deleted", `${deletedCount} removed, ${failedCount} failed.`);
        } else {
          swalSuccess("Models deleted", `${deletedCount} model(s) removed from the backend.`);
        }
      } else {
        const message = response.data.message || "Failed to delete models";
        setError(message);
        swalError("Delete failed", message);
      }
    } catch (err) {
      const message = err.response?.data?.message || "Failed to delete models";
      setError(message);
      swalError("Delete failed", message);
    } finally {
      setDeleting(false);
    }
  };

  if (activeModel) {
    return (
      <Phase
        model={activeModel}
        readOnly={!canManageModels}
        onBack={() => setActiveModel(null)}
      />
    );
  }

  const allSelected = models.length > 0 && selectedIds.size === models.length;

  return (
    <div className={`model-page${canManageModels ? "" : " model-readonly"}`}>
      <div className="model-toolbar">
        <h2 className="model-heading">Models</h2>
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
                <Plus size={16} /> Create Model
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
                    <Plus size={16} /> Create Model
                  </button>
                  <button type="button" className="model-menu-item" onClick={toggleSelectMode}>
                    <Trash2 size={16} /> Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="model-error">{error}</p>}

      {loading && <p className="page-loading">Loading models...</p>}

      <div className="model-grid">
        {models.map((m) => (
          <button
            key={m.id}
            className={`model-card${selectMode ? " model-card-select-mode" : ""}${selectMode && selectedIds.has(m.id) ? " model-card-selected" : ""}`}
            onClick={() => handleCardClick(m)}
          >
            {selectMode && (
              <input
                type="checkbox"
                className="model-card-checkbox"
                checked={selectedIds.has(m.id)}
                onChange={() => toggleSelectOne(m.id)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {!selectMode && <span
              className="model-card-edit"
              onClick={(e) => {
                e.stopPropagation();
                handleRenameModel(m);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); handleRenameModel(m); } }}
              aria-label="Rename model"
            >
              <Pencil size={14} />
            </span>}
            <div className="model-card-heading-row">
              <div className="model-card-icon">
                <Layers size={18} />
              </div>
              <span className="model-card-name">{m.name}</span>
            </div>
            {m.date && (
              <span className="model-card-time">
                {new Date(m.date).toLocaleString("en-IN", {
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
          title="Create Model"
          namePlaceholder="e.g. VE-PC-G3"
          onClose={() => setShowModal(false)}
          onCreate={handleCreateModel}
          showTiming={false}
        />
      )}
    </div>
  );
}
