import { isDeepStrictEqual } from "node:util";
import type { AsideRecord } from "../shared/aside-contract";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { asideReferenceText, asideSourceFingerprint } from "./aside-chat-reference";
import { ContextMessageValidationError, type ContextMessageBinding } from "./context-message";
import { ContextMessageActivationError, contextMessageJournalSnapshot } from "./context-message-activation";
import { ContextMessageEvidenceValidationError, contextMessageFromSubmission, decodeContextMessageDispatchObservation, decodeContextMessageSubmission, projectContextMessageRestart } from "./context-message-evidence";
import { ContextMessageHistoryError, type ContextMessageHistorySnapshot } from "./context-message-reader";
import type { Run } from "./history";
import { UserInputPreparationError } from "./user-input-preparation";
import type { AsideReferenceSnapshot } from "./aside-store";

export type AsideReferenceDelivery = Readonly<{
  kind: "reference" | "body-only";
  /** Original journal association, never a delivered flag inferred from a Run. */
  delivered?: Readonly<{ dispatch: DispatchIdentity; messageId: string; transportSha256: string; source: string }>;
  assertCurrent(ownRunId?: string): void;
}>;

const runIdentity = (run: Run) => [run.runId, run.sessionId, run.cwd, run.nativeCommandId ?? null, run.operation ?? "prompt"];
const deliveryDiagnostics = {
  "journal-missing": "The original reference journal is missing. Restore its exact protected evidence, then retry the evidence check; do not resend the reference.",
  "journal-oversized": "The original reference journal exceeds the protected reader limit. Check its size and reader limit without trimming or rewriting history; do not resend the reference.",
  "journal-unsafe": "The protected reference journal or its storage location failed a file-safety check. Restore the original safe storage and exact evidence; do not resend the reference.",
  "journal-malformed": "The original reference journal is malformed or incomplete. Restore its exact protected evidence, then retry the evidence check; do not resend the reference.",
  "journal-changed": "The protected reference journal changed or was replaced. Re-read its exact evidence; if replaced, restore the original protected history. Do not resend the reference.",
  "journal-unavailable": "The protected reference journal could not be read. Check access to its original evidence, then retry the evidence check; do not resend the reference.",
  "dispatch-binding-mismatch": "The recorded reference dispatch does not match this conversation's original binding. Reconcile the original submission and saved binding; do not resend the reference.",
  "dispatch-evidence-conflict": "The original reference dispatch has conflicting order or boundary evidence. Reconcile that submission's exact journal; do not resend the reference.",
  "reference-source-mismatch": "The recorded submission does not prove this exact captured reference and source. Reconcile the original submission against the saved capture; do not send a replacement reference.",
  "dispatch-outcome-unconfirmed": "The original reference dispatch outcome is unconfirmed. Reconcile the original submission; a new message cannot resend its reference.",
  "reference-evidence-missing": "The existing conversation has no confirmed reference submission evidence. Reconcile its original journal; missing evidence does not authorize a fresh reference.",
  "compaction-without-delivery-proof": "Compaction is recorded without a proven earlier reference delivery. Reconcile the original submission evidence; compaction does not authorize a fresh reference.",
  "delivery-selection-stale": "The conversation's reference delivery selection changed before sending. Re-read the original delivery evidence and reconcile any earlier submission; do not resend its reference.",
} as const;
export type AsideReferenceDeliveryReason = keyof typeof deliveryDiagnostics;

/** Public messages/reasons are fixed, never copied from journal bytes or errors.
 * Keep the original error only as an internal cause, not HTTP diagnostics. */
export class AsideReferenceDeliveryError extends UserInputPreparationError {
  declare readonly reason: AsideReferenceDeliveryReason;
  constructor(reason: AsideReferenceDeliveryReason, cause?: unknown) {
    super(deliveryDiagnostics[reason], 409, "aside-reference-unconfirmed", reason);
    this.name = "AsideReferenceDeliveryError";
    Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
  }
}

/** Not a preparation refusal or proof of an uncertain native submission. */
export class AsideReferenceDeliveryInvariantError extends Error {
  readonly reason = "delivery-validation-failed";
  constructor(cause: unknown) {
    super("Aside reference delivery validation failed unexpectedly; inspect the internal cause before retrying", { cause });
    this.name = "AsideReferenceDeliveryInvariantError";
  }
}

const unconfirmed = (reason: AsideReferenceDeliveryReason): never => {
  throw new AsideReferenceDeliveryError(reason);
};

/** Only explicit codec validation refusals are malformed persisted evidence.
 * Unknown exceptions, including programming failures inside codecs, propagate
 * to invariant handling; no diagnostic text determines the classification. */
function decodeRecordedEvidence<T>(reason: "journal-malformed" | "dispatch-evidence-conflict", decode: () => T): T {
  try { return decode(); }
  catch (error) {
    if (error instanceof ContextMessageValidationError || error instanceof ContextMessageEvidenceValidationError || error instanceof ContextMessageActivationError)
      throw new AsideReferenceDeliveryError(reason, error);
    throw error;
  }
}

function deliveryFailure(error: unknown): never {
  if (error instanceof AsideReferenceDeliveryError || error instanceof AsideReferenceDeliveryInvariantError) throw error;
  if (error instanceof ContextMessageHistoryError) {
    const reasons = {
      missing: "journal-missing", oversized: "journal-oversized", unsafe: "journal-unsafe",
      malformed: "journal-malformed", changed: "journal-changed", unavailable: "journal-unavailable",
    } as const;
    throw new AsideReferenceDeliveryError(reasons[error.reason], error);
  }
  // A callback/helper programming exception is NOT a native outcome fact or an
  // expected preparation refusal. Preserve existing invariant-failure handling,
  // with a safe wrapper and the original exception available internally.
  throw new AsideReferenceDeliveryInvariantError(error);
}

