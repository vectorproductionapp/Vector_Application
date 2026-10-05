import React, { useCallback, useRef, useState } from "react";
import Swal from "sweetalert2";
import { ExternalLink, File, FileText, ImagePlus, Loader2, Paperclip, Trash2 } from "lucide-react";
import api from "./Api";
import "./ImageAttachment.css";

/**
 * Attachments for a PO line or invoice: any file at all - photos, scans,
 * PDFs, spreadsheets, documents.  Images are compressed in the browser, then
 * everything is uploaded to Firebase Storage, so the record only keeps the
 * small metadata per file.
 */
const MAX_EDGE = 1600;
const START_QUALITY = 0.85;
const UPLOAD_ENDPOINT = "/attachments/upload";

export const isPdfEntry = (entry) =>
  entry?.type === "application/pdf" ||
  (typeof entry?.data === "string" && entry.data.startsWith("data:application/pdf"));

export const isImageEntry = (entry) =>
  entry?.type?.startsWith("image/") ||
  (typeof entry?.data === "string" && entry.data.startsWith("data:image/"));

/** "image" | "pdf" | "file" - decides the icon and how a file opens. */
export function fileKind(entry) {
  if (isImageEntry(entry)) return "image";
  if (isPdfEntry(entry)) return "pdf";
  return "file";
}

const shortKind = (entry) => {
  const kind = fileKind(entry);
  if (kind === "image") return "IMG";
  if (kind === "pdf") return "PDF";
  const name = entry?.name || "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return (ext || "FILE").slice(0, 5).toUpperCase();
};

// Where the file's bytes live: a Storage URL, or a legacy inline data URL.
export const entrySrc = (entry) => entry?.url || entry?.data || "";

export const entryName = (entry, fallback = "Attachment") =>
  entry?.name ||
  (fileKind(entry) === "pdf" ? "Attached PDF" : fileKind(entry) === "image" ? "Attached image" : "Attached file");

/**
 * Chrome/Edge render a `data:` PDF URL blank on first load in a new tab, so a
 * legacy inline file is handed to the browser as a Blob URL instead.
 */
export function openEntryInNewTab(entry) {
  if (entry?.url) {
    window.open(entry.url, "_blank", "noopener");
    return true;
  }
  try {
    const data = entry?.data || "";
    const commaAt = data.indexOf(",");
    const header = commaAt > 0 ? data.slice(0, commaAt) : "";
    const base64 = commaAt > 0 ? data.slice(commaAt + 1) : "";
    const mime = /data:([^;,]+)/.exec(header)?.[1] || "application/octet-stream";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const opened = window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!opened) window.open(url, "_blank");
    return true;
  } catch {
    return false;
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`“${file.name}” could not be read.`));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error(`“${file.name}” is not a readable image.`));
      image.onload = () => {
        // Never upscale, and keep enough resolution to stay legible.
        const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.imageSmoothingQuality = "high";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        let quality = START_QUALITY;
        let data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 1_500_000 && quality > 0.5) {
          quality -= 0.05;
          data = canvas.toDataURL("image/jpeg", quality);
        }
        resolve({ data, type: "image/jpeg" });
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`“${file.name}” could not be read.`));
    reader.onload = () => resolve({ data: String(reader.result), type: file.type || "application/pdf" });
    reader.readAsDataURL(file);
  });
}

/**
 * The files of a row, whichever shape it arrived in: the current `attachments`
 * metadata list, or a legacy single inline file.
 */
export function attachmentsOf(row) {
  if (!row) return [];
  if (Array.isArray(row.attachments) && row.attachments.length) {
    return row.attachments.filter((file) => file && (file.url || file.data));
  }
  if (row.image) {
    const kind = String(row.image).startsWith("data:application/pdf") ? "pdf" : "image";
    return [
      {
        name: row.imageName || (kind === "pdf" ? "Attached PDF" : "Attached image"),
        type: kind === "pdf" ? "application/pdf" : "image/jpeg",
        data: row.image,
      },
    ];
  }
  return [];
}

