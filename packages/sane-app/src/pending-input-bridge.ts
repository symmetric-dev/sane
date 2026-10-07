import type { DispatchIdentity, DispatchSource, DispatchSubmissionEvidence, PinnedDispatchReadiness } from "../shared/conversation/dispatch-contract";
import { legacyProfileId } from "./agent-profiles-contract";
import type { ConversationAdmissionLease, ConversationCoordinator, ConversationReadinessOptions } from "./conversation-coordinator";
import { DispatchPreNativeRefusal, synchronousDispatchHook } from "./dispatch-evidence";
import { DispatchProofUnavailableError, HarnessDispatchError, sameDispatchSource, type DispatchLifecycle } from "./harness-dispatch";
import type { Run } from "./history";
import type { ClaudeLocalIdle, ClaudeLocalSettlement, ClaudeLocalSupervision } from "./claude-run-service";
import { validateHarness } from "./harness-operations";
import type { OpenCodeAdapter } from "./opencode";
import type { OpenCodePendingCancellation } from "./opencode-run-service";
import { PendingInputDomainError, type PendingInputPins, type PendingInputLiveValidation } from "./pending-input-contract";
import { PendingInputScheduler, type PendingInputSelection, type PendingInputLiveProof } from "./pending-input-scheduler";
import type { PendingInputPreflight, PendingInputResumeCommit } from "./pending-input-service";
import type { PendingInputStore } from "./pending-input-store";
import type { PreparedAdmissionContext, PreparedInputAdmission } from "./prepared-input-admission";
import { equal as equalPendingPin } from "./prepared-input-codec";
import type { RunOwner } from "./run-owner";
import type { PreparedUserInput } from "./user-input-preparation";
import { WorkstreamAdapterError } from "./workstreams";

/** Live accessors deliberately re-read bridge state after every awaited proof.
 * Catalog/workstream/profile pin policy and App publication remain bridge-owned. */
export type PendingInputBridgeDependencies = Readonly<{
  store: PendingInputStore;
  coordinator: ConversationCoordinator<RunOwner>;
  run: (runId: string) => Run | undefined;
  isClosing: () => boolean;
  storageFailed: () => boolean;
  submissionSafety: (conversationId: string) => void;
  pins: (prepared: PreparedUserInput, captured: PendingInputPins, signal: AbortSignal) => Promise<PendingInputPreflight>;
  nativeReadiness: (source: DispatchSource) => Promise<PinnedDispatchReadiness>;
  terminalSnapshot: (source: DispatchSource, nativeCommandId: string) => Promise<Pick<Awaited<ReturnType<OpenCodeAdapter["snapshot"]>>, "outcome">>;
  groupAlive: (owner: RunOwner) => boolean;
  readLocalSettlement: (owner: RunOwner) => ClaudeLocalSettlement;
  readPendingCancellation: (owner: RunOwner) => OpenCodePendingCancellation;
  /** Queue-only App idleness, never generic Claude/native exclusivity. */
  currentAppIdle: (source: DispatchSource, own?: Readonly<{ lease: ConversationAdmissionLease; identity: DispatchIdentity; owner?: RunOwner }>) => ClaudeLocalIdle;
  /** Shared supervised admission, with bridge domain/storage error translation. */
  admit: PreparedInputAdmission["admit"];
  failClosed: (error: unknown) => void;
  wake?: () => void;
}>;

export type PendingInputBridge = Readonly<{
  consumer: Readonly<{ poll: () => void; drain: () => Promise<void> }>;
  allowsReadiness: (input: Readonly<ConversationReadinessOptions<RunOwner>>) => boolean;
  releasedReadiness: (owner: RunOwner, input: ConversationReadinessOptions<RunOwner>) => ReturnType<ConversationCoordinator<RunOwner>["inspectReadiness"]>;
  validateDispatch: (input: PendingInputLiveValidation) => void;
  assertMutationOwned: () => void;
  recordLifecycle: (conversationId: string, lifecycle: DispatchLifecycle<RunOwner>) => void;
  resumeCommitted: (commit: PendingInputResumeCommit) => void;
  close: () => Promise<void>;
  closeObservations: () => void;
  isReconsidering: () => boolean;
}>;

/** Queue-to-shared-admission adapter. No routes, timers, wake ownership,
 * recovery, configuration mutation, or execution ownership registry. */
