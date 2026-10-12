import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw, Table2, X } from "lucide-react";
import SearchBar from "../components/SearchBar";
import api from "../components/Api";
import { useRealtime } from "../components/RealtimeProvider";
import PageFilter from "../components/PageFilter";
import ExportPdfButton from "../components/ExportPdfButton";
import DataTable from "../components/DataTable";
import ListPagination from "../components/ListPagination";
import { sortRows } from "../utils/tableSort";
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
  const [query, setQuery] = useState("");
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });
  const [rows, setRows] = useState([]);
  const [filterOptions, setFilterOptions] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailsRow, setDetailsRow] = useState(null);
  const [highlightCode, setHighlightCode] = useState("");

  const fetchStock = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setLoading(false);
    setLoadError("");
    const pageToFetch = targetPage ?? page;
    try {
      // Search and PageFilter run on the server. Filtering here instead used to
      // match only the ten rows the API had just paged back, so a search or a
      // dropdown selection silently missed everything on the other pages.
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);
      if (pageFilter.field && pageFilter.value !== "") {
        params.append("filterField", pageFilter.field);
        params.append("filterValue", String(pageFilter.value));
      }

      const response = await api.get(`${API_BASE_URL}/stock-register?${params.toString()}`);
      if (!response.data.success) throw new Error(response.data.message || "Failed to load stock register");
      setRows(response.data.stockRows || []);
      setFilterOptions(response.data.filterOptions || {});
      const pagination = response.data.pagination || {};
      setTotalPages(pagination.totalPages || 1);
      setTotalCount(pagination.totalCount || 0);
      if (pagination.page && pagination.page !== pageToFetch) setPage(pagination.page);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, pageSize, query, pageFilter]);

  // Changing a filter has to restart at page 1, otherwise narrowing the result
  // set can leave the user parked on a page that no longer exists.
  const filterKey = `${query.trim()}|${pageFilter.field || ""}|${pageFilter.value ?? ""}`;
  const prevFilterKeyRef = useRef(filterKey);

  useEffect(() => {
    const filtersChanged = prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;
    if (filtersChanged && page !== 1) {
      setPage(1);
      return;
    }
    fetchStock({ targetPage: filtersChanged ? 1 : page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filterKey]);

  // Stock rows are derived from invoices, so invoice writes are what change
  // this page.  Read-only table: no guard, and the details modal keeps its
  // own copy of the row.
  useRealtime(["invoices"], () => fetchStock({ silent: true }));

  const openDetails = (row) => setDetailsRow(row);
  const closeDetails = useCallback(() => setDetailsRow(null), []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") closeDetails();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeDetails]);

  // Clear highlight when user changes search or filter
  useEffect(() => {
    if (query || pageFilter.value) setHighlightCode("");
  }, [query, pageFilter]);

  // The API already applied the search and PageFilter to the whole register,
  // so this is only a cheap double-check. It mirrors the API's
  // case-insensitive comparison (unlike the shared matchesPageFilter helper,
  // which is case-sensitive) so it can never hide a row the server matched.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !q || columns.some((column) => String(row[column.key] ?? "").toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (!pageFilter.field || pageFilter.value === "") return true;
      const field = STOCK_FILTER_FIELDS.find((item) => item.key === pageFilter.field);
      if (!field) return true;
      return (
        String(row[field.key] ?? "").trim().toLowerCase() ===
        String(pageFilter.value).trim().toLowerCase()
      );
    });
  }, [query, rows, pageFilter]);

  // The PageFilter dropdown draws its options from the whole register (the API
  // sends them), so a narrow page never makes the other values disappear.
  const filterOptionRows = useMemo(() => {
    const byField = {};
    Object.entries(filterOptions).forEach(([field, values]) => {
      byField[field] = (values || []).map((value) => ({ [field]: value }));
    });
    return byField;
  }, [filterOptions]);

  const filtersActive = Boolean(query.trim()) || Boolean(pageFilter.value);

  // Which column header the user sorted by. DataTable owns the interaction and
  // reports it back, so the export can be written in the order on screen.
  const [tableSort, setTableSort] = useState(null);

  const exportTableRows = useMemo(
    () => sortRows(filteredRows, columns, tableSort),
    [filteredRows, tableSort]
  );

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  return (
    <div className="stock-page">
      <div className="stock-toolbar">
        <div className="stock-view-switch" role="tablist" aria-label="Stock register view">
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="stock-view-btn active"
          >
            <Table2 size={15} /> Table View
          </button>
        </div>

      </div>

      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <SearchBar value={query} onChange={setQuery} placeholder="Search Material Stock Register..." />
            <PageFilter rows={filterOptionRows} fields={STOCK_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          </div>
          <ExportPdfButton mode="table" title="Material Stock Register" columns={columns} rows={exportTableRows} />
        </div>
        {loading ? (
          <div className="stock-loading"><Loader2 size={28} className="spin" /><span>Loading stock register...</span></div>
        ) : loadError ? (
          <div className="stock-load-error"><div><span>{loadError}</span><button type="button" className="stock-retry" onClick={() => fetchStock({ targetPage: page })}><RefreshCw size={14} /> Retry</button></div></div>
        ) : rows.length === 0 ? (
          <div className="stock-empty-state">
            {filtersActive
              ? "No material stock records match the current search or filter."
              : "No material stock records found."}
          </div>
        ) : (
          <DataTable columns={columns} rows={filteredRows} onSortChange={setTableSort} onViewDetails={openDetails} highlightCode={highlightCode} />
        )}
      </div>

      {!loading && !loadError && rows.length > 0 && (
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
      {/* )} */}
    </div>
  );
}
