import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import { Plus, Pencil, Trash2, ArrowLeft, ClipboardList, X, Save, Loader2, MoreVertical, Check, FileSpreadsheet } from "lucide-react";
import SearchBar, { SearchableSelect } from "../components/SearchBar";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import ExportPdfButton from "../components/ExportPdfButton";
import BulkUploadModal from "../components/BulkUploadModal";
import { fmtINR } from "../data/mockData";
import "../components/CreateEntityModal.css";
import "./Model.css";
import "./Boq.css";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const PAGE_SIZE = 10;

// ---- Excel bulk upload for the BOQ rows ------------------------------
// The template mirrors the BOQ table, so a filled file can be imported
// straight into the editor and reviewed before saving.
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
const BOQ_BULK_COLUMNS = [
  { key: "phase", label: "Phase" },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "uom", label: "UOM" },
  { key: "reqQty", label: "Req. Qty / Unit" },
  { key: "minStock", label: "Min Stock (Buffer)" },
  // Buffer total = Req. Qty / Unit x Min Stock, calculated in Excel exactly as
  // the editor does, so the sample rows are never blank.
  {
    key: "minStockQty",
    label: "Min Stock Qty (Buffer)",
    required: false,
    formula: `IFERROR(IF(OR(${excelNum("{reqQty}")}="",${excelNum("{minStock}")}=""),"",ROUND(${excelNum("{reqQty}")}*${excelNum("{minStock}")},2)),"")`,
  },
  { key: "vendor", label: "Supplier Name" },
  { key: "rate", label: "Unit Rate (INR)" },
  { key: "gstRate", label: "GST %" },
  // Basic Price / GST Price / Total incl. GST, calculated in Excel from
  // Req. Qty + Unit Rate + GST %, exactly like the editor does; `required:
  // false` keeps them out of the import checks.
  {
    key: "basicPrice",
    label: "Basic Price (INR)",
    required: false,
    formula: `IFERROR(IF(OR(${excelNum("{rate}")}="",${excelNum("{reqQty}")}=""),"",ROUND(${excelNum("{rate}")}*${excelNum("{reqQty}")},2)),"")`,
  },
  {
    key: "gstPrice",
    label: "GST Price (INR)",
    required: false,
    formula: `IFERROR(IF(${excelNum("{basicPrice}")}="","",ROUND(${excelNum("{basicPrice}")}*${excelGst("{gstRate}")},2)),"")`,
  },
  {
    key: "totalInclGst",
    label: "Total incl. GST (INR)",
    required: false,
    formula: `IFERROR(IF(${excelNum("{basicPrice}")}="","",ROUND(${excelNum("{basicPrice}")}+${excelNum("{gstPrice}")},2)),"")`,
  },
  { key: "remarks", label: "Remarks" },
];

// Phase defaults to the one the BOQ belongs to, and Min Stock Qty is derived
// from Req. Qty x Min Stock, so both columns are optional.
const BOQ_BULK_OPTIONAL = new Set([
  "phase",
  "make",
  "model",
  "uom",
  "minStock",
  "minStockQty",
  "vendor",
  "rate",
  "gstRate",
  "remarks",
]);

const BOQ_BULK_NOTES = {
  phase: ["Phase this item belongs to. Blank uses the BOQ's own phase.", "phase-1"],
  code: ["BOQ item code (e.g. ITM-074).", "ITM-074"],
  desc: ["Description of the material.", "LED panel"],
  make: ["Manufacturer / make. Optional.", "Havells"],
  model: ["Linked finished model. Optional.", "Vector 5000"],
  uom: ["Unit of measure. Optional.", "NOS"],
  reqQty: ["Quantity needed per finished unit.", "12"],
  minStock: ["Buffer stock in units. Optional, 0 for none.", "5"],
  minStockQty: [
    "Calculated automatically = Req. Qty / Unit x Min Stock (Buffer). Do not type in this column.",
    "60",
  ],
  vendor: ["Preferred supplier / vendor. Optional.", "Steel Authority"],
  rate: ["Unit price, numbers only. Optional.", "145.50"],
  gstRate: ["GST percentage, 0-100. Blank means 18%.", "18"],
  basicPrice: [
    "Calculated automatically = Req. Qty / Unit x Unit Rate (before GST). Do not type in this column.",
    "30",
  ],
  gstPrice: [
    "Calculated automatically = Basic Price x GST % (blank GST uses 18%). Do not type in this column.",
    "5.4",
  ],
  totalInclGst: [
    "Calculated automatically = Basic Price + GST Price. Do not type in this column.",
    "35.4",
  ],
  remarks: ["Free text note. Optional.", "ISI marked"],
};

