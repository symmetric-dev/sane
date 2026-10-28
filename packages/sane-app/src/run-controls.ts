import type { DispatchSource } from "../shared/conversation/dispatch-contract";
import { HarnessOperationError } from "./harness-operations";
import type { RunOwner } from "./run-owner";
import type { RunPreparationTimings } from "./submission-timing-archive";

export type RunControlOperations = Readonly<{
  cancellation: "retain-result" | "in-flight";
  interrupt: (mode: "worker" | "user") => Promise<{ interrupted: boolean }>;
  cleanup: () => Promise<boolean>;
  shutdown: () => Promise<{ drained: boolean; reconciliationRequired: boolean }>;
  readPreparationTiming?: () => RunPreparationTimings | undefined;
}>;

export type OwnedRunControls = RunControlOperations & Readonly<{
  source: DispatchSource;
  assertOwner: (owner: RunOwner) => void;
  /** Launch/native mutation identity, not a prerequisite for local teardown. */
  assertIdentity: (owner: RunOwner) => void;
}>;

function mismatch(): never {
  throw new HarnessOperationError("Run controls do not match their original owner and source", 409, "owner-harness-mismatch");
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

/** Capture resources once at admission. Teardown must not rediscover a session
 * or reread current configuration: it still owns the original resources after drift. */
export function bindRunControls(owner: RunOwner, source: DispatchSource, operations: RunControlOperations): OwnedRunControls {
  if ("controls" in owner || !source || ![source.harnessId, source.sessionId, source.authorityId, source.nativeSessionId, source.cwd].every(nonempty)) mismatch();
  const run = owner.run, done = owner.done;
  if (!run || !nonempty(run.runId) || run.sessionId !== source.sessionId || run.cwd !== source.cwd
    || (run.nativeCommandId !== undefined && !nonempty(run.nativeCommandId))) mismatch();
  const pinnedSource = Object.freeze({ harnessId: source.harnessId, sessionId: source.sessionId,
    authorityId: source.authorityId, nativeSessionId: source.nativeSessionId, cwd: source.cwd });
  const { runId, sessionId, cwd, nativeCommandId } = run;
  const { cancellation, interrupt, cleanup, shutdown, readPreparationTiming } = operations;
  const assertOwner = (candidate: RunOwner): void => {
    if (candidate !== owner || owner.controls !== controls) mismatch();
  };
  const assertIdentity = (candidate: RunOwner): void => {
    assertOwner(candidate);
    if (owner.run !== run || owner.done !== done || run.runId !== runId || run.sessionId !== sessionId
      || run.cwd !== cwd || run.nativeCommandId !== nativeCommandId) mismatch();
  };
  const controls: OwnedRunControls = Object.freeze({
    source: pinnedSource, cancellation, assertOwner, assertIdentity,
    // The adapter owns interruption's protocol-specific mutation boundary.
    interrupt,
    // Fail-closed teardown must still reach the original resources when identity
    // drift itself caused the failure. These closures never rediscover an owner.
    cleanup,
    shutdown,
    ...(readPreparationTiming ? { readPreparationTiming } : {}),
  });
  Object.defineProperty(owner, "controls", { value: controls, writable: false, configurable: false, enumerable: true });
  return controls;
}

export function requireRunControls(owner: RunOwner): OwnedRunControls {
  const controls = owner.controls;
  if (!controls) mismatch();
  controls.assertOwner(owner);
  return controls;
}

export type RunCancellationHooks = {
  emitStopping: () => Promise<void>;
  isCurrent: () => boolean;
  release: (owner: RunOwner) => void;
};

/** Coalesce per-owner attempts, never source lookups or the legacy native marker.
 * A remote acknowledgement is not terminal evidence; later explicit Stop may retry. */
export function requestRunCancellation(owner: RunOwner, mode: "worker" | "user", hooks: RunCancellationHooks): Promise<{ interrupted: boolean }> {
  const controls = requireRunControls(owner);
  if (owner.cancel) return owner.cancel;
  owner.cancelling = true;
  owner.stopRequested = true;
  const attempt = (async () => {
    if (owner.run.status !== "running") return { interrupted: false };
    await hooks.emitStopping();
    if (mode === "user" && (!hooks.isCurrent() || owner.run.status !== "running")) return { interrupted: false };
    return controls.interrupt(mode);
  })().finally(() => {
    if (controls.cancellation === "in-flight" && owner.cancel === attempt) owner.cancel = undefined;
    owner.cancelling = false;
    hooks.release(owner);
  }).catch(error => {
    if (owner.cancel === attempt) owner.cancel = undefined;
    throw error;
  });
  owner.cancel = attempt;
  return attempt;
}
