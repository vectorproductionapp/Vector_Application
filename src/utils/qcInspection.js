import { exportQcReportToPdf } from "./exportPdf";

// The QC checklist for a Power Conditioner. Shared by Daily Production (which
// fills it in) and the Stock Register's Documents tab (which re-downloads the
// report), so both produce the same PDF.
export const QC_INSPECTION_ITEMS = [
  { key: "acVoltage230V", number: "1", description: "AC Voltage 230V", method: "Multimeter" },
  { key: "outputLow170V", number: "2", description: "Output low 170V", method: "Multimeter + Variac" },
  { key: "outputHigh250V", number: "3", description: "Output high 250V", method: "Multimeter + Variac" },
  { key: "frequency50Hz", number: "4", description: "Frequency 50Hz", method: "Multimeter" },
  { key: "ledInputOn", number: "5a", description: "LED indication — Input on", method: "Visual Inspection" },
  { key: "ledOutputOn", number: "5b", description: "LED indication — Output on", method: "Visual Inspection" },
  { key: "ledOutputLow", number: "5c", description: "LED indication — Output low", method: "Visual Inspection" },
  { key: "ledOutputHigh", number: "5d", description: "LED indication — Output high", method: "Visual Inspection" },
  { key: "inputFuse10A", number: "6", description: "Input Fuse - 15 A", method: "Visual + Continuity test" },
  { key: "frontPanelLcd", number: "7", description: "Front Panel LCD Display", method: "Visual Inspection" },
  { key: "parameterLeds", number: "8", description: "Ensure all parameter LEDs are glowing", method: "Visual Inspection" },
  { key: "loadRun", number: "9", description: "Run machine for 4 hrs without load and 1 hr with load", method: "Input Load Source" },
  { key: "individualPort", number: "10", description: "Individual Port ON/OFF", method: "Visual + Physical Inspection" },
  { key: "schedulingOutlets", number: "11", description: "Scheduling Outlets", method: "Visual + Physical Inspection" },
  { key: "cutoffAlert", number: "12", description: "High/Low Cut-off Alert", method: "Visual Inspection" },
  { key: "temperatureAlert", number: "13", description: "Temperature Alert", method: "Visual Inspection" },
  { key: "wattageLogs", number: "14", description: "Overall Wattage Reading / logs", method: "Visual Inspection" },
  { key: "deviceDiscovery", number: "15", description: "Device discovery tool test", method: "Visual Inspection" },
];

export const VECTOR_PDF_LOGO_URL = `${process.env.PUBLIC_URL || ""}/images/vector-pdf.png`;

export function isQcInspectionComplete(report) {
  if (!report || typeof report !== "object") return false;
  if (!["inspectionDate", "checkedBy", "verifiedBy"].every((field) => String(report[field] || "").trim())) {
    return false;
  }
  return QC_INSPECTION_ITEMS.every((item) => report.checks?.[item.key] === "Passed");
}

/** Generates and saves the QC report PDF for one unit. Throws if incomplete. */
export function downloadQcReportPdf({ model, serial, qcInspection }, { asBlob = false } = {}) {
  if (!isQcInspectionComplete(qcInspection)) {
    throw new Error("Complete the QC inspection report before downloading the PDF.");
  }
  return exportQcReportToPdf({
    model,
    serial,
    logoUrl: VECTOR_PDF_LOGO_URL,
    asBlob,
    inspection: {
      ...qcInspection,
      items: QC_INSPECTION_ITEMS.map((item) => ({
        ...item,
        status: qcInspection.checks?.[item.key] || "",
      })),
    },
  });
}
