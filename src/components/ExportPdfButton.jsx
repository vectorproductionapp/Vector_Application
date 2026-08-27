import React, { useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { exportTableToExcel } from "../utils/exportPdf.js";
import "./ExportPdfButton.css";
 
/**
 * <ExportExcelButton title="BOQ" columns={cols} rows={rows} fileName="boq" />
 */
export default function ExportExcelButton({ title, columns, rows, fileName }) {
  const [busy, setBusy] = useState(false);
 
  const handleClick = async () => {
    setBusy(true);
    try {
      exportTableToExcel({ title, columns, rows, fileName });
    } finally {
      setBusy(false);
    }
  };
 
  return (
    <button className="export-pdf-btn" onClick={handleClick} disabled={busy}>
      {busy ? <Loader2 size={15} className="spin" /> : <FileSpreadsheet size={15} />}
      {busy ? "Exporting..." : "Export Excel"}
    </button>
  );
}
 