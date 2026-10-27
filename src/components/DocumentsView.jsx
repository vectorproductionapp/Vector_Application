import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Camera, Check, CheckSquare, ClipboardCheck, Download, FileArchive, FileText, Files, Loader2, Receipt, RefreshCw, X,
} from "lucide-react";
import api from "./Api";
import DataTable from "./DataTable";
import ListPagination from "./ListPagination";
import FilterModal, { countActiveFilters, matchesFilters } from "./FilterModal";
import ActiveFilterChips from "./ActiveFilterChips";
import DateRangeFilter from "./DateRangeFilter";
import { useRealtime } from "./RealtimeProvider";
import { downloadQcReportPdf } from "../utils/qcInspection";
import "./DocumentsView.css";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

// The categories the endpoint assigns, in the order the cards show them.
const CATEGORIES = [
  { key: "", label: "All Documents", Icon: Files },
  { key: "Invoice", label: "Invoices", Icon: Receipt },
  { key: "PO", label: "PO Details", Icon: FileText },
  { key: "QC Report", label: "QC Reports", Icon: ClipboardCheck },
  { key: "Defect Photo", label: "Defect Photos", Icon: Camera },
];

const CATEGORY_STORAGE_KEY = "stock-register-documents-category";

const SEARCH_KEYS = ["category", "reference", "detail", "date", "name"];

function matchesSearch(item, search) {
  const haystack = [
    ...SEARCH_KEYS.map((key) => String(item[key] ?? "")),
    ...Object.values(item.fields || {}).map((value) => String(value ?? "")),
  ].join(" ").toLowerCase();
  return haystack.includes(search);
}

// Groups a file by what it is, for the File Format filter.
function fileFormat(item) {
  const type = String(item.type || "").toLowerCase();
  const extension = String(item.name || "").toLowerCase().split(".").pop();
  if (type === "application/pdf" || extension === "pdf") return "PDF";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"].includes(extension)) return "Image";
  if (type.includes("spreadsheet") || type.includes("excel") || ["xls", "xlsx", "csv"].includes(extension)) return "Excel";
  if (type.includes("word") || ["doc", "docx"].includes(extension)) return "Word";
  return "Other";
}

// The Type is chosen with the cards above the table, so the dialog offers the
// remaining ways to narrow the list: these on every card, plus the fields of
// the chosen type.
const COMMON_FILTER_FIELDS = [
  { key: "fileFormat", label: "File Format", getValue: fileFormat },
  { key: "reference", label: "Reference" },
  { key: "recordStatus", label: "Record" },
];

// Whether the invoice / PO behind a file still exists. Leftover files (their
// record was deleted, e.g. with its phase) stay downloadable but are marked.
// eslint-disable-next-line no-unused-vars -- kept for the hidden Record column
const RECORD_COLUMN = {
  key: "recordStatus",
  label: "Record",
  render: (row) => (
    <span className={`documents-record-badge${row.recordStatus === "Active" ? "" : " is-deleted"}`}>
      {row.recordStatus || "Active"}
    </span>
  ),
};

