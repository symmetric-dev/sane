import { isDeepStrictEqual } from "node:util";
import { isStoredAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import type { CanonicalExecutionRef } from "./canonical-execution-store";
import { validateContextMessageBinding, type ContextMessageBinding } from "./context-message";
import {
  contextMessageFromSubmission, decodeContextMessageDispatchObservation, projectContextMessageRestart,
  type ContextMessageEvidenceCoverage, type ContextMessageEvidenceSnapshot, type ContextMessageRestartProjection,
} from "./context-message-evidence";
import type { ContextPackageRef } from "./context-package";
import type { Event, Run } from "./history";

export type ContextMessageActivationExpected = Readonly<{
  binding: ContextMessageBinding;
  identity: StoredSaneAgentIdentity;
  context: ContextPackageRef;
  execution: CanonicalExecutionRef;
}>;

/** A bridge-owned association in the EXISTING activation run journal, not another
 * ledger or a delivered boolean. The writer must independently validate the full
 * pinned context/execution pair and actual standard submission binding first.
 * Decoding this shape alone does not grant authority to write that association. */
export type ContextMessageActivationPairing = ContextMessageActivationExpected & Readonly<{
  schema: 1;
  type: "context-message-activation-pairing";
  dispatch: DispatchIdentity;
  messageId: string;
  transportSha256: string;
  intent: "assistant-activation" | "assistant-upgrade" | "worker-launch";
  /** Exact protected journal source, identical to the evidence coverage source. */
  source: string;
}>;

/** Supplied from the owner's non-repairing protected metadata read AND separate
 * actual-native-byte/prefix continuity check, never from candidate metadata.
 * `runs` covers the activation run and ALL subsequent runs for this binding;
 * exclude earlier runs, whose compactions cannot invalidate a later activation.
 * Complete coverage is an owner capability, not a claim established by this codec.
 * `retained` means no later reset, compaction, bootstrap or superseding activation
 * in ANY covered native history/journal, as well as exact native byte continuity.
 * Events outside the activation journal must also be covered by nativeContext. */
export type ContextMessageActivationRetention = Readonly<{
  binding: ContextMessageBinding;
  coverage: ContextMessageEvidenceCoverage;
  nativeContext: "retained" | "reset" | "unknown";
  runs: readonly Readonly<Pick<Run, "runId" | "sessionId" | "operation">>[];
}>;

export type ContextMessageActivationResult = Readonly<{
  association: ContextMessageActivationPairing;
  restart: ContextMessageRestartProjection;
}>;

export class ContextMessageActivationError extends Error {
  readonly name = "ContextMessageActivationError";
  constructor(readonly code: "context-activation-unproven" | "context-retention-unproven", reason: string, options?: ErrorOptions) {
    super(reason, options);
  }
}

function fail(reason: string): never {
  throw new ContextMessageActivationError("context-activation-unproven", reason);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an activation evidence object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("Unexpected or missing activation fields");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("Expected a nonempty activation identity/source");
}
function hash(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Expected an activation SHA-256 pin");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function binding(value: unknown): asserts value is ContextMessageBinding {
  validateContextMessageBinding(value);
  if (value.harnessId !== "claude-code" && value.harnessId !== "opencode" && value.harnessId !== "grok") fail("Unsupported activation harness");
}
function expected(value: unknown): asserts value is ContextMessageActivationExpected {
  const item = record(value);
  keys(item, ["binding", "identity", "context", "execution"]);
  binding(item.binding);
  const identity = record(item.identity);
  keys(identity, ["kind", "role"]);
  if (identity.kind === "assistant" ? !isStoredAssistantAgentId(identity.role) : identity.kind !== "worker" || !isWorkerAgentId(identity.role)) fail("Invalid activation role/kind");
  const context = record(item.context), execution = record(item.execution);
  keys(context, ["schema", "revision", "delivery"], ["activation"]);
  keys(execution, ["schema", "revision"]);
  if (context.schema !== 1 || execution.schema !== 1 || context.delivery !== "standing-native-role"
    || Object.hasOwn(context, "activation") && context.activation !== "upgrade") fail("Invalid activation references");
  hash(context.revision); hash(execution.revision);
  if (context.activation === "upgrade" && identity.kind !== "assistant") fail("Only assistants have upgrade context");
}
function coverage(value: unknown): asserts value is ContextMessageEvidenceCoverage {
  const item = record(value);
  keys(item, ["state", "source"], ["reason"]);
  text(item.source);
  if (!["complete", "partial", "unavailable"].includes(item.state as string)) fail("Invalid protected evidence coverage");
  if (Object.hasOwn(item, "reason")) text(item.reason);
}

/** Strict, immutable JSON record codec. No context/execution store is consulted;
 * those refs attest a pair only because the protected owner wrote this record
 * after independent FULL pair validation, not because hashes look plausible. */
export function decodeContextMessageActivationPairing(value: unknown): ContextMessageActivationPairing {
  try {
    const item = record(structuredClone(value));
    keys(item, ["schema", "type", "dispatch", "binding", "identity", "context", "execution", "messageId", "transportSha256", "intent", "source"]);
    if (item.schema !== 1 || item.type !== "context-message-activation-pairing") fail("Unsupported activation pairing version");
    expected({ binding: item.binding, identity: item.identity, context: item.context, execution: item.execution });
    const dispatch = record(item.dispatch);
    keys(dispatch, ["source", "runId", "nativeCommandId"], ["requestId"]);
    binding(dispatch.source); text(dispatch.runId);
    if (dispatch.nativeCommandId !== null) text(dispatch.nativeCommandId);
    if (Object.hasOwn(dispatch, "requestId")) text(dispatch.requestId);
    text(item.messageId); text(item.source); hash(item.transportSha256);
    if (!isDeepStrictEqual(dispatch.source, item.binding)) fail("Activation dispatch has a different native binding");
    if ((item.binding as ContextMessageBinding).harnessId === "opencode" && dispatch.nativeCommandId !== item.messageId) fail("Activation differs from actual OC native message identity");
    if ((item.binding as ContextMessageBinding).harnessId === "grok" && (dispatch.nativeCommandId !== null || item.messageId !== `${dispatch.runId}:user`)) fail("Activation differs from the Grok prompt-file message identity");
    if ((item.binding as ContextMessageBinding).harnessId === "claude-code") {
      const initial = `${dispatch.runId}:user`;
      if (item.messageId !== initial && (!item.messageId.startsWith(`${initial}:`)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.messageId.slice(initial.length + 1)))) fail("Activation differs from actual CC message identity");
    }
    const identity = item.identity as StoredSaneAgentIdentity, context = item.context as ContextPackageRef;
    if (identity.kind === "worker" ? item.intent !== "worker-launch"
      : item.intent !== (context.activation === "upgrade" ? "assistant-upgrade" : "assistant-activation")) fail("Activation intent differs from role or upgrade pin");
    return freeze(item) as ContextMessageActivationPairing;
  } catch (error) {
    if (error instanceof ContextMessageActivationError) throw error;
    throw new ContextMessageActivationError("context-activation-unproven", "Malformed activation pairing", { cause: error });
  }
}

