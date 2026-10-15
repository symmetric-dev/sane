import { describe, expect, test } from "bun:test";
import { toHttpError } from "./bridge-errors";
import { DomainError } from "sane-core/server";
import { WorkstreamAdapterError } from "./workstreams";
import { PendingInputDomainError, PendingInputStorageError } from "./pending-input-contract";
import { HarnessOperationError } from "./harness-operations";
import { AppStoreError } from "./app-store";

describe("toHttpError", () => {
  test("maps WorkstreamAdapterError with status+code", () => {
    expect(toHttpError(new WorkstreamAdapterError(409, "recipient-mismatch", "bad"))).toEqual({
      status: 409,
      body: { error: "bad", code: "recipient-mismatch" },
    });
  });
  test("maps DomainError INVALID_INPUT to 400", () => {
    expect(toHttpError(new DomainError("INVALID_INPUT", "bad input")).status).toBe(400);
  });
  test("maps DomainError NOT_FOUND to 404, else 409", () => {
    expect(toHttpError(new DomainError("NOT_FOUND", "missing")).status).toBe(404);
    expect(toHttpError(new DomainError("CONFLICT", "conflict")).status).toBe(409);
  });
  test("maps PendingInputDomainError with its status", () => {
    expect(toHttpError(new PendingInputDomainError("busy", "b", 429))).toEqual({
      status: 429,
      body: { error: "b", code: "busy" },
    });
  });
  test("maps HarnessOperationError", () => {
    expect(toHttpError(new HarnessOperationError("nope", 501, "unsupported-harness-operation"))).toEqual({
      status: 501,
      body: { error: "nope", code: "unsupported-harness-operation" },
    });
  });
  test("maps AppStoreError to 400", () => {
    expect(toHttpError(new AppStoreError("APP_STORE_CORRUPT", "corrupt")).status).toBe(400);
  });
  test("maps PendingInputStorageError to 503", () => {
    expect(toHttpError(new PendingInputStorageError("disk")).status).toBe(503);
  });
  test("falls back to 503 for unknown", () => {
    expect(toHttpError(new Error("boom")).status).toBe(503);
  });
});