// Every parameter of each record type, read from `fields` on the API row
// (flattened to `f_<name>` so the table can sort and filter by it). The file
// columns and Download button are appended to every set.
const CATEGORY_COLUMNS = {
  Invoice: [
    { key: "f_invoice", label: "Invoice No" },
    { key: "f_invoiceDate", label: "Invoice Date", isDate: true },
    { key: "f_phase", label: "Phase" },
    { key: "f_po", label: "PO No" },
    { key: "f_code", label: "Item Code" },
    { key: "f_desc", label: "Description" },
    { key: "f_qtyInv", label: "Qty Invoiced" },
    { key: "f_qtyRecv", label: "Qty Received" },
    { key: "f_verifiedBy", label: "Verified By" },
  ],
  PO: [
    { key: "f_po", label: "PO No" },
    { key: "f_supplier", label: "Supplier" },
    { key: "f_poDate", label: "PO Date", isDate: true },
    { key: "f_phase", label: "Phase" },
    { key: "f_code", label: "Item Code" },
    { key: "f_desc", label: "Description" },
    { key: "f_make", label: "Make" },
    { key: "f_model", label: "Model" },
    { key: "f_qty", label: "Qty" },
    { key: "f_rate", label: "Rate" },
    { key: "f_basicPrice", label: "Basic Price" },
    { key: "f_gst", label: "GST" },
    { key: "f_value", label: "Total Value" },
    { key: "f_expectedDeliveryDate", label: "Expected Delivery", isDate: true },
    { key: "f_status", label: "Status" },
  ],
  "QC Report": [
    { key: "f_serial", label: "Serial No" },
    { key: "f_model", label: "Model" },
    { key: "f_phase", label: "Phase" },
    { key: "f_stage", label: "Stage" },
    { key: "f_assembledBy", label: "Assembled By" },
    { key: "f_assembledDate", label: "Assembled Date", isDate: true },
    { key: "f_qcBy", label: "QC By" },
    { key: "f_qc", label: "QC Status" },
    { key: "f_inspectionDate", label: "Inspection Date", isDate: true },
    { key: "f_checkedBy", label: "Checked By" },
    { key: "f_verifiedBy", label: "Verified By" },
    { key: "f_authorizedBy", label: "Authorized By" },
    { key: "f_packagingStatus", label: "Packaging Status" },
  ],
  "Defect Photo": [
    { key: "f_serial", label: "Serial No" },
    { key: "f_date", label: "Reported Date", isDate: true },
    { key: "f_make", label: "Make" },
    { key: "f_model", label: "Model" },
    { key: "f_part", label: "Part" },
    { key: "f_problem", label: "Problem" },
    { key: "f_observations", label: "Observations" },
    { key: "f_solution", label: "Solution" },
    { key: "f_scratches", label: "Scratches" },
    { key: "f_dent", label: "Dent" },
    { key: "f_status", label: "Status" },
  ],
};

// The overview used on "All Documents", where the types share no fields.
const GENERAL_COLUMNS = [
  { key: "category", label: "Type" },
  { key: "reference", label: "Reference" },
  { key: "detail", label: "Details" },
  { key: "date", label: "Date", isDate: true },
];

// Extra Filter dialog fields per type.
const CATEGORY_FILTER_KEYS = {
  Invoice: ["f_phase", "f_po", "f_verifiedBy"],
  PO: ["f_supplier", "f_phase", "f_status", "f_make"],
  "QC Report": ["f_model", "f_phase", "f_checkedBy", "f_packagingStatus"],
  "Defect Photo": ["f_model", "f_part", "f_status"],
};

function filterFieldsFor(category) {
  const keys = CATEGORY_FILTER_KEYS[category] || [];
  const extra = (CATEGORY_COLUMNS[category] || []).filter((column) => keys.includes(column.key))
    .map(({ key, label }) => ({ key, label }));
  return category ? [...COMMON_FILTER_FIELDS, ...extra] : [...COMMON_FILTER_FIELDS, { key: "detail", label: "Details" }];
}

// `fields` flattened onto the row as `f_<name>`.
function flattenFields(item) {
  const flat = { ...item };
  Object.entries(item.fields || {}).forEach(([key, value]) => {
    flat[`f_${key}`] = value;
  });
  return flat;
}

// Stored dates are ISO (`2026-10-05`, sometimes with a time); a few older rows
// may be `05-10-2026`. Both reduce to YYYY-MM-DD so they compare as text.
function isoDay(value) {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return "";
}

function inDateRange(item, from, to) {
  if (!from && !to) return true;
  const day = isoDay(item.date);
  // An undated file cannot be placed in a range, so a range hides it.
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
}

