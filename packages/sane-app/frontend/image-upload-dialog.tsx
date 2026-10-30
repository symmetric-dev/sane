import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertCircle, FiCheck, FiCheckCircle, FiChevronDown, FiEdit2, FiFolder, FiFolderPlus, FiImage, FiInfo, FiLoader, FiRotateCw, FiSearch, FiUpload, FiX } from "react-icons/fi";
import {
  DEFAULT_IMAGE_UPLOAD_DIRECTORY, IMAGE_UPLOAD_LIMITS, imageUploadMimeType, isImageUploadDirectory,
  type ImageUploadReceipt,
} from "../shared/image-upload-contract";
import {
  imageUploadClient, ImageUploadError, imageUploadScopeId, imageUploadContentUrl,
  readImageUploadDirectory, writeImageUploadDirectory, validateImageUploadFile,
  type ImageUploadBinding, type ImageUploadTarget,
} from "./image-upload-client";
import { ImageUploadDirectoryPicker } from "./image-upload-directory-picker";
import { ShellDialog } from "./shell-dialog";
import { useStore } from "./store";
import "./image-upload.css";
export type { ImageUploadTarget } from "./image-upload-client";

export type ImageUploadDialogProps = {
  target: ImageUploadTarget; expectedBindingRevision: string; files: File[]; initialDirectory?: string;
  onUploaded: (receipts: ImageUploadReceipt[]) => void; onClose: () => void;
};
type UploadRow = {
  id: string; requestId: string; file: File; name: string;
  status: "ready" | "uploading" | "uploaded" | "failed" | "unknown" | "skipped";
  error?: string; suggestedFilename?: string; receipt?: ImageUploadReceipt;
};
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
const bytesLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

