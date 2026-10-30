import { constants, closeSync, fstatSync, fsyncSync, fchmodSync, readSync, writeSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_IMAGE_UPLOAD_DIRECTORY, IMAGE_UPLOAD_LIMITS as LIMITS, imageUploadMimeType,
  isImageUploadDirectory, isImageUploadFilename, isImageUploadRequestId, isImageUploadScopeId,
  type ImageUploadReceipt,
} from "../shared/image-upload-contract";
import { WorkspaceError, workspaceOperationCheck, workspaceOperationWait, type WorkspaceService, type WorkspaceOperationOptions } from "./workspace";
import { loadImageUploadFs } from "./image-upload-fs";
import { ImageUploadStore, imageUploadStorageKey } from "./image-upload-store";
import { validateMedia } from "./media-share-format";
import { ExclusiveRenameError, loadExclusiveMove } from "./workspace-safe-rename";
import { loadImageUploadAclGuard } from "./image-upload-acl";

export interface ImageUploadScope { workspaceId: string; worktreeId: string; bindingRevision: string }
export interface ImageUploadOperation { signal: AbortSignal; assertCurrent(): void }
const inFlight = new Set<string>();
let active = 0;
const fail = (status: number, code: string, message: string): never => { throw new WorkspaceError(status, code, message); };
const uncertain = (): never => fail(409, "image-upload-uncertain", "This upload may have committed. Inspect the repository before continuing; do not retry with a new request ID");

/** Uploads are normal files. No session, native/model attachment, Git staging,
 * ignore mutation or private blob URL is involved. */
