import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, BadgeCheck, Boxes, ChevronDown, ChevronLeft, ChevronUp, CircleAlert, Expand, Factory, Flag, MapPin, Minimize2, ShieldCheck, TrendingUp, Truck } from "lucide-react";
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
  DefaultTooltipContent,
} from "recharts";
import KpiCard from "../components/KpiCard";
import DatePicker from "../components/DatePicker";
import { useThemeColors } from "../context/ThemeContext";
import { useModelSelection } from "../context/ModelSelectionContext";
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

function HorizontalActivityBars({ data, labelKey, unitsLabel, colorForRow, modelKeys = [], colorForModel, onBarClick, onModelClick }) {
  const maxUnits = Math.max(1, ...data.map((row) => row.units));

  return (
    <div className="horizontal-activity-bars">
      {data.map((row, index) => {
        const label = row[labelKey];
        const tooltip = `${label}: ${row.units} ${unitsLabel}`;

        const RowElement = onBarClick && !onModelClick ? "button" : "div";
        return (
          <RowElement
            key={`${label}-${index}`}
            type={RowElement === "button" ? "button" : undefined}
            className="horizontal-activity-row"
            onClick={onBarClick && !onModelClick ? () => onBarClick(row) : undefined}
            title={tooltip}
            aria-label={RowElement === "button" ? tooltip : undefined}
          >
            <span className="horizontal-activity-name" title={label}>{label}</span>
            <span className="horizontal-activity-track" aria-hidden="true">
              {modelKeys.length ? modelKeys.map((model) => {
                const units = Number(row.models?.[model] || 0);
                if (units <= 0) return null;
                const SegmentElement = onModelClick ? "button" : "span";
                return <SegmentElement
                  key={model}
                  type={onModelClick ? "button" : undefined}
                  className={`horizontal-activity-fill${onModelClick ? " horizontal-activity-fill--interactive" : ""}`}
                  title={`${model}: ${units} ${unitsLabel}`}
                  aria-label={onModelClick ? `Show defective units for ${model}` : undefined}
                  onClick={onModelClick ? (event) => {
                    event.stopPropagation();
                    onModelClick(model);
                  } : undefined}
                  style={{ width: `${(units / maxUnits) * 100}%`, backgroundColor: colorForModel(model) }}
                />;
              }) : <span
                className="horizontal-activity-fill"
                style={{
                  width: `${row.units > 0 ? Math.max(1, (row.units / maxUnits) * 100) : 0}%`,
                  backgroundColor: colorForRow(row),
                }}
              />}
            </span>
            <span className="horizontal-activity-value">{row.units}</span>
          </RowElement>
        );
      })}
    </div>
  );
}

function ModelLegend({ models, colorForModel }) {
  if (!models.length) return null;
  return (
    <ul className="dashboard-model-legend" aria-label="Models">
      {models.map((model) => (
        <li key={model}><span className="legend-dot" style={{ background: colorForModel(model) }} />{model}</li>
      ))}
    </ul>
  );
}

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
  inStock: { path: "/stock", view: "finishedgoods", field: "status", value: "In Stock" },
  // Waiting for Packing: QC passed, not packed, not sold.
  qcStock: { path: "/stock", view: "finishedgoods", field: "status", value: "Awaiting Packing" },
  inProduction: { path: "/production", field: "stage", value: "In Production" },
  semiFinished: { path: "/production", field: "stage", value: "Semi Finished" },
  qcPassed: { path: "/production", field: "qc", value: "Passed" },
  qcFailed: { path: "/production", field: "qc", value: "Failed" },
  // First-pass yield: every unit with a QC decision (passed and failed).
  firstPassYield: { path: "/production", field: "qc", value: "Passed / Failed" },
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

function summarizeDefectivePartsByModel(defects = []) {
  const counts = defects.reduce((result, defect) => {
    const part = String(defect?.part || "Unspecified").trim() || "Unspecified";
    const model = String(defect?.model || defect?.modelName || "Unspecified").trim() || "Unspecified";
    result[`${part}\u0000${model}`] = (result[`${part}\u0000${model}`] || 0) + 1;
    return result;
  }, {});
  return Object.entries(counts).map(([key, count]) => {
    const [name, model] = key.split("\u0000");
    return { name, model, count };
  });
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

// Hover box for charts that colour each bar or slice on its own (<Cell>):
// Recharts only knows a series colour, so the swatch came out black. This keeps
// the default hover box (and its formatter / label) but gives each line the
// colour of the bar it describes.
function cellColoredTooltip(colorOf) {
  return function CellColoredTooltip(props) {
    const payload = (props.payload || []).map((entry) => ({ ...entry, color: colorOf(entry.payload || {}) || entry.color }));
    return <DefaultTooltipContent {...props} payload={payload} />;
  };
}

function getBarColorOpacity(index) {
  const intensity = [1, 0.76, 0.88];
  return intensity[Math.floor(index / 3) % intensity.length];
}

// Height of one line of phase blocks in the roadmap (block + gap).
const ROADMAP_LANE_PX = 62;

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Dot colour per model row in the phase roadmap.
const ROADMAP_MODEL_COLORS = ["#f5c518", "#5b8def", "#b48cf0", "#f59e63", "#3cc9b0", "#ef6b8a", "#8bc34a", "#64b5f6"];

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

// Names typed by hand ("chennai", "Chennai", " CHENNAI ") are one place or
// customer: they are grouped ignoring case and extra spaces.
function nameLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ") || "Unspecified";
}
function nameMatchKey(value) {
  return nameLabel(value).toLocaleLowerCase();
}
// Which spelling to show for a group: "Chennai" beats "CHENNAI" beats
// "chennai"; between equals, the first one seen stays.
function labelScore(label) {
  if (label === label.toLocaleLowerCase()) return 0;
  if (label === label.toLocaleUpperCase()) return 1;
  return 2;
}
function betterLabel(current, candidate) {
  return labelScore(candidate) > labelScore(current) ? candidate : current;
}
// An all lower-case name is shown with capitals ("chennai" -> "Chennai").
function displayLabel(label) {
  return label === label.toLocaleLowerCase()
    ? label.replace(/(^|[\s\-/(])(\S)/g, (match, before, letter) => before + letter.toLocaleUpperCase())
    : label;
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
    group.name = betterLabel(group.name, label);
  });
  return [...groups.values()].map((group) => ({ ...group, name: displayLabel(group.name) }));
}

