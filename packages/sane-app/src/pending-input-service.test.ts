import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PendingInputService, pendingInputRoute, type PendingInputServiceDependencies } from "./pending-input-service";
import { PendingInputDomainError, PendingInputStorageError } from "./pending-input-contract";
import { id, pendingFixture, sibling } from "./pending-input-fixtures";
import { prepareUserInput } from "./user-input-preparation";
import { seedAgentProfiles } from "./agent-profiles-contract";
import { dispatchSource } from "./pending-input-codec";
import { isPendingInputSnapshot } from "../shared/conversation/pending-input-contract";
import type { Session } from "./history";
import { CatalogService } from "./catalog";
const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(seed?: Awaited<ReturnType<typeof pendingFixture>>) {
  const input = seed ?? await pendingFixture(), b = input.snapshot.prepared.binding;
  const dir = realpathSync(mkdtempSync(join(TEMP, "pending-service-"))); dirs.push(dir);
  const session: Session = { ...input.snapshot.prepared.configuration, sessionId: b.conversationId, harness: b.harness, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId, cwd: b.cwd, lastRunId: null, lastStatus: "unknown" };
  let preparations = 0, preflights = 0, closed = 0, live = true, unsafe = false;
  const deps: PendingInputServiceDependencies = { dataDir: dir, storeId: id(), session: cid => cid === session.sessionId ? session : undefined,
    mutationGuard: () => { if (!live) throw new PendingInputDomainError("closing", "Closing", 503); },
    supervise: async action => action(), failClosed: () => { closed++; },
    guard: (action) => { if (!live) throw new PendingInputDomainError("closing", "Closing", 503); if (unsafe && action !== "remove") throw new PendingInputDomainError("paused-branch", "Branch safety pause"); },
    prepare: async (cid, text) => { preparations++; return prepareUserInput({ sessionId: cid, prompt: text }, { profiles: seedAgentProfiles(), getSession: () => session, defaultCwd: b.cwd, conversationId: id, sourceAuthorityId: () => session.authorityId!, selectedDirectory: async () => b.cwd, ensureDirectory: async () => {}, validateOpenCodeModel: () => {}, resolveOpenCodeLaunch: async () => { throw new Error("No native creation"); } }); },
    preflight: async prepared => { preflights++; return { pins: { ...input.snapshot.pins, configuration: prepared.expectedPrior!.configuration, launch: prepared.configuration }, validate: () => { if (unsafe) throw new PendingInputDomainError("pin-changed", "Queue pin changed"); } }; },
  };
  const service = new PendingInputService(deps), cid = b.conversationId, route = `/api/sessions/${cid}/pending-inputs`;
  const api = async (path = route, value?: unknown, method = value === undefined ? "GET" : "POST") => {
    const response = (await pendingInputRoute(new Request(`http://localhost${path}`, { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), path, service))!;
    return { status: response.status, body: await response.json() as any, response };
  };
  return { input, service, session, cid, route, api, deps, counters: () => ({ preparations, preflights, closed }), close: () => { live = false; }, unsafe: () => { unsafe = true; } };
}
test("explicit wire request asserts server config, three waiting slots and isolated v1 read projection", async () => {
  const f = await fixture();
  for (const i of [f.input, sibling(f.input), sibling(f.input)]) expect((await f.api(f.route, i.request)).status).toBe(202);
  const fourth = await f.api(f.route, sibling(f.input).request); expect(fourth.status).toBe(429);
  const view = await f.api(); expect(isPendingInputSnapshot(view.body.snapshot)).toBe(true); expect(view.body.snapshot.items.map((i: any) => i.sequence)).toEqual([1, 2, 3]);
  expect(view.body.presentation).toMatchObject({ waitingCount: 3, maxWaiting: 3, chainLocked: true, unresolved: null, automation: { supported: false }, enqueue: { allowed: false, code: "pending-input-full" }, resumeAllowed: true });
  expect(view.response.headers.get("cache-control")).toBe("no-store");
});
test("duplicate/lost response precedes preparation, mutable config/capacity/pin checks and never resurrects removal", async () => {
  const f = await fixture(), receipt = (await f.api(f.route, f.input.request)).body; f.service.store.pause(f.cid, { code: "hidden", reason: "Hidden" });
  const request = { version: 1, conversationId: f.cid, requestId: id(), inputRequestId: f.input.request.requestId, itemId: receipt.itemId };
  await f.api(`${f.route}/${receipt.itemId}/remove`, request); f.session.model = "changed-model"; f.unsafe(); const before = f.counters();
  expect((await f.api(f.route, f.input.request)).body).toEqual(receipt); expect(f.counters()).toEqual(before);
  const status = await f.api(`${f.route}/inputs/${f.input.request.requestId}`); expect(status.body).toMatchObject({ receipt, classification: "removed" });
  expect((await f.api(f.route, { ...f.input.request, text: "different" })).status).toBe(409);
});
test("raw queue clients cannot forge source/config/settings or authorization and route body identities must agree", async () => {
  const f = await fixture();
  for (const request of [
    { ...f.input.request, version: 2 }, { ...f.input.request, extra: "unknown" }, { ...f.input.request, configuration: { ...f.input.request.configuration, nativeStopped: true } },
  ]) expect((await f.api(f.route, request)).status).toBe(400);
  for (const request of [
    { ...f.input.request, conversationId: id(), source: { ...f.input.request.source, conversationId: id() } },
    { ...f.input.request, source: { ...f.input.request.source, nativeSessionId: null } },
    { ...f.input.request, configuration: { ...f.input.request.configuration, model: "forged-model" } },
    { ...f.input.request, source: { ...f.input.request.source, nativeSessionId: id() } },
  ]) expect((await f.api(f.route, request)).status).toBeGreaterThanOrEqual(400);
  expect(f.service.store.readRecords().conversations).toEqual([]);
});
test("paused removal stays independent and duplicate resume keeps original operation receipt", async () => {
  const f = await fixture(), receipt = (await f.api(f.route, f.input.request)).body; f.service.store.pause(f.cid, { code: "restart", reason: "Restart" });
  const resume = { version: 1, requestId: id(), conversationId: f.cid, action: "resume", expectedRevision: f.service.store.get(f.cid).revision };
  expect((await f.api(`${f.route}/resume`, { ...resume, expectedRevision: 0 })).status).toBe(409);
  const result = (await f.api(`${f.route}/resume`, resume)).body; f.service.store.pause(f.cid, { code: "hidden", reason: "Hidden again" }); f.unsafe();
  expect((await f.api(`${f.route}/resume`, resume)).body).toEqual(result); expect(f.service.store.get(f.cid).paused).toBe(true);
  const remove = { version: 1, requestId: id(), conversationId: f.cid, inputRequestId: f.input.request.requestId, itemId: receipt.itemId };
  expect((await f.api(`${f.route}/${receipt.itemId}/remove`, remove)).status).toBe(200); const revision = f.service.store.get(f.cid).revision;
  expect((await f.api(`${f.route}/${receipt.itemId}/remove`, remove)).body.revision).toBe(revision); expect(f.service.store.get(f.cid).revision).toBe(revision);
});
test("claim journal mutations are dormant without exact Phase 4 injected authority", async () => {
  const f = await fixture(), receipt = (await f.api(f.route, f.input.request)).body, state = f.service.store.inspect(f.cid);
  expect(() => f.service.store.claim({ conversationId: f.cid, itemId: receipt.itemId, inputRequestId: f.input.request.requestId, expectedRevision: state.snapshot.revision, attemptId: id(), runId: id(), nativeCommandId: null,
    authorization: { kind: "dispatch", authorizationId: id(), chainId: state.chain!.chainId, predecessorRunId: null, source: dispatchSource(f.input.snapshot) } })).toThrow("not integrated");
  expect(f.service.store.get(f.cid).items[0]!.state).toBe("waiting");
});
test("shutdown fence blocks all low-level mutation and HTTP queue writes", async () => {
  const f = await fixture(); await f.api(f.route, f.input.request); const before = f.service.store.readRecords(); f.close();
  expect((await f.api(f.route, sibling(f.input).request)).status).toBe(503);
  expect(() => f.service.store.pause(f.cid, { code: "failed", reason: "No post-release write" })).toThrow(PendingInputDomainError); expect(f.service.store.readRecords()).toEqual(before);
});
test("malformed optional store invokes owner failClosed rather than creating an empty queue", async () => {
  const f = await fixture(); writeFileSync(join(f.deps.dataDir, "pending-inputs.json"), "{invalid");
  expect(() => new PendingInputService(f.deps)).toThrow(PendingInputStorageError); expect(f.counters().closed).toBe(1);
});
test("concurrent identical enqueue returns the original receipt even if second preparation fails after first durable commit", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), prepare = f.deps.prepare;
  let calls = 0;
  f.deps.prepare = async (...args) => { if (++calls === 2) { entered.resolve(); await release.promise; throw new PendingInputDomainError("config-drift", "Mutable configuration changed"); } return prepare(...args); };
  const first = f.service.enqueue(f.cid, f.input.request), second = f.service.enqueue(f.cid, f.input.request);
  await entered.promise; const receipt = await first; f.unsafe(); release.resolve();
  expect(await second).toEqual(receipt); expect(f.service.store.get(f.cid).items).toHaveLength(1); expect(f.service.store.get(f.cid).revision).toBe(1);
});
test("concurrent identical resume dedups before a later failed live preflight", async () => {
  const f = await fixture(); await f.service.enqueue(f.cid, f.input.request); f.service.store.pause(f.cid, { code: "restart", reason: "Explicit resume" });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), preflight = f.deps.preflight;
  let calls = 0;
  f.deps.preflight = async prepared => { if (++calls === 2) { entered.resolve(); await release.promise; throw new PendingInputDomainError("config-drift", "Live source changed"); } return preflight(prepared); };
  const input = { version: 1, requestId: id(), conversationId: f.cid, action: "resume", expectedRevision: f.service.store.get(f.cid).revision };
  const first = f.service.resume(f.cid, input), second = f.service.resume(f.cid, input);
  await entered.promise; const result = await first; f.unsafe(); release.resolve(); expect(await second).toEqual(result);
  expect(f.service.store.readRecords().conversations[0]!.operations).toHaveLength(1);
});
test("resume freezes its original operation identity and observed revision before awaited preflight", async () => {
  const f = await fixture(); await f.service.enqueue(f.cid, f.input.request); f.service.store.pause(f.cid, { code: "restart", reason: "Resume" });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), preflight = f.deps.preflight;
  f.deps.preflight = async prepared => { entered.resolve(); await release.promise; return preflight(prepared); };
  const value = { version: 1, requestId: id(), conversationId: f.cid, action: "resume", expectedRevision: f.service.store.get(f.cid).revision }, original = structuredClone(value);
  const pending = f.service.resume(f.cid, value); await entered.promise; value.requestId = id(); value.expectedRevision = 0; release.resolve();
  expect(await pending).toMatchObject({ ...original, outcome: "resumed" });
});
test("established worker input retains its inherited identity and operation constraints without a role exclusion", async () => {
  const f = await fixture(await pendingFixture("opencode", {}, { agent: "scout", agentKind: "worker", nativeAgentSelected: true, profileId: "worker:scout" }));
  expect((await f.api(f.route, f.input.request)).status).toBe(202);
  const historical = f.service.store.lookup(f.cid, f.input.request.requestId)!.item.snapshot.prepared;
  expect(historical.configuration).toMatchObject({ profileId: "worker:scout", agent: "scout", agentKind: "worker", nativeAgentSelected: true });
  expect(historical.stagedUpgrade).toBeUndefined(); expect((await f.api()).body.presentation.automation.supported).toBe(false);
});
test("catalog final synchronous fence rejects inode replacement and revision drift but does not freeze working files", async () => {
  const f = await fixture(), cwd = realpathSync(mkdtempSync(join(TEMP, "pending-catalog-root-"))); dirs.push(cwd);
  const catalog = new CatalogService(f.deps.dataDir, () => []), registered = await catalog.register(cwd);
  const binding = await catalog.binding(registered.workspaceId, registered.worktreeId);
  const validate = () => catalog.assertBinding(registered.workspaceId, registered.worktreeId, binding.cwd, binding.bindingRevision);
  expect(validate).not.toThrow(); writeFileSync(join(cwd, "working.txt"), "working files are not chain-frozen"); expect(validate).not.toThrow();
  expect(() => catalog.assertBinding(registered.workspaceId, registered.worktreeId, binding.cwd, id())).toThrow("changed");
  renameSync(cwd, `${cwd}-old`); dirs.push(`${cwd}-old`); mkdirSync(cwd); expect(validate).toThrow("filesystem binding changed");
});
