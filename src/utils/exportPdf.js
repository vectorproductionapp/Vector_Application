import * as XLSX from "xlsx";

let qcPdfModulesPromise;
const imageDataUrlPromises = new Map();

function loadQcPdfModules() {
  if (!qcPdfModulesPromise) {
    qcPdfModulesPromise = Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]).catch((error) => {
      qcPdfModulesPromise = undefined;
      throw error;
    });
  }
  return qcPdfModulesPromise;
}

function loadImageAsDataUrl(url) {
  if (!url) return Promise.resolve(null);
  if (!imageDataUrlPromises.has(url)) {
    const imagePromise = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error("Logo could not be loaded");
        return response.blob();
      })
      .then((blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }))
      .catch((error) => {
        imageDataUrlPromises.delete(url);
        throw error;
      });
    imageDataUrlPromises.set(url, imagePromise);
  }
  return imageDataUrlPromises.get(url);
}

/** Warm the lazily loaded PDF code and logo cache before the user clicks Download. */
export function prepareQcReportPdf(logoUrl) {
  return Promise.allSettled([
    loadQcPdfModules(),
    loadImageAsDataUrl(logoUrl),
  ]);
}
 
// ---- helpers (mirrors exportPdf.js conventions) -----------------------
function sanitizeFileName(name) {
  return (name || "export")
    .toString()
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
 
function formatExportTimestamp(date = new Date()) {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
 
// Rough pt -> Excel character-width conversion for columns that
// specified a `width` (matches jspdf-autotable's `cellWidth` usage).
function ptToExcelWidth(pt) {
  return Math.max(8, Math.round(pt / 6));
}
 
// ---- table export (BOQ, StockRegister, DailyProduction, etc.) --------
/**
 * columns: [{ key, label, format?, width? }]
 * rows:    [{ [key]: value, ... }]
 * Same signature as exportTableToPdf — drop-in replacement.
 */
export function exportTableToExcel({ title, columns, rows, fileName }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("exportTableToExcel: `columns` must be a non-empty array.");
  }
 
  const headers = columns.map((column) => column.label ?? column.key);
 
  const body = (rows || []).map((row) =>
    columns.map((column) => {
      const raw = row[column.key];
      const value = column.format ? column.format(raw, row) : raw;
      return value === null || value === undefined ? "" : value;
    })
  );
 
  // Title + timestamp banner rows, then a blank spacer, then the table —
  // mirrors the header banner drawn on every PDF page.
  const bannerRows = [
    [title || "Report"],
    [`Exported ${formatExportTimestamp()}`],
    [],
  ];
 
  const worksheetData = [...bannerRows, headers, ...body];
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
 
  const headerRowIndex = bannerRows.length; // 0-based row where headers sit
 
  // Column widths: honor explicit `width` (pt, like the PDF), else auto-size
  worksheet["!cols"] = columns.map((column, i) => {
    if (column.width) return { wch: ptToExcelWidth(column.width) };
    const maxLen = Math.max(
      String(headers[i]).length,
      ...body.map((row) => String(row[i] ?? "").length)
    );
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
 
  // Merge the title/timestamp rows across all columns
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: columns.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: columns.length - 1 } },
  ];
 
  // Bold the title, italic the timestamp, bold the header row
  const titleCell = worksheet[XLSX.utils.encode_cell({ r: 0, c: 0 })];
  if (titleCell) titleCell.s = { font: { bold: true, sz: 14 } };
 
  const tsCell = worksheet[XLSX.utils.encode_cell({ r: 1, c: 0 })];
  if (tsCell) tsCell.s = { font: { italic: true, sz: 9, color: { rgb: "666564" } } };
 
  for (let c = 0; c < columns.length; c += 1) {
    const cellRef = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    if (worksheet[cellRef]) {
      worksheet[cellRef].s = {
        font: { bold: true, color: { rgb: "FFF2F0" } },
        fill: { fgColor: { rgb: "251714" } },
      };
    }
  }
 
  // Freeze panes below the header row so it stays visible on scroll
  worksheet["!freeze"] = { xSplit: 0, ySplit: headerRowIndex + 1 };
  worksheet["!autofilter"] = {
    ref: XLSX.utils.encode_range(
      { r: headerRowIndex, c: 0 },
      { r: headerRowIndex, c: columns.length - 1 }
    ),
  };
 
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, (title || "Sheet1").slice(0, 31));
 
  const safeName = sanitizeFileName(fileName || title);
  XLSX.writeFile(workbook, `${safeName}.xlsx`);
}

