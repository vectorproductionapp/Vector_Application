import React from "react";
import DocumentsView from "../components/DocumentsView";
import { useHeaderSearch } from "../context/HeaderSearch";

/**
 * Documents Center: every uploaded invoice file, PO file and defect photo,
 * plus completed QC reports, with search, filters, dates and downloads.
 * Formerly a tab inside Stock Register; now its own sidebar page.
 */
export default function DocumentsCenter() {
  const [query] = useHeaderSearch("documents-center", "Search documents by invoice, PO, serial or file name...");
  return <DocumentsView query={query} />;
}
