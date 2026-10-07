import { RepositoryDomain, DomainError, discoverRepository, inspectRepositoryStore, initializeRepository, openRepositoryDomain, normalizeNativeSource, revalidateCheckout } from "sane-core/server";
import type { ConversationRef, CreateWorkstreamInput, InvocationContext, Phase, MutationContext, RepositoryContext, RepositoryDiscovery, StoreAvailability } from "sane-core/contracts";
import { uuid, type Session } from "./history";
import type { WorkstreamOverview } from "./workstreams-contract";
import type { CatalogService } from "./catalog";
import type { Admission, SourceRecords } from "./app-store";

export type AppConversation = Pick<Session, "sessionId" | "harness" | "nativeSessionId" | "authorityId" | "cwd">;
export type ExecutionContext = Pick<InvocationContext, "executionCheckout" | "artifactsRoot"> & { workstreamId: string | null };
export class WorkstreamAdapterError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, options?: ErrorOptions) { super(message, options); }
}
/** Preserve read-only inspection classification across the asynchronous router. */
export class RepositoryStoreError extends WorkstreamAdapterError {
  readonly state: Exclude<StoreAvailability["state"], "ready">;
  constructor(store: Exclude<StoreAvailability, { state: "ready" }>) {
    super(store.state === "corrupt" || store.state === "unavailable" ? 503 : 409, store.code, store.message);
    this.state = store.state;
  }
}
const mutation = (expectedRevision?: number): MutationContext => ({ actor: { kind: "human" }, correlationId: crypto.randomUUID(), ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
const sameRef = (a: ConversationRef, b: ConversationRef) => a.harness === b.harness && a.authorityId === b.authorityId && a.nativeId === b.nativeId;
export type WorkstreamMutation =
  | { kind: "register" | "phase/assign"; ref: ConversationRef }
  | { kind: "associate"; ref: ConversationRef; workstreamId: string | null }
  | { kind: "create"; workstreamId: string }
  | { kind: "phase/end"; assignmentId: string }
  | { kind: "default-checkout"; workstreamId: string; checkout: string | null };
export type WorkstreamMutationHooks = {
  /** App-only occupancy fence. Core/native callers never receive this hook. */
  beforeMutation?: (domain: RepositoryDomain, input: WorkstreamMutation) => void;
  beforeInitialize?: (workspaceId: string, discovery: RepositoryDiscovery) => void;
  /** Reserve the affected repository across core's asynchronous lifecycle write. */
  beforeLifecycle?: (domain: RepositoryDomain) => (() => void);
  mutationFailed?: (error: unknown) => void;
};
/** Only actual writers use this classifier; target/read proof failures stay scoped. */
function mutationFailure(error: unknown, failed?: (error: unknown) => void, unsafeHook = false): never {
  const nominal = error instanceof DomainError || error instanceof WorkstreamAdapterError;
  const fatal = unsafeHook || !nominal || ["STORAGE_ERROR", "CORRUPT_STORE", "INCOMPLETE_INITIALIZATION", "UNSUPPORTED_SCHEMA", "storage-unavailable"].includes(error.code);
  if (!fatal) throw error;
  failed?.(error);
  if (error instanceof WorkstreamAdapterError && error.status === 503 && error.code === "storage-unavailable") throw error;
  throw new WorkstreamAdapterError(503, "storage-unavailable", "Domain mutation failed; operator reconciliation required", { cause: error });
}
function synchronousMutationHook(action: () => unknown, failed?: (error: unknown) => void) {
  // The callback itself may refuse a read-only target proof. Inspection of its
  // returned capability is different: an unsafe synchronous boundary is fatal.
  const result = action();
  let then: unknown;
  try {
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) then = result.then;
  } catch (error) { mutationFailure(error, failed, true); }
  if (typeof then === "function") {
    const error = new Error("Domain mutation hooks must complete synchronously");
    try { mutationFailure(error, failed, true); }
    finally {
      // Consume rejection using the captured method, never reread a then getter
      // or assimilate a malicious thenable's fulfillment value.
      void new Promise<void>((resolve, reject) => { Reflect.apply(then, result, [() => resolve(), reject]); }).catch(() => {});
    }
  }
}
/** Repository-scoped synchronous adapter. No ambient or singleton domain selection. */
export class WorkstreamAdapter {
  constructor(readonly domain: RepositoryDomain, private readonly sources: SourceRecords, private readonly hooks: WorkstreamMutationHooks = {}) {}
  private mutate<T>(input: WorkstreamMutation, action: () => T): T {
    // Read-only target proof failures are scoped refusals, not failed writes.
    synchronousMutationHook(() => this.hooks.beforeMutation?.(this.domain, input), this.hooks.mutationFailed);
    try {
      return action();
    } catch (error) {
      mutationFailure(error, this.hooks.mutationFailed);
    }
  }
  private async lifecycle<T>(action: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    synchronousMutationHook(() => { const result = this.hooks.beforeLifecycle?.(this.domain); if (typeof result === "function") release = result; return result; }, this.hooks.mutationFailed);
    try {
      return await action();
    } catch (error) {
      return mutationFailure(error, this.hooks.mutationFailed);
    } finally { release?.(); }
  }
  close() { this.domain.close(); }
  get repositoryId() { return this.domain.repositoryId; }
  reference(session: AppConversation): ConversationRef {
    const harness = session.harness === "opencode" ? "oc" : session.harness === "claude-code" ? "cc" : null;
    if (!harness || !session.nativeSessionId || !session.authorityId) throw new WorkstreamAdapterError(409, "invalid-app-reference", "Qualified native identity is required");
    return { harness, authorityId: session.authorityId, nativeId: session.nativeSessionId };
  }
  appSessionId(ref: ConversationRef, sessions: readonly AppConversation[]) {
    const matches = sessions.filter(s => sameRef(this.reference(s), ref));
    if (matches.length > 1) throw new WorkstreamAdapterError(409, "ambiguous-app-reference", "Several App records map to the native identity");
    return matches[0]?.sessionId ?? null;
  }
  list() { return this.domain.listWorkstreams(); }
  lifecycleStatus(id: string) { return this.domain.getLifecycleStatus(id); }
  provide(id: string, phase: string, refreshTemplates = false, expectedRevision?: number) { return this.lifecycle(() => this.domain.providePhase(id, phase, { refreshTemplates }, mutation(expectedRevision))); }
  validate(id: string, phase: string, reportId?: string) { return this.domain.validatePhase(id, phase, { reportId }); }
  approve(id: string, phase: string, approvalRef: string, expectedRevision?: number) { return this.lifecycle(() => this.domain.approvePhase(id, phase, approvalRef, mutation(expectedRevision))); }
  registerJobs(id: string) { return this.domain.registerJobs(id, mutation()); }
  updateJob(id: string, jobId: string, status: "running" | "completed") { return this.domain.updateJob(id, jobId, status, mutation()); }
  job(id: string, jobId: string, session?: AppConversation) { return this.domain.getJobContext(id, jobId, session ? this.reference(session) : null); }
  overview(sessions: readonly (AppConversation & { title?: string })[]): WorkstreamOverview {
    const registered = this.domain.listConversations();
    const byRef = new Map(registered.map(conversation => [JSON.stringify([conversation.ref.harness, conversation.ref.authorityId, conversation.ref.nativeId]), conversation]));
    const rows: WorkstreamOverview["conversations"] = sessions.map(session => { const ref = this.reference(session); return { ref, sessionId: session.sessionId, title: session.title || session.sessionId, conversation: byRef.get(JSON.stringify([ref.harness, ref.authorityId, ref.nativeId])) ?? null }; });
    for (const conversation of registered) if (!rows.some(row => row.ref && sameRef(row.ref, conversation.ref))) rows.push({ ref: conversation.ref, sessionId: null, title: conversation.ref.nativeId, conversation });
    return { repositoryId: this.repositoryId, workstreams: this.domain.listStatuses(), conversations: rows };
  }
  manage(ref: ConversationRef, operation: string, input: Record<string, any>) {
    if (operation === "associate") return this.mutate({ kind: operation, ref, workstreamId: input.workstreamId }, () => this.domain.associateConversation(ref, input.workstreamId, mutation()));
    if (operation === "phase/assign") return this.mutate({ kind: operation, ref }, () => this.domain.assignPhase(ref, input.phase, mutation()));
    if (operation === "phase/end") return this.mutate({ kind: operation, assignmentId: input.assignmentId }, () => this.domain.endAssignment(input.assignmentId, mutation()));
    throw new WorkstreamAdapterError(400, "invalid-request", "Unknown management action");
  }
  status(id: string) { return this.domain.getStatus(id); }
  create(input: CreateWorkstreamInput) { return this.mutate({ kind: "create", workstreamId: input.id }, () => this.domain.createWorkstream(input, mutation())); }
  setDefaultCheckout(id: string, checkout: string | null) { return this.mutate({ kind: "default-checkout", workstreamId: id, checkout }, () => this.domain.setDefaultCheckout(id, checkout, mutation())); }
  conversation(session: AppConversation) { return this.domain.getConversation(this.reference(session)); }
  preflight(executionCheckout: string) { return this.domain.validateExecutionCheckout(executionCheckout); }
  register(session: AppConversation, parent?: ConversationRef | null) {
    const ref = this.reference(session), source = this.sources[ref.harness];
    if (normalizeNativeSource(source.descriptor).authorityId !== ref.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Native source differs from persisted identity");
    return this.mutate({ kind: "register", ref }, () => {
      this.domain.declareNativeAuthority(source.descriptor, mutation());
      return this.domain.registerConversation({ ref, executionCheckout: session.cwd, parent }, mutation());
    });
  }
  associate(session: AppConversation, workstreamId: string | null) { const ref = this.reference(session); return this.mutate({ kind: "associate", ref, workstreamId }, () => this.domain.associateConversation(ref, workstreamId, mutation())); }
  assignPhase(session: AppConversation, phase: Phase) { const ref = this.reference(session); return this.mutate({ kind: "phase/assign", ref }, () => this.domain.assignPhase(ref, phase, mutation())); }
  endPhase(_session: AppConversation, assignmentId: string) { this.mutate({ kind: "phase/end", assignmentId }, () => this.domain.endAssignment(assignmentId, mutation())); }
  resolveTarget(workstreamId: string, phase: Phase, target?: ConversationRef) { return this.domain.resolvePhaseTarget(workstreamId, phase, target); }
  listArtifacts(id: string) { return this.domain.listArtifacts(id); }
  readArtifact(id: string, path: string) { return this.domain.readArtifact(id, path); }
  readArtifactSnapshot(id: string, path: string) { return this.domain.readArtifactSnapshot(id, path); }
  documentCatalog(id: string) { return this.domain.getDocumentCatalog(id); }
  invocation(session: AppConversation) {
    const context = this.domain.resolveContext(this.reference(session));
    if (session.cwd !== context.executionCheckout) throw new WorkstreamAdapterError(409, "app-checkout-mismatch", "App execution differs from its domain pin");
    return context;
  }
}

/** Cache handles by immutable domain identity AND complete filesystem evidence. */
export class RepositoryRouter {
  private cache = new Map<string, WorkstreamAdapter>();
  /** Read-only reuse of a fully opened adapter; filesystem evidence is checked on every access. */
  private polls = new Map<string, { root: string; commonDir: string; worktreeId: string; bindingRevision: string; adapter: WorkstreamAdapter }>();
  constructor(private catalog: CatalogService, private sources: SourceRecords, private readonly hooks: WorkstreamMutationHooks = {}) {}
  private async checkout(workspaceId: string) {
    if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
    const workspace = await this.catalog.get(workspaceId);
    if (workspace.kind !== "repository") throw new WorkstreamAdapterError(409, "not-repository", "Plain directory has no repository domain");
    for (const tree of workspace.worktrees) {
      if (tree.state !== "available") continue;
      await this.catalog.binding(workspaceId, tree.worktreeId);
      return { root: tree.root, commonDir: workspace.commonDir!, worktreeId: tree.worktreeId, bindingRevision: tree.bindingRevision };
    }
    throw new WorkstreamAdapterError(409, "unavailable", "No valid checkout is available");
  }
  private discover(checkout: { root: string; commonDir: string }) {
    const discovered = discoverRepository(checkout.root);
    if (discovered.commonDir !== checkout.commonDir) throw new WorkstreamAdapterError(409, "stale-binding", "Repository binding changed");
    return discovered;
  }
  private async discovery(workspaceId: string) { return this.discover(await this.checkout(workspaceId)); }
  async inspect(workspaceId: string) { return inspectRepositoryStore(await this.discovery(workspaceId)); }
  async initialize(workspaceId: string) {
    const discovery = await this.discovery(workspaceId);
    synchronousMutationHook(() => this.hooks.beforeInitialize?.(workspaceId, discovery), this.hooks.mutationFailed);
    try {
      initializeRepository(discovery);
    } catch (error) {
      mutationFailure(error, this.hooks.mutationFailed);
    }
    return this.inspect(workspaceId);
  }
  private key(context: RepositoryContext) { return JSON.stringify([context.repositoryId, context.schemaVersion, context.primaryPin, context.invocationCheckout, context.stateRoot]); }
  private open(context: RepositoryContext) {
    // An explicit local upgrade invalidates old handles even when UUID/inode stay
    // stable. Evict them before reopening the freshly inspected capability.
    for (const [cachedKey, cached] of this.cache) if (cached.repositoryId === context.repositoryId && cached.domain.context.schemaVersion !== context.schemaVersion) { cached.close(); this.cache.delete(cachedKey); }
    const key = this.key(context);
    let adapter = this.cache.get(key);
    if (!adapter) { adapter = new WorkstreamAdapter(openRepositoryDomain(context), this.sources, this.hooks); this.cache.set(key, adapter); }
    try { adapter.domain.validateHandle(); return adapter; }
    catch (error) { adapter.close(); this.cache.delete(key); throw error; }
  }
  private ready(discovery: RepositoryDiscovery, expectedRepositoryId?: string) {
    const store = inspectRepositoryStore(discovery);
    if (store.state !== "ready") throw new RepositoryStoreError(store);
    if (expectedRepositoryId && store.context.repositoryId !== expectedRepositoryId) throw new WorkstreamAdapterError(409, "domain-mismatch", "The intended domain UUID changed");
    return this.open(store.context);
  }
  async forWorkspace(workspaceId: string, expectedRepositoryId?: string) { return this.ready(await this.discovery(workspaceId), expectedRepositoryId); }
  /** Read-only requests only. Cache misses retain full catalog/Git/SQLite discovery. */
  async forPolling(workspaceId: string) {
    if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
    const entry = this.polls.get(workspaceId);
    if (entry) {
      const workspace = await this.catalog.registered(workspaceId);
      const tree = workspace.worktrees.find(tree => tree.state === "available");
      if (workspace.kind === "repository" && entry.commonDir === workspace.commonDir && entry.root === tree?.root && entry.worktreeId === tree.worktreeId && entry.bindingRevision === tree.bindingRevision && this.cache.get(this.key(entry.adapter.domain.context)) === entry.adapter) {
        try { entry.adapter.domain.validatePolling(); }
        catch (error) { this.polls.delete(workspaceId); this.cache.delete(this.key(entry.adapter.domain.context)); entry.adapter.close(); throw error; }
        return entry.adapter;
      }
    }
    this.polls.delete(workspaceId);
    const checkout = await this.checkout(workspaceId);
    const adapter = this.ready(this.discover(checkout));
    this.polls.set(workspaceId, { ...checkout, adapter });
    return adapter;
  }
  async forAdmission(admission: Admission, suppliedWorkspaceId?: string) {
    if (suppliedWorkspaceId && suppliedWorkspaceId !== admission.binding.workspaceId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation and requested workspace differ");
    if (admission.binding.domain.mode === "app-only") return null;
    const adapter = await this.forWorkspace(admission.binding.workspaceId, admission.binding.domain.repositoryId);
    if (adapter.domain.primaryCheckout !== admission.binding.domain.primaryCheckout) throw new WorkstreamAdapterError(409, "domain-mismatch", "The intended primary checkout changed");
    return adapter;
  }
  /** Current execution pin and membership; App-only domains have no workstream. */
  async execution(admission: Admission): Promise<ExecutionContext> {
    if (admission.state !== "ready" || !admission.nativeId) throw new WorkstreamAdapterError(409, "admission-pending", "Conversation admission is not ready");
    if (normalizeNativeSource(admission.source.descriptor).authorityId !== admission.source.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Source pin changed");
    const b = admission.binding, binding = await this.catalog.binding(b.workspaceId, b.worktreeId);
    if (binding.bindingRevision !== b.bindingRevision || binding.cwd !== b.executionCheckout) throw new WorkstreamAdapterError(409, "stale-binding", "Execution checkout binding changed");
    const adapter = await this.forAdmission(admission);
    if (adapter) {
      revalidateCheckout(adapter.domain.context, b.checkoutPin!);
      const context = adapter.domain.resolveContext({ harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId });
      return { executionCheckout: context.executionCheckout, workstreamId: context.workstream?.id ?? null, artifactsRoot: context.artifactsRoot };
    }
    return { executionCheckout: binding.cwd, workstreamId: null, artifactsRoot: null };
  }
  close() { for (const adapter of this.cache.values()) adapter.close(); this.cache.clear(); this.polls.clear(); }
}

export type WorkstreamAuthorization = (request: Request) => Response | null | Promise<Response | null>;
export function validateWorkstreamInput(operation: string, input: unknown): asserts input is Record<string, any> {
  const invalid = (field: string): never => { throw new WorkstreamAdapterError(400, "invalid-request", `Invalid or missing ${field}`); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(input)) return invalid("request object");
  const string = (field: string) => { if (typeof input[field] !== "string" || !input[field]) invalid(field); };
  switch (operation) {
    case "validate": case "approve": case "provide": {
      const fields = ["id", "phase", "repositoryId", "expectedRevision", "sessionId", "approvalRef"];
      if (Object.keys(input).some(field => !fields.includes(field))) invalid("action field");
      if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(input.id)) invalid("id");
      if (!["design", "engineering", "planning", "execution"].includes(input.phase as string)) invalid("phase");
      if (!uuid(input.repositoryId)) invalid("repositoryId");
      if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) invalid("expectedRevision");
      if ("sessionId" in input && !uuid(input.sessionId)) invalid("sessionId");
      if (operation === "approve" || "approvalRef" in input) {
        if (typeof input.approvalRef !== "string" || !input.approvalRef.trim() || input.approvalRef.includes("\0")) invalid("approvalRef");
      }
      break;
    }
    case "create": string("id"); string("title"); if (!["feature", "foundation", "issue", "maintenance"].includes(input.type as string)) invalid("type"); break;
    case "default-checkout": string("id"); if (input.checkout !== null) string("checkout"); break;
    case "target": string("id"); string("phase"); if ("target" in input && (!object(input.target) || !["cc", "oc"].includes(input.target.harness as string) || typeof input.target.authorityId !== "string" || typeof input.target.nativeId !== "string")) invalid("qualified target"); break;
    case "artifacts/catalog": case "artifacts/list": case "artifacts/read":
      string("id");
      if (operation === "artifacts/read") string("path");
      if (operation === "artifacts/catalog" || "repositoryId" in input) {
        if (!uuid(input.repositoryId)) invalid("repositoryId");
      }
      break;
    case "conversation": case "context": case "enroll": string("sessionId"); break;
    case "associate": string("sessionId"); if (input.workstreamId !== null) string("workstreamId"); break;
    case "phase/assign": string("sessionId"); string("phase"); break;
    case "phase/end": string("assignmentId"); break;
    default: throw new WorkstreamAdapterError(404, "not-found", "Unknown workstream operation");
  }
}
export async function flushAndCloseWorkstreams(flush: () => Promise<void>, close: () => void, retainOwnership: () => void): Promise<void> {
  if (process.env.SANE_TEST_FAULT === "shutdown-drain-fail") {
    // Test-only failed drain (C9): force ownership retention so shutdown
    // refuses takeover until explicit reconciliation. Never active otherwise.
    retainOwnership();
    throw new Error("SANE_TEST_FAULT: forced drain failure (test-only)");
  }
  try { await flush(); } catch (error) { retainOwnership(); throw error; }
  finally { try { close(); } catch (error) { retainOwnership(); throw error; } }
}
export async function authenticatedWorkstreamRoute(request: Request, authorize: WorkstreamAuthorization, operation: () => unknown | Promise<unknown>): Promise<Response> {
  const denied = await authorize(request); if (denied !== null) return denied;
  try { return Response.json(await operation() ?? { ok: true }, { headers: { "cache-control": "no-store" } }); }
  catch (error) {
    if (!(error instanceof DomainError) && !(error instanceof WorkstreamAdapterError)) throw error;
    const status = error instanceof WorkstreamAdapterError ? error.status : error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_INPUT" || error.code === "INVALID_ARTIFACT" ? 400 : error.code === "STORAGE_ERROR" ? 500 : 409;
    return Response.json({ error: error.message, code: error.code }, { status, headers: { "cache-control": "no-store" } });
  }
}