export default function Dashboard() {
  const captureRef = useRef(null);
  const chartTheme = useThemeColors();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { role } = useAuth();
  const { setSelectedModel } = useModelSelection();
  const [dashboardModel, setDashboardModel] = useState("");
  const dashboardCacheKey = `vector_dashboard_v3_${role || "guest"}_${dashboardModel || "overall"}`;
  const isRegularUser = role === "user";
  const isProductionIncharge = role === "production_incharge";
  const isProductionOnly = role === "user" || role === "production_incharge";
  const canViewSalesValue = role === "admin" || role === "coadmin";

  useEffect(() => {
    setSelectedModel(dashboardModel);
  }, [dashboardModel, setSelectedModel]);

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
    if (dashboardModel) {
      params.append("field", "model");
      params.append("value", dashboardModel);
    }
    const view = target.view && STOCK_VIEWS[target.view];
    if (view) params.set("view", view);
    return `${target.path}?${params.toString()}`;
  }, [role, dashboardModel]);
  const [activeView, setActiveView] = useState("production");
  const [showCompletedModels, setShowCompletedModels] = useState(false);
  const [showSalesModels, setShowSalesModels] = useState(false);
  const [completedModelSelection, setCompletedModelSelection] = useState("");
  const [completedModelOverview, setCompletedModelOverview] = useState(null);
  const [completedModelOverviewLoading, setCompletedModelOverviewLoading] = useState(false);
  const [completedModelOverviewError, setCompletedModelOverviewError] = useState("");
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
    if (!completedModelSelection) {
      setCompletedModelOverview(null);
      setCompletedModelOverviewError("");
      setCompletedModelOverviewLoading(false);
      return undefined;
    }

    let cancelled = false;
    setCompletedModelOverview(null);
    setCompletedModelOverviewError("");
    setCompletedModelOverviewLoading(true);
    api.get("/dashboard", { params: { model: completedModelSelection } })
      .then((response) => {
        if (!cancelled) setCompletedModelOverview(response.data);
      })
      .catch(() => {
        if (!cancelled) setCompletedModelOverviewError("Could not load this model's overview. Please try selecting it again.");
      })
      .finally(() => {
        if (!cancelled) setCompletedModelOverviewLoading(false);
      });

    return () => { cancelled = true; };
  }, [completedModelSelection]);

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
      const response = await api.get("/dashboard", {
        params: dashboardModel ? { model: dashboardModel } : {},
      });
      let dashboardData = response.data;

      // Compatibility fallback for a running backend that still returns a
      // user-scoped empty defect summary. The shared graph must show the
      // same aggregate defect records for every dashboard role.
      if (isRegularUser && !(dashboardData.defectiveParts || []).length) {
        try {
          const defectsResponse = await api.get("/defects");
          const defects = defectsResponse.data.defects || [];
          const scopedDefects = dashboardModel
            ? defects.filter((defect) =>
              String(defect?.model || "").trim().toLocaleLowerCase() === dashboardModel.toLocaleLowerCase()
            )
            : defects;
          const defectiveParts = summarizeDefectiveParts(scopedDefects);
          const defectivePartsByModel = summarizeDefectivePartsByModel(scopedDefects);
          dashboardData = { ...dashboardData, defectiveParts, defectivePartsByModel };
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
  }, [dashboardModel, isRegularUser, dashboardCacheKey]);

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
  // live-update notice instead of polling or reloading the page.
  useRealtime(
    ["po_details", "invoices", "assembly_units", "sales", "defectives", "phases", "models"],
    () => { loadDashboard(); }
  );

  const liveKpis = dashboard?.kpis || EMPTY_KPIS;
  // Where each model stands in its phase plan today, e.g. "Phase 2 of 3,
  // 1 Oct – 30 Nov, 33 days left". Used by the model view header.
  const modelPhaseInfo = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortDate = (time) => new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const byModel = new Map();
    (dashboard?.phaseRoadmap || []).forEach((phase) => {
      const start = new Date(`${phase.startDate}T00:00:00`).getTime();
      const end = new Date(`${phase.endDate}T00:00:00`).getTime();
      if (!phase.model || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      const key = String(phase.model).trim().toLocaleLowerCase();
      if (!byModel.has(key)) byModel.set(key, []);
      byModel.get(key).push({ name: phase.phase, start, end });
    });
    const info = new Map();
    byModel.forEach((phases, key) => {
      phases.sort((a, b) => a.start - b.start);
      const count = phases.length;
      const runningIndex = phases.findIndex((phase) => today >= phase.start && today <= phase.end);
      if (runningIndex >= 0) {
        const phase = phases[runningIndex];
        const daysLeft = Math.max(0, Math.ceil((phase.end + dayMs - today) / dayMs));
        info.set(key, {
          pill: `Phase ${runningIndex + 1} of ${count}`,
          detail: `${shortDate(phase.start)} – ${shortDate(phase.end)} · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left in phase`,
        });
        return;
      }
      const nextIndex = phases.findIndex((phase) => phase.start > today);
      if (nextIndex >= 0) {
        info.set(key, {
          pill: `Next: Phase ${nextIndex + 1} of ${count}`,
          detail: `${phases[nextIndex].name || `Phase ${nextIndex + 1}`} starts ${shortDate(phases[nextIndex].start)}`,
        });
        return;
      }
      info.set(key, {
        pill: `All ${count} phase${count === 1 ? "" : "s"} completed`,
        detail: `Last phase ended ${shortDate(phases[count - 1].end)}`,
      });
    });
    return info;
  }, [dashboard]);
  const phaseInfoFor = (model) => modelPhaseInfo.get(String(model || "").trim().toLocaleLowerCase()) || null;
  const selectedModelPhase = dashboardModel ? phaseInfoFor(dashboardModel) : null;

  const dashboardModelOptions = [
    { value: "", label: "Overall" },
    ...(dashboard?.modelNames || []).map((model) => ({ value: model, label: model })),
  ];
  const salesDashboard = activeView === "customerSales"
    ? (dashboard?.customerSales || EMPTY_SALES_DASHBOARD)
    : dashboard;
  const salesKpis = salesDashboard?.kpis || EMPTY_KPIS;
  const kpis = useMemo(
    () => KPI_DEFINITIONS.map((kpi) => ({ ...kpi, value: liveKpis[kpi.key] ?? 0 })),
    [liveKpis]
  );
  const defectivePartsByModel = useMemo(() => {
    if (Array.isArray(dashboard?.defectivePartsByModel)) return dashboard.defectivePartsByModel;
    return (dashboard?.defectiveParts || []).map((part) => ({
      name: part.name,
      model: dashboardModel || "Unspecified",
      count: part.count,
    }));
  }, [dashboard, dashboardModel]);
  const defectivePartData = useMemo(() => {
    const parts = new Map();
    defectivePartsByModel.forEach(({ name, model, count }) => {
      const partName = String(name || "Unspecified");
      const modelName = String(model || "Unspecified");
      const row = parts.get(partName) || { name: partName, units: 0, models: {} };
      const value = Number(count || 0);
      row.units += value;
      row.models[modelName] = (row.models[modelName] || 0) + value;
      parts.set(partName, row);
    });
    return [...parts.values()].sort((left, right) => right.units - left.units || left.name.localeCompare(right.name));
  }, [defectivePartsByModel]);
  const defectiveDonutData = useMemo(
    () => defectivePartData.map((part, index) => ({
      name: part.name,
      value: part.units,
      color: getContrastBarColor(index, chartTheme),
    })),
    [defectivePartData, chartTheme]
  );
  const defectiveModelKeys = useMemo(
    () => Array.from(new Set(defectivePartsByModel.map((item) => String(item.model || "Unspecified")))).sort((a, b) => a.localeCompare(b)),
    [defectivePartsByModel]
  );
  const allChartModels = useMemo(() => Array.from(new Set([
    ...(dashboard?.modelNames || []),
    ...(dashboard?.qcByUserModelDay || []).map((item) => item.model),
    ...defectiveModelKeys,
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b)), [dashboard, defectiveModelKeys]);
  const modelColor = (model) => {
    const palette = chartTheme.palette?.length ? chartTheme.palette : [chartTheme.accent];
    return palette[Math.max(0, allChartModels.indexOf(model)) % palette.length];
  };
  const defectiveModelColor = (model) => {
    const palette = ["#D97706", "#DB2777", "#7C3AED", "#2563EB", "#DC2626", "#059669", "#9333EA"];
    return palette[Math.max(0, allChartModels.indexOf(model)) % palette.length];
  };
  const salesValue = salesDashboard?.kpis?.salesValue ?? 0;
  const salesOverviewByModel = (dashboard?.salesByModel || [])
    .filter((model) => !dashboardModel || String(model.model || "").toLocaleLowerCase() === dashboardModel.toLocaleLowerCase())
    .sort((a, b) => Number(b.deliveredUnits || 0) - Number(a.deliveredUnits || 0) || String(a.model).localeCompare(String(b.model)));
  const completedByModel = dashboard?.completedByModel || [];
  const visibleCompletedByModel = dashboardModel
    ? completedByModel.filter((model) => model.model.toLocaleLowerCase() === dashboardModel.toLocaleLowerCase())
    : completedByModel;
  const maxCompletedByModel = Math.max(1, ...visibleCompletedByModel.map((model) => Number(model.units || 0)));
  // Every phase with a target and dates, with its progress worked out for
  // today. Feeds the "Running phases vs target" card (running phases of the
  // selected model, or all models) and the per-model Phase plan cards.
  const phasePlan = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortDate = (time, withYear) => new Date(time).toLocaleDateString("en-IN", withYear
      ? { day: "numeric", month: "short", year: "numeric" }
      : { day: "numeric", month: "short" });
    const modelKey = String(dashboardModel || "").trim().toLocaleLowerCase();
    return (dashboard?.phaseRoadmap || [])
      .filter((phase) => Number(phase.target) > 0 && phase.startDate && phase.endDate)
      .filter((phase) => !modelKey || String(phase.model || "").trim().toLocaleLowerCase() === modelKey)
      .map((phase) => {
        const start = new Date(`${phase.startDate}T00:00:00`).getTime();
        const end = new Date(`${phase.endDate}T00:00:00`).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
        const endExclusive = end + dayMs;
        const target = Number(phase.target);
        const units = Number(phase.units || 0);
        const elapsed = Math.min(1, Math.max(0, (today - start) / (endExclusive - start)));
        const expected = target * elapsed;
        const remaining = Math.max(0, target - units);
        const daysLeft = Math.max(0, Math.ceil((endExclusive - today) / dayMs));
        let status;
        let note;
        if (today < start) {
          status = "upcoming";
          note = `Starts ${shortDate(start)}`;
        } else if (today >= endExclusive || units >= target) {
          status = "completed";
          note = units >= target
            ? `Target met${units > target ? ` · ${units - target} over` : ""}`
            : `Closed ${remaining} unit${remaining === 1 ? "" : "s"} short`;
        } else {
          // Behind = below 90% of where the phase should be by today, the
          // same rule as the roadmap.
          status = units < expected * 0.9 ? "behind" : "running";
          const perDay = daysLeft ? remaining / daysLeft : remaining;
          note = `${remaining} to go · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left · need ${perDay.toFixed(1)} units/day`;
        }
        return {
          ...phase,
          start,
          target,
          units,
          expected,
          daysLeft,
          // Today falls inside the phase dates (even if its target is already met).
          inWindow: today >= start && today < endExclusive,
          status,
          note,
          dates: `${shortDate(start)} – ${shortDate(end, end - start > 300 * dayMs || new Date(start).getFullYear() !== new Date(end).getFullYear())}`,
          progress: Math.min(100, (units / target) * 100),
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(a.model).localeCompare(String(b.model)) || a.start - b.start);
  }, [dashboard, dashboardModel]);

  // Overall view panels: first-pass yield per model and floor alerts.
  const yieldByModel = (dashboard?.floorByModel || [])
    .map((row) => {
      const passed = Number(row.qcPassed || 0);
      const failed = Number(row.qcFailed || 0);
      return { model: row.model, passed, failed, rate: passed + failed ? (passed / (passed + failed)) * 100 : null };
    })
    .filter((row) => row.rate !== null)
    .sort((a, b) => a.rate - b.rate || a.model.localeCompare(b.model));

  const floorAlerts = (() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortDate = (time) => new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const alerts = [];
    // Phases behind schedule first.
    phasePlan.filter((phase) => phase.status === "behind").forEach((phase) => {
      const remaining = Math.max(0, phase.target - phase.units);
      const perDay = phase.daysLeft ? remaining / phase.daysLeft : remaining;
      alerts.push({
        tag: "Phase",
        tone: "phase",
        title: `${phase.model} ${phase.phase} behind target`,
        note: `${phase.units} of ${phase.target} built, ${phase.daysLeft} day${phase.daysLeft === 1 ? "" : "s"} left — need ${perDay.toFixed(1)} units/day`,
      });
    });
    const rows = dashboard?.floorByModel || [];
    const biggestWaiting = Math.max(0, ...rows.map((row) => Number(row.waitingForPacking || 0)));
    rows.forEach((row) => {
      const waiting = Number(row.waitingForPacking || 0);
      const underQc = Number(row.qcInspection || 0);
      if (waiting >= 30) {
        alerts.push({
          tag: "Packing",
          tone: "accent",
          title: `${row.model}: ${waiting} units waiting for packing`,
          note: waiting === biggestWaiting ? "Largest queue on the floor" : "Packing queue is building up",
        });
      }
      if (underQc >= 20) {
        alerts.push({ tag: "QC", tone: "accent", title: `${row.model}: ${underQc} units under QC`, note: "Check QC capacity this week" });
      }
    });
    yieldByModel.filter((row) => row.rate < 90).forEach((row) => {
      alerts.push({
        tag: "Quality",
        tone: "danger",
        title: `${row.model} yield at ${Math.round(row.rate)}%`,
        note: "Below the 90% target — review failed units",
      });
    });
    // Models with no phase running whose next phase starts within 45 days.
    const byModel = new Map();
    phasePlan.forEach((phase) => {
      if (!byModel.has(phase.model)) byModel.set(phase.model, []);
      byModel.get(phase.model).push(phase);
    });
    byModel.forEach((phases, model) => {
      if (phases.some((phase) => phase.status === "running" || phase.status === "behind")) return;
      const next = phases.find((phase) => phase.status === "upcoming");
      if (next && next.start - today <= 45 * dayMs) {
        alerts.push({
          tag: "Upcoming",
          tone: "info",
          title: `${model} ${next.phase} starts ${shortDate(next.start)}`,
          note: `Target ${next.target} units — get line, parts and QC staff ready`,
        });
      }
    });
    return alerts;
  })();

  // "Running" = today is inside the phase dates. A phase that already met its
  // target early still counts until its end date, so the card matches the
  // phases you see scheduled for today.
  const runningPhases = phasePlan.filter((phase) => phase.inWindow);
  const runningBuilt = runningPhases.reduce((sum, phase) => sum + phase.units, 0);
  const runningTarget = runningPhases.reduce((sum, phase) => sum + phase.target, 0);
  // One model with a single running phase: name the phase, like
  // "Phase 2 vs target · 82% built · 33 days left".
  const singleRunning = dashboardModel && runningPhases.length === 1 ? runningPhases[0] : null;
  const runningCard = singleRunning
    ? {
      label: `${singleRunning.phase} vs target`,
      value: `${singleRunning.units} / ${singleRunning.target}`,
      note: `${Math.round((singleRunning.units / singleRunning.target) * 100)}% built · ${singleRunning.daysLeft} day${singleRunning.daysLeft === 1 ? "" : "s"} left`,
    }
    : runningPhases.length
    ? {
      // "All models" (or a model with overlapping phases running).
      label: dashboardModel ? "Phases vs target" : "Running phases vs target",
      value: `${runningBuilt} / ${runningTarget}`,
      note: `${Math.round((runningBuilt / runningTarget) * 100)}% built · ${runningPhases.length} phase${runningPhases.length === 1 ? "" : "s"} running`,
    }
    : dashboardModel
    ? (() => {
      // One model, nothing running today: "Phase target · 0 / 0".
      const next = phasePlan.find((phase) => phase.status === "upcoming");
      return {
        label: "Phase target",
        value: "0 / 0",
        note: next ? `No phase running yet · ${next.phase} starts ${next.note.replace(/^Starts /, "")}` : "No phase running yet",
      };
    })()
    : { label: "Running phases vs target", value: "—", note: "No phase running today" };

  // First-pass yield: of the units with a QC decision, the share that passed.
  const qcPassedCount = Number(liveKpis.qcPassed ?? 0);
  const qcFailedCount = Number(liveKpis.qcFailed ?? 0);
  const qcDecided = qcPassedCount + qcFailedCount;
  const firstPassYield = qcDecided ? (qcPassedCount / qcDecided) * 100 : null;

  const phaseRoadmap = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    // A phase needs only a start date to sit on the timeline.  Target and end
    // date are optional: with no end date the block runs to this month.
    const placed = new Set();
    const phases = (dashboard?.phaseRoadmap || [])
      .map((phase) => {
        if (!phase.startDate) return null;
        const start = new Date(`${phase.startDate}T00:00:00`).getTime();
        const end = phase.endDate ? new Date(`${phase.endDate}T00:00:00`).getTime() : Math.max(start, today);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
        placed.add(phase);
        return { ...phase, start, endExclusive: end + dayMs, openEnded: !phase.endDate };
      })
      .filter(Boolean);
    // Phases without a start date cannot sit on a timeline; list them under
    // it so they are not silently missing.
    const unscheduled = (dashboard?.phaseRoadmap || [])
      .filter((phase) => !placed.has(phase))
      .map((phase) => ({
        key: `${phase.modelId || phase.model}-${phase.phaseId || phase.phase}`,
        model: phase.model,
        phase: phase.phase,
        target: Number(phase.target) > 0 ? Number(phase.target) : null,
        units: Number(phase.units || 0),
        missing: "start date",
      }))
      .sort((a, b) => String(a.model).localeCompare(String(b.model)) || String(a.phase).localeCompare(String(b.phase)));
    if (!phases.length) return { months: [], models: [], rangeLabel: "", unscheduled };

    const first = new Date(Math.min(...phases.map((phase) => phase.start)));
    const last = new Date(Math.max(...phases.map((phase) => phase.endExclusive - dayMs)));
    const rangeStart = new Date(first.getFullYear(), first.getMonth(), 1).getTime();
    // At least 8 months on screen so a short plan doesn't stretch into a
    // few huge blocks; longer plans run to the last phase's month.
    const rangeEnd = Math.max(
      new Date(first.getFullYear(), first.getMonth() + 8, 1).getTime(),
      new Date(last.getFullYear(), last.getMonth() + 1, 1).getTime()
    );
    // Blocks snap to whole month columns (equal width), so a phase of a few
    // days still fills its month instead of shrinking to an unreadable box.
    const monthKey = (time) => { const d = new Date(time); return d.getFullYear() * 12 + d.getMonth(); };
    const firstMonth = monthKey(rangeStart);
    const monthCount = monthKey(rangeEnd) - firstMonth;
    const monthLabel = (date, withYear) => `${MONTH_SHORT[date.getMonth()]}${withYear ? ` ${date.getFullYear()}` : ""}`;
    const months = [];
    for (let cursor = new Date(rangeStart); cursor.getTime() < rangeEnd; cursor.setMonth(cursor.getMonth() + 1)) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1).getTime();
      // "Aug", "Sep" … with the year on January and on the first month.
      months.push({
        label: monthLabel(cursor, cursor.getMonth() === 0 || cursor.getTime() === rangeStart),
        width: 100 / monthCount,
        current: today >= cursor.getTime() && today < monthEnd,
      });
    }

    const grouped = new Map();
    phases.forEach((phase) => {
      const target = Number(phase.target) > 0 ? Number(phase.target) : 0;
      const units = Number(phase.units || 0);
      const elapsed = Math.min(1, Math.max(0, (today - phase.start) / (phase.endExclusive - phase.start)));
      let status = "running";
      if ((target && units >= target) || (!phase.openEnded && today >= phase.endExclusive)) status = "completed";
      else if (today < phase.start) status = "upcoming";
      // "Behind" needs both a target and an end date to measure pace against.
      else if (target && !phase.openEnded && units < target * elapsed * 0.9) status = "behind";
      const row = grouped.get(phase.model) || { model: phase.model, phases: [] };
      row.phases.push({
        ...phase,
        status,
        target,
        progress: target ? Math.min(100, (units / target) * 100) : 0,
        startMonth: monthKey(phase.start) - firstMonth,
        endMonth: monthKey(phase.endExclusive - dayMs) - firstMonth,
        left: ((monthKey(phase.start) - firstMonth) / monthCount) * 100,
        width: ((monthKey(phase.endExclusive - dayMs) - monthKey(phase.start) + 1) / monthCount) * 100,
      });
      grouped.set(phase.model, row);
    });
    grouped.forEach((row) => {
      row.phases.sort((a, b) => a.start - b.start || a.endExclusive - b.endExclusive);
      const laneEnds = [];
      // Phases sharing a month go on separate lines so blocks never overlap.
      row.phases.forEach((phase) => {
        let lane = laneEnds.findIndex((laneEnd) => laneEnd < phase.startMonth);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = phase.endMonth;
        phase.lane = lane;
      });
      row.laneCount = Math.max(1, laneEnds.length);
    });
    const rangeLabel = `${monthLabel(first, true)} – ${monthLabel(new Date(rangeEnd - dayMs), true)}`;
    const models = [...grouped.values()].sort((a, b) => a.model.localeCompare(b.model));
    models.forEach((row, index) => { row.color = ROADMAP_MODEL_COLORS[index % ROADMAP_MODEL_COLORS.length]; });
    return { months, models, rangeLabel, unscheduled };
  }, [dashboard?.phaseRoadmap]);

  // Long plans scroll sideways inside the roadmap box; open it at last
  // month so the current phases are in view without scrolling.
  const roadmapScrollRef = useRef(null);
  useEffect(() => {
    const box = roadmapScrollRef.current;
    const current = box?.querySelector(".phase-roadmap-months .is-current");
    if (!box || !current || box.scrollWidth <= box.clientWidth) return;
    const modelColumn = box.querySelector(".phase-roadmap-axis > strong")?.offsetWidth || 0;
    const offset = current.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    box.scrollLeft = Math.max(0, offset - modelColumn - current.offsetWidth);
  }, [phaseRoadmap]);
  const completedModelKpis = completedModelOverview?.kpis || EMPTY_KPIS;
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
    setFallbackDelivery(null);
    api.get("/sales", { params: { page: 1, limit: 100, ...(dashboardModel ? { model: dashboardModel } : {}) }, __vectorBackground: true })
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
  }, [needsDeliveryFallback, dashboard, dashboardModel]);

  // The delivery series for the current Customer / Location switch.
  const deliverySource = useMemo(() => {
    const seriesKey = deliveryGroupBy === "location" ? "endUserLocationByDay" : "endUserClientByDay";
    const modelSeriesKey = deliveryGroupBy === "location" ? "endUserLocationByModelDay" : "endUserClientByModelDay";
    const source = Array.isArray(salesDashboard?.[modelSeriesKey])
      ? salesDashboard[modelSeriesKey]
      : Array.isArray(salesDashboard?.[seriesKey])
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
    const modelSeriesKey = deliveryGroupBy === "location" ? "endUserLocationByModelDay" : "endUserClientByModelDay";
    const seriesKey = deliveryGroupBy === "location" ? "endUserLocationByDay" : "endUserClientByDay";
    const nameKey = deliveryGroupBy === "location" ? "location" : "client";
    const source = Array.isArray(salesDashboard?.[modelSeriesKey])
      ? salesDashboard[modelSeriesKey]
      : Array.isArray(salesDashboard?.[seriesKey])
      ? salesDashboard[seriesKey]
      : activeView === "sales" ? fallbackDelivery?.[seriesKey] : [];
    const items = (source || []).filter((item) => {
      const period = String(item.period || "");
      if (locationYear !== "all" && !period.startsWith(locationYear)) return false;
      return locationMonth === "all" || period.slice(5, 7) === locationMonth;
    });
    // "chennai", "Chennai" and " CHENNAI " are one bar.
    const grouped = new Map();
    items.forEach((item) => {
      const label = nameLabel(item[nameKey]);
      const key = nameMatchKey(label);
      const row = grouped.get(key) || { group: label, units: 0 };
      row.group = betterLabel(row.group, label);
      const units = Number(item.units || 0);
      row.units += units;
      if (item.model) row[item.model] = (row[item.model] || 0) + units;
      grouped.set(key, row);
    });
    return [...grouped.values()]
      .map((row) => ({ ...row, group: displayLabel(row.group) }))
      .sort((a, b) => b.units - a.units || a.group.localeCompare(b.group));
  }, [salesDashboard, fallbackDelivery, activeView, deliveryGroupBy, locationYear, locationMonth]);
  const deliveryModels = useMemo(
    () => Array.from(new Set(deliverySource.map((item) => String(item.model || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [deliverySource]
  );
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
    if (activeView === "customerSales" && Array.isArray(salesDashboard?.endUserClientByModelDay)) {
      const rows = new Map();
      salesDashboard.endUserClientByModelDay.forEach((item) => {
        const period = String(item.period || "");
        if (clientYear !== "all" && !period.startsWith(clientYear)) return;
        if (clientMonth !== "all" && period.slice(5, 7) !== clientMonth) return;
        // "abc traders" and "ABC Traders" are one customer.
        const label = nameLabel(item.client);
        const key = nameMatchKey(label);
        const row = rows.get(key) || { client: label, units: 0 };
        row.client = betterLabel(row.client, label);
        const units = Number(item.units || 0);
        row.units += units;
        row[item.model] = (row[item.model] || 0) + units;
        rows.set(key, row);
      });
      return [...rows.values()]
        .map((row) => ({ ...row, client: displayLabel(row.client) }))
        .sort((a, b) => b.units - a.units || a.client.localeCompare(b.client));
    }
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
  const clientSalesModels = useMemo(
    () => Array.from(new Set(clientSales.flatMap((item) => Object.keys(item).filter((key) => key !== "client" && key !== "units"))))
      .sort((a, b) => a.localeCompare(b)),
    [clientSales]
  );
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
  const dispatchedModels = useMemo(
    () => Array.from(new Set((salesDashboard?.dispatchedByModelMonth || []).map((item) => item.model).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b)),
    [salesDashboard]
  );
  const monthlyDispatchedTrend = useMemo(() => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const rows = monthNames.map((month) => ({
      month,
      units: 0,
      ...Object.fromEntries(dispatchedModels.map((model) => [model, 0])),
    }));
    (salesDashboard?.dispatchedByModelMonth || []).forEach((item) => {
      const period = String(item.period || "");
      if (dispatchYear !== "all" && !period.startsWith(dispatchYear)) return;
      const monthIndex = Number(period.slice(5, 7)) - 1;
      if (monthIndex >= 0 && monthIndex < 12 && rows[monthIndex]) {
        const units = Number(item.units || 0);
        rows[monthIndex][item.model] = (rows[monthIndex][item.model] || 0) + units;
        rows[monthIndex].units += units;
      }
    });
    return rows;
  }, [salesDashboard, dispatchYear, dispatchedModels]);
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
    // Overall view: the same monthly units split by model. The five biggest
    // models keep their own colour; the rest are grouped as "Others".
    // QC and packaging rows also carry a status; it is kept per model so the
    // tooltip can still say e.g. "4 passed · 1 failed".
    const splitByModel = (source) => {
      const totals = new Map();
      const cells = [];
      (source || []).forEach(({ period, user, model, units, status }) => {
        if (!matchesProductionPeriod(period, user)) return;
        const index = Number(String(period).slice(5, 7)) - 1;
        if (index < 0 || index > 11) return;
        const value = Number(units || 0);
        totals.set(model, (totals.get(model) || 0) + value);
        cells.push({ index, model, value, status });
      });
      const ranked = [...totals.entries()].filter(([, total]) => total > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([model]) => model);
      const top = ranked.slice(0, 5);
      const keys = ranked.length > 5 ? [...top, `Others (${ranked.length - 5})`] : top;
      const rows = monthNames.map((month) => ({ month, units: 0, statuses: {} }));
      cells.forEach(({ index, model, value, status }) => {
        const key = top.includes(model) ? model : keys[keys.length - 1];
        rows[index][key] = (rows[index][key] || 0) + value;
        rows[index].units += value;
        if (status) {
          const byStatus = rows[index].statuses[key] || (rows[index].statuses[key] = {});
          byStatus[status] = (byStatus[status] || 0) + value;
        }
      });
      return { rows, keys };
    };
    return {
      assembled,
      qc,
      packaged,
      byModel: {
        monthlyAssembled: splitByModel(dashboard?.assembledByMonthUserModel),
        monthlyQc: splitByModel(dashboard?.qcByMonthStatusUserModel),
        monthlyPackaging: splitByModel(dashboard?.packagedByMonthStatusUserModel),
      },
    };
  }, [dashboard, productionYear, productionMonth, productionUser, productionFromDate, productionToDate]);
  // Overall view: assembly, QC and packaging are split by model (bars stack
  // one colour per model).  QC/packaging status stays in the tooltip.  With a
  // single model selected the charts show status instead.
  const showByModel = (chartKey) => !dashboardModel && Boolean(productionMonthCharts.byModel[chartKey]?.keys.length > 0);
  const modelTooltipFormatter = (value, name, item) => {
    const statuses = item?.payload?.statuses?.[name];
    const detail = statuses
      ? Object.entries(statuses).filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${status.toLowerCase()}`).join(" · ")
      : "";
    return [detail ? `${value} (${detail})` : value, name];
  };
  // One colour per model across all three charts (by its place in the model list).
  const modelChartColor = (model) => {
    if (model.startsWith("Others (")) return "#7a7d85";
    const names = dashboard?.modelNames || [];
    const index = Math.max(0, names.findIndex((name) => name === model));
    return ROADMAP_MODEL_COLORS[index % ROADMAP_MODEL_COLORS.length];
  };
  const renderModelStackChart = (chartKey) => {
    const { rows, keys } = productionMonthCharts.byModel[chartKey];
    return (
      <>
        <ResponsiveContainer width="100%" height={expandedChart === chartKey ? 650 : 280}>
          <BarChart data={rows} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart(chartKey, rows)} className="chart-drillable">
            <CartesianGrid stroke={chartTheme.grid} vertical={false} />
            <XAxis dataKey="month" interval={0} tick={{ fontSize: 11, fill: chartTheme.axis }} />
            <YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} />
            <Tooltip contentStyle={chartTheme.tooltip} itemSorter={(item) => keys.indexOf(item.dataKey)} formatter={modelTooltipFormatter} />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 14 }} iconType="square" />
            {keys.map((model, index) => (
              <Bar key={model} dataKey={model} name={model} stackId={chartKey} maxBarSize={44} onClick={drillBar(chartKey)} fill={modelChartColor(model)} radius={index === keys.length - 1 ? [5, 5, 0, 0] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        {keys.length > 5 && <p className="chart-model-note">Shows the top 5 models; the rest are grouped as “Others” so the chart stays readable.</p>}
      </>
    );
  };
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
      qc: qcRange === "daily"
        ? dashboard?.qcByUserModelDay || dashboard?.qcByUserDay
        : dashboard?.qcByUserModelWeek || dashboard?.qcByUserWeek,
      assembled: qcRange === "daily" ? dashboard?.assembledByUserDay : dashboard?.assembledByUserWeek,
      packaged: qcRange === "daily" ? dashboard?.packagedByUserDay : dashboard?.packagedByUserWeek,
    };
    const source = sources[userActivity];
    const totals = (source || []).reduce((result, item) => {
      if (!isWithinDateRange(item.period, qcFromDate, qcToDate)) return result;
      if (qcUserFilter !== "all" && item.user !== qcUserFilter) return result;
      const row = result[item.user] || { user: item.user, units: 0, models: {} };
      const units = Number(item.units || 0);
      row.units += units;
      if (userActivity === "qc" && item.model) {
        row.models[item.model] = (row.models[item.model] || 0) + units;
      }
      result[item.user] = row;
      return result;
    }, {});
    return Object.values(totals).sort((left, right) => right.units - left.units || left.user.localeCompare(right.user));
  }, [dashboard, qcRange, userActivity, qcFromDate, qcToDate, qcUserFilter]);
  const qcActivityModelKeys = useMemo(
    () => Array.from(new Set(qcUserData.flatMap((row) => Object.keys(row.models || {})))).sort((a, b) => a.localeCompare(b)),
    [qcUserData]
  );
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
  const selectActivityUser = (user) => {
    const selectedUser = user === "all" ? "" : user;
    setQcUserFilter(user || "all");
    openActivityUser(selectedUser);
  };
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
  useEffect(() => { setAssemblyDayFallback(null); }, [dashboardModel]);
  const needsAssemblyDayFallback = activeView === "production" && anyProductionDrill && Boolean(dashboard)
    && (!Array.isArray(dashboard?.qcByDayStatusUser) || !Array.isArray(dashboard?.packagedByDayStatusUser));
  useEffect(() => {
    if (!needsAssemblyDayFallback || assemblyDayFallback) return undefined;
    let cancelled = false;
    api.get("/assembly", { params: { page: 1, limit: 100, ...(dashboardModel ? { model: dashboardModel } : {}) }, __vectorBackground: true })
      .then((response) => {
        if (cancelled) return;
        const units = (response.data?.allRows || response.data?.assemblyUnits || []).filter((unit) =>
          !dashboardModel || String(unit.model || "").trim().toLocaleLowerCase() === dashboardModel.toLocaleLowerCase()
        );
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
  }, [needsAssemblyDayFallback, assemblyDayFallback, dashboardModel]);
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
    // Overall view: the month's days split by the same models as the monthly
    // "by model" chart (top 5 + Others), with QC / packaging status kept for
    // the tooltip.  Null when the chart is not split or the backend is older.
    const byModelDay = (chartKey, source) => {
      const month = drillMonths[chartKey];
      const keys = productionMonthCharts.byModel?.[chartKey]?.keys || [];
      if (!month || dashboardModel || !keys.length || !Array.isArray(source)) return null;
      const others = keys.find((key) => key.startsWith("Others ("));
      const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
      const rows = Array.from({ length: days }, (_, index) => ({
        day: String(index + 1),
        statuses: {},
        ...Object.fromEntries(keys.map((key) => [key, 0])),
      }));
      source.forEach((item) => {
        const period = String(item.period || "");
        if (!period.startsWith(`${month}-`)) return;
        if (productionUser !== "all" && item.user !== productionUser) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        const key = keys.includes(item.model) && item.model !== others ? item.model : others;
        if (!row || !key) return;
        const units = Number(item.units || 0);
        row[key] += units;
        if (item.status) {
          const byStatus = row.statuses[key] || (row.statuses[key] = {});
          byStatus[item.status] = (byStatus[item.status] || 0) + units;
        }
      });
      return { rows, keys };
    };
    return {
      byModel: {
        monthlyAssembled: byModelDay("monthlyAssembled", dashboard?.assembledByDayUserModel),
        monthlyQc: byModelDay("monthlyQc", dashboard?.qcByDayStatusUserModel),
        monthlyPackaging: byModelDay("monthlyPackaging", dashboard?.packagedByDayStatusUserModel),
      },
      monthlyAssembled: build("monthlyAssembled", { units: 0 }, dashboard?.assembledByUserDay,
        (row, item) => { row.units += Number(item.units || 0); }),
      monthlyQc: build("monthlyQc", { Passed: 0, "Under Inspection": 0, Pending: 0, Failed: 0 }, qcSource,
        (row, item) => { if (item.status in row) row[item.status] += Number(item.units || 0); }),
      monthlyPackaging: build("monthlyPackaging", { Pending: 0, "In Progress": 0, Packed: 0 }, packagedSource,
        (row, item) => { if (item.status in row) row[item.status] += Number(item.units || 0); }),
    };
  }, [drillMonths, dashboard, assemblyDayFallback, productionUser, productionMonthCharts, dashboardModel]);

  // ---- Day-wise drill-down for the two sales trend charts ----
  // Months with sales activity, newest first, for each chart's own Year filter.
  const salesDrillMonthOptions = useMemo(() => {
    const monthsOf = (items, year) => Array.from(new Set((items || [])
      .map((item) => String(item.period || "").slice(0, 7))
      .filter((value) => /^\d{4}-\d{2}$/.test(value) && (year === "all" || value.startsWith(year)))))
      .sort((a, b) => b.localeCompare(a));
    return {
      // Same series as the bars, so a listed month always has dispatches.
      salesDispatchTrend: monthsOf(salesDashboard?.dispatchedByModelMonth || salesDashboard?.salesByMonth, dispatchYear),
      salesModelTrend: monthsOf(salesDashboard?.salesByModelMonth, modelYear),
    };
  }, [salesDashboard, dispatchYear, modelYear]);

  // "Monthly units by model" counts every sale that is not cancelled, by model,
  // on the sale's date. The dashboard only sends that per month, so the days
  // are read from the Sale Register lines once the chart is drilled.
  const [salesDayRows, setSalesDayRows] = useState(null);
  // Only an older backend without `salesByModelDay` needs the Sale Register lines.
  const needsSalesDayRows = activeView === "sales" && Boolean(drillMonths.salesModelTrend)
    && !Array.isArray(salesDashboard?.salesByModelDay);
  useEffect(() => {
    if (!needsSalesDayRows || salesDayRows) return undefined;
    let cancelled = false;
    api.get("/sales", { params: { page: 1, limit: 100, ...(dashboardModel ? { model: dashboardModel } : {}) }, __vectorBackground: true })
      .then((response) => {
        if (cancelled) return;
        const rows = response.data?.allRows || response.data?.sales || [];
        setSalesDayRows(dashboardModel
          ? rows.filter((sale) => String(sale.model || "").trim().toLocaleLowerCase() === dashboardModel.toLocaleLowerCase())
          : rows);
      })
      .catch(() => { if (!cancelled) setSalesDayRows([]); });
    return () => { cancelled = true; };
  }, [needsSalesDayRows, salesDayRows, dashboardModel]);
  useEffect(() => { setSalesDayRows(null); }, [dashboard]);

  const salesDayCharts = useMemo(() => {
    const daysOf = (month, emptyRow) => {
      const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
      return Array.from({ length: days }, (_, index) => ({ day: String(index + 1), ...emptyRow }));
    };
    const result = {};
    const dispatchMonth = drillMonths.salesDispatchTrend;
    if (dispatchMonth) {
      const rows = daysOf(dispatchMonth, {
        units: 0,
        ...Object.fromEntries(dispatchedModels.map((model) => [model, 0])),
      });
      (salesDashboard?.dispatchedByModelDay || []).forEach((item) => {
        const period = String(item.period || "");
        if (!period.startsWith(`${dispatchMonth}-`)) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        if (row) {
          const units = Number(item.units || 0);
          row[item.model] = (row[item.model] || 0) + units;
          row.units += units;
        }
      });
      result.salesDispatchTrend = rows;
    }
    const modelMonth = drillMonths.salesModelTrend;
    if (modelMonth && Array.isArray(salesDashboard?.salesByModelDay)) {
      // The monthly bars' own series, per day: the days add up to the month.
      const rows = daysOf(modelMonth, Object.fromEntries(visibleSalesModels.map((model) => [model, 0])));
      salesDashboard.salesByModelDay.forEach((item) => {
        const period = String(item.period || "");
        if (!period.startsWith(`${modelMonth}-`)) return;
        if (salesModel !== "all" && item.model !== salesModel) return;
        const row = rows[Number(period.slice(8, 10)) - 1];
        if (row) row[item.model] = (row[item.model] || 0) + Number(item.units || 0);
      });
      result.salesModelTrend = rows;
    } else if (modelMonth) {
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
  }, [drillMonths, salesDashboard, salesDayRows, visibleSalesModels, salesModel, dispatchedModels]);

  const renderSalesDayChart = (chartKey) => (chartKey === "salesDispatchTrend"
    ? renderDayChart(chartKey, {
      rows: salesDayCharts.salesDispatchTrend,
      series: dispatchedModels.map((model) => ({
        key: model,
        name: model,
        color: chartTheme.palette[salesModels.indexOf(model) % chartTheme.palette.length],
      })),
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
              <Tooltip contentStyle={chartTheme.tooltip} labelFormatter={(day) => `${day} ${formatDrillMonth(drillMonths[chartKey])}`} cursor={{ fill: chartTheme.cursor }} itemSorter={(item) => series.findIndex((entry) => entry.key === item.dataKey)} formatter={override.tooltipFormatter} />
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
  // Production drill-down: split by model in the Overall view, like the
  // monthly chart it came from; by status when one model is selected.
  const renderProductionDayChart = (chartKey) => {
    const split = productionDayCharts.byModel?.[chartKey];
    if (!split) return renderDayChart(chartKey);
    return renderDayChart(chartKey, {
      rows: split.rows,
      series: split.keys.map((model) => ({ key: model, name: model, color: modelChartColor(model) })),
      loading: false,
      legend: true,
      tooltipFormatter: modelTooltipFormatter,
    });
  };
  const dayTitleByModel = (chartKey, title) => (productionDayCharts.byModel?.[chartKey] ? `${title} by model` : title);
  // Unsold stock, matched to sales by serial, split by packing: "In Stock" is
  // packed and ready, "Waiting for Packing" passed QC but is not packed yet.
  // Like the other cards, the notes describe what is counted.
  const inStockPacked = Number(liveKpis.inStockPacked ?? 0);
  const waitingForPacking = Number(liveKpis.inStockPackingPending ?? 0);
  const packedStockNote = "Packing completed, ready to dispatch";
  const qcStockNote = "QC passed, packing not done yet";
  // "1 unit", not "1 units".
  const unitsLabel = (value) => `${value ?? 0} unit${Number(value ?? 0) === 1 ? "" : "s"}`;
  const selectedModelStats = [
    { label: "Total Unit", value: unitsLabel(completedModelKpis.total), note: "Production pipeline" },
    { label: "In Stock", value: unitsLabel(completedModelKpis.inStockPacked), note: packedStockNote },
    { label: "Waiting for Packing", value: unitsLabel(completedModelKpis.inStockPackingPending), note: qcStockNote },
    { label: "Sold Units", value: unitsLabel(completedModelKpis.sold), note: "Delivered" },
    { label: "Units in Production", value: unitsLabel(completedModelKpis.inProduction), note: "Active assembly" },
    { label: "QC Passed", value: unitsLabel(completedModelKpis.qcPassed), note: "Quality cleared" },
    { label: "QC Failed", value: unitsLabel(completedModelKpis.qcFailed), note: "Failed inspection" },
    { label: "Units Semi Finished", value: unitsLabel(completedModelKpis.semiFinished), note: "In progress" },
    { label: "Under QC Inspection", value: unitsLabel(completedModelKpis.qcInspection), note: "Awaiting decision" },
    { label: "Defective Units Reported", value: Number(completedModelKpis.defects ?? 0).toLocaleString("en-IN"), note: "Defect reports" },
  ];
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
      {defectivePartData.length ? <>
        {dashboardModel ? <>
          <div className="chart-scroll-inner chart-scroll-inner-pie chart-scroll-inner-defective-pie">
            <ResponsiveContainer width="100%" height={expandedChart === chartKey ? 610 : 280}>
              <PieChart>
                <Pie
                  data={defectiveDonutData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={94}
                  paddingAngle={3}
                  onClick={() => {
                    const params = new URLSearchParams({ from: "dashboard", field: "model", value: dashboardModel });
                    navigate(`/defects?${params.toString()}`);
                  }}
                >
                  {defectiveDonutData.map((part) => <Cell key={part.name} fill={part.color} />)}
                </Pie>
                <Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Defect reports"]} content={cellColoredTooltip((row) => row.color)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="legend">
            {defectiveDonutData.map((part) => (
              <li key={part.name}><span className="legend-dot" style={{ background: part.color }} />{part.name} <b>{part.value}</b></li>
            ))}
          </ul>
        </> : <>
          <div className="chart-scroll chart-scroll--defective-parts">
            <HorizontalActivityBars
              data={defectivePartData}
              labelKey="name"
              unitsLabel="defect reports"
              colorForRow={(row) => defectiveModelColor(Object.keys(row.models || {})[0] || "Unspecified")}
              modelKeys={defectiveModelKeys}
              colorForModel={defectiveModelColor}
              onModelClick={(model) => {
                const params = new URLSearchParams({ from: "dashboard", field: "model", value: model });
                navigate(`/defects?${params.toString()}`);
              }}
            />
          </div>
          <ModelLegend models={defectiveModelKeys} colorForModel={defectiveModelColor} />
        </>}
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
        {dashboardModel ? (
          <div className="dashboard-model-heading">
            <p className="dashboard-eyebrow-label">Operations control · Model view</p>
            <h2 className="dashboard-page-heading dashboard-page-heading--model">{dashboardModel}</h2>
            <div className="dashboard-model-meta">
              {selectedModelPhase && <span className="dashboard-model-phase-pill">{selectedModelPhase.pill}</span>}
              {selectedModelPhase && <span>{selectedModelPhase.detail}</span>}
              <button type="button" className="dashboard-model-back" onClick={() => setDashboardModel("")}>← All models</button>
            </div>
          </div>
        ) : (
          <div>
            <p className="dashboard-eyebrow-label">Operations control</p>
            <h2 className="dashboard-page-heading">Production &amp; sales overview</h2>
          </div>
        )}
        <div className="dashboard-header-controls">
          <DashboardFilterSelect label="Model" value={dashboardModel} onChange={setDashboardModel} options={dashboardModelOptions} />
          <div className="dashboard-tabs" data-active={activeView} data-single={isProductionOnly} role="tablist" aria-label="Dashboard views">
            <button className={`dashboard-tab${activeView === "production" ? " active" : ""}`} onClick={() => setActiveView("production")} role="tab" aria-selected={activeView === "production"}><Factory size={16} /> Production</button>
            {!isProductionOnly && <button className={`dashboard-tab${activeView === "sales" ? " active" : ""}`} onClick={() => setActiveView("sales")} role="tab" aria-selected={activeView === "sales"}><TrendingUp size={16} /> Vector Sales</button>}
            {/* End User tab hidden for now - uncomment to bring it back.
            {!isProductionOnly && <button className={`dashboard-tab${activeView === "customerSales" ? " active" : ""}`} onClick={() => setActiveView("customerSales")} role="tab" aria-selected={activeView === "customerSales"}><TrendingUp size={16} /> End User</button>} */}
          </div>
        </div>
      </header>
      <section className="dashboard-summary" aria-labelledby="operations-summary-title">
        <h2 id="operations-summary-title" className="sr-only">Operations summary</h2>
        <div className={`dashboard-summary-grid${activeView === "production" ? " dashboard-summary-grid--production" : ""}`} aria-label="Operations highlights">
          {activeView === "production" ? <>
            <StatCard className="summary-card summary-card--neutral" to={kpiTarget("total")} iconClass="summary-card-icon" icon={<Factory size={19} />} label="Total Unit" value={unitsLabel(liveKpis.total)} note="In production + semi finished + QC" />
            <StatCard className="summary-card summary-card--neutral" iconClass="summary-card-icon" icon={<Flag size={19} />} label={runningCard.label} value={runningCard.value} note={runningCard.note} />
            <StatCard className="summary-card summary-card--neutral" to={kpiTarget("firstPassYield")} iconClass="summary-card-icon" icon={<BadgeCheck size={19} />} label="First-pass yield" value={firstPassYield === null ? "—" : `${firstPassYield.toFixed(1)}%`} note={qcDecided ? `${qcPassedCount} passed · ${qcFailedCount} failed` : "No QC decisions yet"} />
            <StatCard className="summary-card summary-card--success" to={kpiTarget("inStock")} iconClass="summary-card-icon" icon={<Boxes size={19} />} label="In Stock" value={unitsLabel(inStockPacked)} note={packedStockNote} />
            <StatCard className="summary-card summary-card--success" to={kpiTarget("qcStock")} iconClass="summary-card-icon" icon={<ShieldCheck size={19} />} label="Waiting for Packing" value={unitsLabel(waitingForPacking)} note={qcStockNote} />
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
        {activeView === "production" && !dashboardModel && <button
          type="button"
          className="dashboard-summary-more"
          onClick={() => setShowCompletedModels((shown) => !shown)}
          aria-expanded={showCompletedModels}
          aria-controls="completed-models-content"
        >
          {showCompletedModels ? <>Show less <ChevronUp size={15} /></> : <>See more <ChevronDown size={15} /></>}
        </button>}
        {activeView === "production" && !dashboardModel && showCompletedModels && <section id="completed-models-content" className="dashboard-completed-models" aria-label="Production units by model">
          {visibleCompletedByModel.length ? <div className="dashboard-completed-models-list">
            {visibleCompletedByModel.map((model, index) => {
              const units = Number(model.units || 0);
              const selected = completedModelSelection === model.model;
              return (
                <button
                  type="button"
                  key={model.model}
                  className={`dashboard-completed-model-row${selected ? " selected" : ""}`}
                  onClick={() => setCompletedModelSelection(selected ? "" : model.model)}
                  aria-pressed={selected}
                  title={`Show dashboard for ${model.model}`}
                >
                  <span className="dashboard-completed-model-name">
                    <span style={{ background: chartTheme.palette?.[index % chartTheme.palette.length] || chartTheme.accent }} />
                    {model.model}
                  </span>
                  <span className="dashboard-completed-model-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${units > 0 ? Math.max(2, (units / maxCompletedByModel) * 100) : 0}%`,
                        background: chartTheme.palette?.[index % chartTheme.palette.length] || chartTheme.accent,
                      }}
                    />
                  </span>
                  <strong>{unitsLabel(units)}</strong>
                </button>
              );
            })}
          </div> : <p className="dashboard-completed-models-empty">
            {dashboardModel ? `No production units recorded for ${dashboardModel}.` : "No production units recorded yet."}
          </p>}
          {completedModelSelection && <div className="dashboard-model-detail" aria-live="polite">
            <div className="dashboard-model-detail-heading">
              <div>
                <span>Model overview</span>
                <h3>{completedModelSelection}</h3>
              </div>
              <button type="button" onClick={() => setCompletedModelSelection("")}>Close overview</button>
            </div>
            {completedModelOverviewLoading ? <p className="dashboard-model-detail-status" role="status">Loading model overview...</p>
              : completedModelOverviewError ? <p className="dashboard-model-detail-status dashboard-model-detail-status--error" role="alert">{completedModelOverviewError}</p>
                : <div className="dashboard-model-detail-grid">
              {selectedModelStats.map((stat) => (
                <article className="dashboard-model-detail-card" key={stat.label}>
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                  <small>{stat.note}</small>
                </article>
              ))}
                </div>}
          </div>}
        </section>}
        {activeView === "sales" && <button
          type="button"
          className="dashboard-summary-more"
          onClick={() => setShowSalesModels((shown) => !shown)}
          aria-expanded={showSalesModels}
          aria-controls="sales-models-content"
        >
          {showSalesModels ? <>Show less <ChevronUp size={15} /></> : <>See more <ChevronDown size={15} /></>}
        </button>}
        {activeView === "sales" && showSalesModels && <section id="sales-models-content" className="dashboard-completed-models" aria-label="Sales overview by model">
          {salesOverviewByModel.length ? <div className="dashboard-sales-model-list">
            {salesOverviewByModel.map((model, index) => (
              <article className={`dashboard-sales-model-row${canViewSalesValue ? " has-sales-value" : ""}`} key={model.model}>
                <span className="dashboard-completed-model-name">
                  <span style={{ background: chartTheme.palette?.[index % chartTheme.palette.length] || chartTheme.accent }} />
                  {model.model}
                </span>
                <span><small>Total units</small><strong>{unitsLabel(model.units)}</strong></span>
                <span><small>Delivered</small><strong>{unitsLabel(model.deliveredUnits)}</strong></span>
                {canViewSalesValue && <span><small>Sales value</small><strong>{new Intl.NumberFormat("en-IN", {
                  style: "currency",
                  currency: "INR",
                  maximumFractionDigits: 0,
                }).format(Number(model.salesValue || 0))}</strong></span>}
              </article>
            ))}
          </div> : <p className="dashboard-completed-models-empty">
            {dashboardModel ? `No sales recorded for ${dashboardModel}.` : "No model sales recorded yet."}
          </p>}
        </section>}
      </section>

      {/* One model selected: its phases as cards (status, dates, units vs
          target, what is left). "All models" keeps the roadmap below. */}
      {activeView === "production" && dashboardModel && phasePlan.length > 0 && (
        <section className="phase-roadmap phase-plan" aria-labelledby="phase-plan-title">
          <div className="phase-roadmap-heading">
            <div>
              <p className="dashboard-eyebrow-label">Phase plan</p>
              <h2 id="phase-plan-title">Phases &amp; production targets · {dashboardModel}</h2>
            </div>
          </div>
          <div className="phase-plan-grid">
            {phasePlan.map((phase) => (
              <article key={phase.phaseId || phase.phase} className={`phase-plan-card phase-status-${phase.status}`}>
                <div className="phase-plan-card-head">
                  <strong>{phase.phase}</strong>
                  <span className={`phase-plan-pill phase-status-${phase.status}`}>
                    {phase.status === "completed" ? "Completed"
                      : phase.status === "upcoming" ? "Upcoming"
                        : phase.status === "behind" ? "Running · behind" : "Running · on track"}
                  </span>
                </div>
                <span className="phase-plan-dates">{phase.dates}</span>
                <div className="phase-plan-figures">
                  <span><b>{phase.units}</b> / {phase.target} units</span>
                  <strong>{Math.round(phase.progress)}%</strong>
                </div>
                <div className="phase-plan-progress" aria-label={`${Math.round(phase.progress)}% of target`}>
                  <span style={{ width: `${phase.progress}%` }} />
                </div>
                <span className="phase-plan-note">{phase.note}</span>
              </article>
            ))}
          </div>
        </section>
      )}

      {activeView === "production" && !dashboardModel && (phaseRoadmap.models.length > 0 || phaseRoadmap.unscheduled.length > 0) && (
        <section
          ref={(node) => { chartRefs.current.phaseRoadmap = node; }}
          data-chart-key="phaseRoadmap"
          className={`phase-roadmap${expandedChart === "phaseRoadmap" ? " chart-panel-expanded is-expanded" : ""}`}
          aria-labelledby="phase-roadmap-title"
        >
          <div className="phase-roadmap-heading">
            <div>
              <p className="dashboard-eyebrow-label">Phase roadmap</p>
              <h2 id="phase-roadmap-title">Production phases &amp; targets{phaseRoadmap.rangeLabel ? ` · ${phaseRoadmap.rangeLabel}` : ""}</h2>
            </div>
            <div className="phase-roadmap-actions">
              <div className="phase-roadmap-legend" aria-label="Phase status legend">
                <span className="phase-status-completed">Completed</span>
                <span className="phase-status-running">Running</span>
                <span className="phase-status-behind">Behind target</span>
                <span className="phase-status-upcoming">Upcoming</span>
              </div>
              <button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("phaseRoadmap")} aria-label={expandedChart === "phaseRoadmap" ? "Exit fullscreen" : "Expand phase roadmap"}>
                {expandedChart === "phaseRoadmap" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}
              </button>
            </div>
          </div>
          {phaseRoadmap.models.length > 0 && <div className="phase-roadmap-scroll" ref={roadmapScrollRef}>
            <div
              className="phase-roadmap-axis"
              style={{ gridTemplateColumns: `150px minmax(${phaseRoadmap.months.length * 110}px, 1fr)` }}
            >
              <strong>Model</strong>
              <div
                className="phase-roadmap-months"
                style={{ gridTemplateColumns: phaseRoadmap.months.map((month) => `${month.width}fr`).join(" ") }}
              >
                {phaseRoadmap.months.map((month, index) => (
                  <span key={`${month.label}-${index}`} className={month.current ? "is-current" : undefined}>{month.label}</span>
                ))}
              </div>
            </div>
            {phaseRoadmap.models.map((row) => (
              <div
                className="phase-roadmap-row"
                key={row.model}
                style={{ gridTemplateColumns: `150px minmax(${phaseRoadmap.months.length * 110}px, 1fr)` }}
              >
                <strong className="phase-roadmap-model"><i style={{ background: row.color }} aria-hidden="true" />{row.model}</strong>
                <div className="phase-roadmap-track" style={{ height: `${row.laneCount * ROADMAP_LANE_PX}px` }}>
                  {row.phases.map((phase) => (
                    <article
                      className={`phase-roadmap-block phase-status-${phase.status}`}
                      key={phase.phaseId}
                      style={{ left: `calc(${phase.left}% + 3px)`, width: `calc(${phase.width}% - 6px)`, top: `${phase.lane * ROADMAP_LANE_PX}px` }}
                      title={`${row.model} ${phase.phase}: ${phase.units}${phase.target ? ` of ${phase.target}` : ""} units · ${phase.startDate} to ${phase.endDate || "no end date"}`}
                    >
                      <div className="phase-roadmap-block-heading">
                        <strong>{phase.phase}</strong>
                        <span>
                          {phase.status === "upcoming"
                            ? (phase.target ? `Target ${phase.target}` : "Upcoming")
                            : phase.target ? `${phase.units} / ${phase.target}` : `${phase.units} built`}
                        </span>
                      </div>
                      {phase.target > 0 && (
                        <div className="phase-roadmap-progress" aria-label={`${phase.progress.toFixed(0)}% complete`}>
                          <span style={{ width: `${phase.progress}%` }} />
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>}
          {phaseRoadmap.unscheduled.length > 0 && (
            <div className="phase-roadmap-unscheduled">
              <strong>Not on the timeline · {phaseRoadmap.unscheduled.length} phase{phaseRoadmap.unscheduled.length === 1 ? "" : "s"} without a start date</strong>
              <div className="phase-roadmap-unscheduled-list">
                {phaseRoadmap.unscheduled.map((phase) => (
                  <span key={phase.key} title={`Add the ${phase.missing} in Models → Phases to place it on the timeline`}>
                    <b>{phase.model}</b> · {phase.phase}
                    <em>{phase.target ? `${phase.units} / ${phase.target}` : `${phase.units} built`} · no {phase.missing}</em>
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="phase-roadmap-note">Each block is one phase with its own target. Highlighted month = today. A phase is “behind” when units built are under 90% of where they should be by now.</p>
        </section>
      )}

      {/* <div className="dashboard-toolbar">
        <p className="dashboard-subtitle">{loadError ? "Live dashboard data is temporarily unavailable." : dashboard ? activeView === "production" ? "Live production, quality, and packing information." : activeView === "customerSales" ? "Live customer sales and dispatch information." : "Live Vector sales and dispatch information." : "Loading dashboard data..."}</p>
        {activeView !== "production" && canViewSalesValue && <div className="dashboard-value-chip"><ArrowUpRight size={15} /> {formattedSalesValue} sales value</div>}
      </div> */}

      {activeView === "production" && (<section className={`section${isRegularUser ? " user-production-dashboard" : ""}`} aria-labelledby="production-analytics-title">
        <div className="production-analytics-header"><div><p className="dashboard-eyebrow-label">Live reporting</p><h2 id="production-analytics-title" className="dashboard-section-title">Production analytics</h2></div><div className="dashboard-filter-bar">{productionFilterControls}</div></div>
        <div className={`chart-grid production-monthly-chart-grid${isProductionIncharge ? " production-incharge-chart-grid" : ""}`}>
          <div ref={(node) => { chartRefs.current.monthlyAssembled = node; }} data-chart-key="monthlyAssembled" className={`panel chart-panel${expandedChart === "monthlyAssembled" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Assembly output</span><h3 className="panel-title">{drillMonths.monthlyAssembled ? dayTitleByModel("monthlyAssembled", "Daily units assembled") : showByModel("monthlyAssembled") ? "Monthly units assembled by model" : "Monthly units assembled"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyAssembled")}<Factory size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyAssembled")} aria-label={expandedChart === "monthlyAssembled" ? "Exit fullscreen" : "Expand assembly chart"}>{expandedChart === "monthlyAssembled" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyAssembled ? renderProductionDayChart("monthlyAssembled") : hasAssemblyData ? showByModel("monthlyAssembled") ? renderModelStackChart("monthlyAssembled") : <ResponsiveContainer width="100%" height={expandedChart === "monthlyAssembled" ? 650 : 280}>{assemblyDataPoints.length < 3 ? <BarChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyAssembled", assemblyDataPoints)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Bar dataKey="units" name="Assembled units" fill={chartTheme.accent} radius={[7, 7, 0, 0]} onClick={drillBar("monthlyAssembled")} /></BarChart> : <LineChart data={assemblyDataPoints} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyAssembled", assemblyDataPoints)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value) => [value, "Assembled units"]} /><Line type="monotone" dataKey="units" name="Assembled units" stroke={chartTheme.accent} strokeWidth={3} dot={{ r: 3, fill: chartTheme.accentHover }} activeDot={{ r: 6 }} /></LineChart>}</ResponsiveContainer> : chartEmptyState("assembly output")}</div>
          <div ref={(node) => { chartRefs.current.monthlyQc = node; }} data-chart-key="monthlyQc" className={`panel chart-panel${expandedChart === "monthlyQc" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Quality control</span><h3 className="panel-title">{drillMonths.monthlyQc ? dayTitleByModel("monthlyQc", "Daily QC status") : showByModel("monthlyQc") ? "Monthly QC status by model" : "Monthly QC status"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyQc")}<ShieldCheck size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyQc")} aria-label={expandedChart === "monthlyQc" ? "Exit fullscreen" : "Expand quality control chart"}>{expandedChart === "monthlyQc" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyQc ? renderProductionDayChart("monthlyQc") : hasQcData ? showByModel("monthlyQc") ? renderModelStackChart("monthlyQc") : <ResponsiveContainer width="100%" height={expandedChart === "monthlyQc" ? 650 : 280}><BarChart data={productionMonthCharts.qc} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyQc", productionMonthCharts.qc)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} itemSorter={(item) => ["Passed", "Failed", "Under Inspection", "Pending"].indexOf(item.dataKey)} /><Bar dataKey="Passed" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.success} /><Bar dataKey="Failed" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.danger} /><Bar dataKey="Under Inspection" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.accent} /><Bar dataKey="Pending" stackId="qc" onClick={drillBar("monthlyQc")} fill={chartTheme.muted} /></BarChart></ResponsiveContainer> : chartEmptyState("quality control")}</div>
          <div ref={(node) => { chartRefs.current.monthlyPackaging = node; }} data-chart-key="monthlyPackaging" className={`panel chart-panel${expandedChart === "monthlyPackaging" ? " chart-panel-expanded" : ""}`}><div className="chart-heading"><div><span>Packaging</span><h3 className="panel-title">{drillMonths.monthlyPackaging ? dayTitleByModel("monthlyPackaging", "Daily packaging status") : showByModel("monthlyPackaging") ? "Monthly packaging status by model" : "Monthly packaging status"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("monthlyPackaging")}<Boxes size={18} /><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("monthlyPackaging")} aria-label={expandedChart === "monthlyPackaging" ? "Exit fullscreen" : "Expand packaging chart"}>{expandedChart === "monthlyPackaging" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>{drillMonths.monthlyPackaging ? renderProductionDayChart("monthlyPackaging") : hasPackagingData ? showByModel("monthlyPackaging") ? renderModelStackChart("monthlyPackaging") : <ResponsiveContainer width="100%" height={expandedChart === "monthlyPackaging" ? 650 : 280}><BarChart data={productionMonthCharts.packaged} margin={{ top: 16, right: 16, left: 8, bottom: 20 }} onClick={drillFromChart("monthlyPackaging", productionMonthCharts.packaged)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" label={{ value: "Month", position: "insideBottom", offset: -12, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} allowDecimals={false} tick={{ fontSize: 11, fill: chartTheme.axis }} /><Tooltip contentStyle={chartTheme.tooltip} itemSorter={(item) => ["Packed", "Pending", "In Progress"].indexOf(item.dataKey)} /><Bar dataKey="Packed" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.success} /><Bar dataKey="Pending" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.muted} /><Bar dataKey="In Progress" stackId="pack" onClick={drillBar("monthlyPackaging")} fill={chartTheme.warning} /></BarChart></ResponsiveContainer> : chartEmptyState("packaging")}</div>
          {isProductionIncharge && renderDefectiveItemsChart("quality")}
        </div>
        {!dashboardModel && (
          <div className="chart-grid floor-insight-grid">
            <div className="panel chart-panel floor-insight-panel">
              <div className="chart-heading"><div><span>Quality control</span><h3 className="panel-title">First-pass yield by model</h3></div></div>
              {yieldByModel.length ? (
                <>
                  <div className="yield-list">
                    {yieldByModel.map((row) => (
                      <div className={`yield-row${row.rate < 90 ? " is-low" : ""}`} key={row.model}>
                        <div className="yield-row-head"><strong>{row.model}</strong><b>{row.rate.toFixed(1)}%</b></div>
                        <div className="yield-track" aria-label={`${row.rate.toFixed(1)}% first-pass yield`}>
                          <span style={{ width: `${row.rate}%` }} />
                          <i aria-hidden="true" />
                        </div>
                        <small>{row.passed} passed · {row.failed} failed</small>
                      </div>
                    ))}
                  </div>
                  <p className="floor-insight-note">White line = 90% yield target. Models with no QC yet are hidden.</p>
                </>
              ) : chartEmptyState("QC results")}
            </div>
            <div className="panel chart-panel floor-insight-panel">
              <div className="chart-heading"><div><span>Needs attention</span><h3 className="panel-title">Floor alerts across models</h3></div></div>
              {floorAlerts.length ? (
                <div className="floor-alert-list">
                  {floorAlerts.map((alert, index) => (
                    <div className="floor-alert" key={`${alert.tag}-${alert.title}-${index}`}>
                      <span className={`floor-alert-tag tone-${alert.tone}`}>{alert.tag}</span>
                      <div><strong>{alert.title}</strong><small>{alert.note}</small></div>
                    </div>
                  ))}
                </div>
              ) : <p className="floor-insight-empty">No floor alerts right now — every running phase is on track.</p>}
            </div>
          </div>
        )}
        <div className={`chart-grid ${activeView !== "production" ? "sales-chart-grid" : "production-chart-grid"}`}>
          {!isRegularUser && !isProductionIncharge && <div ref={(node) => { chartRefs.current.workload = node; }} data-chart-key="workload" className={`panel chart-panel${expandedChart === "workload" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>{activeView === "production" ? "User activity" : "Distribution"}</span><h3 className="panel-title">{activeView === "production" ? `${userActivity === "assembled" ? "Assembled" : userActivity === "packaged" ? "Packaged" : "QC tested"} by user` : "Units dispatched by location"}</h3></div><div className="chart-heading-actions">{activeView === "production" ? <><div className="dashboard-range-switch chart-range-switch"><button type="button" className={userActivity === "assembled" ? "active" : ""} onClick={() => setUserActivity("assembled")}>Assembled</button><button type="button" className={userActivity === "qc" ? "active" : ""} onClick={() => setUserActivity("qc")}>QC</button><button type="button" className={userActivity === "packaged" ? "active" : ""} onClick={() => setUserActivity("packaged")}>Packaged</button></div><div className="dashboard-range-switch chart-range-switch"><button type="button" className={qcRange === "daily" ? "active" : ""} onClick={() => setQcRange("daily")}>Daily</button><button type="button" className={qcRange === "weekly" ? "active" : ""} onClick={() => setQcRange("weekly")}>Weekly</button></div><Factory size={18} /></> : <MapPin size={18} />}<button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("workload")} aria-label={expandedChart === "workload" ? "Exit fullscreen" : "Expand chart"}>{expandedChart === "workload" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {activeView === "production" && <div className="chart-filter-row">{!isRegularUser && <DashboardFilterSelect label="User" value={qcUserFilter} onChange={selectActivityUser} options={[{ value: "all", label: "All users" }, ...qcUsers.map((user) => ({ value: user, label: user }))]} />}<div className="chart-date-filter"><label>From <DatePicker value={qcFromDate} onChange={setQcFromDate} ariaLabel="Select filter start date" popoverZIndex={100000} /></label><label>To <DatePicker value={qcToDate} onChange={setQcToDate} ariaLabel="Select filter end date" popoverZIndex={100000} /></label></div><button type="button" className="chart-clear-filter" onClick={() => { setQcRange("daily"); selectActivityUser("all"); setQcFromDate(""); setQcToDate(""); }}>Clear filters</button></div>}
            {activeView === "production" && activityDrillUser ? <>
              <div className="chart-drill-bar">
                <button type="button" className="chart-drill-back" onClick={() => (activityDrillMonth ? setActivityDrillMonth("") : selectActivityUser("all"))}>
                  <ChevronLeft size={14} /> {activityDrillMonth ? "All months" : "All users"}
                </button>
                <span className="chart-drill-title">
                  <span className="chart-user-dot" style={{ background: userColor(activityDrillUser) }} aria-hidden="true" />
                  {activityDrillUser} · {activityDrillMonth
                    ? `${formatDrillMonth(activityDrillMonth)} · ${qcRange === "daily" ? "day wise" : "week wise"}`
                    : "month wise"}
                </span>
              </div>
              {activityDrillRows.some((row) => row.units > 0) ? <div className="chart-scroll">
                <div
                  className="chart-scroll-inner"
                  style={{
                    width: activityDrillMonth && qcRange !== "daily" && activityDrillRows.length > 6
                        ? `${activityDrillRows.length * 110}px`
                        : "100%",
                  }}
                >
                  <ResponsiveContainer width="100%" height={expandedChart === "workload" ? 610 : 250}>
                    <BarChart
                      data={activityDrillRows}
                      margin={{ top: 12, right: 12, left: 4, bottom: 20 }}
                      className={activityDrillMonth ? undefined : "chart-drillable"}
                    >
                      <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                      <XAxis
                        dataKey="label"
                        interval={activityDrillMonth && qcRange === "daily" && expandedChart !== "workload" ? "preserveStartEnd" : 0}
                        label={{
                          value: !activityDrillMonth ? "Month" : qcRange === "daily" ? "Day" : "Week",
                          position: "insideBottom",
                          offset: -12,
                          fill: chartTheme.axis,
                          fontSize: 11,
                        }}
                        tick={{ fontSize: 10, fill: chartTheme.axis }}
                      />
                      <YAxis
                        label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }}
                        allowDecimals={false}
                        tick={{ fontSize: 11, fill: chartTheme.axis }}
                      />
                      <Tooltip
                        contentStyle={chartTheme.tooltip}
                        cursor={{ fill: chartTheme.cursor }}
                        labelFormatter={(label, payload) => payload?.[0]?.payload?.fullLabel || label}
                        formatter={(value) => [value, ACTIVITY_UNIT_LABELS[userActivity]]}
                      />
                      <Bar
                        dataKey="units"
                        name={ACTIVITY_UNIT_LABELS[userActivity]}
                        fill={userColor(activityDrillUser)}
                        maxBarSize={activityDrillMonth ? 28 : 48}
                        radius={[6, 6, 0, 0]}
                        onClick={activityDrillMonth ? undefined : (entry) => setActivityDrillMonth(entry?.key ?? entry?.payload?.key ?? "")}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div> : <div className="chart-empty-state" role="status"><span>No {ACTIVITY_UNIT_LABELS[userActivity].toLowerCase()} for {activityDrillUser} in this range.</span></div>}
              {!activityDrillMonth && activityDrillRows.length > 0 && <p className="chart-drill-hint">Click a month to see its {qcRange === "daily" ? "day-wise" : "week-wise"} activity.</p>}
            </> :
            activeView === "production" ? <div className="chart-scroll chart-scroll--user-activity">
              <HorizontalActivityBars
                data={qcUserData}
                labelKey="user"
                unitsLabel={ACTIVITY_UNIT_LABELS[userActivity]}
                colorForRow={(row) => userColor(row.user)}
                modelKeys={userActivity === "qc" ? qcActivityModelKeys : []}
                colorForModel={modelColor}
                onBarClick={(row) => selectActivityUser(row.user)}
              />
            </div> : <div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: locationSales.length > 8 ? `${locationSales.length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "workload" ? 650 : 280}>
              <BarChart data={locationSales} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                <XAxis dataKey="location" tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} />
                <YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} />
                <Tooltip
                  contentStyle={chartTheme.tooltip}
                  cursor={{ fill: chartTheme.cursor }}
                  content={cellColoredTooltip((row) => getContrastBarColor(Math.max(0, locationSales.findIndex((item) => item.location === row.location)), chartTheme))}
                />
                <Bar dataKey="units" radius={[7, 7, 0, 0]}>
                  {locationSales.map((entry, index) => (
                    <Cell
                      key={`${entry.location}-${index}`}
                      fill={getContrastBarColor(index, chartTheme)}
                      fillOpacity={getBarColorOpacity(index)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></div></div>}
            {activeView === "production" && !activityDrillUser && userActivity === "qc" && <ModelLegend models={qcActivityModelKeys} colorForModel={modelColor} />}
            {activeView === "production" && !activityDrillUser && qcUserData.length > 0 && <p className="chart-drill-hint">Click a user&apos;s bar to see their month-wise activity.</p>}
          </div>}

          {!isProductionIncharge && renderDefectiveItemsChart("quality")}

          </div>
      </section>)}
      {(activeView === "sales" || activeView === "customerSales") && <section className="section sales-analytics-section">
        
        <div className="chart-grid sales-chart-grid">
          {activeView !== "sales" && <div ref={(node) => { chartRefs.current.salesClient = node; }} data-chart-key="salesClient" className={`panel chart-panel${expandedChart === "salesClient" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>End User distribution</span><h3 className="panel-title">Units dispatched by end user client</h3></div><div className="chart-heading-actions"><DashboardFilterSelect label="Year" value={clientYear} onChange={setClientYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><DashboardFilterSelect label="Month" value={clientMonth} onChange={setClientMonth} options={[{ value: "all", label: "All months" }, ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((month, index) => ({ value: String(index + 1).padStart(2, "0"), label: month }))]} /><button type="button" className="chart-clear-filter" onClick={() => { setClientYear("all"); setClientMonth("all"); }}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesClient")} aria-label={expandedChart === "salesClient" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesClient" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {hasUsefulClientSalesData ? <><div className="chart-scroll"><div className="chart-scroll-inner" style={{ width: clientSales.length > 8 ? `${clientSales.length * 92}px` : "100%" }}><ResponsiveContainer width="100%" height={expandedChart === "salesClient" ? 650 : 280}><BarChart data={clientSales} margin={{ top: clientSalesModels.length ? 28 : 8, right: 8, left: 6, bottom: 28 }}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="client" label={{ value: "End Customer Name", position: "insideBottom", offset: -18, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis label={{ value: "Units", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value, name) => [value, name]} cursor={{ fill: chartTheme.cursor }} content={cellColoredTooltip((row) => getContrastBarColor(Math.max(0, clientSales.findIndex((item) => item.client === row.client)), chartTheme))} />{clientSalesModels.length ? <><Legend verticalAlign="top" align="right" height={28} />{clientSalesModels.map((model) => <Bar key={model} dataKey={model} name={model} stackId="client" fill={chartTheme.palette[salesModels.indexOf(model) % chartTheme.palette.length]} />)}</> : <Bar dataKey="units" name="Units dispatched" radius={[7, 7, 0, 0]}>{clientSales.map((entry, index) => <Cell key={`${entry.client}-${index}`} fill={getContrastBarColor(index, chartTheme)} fillOpacity={getBarColorOpacity(index)} />)}</Bar>}</BarChart></ResponsiveContainer></div></div></> : <div className="dashboard-empty-chart dashboard-low-data"><span aria-hidden="true">▥</span><strong>{clientSales.length ? "Not enough activity yet this period" : "No dispatch activity yet"}</strong><p>{clientSales.length ? "Record at least four dispatched units to reveal a meaningful client comparison." : "Client dispatches will appear here once sales are recorded."}</p></div>}
          </div>}
          <div ref={(node) => { chartRefs.current.salesDispatchTrend = node; }} data-chart-key="salesDispatchTrend" className={`panel chart-panel${expandedChart === "salesDispatchTrend" ? " chart-panel-expanded" : ""}`}>
            <div className="chart-heading"><div><span>Dispatch trend</span><h3 className="panel-title">{drillMonths.salesDispatchTrend ? "Daily dispatched units" : "Monthly dispatched units"}</h3></div><div className="chart-heading-actions">{renderDrillMonthPicker("salesDispatchTrend")}<DashboardFilterSelect label="Year" value={dispatchYear} onChange={setDispatchYear} options={[{ value: "all", label: "All years" }, ...locationYears.map((year) => ({ value: year, label: year }))]} /><button type="button" className="chart-clear-filter" onClick={() => setDispatchYear("all")}>Clear filters</button><button type="button" className="chart-expand-btn" onClick={() => toggleChartFullscreen("salesDispatchTrend")} aria-label={expandedChart === "salesDispatchTrend" ? "Exit fullscreen" : "Expand to see full details"} title="Expand to see full details">{expandedChart === "salesDispatchTrend" ? <><Minimize2 size={16} /> <span>Exit Fullscreen</span></> : <Expand size={16} />}</button></div></div>
            {drillMonths.salesDispatchTrend ? renderSalesDayChart("salesDispatchTrend") : <ResponsiveContainer width="100%" height={expandedChart === "salesDispatchTrend" ? 650 : 280}><BarChart data={monthlyDispatchedTrend} margin={{ top: 28, right: 18, left: 0, bottom: 8 }} onClick={drillFromChart("salesDispatchTrend", monthlyDispatchedTrend)} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11, fill: chartTheme.axis }} /><YAxis tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Legend verticalAlign="top" align="right" height={28} />{dispatchedModels.map((model) => <Bar key={model} dataKey={model} name={model} stackId="dispatch" fill={chartTheme.palette[salesModels.indexOf(model) % chartTheme.palette.length]} onClick={drillBar("salesDispatchTrend")} />)}</BarChart></ResponsiveContainer>}
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
            {locationSales.length === 0 ? <div className="dashboard-empty-chart dashboard-low-data"><span aria-hidden="true">▥</span><strong>No end customer details yet</strong><p>{deliveryGroupBy === "location" ? "Add an End Customer Location on a dispatched sale to see it here." : "Add an End Customer Name on a dispatched sale to see it here."}</p></div> : <ResponsiveContainer width="100%" height={expandedChart === "locationSales" ? 650 : 280}><BarChart data={locationSales} margin={{ top: deliveryModels.length ? 28 : 8, right: 8, left: 6, bottom: 28 }} className="chart-drillable"><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="group" label={{ value: deliveryGroupBy === "location" ? "End Customer Location" : "End Customer Name", position: "insideBottom", offset: -18, fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} interval={0} /><YAxis label={{ value: "Quantity", angle: -90, position: "insideLeft", fill: chartTheme.axis, fontSize: 11 }} tick={{ fontSize: 11, fill: chartTheme.axis }} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} formatter={(value, name) => [value, name]} cursor={{ fill: chartTheme.cursor }} content={cellColoredTooltip((row) => deliveryColor(row.group))} />{deliveryModels.length ? <><Legend verticalAlign="top" align="right" height={28} />{deliveryModels.map((model) => <Bar key={model} dataKey={model} name={model} stackId="delivery" maxBarSize={72} fill={chartTheme.palette[salesModels.indexOf(model) % chartTheme.palette.length]} onClick={(entry) => setDeliveryDrill({ name: entry?.group ?? entry?.payload?.group ?? "", month: "" })} />)}</> : <Bar dataKey="units" name="Quantity" maxBarSize={72} radius={[7, 7, 0, 0]} onClick={(entry) => setDeliveryDrill({ name: entry?.group ?? entry?.payload?.group ?? "", month: "" })}>{locationSales.map((entry, index) => <Cell key={`${entry.group}-${index}`} fill={deliveryColor(entry.group)} />)}</Bar>}</BarChart></ResponsiveContainer>}
            {!deliveryDrill.name && locationSales.length > 0 && <p className="chart-drill-hint">Click a {deliveryGroupBy === "location" ? "location" : "customer"}&apos;s bar to see their month-wise deliveries.</p>}
            </>}
</div>
        </div>
      </section>}
    </div>
  );
}
