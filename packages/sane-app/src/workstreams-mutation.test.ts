import { expect, test } from "bun:test";
import { DomainError, type RepositoryDomain } from "sane-core/server";
import type { RepositoryDiscovery } from "sane-core/contracts";
import type { SourceRecords } from "./app-store";
import type { CatalogService } from "./catalog";
import { authenticatedWorkstreamRoute, RepositoryRouter, WorkstreamAdapter, WorkstreamAdapterError, type WorkstreamMutationHooks } from "./workstreams";

const input = { id: "mutation-fault", title: "Mutation fault", type: "feature" as const };
const sources = {} as SourceRecords;
function initialization(hooks: WorkstreamMutationHooks) {
  const router = new RepositoryRouter({} as CatalogService, sources, hooks);
  // Stop before the real initializer: these cases exercise unsafe hook results,
  // not filesystem discovery or domain provisioning.
  Object.assign(router, { discovery: async () => ({} as RepositoryDiscovery) });
  return () => router.initialize("workspace");
}
async function caught(action: () => unknown): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  throw new Error("Expected mutation failure");
}

test("Phase5d2 mutation faults fence before reservation cleanup and preserve scoped refusals", async () => {
  for (const committed of [false, true]) {
    const fault = new Error(committed ? "raw lock release after commit" : "raw lock publication before commit");
    const calls: string[] = [];
    const domain = {
      createWorkstream() { if (committed) calls.push("commit"); throw fault; },
      async providePhase() { await Promise.resolve(); if (committed) calls.push("commit"); throw fault; },
    } as unknown as RepositoryDomain;
    const hooks = {
      beforeLifecycle: () => { calls.push("reserve"); return () => calls.push("release"); },
      mutationFailed: (error: unknown) => { expect(error).toBe(fault); calls.push("fatal"); },
    };
    const adapter = new WorkstreamAdapter(domain, sources, hooks);
    const error = await caught(() => adapter.create(input));
    expect(error).toBeInstanceOf(WorkstreamAdapterError);
    expect(error).toMatchObject({ status: 503, code: "storage-unavailable", cause: fault });
    expect(calls).toEqual(committed ? ["commit", "fatal"] : ["fatal"]);
    calls.length = 0;
    const response = await authenticatedWorkstreamRoute(new Request("http://localhost/api/workstreams/provide"), () => null, () => adapter.provide(input.id, "design"));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("storage-unavailable");
    expect(calls).toEqual(committed ? ["reserve", "commit", "fatal", "release"] : ["reserve", "fatal", "release"]);
  }
  for (const fault of [null, "raw primitive", { failure: "raw object" }, new DomainError("STORAGE_ERROR", "write"), new DomainError("CORRUPT_STORE", "invariant"), new DomainError("UNSUPPORTED_SCHEMA", "schema"), new DomainError("INCOMPLETE_INITIALIZATION", "partial")]) {
    const failures: unknown[] = [];
    const adapter = new WorkstreamAdapter({ createWorkstream() { throw fault; } } as unknown as RepositoryDomain, sources, { mutationFailed: error => { failures.push(error); } });
    const error = await caught(() => adapter.create(input));
    expect(error).toMatchObject({ status: 503, code: "storage-unavailable" });
    expect((error as Error).cause).toBe(fault);
    expect(failures).toEqual([fault]);
  }
  for (const code of ["INVALID_INPUT", "NOT_FOUND", "CONFLICT", "BUSY", "SOURCE_UNAVAILABLE"] as const) {
    const fault = new DomainError(code, "scoped refusal"), calls: string[] = [];
    const adapter = new WorkstreamAdapter({ async providePhase() { throw fault; } } as unknown as RepositoryDomain, sources, {
      beforeLifecycle: () => () => { calls.push("release"); }, mutationFailed: () => { calls.push("fatal"); },
    });
    expect(await caught(() => adapter.provide(input.id, "design"))).toBe(fault);
    expect(calls).toEqual(["release"]);
  }
  const proof = new Error("read-only target proof"), failures: unknown[] = [];
  const adapter = new WorkstreamAdapter({} as RepositoryDomain, sources, { beforeMutation: () => { throw proof; }, mutationFailed: error => { failures.push(error); } });
  expect(await caught(() => adapter.create(input))).toBe(proof);
  expect(failures).toEqual([]);
});

test("Phase5d2 throwing then inspection fences all hooks without invoking a writer", async () => {
  for (const hook of ["beforeMutation", "beforeLifecycle", "beforeInitialize"] as const) for (const inspection of ["has", "get"] as const) {
    const fault = new Error(`unsafe ${inspection}`), failures: unknown[] = [];
    let inspections = 0, writes = 0;
    const result = inspection === "has"
      ? new Proxy({}, { has() { inspections++; throw fault; } })
      : Object.defineProperty({}, "then", { get() { inspections++; throw fault; } });
    const hooks = { [hook]: () => result, mutationFailed: (error: unknown) => { failures.push(error); } } as WorkstreamMutationHooks;
    const adapter = new WorkstreamAdapter({ createWorkstream() { writes++; }, async providePhase() { writes++; } } as unknown as RepositoryDomain, sources, hooks);
    const action = hook === "beforeInitialize" ? initialization(hooks) : hook === "beforeLifecycle" ? () => adapter.provide(input.id, "design") : () => adapter.create(input);
    const error = await caught(action);
    expect(error).toMatchObject({ status: 503, code: "storage-unavailable", cause: fault });
    expect(failures).toEqual([fault]);
    expect(inspections).toBe(1);
    expect(writes).toBe(0);
  }
});

test("Phase5d2 returned deferred rejection is consumed once after fencing the hook", async () => {
  for (const hook of ["beforeMutation", "beforeLifecycle", "beforeInitialize"] as const) {
    const deferred = Promise.withResolvers<void>(), calls: string[] = [];
    let reads = 0, writes = 0;
    const result = Object.defineProperty({}, "then", { get() {
      reads++;
      if (reads > 1) throw new Error("then getter reread");
      return (resolve: () => void, reject: (error: unknown) => void) => { calls.push("consume"); return deferred.promise.then(resolve, reject); };
    } });
    const hooks = { [hook]: () => result, mutationFailed: (error: unknown) => {
      expect((error as Error).message).toBe("Domain mutation hooks must complete synchronously"); calls.push("fatal");
    } } as WorkstreamMutationHooks;
    const adapter = new WorkstreamAdapter({ createWorkstream() { writes++; }, async providePhase() { writes++; } } as unknown as RepositoryDomain, sources, hooks);
    const action = hook === "beforeInitialize" ? initialization(hooks) : hook === "beforeLifecycle" ? () => adapter.provide(input.id, "design") : () => adapter.create(input);
    expect(await caught(action)).toMatchObject({ status: 503, code: "storage-unavailable" });
    expect(calls).toEqual(["fatal", "consume"]);
    deferred.reject(new Error("late hook rejection"));
    await Promise.resolve(); await Promise.resolve();
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  }
});
