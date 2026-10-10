import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ScienceWorkspaceService } from "sane-science/science-workspace";
import { EnvironmentFileSystem } from "sane-science/environment-paths";
import type { ScienceWorkspace } from "sane-science/contracts";
import type { ScienceSessionRef } from "sane-science/science-workspace-contracts";
import type { MarimoSnapshot } from "sane-science/marimo-contracts";
import type { ScienceRequest, ScienceResponse, ScienceSession, ScienceSnapshot, ScienceStatus } from "../shared/science-contract";
import type { CatalogService } from "./catalog";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";
import { WorkspaceError } from "./workspace";
import { body, json } from "./bridge-http";
import { scienceTimed } from "sane-science/timing";

type Session = { generation: string; ref: ScienceSessionRef; port: number };
export type ScienceChatNativeRequest = ScienceRequest | { action: "create-cell"; bindingRevision: string; notebook: string; generation: string; code: string; after?: string };
export type ScienceChatOperation = (input?: ScienceChatNativeRequest) => Promise<ScienceResponse>;
type Runtime = { key: string; service: ScienceWorkspaceService; fs: EnvironmentFileSystem; bindings: Map<string, string>; sessions: Map<string, Session>; ports: Set<number>; invalidated?: boolean; stopping?: Promise<void> };
const filename = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.py$/;
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
function validate(input: unknown): ScienceRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "science-input", "Expected a JSON object");
  const i = input as Record<string, unknown>;
  const fields: Record<string, string[]> = { provision: [], create: ["notebook"], open: ["notebook"], inspect: ["notebook", "generation"], close: ["notebook", "generation"], edit: ["notebook", "generation", "cellId", "code", "expectedSourceHash"], run: ["notebook", "generation", "cellId"] };
  const allowed = typeof i.action === "string" && Object.hasOwn(fields, i.action) ? ["action", "bindingRevision", ...fields[i.action]!] : null;
  if (!allowed || Object.keys(i).some(k => !allowed.includes(k)) || allowed.some(k => typeof i[k] !== "string")) fail(400, "science-input", "Invalid science action fields");
  if (!(i.bindingRevision as string).length || (i.bindingRevision as string).length > 256) fail(400, "science-input", "Invalid binding revision");
  if ("notebook" in i && !filename.test(i.notebook as string)) fail(400, "science-input", "Use a simple notebook filename ending in .py");
  for (const key of ["generation", "cellId", "expectedSourceHash"]) if (key in i && (!(i[key] as string).length || (i[key] as string).length > 256)) fail(400, "science-input", "Invalid notebook reference");
  if ("code" in i && Buffer.byteLength(i.code as string) > 256 * 1024) fail(413, "science-input", "Cell source is too large");
  return i as ScienceRequest;
}
function snapshot(value: MarimoSnapshot): ScienceSnapshot {
  // Deliberately omit the pair binding (including its loopback URL).
  return { cells: value.cells, graph: value.graph };
}

