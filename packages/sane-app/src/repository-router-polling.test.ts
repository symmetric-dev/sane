import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Admission } from "./app-store";
import type { CatalogService } from "./catalog";
import type { CatalogResponse } from "./catalog-contract";
import { performanceFixture } from "../tests/fixtures/app-performance";

const registeredWorkspaces = (catalog: CatalogService): Promise<CatalogResponse> =>
  catalog.registeredWorkspaces();

test("polling misses fully discover; warm hits only read registered selection and validate the live domain", async () => {
  const f = await performanceFixture();
  const get = spyOn(f.catalog, "get"), binding = spyOn(f.catalog, "binding"), discover = spyOn(f.catalog, "discover"), registered = spyOn(f.catalog, "registered");
  try {
    const first = await f.router.forPolling(f.workspaceId);
    expect(get).toHaveBeenCalledTimes(1);
    expect(binding.mock.calls.length).toBeGreaterThan(0);
    expect(discover.mock.calls.length).toBeGreaterThan(0);
    expect(registered).not.toHaveBeenCalled();
    const validation = spyOn(first.domain, "validatePolling");
    try {
      get.mockClear(); binding.mockClear(); discover.mockClear();
      for (let i = 0; i < 3; i++) expect(await f.router.forPolling(f.workspaceId)).toBe(first);
      expect(registered).toHaveBeenCalledTimes(3);
      expect(validation).toHaveBeenCalledTimes(3);
      expect(get).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
      // Display-only metadata is not a filesystem rebinding.
      await f.catalog.setAlias(f.workspaceId, f.worktreeId, "Friendly checkout");
      expect(await f.router.forPolling(f.workspaceId)).toBe(first);
      expect(get).not.toHaveBeenCalled();
    } finally { validation.mockRestore(); }
  } finally { for (const spy of [get, binding, discover, registered]) spy.mockRestore(); f.close(); }
});

test("binding revisions require full rebinding rather than trusting a warm polling entry", async () => {
  const f = await performanceFixture();
  try {
    await f.router.forPolling(f.workspaceId);
    // Authoritative selection changes are independent of filesystem changes (same convention as search-scope tests).
    (f.catalog as any).catalog.workspaces[0].worktrees[0].bindingRevision = crypto.randomUUID();
    const get = spyOn(f.catalog, "get"), binding = spyOn(f.catalog, "binding");
    try { await f.router.forPolling(f.workspaceId); expect(get).toHaveBeenCalledTimes(1); expect(binding.mock.calls.length).toBeGreaterThan(0); }
    finally { get.mockRestore(); binding.mockRestore(); }
  } finally { f.close(); }
});

test("changed selected worktree keeps separate invocation pins even within the same domain", async () => {
  const f = await performanceFixture(true);
  try {
    const linked = await f.router.forPolling(f.workspaceId);
    expect(linked.domain.context.invocationCheckout.path).toBe(f.checkout);
    const workspace = (f.catalog as any).catalog.workspaces[0];
    workspace.worktrees.reverse();
    const get = spyOn(f.catalog, "get");
    try {
      const primary = await f.router.forPolling(f.workspaceId);
      expect(get).toHaveBeenCalledTimes(1);
      expect(primary.repositoryId).toBe(linked.repositoryId);
      expect(primary).not.toBe(linked);
      expect(primary.domain.context.invocationCheckout.path).toBe(f.primary);
      expect(linked.domain.context.invocationCheckout.path).toBe(f.checkout);
      workspace.worktrees.reverse();
      expect(await f.router.forPolling(f.workspaceId)).toBe(linked);
    } finally { get.mockRestore(); }
  } finally { f.close(); }
});

test("changed registered common-directory selection fails closed through full discovery", async () => {
  const f = await performanceFixture();
  try {
    await f.router.forPolling(f.workspaceId);
    const workspace = (f.catalog as any).catalog.workspaces[0];
    workspace.commonDir = join(f.root, "different-common-dir");
    const get = spyOn(f.catalog, "get");
    try { await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ code: "unavailable" }); expect(get).toHaveBeenCalledTimes(1); }
    finally { get.mockRestore(); }
  } finally { f.close(); }
});

