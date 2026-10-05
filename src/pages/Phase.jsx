import React, { useCallback, useEffect, useState, useRef } from "react";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import Swal from "sweetalert2";
import { Plus, ArrowLeft, GitBranch, Pencil, Trash2, X, Check, MoreVertical, FileSpreadsheet } from "lucide-react";
import CreateEntityModal from "../components/CreateEntityModal";
import BulkUploadModal from "../components/BulkUploadModal";
import BOQ from "./Boq";
import { fmtINR } from "../data/mockData";
import "./Phase.css";

// An empty base URL uses the development proxy. This keeps the Item Code
// catalogue available even when REACT_APP_API_BASE_URL is not configured.
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

// The phase this tab was drilled into, kept across a browser refresh.
const DRILL_KEY = "vector_active_phase";
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

// ---- Excel bulk upload for phases ------------------------------------
// The file carries a Phase Name column plus the BOQ columns, so one upload can
// create a phase and fill its BOQ in the same file.  Rows are grouped by the
// phase name they list.
// Excel users type money as "1200", "1,200", "₹1,200", "1200/-" or paste
// text with non-breaking spaces; raw arithmetic on those strings gives
// #VALUE!.  excelNum cleans the cell text and returns a number (or "" when
// it cannot be parsed), and excelGst normalises the GST cell (18, 18% or
// 0.18 all mean 18%) with 18% as the default.
const excelNum = (token) =>
  `IFERROR(VALUE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${token}&"",UNICHAR(160),""),"₹",""),"INR",""),"Rs.",""),"Rs","")," ",""),",",""),"/-","")),"")`;
const excelGst = (token) => {
  const n = excelNum(token);
  return `IFERROR(IF(${n}>=1,${n}/100,${n}),0.18)`;
};
const PHASE_BULK_COLUMNS = [
  { key: "phase", label: "Phase Name" },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "uom", label: "UOM" },
  { key: "reqQty", label: "Req. Qty / Unit" },
  { key: "minStock", label: "Min Stock (Buffer)" },
  { key: "minStockQty", label: "Min Stock Qty (Buffer)" },
  { key: "vendor", label: "Supplier Name" },
  { key: "rate", label: "Unit Rate (INR)" },
  { key: "gstRate", label: "GST %" },
  // Calculated in Excel from Unit Rate + GST % + Req. Qty; never imported.
  {
    key: "unitGst",
    label: "GST per Unit (INR)",
    required: false,
    formula: `IFERROR(IF(${excelNum("{rate}")}="","",ROUND(${excelNum("{rate}")}*${excelGst("{gstRate}")},2)),"")`,
  },
  {
    key: "materialCostUnit",
    label: "Material Cost per Unit incl. GST (INR)",
    required: false,
    formula: `IFERROR(IF(${excelNum("{rate}")}="","",ROUND(${excelNum("{rate}")}+ROUND(${excelNum("{rate}")}*${excelGst("{gstRate}")},2),2)),"")`,
  },
  {
    key: "lineTotalQty",
    label: "Material Cost incl. GST (Total) (INR)",
    required: false,
    formula: `IFERROR(IF(OR(${excelNum("{rate}")}="",${excelNum("{reqQty}")}=""),"",ROUND(${excelNum("{rate}")}*${excelNum("{reqQty}")}+ROUND(${excelNum("{rate}")}*${excelNum("{reqQty}")}*${excelGst("{gstRate}")},2),2)),"")`,
  },
  { key: "remarks", label: "Remarks" },
];

const PHASE_BULK_ALIASES = {
  phase: "phase",
  phasename: "phase",
  name: "phase",
  code: "code",
  itemcode: "code",
  materialcode: "code",
  partcode: "code",
  desc: "desc",
  description: "desc",
  itemdescription: "desc",
  make: "make",
  manufacturer: "make",
  brand: "make",
  model: "model",
  linkedmodel: "model",
  finishedmodel: "model",
  uom: "uom",
  unit: "uom",
  unitofmeasure: "uom",
  reqqty: "reqQty",
  reqqtyunit: "reqQty",
  reqqtyper: "reqQty",
  requiredqty: "reqQty",
  reqqtyperunit: "reqQty",
  qtyperunit: "reqQty",
  qtyunit: "reqQty",
  quantityperunit: "reqQty",
  perunitqty: "reqQty",
  minstock: "minStock",
  bufferstock: "minStock",
  minstockbuffer: "minStock",
  minstockqty: "minStockQty",
  minstockqtybuffer: "minStockQty",
  vendor: "vendor",
  vendorname: "vendor",
  supplier: "vendor",
  suppliername: "vendor",
  rate: "rate",
  unitrate: "rate",
  unitrateinr: "rate",
  price: "rate",
  unitprice: "rate",
  gst: "gstRate",
  gstrate: "gstRate",
  gstpercent: "gstRate",
  gstpercentage: "gstRate",
  gstslab: "gstRate",
  taxrate: "gstRate",
  remarks: "remarks",
  remark: "remarks",
  notes: "remarks",
};