/** Scope changes unmount the pinned batch and synchronously gate late callbacks. */
export function ImageUploadDialog(props: ImageUploadDialogProps) {
  const storeId = useStore(state => state.config?.storeId);
  const authScope = useStore(state => JSON.stringify([state.phase, state.config?.authenticated]));
  const permitted = useStore(state => state.phase === "ready" && state.config?.authenticated === true);
  const scope = JSON.stringify([storeId, authScope, imageUploadScopeId(props.target), props.expectedBindingRevision]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  return permitted ? createPortal(<ImageUploadForm key={scope} {...props} storeId={storeId}
    scopeCurrent={() => activeScope.current === scope} />, document.body) : null;
}

function ImageUploadForm({ target, expectedBindingRevision, files, initialDirectory, onUploaded, onClose, storeId, scopeCurrent }: ImageUploadDialogProps & {
  storeId?: string; scopeCurrent: () => boolean;
}) {
  const [binding, setBinding] = useState<ImageUploadBinding>();
  const [resolveError, setResolveError] = useState("");
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const [directory, setDirectory] = useState(DEFAULT_IMAGE_UPLOAD_DIRECTORY);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [rows, setRows] = useState<UploadRow[]>(() => files.map(file => ({
    id: crypto.randomUUID(), requestId: crypto.randomUUID(), file, name: file.name, status: "ready",
  })));
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [closeWarning, setCloseWarning] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [stagedFolder, setStagedFolder] = useState<string>();
  const [folderCreated, setFolderCreated] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true), locked = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const emitted = useRef(new Set<string>());
  const callbacks = useRef({ onUploaded, onClose }); callbacks.current = { onUploaded, onClose };
  const folderId = useId();
  const current = () => alive.current && scopeCurrent();
  const patchRow = (id: string, patch: Partial<UploadRow>) => {
    if (!current()) return;
    setRows(previous => { const next = previous.map(row => row.id === id ? { ...row, ...patch } : row); rowsRef.current = next; return next; });
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    let ignored = false;
    setResolveError("");
    void imageUploadClient.resolve(target).then(value => {
      if (ignored || !current()) return;
      if (!expectedBindingRevision || value.bindingRevision !== expectedBindingRevision) {
        throw new ImageUploadError("The selected checkout changed. Refresh its files and reopen the upload dialog before uploading.", 409, "workspace-changed");
      }
      setBinding(value);
      setDirectory(initialDirectory !== undefined && isImageUploadDirectory(initialDirectory)
        ? initialDirectory : readImageUploadDirectory(value, storeId) ?? DEFAULT_IMAGE_UPLOAD_DIRECTORY);
    }).catch(error => { if (!ignored && current()) setResolveError(message(error)); });
    return () => { ignored = true; };
  }, [resolveAttempt]);

  const deliver = (row: UploadRow, receipt: ImageUploadReceipt) => {
    if (!current() || !binding || receipt.workspaceId !== binding.workspaceId || receipt.worktreeId !== binding.worktreeId
      || receipt.bindingRevision !== binding.bindingRevision || receipt.uploadId !== row.requestId
      || receipt.directory !== directory || receipt.name !== row.name || receipt.bytes !== row.file.size
      || receipt.mimeType !== imageUploadMimeType(row.name)) {
      throw new ImageUploadError("The recovered receipt does not match this file and destination.", 0, "receipt-mismatch", true);
    }
    patchRow(row.id, { status: "uploaded", receipt, error: undefined });
    if (emitted.current.has(receipt.uploadId)) return;
    emitted.current.add(receipt.uploadId);
    try { callbacks.current.onUploaded([receipt]); }
    catch { setNotice("The file was saved, but its reference could not be added. The saved file is retained in the project."); }
  };

  const recoverRow = async (row: UploadRow, signal: AbortSignal) => {
    if (!binding) return;
    try {
      const receipt = await imageUploadClient.recover({ ...binding, requestId: row.requestId }, signal);
      if (!current() || signal.aborted) return;
      if (receipt) deliver(row, receipt);
      else patchRow(row.id, { status: "unknown", error: "No receipt is available yet. The file may still have been saved. Retry sends only the same request; Skip does not delete a file." });
    } catch (error) {
      if (current() && !signal.aborted) patchRow(row.id, { status: "unknown", error: `${message(error)} Upload status is unknown. No automatic retry was made.` });
    }
  };

  const run = async (selected: UploadRow[], checkOnly = false) => {
    if (locked.current || !binding || !current() || !selected.length) return;
    if (!checkOnly && (!directoryReady || rows.length > IMAGE_UPLOAD_LIMITS.files || selected.length > IMAGE_UPLOAD_LIMITS.files
      || selected.reduce((total, row) => total + row.file.size, 0) > IMAGE_UPLOAD_LIMITS.totalBytes
      || selected.some(row => validateImageUploadFile(row.file, row.name)))) return;
    locked.current = true; setBusy(true); setStarted(true); setCloseWarning(false); setNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      if (!checkOnly && stagedFolder && !folderCreated) {
        setProgress(`Creating ${stagedFolder}…`);
        try {
          await imageUploadClient.createDirectory(binding, stagedFolder, abort.signal);
          if (!current() || abort.signal.aborted) return;
          setFolderCreated(true); setRefresh(value => value + 1);
        } catch (error) {
          if (current() && !abort.signal.aborted) {
            setNotice(`${message(error)} No images were uploaded. A folder may have been created and will not be removed.`);
            setRefresh(value => value + 1);
          }
          return;
        }
      }
      for (const [index, row] of selected.entries()) {
        if (!current() || abort.signal.aborted) break;
        setProgress(`${checkOnly ? "Checking receipt" : "Uploading"} ${index + 1} of ${selected.length}: ${row.name}`);
        if (checkOnly) { await recoverRow(row, abort.signal); continue; }
        patchRow(row.id, { status: "uploading", error: undefined, suggestedFilename: undefined });
        try {
          const receipt = await imageUploadClient.upload({ ...binding, directory, filename: row.name, requestId: row.requestId, file: row.file }, abort.signal);
          if (current() && !abort.signal.aborted) deliver(row, receipt);
        } catch (error) {
          if (!current() || abort.signal.aborted) break;
          if (row.status === "unknown" || error instanceof ImageUploadError && error.uncertain) {
            patchRow(row.id, { status: "unknown", error: "Checking whether the server saved this image…" });
            await recoverRow(row, abort.signal);
          } else patchRow(row.id, { status: "failed", error: message(error), suggestedFilename: error instanceof ImageUploadError ? error.suggestedFilename : undefined });
        }
      }
    } finally {
      locked.current = false;
      if (current()) { setBusy(false); setProgress(""); }
    }
  };

  const dismiss = () => {
    if (busy || rowsRef.current.some(row => row.status === "unknown")) { setCloseWarning(true); return; }
    alive.current = false; controller.current?.abort(); callbacks.current.onClose();
  };
  const stopAndClose = () => { alive.current = false; controller.current?.abort(); callbacks.current.onClose(); };
  const chooseDirectory = (path: string) => {
    if (!binding || started || !isImageUploadDirectory(path)) return;
    if (path === directory) { writeImageUploadDirectory(binding, path, storeId); return; }
    setDirectoryReady(false); setDirectory(path); setStagedFolder(undefined);
    writeImageUploadDirectory(binding, path, storeId);
    setRows(previous => previous.map(row => ({ ...row, requestId: crypto.randomUUID() })));
  };
  const stageFolder = () => {
    const path = directory ? `${directory}/${folderName}` : folderName;
    if (!binding || started || !folderName || !isImageUploadDirectory(path)) { setNotice("Enter a safe relative folder name or nested path, without . or .. segments."); return; }
    setDirectoryReady(false); setDirectory(path); setStagedFolder(path); setFolderName(""); setNewFolderOpen(false); setNotice("");
    writeImageUploadDirectory(binding, path, storeId);
    setRows(previous => previous.map(row => ({ ...row, requestId: crypto.randomUUID() })));
  };
  const rename = (row: UploadRow, name: string) => patchRow(row.id, { name, requestId: crypto.randomUUID(), status: "ready", error: undefined, suggestedFilename: undefined });
  const pending = rows.filter(row => row.status === "ready" || row.status === "failed" || row.status === "unknown");
  const retained = rows.filter(row => row.status === "uploaded").length;
  const totalBytes = pending.reduce((total, row) => total + row.file.size, 0);
  const batchError = rows.length > IMAGE_UPLOAD_LIMITS.files ? `Choose at most ${IMAGE_UPLOAD_LIMITS.files} images. Remove extra files to continue.`
    : totalBytes > IMAGE_UPLOAD_LIMITS.totalBytes ? "The batch exceeds 160 MiB. Remove files to continue." : "";
  const invalid = pending.some(row => validateImageUploadFile(row.file, row.name));
  const selectedBytes = rows.reduce((total, row) => total + row.file.size, 0);
  const rootName = binding?.root?.split("/").filter(Boolean).at(-1) || "Project root";

  return <ShellDialog title="Attach images" subtitle={`${rows.length} image${rows.length === 1 ? "" : "s"} · ${bytesLabel(selectedBytes)}`} close={dismiss} className="image-upload-dialog">
    <div className="image-upload-body">
      {resolveError && <div className="image-upload-alert" role="alert"><FiAlertCircle aria-hidden="true" /><div><p>{resolveError}</p><button type="button" className="image-upload-text-action" onClick={() => setResolveAttempt(value => value + 1)}>Retry</button></div></div>}
      {batchError && <div className="image-upload-alert" role="alert"><FiAlertCircle aria-hidden="true" /><p>{batchError}</p></div>}
      <div className="image-upload-layout">
        <section className="image-upload-panel image-upload-files-panel" aria-label="Images to upload">
          <header className="image-upload-panel-heading"><FiImage aria-hidden="true" /><h3>Images</h3><span className="image-upload-badge">{rows.length}</span></header>
          {!rows.length && <p className="image-upload-empty">No images selected.</p>}
          <ul className="image-upload-list">{rows.map(row => <ImageUploadFileRow key={row.id} row={row} busy={busy}
            onRename={name => rename(row, name)} onRemove={() => setRows(previous => previous.filter(item => item.id !== row.id))}
            onSkip={() => patchRow(row.id, { status: "skipped" })}
            onRetry={() => void run([row])} onCheck={() => void run([row], true)} />)}</ul>
        </section>
        <section className="image-upload-panel image-upload-destination" aria-label="Upload destination">
          <header className="image-upload-panel-heading"><FiFolder aria-hidden="true" /><h3>Save to</h3>
            {!started && <button type="button" className="icon-button" aria-label="New folder" title="New folder" aria-expanded={newFolderOpen} aria-controls={`${folderId}-form`} disabled={!binding} onClick={() => setNewFolderOpen(value => !value)}><FiFolderPlus aria-hidden="true" /></button>}
          </header>
          {!binding && !resolveError && <p className="image-upload-empty" role="status"><FiLoader className="image-upload-spin" aria-hidden="true" />Opening folders…</p>}
          {binding && <>
            <div className="image-upload-location">
              <span className="image-upload-project" title={binding.root}>{rootName}</span>
              <p className="image-upload-breadcrumb" title={binding.root ? `${binding.root}${directory ? `/${directory}` : ""}` : directory}>{directory || "/"}</p>
              {(stagedFolder || folderCreated) && <span className="image-upload-badge" title={folderCreated ? "Folder created" : "Created when you upload"}>{folderCreated ? <FiCheck aria-hidden="true" /> : <FiFolderPlus aria-hidden="true" />}{folderCreated ? "Created" : "New folder"}</span>}
              {started && <span className="image-upload-badge">Locked</span>}
            </div>
            {!started && newFolderOpen && <div id={`${folderId}-form`} className="image-upload-new-folder">
              <label className="image-upload-sr-only" htmlFor={folderId}>New folder in the selected destination</label>
              <input id={folderId} value={folderName} autoFocus placeholder="Folder name" title="Folder name or nested path, e.g. screenshots/review" onChange={event => setFolderName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); stageFolder(); } }} />
              <button type="button" className="icon-button" disabled={!folderName} aria-label="Use new folder" title="Use new folder" onClick={stageFolder}><FiCheck aria-hidden="true" /></button>
              <button type="button" className="icon-button" aria-label="Cancel new folder" title="Cancel new folder" onClick={() => { setNewFolderOpen(false); setFolderName(""); }}><FiX aria-hidden="true" /></button>
            </div>}
            <ImageUploadDirectoryPicker binding={binding} selected={directory} onSelect={chooseDirectory} onAvailability={setDirectoryReady} disabled={started || busy} refresh={refresh} />
          </>}
        </section>
      </div>
      {notice && <div className="image-upload-alert" role="alert"><FiAlertCircle aria-hidden="true" /><p>{notice}</p></div>}
      {closeWarning && <div className="image-upload-alert image-upload-close-warning" role="alert">
        <FiAlertCircle aria-hidden="true" /><div><p>Saved files and folders will remain. An in-flight upload may still finish; check the destination before uploading it again.</p>
          <div className="image-upload-actions"><button type="button" className="image-upload-secondary" onClick={() => setCloseWarning(false)}>Keep open</button><button type="button" className="image-upload-secondary" onClick={stopAndClose}>Stop and close</button></div>
        </div>
      </div>}
      <details className="image-upload-help">
        <summary><FiInfo aria-hidden="true" />Upload details<FiChevronDown aria-hidden="true" /></summary>
        <div><p>Static PNG, JPEG, WebP · 16 images · 10 MiB each. Keep the original format when renaming.</p><p>All images go to the selected folder. Files and new folders are written only after Upload; existing files are never replaced. Removing a reference does not delete a project file.</p></div>
      </details>
    </div>
    <footer className="image-upload-footer">
      <div className="image-upload-progress" role="status" aria-live="polite">{busy ? <><FiLoader className="image-upload-spin" aria-hidden="true" /><span>{progress}</span></> : retained > 0 ? <><FiCheckCircle aria-hidden="true" /><span>{retained} saved</span></> : <span>{invalid || batchError ? "Check selected images" : `${pending.length} ready`}</span>}</div>
      <div className="image-upload-actions">
        <button type="button" className="image-upload-secondary" onClick={dismiss}>{busy ? "Stop…" : started ? "Close" : "Cancel"}</button>
        <button type="button" className="primary-button" disabled={!binding || !directoryReady || busy || !pending.length || !!batchError || invalid}
          onClick={() => void run(pending)}><FiUpload aria-hidden="true" />{started ? "Retry remaining" : "Upload"}{pending.length > 0 && <span className="image-upload-button-count">{pending.length}</span>}</button>
      </div>
    </footer>
  </ShellDialog>;
}

