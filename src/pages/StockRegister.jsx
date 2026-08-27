import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import SearchBar from "../components/SearchBar";
import api from "../components/Api";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import StockDashboard from "../components/StockDashboard";
import "./StockRegister.css";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const PAGE_SIZE = 10;

const columns = [
  { key: "phase", label: "Phase" },
  { key: "code", label: "Product Code", mono: true },
  { key: "desc", label: "Material Description" },
  { key: "make", label: "Make" },
  { key: "model", label: "Linked Finished Model" },
  { key: "reqQty", label: "Qty per Unit (BOM)" },
  { key: "opening", label: "Opening Stock" },
  { key: "purchased", label: "Qty Purchased (Received)" },
  { key: "consumed", label: "Qty Consumed (Production)" },
  { key: "closing", label: "Closing Stock" },
  { key: "minLevel", label: "Min Stock Level (from BOQ)" },
  { key: "status", label: "Stock Status" },
  { key: "lastUpdated", label: "Last Updated" },
];
const STOCK_FILTER_FIELDS = columns.filter((column) => ["phase", "make", "model", "status"].includes(column.key));

const DETAIL_FIELDS = columns;

// Add every string your backend might send for an admin-tier role.

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Failed to load stock register.";
}

// Tries several common places a role might live. Once you've confirmed the
// real shape (see console log below), this can be simplified to `user?.role`.
export default function StockRegister() {
  const isAdminView = true;

  useEffect(() => {
    // Temporary diagnostic — remove once role detection is confirmed working.
    // eslint-disable-next-line no-console
  }, []);

  // Admin/co-admin can switch between "table" and "dashboard".
  // Regular users are always on "dashboard" and never see the switch.
  const [view, setView] = useState("table");
  const effectiveView = isAdminView ? view : "dashboard";

  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailsRow, setDetailsRow] = useState(null);

  const fetchStock = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setLoading(false);
    setLoadError("");
    const pageToFetch = targetPage ?? page;
    try {
      const response = await api.get(`${API_BASE_URL}/stock-register`, {
        params: { page: pageToFetch, limit: PAGE_SIZE },
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to load stock register");
      setRows(response.data.stockRows || []);
      const pagination = response.data.pagination || {};
      setTotalPages(pagination.totalPages || 1);
      setTotalCount(pagination.totalCount || 0);
      if (pagination.page && pagination.page !== pageToFetch) setPage(pagination.page);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page]);

  // Only fetch table data for admins while they're actually on the table view.
  useEffect(() => {
    if (isAdminView && effectiveView === "table") fetchStock({ targetPage: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, isAdminView, effectiveView]);

  const openDetails = (row) => setDetailsRow(row);
  const closeDetails = useCallback(() => setDetailsRow(null), []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") closeDetails();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeDetails]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((column) => String(row[column.key] ?? "").toLowerCase().includes(q));
      return matchesSearch && matchesPageFilter(row, pageFilter, STOCK_FILTER_FIELDS);
    });
  }, [query, rows, pageFilter]);

  const goToPage = (nextPage) => {
    if (nextPage >= 1 && nextPage <= totalPages && nextPage !== page) setPage(nextPage);
  };

  // Regular users: dashboard only, no toggle, no table chrome.
  if (!isAdminView) {
    return <StockDashboard />;
  }

  return (
    <div className="stock-page">
      <div className="stock-toolbar">
        <div className="stock-view-switch" role="tablist" aria-label="Stock register view">
          <button
            type="button"
            role="tab"
            aria-selected={view === "table"}
            className={`stock-view-btn${view === "table" ? " active" : ""}`}
            onClick={() => setView("table")}
          >
            <Table2 size={15} /> Table View
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "dashboard"}
            className={`stock-view-btn${view === "dashboard" ? " active" : ""}`}
            onClick={() => setView("dashboard")}
          >
            <LayoutDashboard size={15} /> Dashboard View
          </button>
        </div>

      </div>

      {view === "dashboard" ? (
        <StockDashboard />
      ) : (
        <>
          <div className="panel">
            <div className="table-controls-row">
              <div className="table-controls-primary">
                <SearchBar value={query} onChange={setQuery} placeholder="Search Material Stock Register..." />
                <PageFilter rows={rows} fields={STOCK_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
              </div>
              <ExportPdfButton mode="table" title="Material Stock Register" columns={columns} rows={filteredRows} />
            </div>
            {loading ? (
              <div className="stock-loading"><Loader2 size={28} className="spin" /><span>Loading stock register...</span></div>
            ) : loadError ? (
              <div className="stock-load-error"><div><span>{loadError}</span><button type="button" className="stock-retry" onClick={() => fetchStock({ targetPage: page })}><RefreshCw size={14} /> Retry</button></div></div>
            ) : rows.length === 0 ? (
              <div className="stock-empty-state">No material stock records found.</div>
            ) : (
              <DataTable columns={columns} rows={filteredRows} onViewDetails={openDetails} />
            )}
          </div>

          {!loading && !loadError && rows.length > 0 && (
            <div className="stock-pagination">
              <p className="stock-hint">Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of {totalCount} rows</p>
              <div className="stock-pagination-controls">
                <button type="button" className="stock-page-btn" onClick={() => goToPage(1)} disabled={page === 1} aria-label="First page"><ChevronsLeft size={16} /></button>
                {page > 1 && <button type="button" className="stock-page-btn" onClick={() => goToPage(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /> Prev</button>}
                <span className="stock-page-current" key={page}>{page}</span>
                {page < totalPages && <button type="button" className="stock-page-btn" onClick={() => goToPage(page + 1)} aria-label="Next page">Next <ChevronRight size={16} /></button>}
                <button type="button" className="stock-page-btn" onClick={() => goToPage(totalPages)} disabled={page === totalPages} aria-label="Last page"><ChevronsRight size={16} /></button>
              </div>
            </div>
          )}

          {detailsRow && createPortal(
            <div className="stock-details-overlay" onClick={closeDetails}>
              <div
                className="stock-details-container"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Stock Details"
              >
                <div className="stock-details-header">
                  <h2>Stock Details</h2>
                  <button type="button" className="stock-details-close" onClick={closeDetails} aria-label="Close">
                    <X size={22} />
                  </button>
                </div>
                <div className="stock-details-body">
                  <section className="stock-details-section">
                    <h3>Stock Details</h3>
                    <div className="stock-details-grid">
                    {DETAIL_FIELDS.map((field) => (
                      <React.Fragment key={field.key}>
                        <div className="stock-details-label">{field.label}</div>
                        <div className={`stock-details-value${field.mono ? " mono" : ""}`}>
                          {detailsRow[field.key] ?? "—"}
                        </div>
                      </React.Fragment>
                    ))}
                    </div>
                  </section>
                </div>
                <div className="stock-details-footer">
                  <button type="button" className="stock-details-close-btn" onClick={closeDetails}>Close</button>
                </div>
              </div>
            </div>,
            document.body
          )}
        </>
      )}
    </div>
  );
}