/** Read-only selection at ORIGINAL ordinary intake. The same protected reader,
 * composition decoder and restart projector as context delivery qualify actual
 * CC stdin submission / OC acceptance. No receipt, installed Run, native-history
 * absence, text marker or source hash alone establishes delivery or freshness.
 *
 * No second ledger: restart discovery reads existing journals in their original
 * metadata order and retains the earliest qualifying reference. Later compaction
 * or native-history drift cannot turn that known delivery into a reinjection.
 * Destination identity and native freshness remain the bridge/native gates' job. */
export function captureAsideReferenceDelivery(options: Readonly<{
  record: AsideRecord | AsideReferenceSnapshot;
  destination: ContextMessageBinding;
  runs: () => readonly Run[];
  read: (run: Run) => ContextMessageHistorySnapshot;
}>): AsideReferenceDelivery {
  try { return capture(options); }
  catch (error) { return deliveryFailure(error); }
}

function capture(options: Parameters<typeof captureAsideReferenceDelivery>[0]): AsideReferenceDelivery {
  const destination = structuredClone(options.destination);
  const runs = options.runs().filter(run => run.sessionId === destination.sessionId);
  const identities = runs.map(runIdentity);
  const checks: (() => void)[] = [];
  const revision = asideSourceFingerprint(options.record);
  const record = "record" in options.record ? options.record.record : options.record;
  const source = `app:${record.source.storeId}/aside:${record.id}/parent-reference`;
  let expectedText: string | undefined;
  let unresolved: AsideReferenceDeliveryReason | undefined;
  let delivered: AsideReferenceDelivery["delivered"];
  for (const run of runs) {
    const history = options.read(run);
    checks.push(history.assertCurrent);
    const snapshot = decodeRecordedEvidence("journal-malformed", () => contextMessageJournalSnapshot(history.events, { state: "complete", source: history.source }));
    // Compaction never retracts a prior delivery. Without that prior proof it
    // also cannot authorize a fresh CC --session-id or reference reinjection.
    if (run.operation === "compact") { unresolved ??= "compaction-without-delivery-proof"; continue; }
    const submissions = history.events.filter(event => event.kind === "submission");
    if (!submissions.length) unresolved ??= "reference-evidence-missing";
    for (const event of submissions) {
      const submission = decodeRecordedEvidence("journal-malformed", () => decodeContextMessageSubmission(event.data));
      const dispatch = submission.composition.dispatch;
      const message = decodeRecordedEvidence("journal-malformed", () => contextMessageFromSubmission(submission));
      if (event.runId !== run.runId || event.sessionId !== destination.sessionId || run.cwd !== destination.cwd
        || dispatch.runId !== run.runId || dispatch.nativeCommandId !== (run.nativeCommandId ?? null)
        || submission.liveInput === true || !isDeepStrictEqual(dispatch.source, destination)) unconfirmed("dispatch-binding-mismatch");
      for (const observed of snapshot.observations) {
        const observation = decodeRecordedEvidence("dispatch-evidence-conflict", () => decodeContextMessageDispatchObservation(observed.value));
        if (observation.messageId === submission.messageId && (observed.order <= event.seq || observation.boundary !== "run-initial")) unconfirmed("dispatch-evidence-conflict");
      }
      const restart = decodeRecordedEvidence("dispatch-evidence-conflict", () => projectContextMessageRestart({ identity: dispatch, messageId: submission.messageId }, snapshot));
      const reference = message.segments.find(segment => segment.id === "aside.parent-reference");
      const matches = message.origin === "user" && message.placement.kind === "selected" && message.placement.purpose === "sharing"
        && reference?.category === "shared" && reference.provenance.kind === "fragment"
        && reference.provenance.source === source && reference.provenance.revision === revision
        && reference.text === (expectedText ??= asideReferenceText(options.record));
      if (matches && (restart.fact === "accepted" || destination.harnessId === "claude-code" && restart.fact === "submitted-unconfirmed")) {
        delivered = Object.freeze({ dispatch, messageId: submission.messageId, transportSha256: message.transport.sha256, source: history.source });
        break;
      }
      // Only explicit correlated withholding permits a later explicit first
      // reference send. Prepared-only, attempted/unknown or OC nonacceptance do
      // not silently become a replacement dispatch, even with an idle child.
      if (restart.fact !== "withheld") unresolved ??= !matches ? "reference-source-mismatch" : "dispatch-outcome-unconfirmed";
    }
    if (delivered) break;
  }
  if (!delivered && unresolved) unconfirmed(unresolved);
  const assertCurrent = (ownRunId?: string) => {
    try {
      const current = options.runs().filter(run => run.sessionId === destination.sessionId && run.runId !== ownRunId);
      if (!isDeepStrictEqual(current.map(runIdentity), identities)) unconfirmed("delivery-selection-stale");
      for (const check of checks) check();
    } catch (error) { deliveryFailure(error); }
  };
  assertCurrent();
  return Object.freeze({ kind: delivered ? "body-only" : "reference", ...(delivered ? { delivered } : {}), assertCurrent });
}