/** One managed service per canonical core identity, shared by its catalog worktrees. */
export class ScienceService {
  private runtimes = new Map<string, Runtime>();
  private scopes = new Map<string, Runtime>();
  private ports = new Set<number>();
  private active = new Set<Promise<unknown>>();
  private busy = new Set<string>();
  private closing = false;
  private drain?: Promise<void>;
  private chatNotebooks = new Set<string>();
  /** Synchronous admission reservations cover resolve, native awaits and cleanup.
   * Claims cannot overtake an already admitted legacy operation. */
  private legacyAdmissions = new Map<string, number>();
  constructor(private catalog: CatalogService, private router: RepositoryRouter) {}
  claimChatNotebook(workspaceId: string, notebook: string) {
    const key = `${workspaceId}/${notebook}`;
    if (this.chatNotebooks.has(key)) return;
    if (this.legacyAdmissions.has(workspaceId)) fail(409, "science-busy", "Wait for the admitted legacy science operation before associating a notebook");
    this.chatNotebooks.add(key);
  }
  async handleChat(workspaceId: string, worktreeId: string, input: ScienceChatNativeRequest | undefined, authorized: () => boolean) {
    return this.handle(workspaceId, worktreeId, input, authorized, true);
  }
  /** A single admitted chat action owns the runtime through status, mapping and
   * mutation. The capability expires with the callback; it cannot be replayed. */
  async withChatOperation<T>(workspaceId: string, worktreeId: string, expected: { cwd: string; bindingRevision: string; repositoryId: string; notebook: string }, authorized: () => boolean, use: (call: ScienceChatOperation) => Promise<T>): Promise<T> {
    if (this.closing) fail(503, "science-shutdown", "Bridge is shutting down");
    if (this.active.size >= 16) fail(429, "science-busy", "Too many science operations");
    const task = (async () => {
      if (!authorized()) fail(401, "science-auth", "Science authorization changed");
      const resolved = await scienceTimed("native-resolve", () => this.resolve(workspaceId, worktreeId, true));
      const { r, binding } = resolved;
      if (binding.cwd !== expected.cwd || binding.bindingRevision !== expected.bindingRevision || resolved.repositoryId !== expected.repositoryId) fail(409, "science-binding", "Admitted science repository differs");
      if (this.busy.has(r.key)) fail(409, "science-busy", "A science operation is already pending");
      this.busy.add(r.key);
      let live = true, pending: Promise<ScienceResponse> | undefined;
      const ownership = () => {
        if (!this.chatNotebooks.has(`${workspaceId}/${expected.notebook}`)) fail(409, "science-chat-owned", "Science notebook ownership changed");
      };
      const assertCurrent = this.currentGuard(workspaceId, worktreeId, resolved, authorized, ownership);
      try {
        await assertCurrent();
        assertCurrent.check();
        const result = await scienceTimed("native-operation", () => use(input => {
          if (!live) fail(409, "science-operation", "Science operation has ended");
          ownership();
          if (pending) fail(409, "science-busy", "A native step is already pending");
          if (input && "notebook" in input && input.notebook !== expected.notebook) fail(409, "science-chat-owned", "Native step differs from admitted notebook");
          const step = this.performResolved(workspaceId, worktreeId, input, resolved, assertCurrent);
          pending = step;
          return step.finally(() => { pending = undefined; });
        }).finally(() => { live = false; }));
        await assertCurrent();
        assertCurrent.check();
        return result;
      } finally {
        live = false;
        // Even a callback that abandons its promise cannot release runtime ownership
        // while a dispatched native step is still running.
        if (pending) await pending.catch(() => {});
        this.busy.delete(r.key);
      }
    })();
    this.active.add(task);
    try { return await task; } finally { this.active.delete(task); }
  }