// Header cells are normalised (lower-case, letters/digits only) before matching,
// so "Item Code", "item_code" and "ItemCode" all resolve to the same column.
const BOQ_BULK_ALIASES = {
  phase: "phase",
  phasename: "phase",
  code: "code",
  itemcode: "code",
  materialcode: "code",
  partcode: "code",
  desc: "desc",
  description: "desc",
  itemdescription: "desc",
  materialdescription: "desc",
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
  requiredqtyperunit: "reqQty",
  reqqtyperunit: "reqQty",
  qtyperunit: "reqQty",
  qtyunit: "reqQty",
  quantityperunit: "reqQty",
  perunitqty: "reqQty",
  minstock: "minStock",
  bufferstock: "minStock",
  minstockbuffer: "minStock",
  // "Min Stock Qty" is the derived total, kept separate from the buffer itself.
  minstockqty: "minStockQty",
  minstockqtybuffer: "minStockQty",
  totalbufferstock: "minStockQty",
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
  // Files exported before the Basic Price / GST Price / Total rename still
  // carry the old calculated headers; they are ignored on import either way.
  basicprice: "basicPrice",
  gstprice: "gstPrice",
  materialcost: "totalInclGst",
  materialcostunit: "totalInclGst",
  materialcostinr: "totalInclGst",
  materialcostinclgst: "totalInclGst",
  linecost: "totalInclGst",
  totalinclg: "totalInclGst",
  total: "totalInclGst",
  remarks: "remarks",
  remark: "remarks",
  notes: "remarks",
  note: "remarks",
};

const BOQ_BULK_PREVIEW = [
  { key: "phase", label: "Phase" },
  { key: "code", label: "Item Code" },
  { key: "desc", label: "Item Description" },
  { key: "uom", label: "UOM" },
  { key: "reqQty", label: "Req. Qty", isNumber: true },
  { key: "minStock", label: "Min Stock", isNumber: true },
  { key: "minStockQty", label: "Min Stock Qty", isNumber: true },
  { key: "vendor", label: "Supplier Name" },
  { key: "rate", label: "Unit Rate (INR)", isNumber: true },
  { key: "gstRate", label: "GST %", isNumber: true },
];

