import React, { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import DataTable from "./DataTable";
import ListPagination from "./ListPagination";
import "./GlobalSearchResults.css";

/**
 * "Matching records" under a page's top-level cards.
 *
 * The cards only know their own names (phase, invoice / PO number), so typing
 * an item code, description or supplier used to find nothing until the right
 * card was opened. This panel searches every record of the page (`load`) and
 * lists the matches; "View" on a row opens the card it belongs to (`onOpen`).
 *
 * `load(query)` resolves to { rows, total }.
 */
export default function GlobalSearchResults({ query, load, columns, onOpen, noun = "records" }) {
  const search = String(query || "").trim();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const requestRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setPage(1);
    if (!search) {
      setRows([]);
      setTotal(0);
      setError("");
      return undefined;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    // `query` already arrives once typing has paused (useHeaderSearch), so no
    // second wait is added here.
    const timer = setTimeout(async () => {
      try {
        const result = await loadRef.current(search);
        if (requestId !== requestRef.current) return;
        setRows(result.rows || []);
        setTotal(result.total ?? (result.rows || []).length);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setRows([]);
        setTotal(0);
        setError(err?.response?.data?.message || err?.message || "Search failed.");
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [search]);

  if (!search) return null;

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <section className="panel global-search-panel" aria-live="polite">
      <div className="global-search-head">
        <span className="global-search-icon"><Search size={16} /></span>
        <div>
          <h3>Matching {noun}</h3>
          <p>
            {loading
              ? `Searching every ${noun.replace(/s$/, "")} for “${search}”…`
              : error
                ? error
                : total
                  ? `${total} ${total === 1 ? `${noun.replace(/s$/, "")} contains` : `${noun} contain`} “${search}”${total > rows.length ? ` · showing the first ${rows.length}` : ""}. Click View to open one.`
                  : `No ${noun} contain “${search}”.`}
          </p>
        </div>
        {loading && <Loader2 size={18} className="spin global-search-spinner" />}
      </div>
      {!loading && !error && rows.length > 0 && (
        <>
          <DataTable columns={columns} rows={pageRows} onViewDetails={onOpen} />
          <ListPagination
            page={safePage}
            pageSize={pageSize}
            totalPages={totalPages}
            totalCount={rows.length}
            rowCount={pageRows.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            itemLabel={noun}
          />
        </>
      )}
    </section>
  );
}
