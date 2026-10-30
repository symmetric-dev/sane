import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, writeSync, chmodSync, rmSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJSON } from "./prepared-input-codec";
import { exact } from "./app-store-format";
import { MEDIA_SHARE_LIMITS as LIMITS, isMediaShareRecord, type MediaShareRecord, type MediaShareItem, type NativeMediaShareRequest } from "../shared/media-share-contract";
import { validateMedia, mediaFormat } from "./media-share-format";

export class MediaShareError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const META_BYTES = 256 * 1024, HEX = /^[a-f0-9]{64}$/;
const identity = (value: Pick<MediaShareRecord, "sessionId" | "native" | "anchor">) => canonicalJSON([value.sessionId, value.native, value.anchor.toolCallId, value.anchor.messageId, value.anchor.invocationId, value.anchor.wrapper]);
export const mediaShareKey = (sessionId: string, request: NativeMediaShareRequest) => identity({ sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId }, anchor: { runId: "", toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null } });
export const mediaShareId = (key: string) => createHash("sha256").update(key).digest("hex");
const itemId = (shareId: string, index: number, item: Pick<MediaShareItem, "path" | "sha256">) => mediaShareId(canonicalJSON([shareId, index, item.path, item.sha256]));
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink && a.mode === b.mode && a.uid === b.uid;
function owned(info: Stats, directory = false) {
  const mode = info.mode & 0o7777;
  if (info.uid !== process.getuid?.() || info.isSymbolicLink() || (directory ? !info.isDirectory() || ![0o700, 0o500].includes(mode) : !info.isFile() || info.nlink !== 1 || mode !== 0o400)) throw new Error("Unsafe media snapshot ownership, type or mode");
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directoryNames(path: string, maximum: number): string[] {
  const dir = opendirSync(path), names: string[] = [];
  try { let entry; while ((entry = dir.readSync())) { if (names.length >= maximum) throw new Error("Media directory entry limit exceeded"); names.push(entry.name); } }
  finally { dir.closeSync(); }
  return names;
}
function writePrivate(path: string, bytes: Buffer) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at, at); if (!n) throw new Error("Short snapshot write"); at += n; } fsyncSync(fd); }
  finally { closeSync(fd); }
}
/** Small metadata only. Large blobs are always hashed using a fixed chunk. */
function checkedFile(path: string, maximum: number, collect: boolean) {
  const before = lstatSync(path); owned(before);
  if (before.size > maximum) throw new Error("Oversize media snapshot");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); owned(opened); if (!same(before, opened)) throw new Error("Media snapshot changed while opening");
    const digest = createHash("sha256"), chunk = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
    let at = 0;
    while (at < opened.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - at), at);
      if (!n) throw new Error("Truncated media snapshot");
      digest.update(chunk.subarray(0, n)); if (collect) chunks.push(Buffer.from(chunk.subarray(0, n))); at += n;
    }
    if (!same(opened, fstatSync(fd)) || !same(opened, lstatSync(path))) throw new Error("Media snapshot changed while reading");
    return { info: opened, sha256: digest.digest("hex"), bytes: collect ? Buffer.concat(chunks) : Buffer.alloc(0) };
  } finally { closeSync(fd); }
}
type Saved = { record: MediaShareRecord; directory: Stats; metadata: Stats; metadataHash: string; blobs: Stats[]; diskBytes: number };
type Reservation = { sessionId: string; id: string; path: string; directory: Stats; bytes: number; mediaBytes: number; committed: boolean };

/** Installation/data ownership is held by the App. A share is ONE directory
 * transaction, not a mutable ledger plus independently published blob files.
 * Interrupted/unknown staging is intentionally a startup reconciliation error. */
