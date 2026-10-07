import type { DispatchEvidenceHooks, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { DispatchPreNativeRefusal, synchronousDispatchHook } from "./dispatch-evidence";
import { PendingInputDomainError, PendingInputStorageError } from "./pending-input-contract";
import type { PendingInputStore } from "./pending-input-store";
import { equal } from "./prepared-input-codec";
import type { RunOwner } from "./run-owner";
import { WorkstreamAdapterError } from "./workstreams";

/** Explicit controls only: no dispatch, wake, resume or owner registry. */
export function createPendingInputControls(deps: {
  store: () => PendingInputStore | undefined;
  owner: (sessionId: string) => RunOwner | undefined;
  available: () => boolean;
  failClosed: () => void;
}) {
  function available() {
    if (!deps.available()) throw new PendingInputDomainError("pending-input-owner-unavailable", "App storage ownership is unavailable", 503);
  }
  function storage<T>(action: () => T): T {
    try { return action(); }
    catch (error) { if (error instanceof PendingInputStorageError) deps.failClosed(); throw error; }
  }
  function pause(sessionId: string, code: "stopped" | "hidden") {
    available();
    storage(() => {
      const store = deps.store(), view = store?.inspect(sessionId);
      if (!store || !view?.chain || view.pause && (code === "hidden" || view.pause.code !== "hidden")) return;
      store.pause(sessionId, { code, reason: code === "stopped" ? "Explicit Stop; waiting input preserved until explicit resume" : "Conversation hidden; waiting input preserved until explicit resume" });
    });
  }
  return {
    stop(sessionId: string) {
      available();
      const owner = deps.owner(sessionId);
      // Sticky safety flags precede every durable write and survive its failure.
      if (owner) { owner.stopRequested = true; owner.cancelling = true; }
      pause(sessionId, "stopped");
      return owner; // Cancellation must use this exact owner, never a replacement.
    },
    hide: (sessionId: string) => pause(sessionId, "hidden"),
    cancellationWrite<T>(action: () => T): T {
      available();
      // WorkerStore's atomic writer throws raw errors. Only cancellation writes
      // enter this scope; read/native availability refusals must not poison it.
      try {
        let result!: T;
        synchronousDispatchHook(() => result = action());
        return result;
      }
      catch (error) { deps.failClosed(); throw error instanceof PendingInputStorageError ? error : new PendingInputStorageError("Cancellation suppression storage failed", error); }
    },
    evidence(hooks: DispatchEvidenceHooks | undefined): DispatchEvidenceHooks | undefined {
      if (!hooks) return hooks;
      return { ...hooks, beforeNative: (evidence: DispatchSubmissionEvidence) => {
        storage(() => {
          available();
          const { submission: _submission, nativeAcceptance: _acceptance, ...identity } = evidence;
          const store = deps.store(), claim = evidence.requestId && store?.lookup(evidence.source.sessionId, evidence.requestId)?.item.claim;
          const pause = claim && store!.inspect(evidence.source.sessionId).pause;
          // Certify only an original unattempted claim with an already-durable
          // explicit control pause. Arbitrary coded errors remain uncertified.
          if (claim && !claim.possibleNative && equal(claim.identity, identity) && pause && ["hidden", "stopped"].includes(pause.code)) {
            throw new DispatchPreNativeRefusal(new WorkstreamAdapterError(409, "pending-input-paused", pause.reason));
          }
          synchronousDispatchHook(() => hooks.beforeNative?.(evidence));
        });
      } };
    },
  };
}
