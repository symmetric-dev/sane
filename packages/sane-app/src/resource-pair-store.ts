import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord, exact } from "./app-store";
import { BrowserPairStore } from "./browser-pair-store";
import { isPairLinkedSnapshot, isPairSnapshot, isPairTarget, isPairWrite, MAX_PAIR_SESSIONS, MAX_PAIR_TARGETS, pairTargetKey, samePairSession, type PairLink, type PairLinkedSnapshot, type PairSnapshot, type PairTarget, type PairWrite } from "../shared/resource-pair-contract";

export class ResourcePairError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const FILE = "resource-pairs.json", MAX_BYTES = 16 * 1024 * 1024;

/** File-only overlay. Browser links always use the original store, including its
 * persisted revisions. Empty rows are tombstones; no migration or auto-cleanup. */
export class ResourcePairStore {
  private targets = new Map<string, PairSnapshot>();
  private failed = false;
  private readonly rootIdentity: { dev: number; ino: number };
  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly browserPairs: BrowserPairStore, private readonly failClosed: (error: unknown) => void) {
    try {
      const root = lstatSync(dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataDir) !== dataDir || root.uid !== process.getuid?.() || (root.mode & 0o022)) throw new Error("Unsafe resource pairing directory");
      this.rootIdentity = { dev: root.dev, ino: root.ino };
      const path = join(dataDir, FILE);
      let info;
      try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe resource pairing record");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_BYTES || opened.uid !== process.getuid?.() || (opened.mode & 0o077)) throw new Error("Resource pairing record changed");
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        if (used !== opened.size) throw new Error("Resource pairing record changed");
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        exact(value, ["version", "storeId", "targets"]);
        if (value.version !== 1 || value.storeId !== storeId || !Array.isArray(value.targets) || value.targets.length > MAX_PAIR_TARGETS) throw new Error("Invalid resource pairing record");
        for (const snapshot of value.targets) {
          if (!isPairSnapshot(snapshot) || snapshot.target.kind !== "file" || snapshot.storeId !== storeId || snapshot.revision < 1 || this.targets.has(pairTargetKey(snapshot.target))) throw new Error("Invalid or duplicate resource pairing target");
          this.targets.set(pairTargetKey(snapshot.target), snapshot);
        }
        const after = fstatSync(fd), current = lstatSync(path);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1 || current.isSymbolicLink()) throw new Error("Resource pairing record changed");
      } finally { closeSync(fd); }
    } catch (error) { throw new ResourcePairError(503, "resource-pair-storage", `Resource pairing storage unavailable or corrupt: ${error instanceof Error ? error.message : "invalid record"}`); }
  }
  read(target: PairTarget): PairSnapshot {
    if (this.failed) throw new ResourcePairError(503, "resource-pair-storage", "Resource pairing storage is unavailable");
    if (!isPairTarget(target)) throw new ResourcePairError(400, "resource-pair-input", "Invalid resource identity");
    if (target.kind === "browser") {
      const snapshot = this.browserPairs.read({ workspaceId: target.workspaceId, tabId: target.tabId });
      return { version: 1, storeId: snapshot.storeId, target: { ...target }, revision: snapshot.revision, sessions: snapshot.sessions };
    }
    return structuredClone(this.targets.get(pairTargetKey(target)) ?? { version: 1, storeId: this.storeId, target, revision: 0, sessions: [] });
  }
  /** No writes, recency updates, migration or grants. Match the complete native
   * conversation identity, never just its App session ID. */
  listForSession(input: Omit<PairLinkedSnapshot, "version" | "targets">): PairLinkedSnapshot {
    if (this.failed) throw new ResourcePairError(503, "resource-pair-storage", "Resource pairing storage is unavailable");
    if (!isPairLinkedSnapshot({ ...input, version: 1, targets: [] })) throw new ResourcePairError(400, "resource-pair-input", "Invalid resource pairing discovery identity");
    if (input.storeId !== this.storeId) throw new ResourcePairError(409, "resource-pair-store", "The App store changed; reconnect before pairing");
    const targets: PairSnapshot[] = input.kind === "browser"
      ? this.browserPairs.listForSession(input.workspaceId, input.session).map(snapshot => ({ version: 1, storeId: snapshot.storeId,
        target: { kind: "browser", workspaceId: snapshot.workspaceId, tabId: snapshot.tabId }, revision: snapshot.revision, sessions: snapshot.sessions }))
      : [...this.targets.values()].filter(snapshot => snapshot.target.kind === "file" && snapshot.target.workspaceId === input.workspaceId
        && snapshot.target.worktreeId === input.worktreeId && snapshot.sessions.some(link => samePairSession(link, input.session)));
    return structuredClone({ ...input, version: 1, targets });
  }
  write(input: PairWrite, assertCurrent: () => void): PairSnapshot {
    if (!isPairWrite(input)) throw new ResourcePairError(400, "resource-pair-input", "Invalid resource pairing operation");
    if (this.failed) throw new ResourcePairError(503, "resource-pair-storage", "Resource pairing storage is unavailable");
    if (input.storeId !== this.storeId) throw new ResourcePairError(409, "resource-pair-store", "The App store changed; reconnect before pairing");
    if (input.target.kind === "browser") {
      const { target, ...operation } = input;
      const snapshot = this.browserPairs.write({ ...operation, workspaceId: target.workspaceId, tabId: target.tabId }, assertCurrent);
      return { version: 1, storeId: snapshot.storeId, target: { ...target }, revision: snapshot.revision, sessions: snapshot.sessions };
    }
    const before = this.read(input.target);
    if (input.expectedRevision !== before.revision) throw new ResourcePairError(409, "resource-pair-conflict", "Paired sessions changed. Close this dialog and connect again to review the current links.");
    let sessions: PairLink[];
    if (input.operation === "clear") sessions = [];
    else {
      const session = input.session, existing = before.sessions.find(link => link.sessionId === session.sessionId);
      if (existing && !samePairSession(existing, session)) throw new ResourcePairError(409, "resource-pair-identity", "The linked conversation identity changed; it cannot be silently retargeted");
      let latest = 0;
      for (const snapshot of this.targets.values()) for (const link of snapshot.sessions) latest = Math.max(latest, Date.parse(link.lastPairedAt ?? link.linkedAt));
      const timestamp = Math.max(Date.now(), latest + 1);
      if (!Number.isFinite(new Date(timestamp).getTime())) throw new ResourcePairError(429, "resource-pair-limit", "Resource pairing timestamp limit reached");
      const lastPairedAt = new Date(timestamp).toISOString();
      const link = { ...(existing ?? { ...session, linkedAt: lastPairedAt }), lastPairedAt };
      sessions = input.operation === "remove" ? before.sessions.filter(item => item.sessionId !== session.sessionId)
        : input.operation === "replace" ? [link] : existing ? before.sessions.map(item => item.sessionId === link.sessionId ? link : item) : [...before.sessions, link];
    }
    assertCurrent();
    if (JSON.stringify(sessions) === JSON.stringify(before.sessions)) return before;
    if (sessions.length > MAX_PAIR_SESSIONS || !Number.isSafeInteger(before.revision + 1)) throw new ResourcePairError(429, "resource-pair-limit", "Resource pairing limit reached");
    const next: PairSnapshot = { version: 1, storeId: this.storeId, target: { ...input.target }, revision: before.revision + 1, sessions };
    const targets = new Map(this.targets); targets.set(pairTargetKey(input.target), next);
    const record = { version: 1, storeId: this.storeId, targets: [...targets.values()] };
    if (targets.size > MAX_PAIR_TARGETS || Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new ResourcePairError(429, "resource-pair-limit", "Resource pairing storage limit reached");
    try {
      const root = lstatSync(this.dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino || root.uid !== process.getuid?.() || (root.mode & 0o022) || realpathSync(this.dataDir) !== this.dataDir) throw new Error("Resource pairing directory changed");
      atomicAppRecord(this.dataDir, FILE, record);
    } catch (error) {
      this.failed = true; this.failClosed(error);
      throw new ResourcePairError(503, "resource-pair-storage", "Pairing commit was not confirmed; check stored links before trying again");
    }
    this.targets = targets;
    return structuredClone(next);
  }
}
