import * as XLSX from "xlsx";
import api from "../components/Api";
import { downloadQcReportPdf } from "./qcInspection";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

const norm = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// Windows / macOS forbid these in file and folder names.
const safeName = (value, fallback) => String(value ?? "").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/[. ]+$/, "").trim() || fallback;

async function loadDocuments() {
  const response = await api.get(`${API_BASE_URL}/documents`, { __vectorNoCache: true });
  if (!response.data?.success) throw new Error(response.data?.message || "Failed to load documents");
  return response.data.documents || [];
}

async function blobOf(item) {
  if (item.kind === "qc") return downloadQcReportPdf(item, { asBlob: true });
  const response = await api.get(`${API_BASE_URL}/documents/download`, {
    params: { id: item.id },
    responseType: "blob",
    __vectorNoDedupe: true,
  });
  return response.data;
}

async function errorText(error) {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text()).message || error.message;
    } catch {
      return error.message;
    }
  }
  return data?.message || error?.message || "unknown error";
}

/**
 * Where each file goes inside the card's folder - always the zip layout:
 * one sub-folder per invoice / PO number, documents inside it, for a phase
 * card and a single invoice / PO card alike. Duplicate names get " (2)".
 */
function layout(items) {
  const used = new Set();
  return items.map((item) => {
    const folder = safeName(item.reference, "Unreferenced");
    const name = safeName(item.name, "file");
    const dot = name.lastIndexOf(".");
    let candidate = name;
    for (let copy = 2; used.has(`${folder}/${candidate}`.toLowerCase()); copy += 1) {
      candidate = dot > 0 ? `${name.slice(0, dot)} (${copy})${name.slice(dot)}` : `${name} (${copy})`;
    }
    used.add(`${folder}/${candidate}`.toLowerCase());
    return { item, folder, name: candidate };
  });
}

/** Fetch every file; unreadable ones are reported, not fatal. */
async function fetchAll(planned) {
  const ready = [];
  const missing = [];
  for (const entry of planned) {
    try {
      // eslint-disable-next-line no-await-in-loop
      ready.push({ ...entry, blob: await blobOf(entry.item) });
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      missing.push(`${entry.item.name}: ${await errorText(error)}`);
    }
  }
  if (!ready.length) throw new Error(`None of the files could be downloaded. ${missing[0] || ""}`.trim());
  return { ready, missing };
}

async function saveZip(folderName, ready, missing) {
  const archive = XLSX.CFB.utils.cfb_new();
  const buffers = await Promise.all(ready.map((entry) => entry.blob.arrayBuffer()));
  ready.forEach(({ folder, name }, index) => {
    XLSX.CFB.utils.cfb_add(archive, `/${folderName}/${folder ? `${folder}/` : ""}${name}`, new Uint8Array(buffers[index]));
  });
  if (missing.length) {
    const note = `These files could not be downloaded:\r\n${missing.join("\r\n")}\r\n`;
    XLSX.CFB.utils.cfb_add(archive, `/${folderName}/MISSING-FILES.txt`, new TextEncoder().encode(note));
  }
  const output = XLSX.CFB.write(archive, { fileType: "zip", type: "array" });
  const url = URL.createObjectURL(new Blob([new Uint8Array(output)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${folderName}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download one card's files as a single .zip: only `category` (e.g.
 * "Invoice" or "PO" - the page the card is on), narrowed by `match`.
 *
 * Inside the zip: `<folderName>/<invoice or PO number>/<documents>`, e.g.
 * `phase-1 invoices/21567/Screenshot.png`. Files that cannot be read are
 * listed in `<folderName>/MISSING-FILES.txt`.
 *
 * Resolves to { count, saved, missing, folder } (folder = the zip's name).
 */
export async function downloadCardDocuments({ category, match, folderName }) {
  const wanted = safeName(folderName, "documents");
  const items = (await loadDocuments()).filter((item) => item.category === category && match(item));
  if (!items.length) return { count: 0, saved: 0, missing: [] };
  const { ready, missing } = await fetchAll(layout(items));
  await saveZip(wanted, ready, missing);
  return { count: items.length, saved: ready.length, missing, folder: `${wanted}.zip` };
}

/** Does a document belong to this phase (by name, as the card groups it)? */
export function inPhaseNamed(item, phaseName) {
  return (item.scope?.phaseNames || []).includes(norm(phaseName));
}

/** Is this the document of one invoice / PO number (optionally in a phase)? */
export function isReference(item, reference, phaseName) {
  if (norm(item.reference) !== norm(reference)) return false;
  return !phaseName || !(item.scope?.phaseNames || []).length || inPhaseNamed(item, phaseName);
}
