import { DomainError } from "sane-core/server";
import { WorkstreamAdapterError } from "./workstreams";
import { PendingInputDomainError, PendingInputStorageError } from "./pending-input-contract";
import { HarnessOperationError } from "./harness-operations";
import { AppStoreError } from "./app-store";
import { json } from "./bridge-http";

export type HttpError = { status: number; body: { error: string; code?: string } };

/** Single error taxonomy. Every route maps through here instead of inline instanceof chains. */
export function toHttpError(error: unknown, fallback = "Operation unavailable"): HttpError {
  if (error instanceof WorkstreamAdapterError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof DomainError) {
    const status = error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : 409;
    return { status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof PendingInputDomainError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof HarnessOperationError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof AppStoreError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  if (error instanceof PendingInputStorageError) {
    return { status: 503, body: { error: error.message, code: error.code } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 503, body: { error: message || fallback } };
}

export function httpErrorResponse(error: unknown, fallback?: string): Response {
  const mapped = toHttpError(error, fallback);
  return json(mapped.body, mapped.status);
}
