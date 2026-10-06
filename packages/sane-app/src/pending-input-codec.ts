import { isStoredSlot } from "sane-core/contracts";
import { createHash } from "node:crypto";
import { isStoredAssistantAgentId, isWorkerAgentId } from "sane-core/agent-catalog";
import { validateAdmissions } from "./app-store";
import { nativeMessageId, uuid, validProfileId, validModel, validEffort, validVariant } from "./history";
import { isPendingInputRemovalRequest, isPendingInputRemovalResult, isPendingInputRequest, isPendingInputResumeRequest, isPendingInputSubmissionResult } from "../shared/conversation/pending-input-contract";
import { canonicalJSON, canonicalPath, decodePreparedUserInput, equal, fingerprint, immutable, positive, requireRecord, shape, timestamp, validateBinding, validateConfiguration } from "./prepared-input-codec";
import { PendingInputCodecError, type PendingInputAuthorization, type PendingInputLaunchSnapshot, type PendingInputPins, type PendingInputRecords } from "./pending-input-contract";
import type { DispatchIdentity, DispatchSource } from "../shared/conversation/dispatch-contract";

export const PAUSE_CODES = ["stopped", "failed", "hidden", "restart", "source-changed", "configuration-changed", "context-changed", "admission-unavailable", "acceptance-unknown", "reconciliation-required"] as const;
/** Original user intent, not today's mutable preparation/admission/context.
 * Include explicit native-stopped acknowledgement and optional catalog selection
 * so retransmission cannot silently change safety or selection semantics. */