// eslint-disable-next-line no-unused-vars -- kept for the hidden Size column
function formatSize(bytes) {
  const value = Number(bytes);
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileNameFromHeader(header, fallback) {
  const match = /filename="?([^";]+)"?/i.exec(header || "");
  return match ? match[1] : fallback;
}

// A failed blob request carries its JSON error message inside the blob.
async function blobErrorMessage(error, fallback) {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (parsed?.message) return parsed.message;
    } catch {
      // Not JSON: fall through to the generic message.
    }
  }
  return error?.response?.data?.message || error?.message || fallback;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function DocumentsView({ query = "" }) {
  const [documents, setDocuments] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Like the Stock Register tab, the chosen type card survives a refresh.
  const [category, setCategory] = useState(() => {
    try {
      const saved = sessionStorage.getItem(CATEGORY_STORAGE_KEY) || "";
      return CATEGORIES.some((item) => item.key === saved) ? saved : "";
    } catch {
      return "";
    }
  });
  const [rowFilters, setRowFilters] = useState({});
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo, setAppliedTo] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyId, setBusyId] = useState("");
  const [bulkBusy, setBulkBusy] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    try {
      sessionStorage.setItem(CATEGORY_STORAGE_KEY, category);
    } catch {
      // Storage blocked: the card just resets on refresh.
    }
  }, [category]);

  const fetchDocuments = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const response = await api.get(`${API_BASE_URL}/documents`);
      if (!response.data.success) throw new Error(response.data.message || "Failed to load documents");
      setDocuments((response.data.documents || []).map(flattenFields));
      setCounts(response.data.counts || {});
    } catch (error) {
      setLoadError(error?.response?.data?.message || error?.message || "Failed to load documents.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // New uploads arrive through these records.
  useRealtime(["invoices", "po_details", "assembly_units", "defectives"], () => fetchDocuments({ silent: true }));

  const search = query.trim().toLowerCase();

  const filterFields = useMemo(() => filterFieldsFor(category), [category]);

  // The Filter dialog's fields depend on the type card, so a filter set for
  // one type is cleared when another card is picked rather than lingering
  // invisibly.
  const [filtersCategory, setFiltersCategory] = useState(category);
  if (filtersCategory !== category) {
    setFiltersCategory(category);
    setRowFilters({});
  }

  // The cards count what the search and dates leave, so each one says how
  // many rows clicking it will show. (The Filter dialog's fields belong to the
  // open card, so they narrow the table but not the other cards.)
  const narrowed = useMemo(
    () => documents.filter((item) => (
      (!search || matchesSearch(item, search)) && inDateRange(item, appliedFrom, appliedTo)
    )),
    [documents, search, appliedFrom, appliedTo]
  );
  const narrowedActive = Boolean(search) || Boolean(appliedFrom || appliedTo);
  const cardCounts = useMemo(() => {
    if (!narrowedActive) return counts;
    return narrowed.reduce((result, item) => ({ ...result, [item.category]: (result[item.category] || 0) + 1 }), {});
  }, [counts, narrowed, narrowedActive]);

  const filtered = useMemo(
    () => narrowed.filter((item) => (
      (!category || item.category === category) && matchesFilters(item, rowFilters, filterFields)
    )),
    [narrowed, category, rowFilters, filterFields]
  );

  // A failed download belongs to the list it happened in; changing what the
  // list shows starts clean.
  const viewKey = `${category}|${search}|${JSON.stringify(rowFilters)}|${appliedFrom}|${appliedTo}`;
  useEffect(() => {
    setPage(1);
    setActionError("");
  }, [viewKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Only rows still on screen count as selected, so a filter change can never
  // download something the user can no longer see.
  const selectedRows = useMemo(
    () => filtered.filter((item) => selectedIds.has(item.id)),
    [filtered, selectedIds]
  );
  const allSelected = filtered.length > 0 && selectedRows.length === filtered.length;

  const toggleSelectOne = useCallback((id) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(filtered.map((item) => item.id)));
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const downloadOne = useCallback(async (item) => {
    setActionError("");
    setBusyId(item.id);
    try {
      if (item.kind === "qc") {
        await downloadQcReportPdf(item);
      } else {
        const response = await api.get(`${API_BASE_URL}/documents/download`, {
          params: { id: item.id },
          responseType: "blob",
          __vectorNoDedupe: true,
        });
        saveBlob(response.data, item.name);
      }
    } catch (error) {
      setActionError(await blobErrorMessage(error, `Could not download ${item.name}.`));
    } finally {
      setBusyId("");
    }
  }, []);

  // Uploaded files go into one zip built from exactly these rows; QC reports
  // are generated here, one PDF each (the browser may ask once to allow
  // multiple downloads).
  const downloadItems = async (items, mode) => {
    const files = items.filter((item) => item.kind === "file");
    const qcReports = items.filter((item) => item.kind === "qc");
    if (!files.length && !qcReports.length) return;
    setActionError("");
    setBulkBusy(mode);
    try {
      if (files.length === 1 && !qcReports.length) {
        await downloadOne(files[0]);
      } else if (files.length) {
        const response = await api.post(
          `${API_BASE_URL}/documents/zip`,
          { ids: files.map((item) => item.id) },
          { responseType: "blob", __vectorSuppressBusy: true }
        );
        saveBlob(response.data, fileNameFromHeader(response.headers?.["content-disposition"], "vector-documents.zip"));
      }
      for (const item of qcReports) {
        // eslint-disable-next-line no-await-in-loop
        await downloadQcReportPdf(item);
      }
    } catch (error) {
      setActionError(await blobErrorMessage(error, "Could not download the selected documents."));
    } finally {
      setBulkBusy("");
    }
  };

  const columns = useMemo(() => {
    const base = [
      // A type card shows every parameter of that record type; "All
      // Documents" keeps the short overview, since the types share no fields.
      ...(CATEGORY_COLUMNS[category] || GENERAL_COLUMNS),
      // Record and Size columns hidden on request; uncomment to show them again.
      // ...(["", "Invoice", "PO"].includes(category) ? [RECORD_COLUMN] : []),
      { key: "name", label: "File Name", mono: true },
      // { key: "size", label: "Size", render: (row) => formatSize(row.size) },
      {
        key: "download",
        label: "Download",
        sortable: false,
        render: (row) => (
          <button
            type="button"
            className="documents-download-btn"
            onClick={() => downloadOne(row)}
            disabled={busyId === row.id}
            aria-label={`Download ${row.name}`}
          >
            {busyId === row.id ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {row.kind === "qc" ? "PDF" : "Download"}
          </button>
        ),
      },
    ];
    if (!selectMode) return base;
    return [
      {
        key: "__select",
        label: "",
        sortable: false,
        render: (row) => (
          <input
            type="checkbox"
            className="documents-row-checkbox"
            checked={selectedIds.has(row.id)}
            onChange={() => toggleSelectOne(row.id)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${row.name}`}
          />
        ),
      },
      ...base,
    ];
  }, [busyId, category, downloadOne, selectMode, selectedIds, toggleSelectOne]);

  if (loading) {
    return (
      <div className="documents-loading">
        <Loader2 size={28} className="spin" />
        <span>Loading documents...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="documents-load-error">
        <span>{loadError}</span>
        <button type="button" className="documents-retry" onClick={() => fetchDocuments()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  const totalAll = Object.values(cardCounts).reduce((sum, value) => sum + value, 0);
  const fileCount = filtered.filter((item) => item.kind === "file").length;
  const qcCount = filtered.length - fileCount;
  const anyFilterActive = narrowedActive || countActiveFilters(rowFilters) > 0 || Boolean(category);

  const clearAll = () => {
    setCategory("");
    setRowFilters({});
    setFromDate("");
    setToDate("");
    setAppliedFrom("");
    setAppliedTo("");
  };

  return (
    <div className="documents-page">
      <div className="documents-cards" role="tablist" aria-label="Document type">
        {CATEGORIES.map(({ key, label, Icon }) => {
          const active = category === key;
          const count = key ? cardCounts[key] || 0 : totalAll;
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={active}
              className={`documents-card${active ? " is-active" : ""}`}
              onClick={() => setCategory(key)}
            >
              <span className="documents-card-icon"><Icon size={18} /></span>
              <span className="documents-card-text">
                <span className="documents-card-label">{label}</span>
                <span className="documents-card-value">{count}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <FilterModal
              rows={category ? documents.filter((item) => item.category === category) : documents}
              fields={filterFields}
              value={rowFilters}
              onChange={setRowFilters}
            />
            <DateRangeFilter
              fromDate={fromDate}
              toDate={toDate}
              onChangeFrom={setFromDate}
              onChangeTo={setToDate}
              onApply={(nextFrom, nextTo) => {
                setAppliedFrom(nextFrom);
                setAppliedTo(nextTo);
              }}
              onClear={() => {
                setFromDate("");
                setToDate("");
                setAppliedFrom("");
                setAppliedTo("");
              }}
              error={fromDate && toDate && toDate < fromDate ? "To Date is before From Date." : ""}
              startLabel="From Date"
              endLabel="To Date"
            />
            <ActiveFilterChips fields={filterFields} value={rowFilters} onChange={setRowFilters} />
          </div>

          <div className="documents-bulk-actions">
            {selectMode ? (
              <>
                <button type="button" className="documents-outline-btn" onClick={toggleSelectAll} disabled={!filtered.length}>
                  <Check size={15} /> {allSelected ? "Deselect All" : `Select All (${filtered.length})`}
                </button>
                <button
                  type="button"
                  className="documents-bulk-btn"
                  onClick={() => downloadItems(selectedRows, "selected")}
                  disabled={!selectedRows.length || Boolean(bulkBusy)}
                >
                  {bulkBusy === "selected" ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                  Download Selected ({selectedRows.length})
                </button>
                <button type="button" className="documents-outline-btn" onClick={exitSelectMode}>
                  <X size={15} /> Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="documents-outline-btn"
                  onClick={() => setSelectMode(true)}
                  disabled={!filtered.length}
                >
                  <CheckSquare size={15} /> Select
                </button>
                <button
                  type="button"
                  className="documents-bulk-btn"
                  onClick={() => downloadItems(filtered, "all")}
                  disabled={!filtered.length || Boolean(bulkBusy)}
                  title={qcCount && fileCount ? "Files download as one .zip; QC reports as separate PDFs" : undefined}
                >
                  {bulkBusy === "all" ? <Loader2 size={15} className="spin" /> : <FileArchive size={15} />}
                  Download All ({filtered.length})
                </button>
              </>
            )}
          </div>
        </div>

        <div className="documents-summary">
          {selectMode && selectedRows.length
            ? `${plural(selectedRows.length, "document")} selected of ${filtered.length}`
            : `${plural(filtered.length, "document")}${anyFilterActive ? " match the current filters" : ""}`}
          {fileCount > 0 && qcCount > 0 && " · files download as one .zip, QC reports as PDFs"}
        </div>

        {actionError && <div className="documents-action-error" role="alert">{actionError}</div>}

        {filtered.length === 0 ? (
          <div className="documents-empty">
            {anyFilterActive ? (
              <>
                <span>No documents match the current search, type, filter or dates.</span>
                <button type="button" className="documents-outline-btn" onClick={clearAll}>Clear filters</button>
              </>
            ) : (
              "No uploaded documents or QC reports yet."
            )}
          </div>
        ) : (
          <DataTable columns={columns} rows={pageRows} />
        )}
      </div>

      {filtered.length > 0 && (
        <ListPagination
          page={safePage}
          pageSize={pageSize}
          totalPages={totalPages}
          totalCount={filtered.length}
          rowCount={pageRows.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          itemLabel="documents"
        />
      )}
    </div>
  );
}
