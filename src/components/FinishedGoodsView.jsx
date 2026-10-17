import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Loader2, RefreshCw, X, Package } from "lucide-react";
import SearchBar from "./SearchBar";
import FilterModal from "./FilterModal";
import ActiveFilterChips from "./ActiveFilterChips";
import ExportPdfButton from "./ExportPdfButton";
import DataTable from "./DataTable";
import ListPagination from "./ListPagination";
import { sortRows } from "../utils/tableSort";

const FG_COLUMNS = [
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial No", mono: true },
  { key: "phase", label: "Phase" },
  { key: "packagingStatus", label: "Packaging Status" },
  { key: "packagedBy", label: "Packaged By" },
  { key: "packagedDate", label: "Packaged Date", isDate: true },
  { key: "assembledBy", label: "Assembled By" },
  { key: "assembledDate", label: "Assembled Date", isDate: true },
  { key: "qcBy", label: "QC By" },
  { key: "status", label: "Status" },
];

// Exported because the page owns the request: it has to send these fields to the
// endpoint for the dropdowns and the summary cards to change the rows at all.
export const FG_FILTER_FIELDS = FG_COLUMNS.filter((column) => ["model", "phase", "status"].includes(column.key));

// The status the endpoint assigns to a packed unit that has not been delivered
// (`stockregister.py`). Reused verbatim so the card cannot ask for a value the
// filter would reject. Sold units are still selectable in the Status dropdown.
const STATUS_IN_STOCK = "In Stock";

const FG_DETAIL_FIELDS = FG_COLUMNS;

function formatDate(value) {
  if (!value) return "—";
  try {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  } catch {
    return String(value);
  }
}

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Failed to load finished goods.";
}

