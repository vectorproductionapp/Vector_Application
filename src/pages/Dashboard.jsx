import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Boxes, ChevronLeft, CircleAlert, Expand, Factory, MapPin, Minimize2, ShieldCheck, TrendingUp, Truck } from "lucide-react";
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
import { useRealtime } from "../components/RealtimeProvider";
import { useAuth } from "../context/Auth";
import "./Dashboard.css";

const KPI_DEFINITIONS = [
  { key: "inProduction", label: "Units In Production", group: "pipeline" },
  { key: "qcPassed", label: "QC Passed (Total)", group: "pipeline" },
  { key: "qcFailed", label: "QC Failed", group: "pipeline" },
  { key: "semiFinished", label: "Units Semi Finished", group: "pipeline" },
  { key: "qcInspection", label: "Under QC Inspection", group: "pipeline" },
  { key: "packed", label: "Packed (Ready to Dispatch)", group: "outcome" },
  { key: "sold", label: "Units Sold", group: "outcome" },
  { key: "salesValue", label: "Total Sales Value (INR)", group: "outcome", currency: true },
  { key: "defects", label: "Defective Units Reported", group: "outcome" },
  { key: "reorder", label: "Materials Below Min Stock", group: "outcome" },
];
const EMPTY_SALES_DASHBOARD = { kpis: { sold: 0, salesValue: 0 } };

const PRODUCTION_KPI_KEYS = new Set(["inProduction", "semiFinished", "qcInspection", "qcFailed", "qcPassed", "packed", "defects"]);

// Where each KPI card leads, and which PageFilter value the target page should
// start on. A card without a `field` just opens the page unfiltered.
// `salesValue` and `reorder` are intentionally bare: a total or a reorder
// count is not a single row, so pre-selecting one would be misleading.
const KPI_TARGETS = {
  total: { path: "/production" },
  // In Stock is finished goods, so it belongs on the Stock Register's Finished
  // Goods tab rather than the production log.
  // "In Stock" is the status the finished-goods endpoint gives an undelivered unit.
  // The In Stock card counts only packed units, so the list is narrowed to
  // Packed as well; otherwise it opened on every QC-passed unit.
  inStock: {
    path: "/stock", view: "finishedgoods", field: "status", value: "In Stock",
    extraFilters: [["packagingStatus", "Packed"]],
  },
  // QC Passed Stock is every unsold QC-passed unit, packed or pending.
  qcStock: { path: "/stock", view: "finishedgoods", field: "status", value: "In Stock" },
  inProduction: { path: "/production", field: "stage", value: "In Production" },
  semiFinished: { path: "/production", field: "stage", value: "Semi Finished" },
  qcPassed: { path: "/production", field: "qc", value: "Passed" },
  qcFailed: { path: "/production", field: "qc", value: "Failed" },
  qcInspection: { path: "/production", field: "qc", value: "Under Inspection" },
  packed: { path: "/production", field: "packagingStatus", value: "Packed" },
  sold: { path: "/sales", field: "dispatch", value: "Delivered" },
  salesValue: { path: "/sales" },
  defects: { path: "/defects" },
  reorder: { path: "/stock", view: "minstock" },
};

// Mirrors the ProtectedRoute roles in App.jsx. A regular production user can
// only reach /production, so their sales/stock/defect cards stay plain figures
// rather than navigating into a page that would bounce them to /unauthorized.
const ROUTE_ROLES = {
  "/production": ["admin", "coadmin", "production_incharge", "user"],
  "/sales": ["admin", "coadmin", "production_incharge"],
  "/stock": ["admin", "coadmin", "production_incharge"],
  "/defects": ["admin", "coadmin", "production_incharge"],
};

// Stock Register's own tabs, so a card can open the right one.
const STOCK_VIEWS = { finishedgoods: "finishedgoods", minstock: "minstock" };
const EMPTY_KPIS = {
  inProduction: 0, semiFinished: 0, qcInspection: 0, qcFailed: 0,
  qcPassed: 0, packed: 0, inStock: 0, inStockAdded: 0, inStockSold: 0,
  inStockPacked: 0, inStockPackingPending: 0,
  total: 0, sold: 0, salesValue: 0, defects: 0, reorder: 0,
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

// A chart period is a day ("2026-10-16") or an ISO week ("2026-W42"); returns
// the first and last day it covers as YYYY-MM-DD.
function periodRange(period) {
  const text = String(period || "");
  const week = /^(\d{4})-W(\d{2})$/.exec(text);
  if (!week) return [text.slice(0, 10), text.slice(0, 10)];
  // Monday of ISO week 1 is the Monday on or before 4 January.
  const jan4 = new Date(Date.UTC(Number(week[1]), 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(week[2]) - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)];
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-10-16" -> "16 Oct"; with the year -> "16 Oct 2026".
function formatDay(value, withYear = false) {
  const [year, month, day] = String(value).split("-");
  const label = `${Number(day)} ${SHORT_MONTHS[Number(month) - 1] || ""}`;
  return withYear ? `${label} ${year}` : label;
}

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// "2026-10" -> "October 2026".
function formatMonth(value) {
  return `${LONG_MONTHS[Number(String(value).slice(5, 7)) - 1] || ""} ${String(value).slice(0, 4)}`;
}

const ACTIVITY_UNIT_LABELS = { assembled: "Assembled units", qc: "QC tested units", packaged: "Packaged units" };

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

// A headline figure. When `to` is set the whole card is a link to the page
// that owns the number; otherwise it stays a plain <article> so roles that
// cannot open the target page keep a readable figure.
function StatCard({ className, to, icon, iconClass, label, value, note }) {
  const body = (
    <>
      <span className={iconClass}>{icon}</span>
      <div><small>{label}</small><strong>{value}</strong><em>{note}</em></div>
    </>
  );

  if (!to) {
    return <article className={className}>{body}</article>;
  }
  return (
    <Link className={`${className} stat-card--link`} to={to} aria-label={`${label}: ${value}. Go to details.`}>
      {body}
    </Link>
  );
}

// Sums series items per name, treating names that differ only in case or
// spacing ("mumbai", " Mumbai ") as one. The label shown is the first spelling
// that has a capital letter, so a lower-case entry never wins over a proper one.
function nameLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ") || "Unspecified";
}
function nameMatchKey(value) {
  return nameLabel(value).toLocaleLowerCase();
}

function mergeByName(items, nameKey) {
  const groups = new Map();
  items.forEach((item) => {
    const label = nameLabel(item[nameKey]);
    const key = label.toLocaleLowerCase();
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { name: label, units: Number(item.units || 0) });
      return;
    }
    group.units += Number(item.units || 0);
    if (group.name === group.name.toLocaleLowerCase() && label !== label.toLocaleLowerCase()) group.name = label;
  });
  return [...groups.values()];
}

