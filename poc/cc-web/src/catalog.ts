import { readFile, writeFile, rename, realpath, lstat, open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { WorkspaceError, WorkspaceService } from "./workspace";
import { uuid, type Session } from "./history";
import type { Association, WorkspaceRecord, WorktreeRecord, NavigationBookmark, NavigationWrite } from "./catalog-contract";

type Identity = { dev: number; ino: number };
type Tree = WorktreeRecord & { identity: Identity; gitIdentity: Identity | null };
type Repo = Omit<WorkspaceRecord, "worktrees"> & { identity: Identity; worktrees: Tree[] };
type Catalog = { version: 1; migrated: boolean; workspaces: Repo[]; associations: Record<string, Association> };
type Discovery = { root: string; commonDir: string | null; gitDir: string | null; identity: Identity; gitIdentity: Identity | null; repoIdentity: Identity };
function error(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const same = (a: Identity | null, b: Identity | null) => a === null ? b === null : !!b && a.dev === b.dev && a.ino === b.ino;
const identity = async (path: string): Promise<Identity> => { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) error(409, "binding-invalid", "Directory binding is invalid"); return { dev: s.dev, ino: s.ino }; };
const validPath = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && !v.includes("\0");
const validIdentity = (v: any) => v && Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino);

/** One implicit owner, protected by the bridge's existing owner.lock. Catalog
 * and navigation have independent queues and never serialize mutable run meta. */
