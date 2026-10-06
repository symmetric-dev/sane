/** Dispatch IDs are extensible internally. This does not widen the production
 * Harness wire validator or advertise support for a newly registered harness. */
export type DispatchHarnessId = string;
/** Immediate user submission is distinct from an automatic queued-user drain.
 * This internal distinction does not advertise a production queue capability. */
export type DispatchOrigin = "user" | "queued-user" | "worker-report" | "handoff";
export type AutomationDispatchOrigin = Exclude<DispatchOrigin, "user">;
export type DispatchSupport = { readonly supported: true } | { readonly supported: false; readonly reason: string };

/** Pin the App conversation and the exact native authority/identity/checkout.
 * Null means identity is not yet known, never a default authority or session. */
export type DispatchSource = {
  readonly harnessId: DispatchHarnessId;
  readonly sessionId: string;
  readonly authorityId: string | null;
  readonly nativeSessionId: string | null;
  readonly cwd: string;
};

export type DispatchReadiness = { readonly ready: true } | { readonly ready: false; readonly reason: string; readonly code?: string };
export type PinnedDispatchReadiness = { readonly source: DispatchSource; readonly readiness: DispatchReadiness };
export type HarnessDispatchRequest = {
  readonly requestId?: string;
  readonly source: DispatchSource;
  readonly origin: DispatchOrigin;
  readonly prompt: string;
  readonly resume: boolean;
};

/** The legacy execute ready callback reports App launch admission only. Even
 * false is not proof of non-submission: a transport may have attempted delivery.
 * Neither result proves native acceptance, delivery success, or task completion. */
export type DispatchAdmission = { readonly state: "admitted" } | { readonly state: "unconfirmed" };
export type DispatchSubmission = "not-submitted" | "attempted" | "submitted" | "unknown";
export type DispatchNativeAcceptance = "not-accepted" | "accepted" | "unknown";

/** Correlated evidence, never inferred from App admission, HTTP failure, or done.
 * attempted includes possible native execution (CC spawn), not prompt delivery.
 * submitted proves transport delivery only; acceptance needs exact native ID proof. */
export type DispatchIdentity = Readonly<{ source: DispatchSource; runId: string; nativeCommandId: string | null; requestId?: string }>;
export type DispatchSubmissionEvidence = DispatchIdentity & Readonly<{
  submission: DispatchSubmission;
  nativeAcceptance: DispatchNativeAcceptance;
}>;
export type DispatchEvidenceHooks = {
  /** Synchronous durable intent write immediately BEFORE possible native execution.
   * Throw to withhold delivery. No native I/O or asynchronous writes here. */
  beforeNative?: (attempt: DispatchSubmissionEvidence) => void;
  /** Synchronous evidence write. Failure after possible submission fails closed;
   * never automatically retries, even when HTTP returned an error. */
  outcome?: (evidence: DispatchSubmissionEvidence) => void;
};

/** Read live, including after native I/O. Safe automatic wake requires BOTH
 * reconciliation completion (enforced by lifecycle ordering) and owner release. */
export type DispatchTerminalGuards = {
  readonly settled: boolean;
  readonly released: boolean;
  readonly status: string;
  readonly cancelling: boolean;
  readonly stopRequested: boolean;
  readonly stopping: boolean;
  readonly closing: boolean;
  readonly storageFailed: boolean;
  readonly reconciliationRequired: boolean;
};
