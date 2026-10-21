import { constants } from "node:fs";
import { lstat, realpath, open, readlink, mkdir, rename, unlink, opendir, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CatalogService } from "./catalog";
import { WorkspaceError, WorkspaceService } from "./workspace";
import type { GitEntry } from "./workspace-contract";
import type { GitOperationInput, GitOperationResult, GitOperationsState } from "./git-operations-contract";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024, CONTENT_LIMIT = 64 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => { const r = relative(root, path); return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`); };
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
const text = (value: Buffer) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { return fail(422, "git-path-encoding", "Git metadata contains unsupported non-UTF-8 text"); } };
const line = (value: Buffer) => text(value).replace(/\n$/, "");
const oid = (value: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const remoteName = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const branchName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.startsWith("-");

type Binding = Awaited<ReturnType<CatalogService["binding"]>>;
type IndexEntry = { mode: string; oid: string; stage: string };
type Content = { token: string; bytes?: Buffer; mode?: string; missing?: boolean; unsupported?: string };
type Capture = { state: GitOperationsState; binding: Binding; gitDir?: string; index: Map<string, IndexEntry>; tree: Map<string, IndexEntry>; staged: string[]; contents: Map<string, Content>; config: string; pushUrls: Map<string, string[]> };
type Receipt = { version: 1; fingerprint: string; result: GitOperationResult };
type GitPhase = "review" | "preparation" | "commit" | "push" | "stage" | "unstage";
const diagnosticMessages = {
  "reviewed-tree-changed": "The commit review guard rejected changed HEAD or staged contents after hooks. Review HEAD and the index again; no automatic retry was attempted.",
  "node-runtime-unavailable": "Hook output indicates that Node.js could not start. Repair the Node.js runtime before considering another commit attempt.",
  "hook-rejected": "A Git hook rejected the operation. Resolve the hook failure before considering another attempt.",
  "index-locked": "Git reported an existing index lock. Check for another Git process before resolving the lock; do not remove an active lock.",
  "identity-unavailable": "Git reported missing or invalid author/committer identity. Check the repository's Git identity configuration.",
  "signing-failed": "Git reported a commit signing failure. Check the signing configuration and signing agent.",
} as const;
type GitDiagnostics = { phase: GitPhase; exitCode: number | null; signal: string | null; timedOut: boolean; outputLimited: boolean; reason?: keyof typeof diagnosticMessages };
type GitResult = { code: number; bytes: Buffer; diagnostics: GitDiagnostics };
type GitExecute = (args: string[], bytes?: Buffer, phase?: GitPhase) => Promise<GitResult>;
type HookGuard = { action: "commit"; tree: string } | { action: "push"; remote: string; urlHash: string };
class GitExecutionError extends Error {
  constructor(public started: boolean, public uncertain: boolean, public diagnostics?: GitDiagnostics) { super("Git execution did not complete"); }
}

// Inspect only bounded, ephemeral stderr. Neither raw output nor matched text
// leaves this function; receipts/browser messages use these fixed strings only.
function diagnosticReason(stderr: string): GitDiagnostics["reason"] {
  if (stderr.includes("Commit stopped: HEAD or staged contents changed after review. Review the index again.")) return "reviewed-tree-changed";
  if ((/(?:library not loaded|error while loading shared libraries):/i.test(stderr) && /(?:^|[\/\s])node(?:[\/\s:]|$)/im.test(stderr)) || /(?:env: (?:node|['"]node['"]): (?:No such file or directory|not found)|\bnode: (?:command not found|not found))/i.test(stderr)) return "node-runtime-unavailable";
  if (/Author identity unknown|Committer identity unknown|unable to auto-detect email address|empty ident name|no (?:name|email) was given/i.test(stderr)) return "identity-unavailable";
  if (/(?:gpg|ssh-keygen) failed to sign (?:the )?data|failed to sign the commit|Couldn't load public key|No private key found|Signing file .* failed/i.test(stderr)) return "signing-failed";
  if (/Unable to create '[^\r\n]*index\.lock': File exists/i.test(stderr)) return "index-locked";
  if (stderr.includes("SANE Git hook rejected the operation.")) return "hook-rejected";
}
function diagnosticMessage(diagnostics?: GitDiagnostics): string {
  if (!diagnostics) return "";
  const messages: string[] = [];
  if (diagnostics.reason) messages.push(diagnosticMessages[diagnostics.reason]);
  if (diagnostics.timedOut) messages.push("Git exceeded its execution time limit and was stopped.");
  if (diagnostics.outputLimited) messages.push("Git exceeded its output safety limit and was stopped.");
  if (diagnostics.signal && !diagnostics.timedOut && !diagnostics.outputLimited) messages.push("The Git process was terminated by a signal.");
  return messages.length ? ` ${messages.join(" ")}` : "";
}

// Shared across service instances. Linked worktrees share refs, configuration,
// hooks and objects, so serialize the entire repository, not only its index.
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

/** A separate executor from WorkspaceService's deliberately hermetic reader.
 * Keep HOME, normal Git config, identity, signing, hooks and credential/SSH
 * agents. Never inherit repository/index/config/transport injection through
 * GIT_*; all remaining GIT settings below are fixed by this implementation.
 * SSH limitation: use batch-mode OpenSSH with the user's ~/.ssh/config and
 * agent. Custom core.sshCommand and inherited GIT_SSH/GIT_SSH_COMMAND are not
 * honored: safely adding noninteractive options to arbitrary commands would
 * require a broader transport adapter. Do not claim arbitrary SSH wrappers work.
 * stdout/stderr are bounded and NEVER returned to the browser (hooks and remote
 * errors routinely contain tokens, signed URLs and private server diagnostics).
 */
async function git(cwd: string, args: string[], options: { input?: Buffer; mutation?: boolean; timeout?: number; gitDir?: string; phase?: GitPhase; onStarted?: () => void } = {}): Promise<GitResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^GIT_/i.test(key) && !/^(SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GCM_INTERACTIVE|GPG_TTY)$/i.test(key)) env[key] = value;
  Object.assign(env, {
    LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes", GIT_OPTIONAL_LOCKS: options.mutation ? "1" : "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
  });
  const diagnostics: GitDiagnostics = { phase: options.phase ?? "review", exitCode: null, signal: null, timedOut: false, outputLimited: false };
  let child;
  try {
    child = Bun.spawn(["git", "--no-pager", "--literal-pathspecs", ...(options.gitDir ? [`--git-dir=${options.gitDir}`, `--work-tree=${cwd}`] : []), "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...args], {
      cwd, env, detached: true, stdin: options.input ?? "ignore", stdout: "pipe", stderr: "pipe",
    });
  } catch { throw new GitExecutionError(false, false, diagnostics); }
  options.onStarted?.();
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} };
  let total = 0, interrupted = false, stderr = Buffer.alloc(0);
  const collect = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.length;
        if (!keep) {
          stderr = Buffer.concat([stderr, value.subarray(Math.max(0, value.length - STDERR_LIMIT))]).subarray(-STDERR_LIMIT);
          const reason = diagnosticReason(stderr.toString("utf8"));
          // Keep the most useful evidence even if later output rolls it away.
          if (reason && (diagnostics.reason === undefined || diagnostics.reason === "hook-rejected" || reason === "reviewed-tree-changed")) diagnostics.reason = reason;
        }
        if (total > OUTPUT_LIMIT) { diagnostics.outputLimited = true; interrupted = true; kill(); throw new GitExecutionError(true, true, diagnostics); }
        if (keep) chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally { reader.releaseLock(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = child.exited.then(code => { diagnostics.exitCode = code; diagnostics.signal = child.signalCode; return code; });
  const stdoutCollected = collect(child.stdout, true), stderrCollected = collect(child.stderr, false);
  const work = Promise.all([exited, stdoutCollected, stderrCollected]);
  // Observe all cleanup promises before releasing the repository's queue.
  try {
    const [code, bytes] = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { diagnostics.timedOut = true; interrupted = true; kill(); reject(new GitExecutionError(true, true, diagnostics)); }, options.timeout ?? (options.mutation ? 60000 : 8000));
    })]);
    if (interrupted) throw new GitExecutionError(true, true, diagnostics);
    return { code, bytes, diagnostics };
  } catch (error) { throw error instanceof GitExecutionError ? error : new GitExecutionError(true, true, diagnostics); }
  finally { clearTimeout(timer); kill(); await Promise.allSettled([work, exited, stdoutCollected, stderrCollected]); }
}

function parseIndex(bytes: Buffer, tree = false): Map<string, IndexEntry> {
  const result = new Map<string, IndexEntry>();
  for (const row of text(bytes).split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t"), parts = row.slice(0, tab).split(" "), path = row.slice(tab + 1);
    const [mode, object, stage] = tree ? [parts[0], parts[2], "0"] : parts;
    if (tab < 0 || !mode || !object || !oid(object) || !stage || !/^[0-3]$/.test(stage) || result.has(path)) fail(409, "git-index-unsupported", "The index has conflicts or unsupported metadata");
    result.set(path, { mode, oid: object, stage });
  }
  return result;
}

function redactUrl(value: string): string {
  if (!supportedPushUrl(value) || value.length > 4096) return "[unsupported push URL]";
  try {
    const url = new URL(value);
    if (url.username || url.password) { url.username = "redacted"; url.password = ""; }
    url.search = ""; url.hash = "";
    return url.toString();
  } catch {
    // scp-like SSH URLs can have a username but no password. Redact userinfo
    // anyway, and never expose query/fragment credential conventions.
    return value.replace(/^[^/@:]+@/, "redacted@").split(/[?#]/, 1)[0]!;
  }
}
function supportedPushUrl(value: string): boolean {
  if (/[\x00-\x20\x7f]/.test(value)) return false;
  if (value.includes("://")) return /^(https?|ssh|git):\/\//.test(value);
  return /^(?:[^/@:\s]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:(?!:).+/.test(value);
}

/** Direct UI Git operations only. Receipts survive restart: a reserved request
 * whose final receipt could not be written is permanently "unknown", NEVER
 * replayed. Receipts contain no commit messages, file bytes or raw Git output;
 * diagnostic messages come only from the fixed allowlist above.
 * The bridge's existing single data-directory owner protects this store.
 */
export class GitOperationsService {
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private inflight = new Map<string, { fingerprint: string; promise: Promise<GitOperationResult> }>();
  private completed = new Map<string, Receipt>();
  constructor(private catalog: CatalogService, private worktrees: WorkspaceService, private dataDir: string, private protectedPaths: () => readonly string[] = () => []) {}

  close(): Promise<void> { this.closed = true; return Promise.allSettled([...this.active]).then(() => {}); }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorkspaceError(503, "git-shutdown", "Git operations are shutting down"));
    const promise = operation(); this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  private async bind(workspaceId: string, worktreeId: string, revision: unknown): Promise<Binding> {
    if (typeof revision !== "string" || !revision) fail(400, "binding-required", "Resolve the worktree before using Git");
    const binding = await this.catalog.binding(workspaceId, worktreeId);
    if (binding.bindingRevision !== revision) fail(409, "binding-invalid", "The worktree binding changed; refresh it");
    this.catalog.assertBinding(workspaceId, worktreeId, binding.cwd, binding.bindingRevision);
    return { ...binding, protectedPaths: [...binding.protectedPaths, ...this.protectedPaths(), await realpath(this.dataDir)] };
  }
  private path(binding: Binding, path: unknown): string {
    if (typeof path !== "string" || !path || path.length > 4096 || isAbsolute(path) || /[\0\\]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".." || [".git", ".sane"].includes(p.toLowerCase()))) fail(403, "git-path-forbidden", "Git operations require exact, unprotected worktree-relative files");
    const target = resolve(binding.cwd, path);
    if (!inside(binding.cwd, target) || binding.protectedPaths.some(root => inside(root, target))) fail(403, "git-path-forbidden", "A Git path is protected");
    return target;
  }
  private async content(binding: Binding, path: string, budget: { bytes: number }, deadline: number): Promise<Content> {
    this.path(binding, path);
    let cursor = binding.cwd;
    for (const part of path.split("/")) {
      if (Date.now() >= deadline) fail(504, "git-snapshot-limit", "Git snapshot exceeded its time budget");
      cursor = join(cursor, part);
      let info;
      try { info = await lstat(cursor); }
      catch (error: any) { if (error?.code === "ENOENT") return { token: "missing", missing: true }; throw error; }
      if (info.isSymbolicLink()) return { token: hash(JSON.stringify(["symlink", info.dev, info.ino, info.ctimeMs, await readlink(cursor)])), unsupported: "Symbolic links and symlink traversal are not supported" };
      if (await realpath(cursor) !== cursor) fail(409, "git-path-changed", "A Git path changed during review");
      if (cursor !== resolve(binding.cwd, path)) {
        if (!info.isDirectory()) return { token: "non-directory", unsupported: "A parent path is not a directory" };
        continue;
      }
      const meta = [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs];
      if (!info.isFile() || info.nlink !== 1) return { token: hash(JSON.stringify(meta)), unsupported: "Only regular, single-link files are supported" };
      if (info.size > FILE_LIMIT || budget.bytes + info.size > CONTENT_LIMIT) return { token: hash(JSON.stringify(meta)), unsupported: "File content exceeds the Git staging snapshot budget" };
      const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (before.dev !== info.dev || before.ino !== info.ino || !before.isFile() || before.nlink !== 1) fail(409, "git-path-changed", "A Git file changed while reading");
        const bytes = Buffer.alloc(info.size + 1); let used = 0;
        while (used < bytes.length) { if (Date.now() >= deadline) fail(504, "git-snapshot-limit", "Git snapshot exceeded its time budget"); const r = await handle.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
        const after = await handle.stat(), final = await lstat(cursor);
        if (used !== info.size || [after, final].some(s => s.dev !== info.dev || s.ino !== info.ino || s.nlink !== 1 || s.size !== info.size || s.mode !== info.mode || s.mtimeMs !== info.mtimeMs || s.ctimeMs !== info.ctimeMs)) fail(409, "git-path-changed", "A Git file changed while reading");
        budget.bytes += used;
        const content = bytes.subarray(0, used);
        return { bytes: content, mode: info.mode & 0o111 ? "100755" : "100644", token: hash(JSON.stringify(meta) + "\0" + hash(content)) };
      } finally { await handle.close(); }
    }
    return fail(400, "invalid-path", "Choose an exact file");
  }

  private async indexToken(root: string, gitDir: string): Promise<string> {
    const result = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { gitDir });
    if (result.code) fail(503, "git-index-unavailable", "Git index location is unavailable");
    const path = line(result.bytes);
    if (path !== join(gitDir, "index")) fail(409, "git-index-unsupported", "A nonstandard Git index location is unsupported");
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > FILE_LIMIT) fail(409, "git-index-unsupported", "The full Git index exceeds its safety budget or has an unsupported filesystem type");
      const bytes = Buffer.alloc(info.size + 1); let used = 0;
      while (used < bytes.length) { const r = await handle.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
      const after = await handle.stat(), current = await lstat(path);
      if (used !== info.size || [after, current].some(s => s.dev !== info.dev || s.ino !== info.ino || s.nlink !== 1 || s.size !== info.size || s.mtimeMs !== info.mtimeMs || s.ctimeMs !== info.ctimeMs)) fail(409, "git-index-changed", "Git index changed while reviewing it");
      return hash(bytes.subarray(0, used));
    } catch (error: any) { if (error?.code === "ENOENT") return "missing"; throw error; }
    finally { await handle?.close(); }
  }

  private async capture(workspaceId: string, worktreeId: string, revision: string): Promise<Capture> {
    const deadline = Date.now() + 20000;
    const binding = await this.bind(workspaceId, worktreeId, revision), root = binding.cwd;
    const registered = await this.catalog.registered(workspaceId);
    const gitDir = registered.worktrees.find(t => t.worktreeId === worktreeId)?.gitDir ?? undefined;
    if (gitDir && !binding.protectedPaths.includes(gitDir)) fail(409, "binding-invalid", "Git administration binding changed");
    const read = async (args: string[], optional = false): Promise<GitResult> => {
      if (Date.now() >= deadline) fail(504, "git-snapshot-limit", "Git snapshot exceeded its time budget");
      try {
        const result = await git(root, args, { gitDir, timeout: Math.min(8000, Math.max(1, deadline - Date.now())) });
        if (result.code && !optional) fail(503, "git-review-unavailable", "Git review metadata is unavailable");
        return result;
      } catch (error) { if (error instanceof GitExecutionError) fail(503, "git-review-unavailable", "Git review could not finish within its safety limits"); throw error; }
    };
    const gitStatus = await this.worktrees.status(`${workspaceId}/${worktreeId}`, revision);
    const base = { workspaceId, worktreeId, bindingRevision: revision, root, branch: null, head: null, upstream: null, ahead: null, behind: null, remotes: [], git: gitStatus } satisfies Omit<GitOperationsState, "snapshot">;
    if (!gitStatus.available) return { state: { ...base, snapshot: hash(JSON.stringify(base)), blockedReason: gitStatus.reason ?? "Git is unavailable" }, binding, index: new Map(), tree: new Map(), staged: [], contents: new Map(), config: "", pushUrls: new Map() };
    if (!gitDir) fail(409, "binding-invalid", "Git worktree administration is not pinned");
    const top = line((await read(["rev-parse", "--show-toplevel"])).bytes);
    if (await realpath(top) !== root) fail(403, "git-scope", "Only a complete pinned Git worktree is supported");
    const symbolic = await read(["symbolic-ref", "--quiet", "HEAD"], true);
    const fullRef = symbolic.code === 0 ? line(symbolic.bytes) : null;
    const branch = fullRef?.startsWith("refs/heads/") ? fullRef.slice(11) : null;
    const headResult = await read(["rev-parse", "--verify", "--quiet", "HEAD"], true);
    const head = headResult.code === 0 ? line(headResult.bytes) : null;
    if (head && !oid(head)) fail(503, "git-head-unavailable", "Git HEAD could not be verified");
    if (!head && (!fullRef || (await read(["show-ref", "--verify", "--quiet", fullRef], true)).code !== 1)) fail(503, "git-head-unavailable", "Git HEAD is not a verified unborn branch");
    const indexBytes = (await read(["ls-files", "--stage", "-z"])).bytes;
    if (line((await read(["rev-parse", "--absolute-git-dir"])).bytes) !== gitDir) fail(409, "binding-invalid", "Git administration binding changed");
    const indexToken = await this.indexToken(root, gitDir);
    // Conflict stages can duplicate a path; report a global block, not an
    // apparently committable partial index.
    let index = new Map<string, IndexEntry>(), indexProblem: string | undefined;
    try { index = parseIndex(indexBytes); } catch { indexProblem = "The index has unresolved conflicts or unsupported entries"; }
    const indexFlags = (await read(["ls-files", "-v", "-z"])).bytes;
    const treeBytes = head ? (await read(["ls-tree", "-r", "-z", head])).bytes : Buffer.alloc(0);
    const tree = parseIndex(treeBytes, true);
    const stagedBytes = (await read(["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=none", "--"])).bytes;
    const staged = text(stagedBytes).split("\0").filter(Boolean);
    const configBytes = (await read(["config", "--null", "--list"])).bytes;
    const config = hash(configBytes);
    const pushUrls = new Map<string, string[]>(), remotes: GitOperationsState["remotes"] = [];
    for (const name of line((await read(["remote"])).bytes).split("\n").filter(Boolean)) {
      if (!remoteName(name)) continue;
      const urls = line((await read(["remote", "get-url", "--push", "--all", name])).bytes).split("\n").filter(Boolean);
      pushUrls.set(name, urls); remotes.push({ name, url: urls.map(redactUrl).join(" · ") });
    }
    const upstreamResult = branch ? await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true) : null;
    const upstream = upstreamResult?.code === 0 ? line(upstreamResult.bytes) : null;
    let ahead: number | null = null, behind: number | null = null;
    if (head && upstream) {
      const counts = await read(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], true);
      const match = /^(\d+)\s+(\d+)\s*$/.exec(text(counts.bytes));
      if (!counts.code && match) { ahead = Number(match[1]); behind = Number(match[2]); }
    }
    let blockedReason = indexProblem ?? (!branch ? "Detached HEAD is read-only in this Git UI" : undefined);
    if (gitStatus.truncated) blockedReason = "Git status is truncated; mutations require a complete review";
    if (gitStatus.entries.some(e => e.conflict || e.submodule || e.renameOutsideWorkspace)) blockedReason = "Conflicts, submodules and out-of-scope renames must be handled outside this Git UI";
    if ([...index.values()].some(e => e.stage !== "0" || e.mode === "040000")) blockedReason = "Sparse indexes and conflicted indexes are read-only in this Git UI";
    const visibleStaged = new Set(gitStatus.entries.filter(e => e.comparisons.includes("staged")).flatMap(e => [e.path, ...(e.originalPath ? [e.originalPath] : [])]));
    for (const path of staged) {
      try { this.path(binding, path); } catch { blockedReason = "The index contains protected staged paths; no mutation is allowed"; continue; }
      if (!visibleStaged.has(path)) blockedReason = "The index contains undisplayed staged changes; refresh or use Git outside this UI";
      if ([index.get(path), tree.get(path)].some(e => e && !["100644", "100755"].includes(e.mode))) blockedReason = "Staged symlinks and non-regular files are not supported";
    }
    // Never implicitly finish a merge/rebase/cherry-pick or other sequencer.
    const operationMarkers: string[] = [];
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
      try { await lstat(join(gitDir, marker)); operationMarkers.push(marker); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    if (operationMarkers.length) blockedReason = "A Git merge, rebase or sequencer is active; finish it outside this UI";
    const contents = new Map<string, Content>(), budget = { bytes: 0 };
    for (const path of [...new Set(gitStatus.entries.flatMap(e => [e.path, ...(e.originalPath ? [e.originalPath] : [])]))].sort()) contents.set(path, await this.content(binding, path, budget, deadline));
    const after = await this.bind(workspaceId, worktreeId, revision);
    if (after.cwd !== root || JSON.stringify(after.protectedPaths) !== JSON.stringify(binding.protectedPaths)) fail(409, "binding-invalid", "Git protection changed during review");
    // HEAD/index/config are fenced again AFTER byte capture. The fingerprint
    // includes the full logical index (not just displayed paths), index flags,
    // actual HEAD, user Git config and captured worktree metadata + bytes.
    const finalHead = await read(["rev-parse", "--verify", "--quiet", "HEAD"], true);
    const finalSymbolic = await read(["symbolic-ref", "--quiet", "HEAD"], true);
    const finalIndex = (await read(["ls-files", "--stage", "-z"])).bytes;
    const finalIndexFlags = (await read(["ls-files", "-v", "-z"])).bytes;
    const finalConfig = (await read(["config", "--null", "--list"])).bytes;
    const finalStatus = await this.worktrees.status(`${workspaceId}/${worktreeId}`, revision);
    if (!headResult.bytes.equals(finalHead.bytes) || headResult.code !== finalHead.code || !symbolic.bytes.equals(finalSymbolic.bytes) || symbolic.code !== finalSymbolic.code || !indexBytes.equals(finalIndex) || !indexFlags.equals(finalIndexFlags) || indexToken !== await this.indexToken(root, gitDir) || !configBytes.equals(finalConfig) || JSON.stringify(gitStatus) !== JSON.stringify(finalStatus)) fail(409, "git-snapshot-changed", "Git changed during review; refresh before continuing");
    this.catalog.assertBinding(workspaceId, worktreeId, root, revision);
    const snapshot = hash(JSON.stringify([revision, root, fullRef, head, indexToken, hash(indexBytes), hash(indexFlags), hash(treeBytes), hash(stagedBytes), config, gitStatus, [...contents].map(([path, c]) => [path, c.token]), operationMarkers, remotes, upstream, ahead, behind]));
    return { state: { ...base, branch, head, upstream, ahead, behind, remotes, snapshot, ...(blockedReason ? { blockedReason } : {}) }, binding, gitDir, index, tree, staged, contents, config, pushUrls };
  }

  get(workspaceId: string, worktreeId: string, revision: unknown): Promise<GitOperationsState> {
    return this.track(async () => {
      const binding = await this.bind(workspaceId, worktreeId, revision);
      const repo = await this.catalog.registered(workspaceId);
      return serialized(repo.commonDir ?? binding.cwd, async () => (await this.capture(workspaceId, worktreeId, binding.bindingRevision)).state);
    });
  }

  private validate(input: unknown): GitOperationInput {
    const i = input as GitOperationInput;
    if (!i || typeof i !== "object" || typeof i.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(i.requestId) || typeof i.bindingRevision !== "string" || !i.bindingRevision || typeof i.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(i.snapshot)) fail(400, "invalid-git-operation", "A request ID, binding revision and reviewed Git snapshot are required");
    if (i.action === "stage" || i.action === "unstage") {
      if (!Array.isArray(i.paths) || !i.paths.length || i.paths.length > 2000 || i.paths.some(p => typeof p !== "string") || new Set(i.paths).size !== i.paths.length) fail(400, "invalid-git-paths", "Choose distinct whole files from Git status");
      return { requestId: i.requestId, bindingRevision: i.bindingRevision, snapshot: i.snapshot, action: i.action, paths: [...i.paths] };
    }
    if (i.action === "commit") {
      if (typeof i.message !== "string" || !i.message.trim() || Buffer.byteLength(i.message) > 65536 || /\0/.test(i.message) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(i.message)) fail(400, "invalid-commit-message", "Enter a nonempty commit message of at most 64 KiB");
      return { requestId: i.requestId, bindingRevision: i.bindingRevision, snapshot: i.snapshot, action: i.action, message: i.message };
    }
    if (i.action === "push") {
      if (!remoteName(i.remote) || !branchName(i.branch) || typeof i.setUpstream !== "boolean") fail(400, "invalid-push-target", "Choose an explicit remote and local branch");
      return { requestId: i.requestId, bindingRevision: i.bindingRevision, snapshot: i.snapshot, action: i.action, remote: i.remote, branch: i.branch, setUpstream: i.setUpstream };
    }
    return fail(400, "invalid-git-action", "Unsupported Git operation");
  }

  private async receiptDirectory(): Promise<string> {
    const data = await realpath(this.dataDir), directory = join(data, "git-operation-receipts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) fail(503, "git-receipt-unavailable", "Git request receipts are unavailable; no mutation was admitted");
    return directory;
  }
  private async readReceipt(id: string): Promise<Receipt | undefined> {
    const cached = this.completed.get(id); if (cached) return cached;
    const path = join(await this.receiptDirectory(), `${hash(id)}.json`);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new Error();
      const receipt = JSON.parse(await handle.readFile("utf8")) as Receipt;
      if (receipt.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || receipt.result.requestId !== id || !["stage", "unstage", "commit", "push"].includes(receipt.result.action) || !["succeeded", "failed", "unknown"].includes(receipt.result.outcome) || typeof receipt.result.message !== "string") throw new Error();
      return receipt;
    } catch (error: any) { if (error?.code === "ENOENT") return undefined; return fail(503, "git-receipt-unavailable", "A Git request receipt is unreadable; do not retry the mutation with a new ID"); }
    finally { await handle?.close(); }
  }
  private async writeReceipt(id: string, receipt: Receipt, initial: boolean): Promise<void> {
    const directory = await this.receiptDirectory(), path = join(directory, `${hash(id)}.json`), temporary = join(directory, `${hash(id)}.${randomUUID()}.tmp`);
    const target = initial ? path : temporary;
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
      if (!initial) await rename(temporary, path);
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { if (!initial) await unlink(temporary).catch(() => {}); }
  }

  run(workspaceId: string, worktreeId: string, raw: unknown, authorized: () => boolean = () => true): Promise<GitOperationResult> {
    const input = this.validate(raw), fingerprint = hash(JSON.stringify([workspaceId, worktreeId, input]));
    const pending = this.inflight.get(input.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new WorkspaceError(409, "git-request-id-reused", "This Git request ID already belongs to another operation"));
      return pending.promise;
    }
    const promise = this.track(async () => {
      const prior = await this.readReceipt(input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "git-request-id-reused", "This Git request ID already belongs to another operation");
        return prior.result;
      }
      const binding = await this.bind(workspaceId, worktreeId, input.bindingRevision), repo = await this.catalog.registered(workspaceId);
      return serialized(repo.commonDir ?? binding.cwd, async () => {
        if (this.closed || !authorized()) fail(401, "git-authorization-changed", "Git mutation authorization is no longer available");
        const review = await this.capture(workspaceId, worktreeId, input.bindingRevision);
        if (review.state.snapshot !== input.snapshot) fail(409, "git-snapshot-changed", "Git changed since review; refresh before continuing");
        if (review.state.blockedReason) fail(409, "git-operation-blocked", review.state.blockedReason);
        const plan = await this.plan(review, input);
        if (this.closed || !authorized()) fail(401, "git-authorization-changed", "Git mutation authorization is no longer available");
        this.catalog.assertBinding(workspaceId, worktreeId, review.binding.cwd, input.bindingRevision);
        const result: GitOperationResult = { requestId: input.requestId, action: input.action, outcome: "unknown", message: "This Git request was admitted but its final result is unavailable. Refresh and inspect Git before any new mutation; this request will not be replayed." };
        const receipt: Receipt = { version: 1, fingerprint, result };
        try { await this.writeReceipt(input.requestId, receipt, true); }
        catch { fail(503, "git-receipt-unavailable", "Git request reservation failed; no mutation was started. Reuse this request ID to inspect its receipt"); }
        let started = false, commitAttempted = false;
        try {
          // Persisting a receipt is an await. Revalidate the complete review and
          // authority once more before the FIRST write, not just its binding.
          const fresh = await this.capture(workspaceId, worktreeId, input.bindingRevision);
          if (fresh.state.snapshot !== input.snapshot) fail(409, "git-snapshot-changed", "Git changed before execution; refresh before continuing");
          if (this.closed || !authorized()) fail(401, "git-authorization-changed", "Git mutation authorization is no longer available");
          this.catalog.assertBinding(workspaceId, worktreeId, review.binding.cwd, input.bindingRevision);
          const executionDeadline = Date.now() + 60000;
          const execute: GitExecute = async (args, bytes, phase = input.action === "commit" ? "preparation" : input.action) => {
            const remaining = executionDeadline - Date.now();
            if (remaining <= 0) throw new GitExecutionError(started, true, { phase, exitCode: null, signal: null, timedOut: true, outputLimited: false });
            const response = await git(review.binding.cwd, args, {
              gitDir: review.gitDir, input: bytes, mutation: true, timeout: remaining, phase,
              onStarted: () => { started = true; if (phase === "commit") commitAttempted = true; },
            });
            if (response.code || response.diagnostics.signal) throw new GitExecutionError(true, phase === "commit" || phase === "push", response.diagnostics);
            return response;
          };
          await plan(execute);
          result.outcome = "succeeded";
          result.message = input.action === "stage" ? "Selected whole files staged." : input.action === "unstage" ? "Selected whole files unstaged; working files were not changed." : input.action === "commit" ? "Commit created from the existing index." : "Push completed.";
        } catch (error) {
          // Native nonzero commit can involve hooks; never automatically repeat
          // it. Push transport failures can happen AFTER the remote accepted it.
          const notAttempted = input.action === "commit" ? !commitAttempted : !started || (error instanceof GitExecutionError && !error.started);
          result.outcome = notAttempted ? "failed" : "unknown";
          result.message = input.action === "commit" && notAttempted
            ? `Commit was not attempted; preparation failed before Git commit launched.${error instanceof WorkspaceError ? ` ${error.message}` : ""} Refresh and review HEAD and the index before another attempt.`
            : !started && error instanceof WorkspaceError ? error.message : input.action === "push"
            ? "Push was not confirmed. Credentials, network, remote rejection or hooks may be responsible; inspect local and remote state before retrying. No pull, rebase or force push was attempted."
            : input.action === "commit" ? "Commit was not confirmed. Check Git identity, hooks and signing, then inspect HEAD and the index before retrying."
            : "Git index update was not confirmed. Refresh and inspect the index before retrying.";
          if (error instanceof GitExecutionError) result.message += diagnosticMessage(error.diagnostics);
          if (input.action === "push" && review.pushUrls.get(input.remote)?.some(url => url.startsWith("ssh://") || !url.includes("://"))) result.message += " SSH uses batch-mode OpenSSH with ~/.ssh/config and your SSH agent; custom core.sshCommand and GIT_SSH overrides are unsupported.";
        }
        // Store the confirmed outcome BEFORE readback. A failed status refresh
        // must never turn a known successful write into a failed mutation.
        this.completed.set(input.requestId, structuredClone(receipt));
        try { await this.writeReceipt(input.requestId, receipt, false); }
        catch { result.message += " The final receipt could not be saved; after restart this request remains unknown and is never automatically replayed."; }
        try {
          if (!authorized()) throw new Error("Authorization changed after mutation");
          result.state = (await this.capture(workspaceId, worktreeId, input.bindingRevision)).state;
          if (!authorized()) { delete result.state; throw new Error("Authorization changed during readback"); }
          if (input.action === "commit" && result.outcome === "succeeded" && result.state.head) result.commit = result.state.head;
        } catch { result.message += " Git status readback is unavailable; refresh before continuing."; }
        // Keep only compact receipts on disk/in memory. A repeated ID returns
        // the original result, never a fresh mutation or a misleading new state.
        const compact = { ...result }; delete compact.state;
        this.completed.set(input.requestId, { version: 1, fingerprint, result: compact });
        try { await this.writeReceipt(input.requestId, { version: 1, fingerprint, result: compact }, false); } catch { /* Initial unknown receipt remains a safe restart barrier. */ }
        return result;
      });
    });
    this.inflight.set(input.requestId, { fingerprint, promise });
    void promise.finally(() => { if (this.inflight.get(input.requestId)?.promise === promise) this.inflight.delete(input.requestId); }).catch(() => {});
    return promise;
  }

  private async plan(review: Capture, input: GitOperationInput): Promise<(execute: GitExecute) => Promise<void>> {
    if (input.action === "stage" || input.action === "unstage") {
      const paths = new Set<string>();
      for (const path of input.paths) {
        this.path(review.binding, path);
        const entry = review.state.git.entries.find(e => e.path === path);
        if (!entry || (input.action === "unstage" ? !entry.comparisons.includes("staged") : !entry.comparisons.some(c => c === "unstaged" || c === "untracked"))) fail(409, "git-path-changed", "A selected comparison is no longer available");
        this.checkEntry(review, entry);
        paths.add(path);
        // A staged rename's source is already removed from the index. When
        // restaging its modified destination, do not accidentally add a newly
        // recreated/untracked file at the old name. Copy sources never mutate.
        if (entry.originalPath && (input.action === "unstage" ? entry.index === "R" : entry.worktree === "R")) paths.add(entry.originalPath);
      }
      const operands = [...paths].sort();
      for (const path of operands) {
        this.path(review.binding, path);
        const content = review.contents.get(path);
        if (!content || content.unsupported) fail(422, "git-file-unsupported", content?.unsupported ?? "A selected file has no reviewed content");
        if ([review.index.get(path), review.tree.get(path)].some(e => e && !["100644", "100755"].includes(e.mode))) fail(422, "git-file-unsupported", "Symlinks, submodules and non-regular index entries are unsupported");
      }
      const coreMode = input.action === "stage" ? await git(review.binding.cwd, ["config", "--bool", "core.filemode"], { gitDir: review.gitDir }) : null;
      const preserveMode = coreMode?.code === 0 && line(coreMode.bytes) === "false";
      return async execute => {
        const records: string[] = [];
        const zero = "0".repeat(review.state.head?.length ?? [...review.index.values()][0]?.oid.length ?? 40);
        for (const path of operands) {
          if (input.action === "unstage") {
            const original = review.tree.get(path);
            records.push(original ? `${original.mode} ${original.oid}\t${path}\0` : `0 ${zero}\t${path}\0`);
          } else {
            const content = review.contents.get(path)!;
            if (content.missing) records.push(`0 ${zero}\t${path}\0`);
            else {
              // Hash exactly the reviewed bytes, including binary and files too
              // large for text preview. Never let `git add` reread mutable files.
              // --path applies the user's normal attributes/clean filters.
              const object = line((await execute(["hash-object", "-w", "--stdin", `--path=${path}`], content.bytes)).bytes);
              if (!oid(object)) throw new GitExecutionError(true, true);
              const mode = preserveMode ? review.index.get(path)?.mode ?? "100644" : content.mode;
              records.push(`${mode} ${object}\t${path}\0`);
            }
          }
        }
        // One Git index lock / atomic rewrite for every rename endpoint. An
        // unborn HEAD means removal from the index, never reset/checkout files.
        await execute(["update-index", "--add", "--remove", "-z", "--index-info"], Buffer.from(records.join("")));
      };
    }
    if (input.action === "commit") {
      if (!review.staged.length) fail(409, "git-index-empty", "Stage at least one change before committing");
      if (/[\s\0]/.test(process.execPath)) fail(422, "git-hook-guard-unavailable", "The runtime executable path cannot be used by the commit review guard");
      // No -a, path operands, amend, generated messages or automatic staging.
      return async execute => { await this.commit(review, input.message, execute); };
    }
    if (input.action !== "push") return fail(400, "invalid-git-action", "Unsupported Git operation");
    if (input.branch !== review.state.branch || !review.state.head) fail(409, "git-push-branch-changed", "Push requires the reviewed, checked-out local branch and an existing commit");
    const checked = await git(review.binding.cwd, ["check-ref-format", `refs/heads/${input.branch}`], { gitDir: review.gitDir });
    if (checked.code) fail(400, "invalid-push-branch", "The push branch is not a valid Git ref");
    const urls = review.pushUrls.get(input.remote);
    if (!urls || urls.length !== 1 || !supportedPushUrl(urls[0]!)) fail(422, "git-push-target-unsupported", "Choose a remote with exactly one HTTP(S), SSH or Git push URL");
    const mirror = await git(review.binding.cwd, ["config", "--bool", `remote.${input.remote}.mirror`], { gitDir: review.gitDir });
    if (mirror.code === 0 && line(mirror.bytes) === "true") fail(422, "git-push-mirror-unsupported", "Mirror remotes cannot be pushed from this UI");
    return async execute => {
      // Native pre-push stdin contains the ACTUAL immutable object IDs Git will
      // send, after ref resolution. Verify those IDs and the actual remote URL,
      // rather than merely checking HEAD before starting a network command.
      await this.withHooks(review, { action: "push", remote: input.remote, urlHash: hash(urls[0]!) }, async directory => {
        await execute(["-c", "push.autoSetupRemote=false", "-c", `core.hooksPath=${directory}`, "push", "--porcelain", "--no-force", "--no-follow-tags", "--recurse-submodules=no", ...(input.setUpstream ? ["--set-upstream"] : []), "--", input.remote, `refs/heads/${input.branch}:refs/heads/${input.branch}`]);
      });
    };
  }

  /** Run the user's actual hooks, with a final commit-msg guard AFTER the
   * original hook. Normal formatters/validators/signing still work, but a hook
   * that stages additional contents must stop for another UI review. Merely
   * checking the index before `git commit` would silently commit such changes.
   * The executor never invokes a shell: Git itself runs executable hook files
   * using its ordinary hook semantics (including original paths and argv).
   */
  private async commit(review: Capture, message: string, execute: GitExecute): Promise<void> {
    const root = review.binding.cwd;
    const tree = line((await execute(["write-tree"])).bytes);
    if (!oid(tree)) throw new GitExecutionError(true, true);
    const current = await git(root, ["ls-files", "--stage", "-z"], { gitDir: review.gitDir, phase: "preparation" });
    if (current.code) throw new GitExecutionError(true, false, current.diagnostics);
    if (JSON.stringify([...parseIndex(current.bytes)]) !== JSON.stringify([...review.index])) fail(409, "git-index-changed", "Staged contents changed after review. Review the index again; no automatic retry was attempted.");
    await this.withHooks(review, { action: "commit", tree }, async directory => {
      await execute(["-c", `core.hooksPath=${directory}`, "commit", "--file=-", "--cleanup=verbatim"], Buffer.from(message), "commit");
    });
  }

  private async withHooks(review: Capture, guard: HookGuard, action: (directory: string) => Promise<void>): Promise<void> {
    const root = review.binding.cwd;
    if (/[\s\0]/.test(process.execPath)) fail(422, "git-hook-guard-unavailable", "The runtime executable path cannot be used by the Git review guard");
    if (!review.gitDir) throw new GitExecutionError(false, false);
    // Ask the pinned repository BEFORE installing the temporary override. Git
    // resolves both shared linked-worktree hooks and configured core.hooksPath.
    const discovered = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { gitDir: review.gitDir, phase: "preparation" });
    if (discovered.code) throw new GitExecutionError(false, false, discovered.diagnostics);
    const originalHooks = line(discovered.bytes);
    if (!isAbsolute(originalHooks) || originalHooks.includes("\0")) throw new GitExecutionError(false, false);
    const directory = join(await this.receiptDirectory(), `hooks-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const names = new Set([guard.action === "commit" ? "commit-msg" : "pre-push"]);
    try {
      try {
        let scanned = 0;
        for await (const entry of await opendir(originalHooks)) {
          if (++scanned > 2000 || names.size > 128) fail(422, "git-hook-guard-unavailable", "The Git hooks directory exceeds its safety budget");
          if (/^[a-z][a-z-]{0,79}$/.test(entry.name)) names.add(entry.name);
        }
      }
      catch (error: any) { if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error; }
      for (const name of names) {
        const script = `#!${process.execPath}\n` +
          `const { spawnSync } = require('node:child_process');\n` +
          `const run = (args, stdio = 'inherit', input) => spawnSync('git', args, { cwd: ${JSON.stringify(root)}, env: process.env, stdio, input, timeout: 50000, maxBuffer: 65536 });\n` +
          (guard.action === "push" && name === "pre-push" ?
            `const input = require('node:fs').readFileSync(0);\n` +
            `const records = input.toString('utf8').split('\\n').filter(Boolean).map(line => line.split(' '));\n` +
            `if (input.length > 16384 || records.length > 1 || process.argv[2] !== ${JSON.stringify(guard.remote)} || require('node:crypto').createHash('sha256').update(process.argv[3] || '').digest('hex') !== ${JSON.stringify(guard.urlHash)} || records.some(fields => fields.length !== 4 || fields[0] !== ${JSON.stringify(`refs/heads/${review.state.branch}`)} || fields[1] !== ${JSON.stringify(review.state.head)} || fields[2] !== ${JSON.stringify(`refs/heads/${review.state.branch}`)})) { console.error('Push stopped: the actual branch, commit or remote changed after review.'); process.exit(1); }\n` : "") +
          `const hook = run(['-c', ${JSON.stringify(`core.hooksPath=${originalHooks}`)}, 'hook', 'run', '--ignore-missing', '--to-stdin=/dev/stdin', ${JSON.stringify(name)}, '--', ...process.argv.slice(2)]${guard.action === "push" && name === "pre-push" ? ", ['pipe', 'inherit', 'inherit'], input" : ""});\n` +
          `if (hook.error || hook.status !== 0) { console.error('SANE Git hook rejected the operation.'); process.exit(hook.status || 1); }\n` +
          (guard.action === "commit" && name === "commit-msg" ?
            `const head = run(['rev-parse', '--verify', '--quiet', 'HEAD'], 'pipe');\n` +
            `const branch = run(['symbolic-ref', '--quiet', 'HEAD'], 'pipe');\n` +
            `const tree = run(['write-tree'], 'pipe');\n` +
            `if (head.error || ![0, 1].includes(head.status) || branch.error || tree.error || (head.status === 0 ? head.stdout.toString().trim() : null) !== ${JSON.stringify(review.state.head)} || branch.status !== 0 || branch.stdout.toString().trim() !== ${JSON.stringify(`refs/heads/${review.state.branch}`)} || tree.status !== 0 || tree.stdout.toString().trim() !== ${JSON.stringify(guard.tree)}) { console.error('Commit stopped: HEAD or staged contents changed after review. Review the index again.'); process.exit(1); }\n` : "");
        const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
        try { await file.writeFile(script); } finally { await file.close(); }
      }
      await action(directory);
    } finally {
      // Cleanup only names created in this private directory, never a recursive
      // delete of user hook paths. Leftovers after a crash cannot replay a write.
      for (const name of names) await unlink(join(directory, name)).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
  private checkEntry(review: Capture, entry: GitEntry): void {
    if (entry.conflict || entry.submodule || entry.renameOutsideWorkspace) fail(422, "git-file-unsupported", "Conflicts, submodules and out-of-scope renames are unsupported");
    this.path(review.binding, entry.path);
    if (entry.originalPath) this.path(review.binding, entry.originalPath);
  }
}
