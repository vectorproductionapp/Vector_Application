import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Boxes, CircleAlert, Expand, Factory, MapPin, Minimize2, ShieldCheck, TrendingUp } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import KpiCard from "../components/KpiCard";
import DatePicker from "../components/DatePicker";
import { useThemeColors } from "../context/ThemeContext";
import api from "../components/Api";
import { useAuth } from "../context/Auth";
import "./Dashboard.css";

const KPI_DEFINITIONS = [
  { key: "inProduction", label: "Units In Production", group: "pipeline" },
  { key: "semiFinished", label: "Units Semi Finished", group: "pipeline" },
  { key: "qcInspection", label: "Under QC Inspection", group: "pipeline" },
  { key: "qcFailed", label: "QC Failed", group: "pipeline" },
  { key: "qcPassed", label: "QC Passed (Total)", group: "pipeline" },
  { key: "packed", label: "Packed (Ready to Dispatch)", group: "outcome" },
  { key: "sold", label: "Units Sold", group: "outcome" },
  { key: "salesValue", label: "Total Sales Value (INR)", group: "outcome", currency: true },
  { key: "defects", label: "Defective Units Reported", group: "outcome" },
  { key: "reorder", label: "Materials Below Min Stock", group: "outcome" },
];
const EMPTY_SALES_DASHBOARD = { kpis: { sold: 0, salesValue: 0 } };

const PRODUCTION_KPI_KEYS = new Set(["inProduction", "semiFinished", "qcInspection", "qcFailed", "qcPassed", "packed", "defects"]);
const EMPTY_KPIS = {
  inProduction: 0, semiFinished: 0, qcInspection: 0, qcFailed: 0,
  qcPassed: 0, packed: 0, sold: 0, salesValue: 0, defects: 0, reorder: 0,
};

