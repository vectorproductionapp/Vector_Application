import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Loader2, RefreshCw, X, Package, ShieldCheck } from "lucide-react";
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
  { key: "qc", label: "QC Status" },
  { key: "status", label: "Status" },
];

// Exported because the page owns the request: it has to send these fields to the
// endpoint for the dropdowns and the summary cards to change the rows at all.
export const FG_FILTER_FIELDS = FG_COLUMNS.filter((column) => ["model", "phase", "packagingStatus", "status"].includes(column.key));

// The status the endpoint assigns to a packed unit that has not been delivered
// (`stockregister.py`). Reused verbatim so the card cannot ask for a value the
// filter would reject. Sold units are still selectable in the Status dropdown.
const STATUS_IN_STOCK = "In Stock";
// QC passed but not packed yet - Daily Production's "Awaiting Packing".
const STATUS_AWAITING_PACKING = "Awaiting Packing";

// The two stock cards, matching the dashboard: "In Stock" is packed and ready
// to dispatch, "Waiting for Packing" passed QC but is not packed yet.
// `filters` is exactly what each card applies, and what the dashboard links send.
const CARD_PRESETS = {
  packed: {
    filters: { status: STATUS_IN_STOCK },
    empty: "No packed units in stock yet. Units still to be packed are under Waiting for Packing.",
  },
  qcStock: {
    filters: { status: STATUS_AWAITING_PACKING },
    empty: "No units are waiting for packing.",
  },
};

