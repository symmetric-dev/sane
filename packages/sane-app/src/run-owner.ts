import type { Run } from "./history";

/** Shared execution ownership. The bridge retains the single owner registry;
 * harness services must not release or replace owners independently. */
export type RunOwner = {
  run: Run;
  native?: boolean;
  nativeDispatched?: boolean;
  launchError?: string;
  workerDeliveryId?: string;
  child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  done: Promise<void>;
  settled: boolean;
  stopping?: Promise<boolean>;
  cancel?: Promise<{ interrupted: boolean }>;
  cancelling?: boolean;
  stopRequested?: boolean;
  submission?: Promise<unknown>;
};