export class ImageUploadService {
  private storage?: Promise<ImageUploadStore>;
  constructor(private dataDir: string, private worktrees: WorkspaceService) {}
  private store(): Promise<ImageUploadStore> {
    return this.storage ??= Promise.all([loadImageUploadFs(), loadExclusiveMove(), loadImageUploadAclGuard()])
      .then(([fs, publish, assertAcl]) => new ImageUploadStore(this.dataDir, fs, publish, assertAcl));
  }
  private scope(scope: ImageUploadScope): string {
    if (![scope.workspaceId, scope.worktreeId, scope.bindingRevision].every(isImageUploadScopeId)) fail(400, "image-upload-binding", "Resolve the exact worktree binding before uploading");
    return `${scope.workspaceId}/${scope.worktreeId}`;
  }
  private controls(operation: ImageUploadOperation): { options: WorkspaceOperationOptions; check: () => void } {
    const options = { signal: operation.signal, deadline: Date.now() + LIMITS.uploadMs };
    return { options, check: () => { workspaceOperationCheck(options); operation.assertCurrent(); } };
  }
  private async bind(scope: ImageUploadScope, operation: ImageUploadOperation, options: WorkspaceOperationOptions): Promise<void> {
    const key = this.scope(scope); operation.assertCurrent();
    const value = await workspaceOperationWait(() => this.worktrees.resolve(key, options), options);
    workspaceOperationCheck(options); operation.assertCurrent();
    if (value.workspaceId !== scope.bindingRevision) fail(409, "workspace-changed", "The worktree binding changed; choose the destination again");
  }
  private async body(request: Request, options: WorkspaceOperationOptions, check: () => void): Promise<Buffer> {
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.imageBytes)) fail(413, "image-upload-size", "Each image must be at most 10 MiB");
    if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") fail(415, "image-upload-encoding", "Send raw image bytes without content encoding");
    if (!request.body) return fail(400, "image-upload-empty", "Choose a nonempty image");
    const reader = request.body.getReader(), chunks: Buffer[] = []; let used = 0, complete = false;
    try {
      while (true) {
        check(); const next = await workspaceOperationWait(() => reader.read(), options); check();
        if (next.done) { complete = true; break; }
        used += next.value.byteLength;
        if (used > LIMITS.imageBytes) fail(413, "image-upload-size", "Each image must be at most 10 MiB");
        chunks.push(Buffer.from(next.value));
      }
      if (!used) fail(400, "image-upload-empty", "Choose a nonempty image");
      if (length !== null && Number(length) !== used) fail(400, "image-upload-size", "The image body length did not match");
      return Buffer.concat(chunks, used);
    } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  /** Validation uses the existing static PNG/JPEG/WebP parser on a private
   * temporary file outside the repo. No repo mkdir precedes this validation. */
  private async validate(store: ImageUploadStore, bytes: Buffer, name: string, check: () => void): Promise<void> {
    const temporary = `.stage-${randomUUID()}`, fs = await loadImageUploadFs();
    check();
    // Retain ownership before withRoot's final guard; if that guard rejects,
    // the finally below must still close the native-created descriptor.
    let file = -1;
    try {
      store.withRoot((fd, guard) => { guard(); check(); file = fs.openAt(fd, temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); });
      let at = 0;
      while (at < bytes.length) { check(); const n = writeSync(file, bytes, at, bytes.length - at, at); if (!n) throw new Error("Short validation write"); at += n; }
      check(); store.withRoot(() => {});
      // validateMedia only uses positional read(). Keep the native-opened fd
      // pinned rather than reopening its pathname to obtain a FileHandle.
      const handle = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        check(); return { bytesRead: readSync(file, buffer, offset, length, position), buffer };
      } } as FileHandle;
      try {
        const format = await validateMedia(handle, bytes.length, name, check);
        if (format.kind !== "image" || format.mimeType !== imageUploadMimeType(name)) fail(415, "image-upload-format", "Only static PNG, JPEG and WebP images are supported");
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        fail(415, "image-upload-format", "The image is invalid or unsupported. Use a static PNG, JPEG or WebP within the image limits");
      }
      check();
    } finally {
      if (file >= 0) try { store.withRoot(fd => {
        const verify = fs.openAt(fd, temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(file), current = fstatSync(verify);
          if (opened.dev === current.dev && opened.ino === current.ino && current.isFile() && current.nlink === 1) fs.unlinkAt(fd, temporary);
        } finally { closeSync(verify); }
      }); } finally { closeSync(file); }
    }
  }
  async upload(scope: ImageUploadScope, input: { directory?: string; filename: string; requestId: string }, request: Request, operation: ImageUploadOperation): Promise<ImageUploadReceipt> {
    const key = this.scope(scope), directory = input.directory === undefined ? DEFAULT_IMAGE_UPLOAD_DIRECTORY : input.directory;
    if (!isImageUploadDirectory(directory) || !isImageUploadFilename(input.filename) || (directory ? `${directory}/${input.filename}` : input.filename).length > 4096) fail(400, "image-upload-path", "Use an exact safe folder and PNG, JPEG or WebP basename");
    if (!isImageUploadRequestId(input.requestId)) fail(400, "image-upload-request-id", "Supply a UUID request ID for recovery");
    const uploadId = input.requestId.toLowerCase(), storageKey = imageUploadStorageKey(scope.workspaceId, scope.worktreeId, uploadId);
    const { options, check } = this.controls(operation); check();
    if (active >= LIMITS.concurrent) fail(429, "image-upload-busy", "Two image operations are already active; retry shortly with the same request ID");
    if (inFlight.has(storageKey)) fail(409, "image-upload-in-progress", "This request is still uploading; recover using the same request ID");
    active++; inFlight.add(storageKey);
    try {
      await this.bind(scope, operation, options); check();
      const bytes = await this.body(request, options, check), sha256 = createHash("sha256").update(bytes).digest("hex");
      const receipt: ImageUploadReceipt = { version: 1, uploadId, workspaceId: scope.workspaceId, worktreeId: scope.worktreeId, bindingRevision: scope.bindingRevision, directory, path: directory ? `${directory}/${input.filename}` : input.filename, name: input.filename, mimeType: imageUploadMimeType(input.filename)!, bytes: bytes.length, sha256 };
      const store = await this.store(); check();
      const previous = store.lookup(storageKey);
      if (previous.intent) {
        if (JSON.stringify(previous.intent) !== JSON.stringify(receipt)) fail(409, "image-upload-request-conflict", "This request ID already belongs to different bytes, destination or binding");
        await this.bind(scope, operation, options); check();
        if (!previous.receipt) return uncertain();
        return previous.receipt;
      }
      await this.validate(store, bytes, input.filename, check); check();
      const publish = await loadExclusiveMove(); check();
      // After submission, stage on the destination filesystem in a private
      // directory. Other OS users cannot substitute the verified source name.
      // Same-UID processes (and root) remain trusted, as for App storage itself.
      await this.worktrees.imageUploadDirectory(key, scope.bindingRevision, directory, directory === DEFAULT_IMAGE_UPLOAD_DIRECTORY, options, check, target => {
        target.check();
        let existing: number | undefined;
        try { existing = target.fs.openAt(target.fd, input.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (["ELOOP", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) fail(409, "image-upload-exists", "That filename already exists or is unsafe; rename or skip this image");
          throw error;
        } }
        if (existing !== undefined) { closeSync(existing); fail(409, "image-upload-exists", "That filename already exists; rename or skip this image"); }
        const temporary = `.image-upload-${randomUUID()}.stage`, sourceName = "image";
        target.fs.mkdirAt(target.fd, temporary, 0o700);
        let stage: number | undefined, stageInfo: Stats | undefined, file: number | undefined, committed = false;
        const stageCheck = (authority = true) => {
          if (authority) target.check();
          if (stage === undefined || !stageInfo) uncertain();
          const opened = fstatSync(stage!);
          if (!opened.isDirectory() || opened.dev !== stageInfo!.dev || opened.ino !== stageInfo!.ino || opened.uid !== process.getuid?.() || (opened.mode & 0o7777) !== 0o700) uncertain();
          const linked = target.fs.openAt(target.fd, temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const current = fstatSync(linked);
            if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino || current.uid !== opened.uid || (current.mode & 0o7777) !== 0o700) uncertain();
          } finally { closeSync(linked); }
        };
        try {
          stage = target.fs.openAt(target.fd, temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          stageInfo = fstatSync(stage); stageCheck();
          file = target.fs.openAt(stage, sourceName, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
          // Preserve the public file mode independently of a restrictive umask;
          // its containing directory remains 0700 until exclusive publication.
          fchmodSync(file, 0o644); stageCheck();
          let at = 0;
          while (at < bytes.length) { check(); const n = writeSync(file, bytes, at, bytes.length - at, at); if (!n) throw new Error("Short image write"); at += n; }
          fsyncSync(file); fsyncSync(stage); stageCheck();
          const info = fstatSync(file);
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o644 || info.nlink !== 1 || info.size !== bytes.length) uncertain();
          const verify = target.fs.openAt(stage, sourceName, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const current = fstatSync(verify);
            if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.length || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1) uncertain();
            stageCheck(); store.write(storageKey, "intent", receipt); stageCheck();
            // Rehash the actual private source after intent persistence, keeping
            // both its validated fd and the private parent pinned through move.
            const digest = createHash("sha256"), chunk = Buffer.alloc(64 * 1024); let at = 0;
            while (at < bytes.length) {
              check(); const n = readSync(verify, chunk, 0, Math.min(chunk.length, bytes.length - at), at);
              if (!n) uncertain(); digest.update(chunk.subarray(0, n)); at += n;
            }
            const after = fstatSync(verify);
            if (digest.digest("hex") !== receipt.sha256 || after.nlink !== 1 || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) uncertain();
            stageCheck();
            const source = target.fs.openAt(stage, sourceName, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const linked = fstatSync(source), opened = fstatSync(file);
              if (linked.dev !== info.dev || linked.ino !== info.ino || linked.nlink !== 1 || opened.nlink !== 1 || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs) uncertain();
              stageCheck();
              try { publish(stage, sourceName, target.fd, input.filename); committed = true; }
              catch (error) {
                if (error instanceof ExclusiveRenameError && error.code === "path-exists") fail(409, "image-upload-exists", "That filename was just created; rename or skip this image");
                throw error;
              }
            } finally { closeSync(source); }
            fsyncSync(stage); fsyncSync(target.fd); stageCheck();
            const published = target.fs.openAt(target.fd, input.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const current = fstatSync(published), opened = fstatSync(file);
              if (!current.isFile() || current.nlink !== 1 || opened.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs || (current.mode & 0o7777) !== 0o644 || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs) uncertain();
            } finally { closeSync(published); }
            stageCheck();
            // No await between the publication and durable completion record.
            store.write(storageKey, "receipt", receipt); stageCheck();
          } finally { closeSync(verify); }
        } finally {
          try {
            if (stage !== undefined && stageInfo) {
              // Cleanup uses inode/ownership checks, not authorization: a
              // cancelled request must still remove only its own temporary.
              stageCheck(false);
              if (!committed && file !== undefined) {
                const verify = target.fs.openAt(stage, sourceName, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                  const owned = fstatSync(file), current = fstatSync(verify);
                  if (owned.dev !== current.dev || owned.ino !== current.ino || !current.isFile() || current.nlink !== 1) uncertain();
                  target.fs.unlinkAt(stage, sourceName);
                } finally { closeSync(verify); }
              }
              stageCheck(false); target.fs.unlinkDirectoryAt(target.fd, temporary); fsyncSync(target.fd);
            }
          } finally {
            try { if (file !== undefined) closeSync(file); }
            finally { if (stage !== undefined) closeSync(stage); }
          }
        }
      });
      // Read the actual current repo file, not the private validation buffer.
      await this.verifyContent(receipt, operation, options); check();
      check(); return receipt;
    } finally { inFlight.delete(storageKey); active--; }
  }
  private async verifyContent(receipt: ImageUploadReceipt, operation: ImageUploadOperation, options: WorkspaceOperationOptions): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const check = () => { workspaceOperationCheck(options); operation.assertCurrent(); };
    check();
    let captured: { bytes: number; sha256: string };
    try {
      captured = await this.worktrees.captureMedia(this.scope(receipt), receipt.bindingRevision, receipt.path, LIMITS.imageBytes, async chunk => { check(); chunks.push(Buffer.from(chunk)); }, options);
    } catch (error) {
      if (error instanceof WorkspaceError && ["media-size", "not-file", "file-changed", "hardlink", "symlink"].includes(error.code)) return fail(409, "image-upload-changed", "The uploaded repository image was changed or replaced; its preview is no longer available");
      throw error;
    }
    check();
    if (captured.bytes !== receipt.bytes || captured.sha256 !== receipt.sha256) fail(409, "image-upload-changed", "The uploaded repository image has changed; its preview is no longer available");
    await this.bind(receipt, operation, options); check(); return Buffer.concat(chunks, receipt.bytes);
  }
  async receipt(scope: ImageUploadScope, uploadId: string, operation: ImageUploadOperation): Promise<ImageUploadReceipt> {
    this.scope(scope);
    if (!isImageUploadRequestId(uploadId)) fail(400, "image-upload-request-id", "Use the upload request UUID");
    const { options, check } = this.controls(operation); check();
    await this.bind(scope, operation, options);
    const store = await this.store(); check();
    const saved = store.lookup(imageUploadStorageKey(scope.workspaceId, scope.worktreeId, uploadId));
    if (!saved.intent) return fail(404, "image-upload-not-found", "No image upload receipt was found");
    if (saved.intent.bindingRevision !== scope.bindingRevision) fail(409, "workspace-changed", "This receipt belongs to a different worktree binding");
    await this.bind(scope, operation, options); check();
    if (!saved.receipt) return uncertain(); return saved.receipt;
  }
  async content(scope: ImageUploadScope, uploadId: string, operation: ImageUploadOperation): Promise<{ receipt: ImageUploadReceipt; bytes: Buffer }> {
    if (active >= LIMITS.concurrent) fail(429, "image-upload-busy", "Two image operations are already active; retry shortly");
    active++;
    try {
      const { options, check } = this.controls(operation);
      const receipt = await this.receipt(scope, uploadId, operation); check();
      const bytes = await this.verifyContent(receipt, operation, options); check();
      return { receipt, bytes };
    } finally { active--; }
  }
  async createDirectory(scope: ImageUploadScope, path: string, operation: ImageUploadOperation): Promise<{ path: string; bindingRevision: string }> {
    const key = this.scope(scope);
    if (!isImageUploadDirectory(path) || !path) fail(400, "image-upload-directory", "Specify a new nonempty repository-relative folder; root is an existing choice");
    const { options, check } = this.controls(operation); check();
    if (active >= LIMITS.concurrent) fail(429, "image-upload-busy", "Two image operations are already active; retry shortly");
    active++;
    try {
      await this.worktrees.imageUploadDirectory(key, scope.bindingRevision, path, true, options, check, directory => { directory.check(); fsyncSync(directory.fd); });
      check(); return { path, bindingRevision: scope.bindingRevision };
    } finally { active--; }
  }
}