  private stop(r: Runtime): Promise<void> {
    r.invalidated = true;
    return r.stopping ??= this.shutdownRuntime(r).finally(() => { r.stopping = undefined; });
  }
  private async shutdownRuntime(r: Runtime) {
    const statuses = await r.service.shutdown();
    if (statuses.some(s => !["stopped", "exited", "failed"].includes(s.runtime.state) || ["pending", "failed"].includes(s.runtime.tokenFileCleanup))) fail(503, "science-stop", "Notebook cleanup is incomplete");
    for (const port of r.ports) this.ports.delete(port);
    if (this.runtimes.get(r.key) === r) this.runtimes.delete(r.key);
    for (const [scope, runtime] of this.scopes) if (runtime === r) this.scopes.delete(scope);
  }
  private async resolve(workspaceId: string, worktreeId: string, operation = false) {
    const scope = `${workspaceId}/${worktreeId}`;
    const previous = this.scopes.get(scope);
    try {
      const lease = operation ? await this.catalog.terminalLease(workspaceId, worktreeId) : undefined;
      const binding = lease?.binding ?? await this.catalog.binding(workspaceId, worktreeId);
      const adapter = await this.router.forWorkspace(workspaceId);
      adapter.domain.validateExecutionCheckout(binding.cwd);
      const c = adapter.domain.context;
      const workspace: ScienceWorkspace = { repositoryId: c.repositoryId, primaryCheckout: c.primaryCheckout, stateRoot: c.stateRoot, primaryPin: c.primaryPin };
      const key = JSON.stringify(workspace), proof = JSON.stringify([binding.cwd, binding.bindingRevision]);
      if (previous && (previous.invalidated || previous.key !== key || previous.bindings.has(scope) && previous.bindings.get(scope) !== proof)) {
        await this.stop(previous);
        fail(409, "science-binding", "Science binding changed; reload status before opening a new session");
      }
      let r = this.runtimes.get(key);
      if (!r) {
        if (this.runtimes.size >= 16) fail(429, "science-limit", "Science workspace limit reached");
        r = { key, service: new ScienceWorkspaceService(workspace), fs: new EnvironmentFileSystem(workspace), bindings: new Map(), sessions: new Map(), ports: new Set() };
        this.runtimes.set(key, r);
      }
      r.bindings.set(scope, proof); this.scopes.set(scope, r);
      // Science reads core identity; native writes go through ScienceWorkspaceService,
      // never the core database. Its evidence-checked read guard is appropriate here.
      // The operation-local catalog lease separately fences the execution checkout.
      return { r, binding, repositoryId: c.repositoryId, lease, validate: () => lease ? adapter.domain.validateRead() : adapter.domain.validateHandle() };
    } catch (error) {
      // Lost catalog/domain evidence must not leave an adopted native session alive.
      if (previous && this.runtimes.has(previous.key)) await this.stop(previous);
      throw error;
    }
  }
  private session(r: Runtime, name: string, s: Session): ScienceSession {
    return { notebook: name, generation: s.generation, state: r.service.status(s.ref).state };
  }
  private status(workspaceId: string, worktreeId: string, resolved: Awaited<ReturnType<ScienceService["resolve"]>>): ScienceStatus {
    const { r, binding, repositoryId } = resolved, env = r.service.environmentStatus();
    const dir = r.fs.check(r.fs.paths.notebooks);
    const notebooks = dir ? readdirSync(r.fs.paths.notebooks).filter(name => filename.test(name) && r.fs.check(join(r.fs.paths.notebooks, name))?.isFile()).sort() : [];
    return { workspaceId, worktreeId, bindingRevision: binding.bindingRevision, repositoryId, environment: { state: env.state, python: env.policy.python, marimo: env.policy.marimo }, nativeAvailable: typeof r.service.openNativeNotebook === "function", notebooks, sessions: [...r.sessions].map(([name, s]) => this.session(r, name, s)) };
  }
  private async port(): Promise<number> {
    const start = Math.floor(Math.random() * 64);
    for (let n = 0; n < 64; n++) {
      const port = 27180 + (start + n) % 64;
      if (this.ports.has(port)) continue;
      this.ports.add(port);
      const available = await new Promise<boolean>(done => {
        const server = createServer();
        server.once("error", () => done(false));
        server.listen(port, "127.0.0.1", () => server.close(error => done(!error)));
      });
      if (available) return port;
      this.ports.delete(port);
    }
    return fail(503, "science-port", "No managed science port is available");
  }
  async handle(workspaceId: string, worktreeId: string, input: ScienceChatNativeRequest | undefined, authorized: () => boolean, chat = false): Promise<ScienceResponse> {
    const assertOwnership = () => {
      if (!chat && input && "notebook" in input && this.chatNotebooks.has(`${workspaceId}/${input.notebook}`)) fail(409, "science-chat-owned", "Use the durable chat API for this notebook");
    };
    assertOwnership();
    if (this.closing) fail(503, "science-shutdown", "Bridge is shutting down");
    if (this.active.size >= 16) fail(429, "science-busy", "Too many science operations");
    // Reserve before perform can reach its first await. Claims and reservations
    // are synchronous, so there is no check/await/mutation ownership gap.
    if (!chat) this.legacyAdmissions.set(workspaceId, (this.legacyAdmissions.get(workspaceId) ?? 0) + 1);
    const task = this.perform(workspaceId, worktreeId, input, authorized, assertOwnership);
    this.active.add(task);
    try { return await task; } finally {
      this.active.delete(task);
      if (!chat) {
        const remaining = this.legacyAdmissions.get(workspaceId)! - 1;
        if (remaining) this.legacyAdmissions.set(workspaceId, remaining); else this.legacyAdmissions.delete(workspaceId);
      }
    }
  }
  private async perform(workspaceId: string, worktreeId: string, input: ScienceChatNativeRequest | undefined, authorized: () => boolean, assertOwnership: () => void): Promise<ScienceResponse> {
    const resolved = await scienceTimed("native-resolve", () => this.resolve(workspaceId, worktreeId)), { r } = resolved;
    const assertCurrent = this.currentGuard(workspaceId, worktreeId, resolved, authorized, assertOwnership);
    if (this.busy.has(r.key)) fail(409, "science-busy", "A science operation is already pending");
    this.busy.add(r.key);
    try { return await this.performResolved(workspaceId, worktreeId, input, resolved, assertCurrent); }
    finally { this.busy.delete(r.key); }
  }
  private currentGuard(workspaceId: string, worktreeId: string, resolved: Awaited<ReturnType<ScienceService["resolve"]>>, authorized: () => boolean, assertOwnership: () => void) {
    const { r, binding } = resolved;
    const local = () => {
      if (r.invalidated) fail(409, "science-binding", "Science runtime was invalidated; reload status");
      if (this.closing || !authorized()) fail(401, "science-auth", "Science authorization changed");
      assertOwnership();
    };
    return Object.assign(() => scienceTimed("native-validation", async () => {
      local();
      try {
        if (resolved.lease) await resolved.lease.validate();
        else {
          const current = await this.catalog.binding(workspaceId, worktreeId);
          if (current.cwd !== binding.cwd || current.bindingRevision !== binding.bindingRevision) fail(409, "science-binding", "Science worktree binding changed");
        }
        resolved.validate();
        this.catalog.assertBinding(workspaceId, worktreeId, binding.cwd, binding.bindingRevision);
      } catch { await this.stop(r); fail(409, "science-binding", "Science repository binding is unavailable"); }
      local();
    }), { check: local });
  }
  private async performResolved(workspaceId: string, worktreeId: string, input: ScienceChatNativeRequest | undefined, resolved: Awaited<ReturnType<ScienceService["resolve"]>>, assertCurrent: ReturnType<ScienceService["currentGuard"]>): Promise<ScienceResponse> {
      const { r, binding } = resolved;
      await assertCurrent();
      assertCurrent.check();
      // The synchronous check is adjacent to dispatch, after the awaited lease
      // validation. Rejected native awaits also pass through the publication fence.
      const dispatch = async <T>(send: () => Promise<T>): Promise<T> => {
        assertCurrent.check();
        try { return await send(); }
        finally { await assertCurrent(); assertCurrent.check(); }
      };
      if (input && input.bindingRevision !== binding.bindingRevision) fail(409, "science-binding", "Reload the worktree binding before changing science");
      let selected: ScienceSession | undefined, inspected: ScienceSnapshot | undefined, operation: ScienceResponse["operation"];
      if (input?.action === "provision") await dispatch(() => r.service.provision());
      else if (input?.action === "create") await dispatch(() => r.service.createNotebook(input.notebook));
      else if (input?.action === "open") {
        if (r.sessions.has(input.notebook)) fail(409, "science-open", "Close the current notebook generation before opening another");
        if (r.sessions.size >= 16) fail(429, "science-limit", "Close a notebook before opening another");
        const notebookPath = join(r.fs.paths.notebooks, input.notebook);
        if (!r.fs.check(notebookPath)?.isFile()) fail(404, "science-notebook", "Notebook was not found");
        const port = await this.port(); r.ports.add(port);
        try {
          await assertCurrent();
          const opened = await dispatch(() => scienceTimed("native-open-readiness", () => r.service.openNativeNotebook({ notebookPath, port })));
          if (opened.state !== "session-ready" || !opened.selectedSession) {
            fail(503, "science-session", "Native notebook session did not become ready");
          }
          const s: Session = { generation: crypto.randomUUID(), ref: opened.selectedSession, port };
          inspected = snapshot(await dispatch(() => scienceTimed("native-initial-inspection", () => r.service.inspectCells(s.ref))));
          r.sessions.set(input.notebook, s); selected = this.session(r, input.notebook, s);
        } catch (error) {
          const current = r.service.currentNotebook(notebookPath);
          if (current?.runtime.port === port) {
            const stopped = await r.service.stopNotebook(current.ref);
            if (!["stopped", "exited", "failed"].includes(stopped.runtime.state) || ["pending", "failed"].includes(stopped.runtime.tokenFileCleanup)) fail(503, "science-stop", "Failed notebook launch cleanup is incomplete");
          }
          // Only release after confirming cleanup, or when this port never launched.
          this.ports.delete(port); r.ports.delete(port);
          throw error;
        }
      } else if (input && "generation" in input) {
        const s = r.sessions.get(input.notebook);
        if (!s || s.generation !== input.generation) fail(409, "science-generation", "Notebook generation is stale; reload status");
        if (input.action === "close") {
          const stopped = await dispatch(() => r.service.stopNotebook(s.ref));
          if (!["stopped", "exited", "failed"].includes(stopped.runtime.state) || ["pending", "failed"].includes(stopped.runtime.tokenFileCleanup)) fail(503, "science-stop", "Notebook cleanup is incomplete");
          selected = this.session(r, input.notebook, s); r.sessions.delete(input.notebook);
          this.ports.delete(s.port); r.ports.delete(s.port);
        } else if (input.action === "inspect") {
          // inspectCells refreshes readiness and validates the exact selected session before inspection.
          inspected = snapshot(await dispatch(() => scienceTimed("native-inspection", () => r.service.inspectCells(s.ref))));
        }
        else {
          const result = await dispatch(() => input.action === "create-cell" ? r.service.createCell(s.ref, input.code, { after: input.after, run: false }) : input.action === "edit" ? r.service.editCell(s.ref, input.cellId, input.code, input.expectedSourceHash, false) : r.service.runCell(s.ref, input.cellId));
          operation = { cellId: result.cellId, mutation: result.mutation, execution: result.execution, durability: result.durability, ...(result.error ? { issue: "operation-error" as const } : result.snapshotError ? { issue: "snapshot-unavailable" as const } : {}) };
          if (result.snapshot) inspected = snapshot(result.snapshot);
        }
        selected ??= this.session(r, input.notebook, s);
      }
      await assertCurrent();
      assertCurrent.check();
      return { status: this.status(workspaceId, worktreeId, resolved), ...(selected ? { session: selected } : {}), ...(inspected ? { snapshot: inspected } : {}), ...(operation ? { operation } : {}) };
  }
  close(): Promise<void> {
    this.closing = true;
    return this.drain ??= (async () => {
      await Promise.allSettled([...this.active]);
      const results = await Promise.allSettled([...this.runtimes.values()].map(r => this.stop(r)));
      if (results.some(r => r.status === "rejected")) fail(503, "science-stop", "Science cleanup is incomplete");
    })().finally(() => { this.drain = undefined; });
  }
}

/** Call only behind bridge browserBoundary + authenticated gates. */
export async function scienceRoute(req: Request, service: ScienceService, authorized: () => boolean): Promise<Response | null> {
  const url = new URL(req.url), match = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/science$/.exec(url.pathname);
  if (!match) return null;
  try {
    if (url.search) fail(400, "science-query", "Science routes do not accept query parameters");
    if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let input: ScienceRequest | undefined;
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") fail(415, "science-json", "Expected application/json");
      let parsed: unknown;
      try { parsed = await body(req); } catch { fail(400, "science-json", "Invalid JSON body or body exceeds 1 MiB"); }
      input = validate(parsed);
    }
    return json(await service.handle(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), input, authorized));
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof WorkstreamAdapterError) return json({ error: "Science requires an available initialized repository", code: "science-repository" }, error.status);
    // Package errors may contain subprocess diagnostics, paths and credentials.
    return json({ error: "Science operation failed; refresh status before retrying", code: "science-failed" }, 503);
  }
}