export default function AttachmentsEditor({
  files = [],
  onChange,
  label = "Attach files",
  hint = "Optional · any files - photos, scans, PDFs, documents (photos are compressed automatically)",
  uploadEndpoint = "",
  disabled = false,
  readOnly = false,
  compact = false,
}) {
  const inputRef = useRef(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(
    async (event) => {
      const picked = Array.from(event.target.files || []);
      event.target.value = "";
      if (!picked.length) return;

      setError("");
      setBusy(true);
      const prepared = [];
      const failures = [];

      for (const file of picked) {
        try {
          if (file.type && file.type.startsWith("image/")) {
            // Photos and scans are compressed so they stay small.
            const { data, type } = await compressImage(file);
            prepared.push({ name: file.name, type, data });
          } else {
            // PDFs, documents, spreadsheets, anything else: stored as it is.
            const { data, type } = await readAsDataUrl(file);
            prepared.push({ name: file.name, type: type || "application/octet-stream", data });
          }
        } catch (err) {
          failures.push(err?.message || `“${file.name}” was skipped`);
        }
      }

      // One request per batch: the files go to Storage, the record only keeps
      // the returned metadata, so there is no per-record size ceiling.
      if (prepared.length) {
        try {
          const res = await api.post(uploadEndpoint || UPLOAD_ENDPOINT, { files: prepared });
          if (!res.data?.success) {
            throw new Error(res.data?.message || "The files could not be uploaded");
          }
          onChange?.([...(files || []), ...(res.data.attachments || [])]);
        } catch (err) {
          setError(
            err?.response?.data?.message || err?.message || "The files could not be uploaded."
          );
        }
      }

      if (failures.length) setError(failures[0]);
      setBusy(false);
    },
    [files, onChange, uploadEndpoint]
  );

  const removeAt = (index) => onChange?.(files.filter((_, position) => position !== index));

  // Every remove asks first, so a file can never be dropped by a stray click.
  const confirmRemove = async (index) => {
    const name = entryName(files[index] || {});
    const result = await Swal.fire({
      title: files.length > 1 ? "Remove this file?" : "Remove the attachment?",
      text:
        files.length > 1
          ? `“${name}” will be removed. Any other attached files are kept.`
          : `“${name}” will be removed from this record.`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, remove it",
      cancelButtonText: "Cancel",
      confirmButtonColor: "#d64545",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      focusCancel: true,
      customClass: { popup: "swal-vector-popup" },
    });
    if (result.isConfirmed) removeAt(index);
  };

  const confirmRemoveAll = async () => {
    const result = await Swal.fire({
      title: "Remove all files?",
      text: `All ${files.length} attached file${files.length === 1 ? "" : "s"} will be removed from this record.`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, remove them",
      cancelButtonText: "Cancel",
      confirmButtonColor: "#d64545",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      focusCancel: true,
      customClass: { popup: "swal-vector-popup" },
    });
    if (result.isConfirmed) onChange?.([]);
  };
  const totalSize = (files || []).reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
  const sizeLabel = totalSize
    ? totalSize > 1024 * 1024
      ? `${(totalSize / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(totalSize / 1024)} KB`
    : "0 KB";

  return (
    <div className={`image-attachment${compact ? " compact" : ""}`}>
      {!readOnly && (
        <div className="image-attachment-row">
          <button
            type="button"
            className="image-attachment-btn"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />}
            {busy ? "Uploading..." : files.length ? "Add more files" : label}
          </button>
          {files.length > 0 && (
            <button
              type="button"
              className="image-attachment-btn danger"
              onClick={confirmRemoveAll}
              disabled={disabled || busy}
            >
              <Trash2 size={15} />
              Remove all
            </button>
          )}
          <span className="image-attachment-hint">{hint}</span>
        </div>
      )}

      {files.length > 0 && (
        <ul className="attachment-list">
          {files.map((file, index) => {
            const kind = fileKind(file);
            // Images preview in place; anything else opens in a new tab.
            const Row = kind === "image" ? "div" : "button";
            const Icon = kind === "image" ? Paperclip : kind === "pdf" ? FileText : File;
            return (
              <li key={`${file.name}-${index}`} className="attachment-item">
                <Row
                  className={`attachment-row${kind === "image" ? "" : " is-open"}`}
                  {...(kind === "image"
                    ? {}
                    : {
                        type: "button",
                        title: "Open this file in a new tab",
                        onClick: () => openEntryInNewTab(file),
                      })}
                >
                  <span className={`attachment-kind ${kind}`} aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="attachment-name" title={file.name}>
                    {entryName(file)}
                  </span>
                  <span className="attachment-size">
                    {shortKind(file)}
                    {kind !== "image" ? <ExternalLink size={12} /> : null}
                  </span>
                  {!readOnly && (
                    <span
                      className="attachment-remove"
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove ${file.name}`}
                      title="Remove this file only"
                      onClick={(event) => {
                        event.stopPropagation();
                        confirmRemove(index);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          confirmRemove(index);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </span>
                  )}
                </Row>
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && files.length > 0 && (
        <div className="attachment-usage">
          {files.length} file{files.length === 1 ? "" : "s"} · {sizeLabel} stored
        </div>
      )}

      {!files.length && <div className="image-attachment-empty">No files attached</div>}

      {error && <div className="image-attachment-error">{error}</div>}

      {!readOnly && (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="image-attachment-input"
          onChange={handleFiles}
          tabIndex={-1}
        />
      )}
    </div>
  );
}