/** One spreadsheet row -> one BOQ line, with per-row problems reported. */
function normalizeBoqBulkRow(draft, phaseName) {
  const text = {};
  Object.keys(draft || {}).forEach((key) => {
    text[key] = draft[key] === null || draft[key] === undefined ? "" : String(draft[key]).trim();
  });

  const problems = [];
  if (!text.code) problems.push("Item Code is empty");
  if (!text.desc) problems.push("Item Description is empty");

  const readNumber = (key) => {
    if (!text[key]) return null;
    const parsed = Number(text[key].replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
      problems.push(`${BOQ_BULK_COLUMNS.find((column) => column.key === key)?.label || key} must be a number`);
      return null;
    }
    return parsed;
  };

  const reqQty = readNumber("reqQty");
  const minStock = readNumber("minStock");
  const rate = readNumber("rate");
  const minStockQty = readNumber("minStockQty");

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
      // A blank Phase column falls back to the BOQ's own phase.
      phase: text.phase || phaseName,
      code: text.code,
      itemCodeId: "",
      desc: text.desc,
      make: text.make,
      model: text.model,
      uom: text.uom,
      reqQty: reqQty === null ? text.reqQty : reqQty,
      minStock: minStock === null ? text.minStock : minStock,
      // Derived from Req. Qty x Min Stock; anything typed here is overwritten
      // by withCalculatedFields so the totals can never disagree.
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
  { key: "gstRate", label: "GST %", format: (value) => (value === null || value === undefined || String(value).trim() === "" ? "18%" : `${value}%`) },
  // Money trio: Basic = Req. Qty x Unit Rate, GST is that base times the line's
  // slab, Total is Basic + GST.  `render` drives the table (it gets the whole
  // row), `format` drives the Excel/PDF export (value + row).
  ...[
    { key: "basicPrice", label: "Basic Price (INR)", pick: "base" },
    { key: "gstAmount", label: "GST Price (INR)", pick: "gst" },
    { key: "lineTotal", label: "Total incl. GST (INR)", pick: "total" },
  ].map(({ key, label, pick }) => ({
    key,
    label,
    render: (row) => fmtINR(boqGstAmounts(row)?.[pick] ?? 0),
    format: (value, row) => fmtINR(boqGstAmounts(row)?.[pick] ?? (Number(value) || 0)),
  })),
  { key: "remarks", label: "Remarks" },
];
const BOQ_FILTER_FIELDS = BOQ_COLUMNS.filter((column) => ["phase", "make", "model", "uom", "vendor"].includes(column.key));

// GST differs per product, so every BOQ line carries its own percentage and
// falls back to this slab when the field is left empty.
const BOQ_DEFAULT_GST_RATE = 18;

function boqGstRate(row) {
  const raw = row?.gstRate;
  const parsed =
    raw === null || raw === undefined || String(raw).trim() === "" ? BOQ_DEFAULT_GST_RATE : Number(raw);
  return Number.isFinite(parsed) ? parsed : BOQ_DEFAULT_GST_RATE;
}

// Unit rate, GST and the GST-inclusive cost, split into per-unit and whole-line
// figures so the two are never confused. All read-only.
function boqGstAmounts(row) {
  const rate = Number(row?.rate) || 0;
  const reqQty = Number(row?.reqQty) || 0;
  const gstRate = boqGstRate(row);
  if (!rate) return null;

  const unitGst = Math.round((rate * gstRate) / 100 * 100) / 100;
  const unitTotal = Math.round((rate + unitGst) * 100) / 100;
  const base = rate * reqQty;
  const gst = Math.round((base * gstRate) / 100 * 100) / 100;
  return { rate, reqQty, gstRate, unitGst, unitTotal, base, gst, total: Math.round((base + gst) * 100) / 100 };
}

