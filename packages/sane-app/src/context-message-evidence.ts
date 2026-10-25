import { Buffer } from "node:buffer";
import type { DispatchEvidenceHooks, DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { DispatchPreNativeRefusal, synchronousDispatchHook } from "./dispatch-evidence";
import { decodeContextMessage, validateContextMessageBinding, type ContextMessage, type ContextMessageBinding, type ContextMessageSegment } from "./context-message";
import type { Event } from "./history";

/** Separate from prepared/queue codecs. `text` is the standard submission's exact
 * outgoing bytes, stored ONCE; metadata contains ranges/hashes, never prompt copies.
 * Structural validity is not trusted selection, activation or native admission. */
export type ContextMessageCompositionMetadata = Readonly<{
  schema: 1;
  type: "context-message-composition";
  messageSchema: 1;
  dispatch: DispatchIdentity;
  origin: ContextMessage["origin"];
  placement: ContextMessage["placement"];
  packageRevision: string | null;
  body: Omit<ContextMessage["body"], "text">;
  segments: readonly Omit<ContextMessageSegment, "text">[];
  selectionHash: string;
  transport: Omit<ContextMessage["transport"], "text">;
}>;
export type ContextMessageSubmission = Readonly<{
  messageId: string;
  text: string;
  composition: ContextMessageCompositionMetadata;
  liveInput?: boolean;
  queuedFollowupId?: string;
}>;
export type ContextMessageBoundary = "run-initial" | "message";
export type ContextMessageDispatchObservation = Readonly<{
  schema: 1;
  type: "context-message-dispatch";
  messageId: string;
  transportSha256: string;
  boundary: ContextMessageBoundary;
  stage: "before-native" | "outcome";
  /** Existing contract, not an extended identity that queue codecs might reject. */
  evidence: DispatchSubmissionEvidence;
}>;

function fail(reason: string): never { throw new Error(`Invalid context message evidence: ${reason}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("unexpected or missing fields");
}
function string(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim()) fail("expected nonempty string"); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("expected SHA-256"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? fail("non-JSON value");
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function identity(value: unknown): DispatchIdentity {
  const item = object(value);
  keys(item, ["source", "runId", "nativeCommandId"], ["requestId"]);
  const source = object(item.source);
  keys(source, ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]);
  string(source.harnessId); string(source.sessionId); string(source.cwd);
  if (source.authorityId !== null) string(source.authorityId);
  if (source.nativeSessionId !== null) string(source.nativeSessionId);
  string(item.runId);
  if (item.nativeCommandId !== null) string(item.nativeCommandId);
  if (Object.hasOwn(item, "requestId")) string(item.requestId);
  return freeze({ source: { harnessId: source.harnessId, sessionId: source.sessionId, authorityId: source.authorityId,
    nativeSessionId: source.nativeSessionId, cwd: source.cwd }, runId: item.runId, nativeCommandId: item.nativeCommandId as string | null,
    ...(item.requestId !== undefined ? { requestId: item.requestId as string } : {}) });
}
function dispatchIdentity(value: DispatchSubmissionEvidence): DispatchIdentity {
  // Explicitly strip outcome fields; NEVER pass evidence to an exact-shape
  // identity codec or spread it into a prepared/queue identity.
  return identity({ source: value.source, runId: value.runId, nativeCommandId: value.nativeCommandId,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}) });
}
function evidence(value: unknown): DispatchSubmissionEvidence {
  const item = object(value);
  keys(item, ["source", "runId", "nativeCommandId", "submission", "nativeAcceptance"], ["requestId"]);
  const id = identity({ source: item.source, runId: item.runId, nativeCommandId: item.nativeCommandId,
    ...(item.requestId !== undefined ? { requestId: item.requestId } : {}) });
  if (!["not-submitted", "attempted", "submitted", "unknown"].includes(item.submission as string)
    || !["not-accepted", "accepted", "unknown"].includes(item.nativeAcceptance as string)
    || item.submission === "not-submitted" && item.nativeAcceptance !== "not-accepted"
    || item.submission !== "submitted" && item.submission !== "not-submitted" && item.nativeAcceptance !== "unknown"
    || item.nativeAcceptance === "accepted" && item.submission !== "submitted") fail("contradictory dispatch evidence");
  return freeze({ ...id, submission: item.submission, nativeAcceptance: item.nativeAcceptance } as DispatchSubmissionEvidence);
}

function slice(text: string, rangeValue: unknown): string {
  const range = object(rangeValue);
  keys(range, ["offset", "length"]);
  const { offset, length } = range;
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (offset as number) < 0 || (length as number) < 0
    || (offset as number) > bytes.length - (length as number)) fail("invalid UTF-8 byte range");
  const selected = bytes.subarray(offset as number, (offset as number) + (length as number));
  const result = selected.toString("utf8");
  if (!Buffer.from(result, "utf8").equals(selected)) fail("range splits UTF-8 character");
  return result;
}

/** Reconstruct only from structured recorded ranges, then delegate ALL framing,
 * provenance, hash, placement and exact-byte checks to the composer decoder. */
export function contextMessageFromSubmission(value: unknown): ContextMessage {
  const submission = object(value);
  keys(submission, ["messageId", "text", "composition"], ["liveInput", "queuedFollowupId"]);
  string(submission.messageId);
  if (typeof submission.text !== "string") fail("submission text must be a string");
  if (Object.hasOwn(submission, "liveInput") && typeof submission.liveInput !== "boolean") fail("invalid liveInput");
  if (Object.hasOwn(submission, "queuedFollowupId")) string(submission.queuedFollowupId);
  const metadata = object(submission.composition);
  keys(metadata, ["schema", "type", "messageSchema", "dispatch", "origin", "placement", "packageRevision", "body", "segments", "selectionHash", "transport"]);
  if (metadata.schema !== 1 || metadata.type !== "context-message-composition" || metadata.messageSchema !== 1) fail("unsupported composition version");
  const id = identity(metadata.dispatch);
  assertSubmissionMessageId(submission.messageId, submission.liveInput as boolean | undefined, id);
  const body = object(metadata.body), transport = object(metadata.transport);
  keys(body, ["sha256", "range"]); keys(transport, ["sha256", "byteLength"]);
  if (!Array.isArray(metadata.segments)) fail("segments must be ordered");
  const segments = metadata.segments.map(value => {
    const segment = object(value);
    keys(segment, ["id", "category", "sha256", "reason", "provenance", "range"]);
    return { ...segment, text: slice(submission.text as string, segment.range) };
  });
  return decodeContextMessage({ schema: metadata.messageSchema, binding: id.source, origin: metadata.origin, placement: metadata.placement,
    packageRevision: metadata.packageRevision, body: { ...body, text: slice(submission.text, body.range) }, segments,
    selectionHash: metadata.selectionHash, transport: { ...transport, text: submission.text } });
}

export function decodeContextMessageSubmission(value: unknown): ContextMessageSubmission {
  const copy = structuredClone(value);
  contextMessageFromSubmission(copy);
  return freeze(copy) as ContextMessageSubmission;
}

/** `actual` must be the actual standard submission record, not a comparison
 * candidate. A composer/comparison result alone cannot manufacture a submission. */
export function recordContextMessageSubmission(messageValue: ContextMessage, actual: Readonly<{ messageId: string; text: string; liveInput?: boolean; queuedFollowupId?: string }>, dispatch: DispatchIdentity): ContextMessageSubmission {
  const message = decodeContextMessage(messageValue), id = identity(dispatch);
  if (actual.text !== message.transport.text || !same(id.source, message.binding)) fail("actual submission bytes/source differ from composition");
  const { text: _body, ...body } = message.body;
  const { text: _transport, ...transport } = message.transport;
  const segments = message.segments.map(({ text: _, ...metadata }) => metadata);
  return decodeContextMessageSubmission({ ...actual, composition: { schema: 1, type: "context-message-composition", messageSchema: message.schema,
    dispatch: id, origin: message.origin, placement: message.placement, packageRevision: message.packageRevision, body, segments,
    selectionHash: message.selectionHash, transport } });
}

export function decodeContextMessageDispatchObservation(value: unknown): ContextMessageDispatchObservation {
  const item = object(value);
  keys(item, ["schema", "type", "messageId", "transportSha256", "boundary", "stage", "evidence"]);
  if (item.schema !== 1 || item.type !== "context-message-dispatch") fail("unsupported dispatch observation version");
  string(item.messageId); hash(item.transportSha256);
  if (item.boundary !== "run-initial" && item.boundary !== "message") fail("invalid native boundary");
  if (item.stage !== "before-native" && item.stage !== "outcome") fail("invalid dispatch stage");
  const fact = evidence(item.evidence);
  if ((item.stage === "before-native") !== (fact.submission === "attempted")) fail("attempt is only legal at before-native");
  return freeze({ schema: 1, type: "context-message-dispatch", messageId: item.messageId, transportSha256: item.transportSha256,
    boundary: item.boundary, stage: item.stage, evidence: fact });
}

function assertSubmissionMessageId(messageId: string, liveInput: boolean | undefined, id: DispatchIdentity): void {
  if (id.source.harnessId === "claude-code") {
    const initial = `${id.runId}:user`;
    if (messageId !== initial && (liveInput !== true || !messageId.startsWith(`${initial}:`)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId.slice(initial.length + 1)))) fail("CC live input requires its actual UUID message ID");
    if (messageId === initial && liveInput === true) fail("Initial CC identity cannot be live input");
  }
  if (id.source.harnessId === "opencode" && id.nativeCommandId !== messageId) fail("OC submission differs from requested native message identity");
}
function assertBoundary(submission: ContextMessageSubmission, boundary: ContextMessageBoundary): void {
  if (boundary !== "run-initial" && boundary !== "message") fail("invalid native boundary");
  const id = submission.composition.dispatch;
  assertSubmissionMessageId(submission.messageId, submission.liveInput, id);
  if (id.source.harnessId === "claude-code" && boundary === "run-initial"
    && (submission.messageId !== `${id.runId}:user` || submission.liveInput === true)) fail("initial CC evidence cannot certify background input");
}

/** Decorates the EXISTING owner's hooks; never calls createDispatchEvidence and
 * has no mutable admission/ack state. Supply these hooks to the existing dispatch
 * lifecycle, not to a second owner or a second transport send.
 *
 * persist must use the SAME owner/claim/journal authority as the original hooks:
 * synchronously fsync/commit both the standard submission+metadata and correlated
 * observation (or verify an already durable identical submission). It must return
 * only after both are durable, and flag coverage/reconciliation failure on any
 * partial commit. Reuse existing text storage; don't append full prompt copies for
 * each outcome. Async bridge emit is NOT a valid implementation. No writer is
 * installed here. Existing hook failures fail closed. Only the original
 * synchronous intent hook may propagate a certified refusal unchanged; refusal-
 * class failures elsewhere before native execution are ordinary errors with the
 * original as cause so the enclosing lifecycle cannot certify them by class.
 *
 * `readActualSubmission` must read the native adapter's actual message ID/bytes and
 * owner identity synchronously, not echo the supplied composition. For a CC live
 * input this needs its OWN before-write/flush observations; initial run hooks do
 * not cover sendInput. Initial CC intent must precede spawn, not merely stdin. */
export function decorateContextMessageEvidence(options: Readonly<{
  submission: ContextMessageSubmission;
  boundary: ContextMessageBoundary;
  hooks: DispatchEvidenceHooks;
  readActualSubmission: () => Readonly<{ identity: DispatchIdentity; messageId: string; text: string }>;
  persist: (submission: ContextMessageSubmission, observation: ContextMessageDispatchObservation) => void;
  failClosed: (error: unknown) => void;
}>): DispatchEvidenceHooks {
  const submission = decodeContextMessageSubmission(options.submission);
  const { boundary, readActualSubmission, persist, failClosed } = options;
  const hooks = { ...options.hooks };
  assertBoundary(submission, boundary);
  const observe = (stage: ContextMessageDispatchObservation["stage"], supplied: DispatchSubmissionEvidence) => {
    let certifiedRefusal: DispatchPreNativeRefusal | undefined;
    try {
      let actual: ReturnType<typeof readActualSubmission> | undefined;
      synchronousDispatchHook(() => { actual = readActualSubmission(); return actual; });
      const fact = evidence(supplied);
      if (!actual || !same(identity(actual.identity), submission.composition.dispatch) || actual.messageId !== submission.messageId || actual.text !== submission.text
        || !same(dispatchIdentity(fact), submission.composition.dispatch)) fail("native message or dispatch identity differs from recorded submission");
      const observation = decodeContextMessageDispatchObservation({ schema: 1, type: "context-message-dispatch", messageId: actual.messageId,
        transportSha256: submission.composition.transport.sha256, boundary, stage, evidence: fact });
      // Original hooks retain their order and synchronous refusal semantics.
      // If the second write fails, the owner must retain reconciliation; never
      // infer an outcome from the first record or continue native execution.
      if (stage === "before-native") {
        synchronousDispatchHook(() => {
          try { return hooks.beforeNative?.(fact); }
          catch (error) {
            // Only the ORIGINAL synchronous intent hook can certify a local
            // refusal. Identity/persistence/outcome failures must still fail closed.
            if (error instanceof DispatchPreNativeRefusal) certifiedRefusal = error;
            throw error;
          }
        });
      } else synchronousDispatchHook(() => hooks.outcome?.(fact));
      synchronousDispatchHook(() => persist(submission, observation));
    } catch (error) {
      // No native attempt or composition attempt is committed by this decorator
      // when its original owner hook certifies definite pre-native withholding.
      if (certifiedRefusal !== undefined && error === certifiedRefusal) throw error;
      // The enclosing lifecycle recognizes this class from its beforeNative
      // hook. Do not let a read/validation/persistence failure borrow that
      // certification merely because the decorator is now its original hook.
      const failure = stage === "before-native" && error instanceof DispatchPreNativeRefusal
        ? new Error("Uncertified context message pre-native refusal", { cause: error })
        : error;
      // Preserve ordinary/outcome failure identity (and wrapped causes), even if
      // failClosed itself fails. Genuine original intent refusals returned above.
      try { synchronousDispatchHook(() => failClosed(failure)); }
      finally { throw failure; }
    }
  };
  return { beforeNative: fact => observe("before-native", fact), outcome: fact => observe("outcome", fact) };
}

export type ContextMessageEvidenceCoverage = Readonly<{
  state: "complete" | "partial" | "unavailable";
  /** Exact protected snapshot/journal/claim source, not a generic 'history'. */
  source: string;
  reason?: string;
}>;
export type ContextMessageEvidenceSnapshot = Readonly<{
  coverage: ContextMessageEvidenceCoverage;
  /** Already decoded by the existing journal decoder. No marker/status scanning. */
  events: readonly Event[];
  /** Owner-correlated persisted observations, in one verified total order. `order`
   * is a protected snapshot ordinal; do not sort unrelated journal seqs together.
   * An old dispatch record lacking message-boundary correlation is insufficient. */
  observations: readonly Readonly<{ source: string; order: number; value: unknown }>[];
}>;
export type ContextMessageRestartFact = "no-evidence" | "prepared-only" | "withheld" | "attempt-unresolved" | "submitted-unconfirmed" | "submitted-not-accepted" | "accepted" | "unknown";
export type ContextMessageEvidenceProvenance = Readonly<{ source: string; sequence: number; kind: "submission" | "dispatch" }>;
export type ContextMessageRestartProjection = Readonly<{
  identity: DispatchIdentity;
  messageId: string;
  coverage: ContextMessageEvidenceCoverage;
  fact: ContextMessageRestartFact;
  reason: string;
  provenance: readonly ContextMessageEvidenceProvenance[];
  composition: ContextMessageCompositionMetadata | null;
}>;

function evidenceCoverage(value: unknown): ContextMessageEvidenceCoverage {
  const item = object(value); keys(item, ["state", "source"], ["reason"]);
  if (item.state !== "complete" && item.state !== "partial" && item.state !== "unavailable") fail("invalid coverage state");
  string(item.source);
  if (Object.hasOwn(item, "reason")) string(item.reason);
  return freeze({ state: item.state, source: item.source, ...(item.reason !== undefined ? { reason: item.reason as string } : {}) });
}

/** Pure restart facts, NOT a resend/activation decision. Complete absence means
 * no recorded evidence, NEVER a fresh native session. Partial/unavailable or
 * inconsistent cross-record coverage is unknown even if one record says accepted.
 * Run success, legacy receipts, prepared context and textual markers are ignored.
 * 'submitted-unconfirmed' honestly represents CC pipe delivery; only explicit
 * correlated native acceptance can return 'accepted'. Neither proves consumption
 * or that historical activation remains current after later resets/compaction;
 * the lifecycle owner's durable activation/pairing check must establish that. */
export function projectContextMessageRestart(query: Readonly<{ identity: DispatchIdentity; messageId: string }>, snapshot: ContextMessageEvidenceSnapshot): ContextMessageRestartProjection {
  const id = identity(query.identity); string(query.messageId);
  const provenance: ContextMessageEvidenceProvenance[] = [];
  let composition: ContextMessageCompositionMetadata | null = null;
  let coverage: ContextMessageEvidenceCoverage = { state: "unavailable", source: "unavailable", reason: "No valid protected coverage/source supplied" };
  const finish = (fact: ContextMessageRestartFact, reason: string): ContextMessageRestartProjection => freeze({ identity: id, messageId: query.messageId,
    coverage, fact, reason, provenance: [...provenance], composition });
  try {
    coverage = evidenceCoverage(snapshot.coverage);
    if (coverage.state !== "complete") return finish("unknown", "Evidence coverage is not complete; missing history cannot establish freshness or admission");
    if (id.source.authorityId === null || id.source.nativeSessionId === null) return finish("unknown", "Native source identity is not finalized; composition cannot establish its binding");
    const matching = snapshot.events.filter(event => event.runId === id.runId && event.sessionId === id.source.sessionId && event.kind === "submission"
      && object(event.data).messageId === query.messageId);
    if (matching.length > 1) return finish("unknown", "Duplicate submission message identity");
    const event = matching[0];
    let submission: ContextMessageSubmission | undefined;
    if (event) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0) return finish("unknown", "Invalid decoded submission sequence");
      provenance.push({ source: coverage.source, sequence: event.seq, kind: "submission" });
      submission = decodeContextMessageSubmission(event.data);
      composition = submission.composition;
      if (!same(composition.dispatch, id)) return finish("unknown", "Submission has a different source/dispatch identity");
    }
    const observations: ContextMessageDispatchObservation[] = [];
    let previousOrder = -1;
    for (const record of snapshot.observations) {
      // Invalid correlated records cannot silently disappear from a claimed
      // complete snapshot, even if their corrupt identity looks unrelated.
      string(record.source);
      if (!Number.isSafeInteger(record.order) || record.order <= previousOrder) return finish("unknown", "Observation coverage lacks a strict protected total order");
      previousOrder = record.order;
      const observation = decodeContextMessageDispatchObservation(record.value);
      if (observation.messageId !== query.messageId || observation.evidence.runId !== id.runId) continue;
      provenance.push({ source: record.source, sequence: record.order, kind: "dispatch" });
      if (!same(dispatchIdentity(observation.evidence), id)) return finish("unknown", "Per-message observation has a foreign source/dispatch identity");
      if (!submission || observation.transportSha256 !== composition?.transport.sha256) return finish("unknown", "Dispatch observation has no matching exact submission bytes");
      assertBoundary(submission, observation.boundary);
      observations.push(observation);
    }
    if (!submission) return finish("no-evidence", "No exact per-message submission or boundary evidence; this is not a fresh-session claim");
    if (!observations.length) return finish("prepared-only", "Composition/submission record alone does not establish native execution or activation");
    let attempted = false, submitted = false, withheld = false, unconfirmed = false;
    let acceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown";
    let boundary: ContextMessageBoundary | undefined;
    for (const observation of observations) {
      if (boundary && observation.boundary !== boundary) return finish("unknown", "Mixed native boundaries for one message");
      boundary = observation.boundary;
      const fact = observation.evidence;
      if (observation.stage === "before-native") {
        if (attempted || withheld || unconfirmed) return finish("unknown", "Conflicting or repeated attempt records");
        attempted = true;
      } else if (fact.submission === "not-submitted") {
        if (attempted || submitted || unconfirmed) return finish("unknown", "Withholding conflicts with possible native execution");
        withheld = true;
      } else {
        if (withheld) return finish("unknown", "Outcome conflicts with withholding");
        if (!attempted) {
          if (fact.submission !== "unknown") return finish("unknown", "Outcome lacks durable correlated before-native intent");
          unconfirmed = true;
        }
        if (fact.submission === "submitted") submitted = true;
        if (fact.nativeAcceptance !== "unknown") {
          if (acceptance !== "unknown" && acceptance !== fact.nativeAcceptance) return finish("unknown", "Contradictory native acceptance observations");
          acceptance = fact.nativeAcceptance;
        }
      }
    }
    if (withheld) return finish("withheld", "Explicit correlated non-submission; no activation established");
    if (submitted && acceptance === "accepted") return finish("accepted", "Exact per-message native acceptance, not model consumption");
    if (submitted && acceptance === "not-accepted") return finish("submitted-not-accepted", "Transport submitted but native acceptance explicitly refused");
    if (submitted) return finish("submitted-unconfirmed", "Transport submission only; native acceptance is not established");
    if (attempted) return finish("attempt-unresolved", "Possible native execution with no confirmed submission; never automatically resend");
    return finish("unknown", "Unconfirmed boundary; never infer non-submission or automatically resend");
  } catch {
    return finish("unknown", "Malformed, legacy, or inconsistent composition/correlated dispatch records");
  }
}

export type ContextMessageAncestorReference = Readonly<{ identity: DispatchIdentity; messageId: string; transportSha256: string }>;
/** Only a protected branch owner/native verification record may supply this.
 * Literal fields are schema checks, NOT authorization from user/model text. The
 * owner must verify a completed fork, exact selected prefix and no reset/compact
 * boundary that invalidates the copied bytes. Copying config/canonicalActivation
 * flags does not meet this contract. This module does not discover such proof. */
export type VerifiedContextMessageBranchPrefix = Readonly<{
  schema: 1;
  type: "verified-context-message-branch-prefix";
  branchId: string;
  source: ContextMessageBinding;
  destination: ContextMessageBinding;
  state: "completed";
  reset: "none";
  verification: Readonly<{ kind: "exact-prefix"; source: string; reference: string }>;
  throughMessageId: string;
  prefix: readonly ContextMessageAncestorReference[];
}>;
export type ContextMessageBranchProjection = Readonly<{
  fact: "inherited" | "unknown";
  reason: string;
  lineage: VerifiedContextMessageBranchPrefix | null;
  /** Original ancestor sources/facts only. No destination submission fabricated. */
  ancestors: readonly Readonly<{ reference: ContextMessageAncestorReference; evidence: ContextMessageRestartProjection }>[];
}>;

function ancestor(value: unknown): ContextMessageAncestorReference {
  const item = object(value); keys(item, ["identity", "messageId", "transportSha256"]);
  string(item.messageId); hash(item.transportSha256);
  return freeze({ identity: identity(item.identity), messageId: item.messageId, transportSha256: item.transportSha256 });
}
function branchPrefix(value: unknown): VerifiedContextMessageBranchPrefix {
  const item = object(value);
  keys(item, ["schema", "type", "branchId", "source", "destination", "state", "reset", "verification", "throughMessageId", "prefix"]);
  if (item.schema !== 1 || item.type !== "verified-context-message-branch-prefix" || item.state !== "completed" || item.reset !== "none") fail("incomplete or reset branch prefix");
  string(item.branchId); string(item.throughMessageId);
  validateContextMessageBinding(item.source); validateContextMessageBinding(item.destination);
  if (same(item.source, item.destination)) fail("branch destination equals ancestor source");
  const verification = object(item.verification); keys(verification, ["kind", "source", "reference"]);
  if (verification.kind !== "exact-prefix") fail("branch needs exact native prefix verification");
  string(verification.source); string(verification.reference);
  if (!Array.isArray(item.prefix) || !item.prefix.length) fail("branch prefix is unavailable");
  const prefix = item.prefix.map(ancestor);
  if (prefix.at(-1)?.messageId !== item.throughMessageId || prefix.some(ref => !same(ref.identity.source, item.source))
    || new Set(prefix.map(ref => canonical({ identity: ref.identity, messageId: ref.messageId }))).size !== prefix.length) fail("invalid exact parent prefix identities/boundary");
  return freeze({ schema: 1, type: "verified-context-message-branch-prefix", branchId: item.branchId, source: { ...item.source }, destination: { ...item.destination },
    state: "completed", reset: "none", verification: { kind: "exact-prefix", source: verification.source, reference: verification.reference }, throughMessageId: item.throughMessageId, prefix });
}

/** Pure inheritance projection over protected records. Requires exact ancestor
 * message hashes/identities WITHIN the selected verified prefix, and reconstructs
 * parent facts itself instead of trusting a caller-supplied 'activated' boolean.
 * 'inherited' means verified copied bytes with their ORIGINAL transport/admission
 * facts; it is NOT destination admission, execution pairing, or permission to send.
 * Insufficient proof/boundary/reset/parent coverage always returns unknown. This
 * verifies one protected parent edge, not an inferred transitive lineage chain. */
export function projectContextMessageBranch(options: Readonly<{
  destination: ContextMessageBinding;
  verifiedPrefix: unknown;
  requiredAncestors: readonly ContextMessageAncestorReference[];
  parent: ContextMessageEvidenceSnapshot;
}>): ContextMessageBranchProjection {
  const unknown = (reason: string): ContextMessageBranchProjection => freeze({ fact: "unknown", reason, lineage: null, ancestors: [] });
  try {
    validateContextMessageBinding(options.destination);
    const proof = branchPrefix(options.verifiedPrefix);
    if (!same(proof.destination, options.destination) || !options.requiredAncestors.length) return unknown("No exact destination/required inherited message selection");
    const required = options.requiredAncestors.map(ancestor);
    if (new Set(required.map(canonical)).size !== required.length) return unknown("Duplicate required ancestor identity");
    const ancestors: ContextMessageBranchProjection["ancestors"][number][] = [];
    for (const ref of required) {
      if (!proof.prefix.some(selected => same(selected, ref))) return unknown("Required parent message is outside the verified selected prefix");
      const projected = projectContextMessageRestart({ identity: ref.identity, messageId: ref.messageId }, options.parent);
      if ((projected.fact !== "accepted" && projected.fact !== "submitted-unconfirmed") || projected.composition?.transport.sha256 !== ref.transportSha256) return unknown("Parent message bytes or submission/admission evidence are insufficient");
      ancestors.push({ reference: ref, evidence: projected });
    }
    return freeze({ fact: "inherited", reason: "Exact verified inherited prefix; ancestor evidence retained without a destination submission or consumption claim", lineage: proof, ancestors });
  } catch {
    return unknown("Protected completed prefix proof, boundary/reset information, or parent evidence is unavailable/invalid");
  }
}
