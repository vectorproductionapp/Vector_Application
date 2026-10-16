import React, { useEffect, useMemo, useState } from "react";
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
  const list = Array.isArray(items) ? items : [];
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

// Footer for a card grid. Hidden when there are no cards to page.
export default function CardPagination(props) {
  if (!props.totalCount) return null;
  return <ListPagination {...props} itemLabel="cards" pageSizeOptions={CARD_PAGE_SIZE_OPTIONS} />;
}
