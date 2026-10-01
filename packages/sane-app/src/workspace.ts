import { constants } from "node:fs";
import { open, lstat, realpath, opendir, access, unlink } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep, posix } from "node:path";
import { createHash } from "node:crypto";
import type { WorkspaceSearchLeaseProvider, WorkspaceSearchLease } from "./workspace-search-scope";
import { WorkspaceIgnoreEvaluator, WorkspaceIgnoreError, validateIgnoreSnapshot } from "./workspace-ignore";
import { admitWorkspaceSearch } from "./workspace-search-admission";
import { WORKSPACE_MAX_BYTES, type Workspace, type WorkspaceList, type WorkspaceFile, type WorkspaceWrite, type WorkspaceCreate, type WorkspaceCopy, type WorkspaceDelete, type WorkspaceGit, type GitEntry, type GitComparison, type WorkspaceDiff, type DiffReason, type WorkspaceSearchInput, type WorkspaceSearch } from "./workspace-contract";
import { WORKSPACE_SEARCH_LIMITS as SEARCH, SEARCH_IGNORED_DIRECTORIES, searchPatterns, searchFilter, literalMatcher, searchWholeWord, searchPreview } from "./workspace-search";

export class WorkspaceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const MAX_ENTRIES = 2000, MAX_GIT_OUTPUT = 4 * 1024 * 1024;
export type WorkspaceOperationOptions = { signal?: AbortSignal; deadline?: number };
export function workspaceOperationCheck(options?: WorkspaceOperationOptions): void {
  if (options?.signal?.aborted) fail(499, "search-aborted", "Search cancelled");
  if (options?.deadline !== undefined && Date.now() >= options.deadline) fail(504, "search-time-limit", "Search time budget reached");
}
/** Race uncooperative lookup promises too; production lookups also pass these
 * controls to subprocesses so cancellation kills work, not just its waiter. */
export async function workspaceOperationWait<T>(operation: () => Promise<T>, options?: WorkspaceOperationOptions): Promise<T> {
  workspaceOperationCheck(options);
  if (!options) return operation();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new WorkspaceError(499, "search-aborted", "Search cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.deadline !== undefined) timer = setTimeout(() => reject(new WorkspaceError(504, "search-time-limit", "Search time budget reached")), Math.max(0, options.deadline - Date.now()));
  });
  try { const value = await Promise.race([operation(), interrupted]); workspaceOperationCheck(options); return value; }
  finally { if (timer !== undefined) clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort); }
}
type SearchBinding = { cwd: string; bindingRevision?: string; protectedPaths?: string[] };
type SessionLookup = (id: string, options?: WorkspaceOperationOptions) => SearchBinding | undefined | Promise<SearchBinding | undefined>;
type Bound = Workspace & { data: string; dev: number; ino: number; protectedPaths: string[]; operation?: WorkspaceOperationOptions };
type GitRoot = { root: string; prefix: string };
type Blob = { bytes: Buffer; mode: string | null; reason?: DiffReason };
type GitOptions = { signal?: AbortSignal; timeoutMs?: number };
function decode(bytes: Buffer): { text: string | null; reason?: "binary" | "invalid-utf8"; bom: boolean; eol: WorkspaceFile["eol"] } {
  const bom = bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  if (bytes.includes(0)) return { text: null, reason: "binary", bom, eol: "none" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes); }
  catch { return { text: null, reason: "invalid-utf8", bom, eol: "none" }; }
  const crlf = text.includes("\r\n"), rest = text.replaceAll("\r\n", ""), lf = rest.includes("\n"), cr = rest.includes("\r");
  const eol = Number(crlf) + Number(lf) + Number(cr) > 1 ? "mixed" : crlf ? "crlf" : cr ? "cr" : lf ? "lf" : "none";
  return { text: text.replace(/\r\n|\r/g, "\n"), bom, eol };
}

