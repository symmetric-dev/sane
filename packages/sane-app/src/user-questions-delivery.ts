import {
  parsePresentQuestionsInput, parseUserQuestionAnswers, USER_QUESTIONS_LIMITS,
  type UserQuestionsRecord,
} from "../shared/user-questions-contract";
import type {
  DispatchEvidenceHooks, DispatchIdentity, DispatchSource, DispatchSubmissionEvidence,
} from "../shared/conversation/dispatch-contract";
import type { ConversationAdmissionLease, ConversationCoordinator } from "./conversation-coordinator";
import { DispatchPreNativeRefusal, synchronousDispatchHook } from "./dispatch-evidence";
import { sameDispatchSource } from "./harness-dispatch";
import type { UserQuestionsStore } from "./user-questions-store";

type Delivery = NonNullable<UserQuestionsRecord["delivery"]>;
export type UserQuestionsDeliveryDenial = Readonly<{ ready: false; reason: string; disposition: "wait" | "pause" }>;
export type UserQuestionsDeliveryReadiness = { readonly ready: true } | UserQuestionsDeliveryDenial;

/** A trusted, pre-native readiness refusal, not an HTTP/transport error. */
export class UserQuestionsDeliveryDeferred extends Error {
  constructor(readonly denial: UserQuestionsDeliveryDenial) { super(denial.reason); }
}
/** An explicit resume may replace a definitely unsubmitted attempt while its
 * old preflight is still unwinding. It grants no authority over the new attempt. */
export class UserQuestionsDeliverySuperseded extends Error {}

export type UserQuestionsDeliveryContext = Readonly<{
  origin: "questionnaire-response";
  intent: { readonly kind: "questionnaire-response"; readonly requestId: string };
  delivery: "idle-only";
  requestId: string;
  source: DispatchSource;
  prompt: string;
  lease: ConversationAdmissionLease;
  signal: AbortSignal;
  /** Live domain/source validation, including after awaited preflight. The bridge
   * still validates its PreparedInputAdmission and original owner at dispatch. */
  assertCurrent: () => void;
  /** Pass to PreparedAdmissionContext.link: synchronous durable claim/run link
   * in final installation, BEFORE owner publication or possible native I/O. */
  link: (identity: DispatchIdentity) => void;
  evidence: Required<DispatchEvidenceHooks>;
}>;

export type UserQuestionsDeliveryReconciliation = Readonly<{
  evidence: DispatchSubmissionEvidence;
  /** Requires the original lifecycle's explicit withholding/durable proof of
   * non-submission. A default snapshot, missing command, or idle is NOT proof. */
  definiteNonSubmission?: true;
}>;

export type UserQuestionsDeliveryOptions = {
  store: Pick<UserQuestionsStore, "pending" | "getById" | "delivery" | "recover">;
  coordinator: Pick<ConversationCoordinator, "inspectReadiness" | "reserveAdmission" | "releaseAdmission">;
  /** Synchronous live binding/native identity and domain safety check. Return
   * wait for transient readiness; pause for changed binding/stop/cancel. Do not
   * reject merely because this delivery's original run now owns the session. */
  readiness: (form: UserQuestionsRecord) => UserQuestionsDeliveryReadiness;
  /** Owns input preparation and PreparedInputAdmission; apply context.link and
   * evidence unchanged. Resolve at admission with a snapshot, NEVER at run done.
   * App admission/default snapshots alone cannot establish native acceptance. */
  dispatch: (form: UserQuestionsRecord, context: UserQuestionsDeliveryContext) => Promise<DispatchSubmissionEvidence>;
  /** Read-only proof for these EXACT persisted run/command/source/request IDs.
   * Never submit, resume a model, or infer delivery from latest/idle/completion. */
  reconcile?: (form: UserQuestionsRecord, signal: AbortSignal) => Promise<UserQuestionsDeliveryReconciliation | null>;
  /** Translate only known pre-native readiness/contention errors. Storage,
   * unexpected failures, and errors after beforeNative must never be swallowed. */
  classifyError?: (error: unknown) => UserQuestionsDeliveryDenial | undefined;
  available?: () => boolean;
  failClosed: (error: unknown) => void;
};

/** Original question/answer pairs, not generated IDs or privileged instructions.
 * Reuse the store's parsers/budgets, and never truncate or silently omit answers. */
