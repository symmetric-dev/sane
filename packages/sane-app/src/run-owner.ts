import type { Run } from "./history";
import type { DispatchSubmission, DispatchNativeAcceptance, DispatchIdentity } from "../shared/conversation/dispatch-contract";
import type { OwnedContextMessages, OwnedSubmissionPublication } from "./context-message-transport";

/** Shared execution ownership. The bridge coordinator retains the single registry;
 * harness services must not release or replace owners independently. */
export type RunOwner = {
  run: Run;
  native?: boolean;
  nativeDispatched?: boolean;
  /** Honest CLI lifecycle evidence; exit alone is not proof of stream drain. */
  streamsDrained?: boolean;
  /** Immutable installed configuration/source gate, invoked after discovery. */
  beforeSend?: () => void;
  /** Independent owner-scoped proof of exact durable metadata representation.
   * Not activation delivery, native acceptance, or permission to replay. */
  assertMetadataCommitted?: () => void;
  /** Immutable bridge-installed shared message selection/evidence capability. */
  contextMessages?: OwnedContextMessages;
  /** Initial run submission only. CC live input receives a distinct per-send
   * capability; it must never replace or reuse this installed capability. */
  submissionPublication?: OwnedSubmissionPublication;
  /** Exact immutable identity shared with the existing dispatch lifecycle. */
  contextIdentity?: DispatchIdentity;
  /** Services explicitly mark the earliest possible native boundary. */
  dispatchEvidence?: {
    beforeNative: () => void;
    outcome: (submission: DispatchSubmission, acceptance?: DispatchNativeAcceptance) => void;
    withheld: () => void;
  };
  nativeDeliveryPolicy?: "idle-only" | "native-queued-handoff";
  /** Explicit bridge-linked ordinary App head, never inferred from context.
   * The bridge supplies durable evidence hooks and the final admission gate. */
  nativeQueuedHandoff?: DispatchIdentity & { readonly origin: "queued-user"; readonly requestId: string; readonly nativeCommandId: string };
  /** Sticky protocol refusal; also journaled for read-only recovery. */
  nativeHandoffProtocolUnsafe?: boolean;
  launchError?: string;
  workerDeliveryId?: string;
  child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  /** Processing and source reconciliation completion, including fail-closed
   * completion. NOT an ownership-release signal: cancellation may still retain
   * this owner. Continuation must freshly check ownership and settlement proof. */
  done: Promise<void>;
  settled: boolean;
  stopping?: Promise<boolean>;
  cancel?: Promise<{ interrupted: boolean }>;
  cancelling?: boolean;
  stopRequested?: boolean;
  submission?: Promise<unknown>;
  /** Ephemeral operator terminalization fence. Never persisted on Run. Failed
   * durability retains ownership even when a lifecycle finalizer executes. */
  completionTerminalization?: { done: Promise<void>; state: "pending" | "committed" | "failed" };
};