function journal(events: readonly Event[]): void {
  if (!Array.isArray(events)) fail("Protected journal events are unavailable");
  let previous = 0;
  const first = events[0];
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq !== previous + 1
      || event.runId !== first?.runId || event.sessionId !== first?.sessionId) fail("Activation requires one strictly ordered protected run journal");
    text(event.runId); text(event.sessionId);
    previous = event.seq;
  }
}
function data(event: Event): Record<string, unknown> | undefined {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : undefined;
}
function dispatchEvents(events: readonly Event[]) {
  return events.filter(event => event.kind === "context" && data(event)?.type === "context-message-dispatch");
}

/** Convenience ONLY for an already decoded, non-repairing, protected journal
 * read. Never extracts observations from messages, model text or legacy receipts,
 * and never brands historical submissions as live writer reservations. No sorting
 * of unrelated per-run sequences or promotion of partial coverage happens here.
 * Supply the complete journal from ordinal 1, without gaps or filtered events. */
export function contextMessageJournalSnapshot(events: readonly Event[], protectedCoverage: ContextMessageEvidenceCoverage): ContextMessageEvidenceSnapshot {
  try {
    coverage(protectedCoverage); journal(events);
    return freeze(structuredClone({ coverage: protectedCoverage, events,
      observations: dispatchEvents(events).map(event => ({ source: protectedCoverage.source, order: event.seq,
        value: decodeContextMessageDispatchObservation(event.data) })),
    }));
  } catch (error) {
    if (error instanceof ContextMessageActivationError) throw error;
    throw new ContextMessageActivationError("context-activation-unproven", "Malformed protected activation journal", { cause: error });
  }
}

function assertRetention(value: ContextMessageActivationRetention, association: ContextMessageActivationPairing): void {
  try {
    const item = record(value);
    keys(item, ["binding", "coverage", "nativeContext", "runs"]);
    binding(item.binding); coverage(item.coverage);
    if (!isDeepStrictEqual(item.binding, association.binding) || item.coverage.state !== "complete" || item.nativeContext !== "retained"
      || !Array.isArray(item.runs) || !item.runs.length) fail("No complete current native retention proof for the activation binding");
    const ids = new Set<string>();
    for (const value of item.runs) {
      const run = record(value);
      keys(run, ["runId", "sessionId"], ["operation"]); text(run.runId);
      if (run.sessionId !== association.binding.sessionId || ids.has(run.runId)
        || run.operation !== undefined && run.operation !== "prompt") fail("Compaction or uncertain/foreign run invalidates activation retention");
      ids.add(run.runId);
    }
    if (!ids.has(association.dispatch.runId)) fail("Retention coverage omits the activation run");
  } catch (error) {
    throw new ContextMessageActivationError("context-retention-unproven", "Current context retention is not proven", { cause: error });
  }
}

