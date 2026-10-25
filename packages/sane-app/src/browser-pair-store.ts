import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord, exact } from "./app-store";
import { isBrowserPairSnapshot, isBrowserPairWrite, MAX_BROWSER_PAIR_SESSIONS, sameBrowserPairSession, type BrowserPairSnapshot, type BrowserPairTarget, type BrowserPairWrite } from "../shared/browser-pair-contract";

export class BrowserPairError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const FILE = "browser-pairs.json", MAX_BYTES = 16 * 1024 * 1024, MAX_TARGETS = 5000;
const key = (target: BrowserPairTarget) => JSON.stringify([target.workspaceId, target.tabId]);

/** Optional, lock-owner-written overlay. No native calls, dispatch, observers or
 * automatic cleanup. Empty rows retain revisions to prevent stale writes (ABA). */
export class BrowserPairStore {
  private targets = new Map<string, BrowserPairSnapshot>();
  private failed = false;
  private readonly rootIdentity: { dev: number; ino: number };
  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly failClosed: (error: unknown) => void) {
    try {
      const root = lstatSync(dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataDir) !== dataDir || root.uid !== process.getuid?.() || (root.mode & 0o022)) throw new Error("Unsafe browser pairing directory");
      this.rootIdentity = { dev: root.dev, ino: root.ino };
      const path = join(dataDir, FILE);
      let info;
      try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe browser pairing record");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_BYTES || opened.uid !== process.getuid?.() || (opened.mode & 0o077)) throw new Error("Browser pairing record changed");
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        if (used !== opened.size) throw new Error("Browser pairing record changed");
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        exact(value, ["version", "storeId", "targets"]);
        if (value.version !== 1 || value.storeId !== storeId || !Array.isArray(value.targets) || value.targets.length > MAX_TARGETS) throw new Error("Invalid browser pairing record");
        for (const target of value.targets) {
          if (!isBrowserPairSnapshot(target) || target.storeId !== storeId || target.revision < 1 || this.targets.has(key(target))) throw new Error("Invalid or duplicate browser pairing target");
          this.targets.set(key(target), target);
        }
        const after = fstatSync(fd), current = lstatSync(path);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1 || current.isSymbolicLink()) throw new Error("Browser pairing record changed");
      } finally { closeSync(fd); }
    } catch (error) { throw new BrowserPairError(503, "browser-pair-storage", `Browser pairing storage unavailable or corrupt: ${error instanceof Error ? error.message : "invalid record"}`); }
  }
  read(target: BrowserPairTarget): BrowserPairSnapshot {
    if (this.failed) throw new BrowserPairError(503, "browser-pair-storage", "Browser pairing storage is unavailable");
    return structuredClone(this.targets.get(key(target)) ?? { version: 1, storeId: this.storeId, workspaceId: target.workspaceId, tabId: target.tabId, revision: 0, sessions: [] });
  }
  write(input: BrowserPairWrite, assertCurrent: () => void): BrowserPairSnapshot {
    if (!isBrowserPairWrite(input)) throw new BrowserPairError(400, "browser-pair-input", "Invalid browser pairing operation");
    if (input.storeId !== this.storeId) throw new BrowserPairError(409, "browser-pair-store", "The App store changed; reconnect before pairing");
    const before = this.read(input);
    if (input.expectedRevision !== before.revision) throw new BrowserPairError(409, "browser-pair-conflict", "Paired sessions changed. Close this dialog and connect again to review the current links.");
    const existing = before.sessions.find(link => link.sessionId === input.session.sessionId);
    if (existing && !sameBrowserPairSession(existing, input.session)) throw new BrowserPairError(409, "browser-pair-identity", "The linked conversation identity changed; it cannot be silently retargeted");
    const link = existing ?? { ...input.session, linkedAt: new Date().toISOString() };
    const sessions = input.operation === "remove" ? before.sessions.filter(item => item.sessionId !== input.session.sessionId)
      : input.operation === "replace" ? [link] : existing ? before.sessions : [...before.sessions, link];
    assertCurrent();
    if (JSON.stringify(sessions) === JSON.stringify(before.sessions)) return before;
    if (sessions.length > MAX_BROWSER_PAIR_SESSIONS || !Number.isSafeInteger(before.revision + 1)) throw new BrowserPairError(429, "browser-pair-limit", "Browser tab pairing limit reached");
    const next: BrowserPairSnapshot = { version: 1, storeId: this.storeId, workspaceId: input.workspaceId, tabId: input.tabId, revision: before.revision + 1, sessions };
    const targets = new Map(this.targets); targets.set(key(input), next);
    const record = { version: 1, storeId: this.storeId, targets: [...targets.values()] };
    if (targets.size > MAX_TARGETS || Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new BrowserPairError(429, "browser-pair-limit", "Browser pairing storage limit reached");
    try {
      const root = lstatSync(this.dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino || root.uid !== process.getuid?.() || (root.mode & 0o022) || realpathSync(this.dataDir) !== this.dataDir) throw new Error("Browser pairing directory changed");
      atomicAppRecord(this.dataDir, FILE, record);
    } catch (error) {
      this.failed = true; this.failClosed(error);
      throw new BrowserPairError(503, "browser-pair-storage", "Pairing commit was not confirmed; check stored links before trying again");
    }
    this.targets = targets;
    return structuredClone(next);
  }
}
