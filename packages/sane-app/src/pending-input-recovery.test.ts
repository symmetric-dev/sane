import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPendingInputRecovery, type PendingInputRecovery } from "./pending-input-recovery";
import { PendingInputStore } from "./pending-input-store";
import { dispatchSource } from "./pending-input-codec";
import { PendingInputDomainError } from "./pending-input-contract";
import { pendingFixture, sibling, id } from "./pending-input-fixtures";
import type { OpenCodeRunService } from "./opencode-run-service";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(harness: "opencode" | "claude-code", state: "withheld" | "submitted" | "ambiguous") {
  const dir = realpathSync(mkdtempSync(join("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", "recovered-input-")));
  dirs.push(dir);
  const storeId = id(), input = await pendingFixture(harness), next = sibling(input, "preserved waiter");
  const seed = new PendingInputStore(dir, storeId, { validateLive: () => {} });
  seed.enqueue(input); seed.enqueue(next);
  const cid = input.request.conversationId;
  const head = seed.lookup(cid, input.request.requestId)!.item;
  const identity: DispatchIdentity = seed.claim({ conversationId: cid, itemId: head.itemId, inputRequestId: head.requestId,
    expectedRevision: seed.get(cid).revision, attemptId: id(), runId: id(),
    nativeCommandId: harness === "opencode" ? `msg_${id().replaceAll("-", "")}` : null,
    authorization: { kind: "dispatch", authorizationId: id(), chainId: head.chainId, predecessorRunId: null, source: dispatchSource(input.snapshot) } }).claim!.identity;
  if (state !== "withheld") {
    seed.link(identity);
    seed.beforeNative({ ...identity, submission: "attempted", nativeAcceptance: "unknown" });
  }
  seed.outcome({ ...identity, submission: state === "withheld" ? "not-submitted" : state === "submitted" ? "submitted" : "unknown",
    nativeAcceptance: state === "withheld" ? "not-accepted" : state === "submitted" ? "accepted" : "unknown" });
  let recovery: PendingInputRecovery | undefined, allowResume = false;
  const store = new PendingInputStore(dir, storeId, { beforeMutation: () => {
    if (recovery && !recovery.writing() && !allowResume) throw new PendingInputDomainError("scope", "Original recovery scope required");
  }, validateLive: value => {
    if (allowResume && value.stage === "resume") return;
    if (!recovery?.validateDispatch(value)) throw new PendingInputDomainError("scope", "Original recovery proof required");
  } });
  const originals = store.recover(), original = originals[0]!;
  let observations = 0, settled = 0, protocolUnsafe = false;
  const service = { observeRecoveredInput: async () => { observations++; return { interrupted: false }; } } as unknown as OpenCodeRunService;
  const create = (override: OpenCodeRunService = service) => {
    recovery = createPendingInputRecovery({ store, originals, service: override,
      available: () => {}, association: () => {}, pins: async () => ({ pins: original.snapshot.pins, validate: () => {} }),
      protocolUnsafe: () => protocolUnsafe, protocolMismatch: async () => {}, terminalProof: () => undefined,
      terminalize: async () => {}, settled: () => { settled++; }, failClosed: () => {} });
    return recovery;
  };
  return { store, original, identity, cid, next, create, observations: () => observations, settled: () => settled,
    permitResume: () => { allowResume = true; },
    unsafe: () => { protocolUnsafe = true; } };
}

test("durable exact withholding settles without native read, retains pause and requires fresh resume", async () => {
  const f = await fixture("claude-code", "withheld");
  await f.create().startup();
  expect(f.observations()).toBe(0); expect(f.settled()).toBe(1);
  expect(f.store.lookup(f.cid, f.original.requestId)!.item.history?.kind).toBe("not-submitted");
  expect(f.store.get(f.cid).items.map(item => item.requestId)).toEqual([f.next.request.requestId]);
  expect(f.store.get(f.cid).paused).toBe(true);
  expect(f.store.reconciliationWork()).toHaveLength(0);
  const revision = f.store.get(f.cid).revision;
  expect(() => f.store.resume({ version: 1, action: "resume", requestId: id(), conversationId: f.cid, expectedRevision: revision })).toThrow("Original recovery scope required");
  f.permitResume();
  expect(f.store.resume({ version: 1, action: "resume", requestId: id(), conversationId: f.cid, expectedRevision: revision }).outcome).toBe("resumed");
  expect(f.store.get(f.cid).paused).toBe(false);
});

test("submitted original settles only on exact typed terminal, never status or foreign identity", async () => {
  const f = await fixture("opencode", "submitted");
  await f.create().startup();
  expect(f.store.reconciliationWork()).toHaveLength(1);
  const foreign = { ...f.identity, nativeCommandId: `msg_${id().replaceAll("-", "")}` };
  await f.create({ observeRecoveredInput: async () => ({ interrupted: false, terminal: { identity: foreign, status: "completed" } }) } as unknown as OpenCodeRunService).startup();
  expect(f.store.reconciliationWork()).toHaveLength(1);
  await f.create({ observeRecoveredInput: async () => ({ interrupted: false, terminal: { identity: f.identity, status: "completed" } }) } as unknown as OpenCodeRunService).startup();
  expect(f.store.lookup(f.cid, f.original.requestId)!.item.history).toMatchObject({ kind: "settled", status: "completed" });
  expect(f.store.get(f.cid).paused).toBe(true);
  expect(f.store.get(f.cid).items.map(item => item.requestId)).toEqual([f.next.request.requestId]);
  expect(f.settled()).toBe(1);
});

test("ambiguous claim remains blocking across restart and unsafe proof cannot settle", async () => {
  const f = await fixture("opencode", "ambiguous");
  f.unsafe(); await f.create().startup();
  expect(f.observations()).toBe(1); expect(f.store.reconciliationWork()).toHaveLength(1);
  expect(f.store.lookup(f.cid, f.original.requestId)!.classification).toBe("uncertain");
  expect(f.store.get(f.cid).paused).toBe(true);
  expect(f.settled()).toBe(0);
});

test("original still running at startup automatically settles on a later observation", async () => {
  const f = await fixture("opencode", "submitted");
  let completed = false, observations = 0;
  const recovery = f.create({ observeRecoveredInput: async () => {
    observations++;
    return { interrupted: false, ...(completed ? { terminal: { identity: f.identity, status: "completed" } } : {}) };
  } } as unknown as OpenCodeRunService);
  await recovery.startup();
  expect(f.settled()).toBe(0);
  completed = true;
  await recovery.refresh();
  expect(f.settled()).toBe(1); expect(f.store.reconciliationWork()).toHaveLength(0);
  await recovery.refresh(); await recovery.stop(f.cid);
  expect(observations).toBe(2); expect(f.settled()).toBe(1);
});

test("refresh and Stop serialize exact original observations and shutdown prevents further reads", async () => {
  const f = await fixture("opencode", "submitted"), gate = Promise.withResolvers<void>();
  let observations = 0, active = 0, maximum = 0;
  const recovery = f.create({ observeRecoveredInput: async () => {
    observations++; active++; maximum = Math.max(maximum, active);
    await gate.promise; active--; return { interrupted: false };
  } } as unknown as OpenCodeRunService);
  const first = recovery.refresh(), second = recovery.refresh(), stop = recovery.stop(f.cid);
  gate.resolve(); await Promise.all([first, second, stop]);
  expect(maximum).toBe(1); expect(observations).toBe(2);
  recovery.close(); await recovery.refresh(); await recovery.stop(f.cid);
  expect(observations).toBe(2);
});
