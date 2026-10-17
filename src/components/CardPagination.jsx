import React, { useEffect, useMemo, useRef, useState } from "react";
import ListPagination from "./ListPagination";

// Card grids are 4 / 3 / 2 / 1 columns wide depending on the screen, so page
// sizes are multiples of 12 to keep every full page's rows complete.
export const CARD_PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/**
 * Pages an already-loaded list of cards in the browser.
 *
 * `resetKey` is anything that changes what the list means (a search, a filter,
 * the phase being viewed). When it changes the grid returns to page 1, so a
 * narrower list never strands the user on a page that no longer exists.
 */
export function useCardPagination(items, resetKey) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CARD_PAGE_SIZE_OPTIONS[0]);
  const list = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

  useEffect(() => { setPage(1); }, [resetKey]);
  // Deleting the last cards of the final page moves back to the new last page.
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const pageItems = useMemo(
    () => list.slice((page - 1) * pageSize, page * pageSize),
    [list, page, pageSize]
  );

  return {
    pageItems,
    pagerProps: {
      page: Math.min(page, totalPages),
      pageSize,
      totalPages,
      totalCount: list.length,
      rowCount: pageItems.length,
      onPageChange: setPage,
      onPageSizeChange: (next) => { setPageSize(next); setPage(1); },
    },
  };
}

// Footer for a card grid. Hidden when there are no cards to page. It sticks to
// the bottom of the screen, so with a long page of cards the pager stays in
// reach while the cards scroll behind it.
//
// The bar sits at `bottom: -1px`: while it is pinned over cards one pixel is
// off-screen, so the observer sees it as not fully visible and the band styling
// turns on. Resting in its normal place below the grid it is fully visible and
// looks like the plain footer it always was.
export default function CardPagination(props) {
  const ref = useRef(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(entry.intersectionRatio < 1),
      { threshold: [1] }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.totalCount]);

  if (!props.totalCount) return null;
  return (
    <div ref={ref} className={`card-pager-sticky${stuck ? " is-stuck" : ""}`}>
      <ListPagination {...props} itemLabel="cards" pageSizeOptions={CARD_PAGE_SIZE_OPTIONS} />
    </div>
  );
}