test("invalid cached domain is closed and evicted; corrupt misses fail closed and restoration opens a new handle", async () => {
  const f = await performanceFixture();
  try {
    const first = await f.router.forPolling(f.workspaceId), marker = join(first.domain.stateRoot, "complete.json"), original = readFileSync(marker, "utf8");
    const close = spyOn(first, "close"), get = spyOn(f.catalog, "get");
    try {
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), repositoryId: crypto.randomUUID() }));
      await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ code: "STALE_BINDING" });
      expect(close).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled();
      expect(() => first.list()).toThrow("closed");
      await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ code: "CORRUPT_STORE" });
      expect(get).toHaveBeenCalledTimes(1);
      writeFileSync(marker, original);
      const recovered = await f.router.forPolling(f.workspaceId);
      expect(recovered).not.toBe(first); expect(recovered.repositoryId).toBe(first.repositoryId);
      expect(recovered.list()).toEqual([]);
      expect(await f.router.forPolling(f.workspaceId)).toBe(recovered);
    } finally { close.mockRestore(); get.mockRestore(); }
  } finally { f.close(); }
});

test("missing selected linked invocation invalidates polling without returning the cached reader", async () => {
  const f = await performanceFixture(true);
  try {
    const first = await f.router.forPolling(f.workspaceId);
    renameSync(f.checkout, join(f.root, "moved-linked"));
    await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ code: "INVALID_CHECKOUT" });
    expect(() => first.list()).toThrow("closed");
    // Subsequent full catalog discovery may explicitly select the still valid primary checkout.
    const recovered = await f.router.forPolling(f.workspaceId);
    expect(recovered).not.toBe(first); expect(recovered.domain.context.invocationCheckout.path).toBe(f.primary);
  } finally { f.close(); }
});

test("an entry evicted by another caller's invalid full read cannot be resurrected by polling", async () => {
  const f = await performanceFixture();
  try {
    const first = await f.router.forPolling(f.workspaceId);
    first.close();
    await expect(f.router.forWorkspace(f.workspaceId)).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    const next = await f.router.forPolling(f.workspaceId);
    expect(next).not.toBe(first); expect(next.list()).toEqual([]);
  } finally { f.close(); }
});

test("inspect, workspace mutations and admission routing still perform full binding discovery after polling warms", async () => {
  const f = await performanceFixture();
  try {
    const first = await f.router.forPolling(f.workspaceId);
    const admission = { binding: { workspaceId: f.workspaceId, domain: { mode: "repository", repositoryId: first.repositoryId, primaryCheckout: f.primary } } } as Admission;
    const get = spyOn(f.catalog, "get"), registered = spyOn(f.catalog, "registered");
    try {
      expect((await f.router.inspect(f.workspaceId)).state).toBe("ready");
      expect(await f.router.forWorkspace(f.workspaceId, first.repositoryId)).toBe(first);
      expect(await f.router.forAdmission(admission, f.workspaceId)).toBe(first);
      expect(get).toHaveBeenCalledTimes(3); expect(registered).not.toHaveBeenCalled();
      await expect(f.router.forWorkspace(f.workspaceId, crypto.randomUUID())).rejects.toMatchObject({ code: "domain-mismatch" });
      await expect(f.router.forAdmission(admission, crypto.randomUUID())).rejects.toMatchObject({ code: "repository-mismatch" });
    } finally { get.mockRestore(); registered.mockRestore(); }
  } finally { f.close(); }
});

test("polling misses do not initialize stores or accept missing/plain-directory workspace selection", async () => {
  const f = await performanceFixture(false, false);
  try {
    await expect(f.router.forPolling("")).rejects.toMatchObject({ code: "workspace-required", status: 400 });
    await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    expect((await f.router.inspect(f.workspaceId)).state).toBe("uninitialized");
    const plain = join(f.root, "plain"); mkdirSync(plain);
    const directory = await f.catalog.register(plain);
    await expect(f.router.forPolling(directory.workspaceId)).rejects.toMatchObject({ code: "not-repository" });
    await expect(f.router.forPolling(crypto.randomUUID())).rejects.toMatchObject({ code: "unknown-workspace" });
  } finally { f.close(); }
});

test("registered catalog snapshots perform no discovery and cannot mutate authoritative selection", async () => {
  const f = await performanceFixture();
  const discover = spyOn(f.catalog, "discover"), binding = spyOn(f.catalog, "binding");
  try {
    const snapshot = await f.catalog.registered(f.workspaceId);
    snapshot.worktrees[0]!.root = "/not-the-authoritative-root";
    snapshot.worktrees.reverse();
    expect((await f.catalog.registered(f.workspaceId)).worktrees[0]!.root).toBe(f.primary);
    expect(discover).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled();
  } finally { discover.mockRestore(); binding.mockRestore(); f.close(); }
});

