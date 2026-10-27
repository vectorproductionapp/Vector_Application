import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronRight, Loader2, PackageX, RefreshCw, TrendingUp, X } from "lucide-react";
import api from "./Api";
import ListPagination from "./ListPagination";
import { useRealtime } from "./RealtimeProvider";
import "./MinStockView.css";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
// Aggregation needs every row, not the ten a page would return.
const ALL_ROWS_LIMIT = 100000;

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Failed to load min stock overview.";
}

// The backend status is only "REORDER - BELOW MIN" or "OK", so "out of stock"
// has to come from the closing figure itself: nothing (or less) left.
function isOutOfStock(row) {
  return (Number(row.closing) || 0) <= 0;
}

function isLowStock(row) {
  if (/reorder|below|low/i.test(row.status || "")) return true;
  const minLevel = Number(row.minLevel) || 0;
  return minLevel > 0 && (Number(row.closing) || 0) <= minLevel;
}

// Pages a list in the browser; the view already holds every row. The page
// snaps back to 1 when `resetKey` changes and is clamped when the list shrinks.
function useClientPagination(items, resetKey) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  useEffect(() => setPage(1), [resetKey]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);
  return {
    pageItems,
    pagerProps: {
      page: safePage,
      pageSize,
      totalPages,
      totalCount: items.length,
      rowCount: pageItems.length,
      onPageChange: setPage,
      onPageSizeChange: (size) => {
        setPageSize(size);
        setPage(1);
      },
    },
  };
}

function rowName(row) {
  return row.desc || row.code || "Unnamed material";
}

// Full register information, same columns and order as the table view.
const DETAIL_COLUMNS = [
  { key: "phase", label: "Phase" },
  { key: "code", label: "Product Code", mono: true },
  { key: "desc", label: "Material Description" },
  { key: "make", label: "Make" },
  { key: "model", label: "Linked Finished Model" },
  { key: "reqQty", label: "Qty per Unit (BOM)", numeric: true },
  { key: "opening", label: "Opening Stock", numeric: true },
  { key: "purchased", label: "Qty Purchased (Received)", numeric: true },
  { key: "consumed", label: "Qty Consumed (Production)", numeric: true },
  { key: "closing", label: "Closing Stock", numeric: true },
  { key: "minLevel", label: "Min Stock Level (from BOQ)", numeric: true },
  { key: "status", label: "Stock Status", status: true },
  { key: "lastUpdated", label: "Last Updated" },
];

function statusTone(row) {
  if (isOutOfStock(row)) return "danger";
  return isLowStock(row) ? "warn" : "ok";
}

// Free-text search runs in the browser: this view already holds every row.
const SEARCH_KEYS = ["phase", "code", "desc", "make", "model", "status"];

function matchesSearch(row, search) {
  return SEARCH_KEYS.some((key) => String(row[key] ?? "").toLowerCase().includes(search));
}