export function buildUserQuestionsResponse(form: UserQuestionsRecord): string {
  if (form.status !== "submitted" || !form.submission) throw new Error("Questionnaire response requires an immutable submission");
  const input = parsePresentQuestionsInput(form.input);
  const answers = parseUserQuestionAnswers(input, form.submission.answers);
  const json = JSON.stringify(input.pages.map((question, index) => ({ question: question.question, answer: answers[index] })))
    .replace(/[<>&]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  // Input/selected options may each expand sixfold under JSON escaping; custom
  // text is separately bounded per page.
  const maxBytes = 12 * USER_QUESTIONS_LIMITS.inputBytes + 6 * USER_QUESTIONS_LIMITS.pages * USER_QUESTIONS_LIMITS.answerText + 8192;
  if (new TextEncoder().encode(json).length > maxBytes) throw new Error("Questionnaire response exceeds its storage-derived budget");
  return "The user submitted answers to the earlier questions:\n" + json;
}

const sourceFor = (form: UserQuestionsRecord): DispatchSource => Object.freeze({
  harnessId: form.native.harness === "cc" ? "claude-code" : "opencode", sessionId: form.sessionId,
  authorityId: form.native.authorityId, nativeSessionId: form.native.nativeId, cwd: form.cwd,
});
const reasonText = (reason: string) => reason.replace(/\0/g, "").slice(0, 4096);
const accepted = (evidence: DispatchSubmissionEvidence) => evidence.submission === "submitted" && evidence.nativeAcceptance === "accepted";
const withheld = (evidence: DispatchSubmissionEvidence) => evidence.submission === "not-submitted" && evidence.nativeAcceptance === "not-accepted";

/** Durable outbox consumer only. Capacity and execution ownership remain in the
 * coordinator/bridge; no worker registry, blocking tool, or native retry exists.
 * Parents own polling/wakes and must call close/drain during shutdown. */
export class UserQuestionsDelivery {
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private closed = false;
  private failed = false;

  constructor(private readonly options: UserQuestionsDeliveryOptions) {}

  /** Explicit startup step, while storage is owned and before consumers start:
   * pending -> paused; claimed -> unknown. Never auto-resume either category. */
  recover(): void {
    try { this.options.store.recover(); }
    catch (error) { this.fail(error); throw error; }
  }

  isPolling(): boolean { return this.task !== undefined; }
  private open(): boolean { return !this.closed && !this.failed && this.options.available?.() !== false; }
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true; this.shutdown.abort(); this.options.failClosed(error);
  }

  /** Coalesce concurrent callers into one bounded, serial pass. No self-wake on
   * admission release: the parent's poll backstop handles later readiness. */
  poll(): Promise<void> {
    if (this.task) return this.task;
    if (this.closed || this.failed) return Promise.resolve();
    this.task = Promise.resolve().then(() => this.consume()).catch(error => { this.fail(error); throw error; })
      .finally(() => { this.task = undefined; });
    return this.task;
  }
  async drain(): Promise<void> { while (this.task) await this.task; }
  close(): Promise<void> {
    this.closed = true; this.shutdown.abort();
    return this.drain(); // Includes awaited preflight/admission, not model runs.
  }

  private current(form: UserQuestionsRecord): UserQuestionsRecord {
    const current = this.options.store.getById(form.id);
    if (!current || current.status !== "submitted" || !current.submission || !current.delivery
      || current.submission.id !== form.submission?.id) {
      throw new Error("Questionnaire submission or delivery identity changed");
    }
    if (current.delivery.id !== form.delivery?.id) throw new UserQuestionsDeliverySuperseded("The unsubmitted questionnaire attempt was superseded by explicit resume");
    return current;
  }

  private change(form: UserQuestionsRecord, change: Partial<Delivery>): UserQuestionsRecord {
    const current = this.current(form), delivery = current.delivery!;
    const normalized = { ...change, ...(change.reason !== undefined ? { reason: reasonText(change.reason) } : {}) };
    if (Object.entries(normalized).every(([key, value]) => delivery[key as keyof Delivery] === value)) return current;
    return this.options.store.delivery(form.id, normalized, () => {
      if (this.current(form).revision !== current.revision) throw new Error("Questionnaire delivery changed before commit");
    });
  }

  private readiness(form: UserQuestionsRecord): UserQuestionsDeliveryReadiness {
    if (!this.open()) return { ready: false, disposition: "pause", reason: "Questionnaire delivery stopped before native submission" };
    let result!: UserQuestionsDeliveryReadiness;
    synchronousDispatchHook(() => { result = this.options.readiness(form); return result; });
    return result;
  }

  private identity(form: UserQuestionsRecord, identity: DispatchIdentity, linked: boolean): void {
    const current = this.current(form), delivery = current.delivery!;
    if (!sameDispatchSource(sourceFor(current), identity.source) || identity.requestId !== delivery.id || !identity.runId
      || (current.native.harness === "oc" ? !identity.nativeCommandId : identity.nativeCommandId !== null)
      || linked && (delivery.runId !== identity.runId || delivery.nativeCommandId !== identity.nativeCommandId)) {
      throw new Error("Questionnaire evidence does not match its exact delivery/source/run/command identity");
    }
  }

  private defer(form: UserQuestionsRecord, denial: UserQuestionsDeliveryDenial): void {
    const current = this.current(form);
    if (current.delivery!.state === "pending") {
      this.change(current, { ...(denial.disposition === "pause" ? { state: "paused" as const } : {}), reason: denial.reason });
    }
  }

  private async consume(): Promise<void> {
    if (!this.open()) return;
    for (const snapshot of this.options.store.pending()) {
      if (!this.open()) break;
      let form: UserQuestionsRecord;
      try { form = this.current(snapshot); }
      catch (error) { if (error instanceof UserQuestionsDeliverySuperseded) continue; throw error; }
      if (form.delivery!.state === "pending") {
        try { await this.deliver(form); }
        catch (error) {
          if (this.failed) throw error;
          if (error instanceof UserQuestionsDeliverySuperseded) continue;
          const denial = this.denial(error);
          if (!denial || this.current(form).delivery!.state !== "pending") throw error;
          this.defer(form, denial);
        }
      }
      else if (form.delivery!.state === "claimed" || form.delivery!.state === "unknown") await this.reconcile(form);
    }
  }

  private async reconcile(form: UserQuestionsRecord): Promise<void> {
    if (!this.options.reconcile) return;
    let result: UserQuestionsDeliveryReconciliation | null;
    try { result = await this.options.reconcile(form, this.shutdown.signal); }
    catch (error) {
      if (this.denial(error)) return; // Unavailable read-only proof never retries.
      throw error;
    }
    if (!result) return;
    let current: UserQuestionsRecord;
    try { current = this.current(form); }
    catch (error) {
      if (error instanceof UserQuestionsDeliverySuperseded && !accepted(result.evidence)) return;
      throw error;
    }
    this.identity(current, result.evidence, true);
    if (current.delivery!.state === "accepted" || current.delivery!.state === "paused") return;
    if (accepted(result.evidence)) this.change(current, { state: "accepted", reason: "Exact native acceptance observed; understanding and task completion are not implied" });
    else if (withheld(result.evidence) && result.definiteNonSubmission) {
      this.change(current, { state: "paused", reason: "Exact non-submission confirmed; explicit resume required" });
    } else if (!withheld(result.evidence)) this.change(current, { state: "unknown", reason: "Native acceptance is unknown; do not resend" });
  }

  private denial(error: unknown): UserQuestionsDeliveryDenial | undefined {
    if (error instanceof UserQuestionsDeliveryDeferred) return error.denial;
    let result: UserQuestionsDeliveryDenial | undefined;
    synchronousDispatchHook(() => { result = this.options.classifyError?.(error); return result; });
    return result;
  }

  private async deliver(form: UserQuestionsRecord): Promise<void> {
    const readiness = this.readiness(form);
    if (!readiness.ready) { this.defer(form, readiness); return; }
    const requestId = form.delivery!.id, intent = { kind: "questionnaire-response", requestId } as const;
    const reservation = this.options.coordinator.reserveAdmission({ conversationIds: [form.sessionId], intent });
    if (!reservation.ready) { this.defer(form, { ready: false, disposition: "wait", reason: reservation.reason }); return; }
    const { lease } = reservation;
    let linked = false, possibleNative = false, refused: DispatchPreNativeRefusal | undefined;
    const assertCurrent = () => {
      const current = this.current(form), state = current.delivery!.state;
      if (linked ? state !== "claimed" && state !== "unknown" : state !== "pending") {
        throw new UserQuestionsDeliveryDeferred({ ready: false, disposition: "pause", reason: "Questionnaire delivery is no longer pending" });
      }
      const ready = this.readiness(current);
      if (!ready.ready) throw new UserQuestionsDeliveryDeferred(ready);
    };
    const applyEvidence = (evidence: DispatchSubmissionEvidence, explicitOutcome: boolean) => {
      this.identity(form, evidence, true);
      const current = this.current(form), state = current.delivery!.state;
      if (evidence.nativeAcceptance === "accepted" && evidence.submission !== "submitted") throw new Error("Native acceptance requires submitted questionnaire evidence");
      if (state === "accepted") {
        if (explicitOutcome && evidence.nativeAcceptance === "not-accepted") throw new Error("Native evidence contradicts accepted questionnaire delivery");
        return; // Weaker late observations cannot regress proof.
      }
      if (state === "paused") {
        if (!withheld(evidence)) throw new Error("Native evidence contradicts paused questionnaire delivery");
        return;
      }
      if (accepted(evidence)) {
        if (!possibleNative) throw new Error("Native acceptance arrived without a durable questionnaire boundary");
        this.change(current, { state: "accepted", reason: "Exact native acceptance observed; understanding and task completion are not implied" });
      } else if (withheld(evidence)) {
        // A snapshot at admission can be the default, NOT actual withholding.
        // It can also predate a boundary/outcome delivered before this await resumed.
        if (!explicitOutcome) return;
        if (possibleNative) throw new Error("Non-submission contradicts questionnaire native boundary");
        this.change(current, { state: "paused", reason: "Response was not submitted; explicit resume required" });
      } else this.change(current, { state: "unknown", reason: "Native acceptance is unknown; do not resend" });
    };
    const guarded = (action: () => void, boundary = false, allowSuperseded = false) => {
      try { action(); }
      catch (error) {
        if (error instanceof UserQuestionsDeliverySuperseded && !possibleNative) {
          if (boundary) {
            refused = new DispatchPreNativeRefusal(error);
            throw refused;
          }
          if (allowSuperseded) return; // Late withholding cannot mutate the replacement.
        }
        if (error !== refused) this.fail(error);
        throw error;
      }
    };
    const evidence: Required<DispatchEvidenceHooks> = {
      beforeNative: attempt => guarded(() => {
        if (!linked || possibleNative) throw new Error("Questionnaire native boundary requires one durable linked claim");
        this.identity(form, attempt, true);
        if (attempt.submission !== "attempted" || attempt.nativeAcceptance !== "unknown") throw new Error("Invalid questionnaire native attempt evidence");
        try { assertCurrent(); }
        catch (error) {
          const denial = this.denial(error);
          if (!denial) throw error;
          this.change(form, { state: "paused", reason: denial.reason });
          refused = new DispatchPreNativeRefusal(new Error(denial.reason));
          throw refused;
        }
        this.change(form, { state: "unknown", reason: "Native delivery may begin; acceptance is not yet proven" });
        possibleNative = true; // Only after the synchronous durable write succeeds.
      }, true),
      outcome: outcome => guarded(() => { applyEvidence(outcome, true); }, false, withheld(outcome)),
    };
    try {
      const prompt = buildUserQuestionsResponse(form);
      const result = await this.options.dispatch(form, {
        origin: "questionnaire-response", intent, delivery: "idle-only", requestId,
        source: sourceFor(form), prompt, lease, signal: this.shutdown.signal, assertCurrent, evidence,
        link: identity => {
          if (linked) throw new Error("Questionnaire delivery was already linked; replay forbidden");
          assertCurrent();
          this.identity(form, identity, false);
          const gate = this.options.coordinator.inspectReadiness({ conversationId: form.sessionId, intent, phase: "dispatch", lease });
          if (!gate.ready) throw new UserQuestionsDeliveryDeferred({ ready: false, disposition: "wait", reason: gate.reason });
          this.change(form, { state: "claimed", runId: identity.runId, nativeCommandId: identity.nativeCommandId, reason: "Response claimed for idle-only admission" });
          linked = true;
        },
      });
      if (!linked) throw new Error("Questionnaire dispatch returned without its durable final-install link");
      applyEvidence(result, false);
    } catch (error) {
      if (this.failed) throw error;
      if (possibleNative && error instanceof UserQuestionsDeliverySuperseded) { this.fail(error); throw error; }
      if (!possibleNative && (error instanceof UserQuestionsDeliverySuperseded || error === refused && refused?.cause instanceof UserQuestionsDeliverySuperseded)) return;
      const denial = error === refused ? { ready: false, disposition: "pause", reason: error instanceof Error ? error.message : "Delivery withheld" } as const : this.denial(error);
      if (!denial || possibleNative) throw error;
      if (linked) this.change(form, { state: "paused", reason: denial.reason });
      else this.defer(form, denial);
    } finally { this.options.coordinator.releaseAdmission(lease); }
  }
}
