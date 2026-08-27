// Keep date-only values stable: parsing YYYY-MM-DD with Date can shift the
// displayed day in timezones west of UTC.
export function formatDate(value, fallback = "—") {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return String(parsed.getDate()).padStart(2, "0") + "-" +
    String(parsed.getMonth() + 1).padStart(2, "0") + "-" + parsed.getFullYear();
}