const PHASE_BULK_NOTES = {
  phase: ["Phase these items belong to. It is created if it does not exist yet.", "phase-4"],
  code: ["BOQ item code (e.g. ITM-074).", "ITM-074"],
  desc: ["Description of the material.", "LED panel"],
  make: ["Manufacturer / make.", "Havells"],
  model: ["Linked finished model.", "Vector 5000"],
  uom: ["Unit of measure.", "NOS"],
  reqQty: ["Quantity needed per finished unit.", "12"],
  minStock: ["Buffer stock in units, 0 for none.", "5"],
  minStockQty: ["Total buffer = Req. Qty x Min Stock. Blank is calculated for you.", "60"],
  vendor: ["Preferred supplier / vendor.", "Steel Authority"],
  rate: ["Unit price, numbers only.", "145.50"],
  gstRate: ["GST percentage, 0-100. Blank means 18%.", "18"],
  unitGst: [
    "Calculated automatically = Unit Rate x GST % (blank GST uses 18%). Do not type in this column.",
    "1.08",
  ],
  materialCostUnit: [
    "Calculated automatically = Unit Rate + GST per Unit. Do not type in this column.",
    "7.08",
  ],
  lineTotalQty: [
    "Calculated automatically = Material Cost per Unit incl. GST x Req. Qty / Unit. Do not type here.",
    "35.40",
  ],
  remarks: ["Free text note.", "ISI marked"],
};

const PHASE_BULK_PREVIEW = [
  { key: "phase", label: "Phase Name" },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "uom", label: "UOM" },
  { key: "reqQty", label: "Req. Qty", isNumber: true },
  { key: "minStock", label: "Min Stock", isNumber: true },
  { key: "minStockQty", label: "Min Stock Qty", isNumber: true },
  { key: "vendor", label: "Supplier Name" },
];

const OPTIONAL_PHASE_BULK_COLUMNS = new Set([
  "make", "model", "uom", "minStock", "minStockQty", "vendor", "rate", "gstRate", "remarks",
]);

