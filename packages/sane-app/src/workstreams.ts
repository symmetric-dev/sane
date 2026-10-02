import { RepositoryDomain, DomainError, discoverRepository, inspectRepositoryStore, initializeRepository, openRepositoryDomain, normalizeNativeSource, revalidateCheckout } from "sane-core/server";
import type { ConversationRef, CreateWorkstreamInput, Phase, MutationContext, RepositoryContext } from "sane-core/contracts";
import { uuid, type Session } from "./history";
import type { WorkstreamOverview } from "./workstreams-contract";
import type { CatalogService } from "./catalog";
import type { Admission, SourceRecords } from "./app-store";

export type AppConversation = Pick<Session, "sessionId" | "harness" | "nativeSessionId" | "authorityId" | "cwd">;
export class WorkstreamAdapterError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const mutation = (expectedRevision?: number): MutationContext => ({ actor: { kind: "human" }, correlationId: crypto.randomUUID(), ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
const sameRef = (a: ConversationRef, b: ConversationRef) => a.harness === b.harness && a.authorityId === b.authorityId && a.nativeId === b.nativeId;
/** Repository-scoped synchronous adapter. No ambient or singleton domain selection. */
export class WorkstreamAdapter {
  constructor(readonly domain: RepositoryDomain, private readonly sources: SourceRecords) {}
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
  provide(id: string, phase: string, refreshTemplates = false, expectedRevision?: number) { return this.domain.providePhase(id, phase, { refreshTemplates }, mutation(expectedRevision)); }
  validate(id: string, phase: string, reportId?: string) { return this.domain.validatePhase(id, phase, { reportId }); }
  approve(id: string, phase: string, approvalRef: string, expectedRevision?: number) { return this.domain.approvePhase(id, phase, approvalRef, mutation(expectedRevision)); }
  registerJobs(id: string) { return this.domain.registerJobs(id, mutation()); }
  updateJob(id: string, jobId: string, status: "running" | "completed") { return this.domain.updateJob(id, jobId, status, mutation()); }
  job(id: string, jobId: string, session?: AppConversation) { return this.domain.getJobContext(id, jobId, session ? this.reference(session) : null); }
  overview(sessions: readonly (AppConversation & { title?: string })[]): WorkstreamOverview {
    const registered = this.domain.listConversations();
    const rows: WorkstreamOverview["conversations"] = sessions.map(session => { const ref = this.reference(session); return { ref, sessionId: session.sessionId, title: session.title || session.sessionId, conversation: this.domain.getConversation(ref) }; });
    for (const conversation of registered) if (!rows.some(row => row.ref && sameRef(row.ref, conversation.ref))) rows.push({ ref: conversation.ref, sessionId: null, title: conversation.ref.nativeId, conversation });
    return { repositoryId: this.repositoryId, workstreams: this.list().map(w => this.status(w.id)), conversations: rows };
  }
  manage(ref: ConversationRef, operation: string, input: Record<string, any>) {
    if (operation === "associate") return this.domain.associateConversation(ref, input.workstreamId, mutation());
    if (operation === "phase/assign") return this.domain.assignPhase(ref, input.phase, mutation());
    if (operation === "phase/end") return this.domain.endAssignment(input.assignmentId, mutation());
    throw new WorkstreamAdapterError(400, "invalid-request", "Unknown management action");
  }
  status(id: string) { return this.domain.getStatus(id); }
  create(input: CreateWorkstreamInput) { return this.domain.createWorkstream(input, mutation()); }
  setDefaultCheckout(id: string, checkout: string | null) { return this.domain.setDefaultCheckout(id, checkout, mutation()); }
  conversation(session: AppConversation) { return this.domain.getConversation(this.reference(session)); }
  preflight(executionCheckout: string) { return this.domain.validateExecutionCheckout(executionCheckout); }
  register(session: AppConversation, parent?: ConversationRef | null) {
    const ref = this.reference(session), source = this.sources[ref.harness];
    if (normalizeNativeSource(source.descriptor).authorityId !== ref.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Native source differs from persisted identity");
    this.domain.declareNativeAuthority(source.descriptor, mutation());
    return this.domain.registerConversation({ ref, executionCheckout: session.cwd, parent }, mutation());
  }
  associate(session: AppConversation, workstreamId: string | null) { return this.domain.associateConversation(this.reference(session), workstreamId, mutation()); }
  assignPhase(session: AppConversation, phase: Phase) { return this.domain.assignPhase(this.reference(session), phase, mutation()); }
  endPhase(_session: AppConversation, assignmentId: string) { this.domain.endAssignment(assignmentId, mutation()); }
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
  constructor(private catalog: CatalogService, private sources: SourceRecords) {}
  private async discovery(workspaceId: string) {
    if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
    const workspace = await this.catalog.get(workspaceId);
    if (workspace.kind !== "repository") throw new WorkstreamAdapterError(409, "not-repository", "Plain directory has no repository domain");
    for (const tree of workspace.worktrees) {
      if (tree.state !== "available") continue;
      await this.catalog.binding(workspaceId, tree.worktreeId);
      const discovered = discoverRepository(tree.root);
      if (discovered.commonDir !== workspace.commonDir) throw new WorkstreamAdapterError(409, "stale-binding", "Repository binding changed");
      return discovered;
    }
    throw new WorkstreamAdapterError(409, "unavailable", "No valid checkout is available");
  }
  async inspect(workspaceId: string) { return inspectRepositoryStore(await this.discovery(workspaceId)); }
  async initialize(workspaceId: string) { initializeRepository(await this.discovery(workspaceId)); return this.inspect(workspaceId); }
  private open(context: RepositoryContext) {
    const key = JSON.stringify([context.repositoryId, context.primaryPin, context.stateRoot]);
    let adapter = this.cache.get(key);
    if (!adapter) { adapter = new WorkstreamAdapter(openRepositoryDomain(context), this.sources); this.cache.set(key, adapter); }
    try { adapter.domain.getOverview(); return adapter; }
    catch (error) { adapter.close(); this.cache.delete(key); throw error; }
  }
  async forWorkspace(workspaceId: string, expectedRepositoryId?: string) {
    const store = await this.inspect(workspaceId);
    if (store.state !== "ready") throw new WorkstreamAdapterError(409, store.code, store.message);
    if (expectedRepositoryId && store.context.repositoryId !== expectedRepositoryId) throw new WorkstreamAdapterError(409, "domain-mismatch", "The intended domain UUID changed");
    return this.open(store.context);
  }
  async forAdmission(admission: Admission, suppliedWorkspaceId?: string) {
    if (suppliedWorkspaceId && suppliedWorkspaceId !== admission.binding.workspaceId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation and requested workspace differ");
    if (admission.binding.domain.mode === "app-only") return null;
    const adapter = await this.forWorkspace(admission.binding.workspaceId, admission.binding.domain.repositoryId);
    if (adapter.domain.primaryCheckout !== admission.binding.domain.primaryCheckout) throw new WorkstreamAdapterError(409, "domain-mismatch", "The intended primary checkout changed");
    return adapter;
  }
  async execution(admission: Admission) {
    if (admission.state !== "ready" || !admission.nativeId) throw new WorkstreamAdapterError(409, "admission-pending", "Conversation admission is not ready");
    if (normalizeNativeSource(admission.source.descriptor).authorityId !== admission.source.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Source pin changed");
    const b = admission.binding, binding = await this.catalog.binding(b.workspaceId, b.worktreeId);
    if (binding.bindingRevision !== b.bindingRevision || binding.cwd !== b.executionCheckout) throw new WorkstreamAdapterError(409, "stale-binding", "Execution checkout binding changed");
    const adapter = await this.forAdmission(admission);
    if (adapter) {
      revalidateCheckout(adapter.domain.context, b.checkoutPin!);
      return adapter.domain.resolveContext({ harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId }).executionCheckout;
    }
    return binding.cwd;
  }
  close() { for (const adapter of this.cache.values()) adapter.close(); this.cache.clear(); }
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
