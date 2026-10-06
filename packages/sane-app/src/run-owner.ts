import type { Run } from "./history";

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
};
