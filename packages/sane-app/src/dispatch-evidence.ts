import type { DispatchEvidenceHooks, DispatchIdentity, DispatchNativeAcceptance, DispatchSubmission, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";

/** TypeScript's void callbacks also accept async functions. Enforce the native
 * no-await boundary at runtime instead of silently launching before durability. */
export function synchronousDispatchHook(action: () => unknown): void {
  const result = action();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Dispatch boundary hooks must complete synchronously");
  }
}

/** One lifecycle's evidence, not an owner registry or a retry policy. */
export function createDispatchEvidence(identity: DispatchIdentity, hooks: DispatchEvidenceHooks, failClosed: (error: unknown) => void) {
  const pinned = Object.freeze({ ...identity, source: Object.freeze({ ...identity.source }) });
  // Withholding and unconfirmed legacy completion both close native admission.
  // Only a successful synchronous intent write enters possible-native; attempted
  // is that boundary's intent, whereas unknown is its unresolved outcome.
  let state: "fresh" | "writing-intent" | "possible-native" | "withheld" | "unconfirmed" = "fresh";
  let finished = false;
  let value: DispatchSubmissionEvidence = Object.freeze({ ...pinned, submission: "not-submitted", nativeAcceptance: "not-accepted" });
  const outcome = (submission: DispatchSubmission, nativeAcceptance: DispatchNativeAcceptance = "unknown") => {
    if (state === "writing-intent" || submission === "attempted") throw new Error("Only beforeNative can record native attempt intent");
    if (state === "unconfirmed" && (submission !== "unknown" || nativeAcceptance !== "unknown")) throw new Error("Unconfirmed completion cannot establish native evidence");
    if (state === "possible-native" ? submission === "not-submitted" : submission !== "not-submitted" && !(state === "unconfirmed" && submission === "unknown")) throw new Error("Submission evidence contradicts native boundary");
    if (submission === "not-submitted" && nativeAcceptance !== "not-accepted") throw new Error("Non-submission requires non-acceptance evidence");
    const mergedSubmission = value.submission === "submitted" ? "submitted" : submission;
    // Unknown is weaker than either exact acceptance fact. Contradictory exact
    // facts are refused before mutation or hooks, not resolved by last-write-wins.
    const knownAcceptance = state === "possible-native" && value.nativeAcceptance !== "unknown";
    if (knownAcceptance && nativeAcceptance !== "unknown" && nativeAcceptance !== value.nativeAcceptance) throw new Error("Native acceptance evidence contradicts established proof");
    const mergedAcceptance = knownAcceptance && nativeAcceptance === "unknown" ? value.nativeAcceptance : nativeAcceptance;
    if (mergedAcceptance === "accepted" && mergedSubmission !== "submitted") throw new Error("Native acceptance requires submitted evidence");
    // A wholly weaker transport update need not rewrite unchanged evidence, but
    // independently stronger acceptance evidence must still reach the hook.
    if (submission === "unknown" && value.submission === "submitted" && mergedAcceptance === value.nativeAcceptance) return;
    if (submission === "not-submitted") state = "withheld";
    value = Object.freeze({ ...pinned, submission: mergedSubmission, nativeAcceptance: mergedAcceptance });
    try { synchronousDispatchHook(() => hooks.outcome?.(value)); } catch (error) { failClosed(error); throw error; }
  };
  return {
    snapshot: () => value,
    beforeNative: () => {
      if (state !== "fresh" || finished) throw new Error("Native boundary closed; replay forbidden");
      state = "writing-intent";
      const attempt: DispatchSubmissionEvidence = Object.freeze({ ...pinned, submission: "attempted", nativeAcceptance: "unknown" });
      // A refused durable intent is still definite non-submission. Do not set
      // possible-native until the caller's synchronous write succeeds.
      try { synchronousDispatchHook(() => hooks.beforeNative?.(attempt)); } catch (error) { state = "withheld"; failClosed(error); throw error; }
      state = "possible-native"; value = attempt;
    },
    outcome,
    withheld: () => {
      if (state !== "fresh" && state !== "withheld") throw new Error("Cannot prove non-submission after native boundary or unconfirmed completion");
      state = "withheld";
    },
    finish: () => {
      if (state === "writing-intent") throw new Error("Cannot finish during native intent write");
      if (finished) return;
      finished = true;
      if (state === "withheld") outcome("not-submitted", "not-accepted");
      else if (state === "fresh") {
        // A legacy/injected adapter that never supplied boundary evidence is
        // unconfirmed, not proof of non-submission (regardless of ready(false)).
        state = "unconfirmed";
        outcome("unknown");
      }
      else if (value.submission === "attempted") outcome("unknown");
    },
  };
}
