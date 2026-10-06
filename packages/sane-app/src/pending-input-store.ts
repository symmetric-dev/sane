import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid } from "./history";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { equal, fingerprint, immutable, requireRecord, shape } from "./prepared-input-codec";
import { decodePendingInputRecords, decodePendingInputSnapshot, dispatchSource, pendingInputIntentFingerprint, PAUSE_CODES, validateAuthorization, validateEvidence, validateIdentity, validateRequestSnapshot } from "./pending-input-codec";
import { PendingInputCodecError, PendingInputDomainError, PendingInputStorageError, type PendingInputAuthorization, type PendingInputClaimRequest, type PendingInputConversation, type PendingInputEnqueue, type PendingInputLiveValidation, type PendingInputPause, type PendingInputRecords, type PendingInputResumeResult, type PendingInputStoredItem } from "./pending-input-contract";
import { isPendingInputRemovalRequest, isPendingInputResumeRequest, type PendingInputRemovalRequest, type PendingInputRemovalResult, type PendingInputResumeRequest, type PendingInputSnapshot } from "../shared/conversation/pending-input-contract";
import type { DispatchEvidenceHooks, DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";

const active = (i: PendingInputStoredItem) => ["waiting", "claimed", "run-linked"].includes(i.state);
const unresolved = (i: PendingInputStoredItem) => ["claimed", "run-linked"].includes(i.state);
function deny(code: string, reason: string, status: 400 | 404 | 409 | 429 = 409): never { throw new PendingInputDomainError(code, reason, status); }
const clone = <T>(v: T): T => immutable(structuredClone(v));
export type PendingInputStoreDependencies = {
  /** App installation/data ownership must already be held. No native I/O here. */
  /** Mandatory synchronous authority check. Use PendingInputDomainError for
   * expected refusals (busy/stale/pin drift); unexpected failures fail closed.
   * Claim/link/before-native must verify the live exact Phase 1 lease, not this
   * persisted DTO alone. Outcome/settlement checks must support reconciliation
   * of original identities without authorizing another submission. */
  validateLive: (input: PendingInputLiveValidation) => void;
  write?: typeof atomicAppRecord;
  newId?: () => string;
  /** Optional owning-service process fence; also applies to low-level backend
   * pause/recovery/journal APIs before any candidate mutation or durable write. */
  beforeMutation?: () => void;
};

/** Durable dormant queue authority. All mutations are synchronous candidate ->
 * strict decode -> atomic fsync/rename -> publication. It never acquires native
 * owners/capacity, subscribes, launches, or retries a claim. No tombstone expiry. */
export class PendingInputStore {
  private records: PendingInputRecords;
  private recoveryRequired = false;
  private storageFailed = false;
  private changing = false;
  constructor(private readonly dataDir: string, readonly storeId: string, private readonly deps: PendingInputStoreDependencies) {
    if (!uuid(storeId)) deny("invalid-store-id", "A real App store identity is required", 400);
    try {
      const root = lstatSync(dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataDir) !== dataDir) throw new Error("Noncanonical App directory");
      const path = join(dataDir, "pending-inputs.json"); let stat;
      try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!stat) { this.records = decodePendingInputRecords({ version: 1, storeId, nextSequence: 1, conversations: [] }, storeId); return; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe pending-inputs.json");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Pending input file changed during load");
        this.records = decodePendingInputRecords(JSON.parse(readFileSync(fd, "utf8")), storeId);
        const current = lstatSync(path);
        if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Pending input file changed during load");
      } finally { closeSync(fd); }
      this.recoveryRequired = this.records.conversations.some(c => c.items.some(active));
    } catch (error) { throw new PendingInputStorageError("Pending input store unavailable or corrupt; operator reconciliation required", error); }
  }
  private decode<T>(action: () => T): T {
    try { return action(); } catch (error) { if (error instanceof PendingInputCodecError) return deny("invalid-pending-input", error.message, 400); throw error; }
  }
  private change<T>(action: (candidate: PendingInputRecords) => T, recovery = false): T {
    try { synchronousDispatchHook(() => this.deps.beforeMutation?.()); }
    catch (error) {
      if (error instanceof PendingInputDomainError) throw error;
      this.storageFailed = true; throw new PendingInputStorageError("Pending input mutation ownership fence failed", error);
    }
    if (this.storageFailed) throw new PendingInputStorageError("Pending input storage failed; reload under App ownership before further mutation");
    if (this.changing) deny("pending-input-reentrant", "Pending input mutation already in progress");
    if (this.recoveryRequired && !recovery) deny("pending-input-recovery", "Startup classification must complete before pending input mutation");
    this.changing = true;
    try {
      const candidate = structuredClone(this.records), result = action(candidate);
      // Invalid candidates are invariants, not malformed user input. Fail closed
      // even before writing rather than pretending the queue is safe to retry.
      let validated: PendingInputRecords;
      try { validated = decodePendingInputRecords(candidate, this.storeId); }
      catch (error) { this.storageFailed = true; throw new PendingInputStorageError("Pending input invariant failed", error); }
      try { synchronousDispatchHook(() => (this.deps.write ?? atomicAppRecord)(this.dataDir, "pending-inputs.json", validated)); }
      catch (error) { this.storageFailed = true; throw new PendingInputStorageError("Pending input durable write failed; publication withheld", error); }
      this.records = validated;
      return clone(result);
    } finally { this.changing = false; }
  }
  private conversation(records: PendingInputRecords, id: string): PendingInputConversation {
    return records.conversations.find(c => c.conversationId === id) ?? deny("pending-input-not-found", "Unknown pending input conversation", 404);
  }
  private item(c: PendingInputConversation, itemId: string, requestId: string): PendingInputStoredItem {
    return c.items.find(i => i.itemId === itemId && i.requestId === requestId) ?? deny("pending-input-not-found", "Unknown pending input identity", 404);
  }
  private bump(c: PendingInputConversation) {
    if (c.revision >= Number.MAX_SAFE_INTEGER) deny("pending-input-exhausted", "Pending input revision space exhausted"); c.revision++;
  }
  private finishChain(c: PendingInputConversation) { if (!c.items.some(active)) c.chain = null; }
  private newId() { return this.deps.newId ? this.deps.newId() : crypto.randomUUID(); }
  private validate(c: PendingInputConversation, item: PendingInputStoredItem, stage: PendingInputLiveValidation["stage"], authorization?: PendingInputAuthorization) {
    const input: PendingInputLiveValidation = { stage, snapshot: item.snapshot, chainId: item.chainId, revision: c.revision,
      ...(item.claim ? { identity: item.claim.identity } : {}), ...(authorization ? { authorization } : {}) };
    try { synchronousDispatchHook(() => this.deps.validateLive(clone(input))); }
    catch (error) {
      if (error instanceof PendingInputDomainError) throw error;
      this.storageFailed = true; throw new PendingInputStorageError("Pending input live validation invariant failed", error);
    }
  }
  private namespace(c: PendingInputConversation, id: string) {
    if (c.items.some(i => i.requestId === id || i.claim?.attemptId === id) || c.operations.some(o => o.request.requestId === id)) deny("pending-input-id-conflict", "Request ID already belongs to another operation");
  }
  private duplicate(c: PendingInputConversation | undefined, id: string, kind: "remove" | "resume", hash: string) {
    const old = c?.operations.find(o => o.request.requestId === id);
    if (old) { if (old.kind !== kind || old.fingerprint !== hash) deny("pending-input-id-conflict", "Request ID reused with different intent"); return clone(old.result); }
    if (c) this.namespace(c, id);
  }
  readRecords(): PendingInputRecords { return clone(this.records); }
  get(conversationId: string): PendingInputSnapshot {
    if (!uuid(conversationId)) deny("invalid-conversation-id", "Invalid conversation identity", 400);
    const c = this.records.conversations.find(c => c.conversationId === conversationId);
    const pause = c?.pause ?? (this.recoveryRequired && c?.items.some(active) ? { code: "restart", reason: "Startup reconciliation and explicit resume required" } : null);
    return clone({ version: 1, conversationId, revision: c?.revision ?? 0, paused: pause !== null, reason: pause?.reason ?? null,
      items: (c?.items ?? []).filter(active).map(i => {
        const base = { ...i.request, itemId: i.itemId, sequence: i.sequence };
        return i.state === "waiting" ? { ...base, state: "waiting" as const }
          : i.state === "claimed" ? { ...base, state: "claimed" as const, runId: i.claim!.identity.runId }
          : { ...base, state: "run-linked" as const, runId: i.claim!.identity.runId };
      }),
      tombstones: (c?.items ?? []).filter(i => i.state === "removed").map(i => ({ itemId: i.itemId, requestId: i.requestId, conversationId, sequence: i.sequence, state: "removed" as const })) });
  }
  inspect(conversationId: string) {
    const c = this.records.conversations.find(c => c.conversationId === conversationId);
    return clone({ snapshot: this.get(conversationId), chain: c?.chain ?? null, pause: c?.pause ?? null, lastAuthorization: c?.lastAuthorization ?? null, lastPredecessorRunId: c?.lastPredecessorRunId ?? null, recoveryRequired: this.recoveryRequired, history: (c?.items ?? []).filter(i => !active(i)) });
  }
  lookup(conversationId: string, inputRequestId: string) {
    const item = this.records.conversations.find(c => c.conversationId === conversationId)?.items.find(i => i.requestId === inputRequestId);
    return item && clone({ receipt: item.receipt, classification: item.claim?.uncertain || this.recoveryRequired && unresolved(item) ? "uncertain" : item.state, item });
  }
  enqueue(input: PendingInputEnqueue) {
    this.decode(() => shape(input, ["request", "snapshot"]));
    const hash = this.decode(() => pendingInputIntentFingerprint(input.request, input.snapshot?.prepared));
    const existing = this.records.conversations.find(c => c.conversationId === input.request.conversationId), old = existing?.items.find(i => i.requestId === input.request.requestId);
    // Dedup the original intent BEFORE capacity, startup/pauses, live validation,
    // or decoding today's supplied mutable admission/catalog/context snapshot.
    if (old) { if (old.fingerprint !== hash) deny("pending-input-id-conflict", "Input request ID reused with different intent"); return clone(old.receipt); }
    if (existing) this.namespace(existing, input.request.requestId);
    // Strict queue decoding also requires launch === captured prior configuration,
    // before any live validation, durable write or dispatch claim can occur.
    const snapshot = this.decode(() => decodePendingInputSnapshot(input.snapshot)); this.decode(() => validateRequestSnapshot(input.request, snapshot));
    const source = dispatchSource(snapshot);
    if (this.records.conversations.some(c => c.conversationId !== source.sessionId && c.items.some(i => {
      const prior = dispatchSource(i.snapshot); return prior.harnessId === source.harnessId && prior.authorityId === source.authorityId && prior.nativeSessionId === source.nativeSessionId;
    }))) deny("pending-input-source-conflict", "Native identity already belongs to another App conversation");
    return this.change(records => {
      let c = records.conversations.find(c => c.conversationId === input.request.conversationId);
      if (!c) { c = { conversationId: input.request.conversationId, revision: 1, chain: null, pause: null, lastAuthorization: null, lastPredecessorRunId: null, items: [], operations: [] }; records.conversations.push(c); }
      else this.bump(c);
      if (c.items.filter(i => i.state === "waiting").length >= 3) deny("pending-input-full", "At most three waiting inputs are allowed", 429);
      if (c.chain && !equal(c.chain.pins, snapshot.pins)) deny("pending-input-chain-conflict", "Existing queue chain pins differ from this input");
      if (!c.chain) c.chain = { chainId: this.newId(), pins: snapshot.pins };
      if (records.nextSequence >= Number.MAX_SAFE_INTEGER) deny("pending-input-exhausted", "Pending input sequence space exhausted");
      const sequence = records.nextSequence++, itemId = this.newId();
      const receipt = { version: 1 as const, outcome: "enqueued" as const, conversationId: c.conversationId, requestId: input.request.requestId, itemId, sequence, revision: c.revision };
      const item: PendingInputStoredItem = { itemId, requestId: input.request.requestId, sequence, chainId: c.chain.chainId, fingerprint: hash, request: structuredClone(input.request), snapshot, receipt, state: "waiting", claim: null, history: null };
      this.validate(c, item, "enqueue"); c.items.push(item); return receipt;
    });
  }
  remove(request: PendingInputRemovalRequest): PendingInputRemovalResult {
    this.decode(() => requireRecord(isPendingInputRemovalRequest(request) && [request.requestId, request.conversationId, request.itemId, request.inputRequestId].every(uuid)));
    const hash = fingerprint(request), old = this.duplicate(this.records.conversations.find(c => c.conversationId === request.conversationId), request.requestId, "remove", hash);
    if (old) return old as PendingInputRemovalResult;
    return this.change(records => {
      const c = this.conversation(records, request.conversationId), item = this.item(c, request.itemId, request.inputRequestId); this.bump(c);
      let result: PendingInputRemovalResult;
      if (item.claim) result = { ...request, revision: c.revision, outcome: "claimed", runId: item.claim.identity.runId };
      else { const outcome = item.state === "removed" ? "already-removed" : "removed"; item.state = "removed"; result = { ...request, revision: c.revision, outcome }; }
      c.operations.push({ kind: "remove", fingerprint: hash, request: structuredClone(request), result }); this.finishChain(c); return result;
    });
  }
  resume(request: PendingInputResumeRequest): PendingInputResumeResult {
    this.decode(() => requireRecord(isPendingInputResumeRequest(request) && uuid(request.requestId) && uuid(request.conversationId)));
    const hash = fingerprint(request), old = this.duplicate(this.records.conversations.find(c => c.conversationId === request.conversationId), request.requestId, "resume", hash);
    if (old) return old as PendingInputResumeResult;
    return this.change(records => {
      const c = this.conversation(records, request.conversationId);
      if (request.expectedRevision !== c.revision) deny("pending-input-stale", "Resume revision is stale");
      if (c.items.some(unresolved)) deny("pending-input-claimed", "Resume cannot clear or retry unresolved claims");
      const head = c.items.find(i => i.state === "waiting"); if (!c.chain || !head) deny("pending-input-no-chain", "Resume requires the existing waiting chain");
      this.validate(c, head, "resume"); c.pause = null; this.bump(c);
      const result = { ...request, outcome: "resumed" as const, revision: c.revision };
      c.operations.push({ kind: "resume", fingerprint: hash, request: structuredClone(request), result }); return result;
    });
  }
  pause(conversationId: string, pause: PendingInputPause) {
    this.decode(() => { shape(pause, ["code", "reason"]); requireRecord(PAUSE_CODES.includes(pause.code) && typeof pause.reason === "string" && !!pause.reason.trim()); });
    const prior = this.records.conversations.find(c => c.conversationId === conversationId);
    if (prior && equal(prior.pause, pause)) return clone(prior.pause);
    return this.change(records => { const c = this.conversation(records, conversationId); c.pause = structuredClone(pause); this.bump(c); return c.pause; });
  }
  claim(request: PendingInputClaimRequest) {
    this.decode(() => { shape(request, ["conversationId", "itemId", "inputRequestId", "expectedRevision", "attemptId", "runId", "nativeCommandId", "authorization"]); requireRecord([request.conversationId, request.itemId, request.inputRequestId, request.attemptId, request.runId].every(uuid)); validateAuthorization(request.authorization); });
    return this.change(records => {
      const c = this.conversation(records, request.conversationId), item = this.item(c, request.itemId, request.inputRequestId);
      if (c.revision !== request.expectedRevision) deny("pending-input-stale", "Claim revision is stale");
      if (c.pause) deny("pending-input-paused", c.pause.reason);
      if (c.items.some(unresolved)) deny("pending-input-claimed", "One unresolved claim already owns this chain");
      if (c.items.find(i => i.state === "waiting") !== item || item.state !== "waiting") deny("pending-input-not-head", "Only the exact oldest waiting input can be claimed");
      this.namespace(c, request.attemptId);
      const source = dispatchSource(item.snapshot), identity: DispatchIdentity = { source, runId: request.runId, nativeCommandId: request.nativeCommandId, requestId: item.requestId };
      this.decode(() => validateIdentity(identity));
      if (request.authorization.kind !== "dispatch" || request.authorization.chainId !== item.chainId || !equal(request.authorization.source, source)) deny("pending-input-authorization", "Claim authorization is not bound to this chain/source");
      if (c.lastAuthorization?.chainId === item.chainId && request.authorization.predecessorRunId !== c.lastPredecessorRunId) deny("pending-input-authorization", "Claim must follow this chain's last authorized predecessor");
      if (records.conversations.some(c => c.items.some(i => i.claim && (i.claim.identity.runId === identity.runId || identity.nativeCommandId !== null && i.claim.identity.nativeCommandId === identity.nativeCommandId || i.claim.authorization.authorizationId === request.authorization.authorizationId || i.history?.kind === "settled" && i.history.authorization.authorizationId === request.authorization.authorizationId)))) deny("pending-input-id-conflict", "Preallocated dispatch identity or authorization was already used");
      item.claim = { attemptId: request.attemptId, expectedRevision: request.expectedRevision, identity, authorization: structuredClone(request.authorization), possibleNative: false, uncertain: false, evidence: null };
      this.validate(c, item, "claim", request.authorization); item.state = "claimed";
      this.bump(c); return item;
    });
  }
  private owned(records: PendingInputRecords, identity: DispatchIdentity) {
    this.decode(() => validateIdentity(identity)); const c = this.conversation(records, identity.source.sessionId);
    const item = c.items.find(i => i.requestId === identity.requestId && i.claim && equal(i.claim.identity, identity));
    if (!item || !unresolved(item)) deny("pending-input-claim-mismatch", "Current unresolved claim identity is required"); return { c, item, claim: item.claim! };
  }
  validateClaim(identity: DispatchIdentity) {
    this.validateOwnedClaim(identity, false);
  }
  /** Repeatable Phase 1 context.validate hook, before/after final run linking.
   * Checks original identity, chain pins and live authorization without writing
   * or granting a second native attempt. link/beforeNative remain one-shot.
   * Callers must failClosed on every PendingInputStorageError; no blind retry. */
  validateActiveClaim(identity: DispatchIdentity) {
    this.validateOwnedClaim(identity, true);
  }
  private validateOwnedClaim(identity: DispatchIdentity, active: boolean) {
    const { c, item, claim } = this.owned(this.records, identity);
    if (this.recoveryRequired) deny("pending-input-recovery", "Startup classification must complete before claim validation");
    if (this.storageFailed) throw new PendingInputStorageError("Pending input storage is unavailable");
    if (c.pause) deny("pending-input-paused", c.pause.reason);
    if (claim.uncertain) deny("pending-input-uncertain", "Uncertainty requires reconciliation, never resubmission");
    if (!active && (item.state !== "claimed" || claim.possibleNative || claim.evidence !== null)) deny("pending-input-transition", "Claim admission is one-shot and requires no prior dispatch evidence");
    if (this.changing) deny("pending-input-reentrant", "Pending input mutation already in progress");
    this.changing = true;
    try { this.validate(c, item, active ? "active-claim" : "link", claim.authorization); } finally { this.changing = false; }
  }
  link(identity: DispatchIdentity) {
    return this.change(records => {
      const { c, item, claim } = this.owned(records, identity);
      if (c.pause) deny("pending-input-paused", c.pause.reason);
      if (claim.uncertain || claim.possibleNative || claim.evidence !== null || item.state !== "claimed") deny("pending-input-transition", "Only an unsubmitted exact claim can be linked once");
      this.validate(c, item, "link"); item.state = "run-linked"; this.bump(c); return item;
    });
  }
  beforeNative(evidence: DispatchSubmissionEvidence) {
    this.decode(() => shape(evidence, ["source", "runId", "nativeCommandId", "requestId", "submission", "nativeAcceptance"]));
    return this.change(records => {
      const { submission, nativeAcceptance, ...identity } = evidence, { c, item, claim } = this.owned(records, identity);
      if (c.pause) deny("pending-input-paused", c.pause.reason);
      this.decode(() => validateEvidence(evidence, identity, true));
      if (item.state !== "run-linked" || claim.uncertain || claim.possibleNative || claim.evidence !== null || submission !== "attempted" || nativeAcceptance !== "unknown") deny("pending-input-transition", "Native intent requires an exact linked, never-attempted claim with no prior evidence");
      this.validate(c, item, "before-native"); claim.possibleNative = true; claim.evidence = structuredClone(evidence); this.bump(c); return item;
    });
  }
  outcome(evidence: DispatchSubmissionEvidence) {
    this.decode(() => shape(evidence, ["source", "runId", "nativeCommandId", "requestId", "submission", "nativeAcceptance"]));
    return this.change(records => {
      const { submission: _submission, nativeAcceptance: _acceptance, ...identity } = evidence, { c, item, claim } = this.owned(records, identity);
      this.decode(() => validateEvidence(evidence, identity, claim.possibleNative));
      if (evidence.submission === "attempted") deny("pending-input-transition", "Only beforeNative can journal native attempt intent");
      if (item.state !== "run-linked" && !(item.state === "claimed" && ["not-submitted", "unknown"].includes(evidence.submission))) deny("pending-input-transition", "Delivery evidence requires a linked run; unlinked claims only accept explicit withheld/unknown evidence");
      if (claim.evidence?.submission === "not-submitted" && evidence.submission !== "not-submitted" || claim.evidence?.submission === "submitted" && evidence.submission !== "submitted" || claim.evidence?.nativeAcceptance === "accepted" && evidence.nativeAcceptance !== "accepted") deny("pending-input-evidence-reversal", "Established withholding/delivery/acceptance evidence cannot be reversed");
      this.validate(c, item, "outcome"); claim.evidence = structuredClone(evidence);
      // Fresh evidence is retained, but only authorized settlement can resolve
      // lifecycle uncertainty. No outcome or unhide silently clears a pause.
      if (evidence.submission === "unknown") { claim.uncertain = true; c.pause ??= { code: "acceptance-unknown", reason: "Native submission outcome is unknown; reconcile the original identities" }; }
      this.bump(c); return item;
    });
  }
  hooks(identity: DispatchIdentity): DispatchEvidenceHooks {
    this.decode(() => validateIdentity(identity));
    const pinned = clone(identity);
    return {
      beforeNative: evidence => { this.decode(() => validateEvidence(evidence, pinned, true)); this.beforeNative(evidence); },
      outcome: evidence => {
        this.decode(() => { shape(evidence, ["source", "runId", "nativeCommandId", "requestId", "submission", "nativeAcceptance"]); const { submission: _s, nativeAcceptance: _a, ...ids } = evidence; validateIdentity(ids, pinned); });
        this.outcome(evidence);
      },
    };
  }
  settle(identity: DispatchIdentity, status: "completed" | "failed" | "interrupted", authorization: PendingInputAuthorization) {
    this.decode(() => { requireRecord(["completed", "failed", "interrupted"].includes(status)); validateAuthorization(authorization); });
    return this.change(records => {
      const { c, item, claim } = this.owned(records, identity);
      if (item.state !== "run-linked" || claim.evidence?.submission !== "submitted") deny("pending-input-unproven", "Settlement requires source-correlated delivery evidence");
      if (authorization.kind !== "settlement" || authorization.chainId !== item.chainId || authorization.predecessorRunId !== identity.runId || !equal(authorization.source, identity.source)) deny("pending-input-authorization", "Settlement authorization must prove this exact source/run reconciliation");
      if (records.conversations.some(c => c.items.some(i => i.claim?.authorization.authorizationId === authorization.authorizationId || i.history?.kind === "settled" && i.history.authorization.authorizationId === authorization.authorizationId))) deny("pending-input-id-conflict", "Readiness authorization was already used");
      this.validate(c, item, "settlement", authorization); claim.uncertain = false;
      item.state = "settled"; item.history = { kind: "settled", status, authorization: structuredClone(authorization) };
      c.lastAuthorization = structuredClone(authorization); c.lastPredecessorRunId = identity.runId;
      if (status !== "completed") c.pause ??= { code: status === "interrupted" ? "stopped" : "failed", reason: "Queued execution failed or was stopped; waiting text preserved" };
      this.bump(c); this.finishChain(c); return item;
    });
  }
  archiveNotSubmitted(identity: DispatchIdentity, proof: { kind: "definitely-not-submitted"; identity: DispatchIdentity }) {
    this.decode(() => { shape(proof, ["kind", "identity"]); requireRecord(proof.kind === "definitely-not-submitted"); validateIdentity(proof.identity, identity); });
    return this.change(records => {
      const { c, item, claim } = this.owned(records, identity);
      if (claim.possibleNative || claim.evidence?.submission !== "not-submitted") deny("pending-input-unproven", "Explicit adapter non-submission evidence is required; missing metadata is not proof");
      this.validate(c, item, "not-submitted"); claim.uncertain = false; item.state = "settled"; item.history = { kind: "not-submitted", proof: structuredClone(identity) };
      c.pause ??= { code: "admission-unavailable", reason: "Queued input was definitely withheld; explicit resume is required for remaining waiting text" };
      this.bump(c); this.finishChain(c); return item;
    });
  }
  /** Explicit lock-owned startup mutation. Load itself does not write anything.
   * Every unresolved original claim remains blocking, even with missing metadata
   * or formerly accepted evidence. Waiting text is retained and paused. */
  recover() {
    if (!this.recoveryRequired) return this.reconciliationWork();
    const work = this.change(records => {
      for (const c of records.conversations) if (c.items.some(active)) {
        c.pause ??= { code: "restart", reason: "App restarted; source reconciliation and explicit resume required" };
        for (const item of c.items.filter(unresolved)) item.claim!.uncertain = true;
        this.bump(c);
      }
      return records.conversations.flatMap(c => c.items.filter(unresolved));
    }, true);
    this.recoveryRequired = false; return work;
  }
  reconciliationWork() {
    return clone(this.records.conversations.flatMap(c => c.items.filter(unresolved).map(item => this.recoveryRequired
      ? { ...item, claim: { ...item.claim!, uncertain: true } } : item)));
  }
}
