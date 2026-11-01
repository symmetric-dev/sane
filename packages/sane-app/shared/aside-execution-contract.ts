import { parseAsideDraftRequest, type AsideDraftRequest, type AsideExecutionAvailability, type AsideSourceSnapshot } from "./aside-contract";
import type { DispatchIdentity, DispatchSource, DispatchSubmissionEvidence } from "./conversation/dispatch-contract";
import type { DiagnosticEvent, Harness, RunStatus } from "./conversation/types";

export type AsideContextStrategy = "native-fork" | "reference-session";

/** Immutable App observation identity, NOT native-prefix or context-delivery
 * proof. No transcript text, instruction content, or execution authority. A
 * provider must resolve this exact captured boundary, never today's source. */
export type AsideSourceBoundaryReference = Readonly<Pick<AsideSourceSnapshot, "storeId" | "sessionId" | "rootSessionId" | "capturedAt">> & Readonly<{
  native: Readonly<AsideSourceSnapshot["native"]>;
  binding: Readonly<AsideSourceSnapshot["binding"]>;
  transcript: Readonly<Pick<AsideSourceSnapshot["transcript"], "kind" | "epoch" | "revision" | "totalMessages" | "boundaryMessageId" | "fingerprint">>;
}>;

// Deliberately no public constructors/parsers or executable handles. Only a
// future server-owned materializer can qualify these references. JSON supplied
// by a client (including an App snapshot) is not a qualified native identity or
// proof. The brands are type boundaries, not substitutes for runtime gates.
declare const independentSession: unique symbol;
declare const nativeForkEvidence: unique symbol;
declare const referenceSessionEvidence: unique symbol;
export type AsideIndependentSessionReference = Readonly<DispatchSource & {
  harnessId: Harness;
  authorityId: string;
  nativeSessionId: string;
  readonly [independentSession]: true;
}>;
export type AsideNativeForkEvidenceReference = Readonly<{
  kind: "native-fork-evidence";
  referenceId: string;
  readonly [nativeForkEvidence]: true;
}>;
export type AsideReferenceSessionEvidenceReference = Readonly<{
  kind: "reference-session-evidence";
  referenceId: string;
  readonly [referenceSessionEvidence]: true;
}>;

export type AsideContextPrepareRequest = Readonly<{
  asideId: string;
  expectedRevision: number;
  source: AsideSourceBoundaryReference;
}>;
type PreparedBinding = AsideContextPrepareRequest & Readonly<{
  /** Independently materialized App/native conversation, NEVER the source
   * session as destination. Qualification must bind both identities, authority,
   * checkout, and the exact source boundary to the evidence reference. */
  session: AsideIndependentSessionReference;
}>;
export type AsideContextPrepareResult = Readonly<{
  state: "unavailable";
  code: "aside-context-unconfigured" | "aside-context-unavailable";
}> | (PreparedBinding & Readonly<{ state: "ready" }> & (
  Readonly<{ strategy: "native-fork"; evidence: AsideNativeForkEvidenceReference }>
  | Readonly<{ strategy: "reference-session"; evidence: AsideReferenceSessionEvidenceReference }>
));

/** CONTRACT ONLY: no provider is implemented or registered in this slice.
 * `ready` qualifies materialization only, NOT execution/admission/acceptance.
 * Future integration must revalidate ownership/revision and existing context,
 * binding, permission and dispatch admission gates before any native I/O. A
 * reference-session must prove its reference delivery, not assert fork lineage;
 * an App transcript fingerprint alone cannot prove a native fork prefix. */
export interface AsideContextProvider {
  readonly strategy: AsideContextStrategy;
  prepare(request: AsideContextPrepareRequest): Promise<AsideContextPrepareResult>;
}

export type AsideExecutionReadiness = Readonly<AsideExecutionAvailability>
  | Readonly<{ available: false; code: "aside-archived" | "aside-discarded" }>;
export type AsideExecutionReadResponse = Readonly<{ execution: AsideExecutionReadiness }>;
export type AsideMessageRequest = AsideDraftRequest;

export function parseAsideMessageRequest(value: unknown): AsideMessageRequest {
  const request = parseAsideDraftRequest(value);
  if (!request.text.trim()) throw new Error("Aside message text must not be empty");
  return request;
}

/** Future observations reuse real dispatch/run evidence, never a second aside
 * acceptance state machine. No such observations are produced in this slice.
 * Followups, cancellation, streaming and recovery remain blocked until a
 * materialization provider AND existing dispatch/run integration are present. */
export type AsideExecutionRunEvidence = Readonly<{
  asideId: string;
  dispatch: DispatchSubmissionEvidence;
  status: RunStatus;
}>;
export type AsideExecutionStreamObservation = Readonly<{
  asideId: string;
  identity: DispatchIdentity;
  event: Readonly<DiagnosticEvent>;
}>;