export default function FinishedGoodsView({
  query,
  setQuery,
  filters,
  onFiltersChange,
  rows,
  filterOptions,
  summary,
  loading,
  loadError,
  page,
  pageSize,
  totalPages,
  totalCount,
  onPageChange,
  onPageSizeChange,
  onRetry,
  onViewDetails,
}) {
  const [tableSort, setTableSort] = useState(null);
  const [detailsRow, setDetailsRow] = useState(null);
  const activeFilters = filters || {};
  const setFilters = onFiltersChange || (() => {});

  // Selecting a status the table is already narrowed to clears it, so the card
  // behaves as a toggle rather than stranding the user in a one-row table.
  const toggleStatus = useCallback(
    (status) => {
      const next = { ...activeFilters };
      if (next.status === status) delete next.status;
      else next.status = status;
      setFilters(next);
    },
    [activeFilters, setFilters]
  );

  // "In Stock" belongs to the card: the highlighted card already says the table
  // is narrowed, so that status is kept out of the Filter count and the chips.
  // A status picked in the Filter dialog (e.g. Sold) still shows there as usual.
  const cardOwnsStatus = activeFilters.status === STATUS_IN_STOCK;
  const panelFilters = useMemo(() => {
    if (!cardOwnsStatus) return activeFilters;
    const { status, ...rest } = activeFilters;
    return rest;
  }, [activeFilters, cardOwnsStatus]);
  // The dialog and chips never see the card's status, so put it back on their
  // changes unless they chose a status of their own.
  const setPanelFilters = useCallback(
    (next) => {
      const value = next || {};
      setFilters(cardOwnsStatus && !value.status ? { ...value, status: STATUS_IN_STOCK } : value);
    },
    [cardOwnsStatus, setFilters]
  );

  const openDetails = useCallback((row) => setDetailsRow(row), []);
  const closeDetails = useCallback(() => setDetailsRow(null), []);

  React.useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") closeDetails();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeDetails]);

  const exportTableRows = useMemo(
    () => sortRows(rows, FG_COLUMNS, tableSort),
    [rows, tableSort]
  );

  const statusFilter = activeFilters.status || "";
  const filtersActive =
    Boolean(query.trim()) ||
    Object.values(activeFilters).some((value) => String(value ?? "").trim() !== "");

  if (loading) {
    return (
      <div className="fg-loading">
        <Loader2 size={28} className="spin" />
        <span>Loading finished goods...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="fg-load-error">
        <div>
          <span>{loadError}</span>
          <button type="button" className="fg-retry" onClick={onRetry}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="fg-empty-state">
        {filtersActive ? (
          <>
            <span>No finished goods match the current search or filter.</span>
            {/* This branch replaces the whole panel, summary cards included, so the
                status card that caused it is gone too. Clearing has to live here
                or a filter that matches nothing becomes a dead end. */}
            <button type="button" className="fg-clear-filters" onClick={() => setFilters({})}>
              Clear filters
            </button>
          </>
        ) : (
          "No finished goods records found."
        )}
      </div>
    );
  }

  const detailsModal = detailsRow && createPortal(
    <div className="fg-details-overlay" onClick={closeDetails}>
      <div
        className="fg-details-container"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Finished Goods Details"
      >
        <div className="fg-details-header">
          <h2>Finished Goods Details</h2>
          <button type="button" className="fg-details-close" onClick={closeDetails} aria-label="Close">
            <X size={22} />
          </button>
        </div>
        <div className="fg-details-body">
          <section className="fg-details-section">
            <h3>Unit Details</h3>
            <div className="fg-details-grid">
              {FG_DETAIL_FIELDS.map((field) => (
                <React.Fragment key={field.key}>
                  <div className="fg-details-label">{field.label}</div>
                  <div className={`fg-details-value${field.mono ? " mono" : ""}`}>
                    {field.isDate ? formatDate(detailsRow[field.key]) : (detailsRow[field.key] ?? "—")}
                  </div>
                </React.Fragment>
              ))}
            </div>
          </section>
        </div>
        <div className="fg-details-footer">
          <button type="button" className="fg-details-close-btn" onClick={closeDetails}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );

  return (
    <div className="fg-page">
      {/* The In Stock card is the drill-down: clicking it narrows the table to those
          units using the `status` filter the endpoint already applies, so no
          new server behaviour is involved. Sold units stay reachable through
          the Status dropdown rather than a second tile. It sits above the table
          panel, like the Min Stock cards, rather than inside it. */}
      <div className="fg-summary-row">
          <button
            type="button"
            className={`fg-summary-card in-stock${statusFilter === STATUS_IN_STOCK ? " is-active" : ""}`}
            onClick={() => toggleStatus(STATUS_IN_STOCK)}
            aria-pressed={statusFilter === STATUS_IN_STOCK}
          >
            <div className="fg-summary-icon">
              <Package size={20} />
            </div>
            <div className="fg-summary-content">
              <span className="fg-summary-label">In Stock</span>
              <span className="fg-summary-value">{summary.inStock ?? 0} units</span>
              <span className="fg-summary-detail">
                {statusFilter === STATUS_IN_STOCK ? "Showing these units · click to clear" : "Click to list these units"}
              </span>
            </div>
            <ChevronRight size={18} className="fg-summary-chevron" aria-hidden="true" />
          </button>
      </div>

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <SearchBar value={query} onChange={setQuery} placeholder="Search Finished Goods..." />
            <FilterModal rows={rows} options={filterOptions} fields={FG_FILTER_FIELDS} value={panelFilters} onChange={setPanelFilters} />
            <ActiveFilterChips fields={FG_FILTER_FIELDS} value={panelFilters} onChange={setPanelFilters} />
          </div>
          <ExportPdfButton mode="table" title="Finished Goods Inventory" columns={FG_COLUMNS} rows={exportTableRows} />
        </div>

        <DataTable
          columns={FG_COLUMNS}
          rows={rows}
          onSortChange={setTableSort}
          onViewDetails={openDetails}
          rowClassName={(row) => row.status === "Sold" ? "fg-row-sold" : "fg-row-in-stock"}
        />
      </div>

      {!loading && !loadError && rows.length > 0 && (
        <ListPagination
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          totalCount={totalCount}
          rowCount={rows.length}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}

      {detailsModal}
    </div>
  );
}