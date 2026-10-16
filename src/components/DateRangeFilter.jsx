import DatePicker from "./DatePicker";

/**
 * From/to toolbar filter for a single date column.
 *
 * The pickers hold a draft; the request is only rebuilt when Apply is pressed,
 * so a half-typed date never refetches the table. `fromDate`/`toDate` are the
 * draft values owned by the page, and `onApply` is called with them.
 *
 * An inverted range is refused here rather than being sent to the API, where it
 * would quietly return an empty table and look like missing data.
 */
export default function DateRangeFilter({
  fromDate,
  toDate,
  onChangeFrom,
  onChangeTo,
  onApply,
  onClear,
  error = "",
  column,
  columns = null,
  onChangeColumn,
  startLabel = "From Date",
  endLabel = "To Date",
  applyLabel = "Apply",
  clearLabel = "Clear",
}) {
  const hasDraft = Boolean(fromDate || toDate);
  const inverted = Boolean(fromDate && toDate && toDate < fromDate);

  return (
    <div className="date-range-filter">
      {columns && (
        <select
          className="date-range-column"
          value={column || ""}
          onChange={(event) => onChangeColumn?.(event.target.value)}
          aria-label="Select date column to filter"
        >
          {columns.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <DatePicker
        value={fromDate}
        onChange={onChangeFrom}
        placeholder={startLabel}
        ariaLabel={`Select ${startLabel.toLowerCase()}`}
      />
      <DatePicker
        value={toDate}
        onChange={onChangeTo}
        placeholder={endLabel}
        ariaLabel={`Select ${endLabel.toLowerCase()}`}
      />
      <button
        type="button"
        className="date-range-apply"
        onClick={() => onApply(fromDate, toDate)}
        disabled={!hasDraft || inverted}
        aria-label={`Apply ${startLabel.toLowerCase()} filter`}
        title={inverted ? error : undefined}
      >
        {applyLabel}
      </button>
      {(hasDraft || error) && (
        <button
          type="button"
          className="date-range-clear"
          onClick={onClear}
          aria-label={`Clear ${startLabel.toLowerCase()} filter`}
        >
          {clearLabel}
        </button>
      )}
      {error && <span className="date-range-error">{error}</span>}
    </div>
  );
}