function ImageUploadFileRow({ row, busy, onRename, onRemove, onSkip, onRetry, onCheck }: {
  row: UploadRow; busy: boolean; onRename: (name: string) => void; onRemove: () => void;
  onSkip: () => void; onRetry: () => void; onCheck: () => void;
}) {
  const [preview, setPreview] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const nameId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (row.file.size > IMAGE_UPLOAD_LIMITS.imageBytes || !row.file.size
      || !["image/png", "image/jpeg", "image/webp"].includes(row.file.type || imageUploadMimeType(row.file.name) || "")) return;
    const url = URL.createObjectURL(row.file); setPreview(url);
    return () => { URL.revokeObjectURL(url); };
  }, [row.file]);
  const validation = validateImageUploadFile(row.file, row.name);
  const settled = row.status === "uploaded" || row.status === "skipped";
  const editable = !busy && !settled && row.status !== "unknown";
  const status = row.status === "uploaded" ? "Saved" : row.status === "skipped" ? "Skipped" : row.status === "uploading" ? "Uploading" : row.status === "unknown" ? "Unconfirmed" : row.status === "failed" ? "Failed" : null;
  return <li className={`image-upload-file is-${row.status}`}>
    {!previewFailed && (row.receipt || preview) ? <img className="image-upload-thumbnail" src={row.receipt ? imageUploadContentUrl(row.receipt) : preview} alt="" onError={() => setPreviewFailed(true)} /> : <span className="image-upload-thumbnail image-upload-placeholder" aria-hidden="true"><FiImage /></span>}
    <div className="image-upload-file-details">
      <label className="image-upload-sr-only" htmlFor={nameId}>Filename for {row.file.name}</label>
      <div className="image-upload-filename"><input ref={nameInput} id={nameId} title={row.receipt?.path ?? row.name} value={row.name} disabled={!editable} onChange={event => onRename(event.target.value)} />
        {editable && <button type="button" className="icon-button" aria-label={`Rename ${row.name}`} title="Rename" onClick={() => { nameInput.current?.focus(); nameInput.current?.select(); }}><FiEdit2 aria-hidden="true" /></button>}
      </div>
      <div className="image-upload-file-meta"><span>{bytesLabel(row.file.size)}</span>{status && <span className={`image-upload-badge image-upload-status-${row.status}`}>{row.status === "uploaded" && <FiCheck aria-hidden="true" />}{row.status === "uploading" && <FiLoader className="image-upload-spin" aria-hidden="true" />}{status}</span>}</div>
      {!settled && (validation || row.error) && <p className="image-upload-file-error" role="alert">{validation || row.error}</p>}
      {row.suggestedFilename && editable && <button type="button" className="image-upload-text-action" onClick={() => onRename(row.suggestedFilename!)}>Use {row.suggestedFilename}</button>}
    </div>
    <div className="image-upload-file-actions">
      {(row.status === "failed" || row.status === "unknown") && <button type="button" className="icon-button" disabled={busy || !!validation} aria-label={`Retry ${row.name}`} title="Retry upload" onClick={onRetry}><FiRotateCw aria-hidden="true" /></button>}
      {row.status === "unknown" && <button type="button" className="icon-button" disabled={busy} aria-label={`Check upload status for ${row.name}`} title="Check status" onClick={onCheck}><FiSearch aria-hidden="true" /></button>}
      {!settled && <button type="button" className="icon-button" disabled={busy} aria-label={`${row.status === "ready" ? "Remove" : "Skip"} ${row.name}`} title={row.status === "ready" ? "Remove" : "Skip — does not delete an uploaded file"} onClick={row.status === "ready" ? onRemove : onSkip}><FiX aria-hidden="true" /></button>}
    </div>
  </li>;
}