export class CatalogService {
  private catalog: Catalog = { version: 1, migrated: false, workspaces: [], associations: {} };
  private navigation: NavigationBookmark = { revision: 0, workspaceId: null, worktreeId: null, conversationId: null, view: "chat", filePath: null, comparison: null };
  private serial: Promise<unknown> = Promise.resolve();
  private navSerial: Promise<unknown> = Promise.resolve();
  private git: WorkspaceService;
  private failed = false;
  constructor(private dataDir: string, private sessions: () => Session[]) { this.git = new WorkspaceService(() => undefined, dataDir); }
  private async save(name: string, value: unknown) {
    try {
      const handle = await open(join(this.dataDir, `${name}.tmp`), "w", 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await rename(join(this.dataDir, `${name}.tmp`), join(this.dataDir, name));
      const directory = await open(this.dataDir, "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    catch { this.failed = true; return error(503, "catalog-storage", "Catalog storage unavailable; restart required"); }
  }
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(async () => {
      if (this.failed) error(503, "catalog-storage", "Catalog storage unavailable; restart required");
      const before = structuredClone(this.catalog);
      try { return await fn(); } catch (e) { this.catalog = before; throw e; }
    });
    this.serial = next.catch(() => {}); return next;
  }
  async load() {
    try {
      const c = JSON.parse(await readFile(join(this.dataDir, "catalog.json"), "utf8"));
      if (c.version !== 1 || typeof c.migrated !== "boolean" || !Array.isArray(c.workspaces) || !c.associations || typeof c.associations !== "object" || Array.isArray(c.associations)) throw new Error("Invalid catalog schema");
      const ids = new Set<string>();
      for (const w of c.workspaces) {
        if (!uuid(w.workspaceId) || ids.has(w.workspaceId) || !["repository", "directory"].includes(w.kind) || typeof w.name !== "string" || !validIdentity(w.identity) || (w.kind === "repository" ? !validPath(w.commonDir) : w.commonDir !== null) || !Array.isArray(w.worktrees)) throw new Error("Invalid workspace catalog");
        ids.add(w.workspaceId);
        for (const t of w.worktrees) { if (!uuid(t.worktreeId) || ids.has(t.worktreeId) || !uuid(t.bindingRevision) || !validPath(t.root) || !validIdentity(t.identity) || !["available", "invalid"].includes(t.state) || (w.kind === "repository" ? !validPath(t.gitDir) || !validIdentity(t.gitIdentity) : t.gitDir !== null || t.gitIdentity !== null)) throw new Error("Invalid worktree catalog"); ids.add(t.worktreeId); }
      }
      for (const [id, a] of Object.entries(c.associations) as [string, any][]) {
        if (!uuid(id) || !a || (a.association === "resolved" ? !c.workspaces.some((w: Repo) => w.workspaceId === a.workspaceId && w.worktrees.some(t => t.worktreeId === a.worktreeId)) : a.association !== "unresolved" || a.workspaceId !== null || a.worktreeId !== null || typeof a.associationReason !== "string")) throw new Error("Invalid conversation association");
      }
      this.catalog = c;
    } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (!this.catalog.migrated) {
      // Exclusive create preserves the original metadata across crash retries.
      try { await writeFile(join(this.dataDir, "metadata.pre-catalog.json"), await readFile(join(this.dataDir, "metadata.json")), { flag: "wx", mode: 0o600 }); }
      catch (e: any) { if (!["ENOENT", "EEXIST"].includes(e.code)) throw e; }
      for (const session of this.sessions()) {
        if (this.catalog.associations[session.sessionId]) continue;
        const before = structuredClone(this.catalog);
        try { this.catalog.associations[session.sessionId] = await this.registerInternal(session.cwd); }
        catch (e) { this.catalog = before; this.catalog.associations[session.sessionId] = { workspaceId: null, worktreeId: null, association: "unresolved", associationReason: e instanceof WorkspaceError ? e.code : "directory-unavailable" }; }
      }
      this.catalog.migrated = true; await this.save("catalog.json", this.catalog);
    }
    try {
      const n = JSON.parse(await readFile(join(this.dataDir, "navigation.json"), "utf8"));
      if (n.version !== 1 || !Number.isSafeInteger(n.bookmark?.revision) || n.bookmark.revision < 0) throw new Error("Invalid navigation schema");
      this.validateNavigation(n.bookmark, false); this.navigation = n.bookmark;
    } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  async discover(cwd: string): Promise<Discovery> {
    if (!validPath(cwd)) error(400, "invalid-cwd", "cwd must be an absolute directory path");
    let path: string;
    try { path = await realpath(cwd); } catch (e: any) { return error(e.code === "ENOENT" || e.code === "ENOTDIR" ? 404 : 403, "directory-unavailable", "Directory is unavailable"); }
    const data = await realpath(this.dataDir);
    await identity(path);
    if (inside(data, path) || path.split(sep).some(p => p.toLowerCase() === ".git")) error(403, "workspace-forbidden", "Directory is protected");
    const top = await this.git.git(path, ["rev-parse", "--show-toplevel"]);
    if (top.code) {
      if (!top.stderr.startsWith("fatal: not a git repository (or any of the parent directories): .git")) error(503, "git-discovery", "Git discovery failed");
      const id = await identity(path); return { root: path, commonDir: null, gitDir: null, identity: id, gitIdentity: null, repoIdentity: id };
    }
    const root = await realpath(top.bytes.toString("utf8").replace(/\n$/, ""));
    const query = async (flag: string) => { const r = await this.git.git(path, ["rev-parse", "--path-format=absolute", flag]); if (r.code) error(503, "git-discovery", "Git directory discovery failed"); return realpath(r.bytes.toString("utf8").replace(/\n$/, "")); };
    const commonDir = await query("--git-common-dir"), gitDir = await query("--git-dir");
    if (!inside(root, path) || inside(data, root) || [commonDir, gitDir].some(p => inside(p, path) || inside(p, root))) error(403, "workspace-forbidden", "Git administration directory is protected");
    return { root, commonDir, gitDir, identity: await identity(root), gitIdentity: await identity(gitDir), repoIdentity: await identity(commonDir) };
  }
  private add(d: Discovery): { workspace: Repo; tree: Tree } {
    let workspace = this.catalog.workspaces.find(w => d.commonDir ? w.commonDir === d.commonDir : w.kind === "directory" && w.worktrees[0]?.root === d.root);
    if (workspace && !same(workspace.identity, d.repoIdentity)) error(409, "binding-invalid", "Repository binding changed; explicit reconciliation required");
    if (!workspace) { workspace = { workspaceId: crypto.randomUUID(), kind: d.commonDir ? "repository" : "directory", commonDir: d.commonDir, identity: d.repoIdentity, name: basename(d.root), worktrees: [] }; this.catalog.workspaces.push(workspace); }
    let tree = workspace.worktrees.find(t => d.gitDir ? t.gitDir === d.gitDir : t.root === d.root);
    if (tree && (tree.root !== d.root || !same(tree.identity, d.identity) || !same(tree.gitIdentity, d.gitIdentity))) error(409, "binding-invalid", "Worktree binding changed; explicit reconciliation required");
    if (!tree) { tree = { worktreeId: crypto.randomUUID(), root: d.root, gitDir: d.gitDir, bindingRevision: crypto.randomUUID(), identity: d.identity, gitIdentity: d.gitIdentity, state: "available" }; workspace.worktrees.push(tree); }
    return { workspace, tree };
  }
  private async registerInternal(cwd: string): Promise<Association & { association: "resolved" }> {
    const d = await this.discover(cwd), { workspace, tree } = this.add(d);
    if (d.commonDir) {
      const result = await this.git.git(d.root, ["worktree", "list", "--porcelain", "-z"]);
      if (result.code) error(503, "git-worktrees", "Git worktree discovery failed");
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { return error(422, "git-path-encoding", "Unsupported Git worktree path encoding"); }
      for (const record of text.split("\0\0")) {
        const fields = record.split("\0"), path = fields.find(f => f.startsWith("worktree "))?.slice(9);
        if (!path || fields.includes("bare")) continue;
        try {
          const other = await this.discover(path);
          if (other.commonDir !== d.commonDir) error(409, "binding-invalid", "Native worktree repository mismatch");
          const found = this.add(other).tree; found.branch = fields.find(f => f.startsWith("branch "))?.slice(7); found.detached = fields.includes("detached");
        } catch (e: any) {
          // Prunable/moved native entries do not rebind a pinned ID.
          if (!["ENOENT", "ENOTDIR"].includes(e.code) && !(e instanceof WorkspaceError && (e.code === "binding-invalid" || e.code === "directory-unavailable" && e.status === 404))) throw e;
          const pinned = workspace.worktrees.find(t => t.root === path); if (pinned) { pinned.state = "invalid"; pinned.reason = "Worktree path is missing or changed"; }
        }
      }
    }
    return { workspaceId: workspace.workspaceId, worktreeId: tree.worktreeId, association: "resolved" };
  }
  async register(cwd: string) { return this.queue(async () => { const a = await this.registerInternal(cwd); await this.save("catalog.json", this.catalog); return { workspace: this.publicWorkspace(this.find(a.workspaceId)), workspaceId: a.workspaceId, worktreeId: a.worktreeId }; }); }
  private find(id: string) { return this.catalog.workspaces.find(w => w.workspaceId === id) ?? error(404, "unknown-workspace", "Unknown workspace"); }
  private publicWorkspace(w: Repo): WorkspaceRecord { return { workspaceId: w.workspaceId, kind: w.kind, name: w.name, commonDir: w.commonDir, worktrees: w.worktrees.map(({ identity, gitIdentity, ...t }) => ({ ...t })) }; }
  async binding(workspaceId: string, worktreeId: string) {
    const w = this.find(workspaceId), t = w.worktrees.find(t => t.worktreeId === worktreeId) ?? error(404, "unknown-worktree", "Unknown worktree");
    try {
      const d = await this.discover(t.root);
      if (d.root !== t.root || d.gitDir !== t.gitDir || d.commonDir !== w.commonDir || !same(d.identity, t.identity) || !same(d.gitIdentity, t.gitIdentity) || !same(d.repoIdentity, w.identity)) error(409, "binding-invalid", "Pinned filesystem binding changed");
      t.state = "available"; delete t.reason;
      return { cwd: t.root, bindingRevision: t.bindingRevision, protectedPaths: [w.commonDir, t.gitDir].filter((p): p is string => !!p) };
    } catch (e) { t.state = "invalid"; t.reason = e instanceof WorkspaceError ? e.message : "Worktree path unavailable"; throw e instanceof WorkspaceError ? e : new WorkspaceError(409, "binding-invalid", t.reason); }
  }
  async get(id: string) { await this.serial; const w = this.find(id); for (const t of w.worktrees) { try { await this.binding(id, t.worktreeId); } catch {} } return this.publicWorkspace(w); }
  async list() { await this.serial; return { version: 1 as const, workspaces: await Promise.all(this.catalog.workspaces.map(w => this.get(w.workspaceId))) }; }
  association(id: string): Association { return this.catalog.associations[id] ?? { workspaceId: null, worktreeId: null, association: "unresolved", associationReason: "not-associated" }; }
  async associate(id: string, cwd: string, workspaceId?: unknown, worktreeId?: unknown): Promise<Association> {
    return this.queue(async () => {
      const prior = this.catalog.associations[id];
      if (prior?.association === "unresolved") error(409, "association-unresolved", "Conversation workspace requires explicit reconciliation");
      let a: Association;
      if (workspaceId !== undefined || worktreeId !== undefined) {
        if (typeof workspaceId !== "string" || typeof worktreeId !== "string") error(400, "association-required", "workspaceId and worktreeId are required together");
        const bound = await this.binding(workspaceId, worktreeId), discovered = await this.discover(cwd);
        if (discovered.root !== bound.cwd) error(409, "cwd-worktree-mismatch", "cwd belongs to a different worktree (including nested repositories)");
        a = { workspaceId, worktreeId, association: "resolved" };
      } else if (prior) { await this.binding(prior.workspaceId!, prior.worktreeId!); const d = await this.discover(cwd); const w = this.find(prior.workspaceId!); if (d.root !== w.worktrees.find(t => t.worktreeId === prior.worktreeId)!.root) error(409, "cwd-worktree-mismatch", "Conversation cwd binding changed"); a = prior; }
      else a = await this.registerInternal(cwd);
      if (prior && (prior.workspaceId !== a.workspaceId || prior.worktreeId !== a.worktreeId)) error(409, "association-immutable", "Conversation association cannot change");
      this.catalog.associations[id] = a; await this.save("catalog.json", this.catalog); return a;
    });
  }
  getNavigation() { return { ...this.navigation }; }
  private validateNavigation(n: any, references: boolean) {
    if (!n || !["chat", "code", "git", "terminal"].includes(n.view) || ![null, "staged", "unstaged", "untracked"].includes(n.comparison) || ![n.workspaceId, n.worktreeId, n.conversationId].every(v => v === null || uuid(v)) || (n.workspaceId === null) !== (n.worktreeId === null) || (n.filePath !== null && (typeof n.filePath !== "string" || n.filePath.length > 4096 || n.filePath.includes("\0") || n.filePath.includes("\\") || isAbsolute(n.filePath) || n.filePath.split("/").some((p: string) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")))) error(400, "invalid-navigation", "Invalid navigation bookmark");
    if (references && n.workspaceId !== null && !this.find(n.workspaceId).worktrees.some(t => t.worktreeId === n.worktreeId)) error(404, "unknown-worktree", "Unknown worktree");
    if (references && n.conversationId !== null) {
      const s = this.sessions().find(s => s.sessionId === n.conversationId), a = this.association(n.conversationId);
      if (!s) error(409, "navigation-association", "Conversation no longer exists");
      // History can remain selected with an unresolved execution association.
      // Resolved associations reference their own worktree, independently of browsing.
      if (a.association === "resolved" && !this.catalog.workspaces.some(w => w.workspaceId === a.workspaceId && w.worktrees.some(t => t.worktreeId === a.worktreeId))) error(409, "navigation-association", "Conversation association is unavailable");
    }
  }
  putNavigation(input: NavigationWrite) {
    const next = this.navSerial.then(async () => {
      if (this.failed) error(503, "catalog-storage", "Catalog storage unavailable; restart required");
      this.validateNavigation(input, true);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== this.navigation.revision) error(409, "navigation-conflict", "Navigation changed; reload bookmark before saving");
      const { workspaceId, worktreeId, conversationId, view, filePath, comparison } = input;
      const bookmark = { revision: this.navigation.revision + 1, workspaceId, worktreeId, conversationId, view, filePath, comparison };
      await this.save("navigation.json", { version: 1, bookmark }); this.navigation = bookmark; return this.getNavigation();
    }); this.navSerial = next.catch(() => {}); return next;
  }
  async flush() { await Promise.all([this.serial, this.navSerial]); }
}