function summarizeDefectiveParts(defects = []) {
  const counts = defects.reduce((result, defect) => {
    const part = String(defect?.part || "Unspecified").trim() || "Unspecified";
    result[part] = (result[part] || 0) + 1;
    return result;
  }, {});
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function getContrastBarColor(index, chartTheme) {
  const palette = chartTheme.palette?.length
    ? chartTheme.palette.slice(0, 3)
    : [chartTheme.accent, chartTheme.accentHover];
  return palette[index % palette.length];
}

function getBarColorOpacity(index) {
  const intensity = [1, 0.76, 0.88];
  return intensity[Math.floor(index / 3) % intensity.length];
}

function DashboardFilterSelect({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) || options[0];
  return (
    <div className="dashboard-filter-select">
      <span>{label}</span>
      <button type="button" className="dashboard-filter-select-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {selected.label}<span className="dashboard-filter-chevron" />
      </button>
      {open && <div className="dashboard-filter-select-menu" data-filter={label.toLowerCase()} role="listbox">
        {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
      </div>}
    </div>
  );
}

export default function Dashboard() {
  const captureRef = useRef(null);
  const chartTheme = useThemeColors();
  const [dashboard, setDashboard] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const { role } = useAuth();
  const dashboardCacheKey = `vector_dashboard_v2_${role || "guest"}`;
  const isRegularUser = role === "user";
  const isProductionIncharge = role === "production_incharge";
  const isProductionOnly = role === "user" || role === "production_incharge";
  const canViewSalesValue = role === "admin" || role === "coadmin";
  const [activeView, setActiveView] = useState("production");
  const [qcRange, setQcRange] = useState("daily");
  const [userActivity, setUserActivity] = useState("qc");
  const [qcFromDate, setQcFromDate] = useState("");
  const [qcToDate, setQcToDate] = useState("");
  const [qcUserFilter, setQcUserFilter] = useState("all");
  const [locationYear, setLocationYear] = useState("all");
  const [locationMonth, setLocationMonth] = useState("all");
  const [clientYear, setClientYear] = useState("all");
  const [clientMonth, setClientMonth] = useState("all");
  const [dispatchYear, setDispatchYear] = useState("all");
  const [modelYear, setModelYear] = useState("all");
  const [salesModel, setSalesModel] = useState("all");
  const [productionYear, setProductionYear] = useState("all");
  const [productionMonth, setProductionMonth] = useState("all");
  const [productionUser, setProductionUser] = useState("all");
  const [expandedChart, setExpandedChart] = useState(null);
  const chartRefs = useRef({});

  useEffect(() => {
    if (isProductionOnly && activeView !== "production") setActiveView("production");
  }, [isProductionOnly, activeView]);

  useEffect(() => {
    document.body.style.overflow = expandedChart ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [expandedChart]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement;
      setExpandedChart(active?.dataset?.chartKey || null);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleChartFullscreen = async (chartKey) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await chartRefs.current[chartKey]?.requestFullscreen();
    } catch {
      setExpandedChart(expandedChart === chartKey ? null : chartKey);
    }
  };

  useEffect(() => {
    let cancelled = false;

    try {
      const cached = sessionStorage.getItem(dashboardCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.data) {
          setDashboard(parsed.data);
          setIsLoading(false);
        }
      }
    } catch {
      // A cache miss or malformed browser storage must never block loading.
    }

    const loadDashboard = async () => {
      try {
        const response = await api.get("/dashboard");
        let dashboardData = response.data;

        // Compatibility fallback for a running backend that still returns a
        // user-scoped empty defect summary. The shared graph must show the
        // same aggregate defect records for every dashboard role.
        if (isRegularUser && !(dashboardData.defectiveParts || []).length) {
          try {
            const defectsResponse = await api.get("/defects");
            const defectiveParts = summarizeDefectiveParts(defectsResponse.data.defects || []);
            dashboardData = { ...dashboardData, defectiveParts };
          } catch {
            // Keep the dashboard usable if the fallback endpoint is unavailable.
          }
        }

        if (!cancelled) {
          setDashboard(dashboardData);
          try { sessionStorage.setItem(dashboardCacheKey, JSON.stringify({ data: dashboardData, savedAt: Date.now() })); } catch {}
          setLoadError(false);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadDashboard();
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadDashboard();
    }, 30000);
    return () => { cancelled = true; window.clearInterval(refreshTimer); };
  }, [isRegularUser, dashboardCacheKey]);

  const liveKpis = dashboard?.kpis || EMPTY_KPIS;
  const salesDashboard = activeView === "customerSales"
    ? (dashboard?.customerSales || EMPTY_SALES_DASHBOARD)
    : dashboard;
  const salesKpis = salesDashboard?.kpis || EMPTY_KPIS;
  const kpis = useMemo(
    () => KPI_DEFINITIONS.map((kpi) => ({ ...kpi, value: liveKpis[kpi.key] ?? 0 })),
    [liveKpis]
  );
  const pieData = useMemo(
    () => (dashboard?.defectiveParts || []).map((part, index) => ({
      name: part.name,
      value: part.count,
      color: chartTheme.palette?.[index % chartTheme.palette.length] || chartTheme.accent,
    })),
    [dashboard, chartTheme]
  );
  const salesValue = salesDashboard?.kpis?.salesValue ?? 0;
  const isWithinDateRange = (period, fromDate, toDate) => {
    const normalized = String(period || "").slice(0, 10);
    return (!fromDate || normalized >= fromDate) && (!toDate || normalized <= toDate);
  };
  const locationSales = useMemo(() => {
    const source = salesDashboard?.locationSalesByDay;
    const totals = (source || []).reduce((result, item) => {
      const period = String(item.period || "");
      if (locationYear !== "all" && !period.startsWith(locationYear)) return result;
      if (locationMonth !== "all" && period.slice(5, 7) !== locationMonth) return result;
      const group = item.location || "Unspecified";
      result[group] = (result[group] || 0) + Number(item.units || 0);
      return result;
    }, {});
    return Object.entries(totals).map(([group, units]) => ({ group, units }));
  }, [salesDashboard, locationYear, locationMonth]);
  const salesLocationCount = locationSales.length;
  const locationYears = useMemo(() => {
    const years = new Set(["2025", ...(salesDashboard?.locationSalesByDay || []).map((item) => String(item.period || "").slice(0, 4)).filter(Boolean)]);
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [salesDashboard]);
  const clientSales = useMemo(() => {
    const totals = (salesDashboard?.clientSalesByDay || []).reduce((result, item) => {
      const period = String(item.period || "");
      if (clientYear !== "all" && !period.startsWith(clientYear)) return result;
      if (clientMonth !== "all" && period.slice(5, 7) !== clientMonth) return result;
      result[item.client] = (result[item.client] || 0) + Number(item.units || 0);
      return result;
    }, {});
    return Object.entries(totals)
      .map(([client, units]) => ({ client: client || "Unspecified", units }))
      .sort((a, b) => b.units - a.units || a.client.localeCompare(b.client));
  }, [salesDashboard, clientYear, clientMonth]);
  const clientSalesTotal = clientSales.reduce((total, item) => total + item.units, 0);
  const hasUsefulClientSalesData = activeView === "customerSales"
    ? clientSales.length > 0
    : clientSales.length > 0 && clientSalesTotal >= 4;
  const salesModels = useMemo(() => {
    // Include model names saved on sales as well as the master model list.
    // This keeps the trend visible for valid historical sales whose saved
    // model text does not exactly match the current master record.
    const masterModels = salesDashboard?.modelNames || [];
    const salesModelsFromData = (salesDashboard?.salesByModelMonth || []).map((item) => item.model);
    return Array.from(new Set([...masterModels, ...salesModelsFromData].filter(Boolean)))
      .sort((a, b) => String(a).localeCompare(String(b)));
  }, [salesDashboard]);
  const visibleSalesModels = salesModel === "all" ? salesModels : salesModels.filter((model) => model === salesModel);
  const monthlyDispatchedTrend = useMemo(() => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const totals = Array(12).fill(0);
    (salesDashboard?.salesByMonth || []).forEach((item) => {
      const period = String(item.period || "");
      if (dispatchYear !== "all" && !period.startsWith(dispatchYear)) return;
      const monthIndex = Number(period.slice(5, 7)) - 1;
      if (monthIndex >= 0 && monthIndex < 12) totals[monthIndex] += Number(item.units || 0);
    });
    return monthNames.map((month, index) => ({ month, units: totals[index] }));
  }, [salesDashboard, dispatchYear]);
  const salesTrend = useMemo(() => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const rows = monthNames.map((month) => ({
      month,
      ...Object.fromEntries(visibleSalesModels.map((model) => [model, 0])),
    }));
    (salesDashboard?.salesByModelMonth || []).forEach((item) => {
      const period = String(item.period || "");
      if (modelYear !== "all" && !period.startsWith(modelYear)) return;
      if (salesModel !== "all" && item.model !== salesModel) return;
      const monthIndex = Number(period.slice(5, 7)) - 1;
      if (monthIndex >= 0 && monthIndex < 12) rows[monthIndex][item.model] = (rows[monthIndex][item.model] || 0) + Number(item.units || 0);
    });
    return rows;
  }, [salesDashboard, modelYear, salesModel, visibleSalesModels]);
  const dispatchedRealPointCount = monthlyDispatchedTrend.filter((item) => Number(item.units || 0) > 0).length;
  const modelTrendRealPointCount = salesTrend.filter((row) => visibleSalesModels.some((model) => Number(row[model] || 0) > 0)).length;
  const productionMonthCharts = useMemo(() => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const assembled = monthNames.map((month) => ({ month, units: 0 }));
    const qc = monthNames.map((month) => ({ month, Passed: 0, "Under Inspection": 0, Pending: 0, Failed: 0 }));
    const packaged = monthNames.map((month) => ({ month, Pending: 0, "In Progress": 0, Packed: 0 }));
    const matchesProductionPeriod = (period, user) => (productionYear === "all" || String(period).startsWith(productionYear)) && (productionMonth === "all" || String(period).slice(5, 7) === productionMonth) && (productionUser === "all" || user === productionUser);
    (dashboard?.assembledByMonthUser || []).forEach(({ period, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12) assembled[index].units += Number(units || 0); });
    (dashboard?.qcByMonthStatusUser || []).forEach(({ period, status, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12 && status in qc[index]) qc[index][status] += Number(units || 0); });
    (dashboard?.packagedByMonthStatusUser || []).forEach(({ period, status, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12 && status in packaged[index]) packaged[index][status] += Number(units || 0); });
    return { assembled, qc, packaged };
  }, [dashboard, productionYear, productionMonth, productionUser]);
  const productionYears = useMemo(() => Array.from(new Set(["2025", ...[
    ...(dashboard?.assembledByMonth || []), ...(dashboard?.qcByMonthStatus || []), ...(dashboard?.packagedByMonthStatus || []),
  ].map((item) => String(item.period || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))])).sort().reverse(), [dashboard]);
  const productionUsers = useMemo(() => Array.from(new Set([...(dashboard?.assembledByMonthUser || []), ...(dashboard?.qcByMonthStatusUser || []), ...(dashboard?.packagedByMonthStatusUser || [])].map((item) => item.user).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [dashboard]);
  const productionFilterControls = <>{!isRegularUser && <DashboardFilterSelect label="User" value={productionUser} onChange={setProductionUser} options={[{ value: "all", label: "All users" }, ...productionUsers.map((user) => ({ value: user, label: user }))]} />}<DashboardFilterSelect label="Year" value={productionYear} onChange={setProductionYear} options={[{ value: "all", label: "All years" }, ...productionYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={productionMonth} onChange={setProductionMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="btn btn-secondary chart-clear-filter" onClick={() => { setProductionUser("all"); setProductionYear("all"); setProductionMonth("all"); }}>Clear filters</button></>;
  const qcUserData = useMemo(() => {
    const sources = {
      qc: qcRange === "daily" ? dashboard?.qcByUserDay : dashboard?.qcByUserWeek,
      assembled: qcRange === "daily" ? dashboard?.assembledByUserDay : dashboard?.assembledByUserWeek,
      packaged: qcRange === "daily" ? dashboard?.packagedByUserDay : dashboard?.packagedByUserWeek,
    };
    const source = sources[userActivity];
    const totals = (source || []).reduce((result, item) => {
      if (!isWithinDateRange(item.period, qcFromDate, qcToDate)) return result;
      if (qcUserFilter !== "all" && item.user !== qcUserFilter) return result;
      result[item.user] = (result[item.user] || 0) + Number(item.units || 0);
      return result;
    }, {});
    return Object.entries(totals).map(([user, units]) => ({ user, units }));
  }, [dashboard, qcRange, userActivity, qcFromDate, qcToDate, qcUserFilter]);
  const qcUsers = useMemo(() => Array.from(new Set([
    ...(dashboard?.qcByUserDay || []), ...(dashboard?.qcByUserWeek || []),
    ...(dashboard?.assembledByUserDay || []), ...(dashboard?.assembledByUserWeek || []),
    ...(dashboard?.packagedByUserDay || []), ...(dashboard?.packagedByUserWeek || []),
  ].map((item) => item.user).filter(Boolean))).sort(), [dashboard]);
  const formattedSalesValue = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(salesValue);
  const chartHasData = (rows, keys) => rows.some((row) => keys.some((key) => Number(row[key] || 0) > 0));
  const hasAssemblyData = chartHasData(productionMonthCharts.assembled, ["units"]);
  // Issue 3: sparse assembly periods use bars; trend lines start at three real observations.
  const assemblyDataPoints = productionMonthCharts.assembled.filter((item) => Number(item.units || 0) > 0);
  const hasQcData = chartHasData(productionMonthCharts.qc, ["Passed", "Under Inspection", "Pending", "Failed"]);
  const hasPackagingData = chartHasData(productionMonthCharts.packaged, ["Pending", "In Progress", "Packed"]);
  const metricRelationships = `${liveKpis.packed ?? 0} ready from ${liveKpis.qcPassed ?? 0} QC-passed units`;
  const chartEmptyState = (label) => (
    <div className="chart-empty-state" role="status">
      <span className="chart-empty-state-icon" aria-hidden="true"><Boxes size={18} /></span>
      <strong>No {label.toLowerCase()} data yet</strong>
      <span>Activity will appear here as production records are added for the selected period.</span>
    </div>
  );

  const renderDefectiveItemsChart = (chartKey) => (
    <div ref={(node) => { chartRefs.current[chartKey] = node; }} data-chart-key={chartKey} className={`panel chart-panel${expandedChart === chartKey ? " chart-panel-expanded" : ""}`}>
      <div className="chart-heading"><div><span>Quality watch</span><h3 className="panel-title">Defective parts breakdown</h3></div><div className="chart-heading-actions"><CircleAlert size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen(chartKey)} aria-label={expandedChart === chartKey ? "Exit fullscreen" : "Expand chart"}>{expandedChart === chartKey ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
      {pieData.length ? <>
        <div className="chart-scroll"><div className="chart-scroll-inner chart-scroll-inner-pie"><ResponsiveContainer width="100%" height={expandedChart === chartKey ? 650 : 280}>
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3}>
              {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
            </Pie>
            <Tooltip contentStyle={chartTheme.tooltip} />
          </PieChart>
        </ResponsiveContainer></div></div>
        <ul className="legend">
          {pieData.map((part) => (
            <li key={part.name}><span className="legend-dot" style={{ background: part.color }} />{part.name} <b>{part.value}</b></li>
          ))}
        </ul>
      </> : <p className="dashboard-empty-chart">No defective items recorded.</p>}
    </div>
  );

  if (isLoading && !dashboard) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-skeleton" role="status" aria-live="polite" aria-label="Loading dashboard">
          <span className="sr-only">Loading dashboard data</span>
          <div className="dashboard-skeleton-hero">
            {[0, 1, 2].map((item) => <span className="dashboard-skeleton-stat skeleton-shimmer" key={item} />)}
          </div>
          <div className="dashboard-skeleton-grid">
            {[0, 1, 2, 3, 4].map((item) => <span className="dashboard-skeleton-card skeleton-shimmer" key={item} />)}
          </div>
          <div className="dashboard-skeleton-charts">
            <span className="dashboard-skeleton-chart skeleton-shimmer" />
            <span className="dashboard-skeleton-chart skeleton-shimmer" />
          </div>
          <small>Preparing the latest production and sales information…</small>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page" ref={captureRef}>
      <header className="dashboard-page-header">
        <div>
          <p className="dashboard-eyebrow-label">Operations control</p>
          <h2 className="dashboard-page-heading">Production &amp; sales overview</h2>
        </div>
        <div className="dashboard-tabs" data-active={activeView} data-single={isProductionOnly} role="tablist" aria-label="Dashboard views">
          <button className={`dashboard-tab${activeView === "production" ? " active" : ""}`} onClick={() => setActiveView("production")} role="tab" aria-selected={activeView === "production"}><Factory size={16} /> Production</button>
          {!isProductionOnly && <button className={`dashboard-tab${activeView === "sales" ? " active" : ""}`} onClick={() => setActiveView("sales")} role="tab" aria-selected={activeView === "sales"}><TrendingUp size={16} /> Vector Sales</button>}
          {!isProductionOnly && <button className={`dashboard-tab${activeView === "customerSales" ? " active" : ""}`} onClick={() => setActiveView("customerSales")} role="tab" aria-selected={activeView === "customerSales"}><TrendingUp size={16} /> O2K Sales</button>}
        </div>
      </header>
      <section className="dashboard-summary" aria-labelledby="operations-summary-title">
        <h2 id="operations-summary-title" className="sr-only">Operations summary</h2>
        <div className={`dashboard-summary-grid${activeView === "production" ? " dashboard-summary-grid--production" : ""}`} aria-label="Operations highlights">
          {activeView === "production" ? <>
            <article className="summary-card summary-card--neutral"><span className="summary-card-icon"><Factory size={19} /></span><div><small>Active production</small><strong>{liveKpis.inProduction ?? 0} units</strong><em>Across current work orders</em></div></article>
            <article className="summary-card summary-card--hero summary-card--success"><div className="summary-card-content"><div><small>Quality clearance</small><strong>{dashboard?.qualityPassRate ?? 0}%</strong><em>Pass rate across all completed inspections</em></div><span className="summary-card-icon"><ShieldCheck size={22} /></span></div></article>
            <article className="summary-card summary-card--success"><span className="summary-card-icon"><Boxes size={19} /></span><div><small>Ready to dispatch</small><strong>{liveKpis.packed ?? 0} units</strong><em>{metricRelationships}</em></div></article>
          </> : <>
            <div className="dashboard-hero-stat"><span className="dashboard-stat-icon"><TrendingUp size={18} /></span><div><small>Units sold</small><strong>{salesKpis.sold ?? 0} units</strong><em>Dispatched sales</em></div></div>
            <div className="dashboard-hero-stat"><span className="dashboard-stat-icon gold"><ArrowUpRight size={18} /></span><div><small>Sales value</small><strong>{canViewSalesValue ? formattedSalesValue : "Restricted"}</strong><em>Recorded sales total</em></div></div>
            <div className="dashboard-hero-stat"><span className="dashboard-stat-icon"><MapPin size={18} /></span><div><small>Dispatch network</small><strong>{salesLocationCount} cities</strong><em>Currently receiving shipments</em></div></div>
          </>}
        </div>
        {activeView === "production" && <div className="snapshot-in-hero">
          {kpis.filter((kpi) => PRODUCTION_KPI_KEYS.has(kpi.key) && !["inProduction", "packed"].includes(kpi.key)).map((kpi) => <KpiCard key={kpi.key} kpi={kpi} />)}
        </div>}
      </section>

      {/* <div className="dashboard-toolbar">
        <p className="dashboard-subtitle">{loadError ? "Live dashboard data is temporarily unavailable." : dashboard ? activeView === "production" ? "Live production, quality, and packing information." : activeView === "customerSales" ? "Live customer sales and dispatch information." : "Live Vector sales and dispatch information." : "Loading dashboard data..."}</p>
        {activeView !== "production" && canViewSalesValue && <div className="dashboard-value-chip"><ArrowUpRight size={15} /> {formattedSalesValue} sales value</div>}
      </div> */}

      {activeView === "production" && (<section className={`section${isRegularUser ? " user-production-dashboard" : ""}`} aria-labelledby="production-analytics-title">
        <div className="production-analytics-header"><div><p className="dashboard-eyebrow-label">Live reporting</p><h2 id="production-analytics-title" className="dashboard-section-title">Production analytics</h2></div><div className="dashboard-filter-bar">{productionFilterControls}</div></div>
        <div className={`chart-grid production-monthly-chart-grid${isProductionIncharge ? " production-incharge-chart-grid" : ""}`}>
          <div ref={(node) => { chartRefs.current.monthlyAssembled = node; }} data-chart-key="monthlyAssembled" className={`panel chart-panel${expandedChart === "monthlyAssembled" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Assembly output</span><h3 className="panel-title">Monthly units assembled</h3></div><div className="chart-heading-actions"><Factory size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyAssembled")} aria-label={expandedChart === "monthlyAssembled" ? "Exit fullscreen" : "Expand assembly chart"}>{expandedChart === "monthlyAssembled" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{hasAssemblyData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyAssembled" ? 650 : 280}>{assemblyDataPoints.length < 3 ? <BarChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Bar dataKey="units" name="Assembled units" fill={chartTheme.accent} radius={[7, 7, 0, 0]} /></BarChart> : <LineChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Line type="monotone" dataKey="units" name="Assembled units" stroke={chartTheme.accent} strokeWidth={3} dot={{ r: 3, fill: chartTheme.accentHover }} activeDot={{ r: 6 }} /></LineChart>}</ResponsiveContainer> : chartEmptyState("assembly output")}</div>
          <div ref={(node) => { chartRefs.current.monthlyQc = node; }} data-chart-key="monthlyQc" className={`panel chart-panel${expandedChart === "monthlyQc" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Quality control</span><h3 className="panel-title">Monthly QC status</h3></div><div className="chart-heading-actions"><ShieldCheck size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyQc")} aria-label={expandedChart === "monthlyQc" ? "Exit fullscreen" : "Expand quality control chart"}>{expandedChart === "monthlyQc" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{hasQcData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyQc" ? 650 : 280}><BarChart data={productionMonthCharts.qc} margin={{ top: 16, right: 16, left: 8, bottom: 20 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="Passed" stackId="qc" fill={chartTheme.success} /><Bar dataKey="Under Inspection" stackId="qc" fill={chartTheme.accent} /><Bar dataKey="Pending" stackId="qc" fill={chartTheme.muted} /><Bar dataKey="Failed" stackId="qc" fill={chartTheme.danger} /></BarChart></ResponsiveContainer> : chartEmptyState("quality control")}</div>
          <div ref={(node) => { chartRefs.current.monthlyPackaging = node; }} data-chart-key="monthlyPackaging" className={`panel chart-panel${expandedChart === "monthlyPackaging" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Packaging</span><h3 className="panel-title">Monthly packaging status</h3></div><div className="chart-heading-actions"><Boxes size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyPackaging")} aria-label={expandedChart === "monthlyPackaging" ? "Exit fullscreen" : "Expand packaging chart"}>{expandedChart === "monthlyPackaging" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{hasPackagingData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyPackaging" ? 650 : 280}><BarChart data={productionMonthCharts.packaged} margin={{ top: 16, right: 16, left: 8, bottom: 20 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="Pending" stackId="pack" fill={chartTheme.muted} /><Bar dataKey="In Progress" stackId="pack" fill={chartTheme.warning} /><Bar dataKey="Packed" stackId="pack" fill={chartTheme.success} /></BarChart></ResponsiveContainer> : chartEmptyState("packaging")}</div>
          {isProductionIncharge && renderDefectiveItemsChart("quality")}
        </div>
        <div className={`chart-grid ${activeView !== "production" ? "sales-chart-grid" : "production-chart-grid"}`}>
          {!isRegularUser && !isProductionIncharge && <div ref={(node) => { chartRefs.current.workload = node; }} data-chart-key="workload" className={`panel chart-panel${expandedChart === "workload" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>{activeView === "production" ? "User activity" : "Distribution"}</span><h3 className="panel-title">{activeView === "production" ? `${userActivity === "assembled" ? "Assembled" : userActivity === "packaged" ? "Packaged" : "QC tested"} by user` : "Units dispatched by location"}</h3></div><div className="chart-heading-actions">{activeView === "production" ? <><div className="dashboard-range-switch chart-range-switch"><button type="button" className={userActivity === "assembled" ? "active" : ""} onClick={() => setUserActivity("assembled")}>Assembled</button><button type="button" className={userActivity === "qc" ? "active" : ""} onClick={() => setUserActivity("qc")}>QC</button><button type="button" className={userActivity === "packaged" ? "active" : ""} onClick={() => setUserActivity("packaged")}>Packaged</button></div><div className="dashboard-range-switch chart-range-switch"><button type="button" className={qcRange === "daily" ? "active" : ""} onClick={() => setQcRange("daily")}>Daily</button><button type="button" className={qcRange === "weekly" ? "active" : ""} onClick={() => setQcRange("weekly")}>Weekly</button></div><Factory size={18} /></> : <MapPin size={18} />}<button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("workload")} aria-label={expandedChart === "workload" ? "Exit fullscreen" : "Expand chart"}>{expandedChart === "workload" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {activeView === "production" && <div className="chart-filter-row">{!isRegularUser && <DashboardFilterSelect label="User" value={qcUserFilter} onChange={setQcUserFilter} options={[{ value: "all", label: "All users" }, ...qcUsers.map((user) => ({ value: user, label: user }))]} />}<div className="chart-date-filter"><label>From <DatePicker value={qcFromDate} onChange={setQcFromDate} ariaLabel="Select filter start date" /></label><label>To <DatePicker value={qcToDate} onChange={setQcToDate} ariaLabel="Select filter end date" /></label></div><button type="button" className="chart-clear-filter" onClick={() => { setQcRange("daily"); setQcUserFilter("all"); setQcFromDate(""); setQcToDate(""); }}>Clear filters</button></div>}
            <div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: (activeView === "production" ? qcUserData : locationSales).length > 8 ? `${(activeView === "production" ? qcUserData : locationSales).length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "workload" ? 650 : 280}>
              <BarChart data={activeView === "production" ? qcUserData : locationSales} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis dataKey={activeView === "production" ? "user" : "location"} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} angle={qcUserData.length > 8 && activeView === "production" ? -35 : 0} textAnchor={qcUserData.length > 8 && activeView === "production" ? "end" : "middle"} height={qcUserData.length > 8 && activeView === "production" ? 70 : 30} />
                <YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} />
                <Tooltip contentStyle={chartTheme.tooltip} cursor={{ fill: chartTheme.cursor }} />
                <Bar dataKey="units" radius={[7, 7, 0, 0]}>
                  {(activeView === "production" ? qcUserData : locationSales).map((entry, index) => (
                    <Cell
                      key={`${activeView === "production" ? entry.user : entry.location}-${index}`}
                      fill={getContrastBarColor(index, chartTheme)}
                      fillOpacity={getBarColorOpacity(index)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></div></div>
          </div>}

          {!isProductionIncharge && renderDefectiveItemsChart("quality")}

          {!isRegularUser && !isProductionIncharge && <div ref={(node) => { chartRefs.current.location = node; }} data-chart-key="location" className={`panel chart-panel${expandedChart === "location" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Distribution</span><h3 className="panel-title">Units dispatched by location</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={locationYear} onChange={setLocationYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={locationMonth} onChange={setLocationMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setLocationYear("all"); setLocationMonth("all"); }}>Clear filters</button><MapPin size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("location")} aria-label={expandedChart === "location" ? "Exit fullscreen" : "Expand chart"}>{expandedChart === "location" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            <div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: locationSales.length > 8 ? `${locationSales.length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "location" ? 650 : 280}>
              <BarChart data={locationSales} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="group" tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} cursor={{ fill: chartTheme.cursor }} /><Bar dataKey="units" radius={[7, 7, 0, 0]}>{locationSales.map((entry, index) => <Cell key={`${entry.group}-${index}`} fill={getContrastBarColor(index, chartTheme)} fillOpacity={getBarColorOpacity(index)} />)}</Bar></BarChart>
            </ResponsiveContainer></div></div>
          </div>}
        </div>
      </section>)}
      {(activeView === "sales" || activeView === "customerSales") && <section className="section sales-analytics-section">
        
        <div className="chart-grid sales-chart-grid">
          {activeView !== "sales" && <div ref={(node) => { chartRefs.current.salesClient = node; }} data-chart-key="salesClient" className={`panel chart-panel${expandedChart === "salesClient" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Sales distribution</span><h3 className="panel-title">Units dispatched by client</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={clientYear} onChange={setClientYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={clientMonth} onChange={setClientMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setClientYear("all"); setClientMonth("all"); }}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesClient")} aria-label={expandedChart === "salesClient" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesClient" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {hasUsefulClientSalesData ? <><div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: clientSales.length > 8 ? `${clientSales.length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "salesClient" ? 650 : 280}><BarChart data={clientSales} margin={{ top: 8, right: 8, left: 6, bottom: 18 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="client" label={{ value: "Client", position: "insideBottom", offset: -10, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Units dispatched"]} cursor={{ fill: chartTheme.cursor }} /><Bar dataKey="units" radius={[7, 7, 0, 0]}>{clientSales.map((entry, index) => <Cell key={`${entry.client}-${index}`} fill={getContrastBarColor(index, chartTheme)} fillOpacity={getBarColorOpacity(index)} />)}</Bar></BarChart></ResponsiveContainer></div></div></> : <div className="dashboard-empty-chart dashboard-low-data"><span aria-hidden="true">▥</span><strong>{clientSales.length ? "Not enough activity yet this period" : "No dispatch activity yet"}</strong><p>{clientSales.length ? "Record at least four dispatched units to reveal a meaningful client comparison." : "Client dispatches will appear here once sales are recorded."}</p></div>}
          </div>}
          <div ref={(node) => { chartRefs.current.salesDispatchTrend = node; }} data-chart-key="salesDispatchTrend" className={`panel chart-panel${expandedChart === "salesDispatchTrend" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Dispatch trend</span><h3 className="panel-title">Monthly dispatched units</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={dispatchYear} onChange={setDispatchYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><button type="button" className="chart-clear-filter" onClick={() => setDispatchYear("all")}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesDispatchTrend")} aria-label={expandedChart === "salesDispatchTrend" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesDispatchTrend" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            <ResponsiveContainer width="100%" height={expandedChart === "salesDispatchTrend" ? 650 : 280}>{dispatchedRealPointCount < 3 ? <BarChart data={monthlyDispatchedTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="units" name="Dispatched units" fill={chartTheme.accentActive} radius={[7, 7, 0, 0]} /></BarChart> : <LineChart data={monthlyDispatchedTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Line type="linear" dataKey="units" name="Dispatched units" stroke={chartTheme.accentActive} strokeWidth={3} dot={{ r: 4, fill: chartTheme.accent, stroke: chartTheme.surface, strokeWidth: 2 }} activeDot={{ r: 6 }} /></LineChart>}</ResponsiveContainer>
          </div>
          {activeView !== "customerSales" && <div ref={(node) => { chartRefs.current.salesModelTrend = node; }} data-chart-key="salesModelTrend" className={`panel chart-panel${expandedChart === "salesModelTrend" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Sales trend</span><h3 className="panel-title">Monthly units by model</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={modelYear} onChange={setModelYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Model" value={salesModel} onChange={setSalesModel} options={[{ value: "all", label: "All models" }, ...salesModels.map((model) => ({ value: model, label: model }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setModelYear("all"); setSalesModel("all"); }}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesModelTrend")} aria-label={expandedChart === "salesModelTrend" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesModelTrend" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            <ResponsiveContainer width="100%" height={expandedChart === "salesModelTrend" ? 650 : 280}>{modelTrendRealPointCount < 3 ? <BarChart data={salesTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend />{visibleSalesModels.map((model) => { const modelIndex = salesModels.indexOf(model); return <Bar key={model} dataKey={model} name={model} fill={chartTheme.palette[modelIndex % chartTheme.palette.length]} radius={[5, 5, 0, 0]} />; })}</BarChart> : <LineChart data={salesTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend />{visibleSalesModels.map((model) => { const modelIndex = salesModels.indexOf(model); const color = chartTheme.palette[modelIndex % chartTheme.palette.length]; return <Line key={model} type="linear" dataKey={model} name={model} stroke={color} strokeWidth={salesModel === "all" ? 2 : 3} connectNulls={false} dot={salesModel === "all" ? false : { r: 3, fill: color, strokeWidth: 0 }} activeDot={{ r: 6 }} />; })}</LineChart>}</ResponsiveContainer>
          </div>}
        </div>
      </section>}
    </div>
  );
}
