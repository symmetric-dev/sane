import type { ConversationOperationIntent, ConversationAdmissionLease } from "./conversation-coordinator";
import type { DispatchOrigin, DispatchIdentity, DispatchEvidenceHooks } from "../shared/conversation/dispatch-contract";
import type { DispatchLifecycle } from "./harness-dispatch";
import type { PreparedUserInput } from "./user-input-preparation";

/** Bridge-owned injection point for a future durable consumer. No queue storage,
 * owner registry, HTTP receipt or automatic retry lives in this contract. */
export type PreparedAdmissionContext = Readonly<{
  intent: ConversationOperationIntent;
  origin: DispatchOrigin;
  runId: string;
  nativeCommandId?: string;
  /** Explicit policy, never inferred from context presence. Native handoff is
   * OpenCode queued-user only; its strict requirements are specified below. */
  delivery: "idle-only" | "native-queued-handoff";
  /** Synchronous live claim validation: before configuration mutation, inside
   * final install, and immediately before the native boundary after discovery.
   * UserInputPreparationError/WorkstreamAdapterError are domain refusals; other
   * exceptions are storage/invariant failures and retain App ownership. */
  validate?: (identity: DispatchIdentity) => void;
  /** Synchronous durable claim/run link in final install, BEFORE owner publication.
   * Throw to withhold launch. The consumer owns partial durable-write recovery. */
  link?: (identity: DispatchIdentity) => void;
  evidence?: DispatchEvidenceHooks;
}>;
/** Strict construction type for the future bridge adapter. Keep the base shape
 * compatible with existing idle-only callers composing Partial context values. */
export type NativeQueuedHandoffAdmissionContext = PreparedAdmissionContext & Readonly<{
  /** OpenCode only. Fresh idle BEFORE durable claim, then persist queue delivery
   * before owner publication. Foreign busy after claim is not a refusal. */
  delivery: "native-queued-handoff";
  origin: "queued-user";
  intent: { readonly kind: "user-prompt"; readonly requestId: string };
  nativeCommandId: string;
  validate: (identity: DispatchIdentity) => void;
  link: (identity: DispatchIdentity) => void;
  evidence: DispatchEvidenceHooks & Required<Pick<DispatchEvidenceHooks, "beforeNative" | "outcome">>;
}>;
export type PreparedAdmissionOptions = {
  queuedFollowupId?: string;
  context?: PreparedAdmissionContext;
  /** Captured before preflight; called exactly once synchronously after lifecycle
   * construction, before deferred execution or the admission promise returns.
   * Throwing/returning a Promise withholds execution and retains App ownership. */
  publish?: (lifecycle: DispatchLifecycle) => void;
};
export type PreparedAdmissionResult = {
  sessionId: string; runId: string; harness: string; nativeSessionId?: string;
  lifecycle: DispatchLifecycle;
};
export type PreparedInputAdmission = {
  reserve: (intent: ConversationOperationIntent, conversationId: string) => ConversationAdmissionLease;
  release: (lease: ConversationAdmissionLease) => boolean;
  admit: (prepared: PreparedUserInput, lease: ConversationAdmissionLease, options?: PreparedAdmissionOptions) => Promise<PreparedAdmissionResult>;
};