export class WorkspaceService {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private lookup: SessionLookup, private dataDir: string, private searchLeaseProvider?: WorkspaceSearchLeaseProvider) {}

  private async serialize<T>(target: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(target) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.writes.set(target, next);
    try { return await next; } finally { if (this.writes.get(target) === next) this.writes.delete(target); }
  }

  private async bound(sessionId: string, operation?: WorkspaceOperationOptions): Promise<Bound> {
    const session = await workspaceOperationWait(async () => this.lookup(sessionId, operation), operation);
    if (!session) fail(404, "unknown-session", "Unknown conversation");
    return this.boundBinding(sessionId, session, operation);
  }
  private async boundBinding(sessionId: string, session: SearchBinding, operation?: WorkspaceOperationOptions): Promise<Bound> {
    // Pin a copy: a caller mutating its binding object must not alter a search's
    // initial policy snapshot (or change the meaning of its final comparison).
    const protectedPaths = [...(session.protectedPaths ?? [])];
    const { cwd, bindingRevision } = session;
    let root: string, data: string;
    try { [root, data] = await workspaceOperationWait(() => Promise.all([realpath(cwd), realpath(this.dataDir)]), operation); }
    catch (error) { if (error instanceof WorkspaceError) throw error; return fail(404, "workspace-unavailable", "Conversation workspace is unavailable"); }
    const info = await workspaceOperationWait(() => lstat(root), operation);
    if (!info.isDirectory() || root.split(sep).some(p => [".git", ".sane"].includes(p.toLowerCase())) || inside(data, root)) fail(403, "workspace-forbidden", "Workspace is not accessible");
    if (protectedPaths.some(path => inside(path, root))) fail(403, "workspace-forbidden", "Git administration directory is not accessible");
    return { sessionId, root, data, protectedPaths, dev: info.dev, ino: info.ino, operation, maxFileBytes: WORKSPACE_MAX_BYTES, workspaceId: bindingRevision ?? hash(`${root}\0${info.dev}\0${info.ino}`) };
  }
  async resolve(sessionId: string): Promise<Workspace> {
    const { workspaceId, root, maxFileBytes } = await this.bound(sessionId);
    return { sessionId, workspaceId, root, maxFileBytes };
  }
  private async bind(sessionId: string, workspaceId: unknown, operation?: WorkspaceOperationOptions): Promise<Bound> {
    if (typeof workspaceId !== "string" || !workspaceId) fail(400, "workspace-required", "Resolve the conversation workspace first");
    const bound = await this.bound(sessionId, operation);
    if (bound.workspaceId !== workspaceId) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
    return bound;
  }
  private lexical(bound: Bound, path: unknown, rootAllowed = false): string {
    if (typeof path !== "string" || path.length > 4096 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || (path === "" ? !rootAllowed : path.split("/").some(p => !p || p === "." || p === ".." || [".git", ".sane"].includes(p.toLowerCase())))) fail(400, "invalid-path", "Use an exact workspace-relative path");
    const target = resolve(bound.root, path);
    if (!inside(bound.root, target) || inside(bound.data, target) || bound.protectedPaths.some(path => inside(path, target))) fail(403, "path-forbidden", "Path is not accessible");
    return target;
  }
  private async checked(bound: Bound, path: string, rootAllowed = false, missing = false): Promise<string> {
    const target = this.lexical(bound, path, rootAllowed);
    const fresh = await this.bind(bound.sessionId, bound.workspaceId, bound.operation);
    if (fresh.root !== bound.root || fresh.dev !== bound.dev || fresh.ino !== bound.ino) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
    this.lexical(fresh, path, rootAllowed);
    return this.checkedComponents(bound, path, target, missing);
  }
  private async checkedComponents(bound: Bound, path: string, target: string, missing = false): Promise<string> {
    let cursor = bound.root;
    for (const part of path ? path.split("/") : []) {
      workspaceOperationCheck(bound.operation);
      cursor = join(cursor, part);
      let info;
      try { info = await workspaceOperationWait(() => lstat(cursor), bound.operation); } catch (error: any) {
        if (missing && error.code === "ENOENT") return target;
        throw error;
      }
      if (info.isSymbolicLink()) fail(403, "symlink", "Symlink traversal is not supported");
      const canonical = await workspaceOperationWait(() => realpath(cursor), bound.operation);
      if (canonical !== cursor || !inside(bound.root, canonical) || inside(bound.data, canonical)) fail(403, "path-forbidden", "Path is not accessible");
    }
    workspaceOperationCheck(bound.operation);
    return target;
  }
  /** Search-only fast checker. No writable operation accepts this capability. */
  private async searchChecked(bound: Bound, lease: WorkspaceSearchLease | undefined, path: string, rootAllowed = false, missing = false): Promise<string> {
    if (!lease) return this.checked(bound, path, rootAllowed, missing);
    const target = this.lexical(bound, path, rootAllowed);
    await workspaceOperationWait(() => lease.validate(bound.operation ?? {}), bound.operation);
    const [root, info] = await workspaceOperationWait(() => Promise.all([realpath(bound.root), lstat(bound.root)]), bound.operation);
    if (root !== bound.root || !info.isDirectory() || info.isSymbolicLink() || info.dev !== bound.dev || info.ino !== bound.ino) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
    return this.checkedComponents(bound, path, target, missing);
  }
  /** Instance-local readonly acquisition seam; never used by writable disk(). */
  private searchOpen(target: string) {
    return open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  private async searchDisk(bound: Bound, path: string, check: (path: string) => Promise<string>, readBudget: number) {
    const target = await check(path);
    // Never race resource-creating I/O: retain ownership even if cancellation
    // arrives during open/read, and await close before freeing search admission.
    const handle = await this.searchOpen(target);
    try {
      workspaceOperationCheck(bound.operation);
      const info = await handle.stat();
      if (!info.isFile()) fail(400, "not-file", "Only regular files are supported");
      if (info.nlink !== 1) fail(403, "hardlink", "Hard-linked files are not supported");
      await check(path);
      const current = await lstat(target);
      if (current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1) fail(409, "file-changed", "File changed while opening");
      workspaceOperationCheck(bound.operation);
      const bytes = Buffer.alloc(Math.min(Math.min(info.size, WORKSPACE_MAX_BYTES) + 1, readBudget));
      let used = 0;
      while (used < bytes.length) {
        workspaceOperationCheck(bound.operation);
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      const after = await handle.stat();
      await check(path);
      const final = await lstat(target);
      workspaceOperationCheck(bound.operation);
      if (after.nlink !== 1 || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || final.dev !== info.dev || final.ino !== info.ino || final.nlink !== 1 || final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs) fail(409, "file-changed", "File changed while reading");
      return { info, bytes: bytes.subarray(0, used), oversize: info.size > WORKSPACE_MAX_BYTES || used > WORKSPACE_MAX_BYTES };
    } finally { await handle.close(); }
  }
  async list(sessionId: string, workspaceId: unknown, path: string): Promise<WorkspaceList> {
    const bound = await this.bind(sessionId, workspaceId), target = await this.checked(bound, path, true);
    const entries: WorkspaceList["entries"] = []; let truncated = false, scanned = 0;
    const dir = await opendir(target);
    for await (const entry of dir) {
      if (++scanned > MAX_ENTRIES) { truncated = true; break; }
      const child = path ? `${path}/${entry.name}` : entry.name;
      try { this.lexical(bound, child); } catch { continue; }
      entries.push({ name: entry.name, path: child, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    }
    await this.checked(bound, path, true);
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    return { workspaceId: bound.workspaceId, path, entries, truncated };
  }
  private async disk(bound: Bound, path: string, writable = false, readBudget = WORKSPACE_MAX_BYTES + 1) {
    const target = await this.checked(bound, path);
    const handle = await open(target, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      workspaceOperationCheck(bound.operation);
      const info = await handle.stat();
      if (!info.isFile()) fail(400, "not-file", "Only regular files are supported");
      // Shared inodes could alias protected data or paths outside the workspace.
      if (info.nlink !== 1) fail(403, "hardlink", "Hard-linked files are not supported");
      await this.checked(bound, path);
      const current = await lstat(target);
      if (current.dev !== info.dev || current.ino !== info.ino) fail(409, "file-changed", "File changed while opening");
      const bytes = Buffer.alloc(Math.min(Math.min(info.size, WORKSPACE_MAX_BYTES) + 1, readBudget));
      let used = 0;
      while (used < bytes.length) { workspaceOperationCheck(bound.operation); const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
      const after = await handle.stat();
      workspaceOperationCheck(bound.operation);
      if (after.nlink !== 1 || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail(409, "file-changed", "File changed while reading");
      return { handle, info, target, bytes: bytes.subarray(0, used), oversize: info.size > WORKSPACE_MAX_BYTES || used > WORKSPACE_MAX_BYTES };
    } catch (error) { await handle.close(); throw error; }
  }
  private async fileResult(bound: Bound, path: string, disk: Awaited<ReturnType<WorkspaceService["disk"]>>): Promise<WorkspaceFile> {
    const base = { workspaceId: bound.workspaceId, path, bytes: disk.info.size };
    if (disk.oversize) return { ...base, text: null, revision: null, editable: false, reason: "oversize", eol: "none", bom: false };
    const decoded = decode(disk.bytes);
    let writable = !!(disk.info.mode & 0o222);
    try { await access(disk.target, constants.W_OK); } catch { writable = false; }
    const reason = decoded.reason ?? (decoded.eol === "mixed" ? "mixed-eol" : !writable ? "not-writable" : undefined);
    return { ...base, ...decoded, revision: hash(disk.bytes), editable: !reason, ...(reason ? { reason } : {}) };
  }
  async file(sessionId: string, workspaceId: unknown, path: string): Promise<WorkspaceFile> {
    const bound = await this.bind(sessionId, workspaceId), disk = await this.disk(bound, path);
    try { const result = await this.fileResult(bound, path, disk); await this.checked(bound, path); return result; }
    finally { await disk.handle.close(); }
  }
  async search(sessionId: string, input: WorkspaceSearchInput, signal?: AbortSignal): Promise<WorkspaceSearch> {
    if (!input || typeof input.query !== "string" || !input.query.length || input.query.length > SEARCH.query || /[\0\r\n]/.test(input.query) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.query) || (input.caseSensitive !== undefined && typeof input.caseSensitive !== "boolean") || (input.wholeWord !== undefined && typeof input.wholeWord !== "boolean")) fail(400, "invalid-search", "Use a nonempty single-line literal query of at most 1024 characters and boolean search options");
    let include: string[], exclude: string[];
    try { include = searchPatterns(input.include); exclude = searchPatterns(input.exclude); }
    catch { return fail(400, "invalid-search-filter", "Use at most 32 comma-separated relative globs with *, ?, and ** segments"); }
    workspaceOperationCheck({ signal });
    const release = admitWorkspaceSearch();
    if (!release) fail(503, "search-busy", "Workspace search is busy; try again shortly");
    const deadline = Date.now() + SEARCH.milliseconds, operation = { signal, deadline };
    // All operations receive the SAME absolute 5s deadline. Stop admitting
    // scan work 500ms earlier to reserve cleanup and the full final fence.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const scanOperation = { signal: controller.signal, deadline };
    let scanExpired = false;
    const scanTimer = setTimeout(() => { scanExpired = true; controller.abort(); }, Math.max(0, deadline - 500 - Date.now()));
    const checkpoint = () => {
      if (scanExpired) fail(504, "search-time-limit", "Search time budget reached");
      workspaceOperationCheck(scanOperation);
      if (Date.now() >= deadline - 500) fail(504, "search-time-limit", "Search time budget reached");
    };
    let lease: WorkspaceSearchLease | undefined, evaluator: WorkspaceIgnoreEvaluator | undefined;
    type Outcome = { path: string; reserved: number; used: number; text: string | null; grew: boolean; error?: unknown };
    const pending = new Set<Promise<Outcome>>();
    try {
      checkpoint();
      if (typeof input.workspaceId !== "string" || !input.workspaceId) fail(400, "workspace-required", "Resolve the conversation workspace first");
      // A production provider already does a full binding lookup. Build the
      // same canonical Bound from its result, without a second catalog call.
      if (this.searchLeaseProvider) lease = await this.searchLeaseProvider(sessionId, scanOperation);
      const bound = lease ? await this.boundBinding(sessionId, lease.binding, scanOperation) : await this.bind(sessionId, input.workspaceId, scanOperation);
      if (bound.workspaceId !== input.workspaceId) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
      const paths = new Set<string>([""]);
      const check = async (path: string, rootAllowed = false, missing = false) => {
        checkpoint();
        this.lexical(bound, path, rootAllowed);
        paths.add(path);
        return this.searchChecked(bound, lease, path, rootAllowed, missing);
      };
      const result: WorkspaceSearch = { workspaceId: bound.workspaceId, matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
      let entries = 0, files = 0, bytes = 0, outputBytes = 0, ignoreFiles = 0, ignoreBytes = 0, ignoreRules = 0;
      const skippable = (error: any) => (error instanceof WorkspaceError ? ["invalid-path", "path-forbidden", "symlink", "hardlink", "not-file", "file-changed"].includes(error.code) : ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error?.code));
      const launch = (path: string, reserved: number) => {
        files++; bytes += reserved; // Coordinator reserves BEFORE launching I/O.
        const worker = (async (): Promise<Outcome> => {
          try {
            const disk = await this.searchDisk(bound, path, check, reserved);
            const grew = disk.info.size > reserved && !disk.oversize;
            return { path, reserved, used: disk.bytes.length, text: grew || disk.oversize ? null : decode(disk.bytes).text, grew };
          } catch (error) { return { path, reserved, used: reserved, text: null, grew: false, error }; }
        })();
        pending.add(worker);
        return worker;
      };
      const consume = (outcome: Outcome) => {
        checkpoint();
        if (outcome.error !== undefined) {
          if (!skippable(outcome.error)) throw outcome.error;
          result.skippedFiles++; return;
        }
        if (outcome.grew) { result.truncated = true; return; }
        if (outcome.text === null) { result.skippedFiles++; return; }
        result.scannedFiles++;
        // No mutable RegExp crosses an await or is shared between outcomes.
        const matcher = literalMatcher(input.query, !!input.caseSensitive);
        let lineNumber = 0;
        for (const line of outcome.text.split("\n")) {
          checkpoint(); lineNumber++; matcher.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = matcher.exec(line))) {
            checkpoint();
            const start = match.index, end = start + match[0].length;
            if (input.wholeWord && !searchWholeWord(line, start, end)) continue;
            const found = { path: outcome.path, line: lineNumber, column: start + 1, endColumn: end + 1, preview: searchPreview(line, start) };
            const size = Buffer.byteLength(JSON.stringify(found)) + 1;
            if (result.matches.length >= SEARCH.matches || outputBytes + size > SEARCH.outputBytes) { result.truncated = true; return; }
            outputBytes += size; result.matches.push(found);
          }
        }
      };
      try {
        const directories = [{ path: "", depth: 0, scopes: [] as string[] }];
        while (directories.length && !result.truncated) {
          checkpoint();
          const directory = directories.pop()!, scopes = [...directory.scopes];
          const ignorePath = directory.path ? `${directory.path}/.gitignore` : ".gitignore";
          try {
            const ignoreTarget = await check(ignorePath, false, true);
            const info = await workspaceOperationWait(() => lstat(ignoreTarget), scanOperation);
            // Planning metadata grants no read permission. searchDisk fences
            // every descriptor, including ignore snapshots, independently.
            if (info.isFile() && info.nlink === 1 && info.size <= WORKSPACE_MAX_BYTES) {
              const remaining = Math.min(SEARCH.bytes - bytes, SEARCH.ignoreBytes - ignoreBytes);
              if (files >= SEARCH.files || ignoreFiles >= SEARCH.ignoreFiles || info.size > remaining) { result.truncated = true; break; }
              files++; ignoreFiles++; bytes += info.size; ignoreBytes += info.size;
              const disk = await this.searchDisk(bound, ignorePath, path => check(path), info.size);
              bytes += disk.bytes.length - info.size; ignoreBytes += disk.bytes.length - info.size;
              if (disk.info.size > info.size && !disk.oversize) { result.truncated = true; break; }
              const text = disk.oversize ? null : decode(disk.bytes).text;
              if (text !== null) {
                let rules: number;
                try { rules = validateIgnoreSnapshot(text).rules; }
                catch (error) {
                  if (!(error instanceof WorkspaceIgnoreError) || error.code !== "ignore-limit") throw error;
                  result.truncated = true; break;
                }
                if (ignoreRules + rules > SEARCH.ignoreRules) { result.truncated = true; break; }
                ignoreRules += rules;
                if (rules) {
                  evaluator ??= new WorkspaceIgnoreEvaluator(scanOperation);
                  await evaluator.register(directory.path, text);
                  scopes.push(directory.path);
                }
              }
            }
          } catch (error) { if (!skippable(error)) throw error; }
          checkpoint();
          let dir;
          try { dir = await opendir(await check(directory.path, true)); }
          catch (error) { if (directory.path && skippable(error)) continue; throw error; }
          type Candidate = { path: string; directory: boolean; size: number };
          let candidates: Candidate[] = [];
          const scanBatch = async () => {
            checkpoint();
            // The evaluator owns all ignore parsing/matching; no synchronous
            // ignore add/test can stall the main request's cancellation loop.
            const ignored = scopes.length ? await evaluator!.test(scopes, candidates) : candidates.map(() => false);
            if (ignored.length !== candidates.length) fail(503, "search-ignore-failed", "Ignore evaluation failed");
            let index = 0;
            while (index < candidates.length && !result.truncated) {
              const queue: Promise<Outcome>[] = [];
              while (index < candidates.length && queue.length < 4 && !result.truncated) {
                checkpoint();
                const candidate = candidates[index]!, isIgnored = ignored[index++]!;
                if (isIgnored) { if (!candidate.directory) result.skippedFiles++; continue; }
                if (candidate.directory) {
                  if (directory.depth >= SEARCH.depth) result.truncated = true;
                  else directories.push({ path: candidate.path, depth: directory.depth + 1, scopes });
                  continue;
                }
                const reserved = Math.min(candidate.size, WORKSPACE_MAX_BYTES + 1);
                if (files >= SEARCH.files || bytes + reserved > SEARCH.bytes) { result.truncated = true; break; }
                queue.push(launch(candidate.path, reserved));
              }
              // Only four workers/decoded outcomes exist at a time. All settle
              // before consuming, so a later security failure cannot be hidden
              // by an earlier match/output truncation, and order is discovery order.
              const outcomes = await Promise.all(queue);
              for (const worker of queue) pending.delete(worker);
              for (const outcome of outcomes) bytes += outcome.used - outcome.reserved;
              for (const outcome of outcomes) if (outcome.error !== undefined && !skippable(outcome.error)) throw outcome.error;
              const admissionTruncated = result.truncated;
              result.truncated = false;
              for (const outcome of outcomes) { consume(outcome); if (result.truncated) break; }
              result.truncated ||= admissionTruncated;
            }
            candidates = [];
          };
          try {
            for await (const entry of dir) {
              checkpoint();
              if (++entries > SEARCH.entries) { result.truncated = true; break; }
              const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
              const isDirectory = entry.isDirectory();
              if ((isDirectory && SEARCH_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) || searchFilter(exclude!, path, isDirectory) || (!isDirectory && include!.length && !searchFilter(include!, path))) { if (!isDirectory) result.skippedFiles++; continue; }
              try {
                const target = await check(path), info = await workspaceOperationWait(() => lstat(target), scanOperation);
                if (entry.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) { result.skippedFiles++; continue; }
                candidates.push({ path, directory: info.isDirectory(), size: info.size });
              } catch (error) { if (!skippable(error)) throw error; if (!isDirectory) result.skippedFiles++; continue; }
              if (candidates.length >= 128) { await scanBatch(); if (result.truncated) break; }
            }
            await check(directory.path, true);
            if (!result.truncated) await scanBatch();
          } finally {
            // Async iteration normally closes it itself; cancellation between
            // opendir and iteration still leaves an owned handle to close.
            try { await dir.close(); } catch (error: any) { if (error?.code !== "ERR_DIR_CLOSED") throw error; }
          }
        }
      } catch (error) {
        if (signal?.aborted) fail(499, "search-aborted", "Search cancelled");
        if ((error instanceof WorkspaceError || error instanceof WorkspaceIgnoreError) && (["search-time-limit", "git-timeout", "ignore-limit"].includes(error.code) || (scanExpired && error.code === "search-aborted"))) result.truncated = true;
        else throw error;
      } finally {
        clearTimeout(scanTimer);
        controller.abort();
        const remaining = await Promise.all([...pending]);
        pending.clear();
        await evaluator?.close();
        evaluator = undefined;
        // An admission checkpoint can interrupt a partially filled queue.
        // Do not lose a concurrent scope failure merely because it was not
        // consumed: only cleanup cancellation/deadline errors may be ignored.
        for (const outcome of remaining) {
          if (outcome.error !== undefined && !skippable(outcome.error) && !(outcome.error instanceof WorkspaceError && ["search-aborted", "search-time-limit"].includes(outcome.error.code))) throw outcome.error;
        }
      }
      // Full catalog bind AFTER workers and evaluator are settled, even for
      // zero-match/truncated searches. Compare the entire initial policy, not
      // just result paths: a newly protected subtree invalidates all results.
      const final = await this.bind(sessionId, input.workspaceId, operation);
      const policy = (value: Bound) => JSON.stringify([...new Set(value.protectedPaths)].sort());
      if (final.root !== bound.root || final.data !== bound.data || final.dev !== bound.dev || final.ino !== bound.ino || policy(final) !== policy(bound)) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
      if (lease) await workspaceOperationWait(() => lease!.validate(operation), operation);
      for (const path of paths) { workspaceOperationCheck(operation); this.lexical(final, path, path === ""); }
      workspaceOperationCheck(operation);
      return result;
    } catch (error) {
      if (signal?.aborted) fail(499, "search-aborted", "Search cancelled");
      if (scanExpired && (error instanceof WorkspaceError || error instanceof WorkspaceIgnoreError) && error.code === "search-aborted") fail(504, "search-time-limit", "Search time budget reached");
      throw error;
    } finally {
      clearTimeout(scanTimer);
      controller.abort();
      try {
        await Promise.all([...pending]);
        await evaluator?.close();
      } finally {
        try {
          await lease?.dispose?.();
          // Cleanup is part of the request lifetime, not work allowed after a
          // successful response. Late cancellation/deadline still fails closed.
          workspaceOperationCheck(operation);
        }
        finally { signal?.removeEventListener("abort", abort); release(); }
      }
    }
  }
  async write(sessionId: string, input: WorkspaceWrite): Promise<WorkspaceFile> {
    if (!input || typeof input.text !== "string" || typeof input.expectedRevision !== "string") fail(400, "invalid-write", "Expected text and expectedRevision");
    const bound = await this.bind(sessionId, input.workspaceId), target = this.lexical(bound, input.path);
    return this.serialize(target, async () => {
      await this.bind(sessionId, input.workspaceId);
      const disk = await this.disk(bound, input.path, true);
      try {
        const current = await this.fileResult(bound, input.path, disk);
        if (current.revision !== input.expectedRevision) fail(409, "revision-conflict", "File changed on disk; reload before saving");
        if (!current.editable) fail(422, "read-only", `File is read-only: ${current.reason}`);
        if (input.text.includes("\r") || input.text.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.text)) fail(400, "invalid-text", "Text must be normalized UTF-8 with LF line endings");
        const eol = current.eol === "crlf" ? "\r\n" : current.eol === "cr" ? "\r" : "\n";
        const bytes = Buffer.from((current.bom ? "\uFEFF" : "") + input.text.replaceAll("\n", eol), "utf8");
        if (bytes.length > WORKSPACE_MAX_BYTES) fail(413, "oversize", "File exceeds 256 KiB");
        await this.checked(bound, input.path);
        const info = await lstat(target), opened = await disk.handle.stat();
        if (info.dev !== disk.info.dev || info.ino !== disk.info.ino || opened.nlink !== 1 || opened.size !== disk.info.size || opened.mtimeMs !== disk.info.mtimeMs || opened.ctimeMs !== disk.info.ctimeMs) fail(409, "revision-conflict", "File changed before saving");
        // In-place writes preserve inode, permissions and ownership; never create a file.
        let offset = 0;
        while (offset < bytes.length) { const result = await disk.handle.write(bytes, offset, bytes.length - offset, offset); if (!result.bytesWritten) throw new Error("Short write"); offset += result.bytesWritten; }
        await disk.handle.truncate(bytes.length);
        if (((await disk.handle.stat()).mode & 0o7777) !== (disk.info.mode & 0o7777)) await disk.handle.chmod(disk.info.mode & 0o7777);
        await disk.handle.sync();
        await this.checked(bound, input.path);
        const after = await lstat(target);
        if (after.dev !== disk.info.dev || after.ino !== disk.info.ino) fail(409, "file-changed", "File was replaced while saving; reload");
        return { ...current, text: input.text, revision: hash(bytes), bytes: bytes.length, eol: decode(bytes).eol };
      } finally { await disk.handle.close(); }
    });
  }

  private async createBytes(bound: Bound, path: string, bytes: Buffer, mode = 0o666): Promise<WorkspaceFile> {
    const target = this.lexical(bound, path), parent = posix.dirname(path);
    const directory = await this.checked(bound, parent === "." ? "" : parent, true);
    if (!(await lstat(directory)).isDirectory()) fail(400, "not-directory", "Choose an existing destination folder");
    // Exclusive creation never overwrites an existing file, directory, or symlink.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await this.checked(bound, path);
      await handle.writeFile(bytes);
      await handle.sync();
      const opened = await handle.stat(), current = await lstat(await this.checked(bound, path));
      if (opened.dev !== current.dev || opened.ino !== current.ino || opened.nlink !== 1) fail(409, "file-changed", "File changed while creating; refresh files");
    } finally { await handle.close(); }
    return this.file(bound.sessionId, bound.workspaceId, path);
  }
  async create(sessionId: string, input: WorkspaceCreate): Promise<WorkspaceFile> {
    const bound = await this.bind(sessionId, input?.workspaceId), target = this.lexical(bound, input?.path);
    return this.serialize(target, () => this.createBytes(bound, input.path, Buffer.alloc(0)));
  }
  private assertRevision(input: WorkspaceDelete) {
    if (!input || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail(400, "revision-required", "Read the file before copying or deleting it");
  }
  async copy(sessionId: string, input: WorkspaceCopy): Promise<WorkspaceFile> {
    this.assertRevision(input);
    const bound = await this.bind(sessionId, input.workspaceId), target = this.lexical(bound, input.destination);
    this.lexical(bound, input.path);
    return this.serialize(target, async () => {
      const disk = await this.disk(bound, input.path);
      try {
        if (disk.oversize) fail(413, "oversize", "File exceeds 256 KiB");
        if (hash(disk.bytes) !== input.expectedRevision) fail(409, "revision-conflict", "Source changed on disk; reload before copying");
        // Copy saved bytes exactly, including BOM, line endings, and binary content.
        return await this.createBytes(bound, input.destination, disk.bytes, disk.info.mode & 0o777);
      } finally { await disk.handle.close(); }
    });
  }
  async delete(sessionId: string, input: WorkspaceDelete): Promise<{ workspaceId: string; path: string }> {
    this.assertRevision(input);
    const bound = await this.bind(sessionId, input.workspaceId), target = this.lexical(bound, input.path);
    return this.serialize(target, async () => {
      const disk = await this.disk(bound, input.path);
      try {
        if (disk.oversize) fail(413, "oversize", "File exceeds 256 KiB");
        if (hash(disk.bytes) !== input.expectedRevision) fail(409, "revision-conflict", "File changed on disk; reload before deleting");
        const current = await lstat(await this.checked(bound, input.path)), opened = await disk.handle.stat();
        if (current.dev !== disk.info.dev || current.ino !== disk.info.ino || opened.nlink !== 1 || opened.size !== disk.info.size || opened.mtimeMs !== disk.info.mtimeMs || opened.ctimeMs !== disk.info.ctimeMs) fail(409, "revision-conflict", "File changed before deleting");
        await unlink(target);
        return { workspaceId: bound.workspaceId, path: input.path };
      } finally { await disk.handle.close(); }
    });
  }

  async git(cwd: string, args: string[], limit = MAX_GIT_OUTPUT, options: GitOptions = {}): Promise<{ code: number; bytes: Buffer; stderr: string }> {
    // Do not inherit GIT_DIR/WORK_TREE/INDEX_FILE, config injection, alternates,
    // pagers, credentials, or provider secrets. No shell, hooks, filters or textconv.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_ATTR_NOSYSTEM: "1" };
    let child;
    if (options.signal?.aborted) fail(499, "search-aborted", "Search cancelled");
    try { child = Bun.spawn(["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...args], { cwd, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch { return fail(503, "git-unavailable", "Git executable is unavailable"); }
    let total = 0;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { kill(); reject(new WorkspaceError(504, "git-timeout", "Git operation timed out")); }, options.timeoutMs ?? 8000); });
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => { kill(); reject(new WorkspaceError(499, "search-aborted", "Search cancelled")); }; options.signal?.addEventListener("abort", onAbort, { once: true }); if (options.signal?.aborted) onAbort(); });
    const collect = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
      const reader = stream.getReader(), chunks: Uint8Array[] = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { kill(); fail(413, "git-output-limit", "Git output exceeds the bounded response limit"); } if (keep) chunks.push(value); } }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    };
    try {
      const [code, bytes, stderr] = await Promise.race([Promise.all([child.exited, collect(child.stdout, true), collect(child.stderr, true)]), deadline, aborted]);
      return { code, bytes, stderr: stderr.toString("utf8") };
    } finally { clearTimeout(timer!); options.signal?.removeEventListener("abort", onAbort!); kill(); }
  }
  private async gitRoot(bound: Bound): Promise<GitRoot | null> {
    await this.bind(bound.sessionId, bound.workspaceId);
    const result = await this.git(bound.root, ["rev-parse", "--show-toplevel"]);
    if (result.code) {
      if (result.stderr.startsWith("fatal: not a git repository (or any of the parent directories): .git")) return null;
      fail(503, "git-discovery", "Git repository discovery failed");
    }
    const root = await realpath(result.bytes.toString("utf8").replace(/\n$/, ""));
    if (!inside(root, bound.root)) fail(403, "git-scope", "Workspace is outside the Git worktree");
    return { root, prefix: relative(root, bound.root).split(sep).join("/") };
  }
  private scoped(bound: Bound, git: GitRoot, path: string): string | null {
    if (git.prefix && !path.startsWith(git.prefix + "/")) return null;
    const local = git.prefix ? path.slice(git.prefix.length + 1) : path;
    try { this.lexical(bound, local); return local; } catch { return null; }
  }
  private async entries(bound: Bound, git: GitRoot): Promise<{ entries: GitEntry[]; truncated: boolean }> {
    const result = await this.git(git.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    if (result.code) fail(503, "git-status", "Git status is unavailable");
    // NUL-delimited names are never shell-unquoted, trimmed, or line-split.
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
    catch { return fail(422, "git-path-encoding", "Git paths contain unsupported non-UTF-8 names"); }
    const records = raw.split("\0"), entries: GitEntry[] = []; let truncated = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!; if (!record) continue;
      const index = record[0]!, worktree = record[1]!, name = record.slice(3);
      const renamed = index === "R" || index === "C" || worktree === "R" || worktree === "C";
      const source = renamed ? records[++i] : undefined;
      const destination = this.scoped(bound, git, name), originalPath = source ? this.scoped(bound, git, source) : null;
      // Keep the in-scope endpoint visible when a rename crosses the boundary,
      // without publishing or loading the outside endpoint.
      const path = destination ?? originalPath;
      if (path === null) continue;
      if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
      const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(index + worktree);
      const comparisons: GitComparison[] = index === "?" ? ["untracked"] : [...(index !== " " ? ["staged" as const] : []), ...(worktree !== " " ? ["unstaged" as const] : [])];
      entries.push({ path, ...(originalPath !== null ? { originalPath } : {}), index, worktree, comparisons, conflict, submodule: false, renameOutsideWorkspace: !!source && (originalPath === null || destination === null) });
    }
    // One bounded index read supplies mode metadata (including submodules).
    const modes = await this.git(git.root, ["ls-files", "--stage", "-z", "--", git.prefix || "."]);
    if (modes.code) fail(503, "git-index", "Git index is unavailable");
    const submodules = new Set(modes.bytes.toString("utf8").split("\0").filter(row => row.startsWith("160000 ")).map(row => this.scoped(bound, git, row.slice(row.indexOf("\t") + 1))));
    for (const entry of entries) entry.submodule = submodules.has(entry.path);
    return { entries, truncated };
  }
  async status(sessionId: string, workspaceId: unknown): Promise<WorkspaceGit> {
    const bound = await this.bind(sessionId, workspaceId);
    try {
      const git = await this.gitRoot(bound);
      if (!git) return { workspaceId: bound.workspaceId, available: false, reason: "Conversation workspace is not in a Git worktree", entries: [], truncated: false };
      const result = await this.entries(bound, git); await this.bind(sessionId, workspaceId);
      return { workspaceId: bound.workspaceId, available: true, ...result };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "git-unavailable") return { workspaceId: bound.workspaceId, available: false, reason: error.message, entries: [], truncated: false };
      throw error;
    }
  }
  private async blob(git: GitRoot, path: string, source: "head" | "index"): Promise<Blob> {
    const empty: Blob = { bytes: Buffer.alloc(0), mode: null };
    let result;
    if (source === "head") {
      const head = await this.git(git.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (head.code) {
        // Only a symbolic HEAD with a missing branch ref is an unborn branch.
        const symbolic = await this.git(git.root, ["symbolic-ref", "-q", "HEAD"]);
        if (!symbolic.code) {
          const ref = symbolic.bytes.toString("utf8").replace(/\n$/, "");
          const exists = await this.git(git.root, ["show-ref", "--verify", "--quiet", ref]);
          if (exists.code === 1) return empty;
        }
        return fail(503, "git-head", "Git HEAD is unavailable");
      }
      result = await this.git(git.root, ["ls-tree", "-z", head.bytes.toString("utf8").trim(), "--", path]);
    } else result = await this.git(git.root, ["ls-files", "--stage", "-z", "--", path]);
    if (result.code) fail(503, "git-object", "Git file metadata is unavailable");
    const rows = result.bytes.toString("utf8").split("\0").filter(Boolean).filter(row => row.slice(row.indexOf("\t") + 1) === path);
    if (!rows.length) return empty;
    const row = rows[0]!, fields = row.slice(0, row.indexOf("\t")).split(" "), mode = fields[0]!;
    if (source === "index" && (rows.length !== 1 || fields[2] !== "0")) return { ...empty, mode, reason: "conflict" };
    if (mode === "160000") return { ...empty, mode, reason: "submodule" };
    if (mode === "120000") return { ...empty, mode, reason: "symlink" };
    if (mode !== "100644" && mode !== "100755") return { ...empty, mode, reason: "unavailable" };
    const oid = fields[source === "head" ? 2 : 1]!;
    if (!/^[0-9a-f]{40,64}$/.test(oid)) fail(503, "git-object", "Invalid Git object metadata");
    const size = await this.git(git.root, ["cat-file", "-s", oid]);
    if (size.code || !/^\d+\n?$/.test(size.bytes.toString())) fail(503, "git-object", "Git blob is unavailable");
    if (Number(size.bytes.toString()) > WORKSPACE_MAX_BYTES) return { ...empty, mode, reason: "oversize" };
    const content = await this.git(git.root, ["cat-file", "blob", oid], WORKSPACE_MAX_BYTES + 1024);
    if (content.code) fail(503, "git-object", "Git blob is unavailable");
    return { mode, bytes: content.bytes };
  }
  private async diskBlob(bound: Bound, path: string): Promise<Blob> {
    try {
      const target = await this.checked(bound, path, false, true);
      const info = await lstat(target);
      if (info.isDirectory()) return { bytes: Buffer.alloc(0), mode: "040000", reason: "submodule" };
      const disk = await this.disk(bound, path);
      try { return { bytes: disk.bytes, mode: disk.info.mode & 0o111 ? "100755" : "100644", ...(disk.oversize ? { reason: "oversize" as const } : {}) }; }
      finally { await disk.handle.close(); }
    } catch (error: any) {
      if (error.code === "ENOENT") return { bytes: Buffer.alloc(0), mode: null };
      if (error instanceof WorkspaceError && error.code === "symlink") return { bytes: Buffer.alloc(0), mode: "120000", reason: "symlink" };
      throw error;
    }
  }
  async diff(sessionId: string, workspaceId: unknown, path: string, comparison: string): Promise<WorkspaceDiff> {
    if (!["staged", "unstaged", "untracked"].includes(comparison)) fail(400, "invalid-comparison", "Choose staged, unstaged, or untracked");
    const bound = await this.bind(sessionId, workspaceId); this.lexical(bound, path);
    const git = await this.gitRoot(bound);
    if (!git) fail(422, "not-repository", "Workspace is not in a Git worktree");
    const status = await this.entries(bound, git), entry = status.entries.find(entry => entry.path === path);
    if (!entry || !entry.comparisons.includes(comparison as GitComparison)) fail(409, "git-changed", "This comparison is no longer available; refresh Git status");
    const base: WorkspaceDiff = { workspaceId: bound.workspaceId, path, comparison: comparison as GitComparison, ...(entry.originalPath ? { originalPath: entry.originalPath } : {}), before: null, after: null, beforeMode: null, afterMode: null, modeOnly: false };
    if (entry.conflict || entry.submodule || entry.renameOutsideWorkspace) return { ...base, reason: entry.conflict ? "conflict" : entry.submodule ? "submodule" : "rename-outside-workspace" };
    const full = (p: string) => git.prefix ? `${git.prefix}/${p}` : p;
    const beforePath = entry.originalPath && (comparison === "staged" ? ["R", "C"].includes(entry.index) : ["R", "C"].includes(entry.worktree)) ? entry.originalPath : path;
    this.lexical(bound, beforePath);
    try { await this.checked(bound, path, false, true); await this.checked(bound, beforePath, false, true); }
    catch (error) { if (error instanceof WorkspaceError && error.code === "symlink") return { ...base, reason: "symlink" }; throw error; }
    const before: Blob = comparison === "untracked" ? { bytes: Buffer.alloc(0), mode: null } : await this.blob(git, full(beforePath), comparison === "staged" ? "head" : "index");
    const after = comparison === "staged" ? await this.blob(git, full(path), "index") : await this.diskBlob(bound, path);
    await this.bind(sessionId, workspaceId);
    const left = decode(before.bytes), right = decode(after.bytes), reason = before.reason ?? after.reason ?? left.reason ?? right.reason;
    return { ...base, beforeMode: before.mode, afterMode: after.mode, before: reason ? null : left.text, after: reason ? null : right.text, modeOnly: !reason && !!before.mode && !!after.mode && before.mode !== after.mode && before.bytes.equals(after.bytes), ...(reason ? { reason } : {}) };
  }
}

/** Keep filesystem diagnostics and absolute protected paths out of API errors. */
export function workspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  if (error instanceof WorkspaceIgnoreError) return new WorkspaceError(error.status, error.code, error.message);
  if (error instanceof SyntaxError) return new WorkspaceError(400, "invalid-request", "Invalid JSON request body");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new WorkspaceError(404, "path-missing", "Path no longer exists");
  if (code === "EACCES" || code === "EPERM") return new WorkspaceError(403, "access-denied", "Filesystem access denied");
  if (code === "ELOOP") return new WorkspaceError(403, "symlink", "Symlink traversal is not supported");
  if (code === "EEXIST") return new WorkspaceError(409, "path-exists", "Destination already exists; choose a different path");
  return new WorkspaceError(503, "workspace-unavailable", "Workspace operation is unavailable");
}