export default function MinStockView({ onSelectRow, query = "" }) {
  const [allRows, setRows] = useState([]);
  const search = query.trim().toLowerCase();
  const rows = useMemo(
    () => (search ? allRows.filter((row) => matchesSearch(row, search)) : allRows),
    [allRows, search]
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [openCard, setOpenCard] = useState(null);

  const fetchAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const response = await api.get(`${API_BASE_URL}/stock-register`, {
        params: { page: 1, limit: ALL_ROWS_LIMIT },
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to load min stock overview");
      setRows(response.data.stockRows || []);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Same source as the table: invoice writes move closing stock.
  useRealtime(["invoices"], () => fetchAll({ silent: true }));

  const closeCard = useCallback(() => setOpenCard(null), []);

  useEffect(() => {
    if (!openCard) return undefined;
    const handleEscape = (event) => {
      if (event.key === "Escape") closeCard();
    };
    window.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [closeCard, openCard]);

  // The cards always count the whole register; the search narrows only the
  // lists below them, so typing never changes the totals.
  const stats = useMemo(() => {
    // Count of materials that came in on an invoice, not the summed quantity.
    let itemsPurchased = 0, lowCount = 0, outCount = 0;
    allRows.forEach((row) => {
      if ((Number(row.purchased) || 0) > 0) itemsPurchased += 1;
      if (isOutOfStock(row)) outCount += 1;
      else if (isLowStock(row)) lowCount += 1;
    });
    return { itemsPurchased, lowCount, outCount };
  }, [allRows]);

  const byClosing = (a, b) => (Number(a.closing) || 0) - (Number(b.closing) || 0);

  const purchasedRows = useMemo(
    () => rows.filter((row) => (Number(row.purchased) || 0) > 0).sort(byClosing),
    [rows]
  );

  const outRows = useMemo(() => rows.filter(isOutOfStock).sort(byClosing), [rows]);

  const lowRows = useMemo(
    () => rows.filter((row) => !isOutOfStock(row) && isLowStock(row)).sort(byClosing),
    [rows]
  );

  // Worst first, so the material about to block production sits at the top.
  const lowStockRows = useMemo(() => [...outRows, ...lowRows], [outRows, lowRows]);

  // What each card opens: the rows behind its number.
  const cardDetails = useMemo(
    () => ({
      purchased: {
        title: "Total Items Purchased",
        subtitle: "Materials received on an invoice",
        empty: "No materials have been purchased yet.",
        items: purchasedRows,
      },
      low: {
        title: "Low Stock",
        subtitle: "At or below the minimum stock level",
        empty: "No low stock materials right now.",
        items: lowRows,
      },
      out: {
        title: "Out of Stock",
        subtitle: "Materials with nothing left in stock",
        empty: "Nothing is out of stock.",
        items: outRows,
      },
    }),
    [lowRows, outRows, purchasedRows]
  );

  const { pageItems: pagedAlerts, pagerProps: alertPager } = useClientPagination(lowStockRows, search);
  const { pageItems: pagedDetailRows, pagerProps: detailPager } = useClientPagination(
    openCard ? cardDetails[openCard].items : [],
    openCard
  );

  if (loading) {
    return (
      <div className="minstock-loading">
        <Loader2 size={28} className="spin" />
        <span>Loading min stock details...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="minstock-load-error">
        <span>{loadError}</span>
        <button type="button" className="minstock-retry" onClick={() => fetchAll()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  const detail = openCard ? cardDetails[openCard] : null;

  const cards = [
    {
      key: "purchased",
      label: "Total Items Purchased",
      value: stats.itemsPurchased,
      Icon: TrendingUp,
      className: "minstock-card",
    },
    {
      key: "low",
      label: "Low Stock",
      value: stats.lowCount,
      Icon: AlertTriangle,
      className: "minstock-card minstock-card-warn",
    },
    {
      key: "out",
      label: "Out of Stock",
      value: stats.outCount,
      Icon: PackageX,
      className: "minstock-card minstock-card-danger",
    },
  ];

  return (
    <div className="minstock-page">
      <div className="minstock-cards">
        {cards.map(({ key, label, value, Icon, className }) => (
          <button
            type="button"
            key={key}
            className={`${className} minstock-card-btn`}
            onClick={() => setOpenCard(key)}
            aria-haspopup="dialog"
            aria-expanded={openCard === key}
          >
            <span className="minstock-card-icon"><Icon size={20} /></span>
            <span className="minstock-card-text">
              <span className="minstock-card-label">{label}</span>
              <span className="minstock-card-value">{value}</span>
            </span>
            <ChevronRight size={16} className="minstock-card-chevron" />
          </button>
        ))}
      </div>

      <div className="minstock-panel">
        <h3 className="minstock-panel-title">Low Stock Alerts</h3>
        {lowStockRows.length === 0 ? (
          <p className="minstock-hint">
            {search ? "No low stock alerts match the current search." : "Everything is comfortably stocked."}
          </p>
        ) : (
          <div className="minstock-alert-scroll">
          <ul className="minstock-alert-list">
            {pagedAlerts.map((row) => (
              <li
                className={`minstock-alert-item${isOutOfStock(row) ? " danger" : ""}`}
                key={row.code || row.desc}
                onClick={onSelectRow ? () => onSelectRow(row) : undefined}
                role={onSelectRow ? "button" : undefined}
                tabIndex={onSelectRow ? 0 : undefined}
                onKeyDown={
                  onSelectRow
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectRow(row);
                        }
                      }
                    : undefined
                }
              >
                <span className="minstock-alert-name">{rowName(row)}</span>
                <span className="minstock-alert-meta">
                  {isOutOfStock(row)
                    ? "Out of stock"
                    : `Closing: ${row.closing ?? 0} (min ${row.minLevel ?? 0})`}
                </span>
              </li>
            ))}
          </ul>
          </div>
        )}
        {lowStockRows.length > 0 && <ListPagination {...alertPager} itemLabel="alerts" />}
      </div>

      {detail && createPortal(
        <div className="minstock-modal-overlay" onClick={closeCard}>
          <div
            className="minstock-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={detail.title}
          >
            <div className="minstock-modal-header">
              <div className="minstock-modal-heading">
                <h2 className="minstock-modal-title">{detail.title}</h2>
                <p className="minstock-modal-subtitle">
                  {detail.subtitle} &middot; {detail.items.length} item{detail.items.length === 1 ? "" : "s"}
                </p>
              </div>
              <button type="button" className="minstock-modal-close" onClick={closeCard} aria-label="Close">
                <X size={22} />
              </button>
            </div>

            <div className="minstock-modal-body">
              {detail.items.length === 0 ? (
                <p className="minstock-hint">{detail.empty}</p>
              ) : (
                <div className="minstock-modal-table-card">
                  <div className="minstock-modal-table-wrap">
                    <table className="minstock-modal-table">
                      <thead>
                        <tr>
                          {DETAIL_COLUMNS.map((column) => (
                            <th key={column.key} className={column.numeric ? "numeric" : undefined} scope="col">
                              {column.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedDetailRows.map((row) => (
                          <tr key={`${row.code || ""}-${row.phase || ""}`}>
                            {DETAIL_COLUMNS.map((column) => (
                              <td
                                key={column.key}
                                className={[
                                  column.numeric ? "numeric" : "",
                                  column.mono ? "mono" : "",
                                  column.key === "closing" ? `closing ${statusTone(row)}` : "",
                                ].filter(Boolean).join(" ") || undefined}
                                data-label={column.label}
                              >
                                {column.status ? (
                                  <span className={`minstock-status ${statusTone(row)}`}>{row[column.key] ?? "—"}</span>
                                ) : (
                                  row[column.key] ?? "—"
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {detail.items.length > 0 && (
              <div className="minstock-modal-pager">
                <ListPagination {...detailPager} itemLabel="items" />
              </div>
            )}

            <div className="minstock-modal-footer">
              <button type="button" className="minstock-modal-close-btn" onClick={closeCard}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}