test("registered catalog reads wait for pending serialized selection writes", async () => {
  const f = await performanceFixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), saving = new Promise<void>(resolve => { entered = resolve; });
  const originalSave = (f.catalog as any).save.bind(f.catalog);
  (f.catalog as any).save = async (...args: any[]) => { entered(); await gate; return originalSave(...args); };
  try {
    const write = f.catalog.setAlias(f.workspaceId, f.worktreeId, "Serialized alias");
    await saving;
    let settled = false;
    const read = f.catalog.registered(f.workspaceId).then(value => { settled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    release(); await write;
    expect((await read).worktrees[0]!.alias).toBe("Serialized alias");
  } finally { release(); await f.catalog.flush(); f.close(); }
});

test("catalog storage failure blocks registered snapshots and warm polling rather than serving stale metadata", async () => {
  const f = await performanceFixture();
  try {
    await f.router.forPolling(f.workspaceId);
    renameSync(f.data, join(f.root, "old-data"));
    await expect(f.catalog.setAlias(f.workspaceId, f.worktreeId, "Cannot persist")).rejects.toMatchObject({ status: 503, code: "catalog-storage" });
    await expect(f.catalog.registered(f.workspaceId)).rejects.toMatchObject({ status: 503, code: "catalog-storage" });
    await expect(f.router.forPolling(f.workspaceId)).rejects.toMatchObject({ status: 503, code: "catalog-storage" });
  } finally { f.close(); }
});

test("registered workspace enumeration returns copied metadata in catalog order without get, binding or discovery", async () => {
  const f = await performanceFixture();
  try {
    const plain = join(f.root, "plain"); mkdirSync(plain);
    const directory = await f.catalog.register(plain);
    const get = spyOn(f.catalog, "get"), binding = spyOn(f.catalog, "binding"), discover = spyOn(f.catalog, "discover");
    try {
      const snapshot = await registeredWorkspaces(f.catalog);
      expect(snapshot).toEqual({ version: 1, workspaces: [f.workspace, directory.workspace] });
      snapshot.workspaces[0]!.worktrees[0]!.root = "/not-authoritative";
      snapshot.workspaces[0]!.name = "Not authoritative";
      snapshot.workspaces.reverse();
      expect(await registeredWorkspaces(f.catalog)).toEqual({ version: 1, workspaces: [f.workspace, directory.workspace] });
      expect(get).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
      // Ordinary listing must continue to use the full binding contract.
      expect(await f.catalog.list()).toEqual({ version: 1, workspaces: [f.workspace, directory.workspace] });
      expect(get).toHaveBeenCalledTimes(2); expect(binding.mock.calls.length).toBeGreaterThan(0); expect(discover.mock.calls.length).toBeGreaterThan(0);
      get.mockClear(); binding.mockClear(); discover.mockClear();
      renameSync(f.primary, join(f.root, "moved-primary"));
      // Selection-only enumeration reports registration, not current filesystem
      // validity. The router must still validate before using this stale selection.
      expect((await registeredWorkspaces(f.catalog)).workspaces[0]).toEqual(f.workspace);
      expect(get).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
    } finally { get.mockRestore(); binding.mockRestore(); discover.mockRestore(); }
  } finally { f.close(); }
});

test("registered workspace enumeration waits for serialized catalog writes", async () => {
  const f = await performanceFixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), saving = new Promise<void>(resolve => { entered = resolve; });
  const originalSave = (f.catalog as any).save.bind(f.catalog);
  (f.catalog as any).save = async (...args: any[]) => { entered(); await gate; return originalSave(...args); };
  try {
    const write = f.catalog.setAlias(f.workspaceId, f.worktreeId, "Enumerated alias");
    await saving;
    let settled = false;
    const read = registeredWorkspaces(f.catalog).then(value => { settled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    release(); await write;
    expect((await read).workspaces[0]!.worktrees[0]!.alias).toBe("Enumerated alias");
  } finally { release(); await f.catalog.flush(); f.close(); }
});

test("registered workspace enumeration fails closed after catalog storage failure", async () => {
  const f = await performanceFixture();
  try {
    renameSync(f.data, join(f.root, "old-data"));
    await expect(f.catalog.setAlias(f.workspaceId, f.worktreeId, "Cannot persist")).rejects.toMatchObject({ status: 503, code: "catalog-storage" });
    await expect(registeredWorkspaces(f.catalog)).rejects.toMatchObject({ status: 503, code: "catalog-storage" });
  } finally { f.close(); }
});