/** Read-only durable pairing check for the ordinary production fast path. The
 * caller supplies trusted LIVE pins (never derived from the candidate message),
 * a complete protected activation journal, protected later-run metadata and an
 * independent native user-byte/prefix continuity check BEFORE calling this.
 * This function performs no I/O, repair, freshness inference, resend or storage
 * failure mutation. It deliberately supports no implicit branch inheritance:
 * a different native binding is refused even if its metadata copies these pins.
 * Success retains the honest CC transport/OC acceptance fact, not consumption. */
export function assertContextMessageActivation(options: Readonly<{
  expected: ContextMessageActivationExpected;
  snapshot: ContextMessageEvidenceSnapshot;
  retention: ContextMessageActivationRetention;
}>): ContextMessageActivationResult {
  try {
    expected(options.expected);
    const { snapshot } = options;
    coverage(snapshot.coverage); journal(snapshot.events);
    if (snapshot.coverage.state !== "complete") fail("Activation evidence coverage is not complete");
    const associations = snapshot.events.filter(event => event.kind === "context" && data(event)?.type === "context-message-activation-pairing");
    if (associations.length !== 1) fail("Exactly one protected activation pairing is required; duplicates/supersession are unproven");
    const paired = associations[0]!;
    const association = decodeContextMessageActivationPairing(paired.data);
    if (association.source !== snapshot.coverage.source || paired.runId !== association.dispatch.runId
      || paired.sessionId !== association.binding.sessionId
      || !isDeepStrictEqual({ binding: association.binding, identity: association.identity, context: association.context, execution: association.execution }, options.expected)) fail("Activation pairing differs from trusted source, binding, role or pinned references");
    assertRetention(options.retention, association);

    // Observations cannot be a caller-invented parallel side channel. Every one
    // must be the identical context event at its protected journal ordinal.
    const actual = contextMessageJournalSnapshot(snapshot.events, snapshot.coverage);
    if (!isDeepStrictEqual(snapshot.observations, actual.observations)) fail("Dispatch observations do not exactly cover the same protected journal");
    const submissions = snapshot.events.filter(event => event.kind === "submission" && data(event)?.messageId === association.messageId);
    if (submissions.length !== 1) fail("Activation requires its unique actual standard submission");
    const standard = submissions[0]!;
    const message = contextMessageFromSubmission(standard.data);
    const submission = record(standard.data), composition = record(submission.composition);
    if (standard.seq >= paired.seq || !isDeepStrictEqual(composition.dispatch, association.dispatch)
      || !isDeepStrictEqual(message.binding, association.binding) || message.transport.sha256 !== association.transportSha256
      || message.packageRevision !== association.context.revision || message.placement.kind !== "bootstrap"
      || message.segments.find(segment => segment.category === "role")?.id !== `role.${association.identity.kind}.${association.identity.role}`) fail("Activation does not reference its exact bootstrap, bytes, native dispatch and package");
    if (association.intent === "worker-launch" ? message.origin !== "worker-launch"
      : association.intent === "assistant-activation" ? message.origin !== "activation"
        : message.origin !== "activation" && message.origin !== "context-update") fail("Bootstrap origin differs from activation intent");
    if (association.identity.kind === "assistant" && message.placement.workerMode !== undefined
      || association.identity.kind === "worker" && (!message.placement.workerMode
        || !message.segments.some(segment => segment.category === "worker-assignment")
        || message.placement.workerMode === "free" && association.identity.role !== "implementer")) fail("Bootstrap worker mode differs from activation role");

    for (const event of snapshot.events) {
      if (event.seq <= standard.seq) continue;
      const structured = data(event);
      // Trusted normalized record fields ONLY: never scan parts/text for markers.
      if (structured && (structured.contextReset === true
        || event.kind === "message" && (structured.compaction !== undefined || structured.type === "compaction" || structured.type === "contextReset"))) {
        throw new ContextMessageActivationError("context-retention-unproven", "A later native reset/compaction observation invalidates activation retention");
      }
      if (event.kind === "submission" && structured && Object.hasOwn(structured, "composition")) {
        const later = contextMessageFromSubmission(event.data);
        if (later.placement.kind === "bootstrap" || later.segments.some(segment => segment.category === "role")) fail("A later bootstrap or role update supersedes the activation");
      }
    }
    for (const event of dispatchEvents(snapshot.events)) {
      const observation = decodeContextMessageDispatchObservation(event.data);
      if (observation.evidence.runId !== event.runId || !isDeepStrictEqual(observation.evidence.source, association.binding)) fail("Dispatch event has a foreign journal/native source");
      if (observation.messageId === association.messageId && (event.seq <= standard.seq
        || observation.stage === "outcome" && observation.evidence.submission === "unknown")) fail("Activation has unresolved or misordered native evidence");
    }
    const restart = projectContextMessageRestart({ identity: association.dispatch, messageId: association.messageId }, actual);
    if (restart.fact !== "accepted" && (association.binding.harnessId !== "claude-code" || restart.fact !== "submitted-unconfirmed")) fail(`Activation submission is unproven: ${restart.fact}`);
    return freeze({ association, restart });
  } catch (error) {
    if (error instanceof ContextMessageActivationError) throw error;
    throw new ContextMessageActivationError("context-activation-unproven", "Malformed or unavailable activation evidence", { cause: error });
  }
}
