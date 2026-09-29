import { constants } from "node:fs";
import { open, lstat, realpath, opendir, access } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { WORKSPACE_MAX_BYTES, type Workspace, type WorkspaceList, type WorkspaceFile, type WorkspaceWrite, type WorkspaceGit, type GitEntry, type GitComparison, type WorkspaceDiff, type DiffReason } from "./workspace-contract";

export class WorkspaceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const MAX_ENTRIES = 2000, MAX_GIT_OUTPUT = 4 * 1024 * 1024;
type SessionLookup = (id: string) => { cwd: string; bindingRevision?: string; protectedPaths?: string[] } | undefined | Promise<{ cwd: string; bindingRevision?: string; protectedPaths?: string[] } | undefined>;
type Bound = Workspace & { data: string; dev: number; ino: number; protectedPaths: string[] };
type GitRoot = { root: string; prefix: string };
type Blob = { bytes: Buffer; mode: string | null; reason?: DiffReason };
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
  constructor(private lookup: SessionLookup, private dataDir: string) {}

  private async bound(sessionId: string): Promise<Bound> {
    const session = await this.lookup(sessionId);
    if (!session) fail(404, "unknown-session", "Unknown conversation");
    let root: string, data: string;
    try { [root, data] = await Promise.all([realpath(session.cwd), realpath(this.dataDir)]); }
    catch { return fail(404, "workspace-unavailable", "Conversation workspace is unavailable"); }
    const info = await lstat(root);
    if (!info.isDirectory() || root.split(sep).some(p => p.toLowerCase() === ".git") || inside(data, root)) fail(403, "workspace-forbidden", "Workspace is not accessible");
    const protectedPaths = session.protectedPaths ?? [];
    if (protectedPaths.some(path => inside(path, root))) fail(403, "workspace-forbidden", "Git administration directory is not accessible");
    return { sessionId, root, data, protectedPaths, dev: info.dev, ino: info.ino, maxFileBytes: WORKSPACE_MAX_BYTES, workspaceId: session.bindingRevision ?? hash(`${root}\0${info.dev}\0${info.ino}`) };
  }
  async resolve(sessionId: string): Promise<Workspace> {
    const { workspaceId, root, maxFileBytes } = await this.bound(sessionId);
    return { sessionId, workspaceId, root, maxFileBytes };
  }
  private async bind(sessionId: string, workspaceId: unknown): Promise<Bound> {
    if (typeof workspaceId !== "string" || !workspaceId) fail(400, "workspace-required", "Resolve the conversation workspace first");
    const bound = await this.bound(sessionId);
    if (bound.workspaceId !== workspaceId) fail(409, "workspace-changed", "Conversation workspace changed; resolve it again");
    return bound;
  }
  private lexical(bound: Bound, path: unknown, rootAllowed = false): string {
    if (typeof path !== "string" || path.length > 4096 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || (path === "" ? !rootAllowed : path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))) fail(400, "invalid-path", "Use an exact workspace-relative path");
    const target = resolve(bound.root, path);
    if (!inside(bound.root, target) || inside(bound.data, target) || bound.protectedPaths.some(path => inside(path, target))) fail(403, "path-forbidden", "Path is not accessible");
    return target;
  }
  private async checked(bound: Bound, path: string, rootAllowed = false, missing = false): Promise<string> {
    const target = this.lexical(bound, path, rootAllowed);
    await this.bind(bound.sessionId, bound.workspaceId);
    let cursor = bound.root;
    for (const part of path ? path.split("/") : []) {
      cursor = join(cursor, part);
      let info;
      try { info = await lstat(cursor); } catch (error: any) {
        if (missing && error.code === "ENOENT") return target;
        throw error;
      }
      if (info.isSymbolicLink()) fail(403, "symlink", "Symlink traversal is not supported");
      const canonical = await realpath(cursor);
      if (canonical !== cursor || !inside(bound.root, canonical) || inside(bound.data, canonical)) fail(403, "path-forbidden", "Path is not accessible");
    }
    return target;
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
  private async disk(bound: Bound, path: string, writable = false) {
    const target = await this.checked(bound, path);
    const handle = await open(target, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail(400, "not-file", "Only regular files are supported");
      // Shared inodes could alias protected data or paths outside the workspace.
      if (info.nlink !== 1) fail(403, "hardlink", "Hard-linked files are not supported");
      await this.checked(bound, path);
      const current = await lstat(target);
      if (current.dev !== info.dev || current.ino !== info.ino) fail(409, "file-changed", "File changed while opening");
      const bytes = Buffer.alloc(Math.min(info.size, WORKSPACE_MAX_BYTES) + 1);
      let used = 0;
      while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail(409, "file-changed", "File changed while reading");
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
  async write(sessionId: string, input: WorkspaceWrite): Promise<WorkspaceFile> {
    if (!input || typeof input.text !== "string" || typeof input.expectedRevision !== "string") fail(400, "invalid-write", "Expected text and expectedRevision");
    const bound = await this.bind(sessionId, input.workspaceId), target = this.lexical(bound, input.path);
    const previous = this.writes.get(target) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
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
    this.writes.set(target, next);
    try { return await next; } finally { if (this.writes.get(target) === next) this.writes.delete(target); }
  }

  async git(cwd: string, args: string[], limit = MAX_GIT_OUTPUT): Promise<{ code: number; bytes: Buffer; stderr: string }> {
    // Do not inherit GIT_DIR/WORK_TREE/INDEX_FILE, config injection, alternates,
    // pagers, credentials, or provider secrets. No shell, hooks, filters or textconv.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_ATTR_NOSYSTEM: "1" };
    let child;
    try { child = Bun.spawn(["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...args], { cwd, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch { return fail(503, "git-unavailable", "Git executable is unavailable"); }
    let total = 0;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { kill(); reject(new WorkspaceError(504, "git-timeout", "Git operation timed out")); }, 8000); });
    const collect = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
      const reader = stream.getReader(), chunks: Uint8Array[] = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { kill(); fail(413, "git-output-limit", "Git output exceeds the bounded response limit"); } if (keep) chunks.push(value); } }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    };
    try {
      const [code, bytes, stderr] = await Promise.race([Promise.all([child.exited, collect(child.stdout, true), collect(child.stderr, true)]), deadline]);
      return { code, bytes, stderr: stderr.toString("utf8") };
    } finally { clearTimeout(timer!); kill(); }
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
  if (error instanceof SyntaxError) return new WorkspaceError(400, "invalid-request", "Invalid JSON request body");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new WorkspaceError(404, "path-missing", "Path no longer exists");
  if (code === "EACCES" || code === "EPERM") return new WorkspaceError(403, "access-denied", "Filesystem access denied");
  if (code === "ELOOP") return new WorkspaceError(403, "symlink", "Symlink traversal is not supported");
  return new WorkspaceError(503, "workspace-unavailable", "Workspace operation is unavailable");
}
