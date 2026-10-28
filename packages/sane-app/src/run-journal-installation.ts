import { lstatSync } from "node:fs";
import { join } from "node:path";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { Event, Run } from "./history";
import type { PendingActivationPreparation } from "./pending-activation-journal";

/** Called inside the existing storage queue. An expired admission before any
 * write is an ordinary refusal, not a failed storage operation. Once preparation
 * starts, its errors must propagate to the queue's existing fail-closed latch. */
export function prepareActivationWhileAdmitted<T>(assertAdmission: () => void, prepare: () => T, isRefusal: (error: unknown) => boolean): { prepared: T } | { refused: unknown } {
  try { synchronousDispatchHook(assertAdmission); }
  catch (error) { if (!isRefusal(error)) throw error; return { refused: error }; }
  return { prepared: prepare() };
}

/** Final synchronous bridge installation check, not execution authorization.
 * Never infer fresh history from a missing in-memory list, or manufacture a new
 * event list over an existing file. Adoption preserves original event objects;
 * decoded restart history remains historical, not live submission capability. */
export function prepareRunJournalInstallation(input: Readonly<{
  directory: string;
  run: Run;
  runs: readonly Run[];
  hasEvents: (runId: string) => boolean;
  isDeferred: (runId: string) => boolean;
  hasPendingActivation: (sessionId: string) => boolean;
  claimNew: (run: Run) => void;
  preparation?: PendingActivationPreparation;
  assertPreparation?: () => void;
}>): Event[] {
  const { run, preparation } = input;
  if (input.hasEvents(run.runId) || input.isDeferred(run.runId) || input.runs.some(row => row.runId === run.runId)) throw new Error("Run journal is already installed");
  if (preparation) {
    if (!input.assertPreparation) throw new Error("Activation journal requires its original admission guard");
    synchronousDispatchHook(input.assertPreparation);
    if (preparation.runId !== run.runId || preparation.nativeCommandId !== (run.nativeCommandId ?? null)
      || input.runs.some(row => row.sessionId === run.sessionId)) throw new Error("Activation journal differs from its original first dispatch identity");
    return [...preparation.events];
  }
  if (!input.runs.some(row => row.sessionId === run.sessionId) && input.hasPendingActivation(run.sessionId)) throw new Error("First dispatch requires its original pending activation journal");
  // lstat also detects an empty file or dangling symbolic link. Neither absence
  // from the cache nor absence of messages establishes a new namespace.
  try { lstatSync(join(input.directory, `${run.runId}.jsonl`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    synchronousDispatchHook(() => input.claimNew(run));
    return [];
  }
  throw new Error("Fresh dispatch has an unexpected original journal; reconcile instead of replacing it");
}