function normalizePhaseBulkRow(draft) {
  const text = {};
  Object.keys(draft || {}).forEach((key) => {
    text[key] = draft[key] === null || draft[key] === undefined ? "" : String(draft[key]).trim();
  });

  const problems = [];
  if (!text.phase) problems.push("Phase Name is empty");
  if (!text.code) problems.push("Item Code is empty");
  if (!text.desc) problems.push("Item Description is empty");

  const readNumber = (key) => {
    if (!text[key]) return null;
    const parsed = Number(text[key].replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
      problems.push(`${key} must be a number`);
      return null;
    }
    return parsed;
  };
  const reqQty = readNumber("reqQty");
  const minStock = readNumber("minStock");
  const minStockQty = readNumber("minStockQty");
  const rate = readNumber("rate");

  let gstRate = 18;
  if (text.gstRate) {
    const parsed = Number(text.gstRate.replace(/,/g, "").replace(/%$/, ""));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      problems.push("GST % must be a number between 0 and 100");
    } else {
      gstRate = parsed;
    }
  }

  return {
    row: {
      phase: text.phase,
      code: text.code,
      desc: text.desc,
      make: text.make,
      model: text.model,
      uom: text.uom,
      reqQty: reqQty === null ? text.reqQty : reqQty,
      minStock: minStock === null ? text.minStock : minStock,
      // Derived from Req. Qty x Min Stock when the column is left blank.
      minStockQty:
        minStockQty === null
          ? (Number(reqQty) || 0) * (Number(minStock) || 0)
          : minStockQty,
      vendor: text.vendor,
      rate: rate === null ? text.rate : rate,
      gstRate,
      remarks: text.remarks,
    },
    problems,
  };
}




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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [phases, setPhases] = useState([]);
  // A refresh reopens this model's phase BOQ - but only if the stored drill
  // belongs to the model currently open (the key is shared across models).
  const [activePhase, setActivePhase] = useState(() => {
    const drill = readDrill(DRILL_KEY);
    return drill && drill.modelId === model?.id ? drill.phase : null;
  });

  useEffect(() => {
    writeDrill(DRILL_KEY, activePhase ? { modelId: model?.id, phase: activePhase } : null);
  }, [activePhase, model?.id]);
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

  // Phase writes arrive as a WebSocket notice and reload the list quietly.
  // Skipped while the create/edit modal, bulk upload, or a delete is running.
  useRealtime(["phases"], () => loadPhases(), {
    guard: () => !(showModal || uploadOpen || deleting),
  });

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

  // Rows are grouped by their Phase Name.  A phase that does not exist yet is
  // created, then its BOQ rows are merged with whatever it already has (matched
  // by Item Code) and saved.  A phase that cannot be used is reported and its
  // rows are skipped - the other phases still go through.
  const handleImportedPhases = async (imported) => {
    setUploadOpen(false);
    const grouped = new Map();
    imported.forEach((row) => {
      const key = String(row.phase || "").trim().toLowerCase();
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, { name: String(row.phase).trim(), rows: [] });
      grouped.get(key).rows.push(row);
    });

    const touched = [];
    const problems = [];
    for (const group of grouped.values()) {
      try {
        let target = phases.find(
          (p) => String(p.name || "").trim().toLowerCase() === group.name.toLowerCase()
        );
        let created = false;
        if (!target) {
          const created1 = await api.post(`${API_BASE_URL}/models/${model.id}/phases`, {
            name: group.name,
          });
          if (!created1.data?.success) {
            problems.push(`${group.name}: ${created1.data?.message || "could not be created"}`);
            continue;
          }
          created = true;
          target = { id: created1.data.id, name: created1.data.name || group.name };
        }

        // Merge with the BOQ the phase already has, so a re-upload updates.
        let existingRows = [];
        try {
          const boqRes = await api.get(`${API_BASE_URL}/models/${model.id}/phases/${target.id}/boq`);
          existingRows = (boqRes.data?.boq?.allRows || boqRes.data?.boq?.rows || []).map((row) => ({
            ...row,
            phase: group.name,
          }));
        } catch {
          existingRows = [];
        }
        const merged = [...existingRows];
        const indexByCode = new Map();
        merged.forEach((row, index) => {
          const code = String(row.code || "").trim().toLowerCase();
          if (code) indexByCode.set(code, index);
        });
        group.rows.forEach((row) => {
          const code = String(row.code || "").trim().toLowerCase();
          const at = indexByCode.get(code);
          if (at === undefined) {
            indexByCode.set(code, merged.length);
            merged.push({ ...row, phase: group.name, itemCodeId: "" });
          } else {
            merged[at] = { ...merged[at], ...row, phase: group.name };
          }
        });

        const saved = await api.post(
          `${API_BASE_URL}/models/${model.id}/phases/${target.id}/boq`,
          { rows: merged }
        );
        if (!saved.data?.success) {
          problems.push(`${group.name}: ${saved.data?.message || "BOQ could not be saved"}`);
          continue;
        }
        touched.push(`${group.name} (${created ? "new" : "existing"}, ${group.rows.length} item${group.rows.length === 1 ? "" : "s"})`);
      } catch (err) {
        problems.push(`${group.name}: ${err.response?.data?.message || err.message || "failed"}`);
      }
    }

    await loadPhases();
    Swal.fire({
      title: "Bulk upload finished",
      html:
        `<p style="margin:0 0 6px">${touched.length} phase${touched.length === 1 ? "" : "s"} updated.</p>` +
        (touched.length
          ? `<ul style="text-align:left;margin:0 0 6px;padding-left:18px">${touched
              .map((line) => `<li>${line}</li>`)
              .join("")}</ul>`
          : "") +
        (problems.length
          ? `<p style="margin:0 0 4px">${problems.length} skipped:</p><ul style="text-align:left;margin:0;padding-left:18px">${problems
              .slice(0, 8)
              .map((line) => `<li>${line}</li>`)
              .join("")}</ul>`
          : ""),
      icon: problems.length ? "warning" : "success",
      confirmButtonText: "OK",
      confirmButtonColor: "var(--accent)",
      customClass: { popup: "swal-vector-popup" },
    });
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
      {!readOnly && (
      <button
        type="button"
        className="phase-upload-btn"
        onClick={() => setUploadOpen(true)}
        title="Create or update phases and their BOQ items from an Excel or CSV file"
      >
        <FileSpreadsheet size={15} /> Bulk upload
      </button>
      )}
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
            <span className="model-card-total">
              <span className="model-card-total-label">Material Cost</span>
              <span className="model-card-total-value">
                {fmtINR(Number(p.totalMaterialCost) || 0)}
              </span>
            </span>
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

      {!readOnly && (
      <BulkUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload Excel File"
        description="Upload the completed Phases template for validation."
        fileName="phase-template.xlsx"
        columns={PHASE_BULK_COLUMNS}
        aliases={PHASE_BULK_ALIASES}
        optionalKeys={OPTIONAL_PHASE_BULK_COLUMNS}
        notes={PHASE_BULK_NOTES}
        normalizeRow={normalizePhaseBulkRow}
        previewFields={PHASE_BULK_PREVIEW}
        importLabel="Import rows"
        dropdowns={{ phase: { label: "Phase Name", values: phases.map((p) => p.name) } }}
        onImport={handleImportedPhases}
      />
      )}
    </div>
  );
  }
