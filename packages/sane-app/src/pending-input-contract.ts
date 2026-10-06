import type { Admission } from "./app-store";
import type { Conversation, PhaseAssignment, Workstream } from "sane-core/contracts";
import type { PreparedUserInput } from "./user-input-preparation";
import type { DispatchIdentity, DispatchSource, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import type { PendingInputEnqueueReceipt, PendingInputRemovalRequest, PendingInputRemovalResult, PendingInputRequest, PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";

/** Internal durable DTOs, NOT the wire read projection or native handles. The
 * context is a projection of core membership/assignment identities, not mutable
 * workstream titles, lifecycle progress, files or global worker-profile mappings. */
export type PendingInputPins = {
  admission: Admission;
  catalog: { workspaceId: string; worktreeId: string; bindingRevision: string; cwd: string };
  configuration: PreparedUserInput["configuration"];
  launch: PreparedUserInput["configuration"];
  context: null | {
    conversation: Conversation;
    /** Additive dormant v1 pin. Old records without this proof remain retained;
     * live resume/enqueue refuses a mismatched chain, never synthesizes identity. */
    membership?: { id: string; conversationId: string; workstreamId: string; startedAt: string; endedAt: null } | null;
    workstream: Pick<Workstream, "id" | "repositoryId" | "defaultCheckout"> | null;
    primaryCheckout: string; artifactsRoot: string | null; assignments: PhaseAssignment[];
  };
};
export type PendingInputLaunchSnapshot = { prepared: PreparedUserInput; pins: PendingInputPins };
export type PendingInputPauseCode = "stopped" | "failed" | "hidden" | "restart" | "source-changed" | "configuration-changed" | "context-changed" | "admission-unavailable" | "acceptance-unknown" | "reconciliation-required";
export type PendingInputPause = { code: PendingInputPauseCode; reason: string };
/** Supplied by a live coordinator/source validator. Merely serializing this DTO
 * (or reading run.status) is NOT authorization: mutations call validateLive. */
export type PendingInputAuthorization = {
  kind: "dispatch" | "settlement"; authorizationId: string; chainId: string;
  predecessorRunId: string | null; source: DispatchSource;
};
export type PendingInputClaim = {
  attemptId: string; expectedRevision: number; identity: DispatchIdentity;
  authorization: PendingInputAuthorization;
  possibleNative: boolean; uncertain: boolean; evidence: DispatchSubmissionEvidence | null;
};
export type PendingInputHistory = { kind: "settled"; status: "completed" | "failed" | "interrupted"; authorization: PendingInputAuthorization } | { kind: "not-submitted"; proof: DispatchIdentity };
export type PendingInputStoredItem = {
  itemId: string; requestId: string; sequence: number; chainId: string;
  fingerprint: string; request: PendingInputRequest; snapshot: PendingInputLaunchSnapshot;
  receipt: PendingInputEnqueueReceipt;
  state: "waiting" | "claimed" | "run-linked" | "removed" | "settled";
  claim: PendingInputClaim | null; history: PendingInputHistory | null;
};
export type PendingInputResumeResult = PendingInputResumeRequest & { outcome: "resumed"; revision: number };
export type PendingInputOperation =
  | { kind: "remove"; fingerprint: string; request: PendingInputRemovalRequest; result: PendingInputRemovalResult }
  | { kind: "resume"; fingerprint: string; request: PendingInputResumeRequest; result: PendingInputResumeResult };
export type PendingInputConversation = {
  conversationId: string; revision: number;
  chain: { chainId: string; pins: PendingInputPins } | null;
  pause: PendingInputPause | null;
  lastAuthorization: PendingInputAuthorization | null;
  lastPredecessorRunId: string | null;
  items: PendingInputStoredItem[]; operations: PendingInputOperation[];
};
export type PendingInputRecords = { version: 1; storeId: string; nextSequence: number; conversations: PendingInputConversation[] };
export type PendingInputEnqueue = { request: PendingInputRequest; snapshot: PendingInputLaunchSnapshot };
export type PendingInputClaimRequest = {
  conversationId: string; itemId: string; inputRequestId: string; expectedRevision: number;
  attemptId: string; runId: string; nativeCommandId: string | null; authorization: PendingInputAuthorization;
};
export type PendingInputValidationStage = "enqueue" | "resume" | "claim" | "active-claim" | "link" | "before-native" | "outcome" | "settlement" | "not-submitted";
export type PendingInputLiveValidation = {
  stage: PendingInputValidationStage; snapshot: PendingInputLaunchSnapshot;
  chainId: string; revision: number; identity?: DispatchIdentity; authorization?: PendingInputAuthorization;
};
export class PendingInputDomainError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 429 | 503 = 409) { super(message); }
}
/** Every caller must invoke its App failClosed path, including constructor/read
 * validation failures. A post-rename fsync failure can leave the new record on
 * disk while memory still shows the old record. Neither view authorizes blind
 * retry: retain ownership and reload/reconcile under the App lock. */
export class PendingInputStorageError extends Error {
  readonly code = "pending-input-storage";
  constructor(message: string, readonly cause?: unknown) { super(message); }
}
export class PendingInputCodecError extends Error {
  readonly code = "pending-input-invalid-record";
}