export class MediaShareStore {
  private readonly root: string;
  private dataIdentity!: Stats;
  private rootIdentity!: Stats;
  private marker!: Stats;
  private markerHash = "";
  private failed = false;
  private readonly shares = new Map<string, Saved>();
  private readonly reservations = new Set<Reservation>();
  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly failClosed: (error: unknown) => void) {
    this.root = join(dataDir, "media-shares");
    try {
      this.dataIdentity = lstatSync(dataDir);
      if (!this.dataIdentity.isDirectory() || this.dataIdentity.isSymbolicLink() || this.dataIdentity.uid !== process.getuid?.() || (this.dataIdentity.mode & 0o022) || realpathSync(dataDir) !== dataDir) throw new Error("Unsafe media data directory");
      let exists = true;
      try { lstatSync(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
      if (!exists) {
        mkdirSync(this.root, { mode: 0o700 });
        writePrivate(join(this.root, "store.json"), Buffer.from(JSON.stringify({ version: 1, storeId })));
        syncDirectory(this.root); syncDirectory(dataDir);
      }
      this.rootIdentity = lstatSync(this.root); owned(this.rootIdentity, true);
      if (realpathSync(this.root) !== this.root) throw new Error("Unsafe media root");
      const marker = checkedFile(join(this.root, "store.json"), 4096, true);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(marker.bytes)); exact(parsed, ["version", "storeId"]);
      if (parsed.version !== 1 || parsed.storeId !== storeId) throw new Error("Media store identity mismatch");
      this.marker = marker.info; this.markerHash = marker.sha256;
      const names = directoryNames(this.root, LIMITS.shares + 1);
      if (names.length > LIMITS.shares + 1) throw new Error("Too many media snapshots");
      for (const name of names) {
        if (name === "store.json") continue;
        if (!HEX.test(name)) throw new Error("Uncommitted or unexpected media storage; reconciliation required");
        this.shares.set(name, this.load(name));
      }
      this.budget(); this.guard();
    } catch (error) { this.storageFailure(error); }
  }
  private storageFailure(error: unknown): never {
    this.failed = true;
    try { this.failClosed(error); } catch { /* Preserve the classified storage error. */ }
    throw new MediaShareError(503, "media-share-storage", "Media storage unavailable or uncertain; reconciliation required");
  }
  private validate(record: MediaShareRecord) {
    if (!isMediaShareRecord(record)) throw new Error("Invalid media record");
    exact(record, ["version", "id", "sessionId", "native", "anchor", "workspaceId", "worktreeId", "bindingRevision", "createdAt", "input", "media"]);
    exact(record.native, ["harness", "authorityId", "nativeId"]);
    exact(record.anchor, ["runId", "toolCallId", "messageId", "invocationId", "wrapper"]);
    exact(record.input, ["media"]);
    if (record.id !== mediaShareId(identity(record)) || record.input.media.length !== record.media.length || record.media.length < 1 || record.media.length > LIMITS.items) throw new Error("Invalid media identity");
    if (record.native.harness !== "oc" ? record.anchor.wrapper !== null || record.anchor.invocationId !== record.anchor.toolCallId : record.anchor.messageId === null || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record.anchor.invocationId)) throw new Error("Invalid media invocation");
    let total = 0;
    record.media.forEach((item, index) => {
      exact(item, ["id", "path", "kind", "mimeType", "bytes", "sha256"]); exact(record.input.media[index], ["path"]);
      const format = mediaFormat(item.path);
      if (item.path !== record.input.media[index]!.path || item.id !== itemId(record.id, index, item) || !HEX.test(item.sha256) || item.kind !== format.kind || item.mimeType !== format.mimeType || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > format.maxBytes) throw new Error("Invalid media item");
      if (item.path.split("/").some(part => [".git", ".sane"].includes(part.toLowerCase()))) throw new Error("Protected media path");
      total += item.bytes;
    });
    if (total > LIMITS.totalBytes) throw new Error("Media collection exceeds budget");
  }
  private load(id: string): Saved {
    const path = join(this.root, id), directory = lstatSync(path); owned(directory, true);
    if ((directory.mode & 0o777) !== 0o500 || realpathSync(path) !== path) throw new Error("Mutable media snapshot directory");
    const metadata = checkedFile(join(path, "record.json"), META_BYTES, true);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata.bytes)); exact(value, ["version", "storeId", "record"]);
    if (value.version !== 1 || value.storeId !== this.storeId) throw new Error("Media snapshot store mismatch");
    const record = value.record as MediaShareRecord; this.validate(record);
    if (record.id !== id) throw new Error("Media snapshot path mismatch");
    const names = directoryNames(path, LIMITS.items + 1), expected = new Set(["record.json", ...record.media.map((_, index) => `${index}.blob`)]);
    if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error("Unexpected media snapshot contents");
    const blobs = record.media.map((item, index) => {
      const blob = checkedFile(join(path, `${index}.blob`), item.bytes, false);
      if (blob.info.size !== item.bytes || blob.sha256 !== item.sha256) throw new Error("Media snapshot hash mismatch"); return blob.info;
    });
    if (!same(directory, lstatSync(path))) throw new Error("Media directory changed during load");
    return { record, directory, metadata: metadata.info, metadataHash: metadata.sha256, blobs, diskBytes: metadata.info.size + record.media.reduce((n, item) => n + item.bytes, 0) };
  }
  private guard() {
    if (this.failed) throw new MediaShareError(503, "media-share-storage", "Media storage is unavailable");
    try {
      const data = lstatSync(this.dataDir), root = lstatSync(this.root);
      if (!data.isDirectory() || data.isSymbolicLink() || data.dev !== this.dataIdentity.dev || data.ino !== this.dataIdentity.ino || data.uid !== process.getuid?.() || (data.mode & 0o022) || realpathSync(this.dataDir) !== this.dataDir) throw new Error("Media data directory changed");
      owned(root, true);
      if (root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino || realpathSync(this.root) !== this.root) throw new Error("Media root changed");
      const marker = checkedFile(join(this.root, "store.json"), 4096, true);
      if (!same(marker.info, this.marker) || marker.sha256 !== this.markerHash) throw new Error("Media store marker changed");
      const expected = new Set(["store.json", ...this.shares.keys(), ...[...this.reservations].map(r => r.path.slice(this.root.length + 1))]);
      const names = directoryNames(this.root, LIMITS.shares + LIMITS.concurrentCaptures + 1);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error("Unexpected media root contents");
    } catch (error) { this.storageFailure(error); }
  }
  private budget(extra?: { sessionId: string; bytes: number; count: number }) {
    let bytes = this.marker?.size ?? 4096, count = 0;
    const sessions = new Map<string, { bytes: number; count: number }>();
    const add = (sessionId: string, size: number, n: number) => { const s = sessions.get(sessionId) ?? { bytes: 0, count: 0 }; s.bytes += size; s.count += n; sessions.set(sessionId, s); bytes += size; count += n; };
    for (const saved of this.shares.values()) add(saved.record.sessionId, saved.diskBytes, 1);
    for (const r of this.reservations) add(r.sessionId, r.bytes, 1);
    if (extra) add(extra.sessionId, extra.bytes, extra.count);
    if (count > LIMITS.shares || bytes > LIMITS.storeBytes || [...sessions.values()].some(s => s.bytes > LIMITS.sessionBytes || s.count > LIMITS.sessionShares)) throw new MediaShareError(429, "media-share-limit", "Media snapshot storage budget reached");
  }
  private checkSaved(saved: Saved) {
    try {
      const path = join(this.root, saved.record.id), directory = lstatSync(path); owned(directory, true);
      if (!same(directory, saved.directory)) throw new Error("Media snapshot directory changed");
      const metadata = checkedFile(join(path, "record.json"), META_BYTES, true);
      if (!same(metadata.info, saved.metadata) || metadata.sha256 !== saved.metadataHash) throw new Error("Media snapshot record changed");
      saved.blobs.forEach((info, index) => { const current = lstatSync(join(path, `${index}.blob`)); owned(current); if (!same(current, info)) throw new Error("Media snapshot blob changed"); });
    } catch (error) { this.storageFailure(error); }
  }
  find(key: string): MediaShareRecord | undefined { this.guard(); const saved = this.shares.get(mediaShareId(key)); if (saved) this.checkSaved(saved); return saved && structuredClone(saved.record); }
  list(sessionId: string): MediaShareRecord[] {
    this.guard();
    const saved = [...this.shares.values()].filter(saved => saved.record.sessionId === sessionId);
    saved.forEach(share => this.checkSaved(share));
    return structuredClone(saved.map(saved => saved.record).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  }
  begin(sessionId: string, id: string): MediaShareStage {
    this.guard();
    if (!HEX.test(id) || this.shares.has(id) || [...this.reservations].some(r => r.id === id)) throw new MediaShareError(409, "media-share-conflict", "This media invocation is already being captured");
    if (this.reservations.size >= LIMITS.concurrentCaptures) throw new MediaShareError(429, "media-share-busy", "Media capture is busy; try again shortly");
    this.budget({ sessionId, bytes: META_BYTES, count: 1 });
    try {
      const path = join(this.root, `.stage-${randomBytes(24).toString("hex")}`); mkdirSync(path, { mode: 0o700 });
      const directory = lstatSync(path); owned(directory, true);
      const reservation: Reservation = { sessionId, id, path, directory, bytes: META_BYTES, mediaBytes: 0, committed: false }; this.reservations.add(reservation);
      return new MediaShareStage(this, reservation);
    } catch (error) { this.storageFailure(error); }
  }
  /** Internal staging capability; no private pathname is returned in metadata. */
  checkStage(r: Reservation) {
    this.guard();
    try { const info = lstatSync(r.path); owned(info, true); if (!this.reservations.has(r) || info.dev !== r.directory.dev || info.ino !== r.directory.ino || realpathSync(r.path) !== r.path) throw new Error("Media staging directory changed"); }
    catch (error) { this.storageFailure(error); }
  }
  reserveChunk(r: Reservation, bytes: number) {
    if (r.mediaBytes + bytes > LIMITS.totalBytes) throw new MediaShareError(413, "media-share-size", "Combined media exceeds 200 MiB");
    this.budget({ sessionId: r.sessionId, bytes, count: 0 }); r.bytes += bytes; r.mediaBytes += bytes;
  }
  commitStage(r: Reservation, record: MediaShareRecord, assertCurrent: () => void): MediaShareRecord {
    this.checkStage(r);
    this.validate(record);
    if (record.id !== r.id || record.sessionId !== r.sessionId || record.media.reduce((n, item) => n + item.bytes, 0) !== r.mediaBytes) throw new MediaShareError(400, "invalid-media-share", "Media snapshot does not match its reservation");
    const bytes = Buffer.from(JSON.stringify({ version: 1, storeId: this.storeId, record }));
    if (bytes.length > META_BYTES) throw new MediaShareError(413, "media-share-size", "Media metadata exceeds its budget");
    try {
      writePrivate(join(r.path, "record.json"), bytes);
      // Validate every actual byte and membership before publication.
      const names = directoryNames(r.path, LIMITS.items + 1), expected = new Set(["record.json", ...record.media.map((_, index) => `${index}.blob`)]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error("Invalid staged media membership");
      record.media.forEach((item, index) => { const b = checkedFile(join(r.path, `${index}.blob`), item.bytes, false); if (b.info.size !== item.bytes || b.sha256 !== item.sha256) throw new Error("Staged media mismatch"); });
      chmodSync(r.path, 0o500); syncDirectory(r.path);
      this.checkStage(r);
    } catch (error) { this.storageFailure(error); }
    // A revoked authorization is not a persistence failure; its complete but
    // unpublished directory can still be safely discarded by the owner.
    assertCurrent();
    try {
      // Synchronous rename + directory fsync: no await between the final
      // authority fence and publication. Target is absent in the guarded root.
      renameSync(r.path, join(this.root, record.id)); r.committed = true;
      syncDirectory(this.root);
      const saved = this.load(record.id);
      this.shares.set(record.id, saved); this.reservations.delete(r);
      return structuredClone(record);
    } catch (error) {
      this.storageFailure(error);
    }
  }
  async discardStage(r: Reservation) {
    if (r.committed || !this.reservations.has(r)) return;
    this.checkStage(r);
    try {
      chmodSync(r.path, 0o700);
      rmSync(r.path, { recursive: true });
      this.reservations.delete(r); syncDirectory(this.root);
    } catch (error) { this.storageFailure(error); }
  }
  /** Opens only an authenticated session/share/item membership. Hash the pinned
   * descriptor before response headers; stream consumers retain this descriptor. */
  async openContent(sessionId: string, shareId: string, requestedItemId: string, signal?: AbortSignal): Promise<{ handle: FileHandle; item: MediaShareItem; info: Stats; check(): Promise<void> } | undefined> {
    this.guard();
    if (!HEX.test(shareId) || !HEX.test(requestedItemId)) return;
    const saved = this.shares.get(shareId);
    if (!saved || saved.record.sessionId !== sessionId) return;
    const index = saved.record.media.findIndex(item => item.id === requestedItemId);
    if (index < 0) return;
    const item = saved.record.media[index]!, path = join(this.root, shareId), blobPath = join(path, `${index}.blob`);
    let handle: FileHandle | undefined;
    try {
      if (signal?.aborted) throw new MediaShareError(499, "media-share-aborted", "Media read cancelled");
      const directory = lstatSync(path); owned(directory, true); if (!same(directory, saved.directory)) throw new Error("Media share directory changed");
      const metadata = checkedFile(join(path, "record.json"), META_BYTES, true);
      if (!same(metadata.info, saved.metadata) || metadata.sha256 !== saved.metadataHash) throw new Error("Media metadata changed");
      const names = directoryNames(path, LIMITS.items + 1), expected = new Set(["record.json", ...saved.record.media.map((_, i) => `${i}.blob`)]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error("Media membership changed");
      const before = lstatSync(blobPath); owned(before); if (!same(before, saved.blobs[index]!)) throw new Error("Media blob changed");
      handle = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat(); owned(opened); if (!same(opened, before)) throw new Error("Media blob changed while opening");
      const pinned = handle;
      const check = async () => {
        try { this.guard(); if (!same(await pinned.stat(), opened) || !same(lstatSync(blobPath), opened) || !same(lstatSync(path), directory)) throw new Error("Committed media changed during read"); }
        catch (error) { this.storageFailure(error); }
      };
      const digest = createHash("sha256"), chunk = Buffer.alloc(64 * 1024); let at = 0;
      while (at < item.bytes) { if (signal?.aborted) throw new MediaShareError(499, "media-share-aborted", "Media read cancelled"); const n = await handle.read(chunk, 0, Math.min(chunk.length, item.bytes - at), at); if (!n.bytesRead) throw new Error("Truncated committed media"); digest.update(chunk.subarray(0, n.bytesRead)); at += n.bytesRead; }
      await check(); if (digest.digest("hex") !== item.sha256) throw new Error("Committed media hash mismatch");
      return { handle, item: structuredClone(item), info: opened, check };
    } catch (error) { if (handle) await handle.close(); if (error instanceof MediaShareError && error.status === 499) throw error; this.storageFailure(error); }
  }
}

/** Unpublished snapshot capability. Producer's bytes flow directly from a
 * checked workspace descriptor into an exclusive private file, never JSON. */
export class MediaShareStage {
  private readonly items: MediaShareItem[] = [];
  private readonly snapshots: Stats[] = [];
  constructor(private readonly store: MediaShareStore, private readonly reservation: Reservation) {}
  async capture(path: string, producer: (sink: (chunk: Buffer) => Promise<void>) => Promise<{ bytes: number; sha256: string }>, check: () => void): Promise<MediaShareItem> {
    const index = this.items.length, format = mediaFormat(path);
    if (index >= LIMITS.items) throw new MediaShareError(413, "media-share-size", "Too many media items");
    this.store.checkStage(this.reservation); check();
    const previous = this.items.findIndex(item => item.path === path);
    if (previous >= 0) {
      // Duplicate pages reuse the first frozen revision, even if the source was
      // deleted meanwhile. Copy, never hard-link, the private bounded snapshot.
      producer = async sink => {
        const sourcePath = join(this.reservation.path, `${previous}.blob`), source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          this.store.checkStage(this.reservation);
          const info = await source.stat(); owned(info);
          if (!same(info, this.snapshots[previous]!) || !same(info, lstatSync(sourcePath))) throw new Error("Duplicate media snapshot changed");
          let at = 0; const chunk = Buffer.alloc(64 * 1024);
          while (at < info.size) { check(); const n = await source.read(chunk, 0, Math.min(chunk.length, info.size - at), at); if (!n.bytesRead) throw new Error("Truncated duplicate snapshot"); await sink(chunk.subarray(0, n.bytesRead)); at += n.bytesRead; }
          if (!same(info, await source.stat()) || !same(info, lstatSync(sourcePath))) throw new Error("Duplicate media snapshot changed during copy");
          return { bytes: info.size, sha256: this.items[previous]!.sha256 };
        } finally { await source.close(); }
      };
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(join(this.reservation.path, `${index}.blob`), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const opened = await handle.stat(), current = lstatSync(join(this.reservation.path, `${index}.blob`));
      this.store.checkStage(this.reservation);
      if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600 || !same(opened, current)) throw new Error("Unsafe staged media descriptor");
      let bytes = 0; const digest = createHash("sha256");
      const result = await producer(async chunk => {
        check();
        if (bytes + chunk.length > format.maxBytes) throw new MediaShareError(413, "media-share-size", "Media file exceeds its size limit");
        this.store.reserveChunk(this.reservation, chunk.length);
        let used = 0;
        while (used < chunk.length) { check(); const n = await handle!.write(chunk, used, chunk.length - used, bytes + used); if (!n.bytesWritten) throw new Error("Short media snapshot write"); used += n.bytesWritten; }
        digest.update(chunk); bytes += chunk.length;
      });
      check();
      const sha256 = digest.digest("hex");
      if (result.bytes !== bytes || result.sha256 !== sha256) throw new Error("Media capture digest mismatch");
      try { await validateMedia(handle, bytes, path, check); }
      catch (error) { if (error instanceof MediaShareError) throw error; throw new MediaShareError(415, "media-share-format", error instanceof Error ? error.message : "Invalid media format"); }
      await handle.chmod(0o400); await handle.sync();
      const after = await handle.stat(), final = lstatSync(join(this.reservation.path, `${index}.blob`)); owned(after); owned(final);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes || !same(after, final)) throw new Error("Staged media file changed");
      this.store.checkStage(this.reservation); check();
      const item: MediaShareItem = { id: itemId(this.reservation.id, index, { path, sha256 }), path, kind: format.kind, mimeType: format.mimeType, bytes, sha256 };
      this.items.push(item); this.snapshots.push(after); return structuredClone(item);
    } finally { await handle?.close(); }
  }
  commit(record: MediaShareRecord, assertCurrent: () => void) {
    if (canonicalJSON(record.media) !== canonicalJSON(this.items)) throw new MediaShareError(400, "invalid-media-share", "Media item membership mismatch");
    return this.store.commitStage(this.reservation, record, assertCurrent);
  }
  discard() { return this.store.discardStage(this.reservation); }
}
