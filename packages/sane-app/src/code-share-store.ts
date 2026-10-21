import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicAppRecord, exact } from "./app-store";
import { canonicalJSON } from "./prepared-input-codec";
import { codeSharePages, isCodeShareRecord, type CodeShareRecord, type NativeCodeShareRequest } from "../shared/code-share-contract";

export class CodeShareError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const FILE = "code-shares.json", MAX_BYTES = 32 * 1024 * 1024, SESSION_BYTES = 4 * 1024 * 1024;
const identity = (value: Pick<CodeShareRecord, "sessionId" | "native" | "anchor">) => canonicalJSON([value.sessionId, value.native, value.anchor.toolCallId, value.anchor.messageId, value.anchor.invocationId, value.anchor.wrapper]);
export const codeShareKey = (sessionId: string, request: NativeCodeShareRequest) => identity({ sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId }, anchor: { runId: "", toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null } });

/** Lock-owned immutable snapshots. No checkout access is needed to recover or
 * display a committed record. Limits bound both disk loading and GET responses. */
export class CodeShareStore {
  private shares: CodeShareRecord[] = [];
  private failed = false;
  private rootIdentity: { dev: number; ino: number };
  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly failClosed: (error: unknown) => void) {
    try {
      const root = lstatSync(dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataDir) !== dataDir || root.uid !== process.getuid?.() || (root.mode & 0o022)) throw new Error("Unsafe code share directory");
      this.rootIdentity = { dev: root.dev, ino: root.ino };
      const path = join(dataDir, FILE);
      let info;
      try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe code share ledger");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_BYTES || opened.uid !== process.getuid?.() || (opened.mode & 0o077)) throw new Error("Code share ledger changed");
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        if (used !== opened.size) throw new Error("Code share ledger changed");
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        exact(value, ["version", "storeId", "shares"]);
        if (value.version !== 1 || value.storeId !== storeId || !Array.isArray(value.shares)) throw new Error("Invalid code share ledger");
        this.validate(value.shares);
        const after = fstatSync(fd), current = lstatSync(path);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1 || current.isSymbolicLink()) throw new Error("Code share ledger changed");
        this.shares = value.shares;
      } finally { closeSync(fd); }
    } catch (error) { throw new CodeShareError(503, "code-share-storage", `Code share storage unavailable or corrupt: ${error instanceof Error ? error.message : "invalid ledger"}`); }
  }
  private validate(shares: CodeShareRecord[]) {
    if (shares.length > 2000) throw new Error("Code share ledger full");
    const ids = new Set<string>(), keys = new Set<string>(), sizes = new Map<string, number>(), counts = new Map<string, number>();
    for (const share of shares) {
      if (!isCodeShareRecord(share)) throw new Error("Invalid code share record");
      exact(share, ["version", "id", "sessionId", "native", "anchor", "workspaceId", "worktreeId", "bindingRevision", "createdAt", "input", ...(share.version === 1 ? ["sourceRevision", "language", "code"] : ["snippets"])]);
      if (share.version === 2) for (const snippet of share.snippets) exact(snippet, ["sourceRevision", "language", "input", "code"]);
      exact(share.native, ["harness", "authorityId", "nativeId"]);
      exact(share.anchor, ["runId", "toolCallId", "messageId", "invocationId", "wrapper"]);
      if (codeSharePages(share).some(snippet => snippet.code.includes("\0")) || (share.native.harness === "cc"
        ? share.anchor.wrapper !== null || share.anchor.invocationId !== share.anchor.toolCallId
        : share.anchor.messageId === null || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(share.anchor.invocationId))) throw new Error("Invalid code share invocation");
      if (share.id !== codeShareId(identity(share)) || codeSharePages(share).some(snippet => !/^[a-f0-9]{64}$/.test(snippet.sourceRevision)) || ids.has(share.id) || keys.has(identity(share))) throw new Error("Conflicting code share identity");
      ids.add(share.id); keys.add(identity(share));
      const size = (sizes.get(share.sessionId) ?? 0) + Buffer.byteLength(JSON.stringify(share));
      const count = (counts.get(share.sessionId) ?? 0) + 1;
      if (size > SESSION_BYTES || count > 128) throw new Error("Conversation code share budget exceeded");
      sizes.set(share.sessionId, size); counts.set(share.sessionId, count);
    }
    if (Buffer.byteLength(JSON.stringify({ version: 1, storeId: this.storeId, shares })) > MAX_BYTES) throw new Error("Code share ledger full");
  }
  find(key: string): CodeShareRecord | undefined { const share = this.shares.find(share => identity(share) === key); return share && structuredClone(share); }
  list(sessionId: string): CodeShareRecord[] { return structuredClone(this.shares.filter(share => share.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))); }
  commit(share: CodeShareRecord, assertCurrent: () => void): CodeShareRecord {
    if (this.failed) throw new CodeShareError(503, "code-share-storage", "Code share storage is unavailable");
    const old = this.find(identity(share));
    if (old) {
      if (canonicalJSON(old.input) !== canonicalJSON(share.input)) throw new CodeShareError(409, "code-share-conflict", "This invocation already shared a different excerpt");
      assertCurrent(); return old;
    }
    const next = [...this.shares, structuredClone(share)];
    try { this.validate(next); } catch { throw new CodeShareError(429, "code-share-limit", "Code share snapshot budget reached"); }
    assertCurrent();
    try {
      const root = lstatSync(this.dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino || root.uid !== process.getuid?.() || (root.mode & 0o022) || realpathSync(this.dataDir) !== this.dataDir) throw new Error("Code share directory changed");
      atomicAppRecord(this.dataDir, FILE, { version: 1, storeId: this.storeId, shares: next });
    }
    catch (error) { this.failed = true; this.failClosed(error); throw new CodeShareError(503, "code-share-storage", "Snapshot commit failed; reconciliation required"); }
    this.shares = next;
    return structuredClone(share);
  }
}

export const codeShareId = (key: string) => createHash("sha256").update(key).digest("hex");
