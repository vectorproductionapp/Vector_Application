// Shared column sorting for DataTable and the export buttons, so a downloaded
// file always comes out in the order the user is looking at on screen.

export const isBlankValue = (value) =>
  value === null ||
  value === undefined ||
  (typeof value !== "object" && String(value).trim() === "");

// A column is sortable unless it opts out. The select-mode checkbox column
// passes `sortable: false` - there is no value behind it to sort by.
export const isSortableColumn = (column) => column?.sortable !== false && Boolean(column?.key);

// Clicking a header walks ascending -> descending -> normal.  Normal hands the
// rows back in the order they arrived, and switching to a different column
// starts the cycle over at ascending.
export function nextSort(sort, key) {
  const current = sort || {};
  if (current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  if (current.direction === "desc") return { key: null, direction: null };
  return { key, direction: "asc" };
}

// Date-only values are stored as YYYY-MM-DD.  Everything is reduced to the same
// YYYYMMDD scale so a stored date and a parsed timestamp always compare
// against each other correctly.
function toSortableTime(value) {
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getFullYear() * 10000 + (parsed.getMonth() + 1) * 100 + parsed.getDate();
}

// Sort on the raw row value, never on what a column's `render` returns - a
// rendered dropdown or badge is not comparable.
function compareValues(a, b, column) {
  if (column?.isDate) {
    const aTime = toSortableTime(a);
    const bTime = toSortableTime(b);
    if (aTime !== null && bTime !== null) return aTime - bTime;
  }
  const aNumber = Number(a);
  const bNumber = Number(b);
  // Quantities sort by value, so 9 lands before 10 rather than after it.
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  // `numeric: true` keeps embedded numbers in natural order ("Phase 4" < "Phase 10").
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Order `rows` the way the given header sort asks for.
 *
 * A null/cleared sort returns the rows untouched, so "normal" is always the
 * order they arrived in.  The input array is never mutated.
 */
export function sortRows(rows, columns, sort) {
  if (!sort?.key || !sort.direction) return rows || [];
  const column = (columns || []).find((c) => c.key === sort.key);
  const factor = sort.direction === "asc" ? 1 : -1;
  // Copy first: sorting must never reorder the caller's own array.
  return [...(rows || [])].sort((a, b) => {
    const aValue = a[sort.key];
    const bValue = b[sort.key];
    // Blank cells keep to the bottom either way, so the "-" placeholders do
    // not jump to the top of the table on a descending sort.
    if (isBlankValue(aValue) || isBlankValue(bValue)) {
      if (isBlankValue(aValue) && isBlankValue(bValue)) return 0;
      return isBlankValue(aValue) ? 1 : -1;
    }
    return factor * compareValues(aValue, bValue, column);
  });
}
