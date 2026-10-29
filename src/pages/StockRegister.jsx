import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import useDashboardDeepLink from "../components/useDashboardDeepLink";
import ActiveFilterChips from "../components/ActiveFilterChips";
import BackToDashboard from "../components/BackToDashboard";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw, Table2, TriangleAlert, X, Package } from "lucide-react";
import { useHeaderSearch } from "../context/HeaderSearch";
import api from "../components/Api";
import FilterModal, { countActiveFilters, toFilterParams } from "../components/FilterModal";
import MinStockView from "../components/MinStockView";
import FinishedGoodsView, { FG_FILTER_FIELDS } from "../components/FinishedGoodsView";
import { useRealtime } from "../components/RealtimeProvider";
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
  // Rows come only from invoices; this says whether the BOQ still defines the
  // material. "Not in BOQ" means the BOM line was deleted while the purchase
  // remains, which is why make/model/BOM qty are blank on that row.
  {
    key: "inBoq",
    label: "BOM",
    render: (value) => (value ? "Linked" : "Not in BOQ"),
  },
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

// Documents moved to its own sidebar page (Documents Center).
const STOCK_VIEWS = ["table", "minstock", "finishedgoods"];
const VIEW_STORAGE_KEY = "stock-register-view";

const SEARCH_PLACEHOLDERS = {
  table: "Search Material Stock Register...",
  minstock: "Search Min Stock materials...",
  finishedgoods: "Search Finished Goods...",
};

// Add every string your backend might send for an admin-tier role.

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Failed to load stock register.";
}

