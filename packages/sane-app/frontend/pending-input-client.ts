import { isPendingInputRemovalResult, isPendingInputSubmissionResult, type PendingInputRemovalRequest, type PendingInputRemovalResult, type PendingInputRequest, type PendingInputResumeRequest, type PendingInputSubmissionResult } from "../shared/conversation/pending-input-contract";
import { isPendingInputResumeResult, isPendingInputStatus, isPendingInputView, type PendingInputResumeResult, type PendingInputStatus, type PendingInputView } from "./pending-input-presentation";

/** Preserve correlated 503 bodies and structured claimed-removal 409 results. */
export class PendingInputApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined, readonly body: unknown) { super(message); }
}
/** Only the service's strict pre-commit refusal envelopes are definitive. In
 * particular, a generic 4xx, missing receipt or claimed-removal error is not
 * evidence that an earlier transport-unknown original request never committed. */
export function isDefinitePendingInputRefusal(error: unknown, kind: "enqueue" | "remove" | "resume"): boolean {
  if (!(error instanceof PendingInputApiError) || !error.body || typeof error.body !== "object" || Array.isArray(error.body)) return false;
  const body = error.body as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.error !== "string" || !body.error.trim() || body.code !== error.code) return false;
  const code = error.code;
  if (error.status === 400) return ["invalid-pending-input", "invalid-conversation-id",
    kind === "remove" ? "invalid-pending-input-removal" : kind === "resume" ? "invalid-pending-input-resume" : "invalid-pending-input"].includes(code ?? "");
  if (error.status === 429) return kind === "enqueue" && code === "pending-input-full";
  if (error.status !== 409) return false;
  if (["pending-input-route-conflict", "pending-input-id-conflict", "pending-input-reentrant", "pending-input-recovery", "pending-input-exhausted"].includes(code ?? "")) return true;
  if (kind === "remove") return false; // claimed is a correlated result, not a refusal.
  if (["pending-input-preflight", "pending-input-chain-conflict", "pending-input-hidden", "pending-input-attached-cc", "pending-input-legacy-reservation",
    "pending-input-pin-unavailable", "pending-input-source-unready", "pending-input-dispatch-dormant", "conversation-busy"].includes(code ?? "")) return true;
  return (kind === "enqueue" ? ["pending-input-source-unknown", "pending-input-source-conflict", "pending-input-assertion-conflict",
    "pending-input-domain-changed", "pending-input-admission-changed", "pending-input-source-changed", "pending-input-context-changed"]
    : ["pending-input-stale", "pending-input-claimed", "pending-input-no-chain", "source-changed", "configuration-changed", "context-changed"]).includes(code ?? "");
}
const path = (id: string) => `/api/sessions/${encodeURIComponent(id)}/pending-inputs`;
async function call(url: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
  const value: unknown = await response.json();
  return { response, value };
}
function failure(response: Response, body: unknown): never {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  throw new PendingInputApiError(typeof value.error === "string" ? value.error : `Queue request failed (${response.status}).`, response.status, typeof value.code === "string" ? value.code : undefined, body);
}
export const pendingInputClient = {
  async pendingInputs(id: string, signal?: AbortSignal): Promise<PendingInputView> {
    const { response, value } = await call(path(id), undefined, signal);
    if (!response.ok) failure(response, value);
    if (!isPendingInputView(value, id)) throw new Error("Invalid queue projection. Queue state is stale.");
    return value;
  },
  async enqueuePendingInput(id: string, input: PendingInputRequest): Promise<PendingInputSubmissionResult> {
    const { response, value } = await call(path(id), input);
    if (!response.ok) failure(response, value);
    if (!isPendingInputSubmissionResult(value, input)) throw new Error("Invalid queue acknowledgement; original identity must be reconciled.");
    return value;
  },
  async removePendingInput(id: string, input: PendingInputRemovalRequest): Promise<PendingInputRemovalResult> {
    const { response, value } = await call(`${path(id)}/${encodeURIComponent(input.itemId)}/remove`, input);
    if (isPendingInputRemovalResult(value, input) && (response.ok || response.status === 409 && value.outcome === "claimed")) return value;
    if (!response.ok) failure(response, value);
    throw new Error("Invalid removal acknowledgement; original identity must be reconciled.");
  },
  async resumePendingInputs(id: string, input: PendingInputResumeRequest): Promise<PendingInputResumeResult> {
    const { response, value } = await call(`${path(id)}/resume`, input);
    if (!response.ok) failure(response, value);
    if (!isPendingInputResumeResult(value, input)) throw new Error("Invalid resume acknowledgement; original consent must be reconciled.");
    return value;
  },
  async pendingInputStatus(id: string, requestId: string, signal?: AbortSignal): Promise<PendingInputStatus> {
    const { response, value } = await call(`${path(id)}/inputs/${encodeURIComponent(requestId)}`, undefined, signal);
    if (!response.ok) failure(response, value);
    if (!isPendingInputStatus(value, id, requestId)) throw new Error("Invalid original-input status.");
    return value;
  },
};