export default function Dashboard() {
  const captureRef = useRef(null);
  const chartTheme = useThemeColors();
  const [dashboard, setDashboard] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { role } = useAuth();
  const dashboardCacheKey = `vector_dashboard_v2_${role || "guest"}`;
  const isRegularUser = role === "user";
  const isProductionIncharge = role === "production_incharge";
  const isProductionOnly = role === "user" || role === "production_incharge";
  const canViewSalesValue = role === "admin" || role === "coadmin";

  // Resolves a KPI key to a destination for the signed-in role, or null when
  // that role cannot open the page. `from=dashboard` marks the arrival so the
  // target page can offer a way back; `field`/`value` let it start on the
  // matching PageFilter selection.
  const kpiTarget = useCallback((key) => {
    // A regular user's dashboard is read-only: every card is a plain figure.
    if (role === "user") return null;
    const target = KPI_TARGETS[key];
    if (!target) return null;
    if (!(ROUTE_ROLES[target.path] || []).includes(role)) return null;

    const params = new URLSearchParams({ from: "dashboard" });
    if (target.field) {
      params.set("field", target.field);
      params.set("value", target.value);
    }
    (target.extraFilters || []).forEach(([field, value]) => {
      params.append("field", field);
      params.append("value", value);
    });
    const view = target.view && STOCK_VIEWS[target.view];
    if (view) params.set("view", view);
    return `${target.path}?${params.toString()}`;
  }, [role]);
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
  const [productionFromDate, setProductionFromDate] = useState("");
  const [productionToDate, setProductionToDate] = useState("");
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

  // A role change or a newer loader identity starts a fresh request; the
  // request id makes sure only the newest one writes state.
  const dashReqRef = useRef(0);

  const loadDashboard = useCallback(async () => {
    const requestId = (dashReqRef.current += 1);
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

      if (requestId === dashReqRef.current) {
        setDashboard(dashboardData);
        try { sessionStorage.setItem(dashboardCacheKey, JSON.stringify({ data: dashboardData, savedAt: Date.now() })); } catch {}
      }
    } catch {
    } finally {
      if (requestId === dashReqRef.current) setIsLoading(false);
    }
  }, [isRegularUser, dashboardCacheKey]);

  useEffect(() => {
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

    loadDashboard();
    return () => { dashReqRef.current += 1; };
  }, [loadDashboard, dashboardCacheKey]);

  // Any write in the app moves a KPI somewhere: refresh the numbers from the
  // WebSocket notice instead of polling or reloading the page.
  useRealtime(
    ["po_details", "invoices", "assembly_units", "sales", "defectives", "phases", "models"],
    () => { loadDashboard(); }
  );

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
  // `period` is a day ("2026-10-16") or an ISO week ("2026-W42"). A week is in
  // range when any of its days is, so the Weekly view honours From / To too.
  const isWithinDateRange = (period, fromDate, toDate) => {
    const [start, end] = periodRange(period);
    return (!fromDate || end >= fromDate) && (!toDate || start <= toDate);
  };
  // Delivery chart grouping: "customer" (End Customer Name) or "location"
  // (End Customer Location). Both are read from the Sale Register.
  const [deliveryGroupBy, setDeliveryGroupBy] = useState("customer");

  // A backend without `endUserClientByDay` / `endUserLocationByDay` gets the
  // same series built here from the Sale Register lines, using the backend's
  // rule: dispatched or delivered sales, grouped by the end customer's name or
  // location. Sales without end-customer details are left out, never shown
  // under the client's name.
  const [fallbackDelivery, setFallbackDelivery] = useState(null);
  const needsDeliveryFallback = activeView === "sales" && Boolean(dashboard) && (
    !Array.isArray(dashboard?.endUserClientByDay) || !Array.isArray(dashboard?.endUserLocationByDay)
  );
  useEffect(() => {
    if (!needsDeliveryFallback) return undefined;
    let cancelled = false;
    api.get("/sales", { params: { page: 1, limit: 100 }, __vectorBackground: true })
      .then((response) => {
        if (cancelled) return;
        const sales = response.data?.allRows || response.data?.sales || [];
        const byClient = {};
        const byLocation = {};
        sales.forEach((sale) => {
          if (!["dispatched", "delivered"].includes(String(sale.dispatch || "").trim().toLowerCase())) return;
          const period = String(sale.date || sale.clientPoDate || "").slice(0, 10) || "Undated";
          const qty = Number(sale.qty) || 0;
          const client = String(sale.endUserClient || "").trim();
          const location = String(sale.endUserLocation || "").trim();
          if (client) byClient[`${period}|${client}`] = (byClient[`${period}|${client}`] || 0) + qty;
          if (location) byLocation[`${period}|${location}`] = (byLocation[`${period}|${location}`] || 0) + qty;
        });
        const toSeries = (totals, nameKey) => Object.entries(totals).map(([key, units]) => {
          const [period, name] = key.split("|");
          return { period, [nameKey]: name, units };
        });
        setFallbackDelivery({
          endUserClientByDay: toSeries(byClient, "client"),
          endUserLocationByDay: toSeries(byLocation, "location"),
        });
      })
      .catch(() => { if (!cancelled) setFallbackDelivery({ endUserClientByDay: [], endUserLocationByDay: [] }); });
    return () => { cancelled = true; };
  }, [needsDeliveryFallback, dashboard]);

  // The delivery series for the current Customer / Location switch.
  const deliverySource = useMemo(() => {
    const seriesKey = deliveryGroupBy === "location" ? "endUserLocationByDay" : "endUserClientByDay";
    const source = Array.isArray(salesDashboard?.[seriesKey])
      ? salesDashboard[seriesKey]
      : activeView === "sales" ? fallbackDelivery?.[seriesKey] : [];
    return source || [];
  }, [salesDashboard, fallbackDelivery, activeView, deliveryGroupBy]);
  const deliveryNameKey = deliveryGroupBy === "location" ? "location" : "client";
  // One fixed colour per customer / location (by name, ignoring case), so a bar
  // keeps its colour when the filters change and in its own drill-down.
  const deliveryKeys = useMemo(
    () => Array.from(new Set(deliverySource.map((item) => nameMatchKey(item[deliveryNameKey])))).sort(),
    [deliverySource, deliveryNameKey]
  );
  const deliveryColor = (name) => {
    const palette = chartTheme.palette?.length ? chartTheme.palette : [chartTheme.accent];
    return palette[Math.max(0, deliveryKeys.indexOf(nameMatchKey(name))) % palette.length];
  };
  // Click a customer / location: its deliveries month by month; click a month:
  // that month day by day. Year / Month filters apply at every level.
  const [deliveryDrill, setDeliveryDrill] = useState({ name: "", month: "" });
  useEffect(() => { setDeliveryDrill({ name: "", month: "" }); }, [deliveryGroupBy]);
  const deliveryDrillRows = useMemo(() => {
    if (!deliveryDrill.name) return [];
    const target = nameMatchKey(deliveryDrill.name);
    const items = deliverySource.filter((item) => {
      const period = String(item.period || "");
      if (!/^\d{4}-\d{2}-\d{2}/.test(period)) return false;
      if (nameMatchKey(item[deliveryNameKey]) !== target) return false;
      if (locationYear !== "all" && !period.startsWith(locationYear)) return false;
      return locationMonth === "all" || period.slice(5, 7) === locationMonth;
    });
    if (!deliveryDrill.month) {
      const totals = {};
      items.forEach((item) => {
        const month = String(item.period).slice(0, 7);
        totals[month] = (totals[month] || 0) + Number(item.units || 0);
      });
      return Object.keys(totals).sort().map((month) => ({
        key: month, label: formatMonth(month), fullLabel: formatMonth(month), units: totals[month],
      }));
    }
    const month = deliveryDrill.month;
    const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const rows = Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return { key: date, label: String(index + 1), fullLabel: formatDay(date, true), units: 0 };
    });
    items.forEach((item) => {
      if (!String(item.period).startsWith(`${month}-`)) return;
      const row = rows[Number(String(item.period).slice(8, 10)) - 1];
      if (row) row.units += Number(item.units || 0);
    });
    return rows;
  }, [deliveryDrill, deliverySource, deliveryNameKey, locationYear, locationMonth]);

  // X axis: End Customer Name or End Customer Location. Y axis: quantity.
  const locationSales = useMemo(() => {
    const seriesKey = deliveryGroupBy === "location" ? "endUserLocationByDay" : "endUserClientByDay";
    const nameKey = deliveryGroupBy === "location" ? "location" : "client";
    const source = Array.isArray(salesDashboard?.[seriesKey])
      ? salesDashboard[seriesKey]
      : activeView === "sales" ? fallbackDelivery?.[seriesKey] : [];
    const items = (source || []).filter((item) => {
      const period = String(item.period || "");
      if (locationYear !== "all" && !period.startsWith(locationYear)) return false;
      return locationMonth === "all" || period.slice(5, 7) === locationMonth;
    });
    return mergeByName(items, nameKey)
      .map(({ name, units }) => ({ group: name, units }))
      .sort((a, b) => b.units - a.units || a.group.localeCompare(b.group));
  }, [salesDashboard, fallbackDelivery, activeView, deliveryGroupBy, locationYear, locationMonth]);
  // "Dispatch network" counts the distinct end-customer cities, ignoring case
  // and spacing so "mumbai" and "Mumbai" are one city. Only an older backend
  // without the end-user series falls back to the client locations.
  const salesLocationCount = useMemo(() => {
    const source = Array.isArray(salesDashboard?.endUserLocationByDay)
      ? salesDashboard.endUserLocationByDay
      : salesDashboard?.locationSalesByDay || [];
    return mergeByName(source, "location").filter(({ name }) => name !== "Unspecified").length;
  }, [salesDashboard]);
  const locationYears = useMemo(() => {
    const periods = [
      ...(salesDashboard?.locationSalesByDay || []),
      ...(salesDashboard?.endUserLocationByDay || []),
      ...(salesDashboard?.clientSalesByDay || []),
      ...(salesDashboard?.endUserClientByDay || []),
      ...(salesDashboard?.salesByMonth || []),
      ...(salesDashboard?.salesByModelMonth || []),
    ];
    const years = new Set(
      periods.map((item) => String(item.period || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))
    );
    if (!years.size) years.add(String(new Date().getFullYear()));
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [salesDashboard]);
  const clientSales = useMemo(() => {
    const source = activeView === "customerSales" && (salesDashboard?.endUserClientByDay || []).length
      ? salesDashboard.endUserClientByDay
      : salesDashboard?.clientSalesByDay;
    const items = (source || []).filter((item) => {
      const period = String(item.period || "");
      if (clientYear !== "all" && !period.startsWith(clientYear)) return false;
      return clientMonth === "all" || period.slice(5, 7) === clientMonth;
    });
    return mergeByName(items, "client")
      .map(({ name, units }) => ({ client: name, units }))
      .sort((a, b) => b.units - a.units || a.client.localeCompare(b.client));
  }, [salesDashboard, clientYear, clientMonth, activeView]);
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

    const monthInDateRange = (period) => {
      if (!productionFromDate || !productionToDate) return true;
      const periodYear = Number(period.slice(0, 4));
      const periodMonth = Number(period.slice(5, 7));
      const fromYear = Number(productionFromDate.slice(0, 4));
      const fromMonth = Number(productionFromDate.slice(5, 7));
      const toYear = Number(productionToDate.slice(0, 4));
      const toMonth = Number(productionToDate.slice(5, 7));
      if (periodYear < fromYear) return false;
      if (periodYear === fromYear && periodMonth < fromMonth) return false;
      if (periodYear > toYear) return false;
      if (periodYear === toYear && periodMonth > toMonth) return false;
      return true;
    };

    const matchesProductionPeriod = (period, user) => (productionYear === "all" || String(period).startsWith(productionYear)) && (productionMonth === "all" || String(period).slice(5, 7) === productionMonth) && (productionUser === "all" || user === productionUser) && monthInDateRange(period);
    (dashboard?.assembledByMonthUser || []).forEach(({ period, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12) assembled[index].units += Number(units || 0); });
    (dashboard?.qcByMonthStatusUser || []).forEach(({ period, status, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12 && status in qc[index]) qc[index][status] += Number(units || 0); });
    (dashboard?.packagedByMonthStatusUser || []).forEach(({ period, status, user, units }) => { if (!matchesProductionPeriod(period, user)) return; const index = Number(String(period).slice(5, 7)) - 1; if (index >= 0 && index < 12 && status in packaged[index]) packaged[index][status] += Number(units || 0); });
    return { assembled, qc, packaged };
  }, [dashboard, productionYear, productionMonth, productionUser, productionFromDate, productionToDate]);
  const productionYears = useMemo(() => {
    const years = new Set([
      ...(dashboard?.assembledByMonth || []), ...(dashboard?.qcByMonthStatus || []), ...(dashboard?.packagedByMonthStatus || []),
    ].map((item) => String(item.period || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year)));
    if (!years.size) years.add(String(new Date().getFullYear()));
    return Array.from(years).sort().reverse();
  }, [dashboard]);
  const productionUsers = useMemo(() => Array.from(new Set([...(dashboard?.assembledByMonthUser || []), ...(dashboard?.qcByMonthStatusUser || []), ...(dashboard?.packagedByMonthStatusUser || [])].map((item) => item.user).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [dashboard]);
  const productionFilterControls = <>{!isRegularUser && <DashboardFilterSelect label="User" value={productionUser} onChange={setProductionUser} options={[{ value: "all", label: "All users" }, ...productionUsers.map((user) => ({ value: user, label: user }))]} />}<DashboardFilterSelect label="Year" value={productionYear} onChange={setProductionYear} options={[{ value: "all", label: "All years" }, ...productionYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={productionMonth} onChange={setProductionMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><label className="dashboard-filter-date">From <DatePicker value={productionFromDate} onChange={setProductionFromDate} ariaLabel="Select filter start date" popoverZIndex={100000} /></label><label className="dashboard-filter-date">To <DatePicker value={productionToDate} onChange={setProductionToDate} ariaLabel="Select filter end date" popoverZIndex={100000} /></label><button type="button" className="btn btn-secondary chart-clear-filter" onClick={() => { setProductionUser("all"); setProductionYear("all"); setProductionMonth("all"); setProductionFromDate(""); setProductionToDate(""); }}>Clear filters</button></>;
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
  // One fixed colour per user (by name, not by bar position), so a user keeps
  // the same colour in the by-user chart and in their own date-wise chart.
  const userColor = (user) => {
    const palette = chartTheme.palette?.length ? chartTheme.palette : [chartTheme.accent];
    const index = Math.max(0, qcUsers.indexOf(user));
    return palette[index % palette.length];
  };
  // Clicking a user's bar drills into that user's activity month by month;
  // clicking a month then shows its days (or weeks in Weekly mode). The From /
  // To range applies at every level.
  const [activityDrillUser, setActivityDrillUser] = useState("");
  const [activityDrillMonth, setActivityDrillMonth] = useState("");
  const openActivityUser = (user) => { setActivityDrillUser(user || ""); setActivityDrillMonth(""); };
  const activityDrillRows = useMemo(() => {
    if (!activityDrillUser) return [];
    const pick = (daily) => ({
      qc: daily ? dashboard?.qcByUserDay : dashboard?.qcByUserWeek,
      assembled: daily ? dashboard?.assembledByUserDay : dashboard?.assembledByUserWeek,
      packaged: daily ? dashboard?.packagedByUserDay : dashboard?.packagedByUserWeek,
    }[userActivity] || []);
    const mine = (items) => items.filter((item) => item.user === activityDrillUser
      && item.period !== "Undated" && isWithinDateRange(item.period, qcFromDate, qcToDate));

    if (!activityDrillMonth) {
      // Month level always reads the daily series, so each unit lands in the
      // month it really happened in.
      const totals = {};
      mine(pick(true)).forEach((item) => {
        const month = String(item.period).slice(0, 7);
        totals[month] = (totals[month] || 0) + Number(item.units || 0);
      });
      return Object.keys(totals).sort().map((month) => ({
        key: month,
        label: formatMonth(month),
        fullLabel: formatMonth(month),
        units: totals[month],
      }));
    }

    if (qcRange === "daily") {
      // Every day of the month, like the Assembly chart, so gaps are visible.
      const days = new Date(Number(activityDrillMonth.slice(0, 4)), Number(activityDrillMonth.slice(5, 7)), 0).getDate();
      const rows = Array.from({ length: days }, (_, index) => {
        const date = `${activityDrillMonth}-${String(index + 1).padStart(2, "0")}`;
        return { key: date, label: String(index + 1), fullLabel: formatDay(date, true), units: 0 };
      });
      mine(pick(true)).forEach((item) => {
        if (!String(item.period).startsWith(`${activityDrillMonth}-`)) return;
        const row = rows[Number(String(item.period).slice(8, 10)) - 1];
        if (row) row.units += Number(item.units || 0);
      });
      return rows;
    }

    // Weekly: the weeks that touch the chosen month.
    const totals = {};
    mine(pick(false)).forEach((item) => {
      const [weekStart, weekEnd] = periodRange(item.period);
      if (weekEnd.slice(0, 7) < activityDrillMonth || weekStart.slice(0, 7) > activityDrillMonth) return;
      totals[item.period] = (totals[item.period] || 0) + Number(item.units || 0);
    });
    return Object.keys(totals).sort().map((period) => {
      const [weekStart, weekEnd] = periodRange(period);
      return {
        key: period,
        label: `${formatDay(weekStart)} – ${formatDay(weekEnd)}`,
        fullLabel: `${formatDay(weekStart, true)} – ${formatDay(weekEnd, true)}`,
        units: totals[period],
      };
    });
    // isWithinDateRange is a plain helpers over their arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityDrillUser, activityDrillMonth, dashboard, qcRange, userActivity, qcFromDate, qcToDate]);
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

  // ---- Day-wise drill-down for the three monthly production charts ----
  // Clicking a month bar (or picking a month in the chart header) switches that
  // chart to the chosen month, one bar per day. Each chart drills on its own.
  // Value per chart key: "YYYY-MM", or absent for the monthly view.
  const [drillMonths, setDrillMonths] = useState({});
  const setDrillMonth = (chartKey, month) => setDrillMonths((current) => {
    const next = { ...current };
    if (month) next[chartKey] = month; else delete next[chartKey];
    return next;
  });
  const anyProductionDrill = Object.keys(drillMonths).length > 0;

  // A backend without the day-level QC/packaging series gets them built from
  // the assembly units, by the backend's rule: the unit's date, its status
  // ("Pending" when blank) and who did it. Only fetched once a chart is drilled.
  const [assemblyDayFallback, setAssemblyDayFallback] = useState(null);
  const needsAssemblyDayFallback = activeView === "production" && anyProductionDrill && Boolean(dashboard)
    && (!Array.isArray(dashboard?.qcByDayStatusUser) || !Array.isArray(dashboard?.packagedByDayStatusUser));
  useEffect(() => {
    if (!needsAssemblyDayFallback || assemblyDayFallback) return undefined;
    let cancelled = false;
    api.get("/assembly", { params: { page: 1, limit: 100 }, __vectorBackground: true })
      .then((response) => {
        if (cancelled) return;
        const units = response.data?.allRows || response.data?.assemblyUnits || [];
        const day = (unit) => String(unit.date || "").slice(0, 10) || "Undated";
        setAssemblyDayFallback({
          qcByDayStatusUser: units.map((unit) => ({
            period: day(unit),
            status: String(unit.qc || "").trim(),
            user: String(unit.qcBy || "").trim() || "Unassigned",
            units: Number(unit.qty) || 0,
          })),
          packagedByDayStatusUser: units.map((unit) => ({
            period: day(unit),
            status: String(unit.packagingStatus || "").trim(),
            user: String(unit.packagedBy || "").trim() || "Unassigned",
            units: Number(unit.qty) || 0,
          })),
        });
      })
      .catch(() => { if (!cancelled) setAssemblyDayFallback({ qcByDayStatusUser: [], packagedByDayStatusUser: [] }); });
    return () => { cancelled = true; };
  }, [needsAssemblyDayFallback, assemblyDayFallback]);
  // A fresh dashboard payload may mean new units, so rebuild the fallback.
  useEffect(() => { setAssemblyDayFallback(null); }, [dashboard]);

  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FULL_MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const formatDrillMonth = (value) => `${FULL_MONTH_LABELS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;

  // Months that have production activity, newest first, for the month picker.
  const productionDrillMonthOptions = useMemo(() => {
    const months = new Set([
      ...(dashboard?.assembledByMonthUser || []),
      ...(dashboard?.qcByMonthStatusUser || []),
      ...(dashboard?.packagedByMonthStatusUser || []),
    ].map((item) => String(item.period || "").slice(0, 7)).filter((value) => /^\d{4}-\d{2}$/.test(value)));
    return Array.from(months)
      .filter((value) => productionYear === "all" || value.startsWith(productionYear))
      .sort((a, b) => b.localeCompare(a));
  }, [dashboard, productionYear]);

  // A month bar only carries "Oct". The year is the filtered year, or else the
  // newest year that has activity in that month.
  // Recharts 3 does not always fill `activeLabel`, so the clicked position
  // (`activeIndex`) is read against the chart's own rows as well.
  const drillFromChart = (chartKey, rows) => (state) => {
    const label = MONTH_LABELS.includes(state?.activeLabel)
      ? state.activeLabel
      : rows?.[Number(state?.activeIndex)]?.month;
    drillToMonthLabel(chartKey, label);
  };
  // Bar-level click: stacked bars do not always reach the chart's onClick.
  const drillBar = (chartKey) => (entry) => drillToMonthLabel(chartKey, entry?.month ?? entry?.payload?.month);
  // Each drillable chart has its own Year filter and its own list of months.
  function drillContext(chartKey) {
    if (chartKey === "salesDispatchTrend") return { year: dispatchYear, months: salesDrillMonthOptions.salesDispatchTrend };
    if (chartKey === "salesModelTrend") return { year: modelYear, months: salesDrillMonthOptions.salesModelTrend };
    return { year: productionYear, months: productionDrillMonthOptions };
  }
  function drillToMonthLabel(chartKey, label) {
    const index = MONTH_LABELS.indexOf(label);
    if (index < 0) return;
    const month = String(index + 1).padStart(2, "0");
    const { year, months } = drillContext(chartKey);
    const match = year !== "all"
      ? `${year}-${month}`
      : months.find((value) => value.endsWith(`-${month}`));
    if (match) setDrillMonth(chartKey, match);
  }

  const productionDayCharts = useMemo(() => {
    const build = (chartKey, emptyRow, source, apply) => {
      const month = drillMonths[chartKey];
      if (!month) return null;
      const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
      const rows = Array.from({ length: days }, (_, index) => ({ day: String(index + 1), ...emptyRow }));
      (source || []).forEach((item) => {
        const period = String(item.period || "");
        if (!period.startsWith(`${month}-`)) return;
        if (productionUser !== "all" && item.user !== productionUser) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        if (row) apply(row, item);
      });
      return rows;
    };
    const qcSource = Array.isArray(dashboard?.qcByDayStatusUser)
      ? dashboard.qcByDayStatusUser : assemblyDayFallback?.qcByDayStatusUser;
    const packagedSource = Array.isArray(dashboard?.packagedByDayStatusUser)
      ? dashboard.packagedByDayStatusUser : assemblyDayFallback?.packagedByDayStatusUser;
    return {
      monthlyAssembled: build("monthlyAssembled", { units: 0 }, dashboard?.assembledByUserDay,
        (row, item) => { row.units += Number(item.units || 0); }),
      monthlyQc: build("monthlyQc", { Passed: 0, "Under Inspection": 0, Pending: 0, Failed: 0 }, qcSource,
        (row, item) => { if (item.status in row) row[item.status] += Number(item.units || 0); }),
      monthlyPackaging: build("monthlyPackaging", { Pending: 0, "In Progress": 0, Packed: 0 }, packagedSource,
        (row, item) => { if (item.status in row) row[item.status] += Number(item.units || 0); }),
    };
  }, [drillMonths, dashboard, assemblyDayFallback, productionUser]);

  // ---- Day-wise drill-down for the two sales trend charts ----
  // Months with sales activity, newest first, for each chart's own Year filter.
  const salesDrillMonthOptions = useMemo(() => {
    const monthsOf = (items, year) => Array.from(new Set((items || [])
      .map((item) => String(item.period || "").slice(0, 7))
      .filter((value) => /^\d{4}-\d{2}$/.test(value) && (year === "all" || value.startsWith(year)))))
      .sort((a, b) => b.localeCompare(a));
    return {
      salesDispatchTrend: monthsOf(salesDashboard?.salesByMonth, dispatchYear),
      salesModelTrend: monthsOf(salesDashboard?.salesByModelMonth, modelYear),
    };
  }, [salesDashboard, dispatchYear, modelYear]);

  // "Monthly units by model" counts every sale that is not cancelled, by model,
  // on the sale's date. The dashboard only sends that per month, so the days
  // are read from the Sale Register lines once the chart is drilled.
  const [salesDayRows, setSalesDayRows] = useState(null);
  const needsSalesDayRows = activeView === "sales" && Boolean(drillMonths.salesModelTrend);
  useEffect(() => {
    if (!needsSalesDayRows || salesDayRows) return undefined;
    let cancelled = false;
    api.get("/sales", { params: { page: 1, limit: 100 }, __vectorBackground: true })
      .then((response) => { if (!cancelled) setSalesDayRows(response.data?.allRows || response.data?.sales || []); })
      .catch(() => { if (!cancelled) setSalesDayRows([]); });
    return () => { cancelled = true; };
  }, [needsSalesDayRows, salesDayRows]);
  useEffect(() => { setSalesDayRows(null); }, [dashboard]);

  const salesDayCharts = useMemo(() => {
    const daysOf = (month, emptyRow) => {
      const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
      return Array.from({ length: days }, (_, index) => ({ day: String(index + 1), ...emptyRow }));
    };
    const result = {};
    const dispatchMonth = drillMonths.salesDispatchTrend;
    if (dispatchMonth) {
      // clientSalesByDay holds the same dispatched sales as the monthly trend,
      // one row per day and client, so summing it per day gives the daily total.
      const rows = daysOf(dispatchMonth, { units: 0 });
      (salesDashboard?.clientSalesByDay || []).forEach((item) => {
        const period = String(item.period || "");
        if (!period.startsWith(`${dispatchMonth}-`)) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        if (row) row.units += Number(item.units || 0);
      });
      result.salesDispatchTrend = rows;
    }
    const modelMonth = drillMonths.salesModelTrend;
    if (modelMonth) {
      const rows = daysOf(modelMonth, Object.fromEntries(visibleSalesModels.map((model) => [model, 0])));
      (salesDayRows || []).forEach((sale) => {
        if (String(sale.dispatch || "").trim().toLowerCase() === "cancelled") return;
        const period = String(sale.date || sale.clientPoDate || "").slice(0, 10);
        if (!period.startsWith(`${modelMonth}-`)) return;
        const model = String(sale.model || "").trim() || "Unspecified";
        if (salesModel !== "all" && model !== salesModel) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        if (row) row[model] = (row[model] || 0) + (Number(sale.qty) || 0);
      });
      result.salesModelTrend = rows;
    }
    return result;
  }, [drillMonths, salesDashboard, salesDayRows, visibleSalesModels, salesModel]);

  const renderSalesDayChart = (chartKey) => (chartKey === "salesDispatchTrend"
    ? renderDayChart(chartKey, {
      rows: salesDayCharts.salesDispatchTrend,
      series: [{ key: "units", name: "Dispatched units", color: chartTheme.accentActive }],
      loading: false,
    })
    : renderDayChart(chartKey, {
      rows: salesDayCharts.salesModelTrend,
      series: visibleSalesModels.map((model) => ({
        key: model,
        color: chartTheme.palette[salesModels.indexOf(model) % chartTheme.palette.length],
      })),
      loading: needsSalesDayRows && !salesDayRows,
      grouped: true,
      legend: true,
    }));

  // Month picker shown in each monthly chart's header.
  const renderDrillMonthPicker = (chartKey) => (
    <DashboardFilterSelect
      label="View"
      value={drillMonths[chartKey] || "all"}
      onChange={(value) => setDrillMonth(chartKey, value === "all" ? "" : value)}
      options={[
        { value: "all", label: "All months" },
        ...drillContext(chartKey).months.map((value) => ({ value, label: formatDrillMonth(value) })),
      ]}
    />
  );

  // Day-wise chart for a drilled month: one bar per day, stacked by status for
  // QC and packaging, with a way back to the monthly view.
  const DAY_CHART_SERIES = {
    monthlyAssembled: [{ key: "units", name: "Assembled units", color: chartTheme.accent }],
    // Bar / hover order: Passed, Failed, Under Inspection, Pending. Recharts 3
    // sorts the hover list by name unless a Tooltip passes `itemSorter`.
    monthlyQc: [
      { key: "Passed", color: chartTheme.success },
      { key: "Failed", color: chartTheme.danger },
      { key: "Under Inspection", color: chartTheme.accent },
      { key: "Pending", color: chartTheme.muted },
    ],
    // Bar / hover order: Packed, Pending, In Progress.
    monthlyPackaging: [
      { key: "Packed", color: chartTheme.success },
      { key: "Pending", color: chartTheme.muted },
      { key: "In Progress", color: chartTheme.warning },
    ],
  };
  const renderDayChart = (chartKey, override = {}) => {
    const rows = override.rows || productionDayCharts[chartKey] || [];
    const series = override.series || DAY_CHART_SERIES[chartKey];
    const loadingFallback = override.loading ?? (chartKey !== "monthlyAssembled" && needsAssemblyDayFallback && !assemblyDayFallback);
    const hasDayData = rows.some((row) => series.some(({ key }) => Number(row[key] || 0) > 0));
    return (
      <>
        <div className="chart-drill-bar">
          <button type="button" className="chart-drill-back" onClick={() => setDrillMonth(chartKey, "")}>
            <ChevronLeft size={14} /> All months
          </button>
          <span className="chart-drill-title">{formatDrillMonth(drillMonths[chartKey])} · day wise</span>
        </div>
        {loadingFallback ? (
          <div className="chart-empty-state" role="status"><span>Loading daily figures...</span></div>
        ) : hasDayData ? (
          <ResponsiveContainer width="100%" height={expandedChart === chartKey ? 610 : 250}>
            <BarChart data={rows} margin={{ top: 12, right: 12, left: 4, bottom: 20 }}>
              <CartesianGrid stroke={chartTheme.grid} vertical={false} />
              <XAxis dataKey="day" interval={expandedChart === chartKey ? 0 : "preserveStartEnd"} label={{ value: "Day", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 10, fill: chartTheme.axis }} />
              <YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} />
              <Tooltip contentStyle={chartTheme.tooltip} labelFormatter={(day) => `${day} ${formatDrillMonth(drillMonths[chartKey])}`} cursor={{ fill: chartTheme.cursor }} itemSorter={(item) => series.findIndex((entry) => entry.key === item.dataKey)} />
              {/* Above the plot, so it cannot sit on the "Day" axis label. */}
              {override.legend && <Legend verticalAlign="top" align="right" height={28} />}
              {series.map(({ key, name, color }, index) => (
                <Bar key={key} dataKey={key} name={name || key} stackId={series.length > 1 && !override.grouped ? "day" : undefined} fill={color} maxBarSize={28} radius={series.length > 1 && !override.grouped && index < series.length - 1 ? 0 : [5, 5, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-empty-state" role="status">
            <strong>No activity in {formatDrillMonth(drillMonths[chartKey])}</strong>
            <span>Pick another month or go back to the monthly view.</span>
          </div>
        )}
      </>
    );
  };
  // Unsold stock, matched to sales by serial, shown two ways: "In Stock" is
  // what has finished packing, "QC Passed Stock" is every unit that passed QC
  // whether packing is done or still pending. Like the other cards, the notes
  // describe what is counted rather than repeating numbers.
  const inStockPacked = Number(liveKpis.inStockPacked ?? 0);
  const packedStockNote = "Packing completed, ready to dispatch";
  const qcStockNote = "QC passed, packed + awaiting packing";
  // "1 unit", not "1 units".
  const unitsLabel = (value) => `${value ?? 0} unit${Number(value ?? 0) === 1 ? "" : "s"}`;
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
          {/* End User tab hidden for now - uncomment to bring it back.
          {!isProductionOnly && <button className={`dashboard-tab${activeView === "customerSales" ? " active" : ""}`} onClick={() => setActiveView("customerSales")} role="tab" aria-selected={activeView === "customerSales"}><TrendingUp size={16} /> End User</button>} */}
        </div>
      </header>
      <section className="dashboard-summary" aria-labelledby="operations-summary-title">
        <h2 id="operations-summary-title" className="sr-only">Operations summary</h2>
        <div className={`dashboard-summary-grid${activeView === "production" ? " dashboard-summary-grid--production" : ""}`} aria-label="Operations highlights">
          {activeView === "production" ? <>
            <StatCard className="summary-card summary-card--neutral" to={kpiTarget("total")} iconClass="summary-card-icon" icon={<Factory size={19} />} label="Total Unit" value={unitsLabel(liveKpis.total)} note="In production + semi finished + QC" />
            <StatCard className="summary-card summary-card--success" to={kpiTarget("inStock")} iconClass="summary-card-icon" icon={<Boxes size={19} />} label="In Stock" value={unitsLabel(inStockPacked)} note={packedStockNote} />
            <StatCard className="summary-card summary-card--success" to={kpiTarget("qcStock")} iconClass="summary-card-icon" icon={<ShieldCheck size={19} />} label="QC Passed Stock" value={unitsLabel(liveKpis.inStock)} note={qcStockNote} />
            <StatCard className="summary-card summary-card--success" to={kpiTarget("sold")} iconClass="summary-card-icon" icon={<Truck size={19} />} label="Sold Units" value={unitsLabel(liveKpis.sold)} note="Dispatch status delivered" />
          </> : <>
            <StatCard className="dashboard-hero-stat" to={kpiTarget("sold")} iconClass="dashboard-stat-icon" icon={<TrendingUp size={18} />} label="Total qty delivered" value={unitsLabel(salesKpis.sold)} note="Delivered sales" />
            <StatCard className="dashboard-hero-stat" to={kpiTarget("salesValue")} iconClass="dashboard-stat-icon gold" icon={<ArrowUpRight size={18} />} label="Sales value" value={canViewSalesValue ? formattedSalesValue : "Restricted"} note="Total unit value (cost × qty)" />
            <StatCard className="dashboard-hero-stat" to={kpiTarget("sold")} iconClass="dashboard-stat-icon" icon={<MapPin size={18} />} label="Dispatch network" value={`${salesLocationCount} cities`} note="Currently receiving shipments" />
          </>}
        </div>
        {activeView === "production" && <div className="snapshot-in-hero">
          {kpis.filter((kpi) => PRODUCTION_KPI_KEYS.has(kpi.key) && kpi.key !== "packed").map((kpi) => <KpiCard key={kpi.key} kpi={kpi} to={kpiTarget(kpi.key)} />)}
        </div>}
      </section>

      {/* <div className="dashboard-toolbar">
        <p className="dashboard-subtitle">{loadError ? "Live dashboard data is temporarily unavailable." : dashboard ? activeView === "production" ? "Live production, quality, and packing information." : activeView === "customerSales" ? "Live customer sales and dispatch information." : "Live Vector sales and dispatch information." : "Loading dashboard data..."}</p>
        {activeView !== "production" && canViewSalesValue && <div className="dashboard-value-chip"><ArrowUpRight size={15} /> {formattedSalesValue} sales value</div>}
      </div> */}

      {activeView === "production" && (<section className={`section${isRegularUser ? " user-production-dashboard" : ""}`} aria-labelledby="production-analytics-title">
        <div className="production-analytics-header"><div><p className="dashboard-eyebrow-label">Live reporting</p><h2 id="production-analytics-title" className="dashboard-section-title">Production analytics</h2></div><div className="dashboard-filter-bar">{productionFilterControls}</div></div>
        <div className={`chart-grid production-monthly-chart-grid${isProductionIncharge ? " production-incharge-chart-grid" : ""}`}>
          <div ref={(node) => { chartRefs.current.monthlyAssembled = node; }} data-chart-key="monthlyAssembled" className={`panel chart-panel${expandedChart === "monthlyAssembled" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Assembly output</span><h3 className="panel-title">{drillMonths.monthlyAssembled ? "Daily units assembled" : "Monthly units assembled"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyAssembled")}<Factory size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyAssembled")} aria-label={expandedChart === "monthlyAssembled" ? "Exit fullscreen" : "Expand assembly chart"}>{expandedChart === "monthlyAssembled" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyAssembled ? renderDayChart("monthlyAssembled") : hasAssemblyData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyAssembled" ? 650 : 280}>{assemblyDataPoints.length < 3 ? <BarChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyAssembled", assemblyDataPoints)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Bar dataKey="units" name="Assembled units" fill={chartTheme.accent} radius={[7, 7, 0, 0]} onClick={drillBar("monthlyAssembled")} /></BarChart> : <LineChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyAssembled", assemblyDataPoints)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Line type="monotone" dataKey="units" name="Assembled units" stroke={chartTheme.accent} strokeWidth={3} dot={{ r: 3, fill: chartTheme.accentHover }} activeDot={{ r: 6 }} /></LineChart>}</ResponsiveContainer> : chartEmptyState("assembly output")}</div>
          <div ref={(node) => { chartRefs.current.monthlyQc = node; }} data-chart-key="monthlyQc" className={`panel chart-panel${expandedChart === "monthlyQc" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Quality control</span><h3 className="panel-title">{drillMonths.monthlyQc ? "Daily QC status" : "Monthly QC status"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyQc")}<ShieldCheck size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyQc")} aria-label={expandedChart === "monthlyQc" ? "Exit fullscreen" : "Expand quality control chart"}>{expandedChart === "monthlyQc" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyQc ? renderDayChart("monthlyQc") : hasQcData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyQc" ? 650 : 280}><BarChart data={productionMonthCharts.qc} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyQc", productionMonthCharts.qc)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} itemSorter={(item) => ["Passed", "Failed", "Under Inspection", "Pending"].indexOf(item.dataKey)} /><Bar dataKey="Passed" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.success} /><Bar dataKey="Failed" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.danger} /><Bar dataKey="Under Inspection" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.accent} /><Bar dataKey="Pending" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.muted} /></BarChart></ResponsiveContainer> : chartEmptyState("quality control")}</div>
          <div ref={(node) => { chartRefs.current.monthlyPackaging = node; }} data-chart-key="monthlyPackaging" className={`panel chart-panel${expandedChart === "monthlyPackaging" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Packaging</span><h3 className="panel-title">{drillMonths.monthlyPackaging ? "Daily packaging status" : "Monthly packaging status"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyPackaging")}<Boxes size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyPackaging")} aria-label={expandedChart === "monthlyPackaging" ? "Exit fullscreen" : "Expand packaging chart"}>{expandedChart === "monthlyPackaging" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyPackaging ? renderDayChart("monthlyPackaging") : hasPackagingData ? <ResponsiveContainer width="100%" height={expandedChart === "monthlyPackaging" ? 650 : 280}><BarChart data={productionMonthCharts.packaged} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyPackaging", productionMonthCharts.packaged)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} itemSorter={(item) => ["Packed", "Pending", "In Progress"].indexOf(item.dataKey)} /><Bar dataKey="Packed" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.success} /><Bar dataKey="Pending" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.muted} /><Bar dataKey="In Progress" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.warning} /></BarChart></ResponsiveContainer> : chartEmptyState("packaging")}</div>
          {isProductionIncharge && renderDefectiveItemsChart("quality")}
        </div>
        <div className={`chart-grid ${activeView !== "production" ? "sales-chart-grid" : "production-chart-grid"}`}>
          {!isRegularUser && !isProductionIncharge && <div ref={(node) => { chartRefs.current.workload = node; }} data-chart-key="workload" className={`panel chart-panel${expandedChart === "workload" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>{activeView === "production" ? "User activity" : "Distribution"}</span><h3 className="panel-title">{activeView === "production" ? `${userActivity === "assembled" ? "Assembled" : userActivity === "packaged" ? "Packaged" : "QC tested"} by user` : "Units dispatched by location"}</h3></div><div className="chart-heading-actions">{activeView === "production" ? <><div className="dashboard-range-switch chart-range-switch"><button type="button" className={userActivity === "assembled" ? "active" : ""} onClick={() => setUserActivity("assembled")}>Assembled</button><button type="button" className={userActivity === "qc" ? "active" : ""} onClick={() => setUserActivity("qc")}>QC</button><button type="button" className={userActivity === "packaged" ? "active" : ""} onClick={() => setUserActivity("packaged")}>Packaged</button></div><div className="dashboard-range-switch chart-range-switch"><button type="button" className={qcRange === "daily" ? "active" : ""} onClick={() => setQcRange("daily")}>Daily</button><button type="button" className={qcRange === "weekly" ? "active" : ""} onClick={() => setQcRange("weekly")}>Weekly</button></div><Factory size={18} /></> : <MapPin size={18} />}<button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("workload")} aria-label={expandedChart === "workload" ? "Exit fullscreen" : "Expand chart"}>{expandedChart === "workload" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {activeView === "production" && <div className="chart-filter-row">{!isRegularUser && <DashboardFilterSelect label="User" value={qcUserFilter} onChange={setQcUserFilter} options={[{ value: "all", label: "All users" }, ...qcUsers.map((user) => ({ value: user, label: user }))]} />}<div className="chart-date-filter"><label>From <DatePicker value={qcFromDate} onChange={setQcFromDate} ariaLabel="Select filter start date" popoverZIndex={100000} /></label><label>To <DatePicker value={qcToDate} onChange={setQcToDate} ariaLabel="Select filter end date" popoverZIndex={100000} /></label></div><button type="button" className="chart-clear-filter" onClick={() => { setQcRange("daily"); setQcUserFilter("all"); setQcFromDate(""); setQcToDate(""); openActivityUser(""); }}>Clear filters</button></div>}
            {activeView === "production" && activityDrillUser ? <>
              <div className="chart-drill-bar">
                <button type="button" className="chart-drill-back" onClick={() => (activityDrillMonth ? setActivityDrillMonth("") : openActivityUser(""))}>
                  <ChevronLeft size={14} /> {activityDrillMonth ? "All months" : "All users"}
                </button>
                <span className="chart-drill-title">
                  <span className="chart-user-dot" style={{ background: userColor(activityDrillUser) }} aria-hidden="true" />
                  {activityDrillUser} · {activityDrillMonth
                    ? `${formatDrillMonth(activityDrillMonth)} · ${qcRange === "daily" ? "day wise" : "week wise"}`
                    : "month wise"}
                </span>
              </div>
              {activityDrillRows.some((row) => row.units > 0) ? <div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: activityDrillMonth && qcRange !== "daily" && activityDrillRows.length > 6 ? `${activityDrillRows.length * 110}px` : !activityDrillMonth && activityDrillRows.length > 12 ? `${activityDrillRows.length * 70}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "workload" ? 610 : 250}>
                <BarChart data={activityDrillRows} margin={{ top: 12, right: 12, left: 4, bottom: 20 }} className={activityDrillMonth ? undefined : "chart-drillable"}>
                  <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                  <XAxis dataKey="label" interval={activityDrillMonth && qcRange === "daily" && expandedChart !== "workload" ? "preserveStartEnd" : 0} label={{ value: !activityDrillMonth ? "Month" : qcRange === "daily" ? "Day" : "Week", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 10, fill: chartTheme.axis }} />
                  <YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} />
                  <Tooltip contentStyle={chartTheme.tooltip} cursor={{ fill: chartTheme.cursor }} labelFormatter={(label, payload) => payload?.[0]?.payload?.fullLabel || label} formatter={(value) => [value, ACTIVITY_UNIT_LABELS[userActivity]]} />
                  <Bar dataKey="units" name={ACTIVITY_UNIT_LABELS[userActivity]} fill={userColor(activityDrillUser)} maxBarSize={activityDrillMonth ? 28 : 48} radius={[6, 6, 0, 0]} onClick={activityDrillMonth ? undefined : (entry) => setActivityDrillMonth(entry?.key ?? entry?.payload?.key ?? "")} />
                </BarChart>
              </ResponsiveContainer></div></div> : <div className="chart-empty-state" role="status"><span>No {ACTIVITY_UNIT_LABELS[userActivity].toLowerCase()} for {activityDrillUser} in this range.</span></div>}
              {!activityDrillMonth && activityDrillRows.length > 0 && <p className="chart-drill-hint">Click a month to see its {qcRange === "daily" ? "day-wise" : "week-wise"} activity.</p>}
            </> :
            <div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: (activeView === "production" ? qcUserData : locationSales).length > 8 ? `${(activeView === "production" ? qcUserData : locationSales).length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "workload" ? 650 : 280}>
              <BarChart data={activeView === "production" ? qcUserData : locationSales} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} className={activeView === "production" ? "chart-drillable" : undefined}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis dataKey={activeView === "production" ? "user" : "location"} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} angle={qcUserData.length > 8 && activeView === "production" ? -35 : 0} textAnchor={qcUserData.length > 8 && activeView === "production" ? "end" : "middle"} height={qcUserData.length > 8 && activeView === "production" ? 70 : 30} />
                <YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} />
                <Tooltip contentStyle={chartTheme.tooltip} cursor={{ fill: chartTheme.cursor }} />
                <Bar dataKey="units" radius={[7, 7, 0, 0]} onClick={activeView === "production" ? (entry) => openActivityUser(entry?.user ?? entry?.payload?.user) : undefined}>
                  {(activeView === "production" ? qcUserData : locationSales).map((entry, index) => (
                    <Cell
                      key={`${activeView === "production" ? entry.user : entry.location}-${index}`}
                      fill={activeView === "production" ? userColor(entry.user) : getContrastBarColor(index, chartTheme)}
                      fillOpacity={activeView === "production" ? 1 : getBarColorOpacity(index)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></div></div>}
            {activeView === "production" && !activityDrillUser && qcUserData.length > 0 && <p className="chart-drill-hint">Click a user&apos;s bar to see their month-wise activity.</p>}
          </div>}

          {!isProductionIncharge && renderDefectiveItemsChart("quality")}

          </div>
      </section>)}
      {(activeView === "sales" || activeView === "customerSales") && <section className="section sales-analytics-section">
        
        <div className="chart-grid sales-chart-grid">
          {activeView !== "sales" && <div ref={(node) => { chartRefs.current.salesClient = node; }} data-chart-key="salesClient" className={`panel chart-panel${expandedChart === "salesClient" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>End User distribution</span><h3 className="panel-title">Units dispatched by end user client</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={clientYear} onChange={setClientYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={clientMonth} onChange={setClientMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setClientYear("all"); setClientMonth("all"); }}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesClient")} aria-label={expandedChart === "salesClient" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesClient" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {hasUsefulClientSalesData ? <><div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: clientSales.length > 8 ? `${clientSales.length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "salesClient" ? 650 : 280}><BarChart data={clientSales} margin={{ top: 8, right: 8, left: 6, bottom: 18 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="client" label={{ value: "Client", position: "insideBottom", offset: -10, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Units dispatched"]} cursor={{ fill: chartTheme.cursor }} /><Bar dataKey="units" radius={[7, 7, 0, 0]}>{clientSales.map((entry, index) => <Cell key={`${entry.client}-${index}`} fill={getContrastBarColor(index, chartTheme)} fillOpacity={getBarColorOpacity(index)} />)}</Bar></BarChart></ResponsiveContainer></div></div></> : <div className="dashboard-empty-chart dashboard-low-data"><span aria-hidden="true">▥</span><strong>{clientSales.length ? "Not enough activity yet this period" : "No dispatch activity yet"}</strong><p>{clientSales.length ? "Record at least four dispatched units to reveal a meaningful client comparison." : "Client dispatches will appear here once sales are recorded."}</p></div>}
          </div>}
          <div ref={(node) => { chartRefs.current.salesDispatchTrend = node; }} data-chart-key="salesDispatchTrend" className={`panel chart-panel${expandedChart === "salesDispatchTrend" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Dispatch trend</span><h3 className="panel-title">{drillMonths.salesDispatchTrend ? "Daily dispatched units" : "Monthly dispatched units"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("salesDispatchTrend")}<DashboardFilterSelect label="Year" value={dispatchYear} onChange={setDispatchYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><button type="button" className="chart-clear-filter" onClick={() => setDispatchYear("all")}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesDispatchTrend")} aria-label={expandedChart === "salesDispatchTrend" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesDispatchTrend" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {drillMonths.salesDispatchTrend ? renderSalesDayChart("salesDispatchTrend") : <ResponsiveContainer width="100%" height={expandedChart === "salesDispatchTrend" ? 650 : 280}>{dispatchedRealPointCount < 3 ? <BarChart data={monthlyDispatchedTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }} onClick={drillFromChart("salesDispatchTrend", monthlyDispatchedTrend)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="units" name="Dispatched units" fill={chartTheme.accentActive} radius={[7, 7, 0, 0]} onClick={drillBar("salesDispatchTrend")} /></BarChart> : <LineChart data={monthlyDispatchedTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }} onClick={drillFromChart("salesDispatchTrend", monthlyDispatchedTrend)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Line type="linear" dataKey="units" name="Dispatched units" stroke={chartTheme.accentActive} strokeWidth={3} dot={{ r: 4, fill: chartTheme.accent, stroke: chartTheme.surface, strokeWidth: 2 }} activeDot={{ r: 6 }} /></LineChart>}</ResponsiveContainer>}
          </div>
          {activeView !== "customerSales" && <div ref={(node) => { chartRefs.current.salesModelTrend = node; }} data-chart-key="salesModelTrend" className={`panel chart-panel${expandedChart === "salesModelTrend" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Sales trend</span><h3 className="panel-title">{drillMonths.salesModelTrend ? "Daily units by model" : "Monthly units by model"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("salesModelTrend")}<DashboardFilterSelect label="Year" value={modelYear} onChange={setModelYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Model" value={salesModel} onChange={setSalesModel} options={[{ value: "all", label: "All models" }, ...salesModels.map((model) => ({ value: model, label: model }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setModelYear("all"); setSalesModel("all"); }}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesModelTrend")} aria-label={expandedChart === "salesModelTrend" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesModelTrend" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {drillMonths.salesModelTrend ? renderSalesDayChart("salesModelTrend") : <ResponsiveContainer width="100%" height={expandedChart === "salesModelTrend" ? 650 : 280}>{modelTrendRealPointCount < 3 ? <BarChart data={salesTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }} onClick={drillFromChart("salesModelTrend", salesTrend)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend />{visibleSalesModels.map((model) => { const modelIndex = salesModels.indexOf(model); return <Bar key={model} dataKey={model} name={model} fill={chartTheme.palette[modelIndex % chartTheme.palette.length]} radius={[5, 5, 0, 0]} onClick={drillBar("salesModelTrend")} />; })}</BarChart> : <LineChart data={salesTrend} margin={{ top: 12, right: 18, left: 0, bottom: 4 }} onClick={drillFromChart("salesModelTrend", salesTrend)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend />{visibleSalesModels.map((model) => { const modelIndex = salesModels.indexOf(model); const color = chartTheme.palette[modelIndex % chartTheme.palette.length]; return <Line key={model} type="linear" dataKey={model} name={model} stroke={color} strokeWidth={salesModel === "all" ? 2 : 3} connectNulls={false} dot={salesModel === "all" ? false : { r: 3, fill: color, strokeWidth: 0 }} activeDot={{ r: 6 }} />; })}</LineChart>}</ResponsiveContainer>}
          </div>}
        <div ref={(node) => { chartRefs.current.locationSales = node; }} data-chart-key="locationSales" className={`panel chart-panel${expandedChart === "locationSales" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Delivery</span><h3 className="panel-title">Units dispatched by end customer{deliveryGroupBy === "location" ? " location" : ""}</h3></div><div className="chart-heading-actions"><div className="dashboard-range-switch chart-range-switch" role="group" aria-label="Group delivery chart by"><button type="button" className={deliveryGroupBy === "customer" ? "active" : ""} aria-pressed={deliveryGroupBy === "customer"} onClick={() => setDeliveryGroupBy("customer")}>Customer</button><button type="button" className={deliveryGroupBy === "location" ? "active" : ""} aria-pressed={deliveryGroupBy === "location"} onClick={() => setDeliveryGroupBy("location")}>Location</button></div><DashboardFilterSelect label="Year" value={locationYear} onChange={setLocationYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={locationMonth} onChange={setLocationMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setLocationYear("all"); setLocationMonth("all"); setDeliveryDrill({ name: "", month: "" }); }}>Clear filters</button><MapPin size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("locationSales")} aria-label={expandedChart === "locationSales" ? "Exit fullscreen" : "Expand chart"}>{expandedChart === "locationSales" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {deliveryDrill.name ? <>
              <div className="chart-drill-bar">
                <button type="button" className="chart-drill-back" onClick={() => setDeliveryDrill((prev) => (prev.month ? { ...prev, month: "" } : { name: "", month: "" }))}>
                  <ChevronLeft size={14} /> {deliveryDrill.month ? "All months" : deliveryGroupBy === "location" ? "All locations" : "All customers"}
                </button>
                <span className="chart-drill-title">
                  <span className="chart-user-dot" style={{ background: deliveryColor(deliveryDrill.name) }} aria-hidden="true" />
                  {deliveryDrill.name} · {deliveryDrill.month ? `${formatMonth(deliveryDrill.month)} · day wise` : "month wise"}
                </span>
              </div>
              {deliveryDrillRows.some((row) => row.units > 0) ? <ResponsiveContainer width="100%" height={expandedChart === "locationSales" ? 610 : 250}>
                <BarChart data={deliveryDrillRows} margin={{ top: 12, right: 12, left: 4, bottom: 20 }} className={deliveryDrill.month ? undefined : "chart-drillable"}>
                  <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                  <XAxis dataKey="label" interval={deliveryDrill.month && expandedChart !== "locationSales" ? "preserveStartEnd" : 0} label={{ value: deliveryDrill.month ? "Day" : "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 10, fill: chartTheme.axis }} />
                  <YAxis label={{ value: "Quantity", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} />
                  <Tooltip contentStyle={chartTheme.tooltip} cursor={{ fill: chartTheme.cursor }} labelFormatter={(label, payload) => payload?.[0]?.payload?.fullLabel || label} formatter={(value) => [value, "Quantity"]} />
                  <Bar dataKey="units" name="Quantity" fill={deliveryColor(deliveryDrill.name)} maxBarSize={deliveryDrill.month ? 28 : 56} radius={[6, 6, 0, 0]} onClick={deliveryDrill.month ? undefined : (entry) => setDeliveryDrill((prev) => ({ ...prev, month: entry?.key ?? entry?.payload?.key ?? "" }))} />
                </BarChart>
              </ResponsiveContainer> : <div className="chart-empty-state" role="status"><span>No deliveries for {deliveryDrill.name} in this period.</span></div>}
              {!deliveryDrill.month && deliveryDrillRows.length > 0 && <p className="chart-drill-hint">Click a month to see its day-wise deliveries.</p>}
            </> : <>
            {locationSales.length === 0 ? <div className="dashboard-empty-chart dashboard-low-data"><span aria-hidden="true">▥</span><strong>No end customer details yet</strong><p>{deliveryGroupBy === "location" ? "Add an End Customer Location on a dispatched sale to see it here." : "Add an End Customer Name on a dispatched sale to see it here."}</p></div> : <ResponsiveContainer width="100%" height={expandedChart === "locationSales" ? 650 : 280}><BarChart data={locationSales} margin={{ top: 8, right: 8, left: 6, bottom: 18 }} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="group" label={{ value: deliveryGroupBy === "location" ? "End Customer Location" : "End Customer Name", position: "insideBottom", offset: -10, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis label={{ value: "Quantity", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Quantity"]} cursor={{ fill: chartTheme.cursor }} /><Bar dataKey="units" maxBarSize={72} radius={[7, 7, 0, 0]} onClick={(entry) => setDeliveryDrill({ name: entry?.group ?? entry?.payload?.group ?? "", month: "" })}>{locationSales.map((entry, index) => <Cell key={`${entry.group}-${index}`} fill={deliveryColor(entry.group)} />)}</Bar></BarChart></ResponsiveContainer>}
            {!deliveryDrill.name && locationSales.length > 0 && <p className="chart-drill-hint">Click a {deliveryGroupBy === "location" ? "location" : "customer"}&apos;s bar to see their month-wise deliveries.</p>}
            </>}
</div>
        </div>
      </section>}
    </div>
  );
}