// Tries several common places a role might live. Once you've confirmed the
// real shape (see console log below), this can be simplified to `user?.role`.
export default function StockRegister() {
  // One entry per filterable field; a missing key means "All" for that field.
  const [rowFilters, setRowFilters] = useState({});
  const [rows, setRows] = useState([]);
  // Every matching row (the server's `allRows`) for Export Excel, so the export
  // is not limited to the page on screen.
  const [allStockRows, setAllStockRows] = useState([]);
  const [filterOptions, setFilterOptions] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailsRow, setDetailsRow] = useState(null);
  const [highlightCode, setHighlightCode] = useState("");
  // The open tab survives a page refresh: it is kept for this browser session.
  // A dashboard deep link still wins, because it sets the view after mount.
  const [view, setView] = useState(() => {
    try {
      const saved = sessionStorage.getItem(VIEW_STORAGE_KEY);
      return STOCK_VIEWS.includes(saved) ? saved : "table";
    } catch {
      return "table";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Storage blocked (private mode): the tab just resets on refresh.
    }
  }, [view]);
  // One search box, rendered in the global header next to the profile menu,
  // drives whichever tab is open. It used to feed only the Table View, so on
  // Min Stock it did nothing and Finished Goods had a second box of its own.
  // The owner is per tab, so switching tabs starts with an empty search.
  const [headerQuery, setHeaderQuery] = useHeaderSearch(
    `stock-register-${view}`,
    SEARCH_PLACEHOLDERS[view] || SEARCH_PLACEHOLDERS.table
  );
  const query = view === "table" ? headerQuery : "";
  const fgQuery = view === "finishedgoods" ? headerQuery : "";
  const minStockQuery = view === "minstock" ? headerQuery : "";
  // Only the newest request may write the table; a slower earlier response
  // (e.g. for a shorter search term) would otherwise overwrite fresh results.
  const stockRequestRef = useRef(0);
  const fgRequestRef = useRef(0);
  const [fgRows, setFgRows] = useState([]);
  const [fgAllRows, setFgAllRows] = useState([]);
  const [fgFilterOptions, setFgFilterOptions] = useState({});
  const [fgPage, setFgPage] = useState(1);
  const [fgPageSize, setFgPageSize] = useState(PAGE_SIZE);
  const [fgTotalPages, setFgTotalPages] = useState(1);
  const [fgTotalCount, setFgTotalCount] = useState(0);
  const [fgLoading, setFgLoading] = useState(false);
  const [fgLoadError, setFgLoadError] = useState("");
  const [fgSummary, setFgSummary] = useState({ inStock: 0, sold: 0, total: 0 });
  // Finished Goods filters live here rather than inside FinishedGoodsView
  // because the request is made here. They used to be view-local, so they never
  // reached the query string and the FilterModal (and the summary cards that
  // drive the same `status` filter) had no effect on the rows.
  const [fgRowFilters, setFgRowFilters] = useState({});

  // A dashboard KPI card can deep-link here: "In Stock" opens the Finished
  // Goods tab, "Materials Below Min Stock" opens Min Stock, and a `field`/`value`
  // pair narrows the table itself. Declared after `view` because it needs
  // `setView`.
  // A link that opens the Finished Goods tab carries a Finished Goods filter, so
  // it has to land in fgRowFilters, not the material table's filters. Read once:
  // the hook strips `view` from the URL after applying it.
  const [searchParams] = useSearchParams();
  const [deepLinkToFg] = useState(() => searchParams.get("view") === "finishedgoods");
  const arrivedFromDashboard = useDashboardDeepLink(
    deepLinkToFg ? FG_FILTER_FIELDS : STOCK_FILTER_FIELDS,
    (patch) => (deepLinkToFg ? setFgRowFilters : setRowFilters)((prev) => ({ ...prev, ...patch })),
    setView,
    STOCK_VIEWS
  );

  const fetchStock = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setLoading(false);
    setLoadError("");
    const pageToFetch = targetPage ?? page;
    const requestId = ++stockRequestRef.current;
    const isStale = () => requestId !== stockRequestRef.current;
    try {
      // Search and PageFilter run on the server. Filtering here instead used to
      // match only the ten rows the API had just paged back, so a search or a
      // dropdown selection silently missed everything on the other pages.
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(pageSize));
      const search = query.trim();
      if (search) params.set("q", search);
      toFilterParams(rowFilters, STOCK_FILTER_FIELDS).forEach((value, key) => params.append(key, value));

      const response = await api.get(`${API_BASE_URL}/stock-register?${params.toString()}`);
      if (isStale()) return;
      if (!response.data.success) throw new Error(response.data.message || "Failed to load stock register");
      setRows(response.data.stockRows || []);
      setAllStockRows(response.data.allRows || response.data.stockRows || []);
      setFilterOptions(response.data.filterOptions || {});
      const pagination = response.data.pagination || {};
      setTotalPages(pagination.totalPages || 1);
      setTotalCount(pagination.totalCount || 0);
      if (pagination.page && pagination.page !== pageToFetch) setPage(pagination.page);
    } catch (error) {
      if (!isStale()) setLoadError(errorMessage(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, pageSize, query, rowFilters]);

  // Changing a filter has to restart at page 1, otherwise narrowing the result
  // set can leave the user parked on a page that no longer exists.
  const filterKey = `${query.trim()}|${JSON.stringify(rowFilters)}`;
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
    if (query || countActiveFilters(rowFilters)) setHighlightCode("");
  }, [query, rowFilters]);

  // The API already applied the search and PageFilter to the whole register, so
  // the server response is authoritative.
  const filteredRows = useMemo(() => rows, [rows]);

  const filtersActive = Boolean(query.trim()) || countActiveFilters(rowFilters) > 0;

  // Which column header the user sorted by. DataTable owns the interaction and
  // reports it back, so the export can be written in the order on screen.
  const [tableSort, setTableSort] = useState(null);

  const exportTableRows = useMemo(
    () => sortRows(allStockRows, columns, tableSort),
    [allStockRows, tableSort]
  );

  // Use the same server-generated workbook as the weekly email.  The browser
  // exporter creates a basic spreadsheet; this endpoint includes the Vector
  // title block, red divider, dark headers, row styling and record total.
  const downloadStyledStockRegister = useCallback(async () => {
    const response = await api.get(`${API_BASE_URL}/alerts/weekly-stock-report/excel`, {
      responseType: "blob",
      __vectorNoDedupe: true,
    });
    const match = /filename="?([^";]+)"?/i.exec(
      response.headers?.["content-disposition"] || ""
    );
    const url = URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = match ? match[1] : "Vector-Stock-Register.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handlePageSizeChange = (nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  // Finished Goods fetch
  const fetchFinishedGoods = useCallback(async ({ silent = false, targetPage } = {}) => {
    if (!silent) setFgLoading(false);
    setFgLoadError("");
    const pageToFetch = targetPage ?? fgPage;
    const requestId = ++fgRequestRef.current;
    const isStale = () => requestId !== fgRequestRef.current;
    try {
      const params = new URLSearchParams();
      params.set("page", String(pageToFetch));
      params.set("limit", String(fgPageSize));
      const search = fgQuery.trim();
      if (search) params.set("q", search);
      // The endpoint filters the whole set server-side, then pages what is left,
      // so the summary tiles keep reporting overall counts while the table shows
      // just the selected status.
      toFilterParams(fgRowFilters, FG_FILTER_FIELDS).forEach((value, key) => params.append(key, value));
      const response = await api.get(`${API_BASE_URL}/stock-register/finished-goods?${params.toString()}`);
      if (isStale()) return;
      if (!response.data.success) throw new Error(response.data.message || "Failed to load finished goods");
      setFgRows(response.data.finishedGoods || []);
      setFgAllRows(response.data.allRows || response.data.finishedGoods || []);
      setFgFilterOptions(response.data.filterOptions || {});
      setFgSummary(response.data.summary || { inStock: 0, sold: 0, total: 0 });
      const pagination = response.data.pagination || {};
      setFgTotalPages(pagination.totalPages || 1);
      setFgTotalCount(pagination.totalCount || 0);
      if (pagination.page && pagination.page !== pageToFetch) setFgPage(pagination.page);
    } catch (error) {
      if (!isStale()) setFgLoadError(errorMessage(error));
    } finally {
      if (!silent) setFgLoading(false);
    }
  }, [fgPage, fgPageSize, fgQuery, fgRowFilters]);

  const fgFilterKey = `${fgQuery.trim()}|${JSON.stringify(fgRowFilters)}`;
  const prevFgFilterKeyRef = useRef(fgFilterKey);

  useEffect(() => {
    const filtersChanged = prevFgFilterKeyRef.current !== fgFilterKey;
    prevFgFilterKeyRef.current = fgFilterKey;
    if (filtersChanged && fgPage !== 1) {
      setFgPage(1);
      return;
    }
    fetchFinishedGoods({ targetPage: filtersChanged ? 1 : fgPage });
  }, [fgPage, fgPageSize, fgFilterKey, fetchFinishedGoods]);

  // Finished goods are derived from assembly_units + sales, so refresh on those writes
  useRealtime(["assembly_units", "sales"], () => fetchFinishedGoods({ silent: true }));

  return (
    <div className="stock-page">
      <BackToDashboard visible={arrivedFromDashboard} />
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
            aria-selected={view === "minstock"}
            className={`stock-view-btn${view === "minstock" ? " active" : ""}`}
            onClick={() => setView("minstock")}
          >
            <TriangleAlert size={15} /> Min Stock
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "finishedgoods"}
            className={`stock-view-btn${view === "finishedgoods" ? " active" : ""}`}
            onClick={() => setView("finishedgoods")}
          >
            <Package size={15} /> Finished Goods
          </button>
        </div>

      </div>

      {view === "minstock" ? (
        <MinStockView onSelectRow={openDetails} query={minStockQuery} />
      ) : view === "finishedgoods" ? (
        <FinishedGoodsView
          query={fgQuery}
          setQuery={setHeaderQuery}
          filters={fgRowFilters}
          onFiltersChange={setFgRowFilters}
          rows={fgRows}
          allRows={fgAllRows}
          filterOptions={fgFilterOptions}
          summary={fgSummary}
          loading={fgLoading}
          loadError={fgLoadError}
          page={fgPage}
          pageSize={fgPageSize}
          totalPages={fgTotalPages}
          totalCount={fgTotalCount}
          onPageChange={setFgPage}
          onPageSizeChange={setFgPageSize}
          onRetry={() => fetchFinishedGoods({ targetPage: fgPage })}
          onViewDetails={openDetails}
          fromDashboard={arrivedFromDashboard && deepLinkToFg}
        />
      ) : (
        <>
      <div className="panel">
        <div className="table-controls-row">
          <div className="table-controls-primary">
            <FilterModal rows={rows} options={filterOptions} fields={STOCK_FILTER_FIELDS} value={rowFilters} onChange={setRowFilters} />
            <ActiveFilterChips fields={STOCK_FILTER_FIELDS} value={rowFilters} onChange={setRowFilters} />
          </div>
          <ExportPdfButton
            title="Material Stock Register"
            columns={columns}
            rows={exportTableRows}
            onExport={downloadStyledStockRegister}
          />
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
        </>
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
    </div>
  );
}