export function createPendingInputBridge(deps: PendingInputBridgeDependencies): PendingInputBridge {
  const { store, coordinator } = deps;
  // One latest shared lifecycle per conversation, never per attempt/history.
  // Keep released handles across dependent claims and settlement; the scheduler
   // also retains its selected handle. done is a hint, never a release proof.
  const predecessors = new Map<string, DispatchLifecycle<RunOwner>>();
  type ResumeGrant = { readonly commit: PendingInputResumeCommit; readonly predecessor: DispatchLifecycle<RunOwner> | null;
    readonly predecessorRunId: string | null; readonly evidence: DispatchSubmissionEvidence | null; bound?: DispatchIdentity; consumed: boolean };
  // Process-only consent. No serialized authorization, historical receipt or
  // restart can populate this map. Binding consumes it for ONE original attempt.
  const resumeGrants = new Map<string, ResumeGrant>();
  let selectingQueueHead: { conversationId: string; requestId: string; itemId: string; revision: number } | undefined;
  const queueLeases = new WeakMap<ConversationAdmissionLease, { conversationId: string; requestId: string; itemId: string }>();
  const lifecycleLeases = new WeakMap<DispatchLifecycle<RunOwner>, ConversationAdmissionLease>();
  // Reserve and claim are contiguous synchronous scheduler operations. Transfer
  // the actual opaque lease into ONE proof closure, never reconstruct it by ID.
  let claimingQueueLease: ConversationAdmissionLease | undefined;
  let observingQueueIdentity: DispatchIdentity | undefined;
  let observationsOpen = true;
  let releasedQueueOwner: RunOwner | undefined;
  let reconsidering = false;
  function markReconsidering() {
    if (reconsidering) return;
    reconsidering = true;
    // Includes scheduler-owned lifecycle passes, not only external poll calls.
    // Coordinator notifications during a pass must not feed its transient
    // reserve/refuse/release back into another autonomous poll.
    void Promise.resolve().then(() => scheduler.drain()).catch(deps.failClosed).finally(() => { reconsidering = false; });
  }

  function allowsReadiness({ conversationId, intent, phase, lease }: Readonly<ConversationReadinessOptions<RunOwner>>) {
    if (!conversationId || intent.kind !== "user-prompt" || !intent.requestId || phase === "enqueue") return false;
    const view = store.inspect(conversationId), head = view.snapshot.items[0];
    const capability = lease && queueLeases.get(lease);
    const resumed = resumeGrants.get(conversationId), originalResume = resumed?.predecessor;
    if (releasedQueueOwner && originalResume?.owner === releasedQueueOwner && !resumed!.consumed
      && originalResume === predecessors.get(conversationId) && !view.pause && !view.recoveryRequired
      && intent.requestId === resumed!.evidence?.requestId && withheldArchive(originalResume, resumed!.commit.head.snapshot.prepared, resumed!.commit.preflight.pins)) return true;
    // Settlement alone may inspect its retained ORIGINAL lease while paused.
    // No serialized request, waiter or foreign lease can enter this scope.
    if (releasedQueueOwner && !view.recoveryRequired && capability && capability.conversationId === conversationId
      && capability.requestId === intent.requestId && capability.itemId === head?.itemId
      && coordinator.holdsAdmission(lease!, conversationId)) {
      const original = predecessors.get(conversationId), claim = store.lookup(conversationId, intent.requestId)?.item.claim;
      return original?.owner === releasedQueueOwner && !!claim && !claim.uncertain
        && equalPendingPin(claim.identity, { source: original.submissionEvidence().source,
          runId: releasedQueueOwner.run.runId, nativeCommandId: releasedQueueOwner.run.nativeCommandId ?? null,
          requestId: intent.requestId }) && original.submissionEvidence().submission === "submitted";
    }
    if (view.recoveryRequired || view.pause || !head || head.requestId !== intent.requestId) return false;
    const selecting = selectingQueueHead;
    if (selecting && selecting.conversationId === conversationId && selecting.requestId === intent.requestId
      && selecting.itemId === head.itemId && selecting.revision === view.snapshot.revision
      && view.snapshot.items.every(i => i.state === "waiting")) return true;
    if (!capability || capability.conversationId !== conversationId || capability.requestId !== intent.requestId || capability.itemId !== head.itemId
      || !coordinator.holdsAdmission(lease!, conversationId)) return false;
    const item = store.lookup(conversationId, intent.requestId)!.item;
    const owner = coordinator.getOwner(conversationId);
    return !!item.claim && !item.claim.uncertain && ["claimed", "run-linked"].includes(item.state)
      && (!owner || predecessors.get(conversationId)?.owner === owner && owner.run.runId === item.claim.identity.runId
        && (owner.run.nativeCommandId ?? null) === item.claim.identity.nativeCommandId);
  }
  function selectingHead<T>(id: string | undefined, intent: ConversationReadinessOptions<RunOwner>["intent"], action: () => T): T {
    if (!id || intent.kind !== "user-prompt" || !intent.requestId || selectingQueueHead) throw new Error("Invalid/reentrant consumer head selection");
    const view = store.inspect(id), head = view.snapshot.items[0];
    if (!head || head.requestId !== intent.requestId || view.pause || view.recoveryRequired || view.snapshot.items.some(i => i.state !== "waiting"))
      throw new PendingInputDomainError("pending-input-stale", "Consumer waiting head changed");
    selectingQueueHead = { conversationId: id, requestId: intent.requestId, itemId: head.itemId, revision: view.snapshot.revision };
    try { return action(); } finally { selectingQueueHead = undefined; }
  }
  // Only consumer calls can enter this synchronous scope. Serialized IDs/origins
  // cannot grant policy permission; arbitration remains in the real coordinator.
  const queueCoordinator = new Proxy(coordinator, { get(target, key) {
    if (key === "inspectReadiness") return (input: ConversationReadinessOptions<RunOwner>) => {
      markReconsidering();
      const capability = input.lease && queueLeases.get(input.lease);
      if (input.lease && (!capability || store.lookup(capability.conversationId, capability.requestId)?.item.state !== "waiting")) return target.inspectReadiness(input);
      return selectingHead(input.conversationId, input.intent, () => target.inspectReadiness(input));
    };
    if (key === "reserveAdmission") return (input: Parameters<typeof coordinator.reserveAdmission>[0]) => {
      if (input.conversationIds.length !== 1 || input.predecessor) throw new Error("Consumer must reserve exactly one fresh head");
      return selectingHead(input.conversationIds[0], input.intent, () => {
        const result = target.reserveAdmission(input);
        if (result.ready) { queueLeases.set(result.lease, { ...selectingQueueHead! }); claimingQueueLease = result.lease; }
        return result;
      });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const queueStore = new Proxy(store, { get(target, key) {
    if (key === "outcome") return (evidence: DispatchSubmissionEvidence) => {
      const { submission: _submission, nativeAcceptance: _acceptance, ...identity } = evidence;
      const claim = target.lookup(identity.source.sessionId, identity.requestId!)?.item.claim;
      if (!observationsOpen || observingQueueIdentity || !claim || !equalPendingPin(claim.identity, identity)) throw new PendingInputDomainError("scheduler-identity", "Original lock-owned queue observation required");
      observingQueueIdentity = identity;
      try { return target.outcome(evidence); } finally { observingQueueIdentity = undefined; }
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  async function queueReadOnlyProof<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      if (error instanceof HarnessDispatchError && error.code === "dispatch-source-mismatch") throw new PendingInputDomainError("source-changed", error.message);
      throw error;
    }
  }
  // Run metadata has only context version; framework/attachment stay in pins.
  function configurationProjection(configuration: Pick<Run, "profileId" | "model" | "effort" | "agent" | "agentKind" | "nativeAgentSelected" | "saneContextVersion">, harness: string) {
    return Object.fromEntries(Object.entries({ profileId: configuration.profileId ?? legacyProfileId(validateHarness(harness), configuration.agent),
      model: configuration.model, effort: configuration.effort, agent: configuration.agent, agentKind: configuration.agentKind,
      nativeAgentSelected: configuration.nativeAgentSelected, saneContextVersion: configuration.saneContextVersion }).filter(([, value]) => value !== undefined));
  }
  function queueOwnerConfiguration(run: Run, prepared: PreparedUserInput) {
    const config = prepared.configuration;
    if (!equalPendingPin(configurationProjection(run, prepared.binding.harness),
      configurationProjection({ ...config, saneContextVersion: config.saneContext?.version }, prepared.binding.harness)))
      throw new PendingInputDomainError("configuration-changed", "Installed queue owner launch settings differ from the captured launch");
  }
  function dispatchSourceFromPrepared(prepared: PreparedUserInput): DispatchSource {
    const b = prepared.binding;
    return Object.freeze({ harnessId: b.harness, sessionId: b.conversationId, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId ?? null, cwd: b.cwd });
  }
  function withheldArchive(lifecycle: DispatchLifecycle<RunOwner>, prepared: PreparedUserInput, captured: PendingInputPins): boolean {
    const evidence = lifecycle.submissionEvidence(), source = dispatchSourceFromPrepared(prepared);
    if (source.harnessId !== "claude-code" || !sameDispatchSource(evidence.source, source)
      || evidence.submission !== "not-submitted" || evidence.nativeAcceptance !== "not-accepted" || !evidence.requestId) return false;
    const item = store.lookup(source.sessionId, evidence.requestId)?.item, claim = item?.claim;
    const identity = { source, runId: evidence.runId, nativeCommandId: evidence.nativeCommandId, requestId: evidence.requestId };
    const local = deps.readLocalSettlement(lifecycle.owner);
    return !!item && item.state === "settled" && item.history?.kind === "not-submitted"
      && !!claim && !claim.possibleNative && !claim.uncertain && equalPendingPin(claim.identity, identity)
      && equalPendingPin(claim.evidence, evidence) && equalPendingPin(item.history.proof, identity)
      && equalPendingPin(item.snapshot.pins, captured)
      && equalPendingPin(item.snapshot.pins.configuration, prepared.expectedPrior?.configuration)
      && equalPendingPin(item.snapshot.prepared.configuration, prepared.configuration)
      && equalPendingPin(item.snapshot.prepared.binding, prepared.binding)
      && local.ready && local.kind === "withheld" && local.evidence.lifecycleFinished && local.evidence.streamsDrained
      && !local.evidence.nativeAttempted && local.evidence.childPid === null && local.evidence.groupPid === null
      && local.evidence.runId === evidence.runId && local.evidence.sessionId === source.sessionId
      && local.evidence.nativeSessionId === source.nativeSessionId && local.evidence.cwd === source.cwd
      && local.evidence.terminal?.status === lifecycle.owner.run.status && lifecycle.owner.run.status !== "completed";
  }
  function resumeValid(grant: ResumeGrant, selection: PendingInputSelection<RunOwner>, identity?: DispatchIdentity) {
    const cid = selection.item.request.conversationId, view = store.inspect(cid);
    const record = store.readRecords().conversations.find(c => c.conversationId === cid)!;
    const latest = record?.operations.filter(o => o.kind === "resume").at(-1);
    try {
      deps.submissionSafety(cid);
      if (resumeGrants.get(cid) !== grant || view.recoveryRequired || view.pause || view.chain?.chainId !== grant.commit.chainId
        || selection.item.chainId !== grant.commit.chainId || selection.predecessor !== grant.predecessor
        || selection.predecessorRunId !== grant.predecessorRunId
        || (view.lastAuthorization?.chainId === grant.commit.chainId ? view.lastPredecessorRunId : grant.predecessor?.owner.run.runId ?? null) !== grant.predecessorRunId
        || !equalPendingPin(latest?.request, grant.commit.request) || !equalPendingPin(latest?.result, grant.commit.receipt)
        || !equalPendingPin(selection.item.snapshot.pins, grant.commit.preflight.pins))
        throw new PendingInputDomainError("pending-input-stale", "Live resume consent was revoked or replaced");
      if (grant.bound) {
        if (!identity || !equalPendingPin(identity, grant.bound)) throw new PendingInputDomainError("pending-input-stale", "Resume consent already belongs to another attempt");
      } else {
        // The service capability was validated at commit/publication. Its enqueue
        // contention policy is NOT the consumer's policy (our own lease is now
        // expected). Consumer preflight refreshes the ORIGINAL captured pins and
        // its independent live validator checks every submission boundary.
        // Only same-chain waiter enqueue/remove revisions can carry unconsumed
        // consent forward. An unledgered pause/recovery/claim increment revokes it,
        // even if a later caller silently clears that pause.
        const revisions = new Set([
          ...record.items.filter(i => i.chainId === grant.commit.chainId && i.receipt.revision > grant.commit.receipt.revision).map(i => i.receipt.revision),
          ...record.operations.filter(o => o.kind === "remove" && o.result.revision > grant.commit.receipt.revision
            && record.items.some(i => i.chainId === grant.commit.chainId && i.itemId === o.request.itemId && !i.claim)).map(o => o.result.revision),
        ]);
        if (record.revision < grant.commit.receipt.revision || revisions.size !== record.revision - grant.commit.receipt.revision
          || record.items.some(i => ["claimed", "run-linked"].includes(i.state))
          || predecessors.get(cid) !== grant.predecessor && !(grant.predecessor === null && !predecessors.has(cid)))
          throw new PendingInputDomainError("pending-input-stale", "Resume waiting chain/revision changed without live consent");
      }
      const original = grant.predecessor, owner = original?.owner;
      if (owner) {
        const evidence = original!.submissionEvidence(), source = dispatchSourceFromPrepared(selection.item.snapshot.prepared);
        if (!owner.settled || owner.cancelling || coordinator.owns(owner) || coordinator.hasReconciliation(cid)
          || deps.run(owner.run.runId) !== owner.run || !sameDispatchSource(evidence.source, source)
          || !equalPendingPin(evidence, grant.evidence) || owner.run.runId !== evidence.runId || owner.run.sessionId !== cid
          || owner.run.cwd !== source.cwd || (owner.run.nativeCommandId ?? null) !== evidence.nativeCommandId
          || !["completed", "failed", "interrupted"].includes(owner.run.status))
          throw new PendingInputDomainError("pending-input-unproven", "Original resume predecessor release/identity is not proven");
        if (source.harnessId === "claude-code" && evidence.submission === "not-submitted") {
          if (!withheldArchive(original!, selection.item.snapshot.prepared, selection.item.snapshot.pins)) throw new PendingInputDomainError("pending-input-unproven", "Resume needs the exact finished withholding capability and original archive");
        } else {
          queueOwnerConfiguration(owner.run, selection.item.snapshot.prepared);
          if (source.harnessId === "claude-code") {
            const local = deps.readLocalSettlement(owner);
            if (!local.ready || local.kind !== "terminated") throw new PendingInputDomainError("pending-input-unproven", "Resume needs the original service terminal capability");
          }
        }
      }
      const current = coordinator.getOwner(cid);
      if (current && (!grant.bound || current.run.runId !== grant.bound.runId || predecessors.get(cid)?.owner !== current))
        throw new PendingInputDomainError("scheduler-owner", "Foreign owner replaced live resume consent");
      if (!current && coordinator.hasReconciliation(cid)) throw new PendingInputDomainError("pending-input-unproven", "Resume reconciliation is still held");
    } catch (error) { resumeGrants.delete(cid); throw error; }
    // A valid generation can outlive a read-only selection of a removed head.
    // Refuse that stale selection without destroying safe same-chain consent;
    // the next explicit poll must refresh both head and revision before claim.
    if (!grant.bound && (view.snapshot.items[0]?.itemId !== selection.item.itemId || view.snapshot.revision !== selection.revision))
      throw new PendingInputDomainError("pending-input-stale", "Resume selection requires the fresh waiting head/revision");
  }
  function queueLiveProof(selection: PendingInputSelection<RunOwner>, pins: PendingInputPreflight, kind: "dispatch" | "settlement", lifecycle?: DispatchLifecycle<RunOwner>, terminal?: () => void, grant?: ResumeGrant): PendingInputLiveProof {
    const source = dispatchSourceFromPrepared(selection.item.snapshot.prepared), cid = source.sessionId;
    let lease: ConversationAdmissionLease | undefined, bound: DispatchIdentity | undefined;
    const authorization = Object.freeze({ kind, authorizationId: crypto.randomUUID(), chainId: selection.item.chainId,
      predecessorRunId: kind === "settlement" ? lifecycle!.owner.run.runId : selection.predecessorRunId !== undefined ? selection.predecessorRunId : selection.predecessor?.owner.run.runId ?? null, source });
    return Object.freeze({ authorization, validate: (input: PendingInputLiveValidation, purpose: "submission" | "observation") => {
      if (!equalPendingPin(input.authorization ?? authorization, authorization) || !input.identity || !sameDispatchSource(input.identity.source, source)
        || input.chainId !== selection.item.chainId || !equalPendingPin(input.snapshot, selection.item.snapshot)) throw new PendingInputDomainError("scheduler-identity", "Queue proof differs from original snapshot");
      // Original-identity outcomes survive closing, pauses and current pin drift;
      // this observation membrane never renews submission permission.
      if (purpose === "observation" && input.stage !== "settlement") {
        if (!observationsOpen || deps.storageFailed()) throw new PendingInputDomainError("pending-input-owner-unavailable", "Queue observation ownership unavailable", 503);
        const claim = store.lookup(cid, input.identity.requestId!)?.item.claim;
        if (!claim || !equalPendingPin(claim.identity, input.identity)) throw new PendingInputDomainError("scheduler-identity", "Original queue claim changed");
        if (grant && ["outcome", "not-submitted"].includes(input.stage)) resumeGrants.delete(cid);
        return;
      }
      deps.submissionSafety(cid); pins.validate();
      if (grant && purpose === "submission") {
        resumeValid(grant, selection, input.identity);
        if (input.stage === "claim") { grant.bound = input.identity; grant.consumed = true; }
      }
      if (purpose === "submission") {
        const owner = coordinator.getOwner(cid);
        if (owner) {
          const published = predecessors.get(cid);
          const evidence = published?.submissionEvidence();
          if (published?.owner !== owner || !coordinator.owns(owner) || !evidence || !equalPendingPin({ source: evidence.source, runId: owner.run.runId,
            nativeCommandId: owner.run.nativeCommandId ?? null, requestId: evidence.requestId }, input.identity))
            throw new PendingInputDomainError("scheduler-owner", "Queue submission requires the exact published coordinator owner");
          queueOwnerConfiguration(owner.run, selection.item.snapshot.prepared);
        }
        if (source.harnessId === "claude-code") {
          if (input.stage === "claim") {
            const capability = claimingQueueLease && queueLeases.get(claimingQueueLease);
            if (!capability || capability.conversationId !== cid || capability.requestId !== input.identity.requestId
              || capability.itemId !== selection.item.itemId) throw new PendingInputDomainError("scheduler-owner", "Exact private queue reservation required");
            lease = claimingQueueLease; bound = input.identity;
          }
          const claim = store.lookup(cid, input.identity.requestId!)?.item.claim;
          if (!lease || !bound || !equalPendingPin(bound, input.identity) || !coordinator.holdsAdmission(lease, cid)
            || input.stage !== "claim" && (!claim || claim.possibleNative || claim.uncertain || !equalPendingPin(claim.identity, bound))
            || owner && (predecessors.get(cid)?.owner !== owner || lifecycleLeases.get(predecessors.get(cid)!) !== lease))
            throw new PendingInputDomainError("pending-input-unproven", "Only the exact unattempted original queue claim may exclude its own preparation");
          const idle = deps.currentAppIdle(source, { lease, identity: bound, ...(owner ? { owner } : {}) });
          if (!idle.ready) throw new PendingInputDomainError(idle.code, idle.reason);
          // before-native validation runs BEFORE possibleNative is set/written.
          // Never observe this service exception after native intent writes.
          deps.submissionSafety(cid); pins.validate();
        }
      }
      if (kind === "settlement") terminal!();
      else if (input.stage === "claim" && predecessors.get(cid) !== selection.predecessor && !(selection.predecessor === null && !predecessors.has(cid))) throw new PendingInputDomainError("pending-input-stale", "Queue predecessor changed");
    } });
  }
  const scheduler = new PendingInputScheduler<RunOwner>({ store: queueStore, coordinator: queueCoordinator, failClosed: deps.failClosed,
    predecessor: id => predecessors.get(id) ?? null,
    preflight: async (selection, signal) => {
      const { item, predecessor } = selection, cid = item.request.conversationId;
      deps.submissionSafety(cid);
        const grant = resumeGrants.get(cid);
        if (grant && !grant.consumed) resumeValid(grant, selection);
         // A NEW live consent generation may use a durable predecessor ID only
         // as identity. Fresh current App/native idleness below supplies authority,
         // never reconstructed historical release/success or a new-idle null ID.
       // Historical resume receipts are never permission. After consumption only
       // a newly dispatched queue predecessor's live successful settlement can
       // advance the chain by the ordinary success path.
       const record = store.readRecords().conversations.find(c => c.conversationId === cid)!;
       const chainStart = Math.min(...record.items.filter(i => i.chainId === item.chainId).map(i => i.receipt.revision));
       const latestResume = record.operations.filter(o => o.kind === "resume" && o.result.revision >= chainStart).at(-1);
       if (latestResume && (!grant || grant.consumed)) {
         const previous = predecessor && record.items.find(i => i.claim?.identity.runId === predecessor.owner.run.runId);
         if (!previous?.claim || previous.claim.expectedRevision < latestResume.result.revision || previous.history?.kind !== "settled" || previous.history.status !== "completed") return { kind: "wait" };
       }
      const pins = await deps.pins(item.snapshot.prepared, item.snapshot.pins, signal);
      deps.submissionSafety(cid); pins.validate();
      if (item.snapshot.prepared.stagedUpgrade || item.snapshot.prepared.nativeLaunch || !equalPendingPin(item.snapshot.pins.configuration, item.snapshot.pins.launch)) throw new PendingInputDomainError("configuration-changed", "Queue dispatch cannot upgrade captured settings");
      const source = dispatchSourceFromPrepared(item.snapshot.prepared);
       if (grant && !grant.consumed && predecessor && source.harnessId === "claude-code"
         && predecessor.submissionEvidence().submission === "not-submitted") {
         const release = await predecessor.releasedSettlement();
         deps.submissionSafety(cid); pins.validate(); resumeValid(grant, selection);
         if (!release.ready) {
           if (release.code === "dispatch-source-mismatch") throw new PendingInputDomainError("source-changed", release.reason);
           return { kind: "wait" };
         }
       }
       if (grant && !grant.consumed) resumeValid(grant, selection);
       else if (predecessor) {
        const success = await predecessor.successfulSettlement();
        deps.submissionSafety(cid); pins.validate();
        if (!success.ready) {
           if (success.code === "dispatch-source-mismatch") throw new PendingInputDomainError("source-changed", success.reason);
           if (success.code === "dispatch-stopped" || success.code === "dispatch-unsuccessful") return { kind: "pause", pause: {
             code: success.code === "dispatch-stopped" ? "stopped" : "failed", reason: success.reason } };
          // Denial/status/done is not failure proof: keep predecessor and wait.
          return { kind: "wait" };
        }
      }
       if (source.harnessId === "opencode") {
         let native: PinnedDispatchReadiness;
         try { native = await queueReadOnlyProof(() => deps.nativeReadiness(source)); }
         catch (error) {
           // Only typed transport unavailability can wait. Do not mask unknown
           // native/storage failures with a secondary consent check.
           if (error instanceof DispatchProofUnavailableError) {
             if (grant && !grant.consumed) resumeValid(grant, selection);
             deps.submissionSafety(cid); pins.validate();
           }
           throw error;
         }
         // Native busyness is not an App release proof: revoke consent observed
         // invalid during the await before returning any retryable wait.
         if (grant && !grant.consumed) resumeValid(grant, selection);
         deps.submissionSafety(cid); pins.validate();
        if (!sameDispatchSource(native.source, source) || !native.readiness.ready && native.readiness.code === "dispatch-source-mismatch") throw new PendingInputDomainError("source-changed", "Native readiness source changed");
         if (!native.readiness.ready) return { kind: "wait" };
       } else {
         // Historical identity alone can never authorize a new idle chain.
         if (!predecessor && selection.predecessorRunId != null && (!grant || grant.consumed)) return { kind: "wait" };
         const idle = deps.currentAppIdle(source);
         deps.submissionSafety(cid); pins.validate();
         if (grant && !grant.consumed) resumeValid(grant, selection);
         if (!idle.ready) return { kind: "wait" };
       }
       if (grant && !grant.consumed) resumeValid(grant, selection);
       return { kind: "ready", proof: { ...queueLiveProof(selection, pins, "dispatch", undefined, undefined, grant && !grant.consumed ? grant : undefined), basis: grant && !grant.consumed ? "user-resume" : predecessor ? "successful-predecessor" : "new-idle-chain" } };
    },
    settlement: async (selection, lifecycle, signal) => {
      const owner = lifecycle.owner, evidence = lifecycle.submissionEvidence(), { source } = evidence;
      let local: ClaudeLocalSupervision | undefined;
      const pendingCancellation = source.harnessId === "opencode" ? deps.readPendingCancellation(owner) : undefined;
      const canceledPending = () => {
        if (!pendingCancellation?.ready) return false;
        const current = deps.readPendingCancellation(owner), observed = pendingCancellation.evidence;
        return current === pendingCancellation && evidence.nativeAcceptance === "accepted"
          && observed.runId === evidence.runId && observed.requestId === evidence.requestId
          && observed.nativeCommandId === evidence.nativeCommandId && sameDispatchSource(observed.source, source);
      };
      const localTerminal = () => {
        const proof = deps.readLocalSettlement(owner);
        if (!proof.ready || proof.kind !== "terminated") return false;
        const observed = proof.evidence;
        if (observed.runId !== evidence.runId || observed.sessionId !== source.sessionId
          || observed.nativeSessionId !== source.nativeSessionId || observed.cwd !== source.cwd
          || evidence.nativeCommandId !== null || !observed.terminal
          || local && !equalPendingPin(local, observed)) return false;
        local = observed;
        return true;
      };
      // Capture the service's ORIGINAL classification before asynchronous pins.
      const initialLocal = source.harnessId !== "claude-code" || localTerminal();
      const pins = await deps.pins(selection.item.snapshot.prepared, selection.item.snapshot.pins, signal);
      deps.submissionSafety(source.sessionId); pins.validate();
      if (!initialLocal || source.harnessId === "claude-code" && !localTerminal()) return { kind: "wait" };
      if (pendingCancellation?.ready && !canceledPending()) return { kind: "wait" };
      const status = local?.terminal?.status ?? owner.run.status;
      const terminal = () => {
        pins.validate();
        deps.submissionSafety(source.sessionId);
        const claim = store.lookup(source.sessionId, evidence.requestId!)?.item.claim;
        const run = owner.run, config = selection.item.snapshot.prepared.configuration;
        if (pendingCancellation?.ready && !canceledPending()) throw new PendingInputDomainError("pending-input-unproven", "Original pending cancellation capability changed");
        if (source.harnessId === "claude-code" && !localTerminal()) throw new PendingInputDomainError("pending-input-unproven", "Original local terminal capability changed");
        if (predecessors.get(source.sessionId) !== lifecycle || !owner.settled || owner.cancelling || coordinator.owns(owner) || coordinator.hasOwner(source.sessionId) || coordinator.hasReconciliation(source.sessionId)
          || !claim || !equalPendingPin(claim.identity, { source, runId: evidence.runId, nativeCommandId: evidence.nativeCommandId, requestId: evidence.requestId })
          || !equalPendingPin(lifecycle.submissionEvidence(), evidence) || evidence.submission !== "submitted"
          || deps.run(evidence.runId) !== run || run.runId !== evidence.runId || run.sessionId !== source.sessionId || run.cwd !== source.cwd || (run.nativeCommandId ?? null) !== evidence.nativeCommandId || run.status !== status
          || run.model !== config.model || run.effort !== config.effort || run.agent !== config.agent || (run.profileId ?? legacyProfileId(validateHarness(source.harnessId), run.agent)) !== config.profileId
          || run.agentKind !== config.agentKind || run.nativeAgentSelected !== config.nativeAgentSelected || run.saneContextVersion !== config.saneContext?.version)
           throw new PendingInputDomainError("pending-input-unproven", "Exact queue installation, settings, release and reconciliation are not proven");
        const lease = lifecycleLeases.get(lifecycle);
        if (!lease || releasedQueueOwner) throw new PendingInputDomainError("pending-input-unproven", "Original queue lease unavailable");
        releasedQueueOwner = owner;
        try {
          const ready = coordinator.inspectReadiness({ conversationId: source.sessionId,
            intent: { kind: "user-prompt", requestId: evidence.requestId }, phase: "dispatch", lease });
          if (!ready.ready) throw new PendingInputDomainError("pending-input-unproven", ready.reason);
        } finally { releasedQueueOwner = undefined; }
      };
      terminal();
      if (status !== "completed" && status !== "failed" && status !== "interrupted") return { kind: "wait" };
      if (source.harnessId === "opencode") {
        if (status === "interrupted" && canceledPending()) {
          // Exact acknowledged removal BEFORE consumption has no history outcome.
          // This is interruption only; release/reconciliation gates still apply.
          terminal();
        } else {
          const snapshot = await queueReadOnlyProof(() => deps.terminalSnapshot(source, evidence.nativeCommandId!));
          terminal();
          if (snapshot.outcome !== (status === "completed" ? "succeeded" : status)) return { kind: "wait" };
        }
      } else {
        if (!localTerminal()) return { kind: "wait" };
        if (status === "completed" && (local!.terminal!.cause !== "result-success" || local!.exitCode !== 0)) return { kind: "wait" };
      }
      const release = await lifecycle.releasedSettlement(); terminal();
      if (!release.ready) {
        if (release.code === "dispatch-source-mismatch") throw new PendingInputDomainError("source-changed", release.reason);
        return { kind: "wait" };
      }
      if (status === "completed") {
        const success = await lifecycle.successfulSettlement(); terminal();
        if (!success.ready) return { kind: "wait" };
      }
      terminal();
      return { kind: "ready", status, proof: queueLiveProof(selection, pins, "settlement", lifecycle, terminal) };
    },
    allocate: harness => ({ runId: crypto.randomUUID(), attemptId: crypto.randomUUID(), nativeCommandId: harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : null }),
    dispatch: async (prepared, lease, input) => {
      let published: DispatchLifecycle<RunOwner> | undefined;
      const translate = <T>(action: () => T): T => {
        try { return action(); } catch (error) {
          if (error instanceof PendingInputDomainError) {
            if (error.code === "source-changed" || error.code === "configuration-changed" || error.code === "context-changed") store.pause(prepared.binding.conversationId,
              { code: error.code, reason: error.message });
            throw new WorkstreamAdapterError(error.status, error.code, error.message);
          }
          throw error;
        }
      };
      const c = input.context;
      const context: PreparedAdmissionContext = { ...c,
        validate: identity => translate(() => c.validate?.(identity)), link: identity => translate(() => c.link?.(identity)),
        evidence: { beforeNative: evidence => {
          try { return c.evidence?.beforeNative?.(evidence); }
          catch (error) {
            // Certify ONLY fresh live drift after a successful durable pause.
            // Storage/writer failures, including post-rename pause failure, escape.
             if (error instanceof PendingInputDomainError && (error.code === "source-changed" || error.code === "configuration-changed" || error.code === "context-changed")) {
              store.pause(prepared.binding.conversationId, { code: error.code, reason: error.message });
               throw new DispatchPreNativeRefusal(new WorkstreamAdapterError(error.status, error.code, error.message));
             }
             if (error instanceof PendingInputDomainError && error.code === "claude-local-unproven") {
               store.pause(prepared.binding.conversationId, { code: "admission-unavailable", reason: error.message });
               throw new DispatchPreNativeRefusal(new WorkstreamAdapterError(error.status, error.code, error.message));
             }
            return translate(() => { throw error; });
          }
        }, outcome: evidence => {
          translate(() => c.evidence?.outcome?.(evidence));
          // Classify honest withholding only against the original published owner,
          // never reject accepted/unknown outcomes using current Session settings.
          if (evidence.submission === "not-submitted" && published && !deps.isClosing() && !deps.storageFailed()) {
            const original = published.submissionEvidence();
            if (!equalPendingPin(original, evidence)) throw new PendingInputDomainError("scheduler-identity", "Withholding differs from original published queue evidence");
            try { queueOwnerConfiguration(published.owner.run, prepared); }
            catch (error) {
              if (!(error instanceof PendingInputDomainError) || error.code !== "configuration-changed") throw error;
              store.pause(prepared.binding.conversationId, { code: "configuration-changed", reason: error.message });
            }
          }
        } } };
      return await deps.admit(prepared, lease, { context, publish: lifecycle => {
        input.publish(lifecycle); published = lifecycle; lifecycleLeases.set(lifecycle, lease);
      } });
    },
  });
  return Object.freeze({
    consumer: Object.freeze({ poll: () => { markReconsidering(); scheduler.poll(); }, drain: () => scheduler.drain() }),
    isReconsidering: () => reconsidering,
    allowsReadiness,
    releasedReadiness: (owner, input) => {
      if (releasedQueueOwner) throw new Error("Reentrant queue release observation");
      releasedQueueOwner = owner;
      try { return coordinator.inspectReadiness(input); }
      finally { releasedQueueOwner = undefined; }
    },
    validateDispatch: input => { try { scheduler.validateLive(input); } finally { if (input.stage === "claim") claimingQueueLease = undefined; } },
    assertMutationOwned: () => {
      if (deps.storageFailed() || deps.isClosing() && !observingQueueIdentity) throw new PendingInputDomainError("pending-input-owner-unavailable", "App storage ownership is unavailable", 503);
    },
    resumeCommitted: commit => {
      const cid = commit.request.conversationId, view = store.inspect(cid);
      if (view.snapshot.revision !== commit.receipt.revision || view.chain?.chainId !== commit.chainId || view.pause || view.recoveryRequired
        || view.snapshot.items[0]?.itemId !== commit.head.itemId || view.snapshot.items.some(i => i.state !== "waiting")) throw new Error("Resume publication differs from the new durable chain/head");
      commit.preflight.validate();
      const predecessor = predecessors.get(cid) ?? null;
      const predecessorRunId = predecessor?.owner.run.runId ?? (view.lastAuthorization?.chainId === commit.chainId ? view.lastPredecessorRunId : null);
      resumeGrants.set(cid, { commit, predecessor, predecessorRunId, evidence: predecessor?.submissionEvidence() ?? null, consumed: false });
    },
    recordLifecycle: (conversationId, lifecycle) => {
      if (predecessors.get(conversationId) === lifecycle) return;
      const grant = resumeGrants.get(conversationId), evidence = lifecycle.submissionEvidence();
      if (grant) {
        if (grant.bound && equalPendingPin(grant.bound, { source: evidence.source, runId: evidence.runId, nativeCommandId: evidence.nativeCommandId, requestId: evidence.requestId })) grant.consumed = true;
        else resumeGrants.delete(conversationId);
      }
      predecessors.set(conversationId, lifecycle);
      // Exactly one ordinary-predecessor done hint, including failure/Stop.
      // Queued lifecycles already have the scheduler's notifyOnce-style hook.
      if (lifecycle.owner.nativeQueuedHandoff || evidence.requestId && store.lookup(conversationId, evidence.requestId)?.item.claim?.identity.runId === evidence.runId) return;
      void lifecycle.done.then(() => { synchronousDispatchHook(() => deps.wake?.()); }).catch(deps.failClosed);
    },
    close: () => { resumeGrants.clear(); return scheduler.close(); },
    // Bridge calls this only after its bounded dispatch/ownership drain. It is
    // distinct from close(): outcomes still need the original-identity membrane.
    closeObservations: () => { observationsOpen = false; },
  });
}
