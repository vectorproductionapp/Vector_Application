import React, { useState } from "react";
import Swal from "sweetalert2";
import { Download, Loader2 } from "lucide-react";
import { downloadCardDocuments } from "../utils/downloadCardDocuments";

const swal = (options) => Swal.fire({ confirmButtonColor: "var(--accent)", customClass: { popup: "swal-vector-popup" }, ...options });

/**
 * The ⬇ icon in a card's corner (left of the edit pencil). It shows on hover,
 * like the pencil, and downloads only this page's kind of document for the
 * card - e.g. on Invoices, the invoice files of that phase / invoice.
 *
 * Rendered as a span with role=button because cards are themselves buttons.
 */
export default function CardDownloadButton({ category, match, label, emptyText, folderName }) {
  const [busy, setBusy] = useState(false);

  const run = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const result = await downloadCardDocuments({ category, match, folderName });
      const clean = (text) => String(text).replace(/[<>&]/g, "");
      const where = `Saved as <b>${clean(result.folder || "")}</b> in your Downloads folder.`;
      if (!result.count) {
        swal({ icon: "info", title: "No files to download", text: emptyText });
      } else if (result.missing.length) {
        swal({
          icon: "warning",
          title: "Some files were not downloaded",
          html: `${result.saved} of ${result.count} files are in the zip. ${where}<br><br>These could not be read from storage (also listed in MISSING-FILES.txt inside the zip):<br><small>${result.missing.map(clean).join("<br>")}</small>`,
        });
      } else {
        swal({
          icon: "success",
          title: `${result.saved} file${result.saved === 1 ? "" : "s"} downloaded`,
          html: where,
          timer: 5000,
          showConfirmButton: false,
        });
      }
    } catch (error) {
      swal({ icon: "error", title: "Download failed", text: error?.response?.data?.message || error?.message || "The files could not be downloaded." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className={`model-card-download${busy ? " is-busy" : ""}`}
      onClick={run}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") run(event); }}
      aria-label={label}
      title={label}
    >
      {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
    </span>
  );
}
