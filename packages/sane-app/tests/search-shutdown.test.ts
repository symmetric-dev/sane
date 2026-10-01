import { expect, test } from "bun:test";
import { createWorkspaceSearchLifecycle } from "../src/bridge";
import { WorkspaceError } from "../src/workspace";

test("host shutdown cancels both search routes and awaits every resource-cleanup finally", async () => {
  const lifecycle = createWorkspaceSearchLifecycle();
  const cleanup = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const aborted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let finished = 0, drained = false, admittedAfterClose = false;
  const requests = ["worktree", "legacy"].map((_route, index) => lifecycle.run(new AbortController().signal, async signal => {
    try {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted[index]!.resolve(); reject(new WorkspaceError(499, "search-aborted", "Search cancelled")); }, { once: true });
      });
    } finally {
      // Model WorkspaceService's awaited active read / evaluator-reap finally.
      await cleanup[index]!.promise;
      finished++;
    }
  }));
  const outcomes = Promise.allSettled(requests);
  const drain = lifecycle.close();
  expect(lifecycle.close()).toBe(drain);
  void drain.then(() => { drained = true; });
  await Promise.all(aborted.map(value => value.promise));
  expect(drained).toBe(false); expect(finished).toBe(0);
  await expect(lifecycle.run(new AbortController().signal, async () => { admittedAfterClose = true; })).rejects.toMatchObject({ status: 503, code: "search-shutdown" });
  expect(admittedAfterClose).toBe(false);
  cleanup[0]!.resolve(); await requests[0]!.catch(() => {});
  expect(drained).toBe(false); expect(finished).toBe(1);
  cleanup[1]!.resolve(); await drain;
  expect(finished).toBe(2);
  expect((await outcomes).map(result => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of await outcomes) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "search-aborted" });
});

test("request cancellation is isolated; completed/error searches do not obstruct host drain", async () => {
  const lifecycle = createWorkspaceSearchLifecycle(), request = new AbortController();
  let secondAborted = false;
  const secondFinished = Promise.withResolvers<void>();
  const first = lifecycle.run(request.signal, signal => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new WorkspaceError(499, "search-aborted", "Search cancelled")), { once: true });
  }));
  // Register settlement without an eager Bun rejection matcher: cancellation
  // must be driven before waiting for the deliberately pending request.
  const rejected = Promise.allSettled([first]);
  const second = lifecycle.run(new AbortController().signal, async signal => {
    signal.addEventListener("abort", () => { secondAborted = true; }, { once: true });
    await secondFinished.promise;
    return "matches";
  });
  try {
    request.abort();
    expect((await rejected)[0]).toMatchObject({ status: "rejected", reason: { code: "search-aborted" } });
    expect(secondAborted).toBe(false);
    secondFinished.resolve(); expect(await second).toBe("matches");
    await expect(lifecycle.run(new AbortController().signal, async () => { throw new WorkspaceError(409, "binding-invalid", "Binding changed"); })).rejects.toMatchObject({ code: "binding-invalid" });
  } finally {
    request.abort(); secondFinished.resolve();
    await Promise.allSettled([first, second]);
    await lifecycle.close();
  }
});

test("already cancelled requests and shutdown gate never invoke search work", async () => {
  const lifecycle = createWorkspaceSearchLifecycle(), request = new AbortController(); request.abort();
  let calls = 0;
  await expect(lifecycle.run(request.signal, async () => { calls++; })).rejects.toMatchObject({ code: "search-aborted" });
  await lifecycle.close();
  expect(() => lifecycle.assertOpen()).toThrow("Bridge is shutting down");
  await expect(lifecycle.run(new AbortController().signal, async () => { calls++; })).rejects.toMatchObject({ code: "search-shutdown" });
  expect(calls).toBe(0);
});
