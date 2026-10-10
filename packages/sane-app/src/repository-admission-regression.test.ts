import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Admission } from "./app-store";
import { AdmissionService } from "./admission";
import { performanceFixture } from "../tests/fixtures/app-performance";

async function waitForEntry(entered: Promise<void>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      pending.then(() => { throw new Error("Route settled before entering the catalog gate"); }, error => { throw error; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Catalog gate was not reached")), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function drainRoute(pending: Promise<unknown> | undefined) {
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.catch(() => {}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Released route did not settle during cleanup")), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Distinguish discovery inside get() from the router's final binding await.
for (const boundary of ["get-internal-binding", "final-router-binding", "warm-polling-registered"] as const) {
  const route = boundary === "warm-polling-registered" ? "forPolling" : "forWorkspace";
  for (const change of ["checkout", "store"] as const) test(`${boundary} ${boundary === "final-router-binding" && change === "checkout" ? "execution" : route} refuses ${change} drift across catalog admission await`, async () => {
    const f = await performanceFixture(true);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;
    const restores: (() => void)[] = [];
    try {
      let admission: Admission | undefined;
      if (boundary === "final-router-binding" && change === "checkout") {
        const admissions = new AdmissionService(f.data, { version: 1, admissions: [] }, f.sources, f.catalog, f.router);
        const sessionId = crypto.randomUUID();
        await admissions.begin({ sessionId, operation: "attach", harness: "cc", cwd: f.checkout,
          workspaceId: f.workspaceId, worktreeId: f.worktreeId, nativeId: crypto.randomUUID() });
        await admissions.register(sessionId);
        admissions.ready(sessionId);
        // Keep the exact durable admission and execution pin from before replacement.
        admission = admissions.get(sessionId)!;
        expect(JSON.parse(readFileSync(join(f.data, "admissions.json"), "utf8")).admissions).toEqual([admission]);
        expect(admission.binding.checkoutPin?.path).toBe(f.checkout);
        expect((await f.router.execution(admission)).executionCheckout).toBe(f.checkout);
      }
      if (route === "forPolling") await f.router.forPolling(f.workspaceId);
      let getCompleted = false;
      const originalGet = f.catalog.get.bind(f.catalog);
      const get = spyOn(f.catalog, "get").mockImplementation(async id => {
        const value = await originalGet(id); getCompleted = true; return value;
      });
      restores.push(() => get.mockRestore());
      const method = route === "forPolling" ? "registered" : "binding";
      const original = f.catalog[method].bind(f.catalog);
      const suspended = spyOn(f.catalog, method).mockImplementation(async (...args: any[]) => {
        const value = await (original as (...args: any[]) => Promise<any>)(...args);
        if (boundary !== "final-router-binding" || getCompleted) {
          entered.resolve(); await gate.promise;
        }
        return value;
      });
      restores.push(() => suspended.mockRestore());
      const dispatch = mock(() => undefined);
      pending = (admission ? f.router.execution(admission) : f.router[route](f.workspaceId)).then(dispatch);
      const outcome = pending.then(() => ({ code: "unexpected-dispatch" }), error => error);
      await waitForEntry(entered.promise, pending);
      expect(dispatch).not.toHaveBeenCalled();
      if (change === "checkout") {
        renameSync(f.checkout, f.checkout + "-saved"); mkdirSync(f.checkout);
        renameSync(join(f.checkout + "-saved", ".git"), join(f.checkout, ".git"));
      } else {
        const marker = join(f.primary, ".sane", "complete.json");
        writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), repositoryId: crypto.randomUUID() }));
      }
      gate.resolve();
      // Cold routes now fence catalog identity after asynchronous repository
      // inspection. A replaced execution checkout is rejected there (409)
      // before execution() reaches its additional persisted core-pin check.
      const code = route === "forPolling" ? "STALE_BINDING" : change === "checkout" ? "binding-invalid" : "CORRUPT_STORE";
      expect(await outcome).toMatchObject({ code, ...(code === "binding-invalid" ? { status: 409 } : {}) });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      try { await drainRoute(pending); }
      finally { try { for (const restore of restores.reverse()) restore(); } finally { f.close(); } }
    }
  });
}

test("admission refuses another repository UUID or primary checkout before dispatch", async () => {
  const f = await performanceFixture();
  let other: Awaited<ReturnType<typeof performanceFixture>> | undefined;
  try {
    other = await performanceFixture();
    const adapter = await f.router.forWorkspace(f.workspaceId), foreign = await other.router.forWorkspace(other.workspaceId);
    const dispatch = mock(() => undefined);
    for (const domain of [
      { repositoryId: foreign.repositoryId, primaryCheckout: f.primary },
      { repositoryId: adapter.repositoryId, primaryCheckout: other.primary },
    ]) {
      const admission = { binding: { workspaceId: f.workspaceId, domain: { mode: "repository", ...domain } } } as Admission;
      await expect(f.router.forAdmission(admission).then(dispatch)).rejects.toMatchObject({ code: "domain-mismatch" });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect((await f.router.forWorkspace(f.workspaceId)).list()).toEqual([]);
  } finally { try { other?.close(); } finally { f.close(); } }
});

test("catalog rejection during admission cannot return a warm adapter; fresh retry can recover", async () => {
  const f = await performanceFixture();
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined, restore: (() => void) | undefined;
  try {
    const adapter = await f.router.forPolling(f.workspaceId);
    const failure = new Error("catalog temporarily unavailable");
    const suspended = spyOn(f.catalog, "registered").mockImplementation(async () => {
      entered.resolve(); await gate.promise; throw failure;
    });
    restore = () => suspended.mockRestore();
    const dispatch = mock(() => undefined);
    pending = f.router.forPolling(f.workspaceId).then(dispatch);
    const outcome = pending.then(() => null, error => error);
    await waitForEntry(entered.promise, pending); expect(dispatch).not.toHaveBeenCalled();
    gate.resolve(); expect(await outcome).toBe(failure); expect(dispatch).not.toHaveBeenCalled();
    suspended.mockRestore();
    expect((await f.router.forPolling(f.workspaceId)).repositoryId).toBe(adapter.repositoryId);
  } finally {
    gate.resolve();
    try { await drainRoute(pending); }
    finally { try { restore?.(); } finally { f.close(); } }
  }
});
