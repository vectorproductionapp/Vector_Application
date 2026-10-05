import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import { File, FileText, Paperclip, Trash2, X } from "lucide-react";
import api from "./Api";
import { openEntryInNewTab, fileKind, entrySrc, entryName } from "./AttachmentsEditor";
import "./ImageAttachment.css";

const errorText = (err, fallback) =>
  err?.response?.data?.message || (err?.message === "Network Error" ? fallback : err?.message) || fallback;

/**
 * Attachment strip for the PO Details / Invoices table toolbars.
 *
 * - one label per view ("PO" / "Invoice" + the number of files), which links
 *   straight to the file: a single file opens in a new tab, several open the
 *   manager;
 * - the manager lists every file of the records currently in view, with preview
 *   and a per-file delete.
 *
 * `updateEndpoint` is the collection root (e.g. `/po-details`), used to PUT the
 * changed attachment list back onto a single record.
 */
export default function ImageStrip({
  rows,
  endpoint,
  updateEndpoint,
  attachmentsEndpoint = "",
  labelOf,
  scopeLabel = "Attachments",
  onChanged,
  onError,
}) {
  const [files, setFiles] = useState({});
  const [managerOpen, setManagerOpen] = useState(false);
  const [gallery, setGallery] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [actionError, setActionError] = useState("");

  const withFiles = (rows || []).filter((row) => row?.hasImage);
  // Storage-backed files already carry their URL in the list payload.  Inline
  // ones arrive as metadata only - the list strips the bytes - so any entry
  // without a `url` needs the second request.  Testing for `data` here (as this
  // used to) never matched, which is why records with files showed "0 files".
  const inlineIds = withFiles
    .filter((row) => (row.attachments || []).some((file) => !file?.url))
    .map((row) => row.id)
    .filter(Boolean)
    .join(",");

  // Adding a file to a row that already had files keeps `inlineIds` identical,
  // so the effect below also keys off the actual file list: when a save (or a
  // WebSocket notice) brings new metadata, the inline lookup refetches and the
  // badge count updates without a page refresh.
  const inlineSig = withFiles
    .filter((row) => (row.attachments || []).some((file) => !file?.url))
    .map(
      (row) =>
        `${row.id}=${(row.attachments || []).length}:${(row.attachments || [])
          .map((file) => file.name || "")
          .join("|")}`
    )
    .join(",");

  useEffect(() => {
    if (!endpoint || !inlineIds) {
      setFiles({});
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`${endpoint}?ids=${encodeURIComponent(inlineIds)}`);
        if (cancelled) return;
        if (!res.data.success) throw new Error(res.data.message || "Failed to load attachments");
        setFiles(res.data.attachments || {});
      } catch (err) {
        if (cancelled) return;
        setFiles({});
        onError?.(errorText(err, "Failed to load attachments."));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, inlineIds, inlineSig]);

  useEffect(() => {
    if (!managerOpen && !gallery && !viewing) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setManagerOpen(false);
      setGallery(null);
      setViewing(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [managerOpen, gallery, viewing]);

  // Every file behind the strip: the list payload's own metadata, with any
  // legacy inline file merged in from the lookup above.
  const filesOf = useCallback(
    (row) => {
      const inline = files[row.id] || [];
      const meta = (row.attachments || []).filter((file) => file && (file.url || file.data));
      if (!inline.length) return meta;
      if (!meta.length) return inline;
      const inlineNames = new Set(inline.map((file) => file.name));
      return [...meta, ...inline.filter((file) => !inlineNames.has(file.name))];
    },
    [files]
  );

  // Every file behind the strip, flat for the manager.
  const entries = useMemo(
    () =>
      withFiles.flatMap((row) =>
        filesOf(row).map((file, index) => ({
          row,
          file,
          index,
          key: `${row.id}-${index}`,
          record: labelOf ? labelOf(row) : row.id,
        }))
      ),
    [withFiles, filesOf, labelOf]
  );

  if (!withFiles.length) return null;

  // Deleting a file writes the whole list back to that one record, so the
  // other files on it are untouched.
  const saveList = async (entry, nextFiles) => {
    if (!updateEndpoint) return;
    setBusyKey(entry.key);
    setActionError("");
    try {
      const res = await api.put(`${updateEndpoint}/${entry.row.id}`, { attachments: nextFiles });
      if (!res.data?.success) {
        throw new Error(res.data.message || "Failed to update attachments");
      }
      setFiles((current) => ({ ...current, [entry.row.id]: nextFiles }));
      onChanged?.();
    } catch (err) {
      setActionError(errorText(err, "Failed to update attachments."));
    } finally {
      setBusyKey(null);
    }
  };

  const removeFile = async (entry) => {
    const name = entryName(entry.file);
    // Always confirm: only this one file goes, the rest of the record stays.
    const result = await Swal.fire({
      title: "Delete this file?",
      text: `“${name}” will be removed from ${entry.record}. Any other files on this record are kept.`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, delete it",
      cancelButtonText: "Cancel",
      confirmButtonColor: "#d64545",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      focusCancel: true,
      customClass: { popup: "swal-vector-popup" },
    });
    if (!result.isConfirmed) return;

    const current = filesOf(entry.row);
    const next = current.filter((_, position) => position !== entry.index);
    await saveList(entry, next);

    // The stored object goes too, so Storage does not keep orphans.
    if (attachmentsEndpoint && entry.file?.path) {
      try {
        await api.delete(attachmentsEndpoint, { data: { attachments: [entry.file] } });
      } catch {
        /* the record is already updated; a leftover object is harmless */
      }
    }
  };

  const openGallery = (row) => {
    const list = filesOf(row);
    if (list.length) setGallery({ row, list });
  };

  // The label is not a link: it just opens the manager, where the files are
  // listed (and the file names there are the hyperlinks).
  const openManager = () => {
    setManagerOpen(true);
    setActionError("");
  };

  return (
    <>
      <span className="image-strip">
        <button
          type="button"
          className="image-strip-label-button"
          onClick={openManager}
          title={`Manage ${scopeLabel} attachments`}
        >
          <Paperclip size={15} />
          <span className="image-strip-label">
            <span className="image-strip-scope">{scopeLabel}</span>
            <span className="image-strip-count">{entries.length}</span>
          </span>
        </button>
      </span>

      {managerOpen &&
        createPortal(
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            onClick={() => setManagerOpen(false)}
          >
            <div className="attachment-manager" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="attachment-manager-close"
                onClick={() => setManagerOpen(false)}
                aria-label="Close attachments"
              >
                <X size={18} />
              </button>

              <h3 className="attachment-manager-title">
                {scopeLabel} attachments
                <span className="attachment-manager-count">
                  {entries.length} file{entries.length === 1 ? "" : "s"} ·{" "}
                  {withFiles.length} record{withFiles.length === 1 ? "" : "s"}
                </span>
              </h3>

              {actionError && <div className="image-attachment-error">{actionError}</div>}

              {entries.length === 0 ? (
                <p className="attachment-manager-empty">No files attached in this view.</p>
              ) : (
                <ul className="attachment-manager-list">
                  {entries.map((entry) => {
                    const kind = fileKind(entry.file);
                    const busy = busyKey === entry.key;
                    return (
                      <li key={entry.key} className="attachment-manager-row">
                        <button
                          type="button"
                          className={`attachment-manager-thumb ${kind}`}
                          title={kind === "image" ? "Preview" : "Open this file"}
                          onClick={() => (kind === "image" ? openGallery(entry.row) : openEntryInNewTab(entry.file))}
                        >
                          {kind === "image" ? <img src={entrySrc(entry.file)} alt="" /> : kind === "pdf" ? <FileText size={20} /> : <File size={20} />}
                        </button>

                        <span className="attachment-manager-meta">
                          <span className="attachment-manager-record">{entry.record}</span>
                          {/* A real link when the file has a Storage URL, so the
                              status bar shows it and ctrl/right-click → open in
                              new tab works.  An inline file cannot be a link
                              (browsers block `data:` hrefs), so it opens through
                              a blob instead. */}
                          {entry.file?.url ? (
                            <a
                              className="attachment-manager-name"
                              href={entry.file.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={entry.file.name}
                            >
                              {entryName(entry.file)}
                            </a>
                          ) : (
                            <button
                              type="button"
                              className="attachment-manager-name is-link"
                              title={`Open ${entryName(entry.file)}`}
                              onClick={() => openEntryInNewTab(entry.file)}
                            >
                              {entryName(entry.file)}
                            </button>
                          )}
                        </span>

                        <span className="attachment-manager-actions">
                          <button
                            type="button"
                            className="attachment-manager-btn danger"
                            title="Delete this file only"
                            disabled={busy}
                            onClick={() => removeFile(entry)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>,
          document.body
        )}

      {gallery &&
        createPortal(
          <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setGallery(null)}>
            <button
              type="button"
              className="image-lightbox-close"
              onClick={() => setGallery(null)}
              aria-label="Close"
            >
              <X size={18} /> Close
            </button>

            {viewing ? (
              <>
                <img src={viewing.data} alt={viewing.name} onClick={(e) => e.stopPropagation()} />
                <div className="image-lightbox-caption">
                  <span>{viewing.name}</span>
                  <span className="image-lightbox-meta">
                    {gallery.list.length} file{gallery.list.length === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  className="image-lightbox-close"
                  style={{ top: "auto", bottom: 22, right: 22 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setViewing(null);
                  }}
                >
                  All files
                </button>
              </>
            ) : (
              <>
                <div className="image-gallery" onClick={(e) => e.stopPropagation()}>
                  {gallery.list.map((file, index) => {
                    const kind = fileKind(file);
                    return (
                      <button
                        key={`${file.name}-${index}`}
                        type="button"
                        className="image-gallery-item"
                        onClick={() => (kind === "image" ? setViewing({ ...file }) : openEntryInNewTab(file))}
                      >
                        {kind === "image" ? (
                          <img src={entrySrc(file)} alt="" />
                        ) : (
                          <span className={`image-gallery-pdf ${kind}`}>
                            {kind === "pdf" ? <FileText size={28} /> : <File size={28} />}
                          </span>
                        )}
                        <span className="image-gallery-name">{entryName(file)}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="image-lightbox-caption">
                  <span>
                    {gallery.list.length} file{gallery.list.length === 1 ? "" : "s"}
                  </span>
                </div>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
