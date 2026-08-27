import React, { useEffect, useState } from "react";
import {
  Boxes,
  CircleDot,
  Factory,
  IndianRupee,
  Package,
  PackageCheck,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  TriangleAlert,
} from "lucide-react";
import { fmtINR } from "../data/mockData";
import "./KpiCard.css";

const KPI_ICONS = {
  inProduction: Factory,
  semiFinished: CircleDot,
  qcInspection: ShieldCheck,
  qcFailed: ShieldAlert,
  qcPassed: PackageCheck,
  packed: Package,
  sold: ShoppingCart,
  salesValue: IndianRupee,
  defects: TriangleAlert,
  reorder: Boxes,
};

function useCountUp(value, duration = 700) {
  const target = Number(value) || 0;
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDisplayValue(target);
      return undefined;
    }

    let frameId;
    let startedAt;
    const tick = (timestamp) => {
      startedAt ??= timestamp;
      const progress = Math.min((timestamp - startedAt) / duration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(target * easedProgress));
      if (progress < 1) frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [duration, target]);

  return displayValue;
}

export default function KpiCard({ kpi }) {
  const Icon = KPI_ICONS[kpi.key] || Boxes;
  const animatedValue = useCountUp(kpi.value);
  const value = Number(kpi.value) || 0;
  // Issue 2: assign each live metric a meaning-based semantic tone.
  const isNegativeMetric = kpi.key === "qcFailed" || kpi.key === "defects";
  const isPositiveMetric = kpi.key === "qcPassed" || kpi.key === "packed";
  const tone = isNegativeMetric && value > 0 ? "danger" : isNegativeMetric || isPositiveMetric ? "success" : "neutral";
  // Issue 4: zero-value failure metrics explicitly communicate an all-clear state.
  const context = isNegativeMetric
    ? value === 0 ? "No issues requiring attention" : "Requires immediate review"
    : kpi.key === "qcPassed" ? "Cleared quality inspection"
    : kpi.key === "semiFinished" ? "Moving through production"
    : kpi.key === "qcInspection" ? "Awaiting quality decision"
    : "Live operational total";

  return (
    <article className={`kpi-card kpi-card--${tone}${isNegativeMetric && value > 0 ? " kpi-card--attention" : ""}`} aria-label={`${kpi.label}: ${kpi.value}`}>
      <span className="kpi-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="kpi-value">
        {kpi.currency ? fmtINR(animatedValue) : animatedValue.toLocaleString("en-IN")}
      </span>
      <span className="kpi-label">{kpi.label}</span>
      <span className="kpi-context">{context}</span>
    </article>
  );
}
