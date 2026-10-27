import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Handles the deep link a dashboard KPI card creates:
 * `/production?from=dashboard&field=qc&value=Failed`.
 *
 * Three things it has to get right:
 *
 * 1. The filter is applied **once per mount**, not on every render. Re-reading
 *    the params each time would fight the user: pressing Reset clears the
 *    selection, but the URL still carried the old value, so the next render
 *    would silently put the filter back.
 * 2. `field` and `value` are then **stripped from the URL**, so Reset (and a
 *    later reload) do not resurrect a filter the user has already cleared.
 *    `from=dashboard` is left behind on purpose - it is what renders the
 *    "back to Dashboard" control.
 * 3. `field` is validated against the page's own filter fields, so a
 *    hand-written URL cannot push a filter the PageFilter dropdown never
 *    offered.
 *
 * @param {Array<{key: string}>} fields  The page's filterable fields.
 * @param {(patch: object) => void} applyFilters  Receives `{ [key]: value }`.
 * @param {(view: string) => void} [applyView]  Optional, for pages with tabs.
 * @param {string[]} [views]  Valid values for the optional `view` param.
 * @returns {boolean} whether the page was opened from the dashboard.
 */
export default function useDashboardDeepLink(fields, applyFilters, applyView, views) {
  const [searchParams, setSearchParams] = useSearchParams();
  // A ref, not state: the guard must survive re-renders without itself causing
  // a render.
  const appliedRef = useRef(false);
  // Track whether the page was opened from dashboard for the back link.
  const [fromDashboard, setFromDashboard] = useState(false);

  useEffect(() => {
    if (appliedRef.current) return;
    // A card may narrow by more than one field (e.g. In Stock + Packed), sent
    // as repeated `field`/`value` pairs in the same order.
    const fieldList = searchParams.getAll("field");
    const valueList = searchParams.getAll("value");
    const field = fieldList[0];
    const view = searchParams.get("view");
    const from = searchParams.get("from");

    const patch = {};
    fieldList.forEach((name, index) => {
      const value = valueList[index];
      if (name && value && fields.some((option) => option.key === name)) patch[name] = value;
    });
    if (Object.keys(patch).length) applyFilters(patch);

    if (view && views?.includes(view)) applyView?.(view);

    if (!field && !view && !from) return;

    appliedRef.current = true;
    if (from === "dashboard") setFromDashboard(true);

    // Keep only what the page still needs to render (the back link), and drop
    // the consumed filter/view params so they cannot be applied twice.
    const next = new URLSearchParams();
    if (from) next.set("from", from);
    setSearchParams(next, { replace: true });
    // `fields` is a module-level constant on every caller, so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return fromDashboard;
}