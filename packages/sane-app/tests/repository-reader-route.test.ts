import { expect, test } from "bun:test";
import { DomainError, RepositoryReader } from "sane-core/server";
import { authenticatedWorkstreamRoute, WorkstreamAdapterError } from "../src/workstreams";

const request = () => new Request("http://localhost/api/workstreams");
const authorize = () => null;

test("authenticated route returns transient unavailability for a closed reader", async () => {
  const reader = new RepositoryReader();
  await reader.close();
  const response = await authenticatedWorkstreamRoute(request(), authorize, () => reader.discover(process.cwd()));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code: "UNAVAILABLE", error: "Repository read cancelled or reader closed." });
});

test("authenticated route maps capacity and deadline domain errors to transient failures", async () => {
  for (const error of [
    new DomainError("BUSY", "Repository reader capacity exhausted."),
    new DomainError("UNAVAILABLE", "Repository read deadline exceeded."),
  ]) {
    const response = await authenticatedWorkstreamRoute(request(), authorize, async () => { throw error; });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: error.code, error: error.message });
  }
});

test("authenticated route preserves other domain and adapter statuses", async () => {
  for (const [error, status] of [
    [new DomainError("NOT_FOUND", "missing"), 404],
    [new DomainError("INVALID_INPUT", "invalid"), 400],
    [new DomainError("INVALID_ARTIFACT", "invalid artifact"), 400],
    [new DomainError("STORAGE_ERROR", "storage failure"), 500],
    [new DomainError("CONFLICT", "conflict"), 409],
    [new WorkstreamAdapterError(409, "BUSY", "adapter refusal"), 409],
  ] as const) {
    const response = await authenticatedWorkstreamRoute(request(), authorize, () => { throw error; });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: error.code, error: error.message });
  }
});