/** Generate the completed Daily Production QC inspection as a printable PDF. */
export async function exportQcReportToPdf({ model, serial, inspection, logoUrl }) {
  if (!inspection || !Array.isArray(inspection.items) || inspection.items.length === 0) {
    throw new Error("A completed QC inspection is required to generate the report.");
  }

  const [pdfModules, logoResult] = await Promise.all([
    loadQcPdfModules(),
    loadImageAsDataUrl(logoUrl).then(
      (dataUrl) => ({ dataUrl }),
      () => ({ dataUrl: null })
    ),
  ]);
  const [{ jsPDF }, { default: autoTable }] = pdfModules;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const bronze = [185, 130, 44];
  const dark = [17, 24, 39];
  const muted = [75, 85, 99];

  let logoAdded = false;
  if (logoResult.dataUrl) {
    try {
      doc.addImage(logoResult.dataUrl, "PNG", 14, 4.5, 13, 17.3);
      logoAdded = true;
    } catch (_) {
      logoAdded = false;
    }
  }
  if (!logoAdded) {
    doc.setTextColor(...dark);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("VECTOR", 14, 17);
  }
  doc.setFontSize(9);
  doc.setTextColor(...muted);
  doc.text("Format no: VIPL/F/23", pageWidth - 14, 17, { align: "right" });

  doc.setDrawColor(...bronze);
  doc.setLineWidth(0.6);
  doc.line(14, 22, pageWidth - 14, 22);

  doc.setTextColor(...dark);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("QC REPORT FOR POWER CONDITIONER", pageWidth / 2, 32, { align: "center" });

  doc.setFontSize(9.5);
  doc.setFont("helvetica", "normal");
  const details = [
    ["Make", "Vector"],
    ["Model", model || "-"],
    ["Serial No.", serial || "-"],
    ["QC Inspection Date", inspection.inspectionDate || "-"],
  ];
  details.forEach(([label, value], index) => {
    const y = 43 + (index * 6);
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(value), 50, y);
  });

  autoTable(doc, {
    startY: 70,
    head: [["S.No", "Description", "Method of Check", "Status"]],
    body: inspection.items.map((item) => [
      item.number,
      String(item.description || "").replace(/\u2014/g, "-"),
      item.method,
      item.status,
    ]),
    theme: "grid",
    styles: { font: "helvetica", fontSize: 8.3, cellPadding: 2.2, textColor: dark, lineColor: [209, 213, 219] },
    headStyles: { fillColor: bronze, textColor: [11, 11, 13], fontStyle: "bold", lineColor: bronze },
    columnStyles: {
      0: { cellWidth: 14, halign: "center" },
      1: { cellWidth: 76 },
      2: { cellWidth: 58 },
      3: { cellWidth: 28, halign: "center", fontStyle: "bold" },
    },
    margin: { left: 14, right: 14 },
    didDrawPage: () => {
      const pageHeight = doc.internal.pageSize.getHeight();
      doc.setFontSize(7.5);
      doc.setTextColor(...muted);
      doc.text(`QC Report - ${serial || "Assembly Unit"}`, 14, pageHeight - 8);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - 14, pageHeight - 8, { align: "right" });
    },
  });

  const signoffY = Math.min((doc.lastAutoTable?.finalY || 210) + 14, 270);
  const signoffs = [
    ["Checked By", inspection.checkedBy || "-"],
    ["Verified By", inspection.verifiedBy || "-"],
    ["Authorized By", inspection.authorizedBy || "-"],
  ];
  const signoffWidth = (pageWidth - 28) / 3;
  signoffs.forEach(([label, value], index) => {
    const x = 14 + (index * signoffWidth);
    doc.setDrawColor(156, 163, 175);
    doc.line(x, signoffY, x + signoffWidth - 8, signoffY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...dark);
    doc.text(label, x, signoffY + 5);
    doc.setFont("helvetica", "normal");
    doc.text(String(value), x, signoffY + 10);
  });

  const safeSerial = sanitizeFileName(serial || "assembly-unit");
  doc.save(`qc-report-${safeSerial}.pdf`);
}
 
