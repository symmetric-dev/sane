import type { DispatchIdentity, DispatchNativeAcceptance, DispatchSubmission } from "../shared/conversation/dispatch-contract";
import type { ContextMessage } from "./context-message";
import type { ContextMessageBoundary, ContextMessageSubmission } from "./context-message-evidence";

/** Bridge-owned selection, adapter-owned actual bytes. Neither this capability
 * nor a bound submission is an execution lease or an activation ledger. */
export type ActualContextSubmission = Readonly<{ identity: DispatchIdentity; messageId: string; text: string }>;
export type OwnedContextMessageRequest = Readonly<{
  messageId: string;
  body: string;
  boundary: ContextMessageBoundary;
  liveInput?: boolean;
  queuedFollowupId?: string;
}>;
export type PreparedOwnedContextMessage = Readonly<{
  message: ContextMessage;
  assertCurrent: () => Promise<void>;
  /** Capture from the actual immutable encoded native payload, never by
   * returning message.transport.text from the supplied candidate. */
  bindActual: (readActual: () => ActualContextSubmission) => ContextMessageSubmission;
  /** CC live input only; never re-enters the initial dispatch evidence object. */
  beforeMessageNative: () => void;
  messageOutcome: (submission: DispatchSubmission, acceptance?: DispatchNativeAcceptance) => void;
}>;
export type OwnedContextMessages = Readonly<{
  prepare: (request: OwnedContextMessageRequest, assertCurrent: () => void) => Promise<PreparedOwnedContextMessage>;
}>;

/** Bridge-owned historical installation publication, not native intent or
 * execution authority. The coordinator supplies the ACTUAL bound, immutable
 * submission after its standard journal and metadata publication complete.
 * Callbacks must not mutate that DTO or substitute a prepared candidate. */
export type OwnedSubmissionPublication = Readonly<{
  /** Use the existing serialized publication queue. Independently prove the
   * exact durable standard journal and committed metadata before publishing.
   * No native IO, ownership changes, retries, or transport outcome publication. */
  publish: (submission: ContextMessageSubmission) => Promise<void>;
  /** Synchronous, read-only exact publication proof at the native boundary.
   * Never creates/adopts an admission or grants permission to replay. */
  assertCurrent: (submission: ContextMessageSubmission) => void;
}>;
