import { isPendingInputRequest, isPendingInputRemovalRequest, isPendingInputResumeRequest, type PendingInputRequest, type PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";
import { PendingInputStore } from "./pending-input-store";
import { PendingInputCodecError, PendingInputDomainError, PendingInputStorageError, type PendingInputLiveValidation, type PendingInputPins, type PendingInputResumeResult, type PendingInputStoredItem } from "./pending-input-contract";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { equal, immutable } from "./prepared-input-codec";
import { validateRequest } from "./pending-input-codec";
import { uuid, type Session } from "./history";
import type { PreparedUserInput } from "./user-input-preparation";

export type PendingInputPreflight = { pins: PendingInputPins; validate: () => void };
/** Internal live capability, never returned through the wire receipt. Only a new
 * successful durable commit calls this hook; historical/deduplicated receipts do
 * not renew consent. The original head and observed revision survived all awaits. */
export type PendingInputResumeCommit = Readonly<{
  request: Readonly<PendingInputResumeRequest>; receipt: Readonly<PendingInputResumeResult>;
  chainId: string; head: Readonly<PendingInputStoredItem>; preflight: Readonly<PendingInputPreflight>;
}>;
export type PendingInputServiceDependencies = {
  dataDir: string; storeId: string;
  session: (id: string) => Session | undefined;
  /** Process/storage/startup gates always apply. Removal must NOT inherit
   * branch/lifecycle/configuration/ordinary execution refusal. */
  guard: (action: "enqueue" | "resume" | "remove", id: string) => void;
  prepare: (id: string, text: string) => Promise<PreparedUserInput>;
  preflight: (prepared: PreparedUserInput) => Promise<PendingInputPreflight>;
  failClosed: (error: PendingInputStorageError) => void;
  /** Bridge ownership/shutdown supervision, including backend callers. */
  supervise: <T>(action: () => Promise<T>) => Promise<T>;
  mutationGuard: () => void;
  /** Phase 4 injection only: must check exact live lease/authorization and all
   * source/config/context pins. Persisted authorization DTOs are not sufficient.
   * Without it the internal store refuses every dispatch journal mutation. */
  validateDispatch?: (input: PendingInputLiveValidation) => void;
  resumeCommitted?: (commit: PendingInputResumeCommit) => void;
  committed?: (kind: "enqueue" | "remove" | "resume") => void;
  automationStarted?: () => boolean;
};
function refused(code: string, reason: string, status: 400 | 404 | 409 = 409): never { throw new PendingInputDomainError(code, reason, status); }
const copy = <T>(v: T): T => immutable(structuredClone(v));

/** Backend-only API/service. No advertisements, timer, capacity reservation,
 * native calls, claims, SSE or transcript events. Explicit wire requests ASSERT
 * current launch settings; they never select new settings or upgrade profiles. */
export class PendingInputService {
  readonly store: PendingInputStore;
  private validation?: PendingInputPreflight;
  constructor(private readonly deps: PendingInputServiceDependencies) {
    try {
      this.store = new PendingInputStore(deps.dataDir, deps.storeId, { beforeMutation: deps.mutationGuard, validateLive: input => {
        if (input.stage === "enqueue" || input.stage === "resume") {
          this.deps.guard(input.stage, input.snapshot.prepared.binding.conversationId);
          if (!this.validation || !equal(this.validation.pins, input.snapshot.pins)) refused("pending-input-preflight", "Exact synchronous queue preflight is required");
          this.validation!.validate();
        } else {
          if (!deps.validateDispatch) refused("pending-input-dispatch-dormant", "Queue dispatch is not integrated in this phase");
          deps.validateDispatch!(input);
        }
      } });
    } catch (error) { this.storageError(error); throw error; }
  }
  private storageError(error: unknown) { if (error instanceof PendingInputStorageError) this.deps.failClosed(error); }
  private committed(kind: "enqueue" | "remove" | "resume") {
    try { synchronousDispatchHook(() => this.deps.committed?.(kind)); }
    catch (error) { throw new PendingInputStorageError("Pending input commit notification failed; reconcile original receipt", error); }
  }
  private async protect<T>(action: () => T | Promise<T>): Promise<T> {
    return this.deps.supervise(async () => {
      try { return await action(); }
      catch (error) {
        this.storageError(error);
        if (error instanceof PendingInputCodecError) return refused("invalid-pending-input", error.message, 400);
        throw error;
      }
    });
  }
  private known(id: string) {
    if (!uuid(id)) refused("invalid-conversation-id", "Invalid conversation identity", 400);
    return this.deps.session(id) ?? refused("pending-input-not-found", "Unknown conversation", 404);
  }
  private during<T>(preflight: PendingInputPreflight, action: () => T): T {
    if (this.validation) refused("pending-input-reentrant", "Queue preflight commit already in progress");
    this.validation = preflight;
    try { preflight.validate(); return action(); } finally { this.validation = undefined; }
  }
  hasChain(id: string) { return this.store.inspect(id).chain !== null; }
  private duplicate(request: PendingInputRequest) {
    const old = this.store.lookup(request.conversationId, request.requestId);
    if (old && !equal(old.item.request, request)) refused("pending-input-id-conflict", "Input request ID reused with different intent");
    return old?.receipt;
  }
  async enqueue(id: string, value: unknown) {
    return this.protect(async () => {
      if (!isPendingInputRequest(value) || !uuid(value.requestId) || !uuid(value.conversationId)) refused("invalid-pending-input", "Invalid version 1 queue request", 400);
      const request = copy(value as PendingInputRequest);
      if (request.conversationId !== id) refused("pending-input-route-conflict", "Route and body conversation identities differ");
      if (!request.source.authorityId || !request.source.nativeSessionId) refused("pending-input-source-unknown", "Established executable native identity is required");
      validateRequest(request);
      this.deps.guard("remove", id); // Ownership gates, not mutable enqueue policy.
      // Original wire intent is durable. Lookup MUST precede current preparation,
      // profiles, admission, filesystem/context, safety pause and capacity checks.
      const old = this.duplicate(request); if (old) return old;
      if (this.store.readRecords().conversations.find(c => c.conversationId === id)?.operations.some(o => o.request.requestId === request.requestId)) refused("pending-input-id-conflict", "Request ID already belongs to another operation");
      this.known(id); this.deps.guard("enqueue", id);
      let prepared: PreparedUserInput, preflight: PendingInputPreflight;
      try {
        prepared = await this.deps.prepare(id, request.text);
        const preparedDuplicate = this.duplicate(request); if (preparedDuplicate) { this.deps.guard("remove", id); return preparedDuplicate; }
        preflight = await this.deps.preflight(prepared);
      } catch (error) {
        // Concurrent original admission may have completed during an await that
        // now fails against changed live state. Its durable receipt still wins.
        if (!(error instanceof PendingInputStorageError)) { const receipt = this.duplicate(request); if (receipt) { this.deps.guard("remove", id); return receipt; } }
        throw error;
      }
      this.deps.guard("remove", id);
      const preflightDuplicate = this.duplicate(request); if (preflightDuplicate) return preflightDuplicate;
      const b = prepared.binding, c = prepared.configuration;
      const asserted = { version: 1, requestId: request.requestId, conversationId: id, text: request.text,
        source: { harnessId: b.harness, conversationId: id, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId ?? null, cwd: b.cwd },
        configuration: { cwd: b.cwd, profileId: c.profileId, ...(c.model === undefined ? {} : { model: c.model }), ...(c.effort === undefined ? {} : { effort: c.effort }), ...(c.agent === undefined ? {} : { agent: c.agent }) } };
      if (!equal(request, asserted)) refused("pending-input-assertion-conflict", "Queue source/configuration assertions differ from server-owned preparation");
      // All awaits finish before synchronous authoritative validation + commit.
      return this.during(preflight, () => {
        const revision = this.store.get(id).revision;
        const receipt = this.store.enqueue({ request, snapshot: { prepared, pins: preflight.pins } });
        if (receipt.revision > revision) this.committed("enqueue");
        return receipt;
      });
    });
  }
  async remove(id: string, itemId: string, value: unknown) {
    return this.protect(() => {
      if (!isPendingInputRemovalRequest(value) || ![value.conversationId, value.requestId, value.inputRequestId, value.itemId].every(uuid)) refused("invalid-pending-input-removal", "Invalid removal request", 400);
      if (value.conversationId !== id || value.itemId !== itemId) refused("pending-input-route-conflict", "Route and body removal identities differ");
      this.known(id); this.deps.guard("remove", id);
      const before = this.store.lookup(id, value.inputRequestId)?.item;
      const receipt = this.store.remove(value);
      if (before?.state === "waiting" && receipt.outcome === "removed") this.committed("remove");
      return receipt;
    });
  }
  async resume(id: string, value: unknown) {
    return this.protect(async () => {
      if (!isPendingInputResumeRequest(value) || !uuid(value.conversationId) || !uuid(value.requestId)) refused("invalid-pending-input-resume", "Invalid observed-revision resume request", 400);
      const request = copy(value);
      if (request.conversationId !== id) refused("pending-input-route-conflict", "Route and body resume identities differ");
      this.known(id);
      this.deps.guard("remove", id);
      const records = this.store.readRecords(), c = records.conversations.find(c => c.conversationId === id);
      // The operation ledger dedups before live preflight just like enqueue.
      if (c?.operations.some(o => o.request.requestId === request.requestId)) return this.store.resume(request);
      if (c?.items.some(i => i.requestId === request.requestId || i.claim?.attemptId === request.requestId)) refused("pending-input-id-conflict", "Request ID already belongs to another operation");
      if (c && request.expectedRevision !== c.revision) refused("pending-input-stale", "Resume revision is stale");
      if (c?.items.some(i => ["claimed", "run-linked"].includes(i.state))) refused("pending-input-claimed", "Resume cannot clear or retry unresolved claims");
      this.deps.guard("resume", id);
      const head = c?.items.find(i => i.state === "waiting");
      if (!head) refused("pending-input-no-chain", "Resume requires the existing waiting chain");
      let preflight: PendingInputPreflight;
      try { preflight = await this.deps.preflight(head!.snapshot.prepared); }
      catch (error) {
        if (!(error instanceof PendingInputStorageError) && this.store.readRecords().conversations.find(c => c.conversationId === id)?.operations.some(o => o.request.requestId === request.requestId)) { this.deps.guard("remove", id); return this.store.resume(request); }
        throw error;
      }
      this.deps.guard("remove", id);
      if (this.store.readRecords().conversations.find(c => c.conversationId === id)?.operations.some(o => o.request.requestId === request.requestId)) return this.store.resume(request);
      const current = this.store.readRecords().conversations.find(c => c.conversationId === id);
      if (!current || current.revision !== request.expectedRevision || current.chain?.chainId !== c!.chain?.chainId
        || current.items.find(i => i.state === "waiting")?.itemId !== head!.itemId
        || !equal(current.items.find(i => i.state === "waiting")?.request, head!.request)) refused("pending-input-stale", "Resume chain/head changed during preflight");
      if (!equal(preflight.pins, head!.snapshot.pins)) refused("pending-input-chain-conflict", "Resume pins differ from the original waiting chain");
      return this.during(preflight, () => {
        const revision = this.store.get(id).revision;
        const receipt = this.store.resume(request);
        if (receipt.revision <= revision) return receipt;
        // The store never publishes a post-rename failure. A callback failure
        // after durability is also uncertainty, not a retryable/silent resend.
        try {
          synchronousDispatchHook(() => this.deps.resumeCommitted?.(Object.freeze({ request, receipt,
            chainId: current.chain!.chainId, head: copy(head!),
            preflight: Object.freeze({ pins: copy(preflight.pins), validate: preflight.validate }) })));
        } catch (error) { throw new PendingInputStorageError("Pending input resume capability publication failed; reconcile original receipt", error); }
        this.committed("resume");
        return receipt;
      });
    });
  }
  async get(id: string) {
    return this.protect(async () => {
      const session = this.known(id);
      let enqueue = { allowed: true, code: null as string | null, reason: null as string | null };
      let source: PendingInputRequest["source"] | null = null, configuration: PendingInputRequest["configuration"] | null = null;
      let pins: PendingInputPins | undefined;
      try {
        this.deps.guard("enqueue", id);
        const prepared = await this.deps.prepare(id, "Queue eligibility inspection");
        const preflight = await this.deps.preflight(prepared); preflight.validate();
        pins = preflight.pins;
        const b = prepared.binding, c = prepared.configuration;
        source = { harnessId: b.harness, conversationId: id, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId ?? null, cwd: b.cwd };
        configuration = { cwd: b.cwd, profileId: c.profileId, ...(c.model === undefined ? {} : { model: c.model }), ...(c.effort === undefined ? {} : { effort: c.effort }), ...(c.agent === undefined ? {} : { agent: c.agent }) };
      } catch (error) {
        if (error instanceof PendingInputStorageError) throw error;
        enqueue = { allowed: false, code: error instanceof PendingInputDomainError ? error.code : "pending-input-unavailable", reason: error instanceof Error ? error.message : "Queue admission unavailable" };
      }
      let removalAllowed = true;
      try { this.deps.guard("remove", id); } catch (error) { if (error instanceof PendingInputStorageError) throw error; removalAllowed = false; }
      const state = this.store.inspect(id), unresolved = state.snapshot.items.find(i => i.state !== "waiting"), waitingCount = state.snapshot.items.filter(i => i.state === "waiting").length;
      const pinnedRequest = state.chain ? this.store.lookup(id, state.snapshot.items[0]!.requestId)!.item.request : null;
      if (enqueue.allowed && state.chain && !equal(state.chain.pins, pins)) enqueue = { allowed: false, code: "pending-input-chain-conflict", reason: "Current source/config/context differs from the pinned chain" };
      const resumeEligible = enqueue.allowed && !unresolved && waitingCount > 0;
      let automationStarted = false;
      try {
        synchronousDispatchHook(() => automationStarted = this.deps.automationStarted?.() ?? false);
        if (typeof automationStarted !== "boolean") throw new Error("Queue automation availability must be synchronous boolean");
      } catch (error) { throw new PendingInputStorageError("Pending input automation availability failed", error); }
      if (enqueue.allowed && waitingCount >= 3) enqueue = { allowed: false, code: "pending-input-full", reason: "At most three waiting inputs are allowed" };
      // Keep exact dormant wire v1 snapshot separate from presentation metadata.
      return { snapshot: state.snapshot, presentation: { maxWaiting: 3, waitingCount,
        chainLocked: state.chain !== null, chainId: state.chain?.chainId ?? null, source: pinnedRequest?.source ?? source, configuration: pinnedRequest?.configuration ?? configuration,
        currentAssertions: source && configuration ? { source, configuration } : null,
        removals: state.snapshot.items.map(i => ({ itemId: i.itemId, allowed: removalAllowed && i.state === "waiting", code: i.state === "waiting" ? removalAllowed ? null : "pending-input-owner-unavailable" : "pending-input-claimed" })),
        unresolved: unresolved ? { itemId: unresolved.itemId, requestId: unresolved.requestId, runId: unresolved.runId, classification: this.store.lookup(id, unresolved.requestId)!.classification } : null,
        pauseCode: state.pause?.code ?? (state.recoveryRequired ? "restart" : null), enqueue, removalAllowed,
        resumeAllowed: removalAllowed && resumeEligible, automation: { supported: automationStarted, reason: automationStarted ? null : "Queue automation has not been activated" }, hidden: !!session.hidden } };
    });
  }
  async status(id: string, requestId: string) {
    return this.protect(() => {
      this.known(id); if (!uuid(requestId)) refused("invalid-request-id", "Invalid input request identity", 400);
      const old = this.store.lookup(id, requestId) ?? refused("pending-input-not-found", "Unknown original input request", 404);
      return { version: 1, conversationId: id, requestId, receipt: old.receipt, classification: old.classification, itemId: old.item.itemId, sequence: old.item.sequence,
        ...(old.item.claim ? { runId: old.item.claim.identity.runId, nativeCommandId: old.item.claim.identity.nativeCommandId } : {}) };
    });
  }
  recover() {
    try { return this.store.recover(); } catch (error) { this.storageError(error); throw error; }
  }
}

export async function pendingInputRoute(request: Request, path: string, service: PendingInputService): Promise<Response | undefined> {
  const match = /^\/api\/sessions\/([^/]+)\/pending-inputs(?:\/(resume|inputs\/([^/]+)|([^/]+)\/remove))?$/.exec(path);
  if (!match) return undefined;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  let correlation: { conversationId: string; requestId?: string; inputRequestId?: string; itemId?: string } | undefined;
  try {
    const id = decodeURIComponent(match[1]!);
    if (uuid(id)) correlation = { conversationId: id };
    if (request.method === "GET" && !match[2]) return json(await service.get(id));
    if (request.method === "GET" && match[3]) return json(await service.status(id, decodeURIComponent(match[3])));
    if (request.method !== "POST" || match[3]) return json({ error: "Method not allowed" }, 405);
    let input: unknown;
    try { input = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (correlation && input && typeof input === "object") for (const key of ["requestId", "inputRequestId", "itemId"] as const) {
      const value = (input as Record<string, unknown>)[key]; if (uuid(value)) correlation[key] = value;
    }
    if (!match[2]) return json(await service.enqueue(id, input), 202);
    if (match[2] === "resume") return json(await service.resume(id, input));
    const result = await service.remove(id, decodeURIComponent(match[4]!), input);
    return json(result, result.outcome === "claimed" ? 409 : 200);
  } catch (error) {
    if (error instanceof URIError) return json({ error: "Invalid queue selector" }, 400);
    if (error instanceof PendingInputDomainError) return json({ error: error.message, code: error.code }, error.code === "pending-input-full" ? 429 : error.status);
    if (error instanceof PendingInputStorageError) return json({ error: "Queue storage unavailable; reconcile original identities without resending", code: error.code, reconciliationRequired: true, ...correlation }, 503);
    throw error;
  }
}