export function pendingInputIntentFingerprint(request: unknown, prepared: unknown): string {
  validateRequest(request);
  requireRecord(prepared && typeof prepared === "object");
  const p = prepared as Record<string, unknown>;
  shape(p.requested, [], ["harness", "model", "effort", "agent", "profileId"]);
  shape(p.associationSelection, [], ["workspaceId", "worktreeId"]);
  requireRecord(typeof p.nativeStopped === "boolean");
  return fingerprint({ request, requested: p.requested, associationSelection: p.associationSelection, nativeStopped: p.nativeStopped });
}
export function dispatchSource(snapshot: PendingInputLaunchSnapshot): DispatchSource {
  const b = snapshot.prepared.binding;
  return { harnessId: b.harness, sessionId: b.conversationId, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId!, cwd: b.cwd };
}
function ref(v: unknown) {
  shape(v, ["harness", "authorityId", "nativeId"]);
  requireRecord(["cc", "oc"].includes(v.harness));
  validateBinding({ conversationId: "00000000-0000-4000-8000-000000000001", harness: v.harness === "cc" ? "claude-code" : "opencode", authorityId: v.authorityId, nativeSessionId: v.nativeId, cwd: "/codec" });
}
function checkout(v: unknown) {
  shape(v, ["path", "commonDir", "gitDir", "device", "inode", "commonDevice", "commonInode", "gitDevice", "gitInode"]);
  requireRecord([v.path, v.commonDir, v.gitDir].every(canonicalPath) && [v.device, v.inode, v.commonDevice, v.commonInode, v.gitDevice, v.gitInode].every(n => Number.isSafeInteger(n) && n >= 0));
}
export function validateSource(v: unknown) {
  shape(v, ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]);
  validateBinding({ conversationId: v.sessionId, harness: v.harnessId, authorityId: v.authorityId, nativeSessionId: v.nativeSessionId, cwd: v.cwd });
}
export function validateIdentity(v: unknown, expected?: DispatchIdentity) {
  shape(v, ["source", "runId", "nativeCommandId", "requestId"]); validateSource(v.source);
  requireRecord(uuid(v.runId) && uuid(v.requestId) && (v.source.harnessId === "opencode" ? nativeMessageId(v.nativeCommandId) : v.nativeCommandId === null));
  if (expected) requireRecord(equal(v, expected), "Dispatch identity mismatch");
}
export function validateAuthorization(v: unknown): asserts v is PendingInputAuthorization {
  shape(v, ["kind", "authorizationId", "chainId", "predecessorRunId", "source"]); validateSource(v.source);
  requireRecord(["dispatch", "settlement"].includes(v.kind) && uuid(v.authorizationId) && uuid(v.chainId) && (v.predecessorRunId === null || uuid(v.predecessorRunId)));
}
export function decodePendingInputPins(v: unknown): PendingInputPins {
  canonicalJSON(v); shape(v, ["admission", "catalog", "configuration", "launch", "context"]);
  try { validateAdmissions({ version: 1, admissions: [v.admission] }); } catch { throw new PendingInputCodecError("Invalid pending admission pin"); }
  const a = v.admission, b = a.binding, harness = a.source.descriptor.harness === "cc" ? "claude-code" : "opencode";
  requireRecord(a.state === "ready" && a.nativeId !== null && canonicalPath(b.executionCheckout));
  if (a.parent !== null) ref(a.parent);
  requireRecord(canonicalPath(a.source.descriptor.harness === "cc" ? a.source.descriptor.profileRoot : a.source.descriptor.registrationFile));
  const descriptor = a.source.descriptor.harness === "cc"
    ? { version: 1, harness: "cc", kind: "local-profile", profileRoot: a.source.descriptor.profileRoot }
    : { version: 1, harness: "oc", kind: "local-registration", registrationFile: a.source.descriptor.registrationFile };
  requireRecord(a.source.authorityId === `sane-native-v1:${descriptor.harness}:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`, "Native authority does not match its configured descriptor");
  if (b.checkoutPin !== null) checkout(b.checkoutPin);
  if (b.domain.mode === "repository") requireRecord(canonicalPath(b.domain.primaryCheckout));
  shape(v.catalog, ["workspaceId", "worktreeId", "bindingRevision", "cwd"]);
  requireRecord(equal(v.catalog, { workspaceId: b.workspaceId, worktreeId: b.worktreeId, bindingRevision: b.bindingRevision, cwd: b.executionCheckout }), "Catalog/admission pin mismatch");
  validateConfiguration(v.configuration, harness); validateConfiguration(v.launch, harness);
  // Queue requests assert current settings; they cannot select a new launch.
  // Keep the captured configuration stable through admission and chain refill.
  requireRecord(equal(v.configuration, v.launch), "Queued launch must preserve the captured prior configuration");
  if (v.context !== null) {
    requireRecord(b.domain.mode === "repository");
    const c = v.context; shape(c, ["conversation", "workstream", "primaryCheckout", "artifactsRoot", "assignments"], ["membership"]);
    const conv = c.conversation; shape(conv, ["id", "repositoryId", "ref", "executionCheckout", "parent", "workstreamId", "createdAt"]);
    ref(conv.ref); if (conv.parent !== null) ref(conv.parent); checkout(conv.executionCheckout);
    requireRecord(uuid(conv.id) && conv.repositoryId === b.domain.repositoryId && timestamp(conv.createdAt) && equal(conv.executionCheckout, b.checkoutPin) && equal(conv.parent, a.parent));
    requireRecord(equal(conv.ref, { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId }));
    requireRecord(c.primaryCheckout === b.domain.primaryCheckout && (c.artifactsRoot === null || canonicalPath(c.artifactsRoot)) && Array.isArray(c.assignments));
    if (c.workstream === null) requireRecord(conv.workstreamId === null && c.assignments.length === 0 && c.artifactsRoot === null);
    else {
      shape(c.workstream, ["id", "repositoryId", "defaultCheckout"]); requireRecord(typeof c.workstream.id === "string" && /^[a-z0-9][a-z0-9_-]{0,95}$/.test(c.workstream.id) && c.workstream.repositoryId === conv.repositoryId && conv.workstreamId === c.workstream.id);
      if (c.workstream.defaultCheckout !== null) checkout(c.workstream.defaultCheckout);
      requireRecord(c.artifactsRoot !== null);
    }
    const ids = new Set<string>();
    if ("membership" in c) {
      if (c.membership === null) requireRecord(conv.workstreamId === null);
      else {
        shape(c.membership, ["id", "conversationId", "workstreamId", "startedAt", "endedAt"]);
        requireRecord(uuid(c.membership.id) && c.membership.conversationId === conv.id && c.membership.workstreamId === conv.workstreamId && timestamp(c.membership.startedAt) && c.membership.endedAt === null);
      }
    }
    for (const assignment of c.assignments) {
      shape(assignment, ["id", "membershipId", "ref", "workstreamId", "phase", "startedAt", "endedAt"]); ref(assignment.ref);
      requireRecord(uuid(assignment.id) && !ids.has(assignment.id) && uuid(assignment.membershipId) && equal(assignment.ref, conv.ref) && assignment.workstreamId === conv.workstreamId && isStoredSlot(assignment.phase) && timestamp(assignment.startedAt) && assignment.endedAt === null);
      ids.add(assignment.id);
      if ("membership" in c) requireRecord(c.membership !== null && assignment.membershipId === c.membership.id);
    }
  } else requireRecord(b.domain.mode === "app-only", "Registered repository queue requires a context pin");
  const copy = structuredClone(v) as PendingInputPins;
  copy.context?.assignments.sort((a, b) => a.id.localeCompare(b.id));
  return immutable(copy);
}
export function decodePendingInputSnapshot(v: unknown): PendingInputLaunchSnapshot {
  shape(v, ["prepared", "pins"]);
  const prepared = decodePreparedUserInput(v.prepared), b = prepared.binding;
  requireRecord(prepared.resume && prepared.expectedPrior && b.nativeSessionId && !prepared.stagedUpgrade && !prepared.nativeLaunch, "Queue requires an established resume without a staged upgrade");
  const pins = decodePendingInputPins(v.pins), a = pins.admission;
  requireRecord(b.conversationId === a.sessionId && b.nativeSessionId === a.nativeId && b.authorityId === a.source.authorityId && b.harness === (a.source.descriptor.harness === "cc" ? "claude-code" : "opencode") && b.cwd === a.binding.executionCheckout, "Prepared/admission source mismatch");
  requireRecord(equal(prepared.expectedPrior.configuration, pins.configuration) && equal(prepared.configuration, pins.launch), "Prepared configuration/chain pin mismatch");
  const selection = prepared.associationSelection;
  requireRecord((selection.workspaceId === undefined || selection.workspaceId === pins.catalog.workspaceId) && (selection.worktreeId === undefined || selection.worktreeId === pins.catalog.worktreeId));
  requireRecord(!prepared.configuration.attachment || prepared.configuration.attachment.state === "ready");
  return immutable({ prepared, pins });
}
export function validateRequest(v: unknown) {
  requireRecord(isPendingInputRequest(v), "Invalid pending input request");
  requireRecord(uuid(v.conversationId) && uuid(v.requestId));
  validateSource({ harnessId: v.source.harnessId, sessionId: v.source.conversationId, authorityId: v.source.authorityId, nativeSessionId: v.source.nativeSessionId, cwd: v.source.cwd });
  const c = v.configuration;
  requireRecord(canonicalPath(c.cwd) && validProfileId(c.profileId) && (!("model" in c) || validModel(c.model)) && (!("effort" in c) || (v.source.harnessId === "opencode" ? validVariant(c.effort) && !/\x7f/.test(c.effort) : validEffort(c.effort))) && (!("agent" in c) || isStoredAssistantAgentId(c.agent) || isWorkerAgentId(c.agent)));
}
export function validateRequestSnapshot(request: unknown, snapshot: PendingInputLaunchSnapshot) {
  validateRequest(request); const r = request as Record<string, any>, p = snapshot.prepared;
  requireRecord(r.text === p.prompt, "Request/prepared prompt mismatch");
  const source = { harnessId: r.source.harnessId, sessionId: r.source.conversationId, authorityId: r.source.authorityId, nativeSessionId: r.source.nativeSessionId, cwd: r.source.cwd };
  const configuration = { cwd: p.binding.cwd, profileId: p.configuration.profileId, ...("model" in p.configuration ? { model: p.configuration.model } : {}), ...("effort" in p.configuration ? { effort: p.configuration.effort } : {}), ...("agent" in p.configuration ? { agent: p.configuration.agent } : {}) };
  requireRecord(equal(source, dispatchSource(snapshot)) && equal(r.configuration, configuration), "Request/prepared launch mismatch");
}
export function validateEvidence(v: unknown, identity: DispatchIdentity, possibleNative: boolean) {
  shape(v, ["source", "runId", "nativeCommandId", "requestId", "submission", "nativeAcceptance"]);
  const { submission, nativeAcceptance, ...ids } = v; validateIdentity(ids, identity);
  requireRecord(["not-submitted", "attempted", "submitted", "unknown"].includes(submission) && ["not-accepted", "accepted", "unknown"].includes(nativeAcceptance));
  requireRecord(submission === "not-submitted" ? !possibleNative && nativeAcceptance === "not-accepted" : nativeAcceptance !== "not-accepted");
  requireRecord(!["attempted", "submitted"].includes(submission) || possibleNative);
  requireRecord(nativeAcceptance !== "accepted" || possibleNative && submission === "submitted" && identity.source.harnessId === "opencode", "Unproven native acceptance");
}
export function decodePendingInputRecords(v: unknown, storeId: string): PendingInputRecords {
  canonicalJSON(v); shape(v, ["version", "storeId", "nextSequence", "conversations"]);
  requireRecord(v.version === 1 && uuid(storeId) && v.storeId === storeId && positive(v.nextSequence) && Array.isArray(v.conversations));
  const conversations = new Set<string>(), itemIds = new Set<string>(), sequences = new Set<number>(), runs = new Set<string>(), commands = new Set<string>(), authorizations = new Set<string>();
  const chains = new Map<string, { conversationId: string; pins: PendingInputPins }>(); let maximum = 0;
  const nativeOwners = new Map<string, string>();
  for (const c of v.conversations) {
    shape(c, ["conversationId", "revision", "chain", "pause", "lastAuthorization", "lastPredecessorRunId", "items", "operations"]);
    requireRecord(uuid(c.conversationId) && !conversations.has(c.conversationId) && positive(c.revision) && Array.isArray(c.items) && Array.isArray(c.operations)); conversations.add(c.conversationId);
    if (c.pause !== null) { shape(c.pause, ["code", "reason"]); requireRecord(PAUSE_CODES.includes(c.pause.code) && typeof c.pause.reason === "string" && !!c.pause.reason.trim()); }
    if (c.chain !== null) { shape(c.chain, ["chainId", "pins"]); requireRecord(uuid(c.chain.chainId)); decodePendingInputPins(c.chain.pins); }
    requireRecord(c.lastPredecessorRunId === null || uuid(c.lastPredecessorRunId));
    if (c.lastAuthorization !== null) { validateAuthorization(c.lastAuthorization); requireRecord(c.lastAuthorization.kind === "settlement" && c.lastAuthorization.predecessorRunId === c.lastPredecessorRunId); }
    else requireRecord(c.lastPredecessorRunId === null);
    const requests = new Set<string>(), attempts = new Set<string>(); let last = 0, lastReceiptRevision = 0;
    let latestSettlement: PendingInputAuthorization | null = null;
    const predecessors = new Map<string, string>();
    for (const item of c.items) {
      shape(item, ["itemId", "requestId", "sequence", "chainId", "fingerprint", "request", "snapshot", "receipt", "state", "claim", "history"]);
      validateRequest(item.request); const snapshot = decodePendingInputSnapshot(item.snapshot); validateRequestSnapshot(item.request, snapshot);
      const source = dispatchSource(snapshot), nativeKey = canonicalJSON([source.harnessId, source.authorityId, source.nativeSessionId]);
      requireRecord(!nativeOwners.has(nativeKey) || nativeOwners.get(nativeKey) === c.conversationId, "Native identity cannot have two App conversations");
      nativeOwners.set(nativeKey, c.conversationId);
      requireRecord(uuid(item.itemId) && !itemIds.has(item.itemId) && uuid(item.chainId) && item.requestId === item.request.requestId && !requests.has(item.requestId) && item.request.conversationId === c.conversationId);
      const chain = chains.get(item.chainId);
      requireRecord(!chain || chain.conversationId === c.conversationId && equal(chain.pins, snapshot.pins), "Historical chain pins are immutable");
      chains.set(item.chainId, { conversationId: c.conversationId, pins: snapshot.pins });
      requireRecord(positive(item.sequence) && item.sequence > last && !sequences.has(item.sequence) && item.fingerprint === pendingInputIntentFingerprint(item.request, snapshot.prepared));
      maximum = Math.max(maximum, item.sequence); last = item.sequence; sequences.add(item.sequence); itemIds.add(item.itemId); requests.add(item.requestId);
      requireRecord(isPendingInputSubmissionResult(item.receipt) && item.receipt.outcome === "enqueued" && item.receipt.itemId === item.itemId && item.receipt.sequence === item.sequence && item.receipt.requestId === item.requestId && item.receipt.conversationId === c.conversationId && positive(item.receipt.revision) && item.receipt.revision > lastReceiptRevision && item.receipt.revision <= c.revision);
      lastReceiptRevision = item.receipt.revision;
      requireRecord(["waiting", "claimed", "run-linked", "removed", "settled"].includes(item.state));
      if (["waiting", "removed"].includes(item.state)) requireRecord(item.claim === null && item.history === null);
      else {
        const claim = item.claim; shape(claim, ["attemptId", "expectedRevision", "identity", "authorization", "possibleNative", "uncertain", "evidence"]);
        requireRecord(uuid(claim.attemptId) && !attempts.has(claim.attemptId) && positive(claim.expectedRevision) && claim.expectedRevision < c.revision && typeof claim.possibleNative === "boolean" && typeof claim.uncertain === "boolean"); attempts.add(claim.attemptId);
        validateIdentity(claim.identity); requireRecord(claim.identity.requestId === item.requestId && equal(claim.identity.source, dispatchSource(snapshot)) && !runs.has(claim.identity.runId)); runs.add(claim.identity.runId);
        if (claim.identity.nativeCommandId !== null) { requireRecord(!commands.has(claim.identity.nativeCommandId)); commands.add(claim.identity.nativeCommandId); }
        validateAuthorization(claim.authorization); requireRecord(claim.authorization.kind === "dispatch" && claim.authorization.chainId === item.chainId && equal(claim.authorization.source, claim.identity.source) && !authorizations.has(claim.authorization.authorizationId)); authorizations.add(claim.authorization.authorizationId);
        requireRecord(claim.expectedRevision >= item.receipt.revision);
        if (predecessors.has(item.chainId)) requireRecord(claim.authorization.predecessorRunId === predecessors.get(item.chainId), "Historical claim predecessor mismatch");
        if (claim.evidence !== null) validateEvidence(claim.evidence, claim.identity, claim.possibleNative);
        if (claim.possibleNative) requireRecord(claim.evidence !== null && claim.evidence.submission !== "not-submitted");
        if (item.state === "claimed") requireRecord(!claim.possibleNative && (claim.evidence === null || ["not-submitted", "unknown"].includes(claim.evidence.submission)));
        if (claim.evidence?.submission === "unknown") requireRecord(claim.uncertain);
        if (item.state !== "settled") requireRecord(item.history === null);
        else {
          requireRecord(!claim.uncertain); const history = item.history;
          if (history?.kind === "not-submitted") { shape(history, ["kind", "proof"]); validateIdentity(history.proof, claim.identity); requireRecord(!claim.possibleNative && claim.evidence?.submission === "not-submitted"); }
          else {
            shape(history, ["kind", "status", "authorization"]); validateAuthorization(history.authorization);
            requireRecord(history.kind === "settled" && ["completed", "failed", "interrupted"].includes(history.status) && history.authorization.kind === "settlement" && history.authorization.chainId === item.chainId && history.authorization.predecessorRunId === claim.identity.runId && equal(history.authorization.source, claim.identity.source) && claim.evidence?.submission === "submitted" && !authorizations.has(history.authorization.authorizationId));
            authorizations.add(history.authorization.authorizationId); latestSettlement = history.authorization;
            predecessors.set(item.chainId, claim.identity.runId);
          }
        }
      }
    }
    const active = c.items.filter((i: any) => ["waiting", "claimed", "run-linked"].includes(i.state));
    requireRecord(active.filter((i: any) => i.state === "waiting").length <= 3 && active.filter((i: any) => i.state !== "waiting").length <= 1);
    requireRecord(active.length ? c.chain !== null && active.every((i: any) => i.chainId === c.chain.chainId && equal(i.snapshot.pins, c.chain.pins)) : c.chain === null);
    if (active.some((i: any) => i.claim?.uncertain)) requireRecord(c.pause !== null, "Uncertainty requires a safety pause");
    const claimed = active.find((i: any) => i.state !== "waiting");
    if (claimed) requireRecord(active.filter((i: any) => i.state === "waiting").every((i: any) => i.sequence > claimed.sequence), "Claim cannot skip an older waiter");
    for (const op of c.operations) {
      shape(op, ["kind", "fingerprint", "request", "result"]); requireRecord(["remove", "resume"].includes(op.kind) && uuid(op.request?.requestId) && !requests.has(op.request.requestId) && op.request.conversationId === c.conversationId && op.fingerprint === fingerprint(op.request)); requests.add(op.request.requestId);
      requireRecord(positive(op.result?.revision) && op.result.revision <= c.revision);
      if (op.kind === "remove") {
        requireRecord(isPendingInputRemovalRequest(op.request) && isPendingInputRemovalResult(op.result) && uuid(op.request.itemId) && uuid(op.request.inputRequestId));
        const item = c.items.find((i: any) => i.itemId === op.request.itemId && i.requestId === op.request.inputRequestId); requireRecord(item);
        requireRecord(equal(op.request, { version: op.result.version, requestId: op.result.requestId, conversationId: op.result.conversationId, inputRequestId: op.result.inputRequestId, itemId: op.result.itemId }));
        requireRecord(op.result.outcome === "claimed" ? item.claim !== null && op.result.runId === item.claim.identity.runId : item.state === "removed");
      } else {
        shape(op.result, ["version", "requestId", "conversationId", "action", "expectedRevision", "outcome", "revision"]);
        requireRecord(isPendingInputResumeRequest(op.request) && op.result.outcome === "resumed" && equal(op.request, { version: op.result.version, requestId: op.result.requestId, conversationId: op.result.conversationId, action: op.result.action, expectedRevision: op.result.expectedRevision }) && op.result.revision === op.request.expectedRevision + 1);
      }
    }
    requireRecord([...attempts].every(id => !requests.has(id)), "Request/attempt namespace collision");
    requireRecord(equal(c.lastAuthorization, latestSettlement), "Last authorization must identify the latest historical settlement");
  }
  requireRecord(v.nextSequence > maximum, "Sequence must never be reused");
  return immutable(structuredClone(v)) as PendingInputRecords;
}
