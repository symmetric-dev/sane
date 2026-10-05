import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicAppRecord } from "./app-store";
import type { CatalogService } from "./catalog";
import type { RegistrationResponse, WorkspaceCreationInput } from "./catalog-contract";
import { uuid } from "./history";
import { WorkspaceError, WorkspaceService } from "./workspace";

type RecordEntry = WorkspaceCreationInput & { root: string; state: "started" | "completed" | "failed"; result?: RegistrationResponse; error?: string; status?: number; code?: string };
const within = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const failure = (status: number, code: string, message: string): never => { throw new WorkspaceError(status, code, message); };

/** Exclusive destinations and a durable request ledger. Incomplete attempts are
 * never adopted or rerun after restart. Parents are trusted local directories;
 * identity checks detect changes, not an atomic sandbox against external swaps. */
export class WorkspaceCreationService {
  private records: Record<string, RecordEntry> = {};
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
  private storageFailed = false;
  private git: WorkspaceService;
  private constructor(private dataDir: string, private catalog: CatalogService, private protectedRoots: string[]) { this.git = new WorkspaceService(() => undefined, dataDir); }
  static async open(dataDir: string, catalog: CatalogService, protectedRoots: string[]) {
    const service = new WorkspaceCreationService(dataDir, catalog, protectedRoots);
    try {
      const path = join(dataDir, "workspace-creations.json"), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("Unsafe workspace creation ledger");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records)) throw new Error("Invalid workspace creation ledger");
      for (const [id, entry] of Object.entries(value.records) as [string, RecordEntry][]) {
        if (!uuid(id) || !entry || entry.requestId !== id || typeof entry.parent !== "string" || !isAbsolute(entry.parent) || typeof entry.name !== "string" || typeof entry.root !== "string" || !isAbsolute(entry.root) || !["started", "completed", "failed"].includes(entry.state) || (entry.state === "completed" && (!entry.result || !uuid(entry.result.workspaceId) || !uuid(entry.result.worktreeId)))) throw new Error("Invalid workspace creation record");
      }
      service.records = value.records;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return service;
  }
  private save() {
    try { atomicAppRecord(this.dataDir, "workspace-creations.json", { version: 1, records: this.records }); }
    catch { this.storageFailed = true; failure(503, "creation-storage", "Workspace creation storage is unavailable. Restart and inspect the destination before continuing."); }
  }
  create(input: unknown, authorized: () => boolean): Promise<RegistrationResponse> {
    const run = this.serial.then(() => this.perform(input, authorized));
    this.serial = run.catch(() => {});
    return run;
  }
  async close() { this.closing = true; await this.serial; }
  private check(authorized: () => boolean) {
    if (this.closing) failure(503, "creation-shutdown", "Bridge is shutting down");
    if (this.storageFailed) failure(503, "creation-storage", "Workspace creation storage is unavailable; restart required");
    if (!authorized()) failure(401, "creation-unauthorized", "Workspace creation authorization changed");
  }
  private async perform(raw: unknown, authorized: () => boolean): Promise<RegistrationResponse> {
    this.check(authorized);
    const deadline = Date.now() + 20000;
    const input = raw as WorkspaceCreationInput;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "name,parent,requestId" || !uuid(input.requestId) || typeof input.parent !== "string" || !isAbsolute(input.parent) || input.parent.length > 4096 || /[\x00-\x1f\x7f]/.test(input.parent) || typeof input.name !== "string" || !input.name || input.name !== input.name.trim() || Buffer.byteLength(input.name) > 200 || /[\/\\\x00-\x1f\x7f]/.test(input.name) || [".", "..", ".git", ".sane"].includes(input.name.toLowerCase())) failure(400, "invalid-workspace", "Supply an existing absolute parent directory and a folder name without separators, control characters, or surrounding spaces.");
    const previous = this.records[input.requestId];
    if (previous) {
      if (previous.parent !== input.parent || previous.name !== input.name) failure(409, "creation-request-conflict", "This creation request was already used with another location or name.");
      if (previous.state !== "completed") failure(previous.status ?? 409, previous.code ?? "creation-incomplete", previous.error ?? `Creation was interrupted at ${previous.root}. Inspect the retained folder; it will not be overwritten or automatically retried.`);
      const result = previous.result!;
      const binding = await this.catalog.binding(result.workspaceId, result.worktreeId, { deadline });
      if (binding.cwd !== previous.root) failure(409, "creation-binding-changed", "The recorded workspace no longer matches the created folder.");
      this.check(authorized);
      return { ...result, workspace: await this.catalog.get(result.workspaceId) };
    }
    if (Object.keys(this.records).length >= 10000 || Buffer.byteLength(JSON.stringify(this.records)) > 7 * 1024 * 1024) failure(503, "creation-limit", "Workspace creation history is full; no new requests can be admitted.");
    let parent: string;
    try {
      const selected = await lstat(input.parent);
      if (!selected.isDirectory() || selected.isSymbolicLink()) failure(400, "invalid-parent", "Parent must be an existing directory, not a symbolic link.");
      parent = await realpath(input.parent);
    } catch (error) { if (error instanceof WorkspaceError) throw error; return failure(400, "parent-unavailable", "Parent directory is unavailable."); }
    const root = join(parent, input.name), parentStat = await lstat(parent);
    const protectedRoots = await Promise.all(this.protectedRoots.map(async path => { try { return await realpath(path); } catch { return resolve(path); } }));
    if (root.split(sep).some(part => [".git", ".sane"].includes(part.toLowerCase())) || protectedRoots.some(path => within(path, root))) failure(403, "workspace-forbidden", "Cannot create a workspace inside protected App, Git, or SANE data.");
    for (const workspace of (await this.catalog.registeredWorkspaces()).workspaces) {
      if (workspace.commonDir && within(workspace.commonDir, root)) failure(403, "workspace-forbidden", "Cannot create a workspace inside Git administration data.");
      for (const tree of workspace.worktrees) if (tree.gitDir && within(tree.gitDir, root)) failure(403, "workspace-forbidden", "Cannot create a workspace inside Git administration data.");
    }
    const probe = await this.git.git(parent, ["rev-parse", "--git-dir"], undefined, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (!probe.code) failure(409, "nested-repository", "Choose a parent outside existing Git repositories. Nested repositories are not supported by workspace creation.");
    if (!probe.stderr.startsWith("fatal: not a git repository (or any of the parent directories): .git")) failure(503, "git-discovery", "Cannot safely determine whether the parent is inside a Git repository.");
    const checkParent = async () => {
      this.check(authorized);
      if (Date.now() >= deadline) failure(504, "creation-timeout", "Workspace creation time budget reached.");
      const now = await lstat(parent);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== parentStat.dev || now.ino !== parentStat.ino || await realpath(parent) !== parent) failure(409, "parent-changed", "Parent directory changed during workspace creation.");
    };
    await checkParent();
    // Reserve durably before any project writes; mkdir is the cross-process
    // arbiter, including dangling symlinks and case-insensitive collisions.
    const record: RecordEntry = { ...input, root, state: "started" };
    this.records[input.requestId] = record; this.save();
    let created = false;
    try {
      await checkParent();
      try { await mkdir(root, { mode: 0o755 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") failure(409, "destination-exists", `A file or folder already exists at ${root}. Nothing was overwritten.`); throw error; }
      const pin = await lstat(root);
      await checkParent();
      await this.initialize(root, pin.dev, pin.ino, Math.min(15000, Math.max(1, deadline - Date.now())));
      await checkParent();
      const now = await lstat(root);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino || await realpath(root) !== root) failure(409, "destination-changed", "Workspace directory changed during initialization.");
      const discovery = await this.catalog.discover(root, { deadline });
      if (discovery.root !== root || discovery.commonDir !== join(root, ".git")) failure(409, "repository-mismatch", "The new repository no longer matches its destination.");
      this.check(authorized);
      const result = await this.catalog.register(root, { deadline });
      record.result = result; record.state = "completed"; this.save();
      return result;
    } catch (error) {
      const timeLimit = error instanceof WorkspaceError && ["search-time-limit", "git-timeout"].includes(error.code);
      const status = error instanceof WorkspaceError ? error.status : 503, code = timeLimit ? "creation-timeout" : error instanceof WorkspaceError ? error.code : "creation-failed";
      const detail = timeLimit ? "Workspace creation time budget reached." : error instanceof Error ? error.message : "Workspace creation failed";
      const message = created ? `${detail} The folder at ${root} was retained and may be partially initialized. Inspect it before continuing; nothing will be deleted or automatically recreated.` : detail;
      record.state = "failed"; record.error = message; record.status = status; record.code = code;
      if (!this.storageFailed) this.save();
      return failure(status, code, message);
    }
  }
  private async initialize(root: string, device: number, inode: number, timeoutMs: number) {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./create-workspace-repository.ts", import.meta.url)), root, String(device), String(inode)], {
      cwd: root, detached: true, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      // Core discovery strips GIT_* selectors. Its HOME/XDG paths must also be
      // isolated from user Git configuration; the newly created folder is empty.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: root, XDG_CONFIG_HOME: root },
    });
    let timedOut = false, output = "";
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    try {
      const collect = (async () => {
        const reader = child.stderr.getReader();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; if (output.length + value.length > 65536) { kill(); throw new Error("Initialization output exceeded its limit"); } output += Buffer.from(value).toString("utf8"); } }
        finally { reader.releaseLock(); }
      })();
      const [code] = await Promise.all([child.exited, collect]);
      if (timedOut) failure(504, "creation-timeout", "Repository initialization timed out.");
      if (code !== 0) failure(503, "initialization-failed", `Git or SANE initialization failed: ${output.trim().slice(-2000) || `helper exited ${code}`}`);
    } finally { clearTimeout(timer); kill(); await child.exited; }
  }
}
