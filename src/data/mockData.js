/* ---------------------------------------------------------------
   KPI cards (Dashboard) — colours pulled from the brand ramp only.
   --------------------------------------------------------------- */
export const kpis = [
  { key: "prod", label: "Units In Production", value: 18, group: "pipeline" },
  { key: "semi", label: "Units Semi Finished", value: 9, group: "pipeline" },
  { key: "qc", label: "Under QC Inspection", value: 6, group: "pipeline" },
  { key: "failed", label: "QC Failed", value: 2, group: "pipeline" },
  { key: "passed", label: "QC Passed (Total)", value: 41, group: "pipeline" },
  { key: "packed", label: "Packed (Ready to Dispatch)", value: 12, group: "outcome" },
  { key: "sold", label: "Units Sold", value: 29, group: "outcome" },
  { key: "salesValue", label: "Total Sales Value (INR)", value: 1842300, group: "outcome", currency: true },
  { key: "defects", label: "Defective Units Reported", value: 5, group: "outcome" },
  { key: "reorder", label: "Materials Below Min Stock", value: 3, group: "outcome" },
];

export const pipelineStages = [
  { label: "In Production", value: 18 },
  { label: "Semi Finished", value: 9 },
  { label: "QC Inspection", value: 6 },
  { label: "QC Passed", value: 41 },
  { label: "Packed", value: 12 },
  { label: "Sold", value: 29 },
];

export const locationSales = [
  { location: "Chennai", units: 11 },
  { location: "Bengaluru", units: 8 },
  { location: "Hyderabad", units: 6 },
  { location: "Coimbatore", units: 4 },
  { location: "Pune", units: 3 },
  { location: "Delhi NCR", units: 2 },
];

export const defectiveParts = [
  { name: "LED", count: 6 },
  { name: "Power Board", count: 4 },
  { name: "Enclosure", count: 3 },
  { name: "Raspberry Pi", count: 2 },
  { name: "Cable Harness", count: 1 },
];

/* ---------------------------------------------------------------
   Table pages
   --------------------------------------------------------------- */
export const boqRows = [
  { phase: "Phase 1", code: "RM-001", desc: "Raspberry Pi", make: "Raspberry", model: "Pi 4 Model B", uom: "Qty", reqQty: 1, minStock: 50, vendor: "Megatronix", rate: 5174 },
  { phase: "Phase 1", code: "RM-002", desc: "LED", make: "Mega", model: ".5mm", uom: "Qty", reqQty: 4, minStock: 50, vendor: "Megatronix", rate: 0.9 },
  { phase: "Phase 1", code: "RM-003", desc: "Power Board", make: "Voltrex", model: "PB-12V", uom: "Qty", reqQty: 1, minStock: 30, vendor: "Voltrex Ind.", rate: 640 },
];

export const poRows = [
  { phase: "Phase 1", po: "VIPL-26-27-1234", date: "2026-05-20", code: "RM-001", desc: "Raspberry Pi", qty: 100, rate: 5174, gst: 93132, value: 610532, status: "Received" },
  { phase: "Phase 1", po: "VIPL-26-27-1234", date: "2026-05-20", code: "RM-002", desc: "LED", qty: 50, rate: 0.9, gst: 8.1, value: 53.1, status: "Received" },
];

export const invoiceRows = [
  { invoice: "INV-26-27-GST-1454", date: "2026-07-02", po: "VIPL-26-27-1234", code: "RM-001", desc: "Raspberry Pi", qtyInv: 25, qtyRecv: 25, verifiedBy: "Sivakami" },
  { invoice: "INV-26-27-GST-1455", date: "2026-07-02", po: "VIPL-26-27-1234", code: "RM-002", desc: "LED", qtyInv: 50, qtyRecv: 25, verifiedBy: "Sivakami" },
];

export const stockRows = [
  { phase: "Phase 1", code: "RM-001", desc: "Raspberry Pi", opening: 0, purchased: 25, consumed: 12, closing: 13, minLevel: 50, status: "REORDER - BELOW MIN" },
  { phase: "Phase 1", code: "RM-002", desc: "LED", opening: 0, purchased: 25, consumed: 48, closing: -23, minLevel: 200, status: "REORDER - BELOW MIN" },
];

export const productionRows = [
  { date: "2026-07-03", phase: "Phase 1", model: "VE-PC-G1", serial: "26CHA07245", stage: "Completed", qc: "Passed", qcBy: "Divakaran", packaging: "Packed" },
  { date: "2026-07-02", phase: "Phase 1", model: "VE-PC-G1", serial: "26CHA07244", stage: "Completed", qc: "Passed", qcBy: "Divakaran", packaging: "Packed" },
];

export const saleRows = [
  { poNo: "CL-PO-5521", client: "Zenith Retail", location: "Chennai", model: "VE-PC-G1", serial: "26CHA07240", qty: 1, dispatch: "Dispatched", value: 41000 },
  { poNo: "CL-PO-5522", client: "Orion Traders", location: "Bengaluru", model: "VE-PC-G1", serial: "26CHA07241", qty: 1, dispatch: "Dispatched", value: 41000 },
];

export const defectRows = [
  { date: "2026-06-28", make: "Raspberry", model: "Pi 4 Model B", serial: "26CHA07201", part: "LED", problem: "Intermittent flicker", status: "Open" },
  { date: "2026-06-30", make: "Voltrex", model: "PB-12V", serial: "26CHA07198", part: "Power Board", problem: "No output", status: "Closed" },
];

export const fmtINR = (n) => "\u20B9" + Math.round(n).toLocaleString("en-IN");
