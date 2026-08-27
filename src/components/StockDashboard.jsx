import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, Expand, Loader2, Minimize2, PackageCheck, PackageX, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import api from "./Api";
import { useThemeColors } from "../context/ThemeContext";
import "./StockDashboard.css";
 
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
// Pulls every row for aggregation. If your backend supports a dedicated
// summary/analytics endpoint, swap this out for that instead — it'll be lighter.
const ALL_ROWS_LIMIT = 100000;
 
function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Failed to load stock overview.";
}
 
function isLowStock(row) {
  const closing = Number(row.closing) || 0;
  const minLevel = Number(row.minLevel) || 0;
  if (row.status) return /low/i.test(row.status);
  return minLevel > 0 && closing <= minLevel;
}
 
function isOutOfStock(row) {
  if (row.status) return /out/i.test(row.status);
  return (Number(row.closing) || 0) <= 0;
}
 
export default function StockDashboard() {
  const themeColors = useThemeColors();
  const statusColors = { ok: themeColors.success, low: themeColors.warning, out: themeColors.danger };
  const [expandedPanel, setExpandedPanel] = useState(null);
  const panelRefs = React.useRef({});
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const handleFullscreenChange = () => setExpandedPanel(document.fullscreenElement?.dataset?.stockPanel || null);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.body.style.overflow = expandedPanel ? "hidden" : "";
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.body.style.overflow = "";
    };
  }, [expandedPanel]);

  const toggleFullscreen = async (panel) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await panelRefs.current[panel]?.requestFullscreen();
    } catch {
      setExpandedPanel(expandedPanel === panel ? null : panel);
    }
  };
 
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await api.get(`${API_BASE_URL}/stock-register`, {
        params: { page: 1, limit: ALL_ROWS_LIMIT },
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to load stock overview");
      setRows(response.data.stockRows || []);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
 
  useEffect(() => { fetchAll(); }, [fetchAll]);
 
  const stats = useMemo(() => {
    const totalItems = rows.length;
    let totalOpening = 0, totalPurchased = 0, totalConsumed = 0, totalClosing = 0;
    let lowCount = 0, outCount = 0, okCount = 0;
 
    rows.forEach((row) => {
      totalOpening += Number(row.opening) || 0;
      totalPurchased += Number(row.purchased) || 0;
      totalConsumed += Number(row.consumed) || 0;
      totalClosing += Number(row.closing) || 0;
      if (isOutOfStock(row)) outCount += 1;
      else if (isLowStock(row)) lowCount += 1;
      else okCount += 1;
    });
 
    return { totalItems, totalOpening, totalPurchased, totalConsumed, totalClosing, lowCount, outCount, okCount };
  }, [rows]);
 
  const lowStockRows = useMemo(
    () => rows.filter((row) => isOutOfStock(row) || isLowStock(row))
      .sort((a, b) => (Number(a.closing) || 0) - (Number(b.closing) || 0))
      .slice(0, 8),
    [rows]
  );
 
  const topByClosing = useMemo(
    () => [...rows]
      .sort((a, b) => (Number(b.closing) || 0) - (Number(a.closing) || 0))
      .slice(0, 8),
    [rows]
  );
 
  if (loading) {
    return (
      <div className="dash-loading"><Loader2 size={28} className="spin" /><span>Loading stock overview...</span></div>
    );
  }
 
  if (loadError) {
    return (
      <div className="dash-load-error">
        <span>{loadError}</span>
        <button type="button" className="dash-retry" onClick={fetchAll}><RefreshCw size={14} /> Retry</button>
      </div>
    );
  }
 
  if (rows.length === 0) {
    return <div className="dash-empty-state">No stock records found.</div>;
  }
 
  const donutTotal = stats.okCount + stats.lowCount + stats.outCount || 1;
  const okPct = (stats.okCount / donutTotal) * 100;
  const lowPct = (stats.lowCount / donutTotal) * 100;
  const outPct = (stats.outCount / donutTotal) * 100;
 
  const barMax = Math.max(1, ...topByClosing.map((r) => Number(r.closing) || 0));
 
  return (
    <div className="dash-page">
      <div className="dash-cards">
        <div className="dash-card">
          <div className="dash-card-icon"><Boxes size={20} /></div>
          <div>
            <p className="dash-card-label">Total Items</p>
            <p className="dash-card-value">{stats.totalItems}</p>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-icon"><TrendingUp size={20} /></div>
          <div>
            <p className="dash-card-label">Total Purchased</p>
            <p className="dash-card-value">{stats.totalPurchased}</p>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-icon"><TrendingDown size={20} /></div>
          <div>
            <p className="dash-card-label">Total Consumed</p>
            <p className="dash-card-value">{stats.totalConsumed}</p>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-icon"><PackageCheck size={20} /></div>
          <div>
            <p className="dash-card-label">Total Closing Stock</p>
            <p className="dash-card-value">{stats.totalClosing}</p>
          </div>
        </div>
        <div className="dash-card dash-card-warn">
          <div className="dash-card-icon"><AlertTriangle size={20} /></div>
          <div>
            <p className="dash-card-label">Low Stock</p>
            <p className="dash-card-value">{stats.lowCount}</p>
          </div>
        </div>
        <div className="dash-card dash-card-danger">
          <div className="dash-card-icon"><PackageX size={20} /></div>
          <div>
            <p className="dash-card-label">Out of Stock</p>
            <p className="dash-card-value">{stats.outCount}</p>
          </div>
        </div>
      </div>
 
      <div className="dash-panels">
        <div ref={(node) => { panelRefs.current.status = node; }} data-stock-panel="status" className={`dash-panel${expandedPanel === "status" ? " dash-panel-expanded" : ""}`}>
          <div className="dash-panel-heading"><h3 className="dash-panel-title">Stock Status</h3><button type="button" className="dash-expand-btn" onClick={() => toggleFullscreen("status")} aria-label={expandedPanel === "status" ? "Exit fullscreen" : "Expand chart"}>{expandedPanel === "status" ? <><Minimize2 size={15} /> Exit Fullscreen</> : <Expand size={15} />}</button></div>
          <div className="dash-donut-row">
            <svg viewBox="0 0 42 42" className="dash-donut" role="img" aria-label="Stock status breakdown">
              <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="var(--border)" strokeWidth="6" />
              <circle
                cx="21" cy="21" r="15.915" fill="transparent"
                stroke={statusColors.ok} strokeWidth="6"
                strokeDasharray={`${okPct} ${100 - okPct}`}
                strokeDashoffset="25"
              />
              <circle
                cx="21" cy="21" r="15.915" fill="transparent"
                stroke={statusColors.low} strokeWidth="6"
                strokeDasharray={`${lowPct} ${100 - lowPct}`}
                strokeDashoffset={`${25 - okPct}`}
              />
              <circle
                cx="21" cy="21" r="15.915" fill="transparent"
                stroke={statusColors.out} strokeWidth="6"
                strokeDasharray={`${outPct} ${100 - outPct}`}
                strokeDashoffset={`${25 - okPct - lowPct}`}
              />
            </svg>
            <div className="dash-legend">
              <div className="dash-legend-item"><span className="dash-dot" style={{ background: statusColors.ok }} />OK ({stats.okCount})</div>
              <div className="dash-legend-item"><span className="dash-dot" style={{ background: statusColors.low }} />Low ({stats.lowCount})</div>
              <div className="dash-legend-item"><span className="dash-dot" style={{ background: statusColors.out }} />Out ({stats.outCount})</div>
            </div>
          </div>
        </div>
 
        <div ref={(node) => { panelRefs.current.topItems = node; }} data-stock-panel="topItems" className={`dash-panel${expandedPanel === "topItems" ? " dash-panel-expanded" : ""}`}>
          <div className="dash-panel-heading"><h3 className="dash-panel-title">Top Items by Closing Stock</h3><button type="button" className="dash-expand-btn" onClick={() => toggleFullscreen("topItems")} aria-label={expandedPanel === "topItems" ? "Exit fullscreen" : "Expand chart"}>{expandedPanel === "topItems" ? <><Minimize2 size={15} /> Exit Fullscreen</> : <Expand size={15} />}</button></div>
          <div className="dash-bars">
            {topByClosing.map((row) => {
              const value = Number(row.closing) || 0;
              const pct = Math.max(4, (value / barMax) * 100);
              return (
                <div className="dash-bar-row" key={row.code || row.desc}>
                  <span className="dash-bar-label" title={row.desc}>{row.desc || row.code}</span>
                  <div className="dash-bar-track">
                    <div className="dash-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="dash-bar-value">{value}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
 
      <div className="dash-panel">
        <h3 className="dash-panel-title">Low Stock Alerts</h3>
        {lowStockRows.length === 0 ? (
          <p className="dash-hint">Everything is comfortably stocked.</p>
        ) : (
          <ul className="dash-alert-list">
            {lowStockRows.map((row) => (
              <li className={`dash-alert-item${isOutOfStock(row) ? " danger" : ""}`} key={row.code || row.desc}>
                <span className="dash-alert-name">{row.desc || row.code}</span>
                <span className="dash-alert-meta">
                  {isOutOfStock(row) ? "Out of stock" : `Closing: ${row.closing ?? 0} (min ${row.minLevel ?? 0})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
 