function unitCount(value) {
  return `${value} unit${Number(value) === 1 ? "" : "s"}`;
}

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
  fromDashboard = false,
}) {
  const [tableSort, setTableSort] = useState(null);
  const [detailsRow, setDetailsRow] = useState(null);
  const activeFilters = useMemo(() => filters || {}, [filters]);
  const setFilters = useMemo(() => onFiltersChange || (() => {}), [onFiltersChange]);

  // The card whose filters the table is narrowed to exactly, if any. A card is
  // highlighted only when the rows are its units, so it never claims "showing
  // these units" over a table that a different filter has emptied.
  const activeCard = useMemo(() => {
    const packaging = String(activeFilters.packagingStatus ?? "").trim().toLowerCase();
    // Older dashboard links also sent packagingStatus=Packed with In Stock.
    if (activeFilters.status === STATUS_IN_STOCK && (packaging === "" || packaging === "packed")) return CARD_PRESETS.packed;
    if (activeFilters.status === STATUS_AWAITING_PACKING && packaging === "") return CARD_PRESETS.qcStock;
    return null;
  }, [activeFilters]);

  // Clicking the highlighted card clears its filters, so it behaves as a
  // toggle; clicking the other card switches the table straight to it.
  const toggleCard = useCallback(
    (card) => {
      const { status, packagingStatus, ...rest } = activeFilters;
      setFilters(activeCard === card ? rest : { ...rest, ...card.filters });
    },
    [activeCard, activeFilters, setFilters]
  );

  // The highlighted card already says how the table is narrowed, so its
  // filters are kept out of the Filter count and the chips. Anything else
  // (e.g. a Model, or Status = Sold) still shows there as usual.
  const panelFilters = useMemo(() => {
    if (!activeCard) return activeFilters;
    const rest = { ...activeFilters };
    Object.keys(activeCard.filters).forEach((key) => delete rest[key]);
    return rest;
  }, [activeFilters, activeCard]);
  // The dialog and chips never see the card's filters, so put them back on
  // their changes unless they chose a value of their own for that field.
  const setPanelFilters = useCallback(
    (next) => {
      const value = { ...(next || {}) };
      if (activeCard) {
        Object.entries(activeCard.filters).forEach(([key, cardValue]) => {
          if (String(value[key] ?? "") === "") value[key] = cardValue;
        });
      }
      setFilters(value);
    },
    [activeCard, setFilters]
  );

  const inStockPacked = Number(summary.inStockPacked ?? 0);
  const awaitingPacking = Number(summary.awaitingPacking ?? Math.max(0, (summary.inStock ?? 0) - inStockPacked));
  const allSummaryCards = [
    {
      card: CARD_PRESETS.packed,
      Icon: Package,
      label: "In Stock",
      value: inStockPacked,
      detail: "Packing completed, ready to dispatch",
    },
    {
      card: CARD_PRESETS.qcStock,
      Icon: ShieldCheck,
      label: "Waiting for Packing",
      value: awaitingPacking,
      detail: "QC passed, packing not done yet",
    },
  ];
  // Opened from a dashboard card: show just the card that was clicked, so the
  // page answers that one figure. Clearing it brings both cards back, and
  // opening the tab directly always shows both.
  const summaryCards = fromDashboard && activeCard
    ? allSummaryCards.filter(({ card }) => card === activeCard)
    : allSummaryCards;

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

  const searchActive = Boolean(query.trim());
  const onlyCardFilters = Boolean(activeCard) && !searchActive
    && !Object.values(panelFilters).some((value) => String(value ?? "").trim() !== "");
  const filtersActive =
    searchActive ||
    Object.values(activeFilters).some((value) => String(value ?? "").trim() !== "");

  // An unmatched search is as much a dead end as an unmatched filter, so the
  // button resets both.
  const clearSearchAndFilters = () => {
    if (setQuery) setQuery("");
    setFilters({});
  };

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

  // Rendered inside the panel rather than in place of it, so the summary card,
  // Filter button and chips stay on screen and the search can still be edited.
  const emptyState = (
    <div className="fg-empty-state">
      {filtersActive ? (
        <>
          {/* A card that counts zero gets its own explanation rather than the
              generic "no match", which read like an error. */}
          <span>{onlyCardFilters ? activeCard.empty : "No finished goods match the current search or filter."}</span>
          <button type="button" className="fg-clear-filters" onClick={clearSearchAndFilters}>
            {onlyCardFilters ? "Show all finished goods" : searchActive ? "Clear search & filters" : "Clear filters"}
          </button>
        </>
      ) : (
        "No finished goods records found."
      )}
    </div>
  );

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
      {/* The stock cards are the drill-down: each one narrows the table to the
          units it counts, using filters the endpoint already applies. Sold
          units stay reachable through the Status dropdown. They sit above the
          table panel, like the Min Stock cards, rather than inside it. */}
      <div className="fg-summary-row">
        {summaryCards.map(({ card, Icon, label, value, detail }) => {
          const isActive = activeCard === card;
          return (
            <button
              key={label}
              type="button"
              className={`fg-summary-card in-stock${isActive ? " is-active" : ""}`}
              onClick={() => toggleCard(card)}
              aria-pressed={isActive}
            >
              <div className="fg-summary-icon">
                <Icon size={20} />
              </div>
              <div className="fg-summary-content">
                <span className="fg-summary-label">{label}</span>
                <span className="fg-summary-value">{unitCount(value)}</span>
                <span className="fg-summary-detail">{detail}</span>
                <span className="fg-summary-detail fg-summary-hint">
                  {isActive ? "Showing these units · click to clear" : "Click to list these units"}
                </span>
              </div>
              <ChevronRight size={18} className="fg-summary-chevron" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <FilterModal rows={rows} options={filterOptions} fields={FG_FILTER_FIELDS} value={panelFilters} onChange={setPanelFilters} />
            <ActiveFilterChips fields={FG_FILTER_FIELDS} value={panelFilters} onChange={setPanelFilters} />
          </div>
          <ExportPdfButton mode="table" title="Finished Goods Inventory" columns={FG_COLUMNS} rows={exportTableRows} />
        </div>

        {rows.length === 0 ? emptyState : (
          <DataTable
            columns={FG_COLUMNS}
            rows={rows}
            onSortChange={setTableSort}
            onViewDetails={openDetails}
            rowClassName={(row) => row.status === "Sold" ? "fg-row-sold" : "fg-row-in-stock"}
          />
        )}
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