// Recomputes the auto-calculated fields for a single row.  Exported because the
// Phases page imports rows straight from Excel and must derive the same figures
// as the editor.
export const withCalculatedFields = (row) => {
  const reqQty = Number(row.reqQty) || 0;
  const minStock = Number(row.minStock) || 0;
  const amounts = boqGstAmounts(row);

  return {
    ...row,
    minStockQty: reqQty && minStock ? reqQty * minStock : 0,
    // Stored as the GST-inclusive cost of the whole line (rate x req qty), so
    // the page total keeps summing real line values; per-unit cost is derived.
    materialCost: amounts ? amounts.total : 0,
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
    // Default GST slab; every line can override it with its own rate.
    gstRate: "18",
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
  const [uploadOpen, setUploadOpen] = useState(false);
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

  // Master-list maintenance: fix a mistyped supplier name, or drop one that is
  // no longer used.  BOQ rows keep whatever name they were saved with.
  const applySupplierList = (nextList) => {
    suppliersCache = nextList;
    setSuppliers(nextList);
  };

  const handleEditSupplier = async (option) => {
    const { value: newName } = await Swal.fire({
      title: "Edit supplier name",
      input: "text",
      inputValue: option.value,
      showCancelButton: true,
      confirmButtonText: "Save name",
      cancelButtonText: "Cancel",
      confirmButtonColor: "var(--accent)",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      inputValidator: (value) => (!value || !value.trim() ? "Supplier name cannot be empty" : null),
      customClass: { popup: "swal-vector-popup" },
    });
    if (!newName) return;

    const trimmed = newName.trim();
    if (trimmed.toLowerCase() === option.value.toLowerCase()) return;

    try {
      const response = await api.put(`${API_BASE_URL}/suppliers`, {
        oldName: option.value,
        newName: trimmed,
      });
      if (!response.data.success) {
        throw new Error(response.data.message || "Failed to rename supplier");
      }

      // Keep the open BOQ in sync when the row being edited used that name.
      setDraftRows((prev) =>
        prev.map((row) =>
          String(row.vendor ?? "").toLowerCase() === option.value.toLowerCase()
            ? { ...row, vendor: trimmed }
            : row
        )
      );
      applySupplierList(
        (suppliersCache || [])
          .map((name) => (name.toLowerCase() === option.value.toLowerCase() ? trimmed : name))
          .sort((a, b) => a.localeCompare(b))
      );
      await swalSuccess("Supplier renamed", `"${option.value}" is now "${trimmed}".`);
    } catch (err) {
      await swalError("Rename failed", err?.response?.data?.message || err?.message || "Failed to rename supplier.");
    }
  };

  const handleDeleteSupplier = async (option) => {
    const confirmed = await swalConfirm({
      title: `Delete "${option.value}"`,
      text: "It disappears from the supplier list. BOQ rows already saved keep the name they were saved with.",
      confirmText: "Yes, delete it",
    });
    if (!confirmed) return;

    try {
      const response = await api.delete(`${API_BASE_URL}/suppliers`, {
        data: { name: option.value },
      });
      if (!response.data.success) {
        throw new Error(response.data.message || "Failed to delete supplier");
      }
      applySupplierList(
        (suppliersCache || []).filter(
          (name) => name.toLowerCase() !== option.value.toLowerCase()
        )
      );
      await swalSuccess("Supplier deleted", `"${option.value}" was removed from the list.`);
    } catch (err) {
      await swalError("Delete failed", err?.response?.data?.message || err?.message || "Failed to delete supplier.");
    }
  };

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

  // Imported rows are reconciled by Item Code: a code that is already listed
  // updates that row in place, anything new is appended.  The rows stay drafts
  // until "Save Overall", so nothing reaches the database from the upload.
  const handleImportedRows = (imported) => {
    setError("");
    setDraftRows((previous) => {
      const kept = previous.filter((row) => String(row.desc || "").trim() || String(row.code || "").trim());
      const next = [...kept];
      const indexByCode = new Map();
      next.forEach((row, index) => {
        const code = String(row.code || "").trim().toLowerCase();
        if (code) indexByCode.set(code, index);
      });

      let added = 0;
      let updated = 0;
      imported.forEach((row) => {
        const code = String(row.code || "").trim();
        const key = code.toLowerCase();
        const existingIndex = indexByCode.get(key);
        const prepared = withCalculatedFields({ ...row, phase: row.phase || phaseName });
        if (existingIndex === undefined) {
          indexByCode.set(key, next.length);
          next.push(prepared);
          added += 1;
        } else {
          next[existingIndex] = { ...next[existingIndex], ...prepared };
          updated += 1;
        }
      });

      setTimeout(() => {
        Swal.fire({
          title: "Rows imported",
          text: `${updated} row${updated === 1 ? "" : "s"} updated, ${added} added. Review the list, then save.`,
          icon: "success",
          confirmButtonText: "OK",
          confirmButtonColor: "var(--accent)",
          customClass: { popup: "swal-vector-popup" },
        });
      }, 0);
      return next;
    });
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
          <div className="modal-header-actions">
            <button
              type="button"
              className="boq-add-item-btn"
              onClick={addRow}
              disabled={saving}
              title="Add another item to this BOQ"
            >
              <Plus size={15} /> Add item
            </button>
            <button
              type="button"
              className="boq-upload-btn"
              onClick={() => setUploadOpen(true)}
              title="Add many BOQ items from an Excel or CSV file"
            >
              <FileSpreadsheet size={15} /> Bulk upload
            </button>
            <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
              <X size={22} />
            </button>
          </div>
        </div>

        <form
          className="boq-form-scroll"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          {error && <div className="boq-form-error">{error}</div>}

          {draftRows.map((row, rowIndex) => {
            const totals = boqGstAmounts(row);
            return (
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
                    onEditOption={handleEditSupplier}
                    onDeleteOption={handleDeleteSupplier}
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
                  <span>GST %</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="any"
                    value={row.gstRate ?? ""}
                    onChange={(e) => updateField(rowIndex, "gstRate", e.target.value)}
                    placeholder="18"
                  />
                </label>

                {/* Same three money figures the table shows: Req. Qty x Unit
                    Rate, the GST on that base, and Basic + GST. */}
                <label className="boq-field">
                  <span>Basic Price (INR)</span>
                  <input type="number" value={totals ? totals.base : 0} readOnly disabled />
                </label>

                <label className="boq-field">
                  <span>GST Price (INR)</span>
                  <input type="number" value={totals ? totals.gst : 0} readOnly disabled />
                </label>

                <label className="boq-field">
                  <span>Total incl. GST (INR)</span>
                  <input type="number" value={row.materialCost ?? 0} readOnly disabled />
                </label>

              </div>

              {totals && (
                <div className="boq-gst-totals">
                  <span className="boq-gst-totals-item">
                    Unit Rate: <strong>{fmtINR(totals.rate)}</strong>
                  </span>
                  <span className="boq-gst-totals-item">
                    GST ({totals.gstRate}%) per Unit: <strong>{fmtINR(totals.unitGst)}</strong>
                  </span>
                  <span className="boq-gst-totals-item boq-gst-totals-final">
                    Total per Unit incl. GST: <strong>{fmtINR(totals.unitTotal)}</strong>
                  </span>
                  <span className="boq-gst-totals-item">
                    Basic Price ({totals.reqQty} × {fmtINR(totals.rate)}):{" "}
                    <strong>{fmtINR(totals.base)}</strong>
                  </span>
                  <span className="boq-gst-totals-item">
                    GST Price: <strong>{fmtINR(totals.gst)}</strong>
                  </span>
                  {totals.reqQty > 0 && (
                    <span className="boq-gst-totals-item boq-gst-totals-total">
                      Total incl. GST: <strong>{fmtINR(totals.total)}</strong>
                    </span>
                  )}
                </div>
              )}
            </div>
            );
          })}
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

      <BulkUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload Excel File"
        description={`Upload the completed ${phaseName} BOQ template for validation.`}
        fileName="boq-template.xlsx"
        columns={BOQ_BULK_COLUMNS}
        aliases={BOQ_BULK_ALIASES}
        optionalKeys={BOQ_BULK_OPTIONAL}
        notes={BOQ_BULK_NOTES}
        normalizeRow={(draft) => normalizeBoqBulkRow(draft, phaseName)}
        previewFields={BOQ_BULK_PREVIEW}
      importLabel="Import rows"
      onImport={handleImportedRows}
      />
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
  // Bulk upload lives on this page (like PO Details) and inside the editor.
  const [uploadOpen, setUploadOpen] = useState(false);
  // Rows waiting from a bulk upload: they join the editor, not the database.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
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
        { params: { page: pageToFetch, limit: pageSize } }
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
  }, [page, pageSize, resolvedModelId, resolvedPhaseId]);

  useEffect(() => {
    const resourceKey = `${resolvedModelId || ""}:${resolvedPhaseId || ""}`;
    const resourceChanged = !lastLoadKeyRef.current
      || !lastLoadKeyRef.current.startsWith(`${resourceKey}:`);
    const targetPage = resourceChanged ? 1 : page;
    const loadKey = `${resourceKey}:${targetPage}:${pageSize}`;

    if (resourceChanged && page !== 1) setPage(1);
    if (lastLoadKeyRef.current === loadKey) return;

    lastLoadKeyRef.current = loadKey;
    loadBoq({ targetPage });
  }, [loadBoq, page, pageSize, resolvedModelId, resolvedPhaseId]);

  // A BOQ write on this phase arrives as a WebSocket notice and reloads the
  // items quietly.  Skipped while the row editor or the bulk-upload modal is
  // open, so a background save never disturbs a half-finished edit.
  useRealtime(["boq"], () => loadBoq({ silent: true }), {
    guard: () => !(editorOpen || uploadOpen),
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

  // A BOQ document can survive with no rows in it (every line was deleted, or
  // the upload preview never saved).  That is the same situation as never
  // having had a BOQ, so the page offers "Add BOQ" and the empty state again
  // instead of an empty table under an "Edit BOQ" button.
  const hasBoqRows = Boolean(boq && (boq.allRows || boq.rows || []).length);

  const exportRows = useMemo(
    () => filterBoqRows(boq?.allRows || boq?.rows || []),
    [boq, filterBoqRows]
  );

  // Grand total over every exported row (all pages), not just the visible page.
  const totalMaterialCost = useMemo(
    () =>
      exportRows.reduce(
        (sum, row) => sum + (Number(String(row.materialCost ?? 0).replace(/,/g, "")) || 0),
        0
      ),
    [exportRows]
  );

  // The same rows without their GST portion, so the badge can show both.
  const totalMaterialCostExclGst = useMemo(
    () =>
      exportRows.reduce((sum, row) => {
        const amounts = boqGstAmounts(row);
        if (amounts) return sum + amounts.base;
        // No unit rate on the row: strip GST from the stored inclusive cost.
        const incl = Number(String(row.materialCost ?? 0).replace(/,/g, "")) || 0;
        return sum + Math.round((incl / (1 + boqGstRate(row) / 100)) * 100) / 100;
      }, 0),
    [exportRows]
  );

  const persistRows = useCallback(async (rows, { createMissingItemCodes = false } = {}) => {
    // A spreadsheet is how new Item Codes arrive, so an upload may register the
    // codes it carries; the editor keeps its stricter "pick or create" flow.
    const body = { rows, createMissingItemCodes };
    if (boq?.id) {
      return api.put(
        `${API_BASE_URL}/models/${resolvedModelId}/phases/${resolvedPhaseId}/boq/${boq.id}`,
        body,
        { __vectorSuppressBusy: true }
      );
    }
      return api.post(
        `${API_BASE_URL}/models/${resolvedModelId}/phases/${resolvedPhaseId}/boq`,
        body,
        { __vectorSuppressBusy: true }
      );
  }, [boq, resolvedModelId, resolvedPhaseId]);

  // Create vs update messaging is decided *before* the save, since after
  // persistRows() succeeds boq.id will always be truthy either way.
  const handleSave = async (rows, { keepEditorOpen = false, addedCount = 0, createMissingItemCodes = false } = {}) => {
    const wasExisting = Boolean(boq?.id);
    try {
      await persistRows(rows, { createMissingItemCodes });
      if (keepEditorOpen) {
        setBoq((current) => current ? {
          ...current,
          allRows: rows,
          rows: rows.slice((page - 1) * pageSize, page * pageSize),
        } : current);
      } else {
        await loadBoq({ targetPage: 1, silent: true });
        setPage(1);
      }
      if (!keepEditorOpen) setEditorOpen(false);
      swalSuccess(
        keepEditorOpen ? "BOQ item saved" : (wasExisting ? "BOQ updated" : "BOQ created"),
        addedCount
          ? `${addedCount} row${addedCount === 1 ? "" : "s"} added to the BOQ for ${phaseName}.`
          : wasExisting
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

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
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
      {hasBoqRows ? "Edit BOQ" : "Add BOQ"}
      </button>
      <button
        type="button"
        className="boq-upload-btn"
        onClick={() => setUploadOpen(true)}
        title="Add or update many BOQ items from an Excel or CSV file"
      >
        <FileSpreadsheet size={15} /> Bulk upload
      </button>
              {hasBoqRows && (
                <button type="button" className="delete-button" onClick={toggleSelectMode}>
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
                    {hasBoqRows ? "Edit BOQ" : "Add BOQ"}
                  </button>
                  {hasBoqRows && (
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

      {!loading && !hasBoqRows && (
        <div className="boq-empty">
          <ClipboardList size={34} />
          <h3>No BOQ added yet</h3>
          <p>{readOnly ? "No BOQ has been configured for this phase." : "Create the BOQ for this phase to start tracking rows."}</p>
        </div>
      )}

      {!loading && hasBoqRows && (
        <>
          <div className="panel">
            <div className="table-controls-row">
              <div className="table-controls-primary">
                <SearchBar value={query} onChange={setQuery} placeholder="Search BOQ rows..." />
                <PageFilter rows={boq.rows || []} fields={BOQ_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
                {/* <span className="boq-count">Showing {filteredRows.length} of {totalCount} rows</span> */}
              </div>
              <div className="table-controls-right">
                <span className="table-total">
                  <span className="table-total-label">Total</span>
                  <span className="table-total-value">
                    {fmtINR(totalMaterialCostExclGst)}{" "}
                    <span className="table-total-scope">(Basic Price)</span>
                  </span>
                  <span className="table-total-scope">|</span>
                  <span className="table-total-value">
                    {fmtINR(totalMaterialCost - totalMaterialCostExclGst)}{" "}
                    <span className="table-total-scope">(GST Price)</span>
                  </span>
                  <span className="table-total-scope">|</span>
                  <span className="table-total-value">
                    {fmtINR(totalMaterialCost)}{" "}
                    <span className="table-total-scope">(Total incl. GST)</span>
                  </span>
                </span>
                <ExportPdfButton
                  mode="table"
                  title={`${phaseName} BOQ`}
                  columns={BOQ_COLUMNS}
                  rows={exportRows}
                  fileName={`${phaseName}-boq`}
                />
              </div>
            </div>
            <DataTable columns={tableColumns} rows={filteredRows} />
          </div>

          {/* <div className="table-total-outside">
            <span className="table-total-label">Total Material Cost incl. GST</span>
            <span className="table-total-value">{fmtINR(totalMaterialCost)}</span>
          </div> */}

          <ListPagination
            page={page}
            pageSize={pageSize}
            totalPages={totalPages}
            totalCount={totalCount}
            rowCount={filteredRows.length}
            onPageChange={setPage}
            onPageSizeChange={handlePageSizeChange}
          />
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

      {!readOnly && (
        <BulkUploadModal
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          title="Upload Excel File"
          description={`Upload the completed ${phaseName} BOQ template for validation.`}
          fileName="boq-template.xlsx"
          columns={BOQ_BULK_COLUMNS}
          aliases={BOQ_BULK_ALIASES}
          optionalKeys={BOQ_BULK_OPTIONAL}
          notes={BOQ_BULK_NOTES}
          normalizeRow={(draft) => normalizeBoqBulkRow(draft, phaseName)}
          previewFields={BOQ_BULK_PREVIEW}
      importLabel="Add to BOQ"
onImport={(imported) => {
          // The upload is a deliberate save: append the imported lines to the
          // phase's own BOQ and refresh the table.  No detour through the
          // editor, which used to open with the new items as unsaved drafts.
          if (!imported.length) return;
          const current = boq?.allRows || boq?.rows || [];
          // Rows that never pass through the editor still need their derived
          // fields (buffer total, GST-inclusive material cost), or the page
          // totals read as zero.
          const prepared = imported.map((row) => withCalculatedFields(row));
          setUploadOpen(false);
          handleSave([...current, ...prepared], {
            addedCount: imported.length,
            createMissingItemCodes: true,
          });
        }}
      />
      )}
    </div>
  );
  }
