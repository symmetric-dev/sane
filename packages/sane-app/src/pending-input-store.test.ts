import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PendingInputStore, type PendingInputStoreDependencies } from "./pending-input-store";
import { PendingInputDomainError, PendingInputStorageError, type PendingInputAuthorization, type PendingInputClaimRequest, type PendingInputEnqueue, type PendingInputLiveValidation } from "./pending-input-contract";
import { atomicAppRecord } from "./app-store";
import { createDispatchEvidence } from "./dispatch-evidence";
import { decodePendingInputRecords, dispatchSource } from "./pending-input-codec";
import { isPendingInputSnapshot } from "../shared/conversation/pending-input-contract";
import type { DispatchIdentity, DispatchSubmission, DispatchNativeAcceptance } from "../shared/conversation/dispatch-contract";
import { id, pendingFixture, sibling } from "./pending-input-fixtures";
import { decodePreparedUserInput } from "./prepared-input-codec";
import { assertPreparedUserInputCurrent } from "./user-input-preparation";
import { seedAgentProfiles } from "./agent-profiles-contract";
import type { Session } from "./history";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides: Partial<PendingInputStoreDependencies> = {}) {
  const dir = realpathSync(mkdtempSync(join(TEMP, "pending-store-"))); dirs.push(dir); const storeId = id(), stages: PendingInputLiveValidation[] = [];
  const deps: PendingInputStoreDependencies = { validateLive: input => { stages.push(input); }, ...overrides };
  const store = new PendingInputStore(dir, storeId, deps);
  return { store, dir, storeId, stages, deps, reload: () => new PendingInputStore(dir, storeId, deps) };
}
function claimRequest(store: PendingInputStore, input: PendingInputEnqueue, itemId = store.lookup(input.request.conversationId, input.request.requestId)!.receipt.itemId): PendingInputClaimRequest {
  const c = store.inspect(input.request.conversationId), source = dispatchSource(input.snapshot);
  return { conversationId: input.request.conversationId, inputRequestId: input.request.requestId, itemId, expectedRevision: c.snapshot.revision, attemptId: id(), runId: id(), nativeCommandId: source.harnessId === "opencode" ? `msg_${id().replaceAll("-", "")}` : null,
    authorization: { kind: "dispatch", authorizationId: id(), chainId: c.chain!.chainId, predecessorRunId: c.lastPredecessorRunId, source } };
}
const evidence = (identity: DispatchIdentity, submission: DispatchSubmission, nativeAcceptance: DispatchNativeAcceptance = submission === "not-submitted" ? "not-accepted" : "unknown") => ({ ...identity, submission, nativeAcceptance });
const settlement = (store: PendingInputStore, identity: DispatchIdentity): PendingInputAuthorization => ({ kind: "settlement", authorizationId: id(), chainId: store.inspect(identity.source.sessionId).chain!.chainId, predecessorRunId: identity.runId, source: identity.source });
const removeRequest = (store: PendingInputStore, input: PendingInputEnqueue) => ({ version: 1 as const, requestId: id(), conversationId: input.request.conversationId, inputRequestId: input.request.requestId, itemId: store.lookup(input.request.conversationId, input.request.requestId)!.receipt.itemId });
const resumeRequest = (store: PendingInputStore, cid: string) => ({ version: 1 as const, requestId: id(), conversationId: cid, action: "resume" as const, expectedRevision: store.get(cid).revision });

test("optional absent file is empty, creates nothing, consumes no capacity/reservation", () => {
  const f = fixture(); expect(existsSync(join(f.dir, "pending-inputs.json"))).toBe(false);
  expect(f.store.get(id())).toMatchObject({ version: 1, revision: 0, paused: false, items: [], tombstones: [] }); expect(f.store.readRecords().nextSequence).toBe(1);
});
test("three concurrent serialized enqueues win, fourth fails without changing memory or revision", async () => {
  const f = fixture(), input = await pendingFixture(), all = [input, sibling(input), sibling(input), sibling(input)];
  const results = await Promise.allSettled(all.map(i => Promise.resolve().then(() => f.store.enqueue(i))));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3); expect(results[3]!.status).toBe("rejected");
  expect(f.store.get(input.request.conversationId).items.map(i => i.sequence)).toEqual([1, 2, 3]); expect(f.store.get(input.request.conversationId).revision).toBe(3); expect(f.store.readRecords().nextSequence).toBe(4);
});
test("claim frees a waiting slot but permits only one unresolved claim and preserves strict head order", async () => {
  const f = fixture(), input = await pendingFixture(), second = sibling(input); f.store.enqueue(input); f.store.enqueue(second); f.store.enqueue(sibling(input));
  const later = claimRequest(f.store, second); expect(() => f.store.claim(later)).toThrow("oldest");
  const claimed = f.store.claim(claimRequest(f.store, input)); expect(claimed.state).toBe("claimed"); f.store.enqueue(sibling(input));
  expect(f.store.get(input.request.conversationId).items).toHaveLength(4); expect(() => f.store.claim(claimRequest(f.store, second))).toThrow("unresolved claim");
  expect(isPendingInputSnapshot(f.store.get(input.request.conversationId))).toBe(true);
});
for (const harness of ["claude-code", "opencode"] as const) for (const setting of ["model", "effort"] as const) test(`${harness} queued ${setting} change is refused before write, claim or native effects`, async () => {
  let writes = 0, native = 0;
  const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); } });
  const old = setting === "model" ? "old-model" : harness === "opencode" ? "old variant" : "medium";
  const selected = setting === "model" ? "new-model" : harness === "opencode" ? " new variant " : "high";
  const input = await pendingFixture(harness, { [setting]: selected }, { [setting]: old });
  expect(decodePreparedUserInput(input.snapshot.prepared).configuration[setting]).toBe(selected);
  const before = f.store.readRecords();
  expect(() => {
    f.store.enqueue(input);
    const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
    f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); native++;
  }).toThrow("preserve the captured prior configuration");
  expect(writes).toBe(0); expect(native).toBe(0); expect(f.stages).toEqual([]);
  expect(f.store.readRecords()).toEqual(before); expect(existsSync(join(f.dir, "pending-inputs.json"))).toBe(false);
  // A malformed selector does not poison storage or prevent ordinary assertion-only admission.
  expect(f.store.enqueue(await pendingFixture(harness, {}, { [setting]: old })).outcome).toBe("enqueued");
});
for (const harness of ["claude-code", "opencode"] as const) test(`${harness} ordinary current-run preparation refills three waiters with the same linked chain`, async () => {
  const input = await pendingFixture(harness, {}, { model: "saved-model", effort: harness === "opencode" ? " native thinking " : "medium", agent: "engineering", agentKind: "assistant", nativeAgentSelected: false });
  const prepared = input.snapshot.prepared, b = prepared.binding;
  let current: Session = { sessionId: b.conversationId, harness, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId, cwd: b.cwd, lastRunId: null, lastStatus: "unknown", ...prepared.expectedPrior!.configuration };
  const f = fixture({ validateLive: value => assertPreparedUserInputCurrent(value.snapshot.prepared, { getSession: () => current, sourceAuthorityId: () => b.authorityId, profiles: seedAgentProfiles("2026-10-06T00:00:00.000Z") }) });
  f.store.enqueue(input); f.store.enqueue(sibling(input, "second")); f.store.enqueue(sibling(input, "third"));
  const chain = f.store.inspect(b.conversationId).chain!, claim = f.store.claim(claimRequest(f.store, input)), identity = claim.claim!.identity;
  // Simulate admission applying only the queue's existing configuration, followed
  // by Phase 3 preparing against the current queue-origin running conversation.
  current = { ...current, ...claim.snapshot.prepared.configuration, lastRunId: identity.runId, lastStatus: "running" };
  f.store.link(identity); f.store.validateActiveClaim(identity);
  const refill = await pendingFixture(harness, {}, current);
  refill.snapshot.pins = { ...structuredClone(input.snapshot.pins), configuration: refill.snapshot.prepared.expectedPrior!.configuration, launch: refill.snapshot.prepared.configuration };
  expect(refill.snapshot.prepared.requested).toEqual({});
  expect(refill.snapshot.pins).toEqual(chain.pins);
  f.store.enqueue(refill); f.store.validateActiveClaim(identity);
  const snapshot = f.store.get(b.conversationId);
  expect(snapshot.items.filter(i => i.state === "waiting")).toHaveLength(3);
  expect(snapshot.items.find(i => i.state === "run-linked")?.runId).toBe(identity.runId);
  expect(f.store.inspect(b.conversationId).chain!.chainId).toBe(chain.chainId);
  expect(f.store.lookup(b.conversationId, refill.request.requestId)!.item.chainId).toBe(chain.chainId);
});
test("duplicate original intent wins before capacity/live mutable state, and different payload conflicts", async () => {
  let denyLive = false; const f = fixture({ validateLive: () => { if (denyLive) throw new PendingInputDomainError("live-changed", "changed"); } }), input = await pendingFixture();
  const receipt = f.store.enqueue(input); f.store.enqueue(sibling(input)); f.store.enqueue(sibling(input)); const before = f.store.readRecords(); denyLive = true;
  const changedContext = structuredClone(input); (changedContext.snapshot as any).pins = { malformed: true };
  expect(f.store.enqueue(changedContext)).toEqual(receipt); expect(f.store.readRecords()).toEqual(before);
  const different = structuredClone(input); different.request = { ...different.request, text: "different" }; expect(() => f.store.enqueue(different)).toThrow("different intent");
});
test("original receipt dedups before decoding changed caller prior/launch, but new effective wire intent conflicts", async () => {
  let writes = 0;
  const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); } }), input = await pendingFixture("claude-code", {}, { model: "old-model" });
  const receipt = f.store.enqueue(input), before = f.store.readRecords(), priorWrites = writes, priorStages = f.stages.length;
  const replay = structuredClone(input);
  replay.snapshot.prepared = { ...replay.snapshot.prepared, configuration: { ...replay.snapshot.prepared.configuration, model: "new-model" } };
  replay.snapshot.pins.launch = { ...replay.snapshot.pins.launch, model: "new-model" };
  expect(f.store.enqueue(replay)).toEqual(receipt);
  const different = structuredClone(replay);
  different.request = { ...different.request, configuration: { ...different.request.configuration, model: "new-model" } };
  expect(() => f.store.enqueue(different)).toThrow("different intent");
  expect(f.store.readRecords()).toEqual(before); expect(writes).toBe(priorWrites); expect(f.stages).toHaveLength(priorStages);
});
test("identical text with different request IDs remains distinct; requested omission is part of intent", async () => {
  const f = fixture(), input = await pendingFixture(); const a = f.store.enqueue(input), b = f.store.enqueue(sibling(input)); expect(a.itemId).not.toBe(b.itemId);
  const explicit = structuredClone(input); explicit.snapshot.prepared = { ...explicit.snapshot.prepared, requested: { model: "same-effective-model" } };
  expect(() => f.store.enqueue(explicit)).toThrow("different intent");
});
for (const position of [0, 1, 2]) test(`paused removal independently removes waiting position ${position}, preserving siblings`, async () => {
  const f = fixture(), input = await pendingFixture(), all = [input, sibling(input, "middle"), sibling(input, "last")]; all.forEach(i => f.store.enqueue(i));
  f.store.pause(input.request.conversationId, { code: "hidden", reason: "Hidden, preserve text" }); const target = all[position]!, receipt = f.store.lookup(target.request.conversationId, target.request.requestId)!.receipt;
  const request = removeRequest(f.store, target), result = f.store.remove(request), before = f.store.readRecords();
  expect(result.outcome).toBe("removed"); expect(f.store.get(input.request.conversationId).items.map(i => i.text)).toEqual(all.filter((_, n) => n !== position).map(i => i.request.text));
  expect(f.store.get(input.request.conversationId).paused).toBe(true); expect(f.store.remove(request)).toEqual(result); expect(f.store.readRecords()).toEqual(before);
  expect(f.store.enqueue(target)).toEqual(receipt); expect(f.store.lookup(target.request.conversationId, target.request.requestId)!.classification).toBe("removed");
  expect(f.store.remove({ ...request, requestId: id() }).outcome).toBe("already-removed");
});
for (const claimFirst of [false, true]) test(`claim/remove have exactly one synchronous winner (claimFirst=${claimFirst})`, async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const claim = claimRequest(f.store, input), removal = removeRequest(f.store, input);
  if (claimFirst) { const result = f.store.claim(claim); expect(f.store.remove(removal)).toMatchObject({ outcome: "claimed", runId: result.claim!.identity.runId }); }
  else { f.store.remove(removal); expect(() => f.store.claim(claim)).toThrow("stale"); }
});
test("chain survives removal of every waiter while queue-origin execution remains unresolved", async () => {
  const f = fixture(), input = await pendingFixture(), next = sibling(input); f.store.enqueue(input); f.store.enqueue(next); const claim = f.store.claim(claimRequest(f.store, input)), chain = f.store.inspect(input.request.conversationId).chain;
  f.store.link(claim.claim!.identity); f.store.remove(removeRequest(f.store, next)); expect(f.store.inspect(input.request.conversationId).chain).toEqual(chain);
  const changed = sibling(input); (changed.snapshot.pins as any).admission.requestId = id(); expect(() => f.store.enqueue(changed)).toThrow("chain pins differ");
});
test("sequence and revision never reset after last removal, empty-chain restart or a new chain", async () => {
  const f = fixture(), input = await pendingFixture(); const receipt = f.store.enqueue(input); f.store.remove(removeRequest(f.store, input)); const revision = f.store.get(input.request.conversationId).revision;
  const reloaded = f.reload(), next = reloaded.enqueue(sibling(input)); expect(next.sequence).toBe(receipt.sequence + 1); expect(next.revision).toBe(revision + 1); expect(reloaded.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("removed");
});
test("request namespace includes enqueue/remove/resume and operation receipts are immutable", async () => {
  const f = fixture(), input = await pendingFixture(), second = sibling(input); f.store.enqueue(input); f.store.enqueue(second);
  expect(() => f.store.remove({ ...removeRequest(f.store, input), requestId: input.request.requestId })).toThrow("another operation");
  const removal = removeRequest(f.store, second); f.store.remove(removal); const collision = sibling(input); collision.request = { ...collision.request, requestId: removal.requestId }; expect(() => f.store.enqueue(collision)).toThrow("another operation");
  f.store.pause(input.request.conversationId, { code: "stopped", reason: "Stopped" }); const request = resumeRequest(f.store, input.request.conversationId), result = f.store.resume(request), before = f.store.readRecords();
  f.store.pause(input.request.conversationId, { code: "hidden", reason: "Hidden again" }); const pausedRevision = f.store.get(input.request.conversationId).revision;
  expect(f.store.resume(request)).toEqual(result); expect(f.store.get(input.request.conversationId).revision).toBe(pausedRevision); expect(f.store.get(input.request.conversationId).paused).toBe(true);
  expect(() => f.store.resume({ ...request, expectedRevision: before.conversations[0]!.revision })).toThrow("different intent");
  expect(() => f.store.remove({ ...removal, itemId: id() })).toThrow("different intent");
});
test("resume is observed-revision/live-chain bound and cannot clear an unresolved or uncertain claim", async () => {
  let blockResume = false; const f = fixture({ validateLive: input => { if (input.stage === "resume" && blockResume) throw new PendingInputDomainError("context-changed", "Live context changed"); } }), input = await pendingFixture(); f.store.enqueue(input);
  f.store.pause(input.request.conversationId, { code: "restart", reason: "Resume required" });
  expect(() => f.store.resume({ ...resumeRequest(f.store, input.request.conversationId), expectedRevision: 0 })).toThrow("stale");
  blockResume = true; expect(() => f.store.resume(resumeRequest(f.store, input.request.conversationId))).toThrow("Live context"); expect(f.store.get(input.request.conversationId).paused).toBe(true);
  blockResume = false; f.store.resume(resumeRequest(f.store, input.request.conversationId)); f.store.claim(claimRequest(f.store, input));
  expect(() => f.store.resume(resumeRequest(f.store, input.request.conversationId))).toThrow("unresolved claims");
  const loaded = f.reload(); loaded.recover(); expect(() => loaded.resume(resumeRequest(loaded, input.request.conversationId))).toThrow("unresolved claims");
});
test("transient busy is not a permanent pause category, and failed/hidden/stopped pauses preserve text", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input);
  expect(() => f.store.pause(input.request.conversationId, { code: "busy", reason: "ordinary contention" } as any)).toThrow(PendingInputDomainError);
  for (const code of ["failed", "hidden", "stopped"] as const) { f.store.pause(input.request.conversationId, { code, reason: code }); expect(f.store.get(input.request.conversationId).items[0]!.text).toBe(input.request.text); }
});
test("authorized settlement keeps original receipt/history and precise predecessor without resurrection", async () => {
  const f = fixture(), input = await pendingFixture(), second = sibling(input); const receipt = f.store.enqueue(input); f.store.enqueue(second);
  const item = f.store.claim(claimRequest(f.store, input)), identity = item.claim!.identity; f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); f.store.outcome(evidence(identity, "submitted"));
  const authorization = settlement(f.store, identity); f.store.settle(identity, "completed", authorization);
  expect(f.store.lookup(input.request.conversationId, input.request.requestId)).toMatchObject({ receipt, classification: "settled" }); expect(f.store.enqueue(input)).toEqual(receipt);
  expect(f.store.inspect(input.request.conversationId).lastPredecessorRunId).toBe(identity.runId); expect(f.store.inspect(input.request.conversationId).lastAuthorization).toEqual(authorization);
  const wrong = claimRequest(f.store, second); wrong.authorization.predecessorRunId = id(); expect(() => f.store.claim(wrong)).toThrow("last authorized predecessor");
  expect(f.store.claim(claimRequest(f.store, second)).state).toBe("claimed");
});
for (const stage of ["waiting", "claimed", "linked", "attempted", "submitted", "accepted", "unknown", "settled", "removed", "not-submitted"] as const) test(`crash/load at ${stage} preserves original identity and never resets/replays claims`, async () => {
  const f = fixture(), input = await pendingFixture("opencode"), receipt = f.store.enqueue(input); let identity: DispatchIdentity | undefined;
  if (stage === "removed") f.store.remove(removeRequest(f.store, input));
  else if (stage !== "waiting") {
    identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
    if (stage !== "claimed") f.store.link(identity);
    if (!["claimed", "linked", "not-submitted"].includes(stage)) f.store.beforeNative(evidence(identity, "attempted"));
    if (["submitted", "settled"].includes(stage)) f.store.outcome(evidence(identity, "submitted"));
    if (stage === "accepted") f.store.outcome(evidence(identity, "submitted", "accepted"));
    if (stage === "unknown") f.store.outcome(evidence(identity, "unknown"));
    if (stage === "settled") f.store.settle(identity, "completed", settlement(f.store, identity));
    if (stage === "not-submitted") { f.store.outcome(evidence(identity, "not-submitted")); f.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity }); }
  }
  const before = readFileSync(join(f.dir, "pending-inputs.json"), "utf8"), loaded = f.reload(); expect(readFileSync(join(f.dir, "pending-inputs.json"), "utf8")).toBe(before);
  expect(loaded.enqueue(input)).toEqual(receipt); loaded.recover(); const status = loaded.lookup(input.request.conversationId, input.request.requestId)!;
  const terminal = ["settled", "removed", "not-submitted"].includes(stage);
  if (!terminal && stage !== "waiting") { expect(status.classification).toBe("uncertain"); expect(status.item.claim!.identity).toEqual(identity!); expect(() => loaded.validateClaim(identity!)).toThrow(); expect(() => loaded.resume(resumeRequest(loaded, input.request.conversationId))).toThrow("unresolved claims"); }
  else if (stage === "waiting") { expect(loaded.get(input.request.conversationId).paused).toBe(true); loaded.resume(resumeRequest(loaded, input.request.conversationId)); expect(loaded.get(input.request.conversationId).paused).toBe(false); }
  else expect(status.classification).toBe(stage === "removed" ? "removed" : "settled");
  expect(status.receipt).toEqual(receipt);
});
test("source-correlated evidence forbids false acceptance, reversals, mismatches and repeated native attempts", async () => {
  const f = fixture(), input = await pendingFixture("opencode"); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity);
  expect(() => f.store.outcome(evidence(identity, "submitted", "accepted"))).toThrow();
  f.store.beforeNative(evidence(identity, "attempted")); expect(() => f.store.beforeNative(evidence(identity, "attempted"))).toThrow("never-attempted");
  expect(() => f.store.outcome(evidence({ ...identity, runId: id() }, "submitted", "accepted"))).toThrow("claim identity");
  expect(() => f.store.hooks({ ...identity, runId: id() }).outcome!(evidence(identity, "submitted", "accepted"))).toThrow("identity mismatch");
  expect(() => f.store.outcome(evidence(identity, "not-submitted"))).toThrow();
  f.store.outcome(evidence(identity, "submitted", "accepted")); expect(() => f.store.outcome(evidence(identity, "unknown"))).toThrow("reversed");
  const before = f.store.readRecords(); expect(() => f.store.settle(identity, "completed", { ...settlement(f.store, identity), predecessorRunId: id() })).toThrow("exact source/run"); expect(f.store.readRecords()).toEqual(before);
});
test("CC delivery does not become fabricated native acceptance; explicit non-submission archival never retries", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity);
  expect(() => f.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity })).toThrow("adapter non-submission");
  f.store.outcome(evidence(identity, "not-submitted")); f.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity });
  expect(f.store.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("settled"); expect(f.store.enqueue(input).sequence).toBe(1);
  const next = sibling(input); f.store.enqueue(next); f.store.resume(resumeRequest(f.store, input.request.conversationId)); const cc = f.store.claim(claimRequest(f.store, next)).claim!.identity; f.store.link(cc); f.store.beforeNative(evidence(cc, "attempted"));
  expect(() => f.store.outcome(evidence(cc, "submitted", "accepted"))).toThrow("native acceptance");
});
for (const boundary of ["enqueue", "claim", "link", "before-native", "outcome", "settlement", "recover"] as const) test(`atomic failure at ${boundary} publishes no memory state or native-hook progress`, async () => {
  let fail = false; const f = fixture({ write: (dir, name, value) => { if (fail) throw new Error("injected disk failure"); atomicAppRecord(dir, name, value); } }), input = await pendingFixture("opencode");
  let identity: DispatchIdentity | undefined;
  if (boundary !== "enqueue") f.store.enqueue(input);
  if (!["enqueue", "claim", "recover"].includes(boundary)) identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  if (["before-native", "outcome", "settlement"].includes(boundary)) f.store.link(identity!);
  if (["outcome", "settlement"].includes(boundary)) f.store.beforeNative(evidence(identity!, "attempted"));
  if (boundary === "settlement") f.store.outcome(evidence(identity!, "submitted", "accepted"));
  const store = boundary === "recover" ? f.reload() : f.store, before = store.readRecords(); fail = true;
  const action = () => {
    if (boundary === "enqueue") return store.enqueue(input);
    if (boundary === "claim") return store.claim(claimRequest(store, input));
    if (boundary === "link") return store.link(identity!);
    if (boundary === "before-native") return store.beforeNative(evidence(identity!, "attempted"));
    if (boundary === "outcome") return store.outcome(evidence(identity!, "submitted", "accepted"));
    if (boundary === "settlement") return store.settle(identity!, "completed", settlement(store, identity!));
    return store.recover();
  };
  expect(action).toThrow(PendingInputStorageError); expect(store.readRecords()).toEqual(before);
  expect(() => store.pause(input.request.conversationId, { code: "failed", reason: "Storage blocked" })).toThrow(PendingInputStorageError);
});
test("Phase 1 hooks durably precede possible native execution and write failures stop before boundary", async () => {
  let fail = false, native = 0, closed = 0; const f = fixture({ write: (dir, name, value) => { if (fail) throw new Error("before-send persistence failed"); atomicAppRecord(dir, name, value); } }), input = await pendingFixture(); f.store.enqueue(input);
  const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity);
  const controller = createDispatchEvidence(identity, f.store.hooks(identity), () => closed++), before = f.store.readRecords(); fail = true;
  expect(() => { controller.beforeNative(); native++; }).toThrow(PendingInputStorageError); expect(native).toBe(0); expect(closed).toBe(1); expect(controller.snapshot().submission).toBe("not-submitted"); expect(f.store.readRecords()).toEqual(before);
});
test("a post-rename write failure latches storage; restart classifies persisted attempt conservatively", async () => {
  let fail = false, writes = 0, closed = 0, native = 0; const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); if (fail) throw new Error("directory sync failed after rename"); } }), input = await pendingFixture(); f.store.enqueue(input);
  const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity); const before = f.store.readRecords(); fail = true;
  const controller = createDispatchEvidence(identity, f.store.hooks(identity), () => closed++);
  expect(() => { controller.beforeNative(); native++; }).toThrow(PendingInputStorageError); expect(f.store.readRecords()).toEqual(before); expect(closed).toBe(1); expect(native).toBe(0);
  const disk = JSON.parse(readFileSync(join(f.dir, "pending-inputs.json"), "utf8")), afterWrites = writes;
  expect(disk.conversations[0].revision).toBe(before.conversations[0]!.revision + 1);
  expect(disk.conversations[0].items[0].claim).toMatchObject({ identity, possibleNative: true, evidence: { submission: "attempted" } });
  expect(() => f.store.beforeNative(evidence(identity, "attempted"))).toThrow(PendingInputStorageError);
  expect(() => f.store.validateActiveClaim(identity)).toThrow(PendingInputStorageError); expect(writes).toBe(afterWrites);
  fail = false; const reloaded = f.reload(); expect(reloaded.readRecords()).toEqual(disk); expect(reloaded.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("uncertain");
  reloaded.recover(); expect(reloaded.lookup(input.request.conversationId, input.request.requestId)!.item.claim).toMatchObject({ identity, possibleNative: true, uncertain: true });
  expect(() => reloaded.beforeNative(evidence(identity, "attempted"))).toThrow(PendingInputDomainError);
});
test("live callbacks cannot reenter publication or mutate pinned snapshots", async () => {
  const input = await pendingFixture(); let store: PendingInputStore, reentrant = 0;
  const f = fixture({ validateLive: value => { expect(Object.isFrozen(value.snapshot.prepared.configuration)).toBe(true); try { store.enqueue(sibling(input)); } catch (error) { if (error instanceof PendingInputDomainError && error.code === "pending-input-reentrant") reentrant++; else throw error; } } }); store = f.store;
  store.enqueue(input); expect(reentrant).toBe(1); expect(store.get(input.request.conversationId).items).toHaveLength(1);
});
test("actual enqueue dedup is canonical and both caller and returned clones are independent", async () => {
  const f = fixture(), input = await pendingFixture(), original = structuredClone(input), receipt = f.store.enqueue(input);
  const reordered = structuredClone(original); reordered.request = Object.fromEntries(Object.entries(reordered.request).reverse()) as any;
  expect(f.store.enqueue(reordered)).toEqual(receipt);
  (input.snapshot.pins as any).catalog.cwd = "/changed"; (input.request as any).text = "changed";
  expect(f.store.lookup(original.request.conversationId, original.request.requestId)!.item.snapshot).toEqual(original.snapshot);
  expect(Object.isFrozen(f.store.get(original.request.conversationId).items[0]!.source)).toBe(true);
  const different = structuredClone(original); different.snapshot.prepared = { ...different.snapshot.prepared, nativeStopped: true };
  expect(() => f.store.enqueue(different)).toThrow("different intent");
});
test("claim validation delegates exact identity, pins and revision, and cannot be used twice", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const request = claimRequest(f.store, input), claim = f.store.claim(request).claim!;
  expect(f.stages.find(i => i.stage === "claim")).toMatchObject({ identity: claim.identity, authorization: request.authorization, revision: request.expectedRevision, snapshot: input.snapshot });
  f.store.validateClaim(claim.identity); f.store.link(claim.identity); expect(() => f.store.validateClaim(claim.identity)).toThrow("one-shot");
});
test("Phase 1 withheld evidence can archive an unlinked claim only with explicit validation", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  const controller = createDispatchEvidence(identity, f.store.hooks(identity), error => { throw error; }); controller.withheld(); controller.finish();
  expect(f.store.lookup(input.request.conversationId, input.request.requestId)!.item.claim!.evidence?.submission).toBe("not-submitted");
  expect(() => f.store.link(identity)).toThrow("unsubmitted exact claim");
  f.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity }); expect(f.store.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("settled");
});
test("unlinked legacy adapter unknown outcome blocks, persists, and never becomes a waiting item", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  const controller = createDispatchEvidence(identity, f.store.hooks(identity), error => { throw error; }); controller.finish();
  expect(f.store.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("uncertain");
  const loaded = f.reload(); loaded.recover(); expect(loaded.reconciliationWork()[0]!.claim!.identity).toEqual(identity);
  expect(() => loaded.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity })).toThrow("adapter non-submission");
});
test("settled removal is claimed-not-cancelled and its operation receipt survives restart", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); f.store.outcome(evidence(identity, "submitted")); f.store.settle(identity, "completed", settlement(f.store, identity));
  const request = removeRequest(f.store, input), result = f.store.remove(request); expect(result).toMatchObject({ outcome: "claimed", runId: identity.runId });
  const loaded = f.reload(), records = loaded.readRecords(); expect(loaded.remove(request)).toEqual(result); expect(loaded.readRecords()).toEqual(records); expect(loaded.get(input.request.conversationId).tombstones).toEqual([]);
});
for (const status of ["failed", "interrupted"] as const) test(`${status} settlement preserves waiting text and requires explicit resume`, async () => {
  const f = fixture(), input = await pendingFixture(), next = sibling(input); f.store.enqueue(input); f.store.enqueue(next); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); f.store.outcome(evidence(identity, "submitted")); f.store.settle(identity, status, settlement(f.store, identity));
  expect(f.store.inspect(input.request.conversationId).pause?.code).toBe(status === "failed" ? "failed" : "stopped"); expect(f.store.get(input.request.conversationId).items[0]!.text).toBe(next.request.text);
  expect(() => f.store.claim(claimRequest(f.store, next))).toThrow(PendingInputDomainError); f.store.resume(resumeRequest(f.store, input.request.conversationId)); expect(f.store.claim(claimRequest(f.store, next)).state).toBe("claimed");
});
test("readiness authorization resolves recovered evidence but never clears a safety pause automatically", async () => {
  const f = fixture(), input = await pendingFixture("opencode"), next = sibling(input); f.store.enqueue(input); f.store.enqueue(next); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); f.store.outcome(evidence(identity, "unknown")); const loaded = f.reload(); loaded.recover();
  loaded.outcome(evidence(identity, "submitted", "accepted")); expect(loaded.lookup(input.request.conversationId, input.request.requestId)!.classification).toBe("uncertain");
  loaded.settle(identity, "completed", settlement(loaded, identity)); expect(loaded.get(input.request.conversationId).paused).toBe(true);
  loaded.resume(resumeRequest(loaded, input.request.conversationId)); expect(loaded.claim(claimRequest(loaded, next)).state).toBe("claimed");
});
test("async live validation and invariant exceptions are storage errors, not safe retry refusals", async () => {
  const input = await pendingFixture();
  for (const validateLive of [async () => {}, () => { throw new Error("invariant/cross-store failure"); }]) {
    const f = fixture({ validateLive }), before = f.store.readRecords(); expect(() => f.store.enqueue(input)).toThrow(PendingInputStorageError);
    expect(f.store.readRecords()).toEqual(before); expect(existsSync(join(f.dir, "pending-inputs.json"))).toBe(false);
    expect(() => f.store.enqueue(sibling(input))).toThrow(PendingInputStorageError);
  }
});
test("asynchronous durable writer is refused without publication", async () => {
  const f = fixture({ write: async () => {} }), input = await pendingFixture(); expect(() => f.store.enqueue(input)).toThrow(PendingInputStorageError); expect(f.store.get(input.request.conversationId).items).toEqual([]);
});
test("duplicate operation receipts do not run live validation or increment revision after recovery", async () => {
  const f = fixture(), input = await pendingFixture(), next = sibling(input); f.store.enqueue(input); f.store.enqueue(next); f.store.pause(input.request.conversationId, { code: "hidden", reason: "Hidden" });
  const resume = resumeRequest(f.store, input.request.conversationId), resumed = f.store.resume(resume), removal = removeRequest(f.store, next), removed = f.store.remove(removal);
  const loaded = f.reload(), before = loaded.readRecords(); expect(loaded.resume(resume)).toEqual(resumed); expect(loaded.remove(removal)).toEqual(removed); expect(loaded.readRecords()).toEqual(before);
  loaded.recover(); const after = loaded.readRecords(); expect(loaded.resume(resume)).toEqual(resumed); expect(loaded.remove(removal)).toEqual(removed); expect(loaded.readRecords()).toEqual(after); expect(loaded.get(input.request.conversationId).paused).toBe(true);
});
test("pause between claim and native boundary prevents execution without discarding claim identities", async () => {
  const f = fixture(), input = await pendingFixture(); f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity);
  f.store.pause(input.request.conversationId, { code: "stopped", reason: "Operator stopped" }); expect(() => f.store.beforeNative(evidence(identity, "attempted"))).toThrow("Operator stopped");
  expect(f.store.lookup(input.request.conversationId, input.request.requestId)!.item.claim!.possibleNative).toBe(false);
  f.store.outcome(evidence(identity, "not-submitted")); f.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity }); expect(f.store.get(input.request.conversationId).paused).toBe(true);
});
for (const mutation of ["remove", "resume", "pause", "archive"] as const) test(`durable failure during ${mutation} cannot publish mutation or operation receipt`, async () => {
  let fail = false; const f = fixture({ write: (dir, name, value) => { if (fail) throw new Error("failed mutation"); atomicAppRecord(dir, name, value); } }), input = await pendingFixture(); f.store.enqueue(input);
  let identity: DispatchIdentity | undefined;
  if (mutation === "resume") f.store.pause(input.request.conversationId, { code: "hidden", reason: "Hidden" });
  if (mutation === "archive") { identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.outcome(evidence(identity, "not-submitted")); }
  const before = f.store.readRecords(); fail = true;
  expect(() => {
    if (mutation === "remove") f.store.remove(removeRequest(f.store, input));
    if (mutation === "resume") f.store.resume(resumeRequest(f.store, input.request.conversationId));
    if (mutation === "pause") f.store.pause(input.request.conversationId, { code: "failed", reason: "Failed" });
    if (mutation === "archive") f.store.archiveNotSubmitted(identity!, { kind: "definitely-not-submitted", identity: identity! });
  }).toThrow(PendingInputStorageError); expect(f.store.readRecords()).toEqual(before);
});
test("request IDs are namespaced by conversation, while native owners and run IDs are not duplicated", async () => {
  const f = fixture(), first = await pendingFixture(), second = await pendingFixture(); f.store.enqueue(first); second.request = { ...second.request, requestId: first.request.requestId }; f.store.enqueue(second);
  const identity = f.store.claim(claimRequest(f.store, first)).claim!.identity, collision = claimRequest(f.store, second); collision.runId = identity.runId;
  expect(() => f.store.claim(collision)).toThrow("already used");
  const alias = await pendingFixture("claude-code", {}, { nativeSessionId: first.request.source.nativeSessionId! });
  expect(() => f.store.enqueue(alias)).toThrow("another App conversation"); expect(f.store.readRecords().conversations).toHaveLength(2);
});
test("strict load codec rejects forged claim/evidence, chain summaries and operation crosslinks", async () => {
  const f = fixture(), input = await pendingFixture("opencode"), second = sibling(input); f.store.enqueue(input); f.store.enqueue(second);
  const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity); f.store.beforeNative(evidence(identity, "attempted")); f.store.outcome(evidence(identity, "submitted", "accepted")); f.store.settle(identity, "completed", settlement(f.store, identity));
  f.store.remove(removeRequest(f.store, second)); const pristine = f.store.readRecords();
  const corrupt: Array<(r: any) => void> = [
    r => r.conversations[0].items[0].claim.identity.runId = id(),
    r => r.conversations[0].items[0].claim.identity.source.nativeSessionId = `ses_${id()}`,
    r => r.conversations[0].items[0].claim.possibleNative = false,
    r => r.conversations[0].items[0].claim.evidence.nativeAcceptance = "not-accepted",
    r => r.conversations[0].items[0].claim.evidence.extra = true,
    r => r.conversations[0].items[0].claim.uncertain = true,
    r => r.conversations[0].items[0].history.authorization.predecessorRunId = id(),
    r => r.conversations[0].lastAuthorization = null,
    r => r.conversations[0].items[1].snapshot.pins.admission.requestId = id(),
    r => r.conversations[0].operations[0].result.itemId = id(),
    r => r.conversations[0].operations[0].result.requestId = id(),
    r => r.conversations[0].operations[0].request.requestId = input.request.requestId,
  ];
  for (const mutate of corrupt) { const raw = structuredClone(pristine); mutate(raw); expect(() => decodePendingInputRecords(raw, f.storeId)).toThrow(); }
});
for (const harness of ["claude-code", "opencode"] as const) test(`${harness} linked withheld outcome cannot become native intent under the same claim`, async () => {
  let writes = 0; const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); } }), input = await pendingFixture(harness);
  f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity); f.store.outcome(evidence(identity, "not-submitted", "not-accepted"));
  const before = f.store.readRecords(), revision = f.store.get(input.request.conversationId).revision, priorWrites = writes, disk = readFileSync(join(f.dir, "pending-inputs.json"), "utf8");
  expect(() => f.store.beforeNative(evidence(identity, "attempted"))).toThrow("no prior evidence");
  expect(() => f.store.outcome(evidence(identity, "unknown"))).toThrow("cannot be reversed");
  expect(f.store.readRecords()).toEqual(before); expect(f.store.get(input.request.conversationId).revision).toBe(revision); expect(writes).toBe(priorWrites); expect(readFileSync(join(f.dir, "pending-inputs.json"), "utf8")).toBe(disk);
});
test("outcome cannot synthesize or replace attempt intent; only beforeNative journals it", async () => {
  let writes = 0; const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); } }), input = await pendingFixture("opencode");
  f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity;
  for (const linked of [false, true]) {
    if (linked) f.store.link(identity);
    const before = f.store.readRecords(), priorWrites = writes;
    expect(() => f.store.outcome(evidence(identity, "attempted"))).toThrow(PendingInputDomainError); expect(f.store.readRecords()).toEqual(before); expect(writes).toBe(priorWrites);
  }
  f.store.beforeNative(evidence(identity, "attempted")); const before = f.store.readRecords(), priorWrites = writes;
  expect(() => f.store.outcome(evidence(identity, "attempted"))).toThrow("Only beforeNative"); expect(f.store.readRecords()).toEqual(before); expect(writes).toBe(priorWrites);
  f.store.outcome(evidence(identity, "submitted")); f.store.outcome(evidence(identity, "submitted", "accepted"));
  const accepted = f.store.readRecords(), acceptedWrites = writes;
  for (const e of [evidence(identity, "unknown"), evidence(identity, "submitted", "unknown"), evidence(identity, "attempted")]) {
    expect(() => f.store.outcome(e)).toThrow(PendingInputDomainError); expect(f.store.readRecords()).toEqual(accepted); expect(writes).toBe(acceptedWrites);
  }
});
test("validateActiveClaim supports repeated Phase 1 callbacks before and after link without writes", async () => {
  let writes = 0; const f = fixture({ write: (dir, name, value) => { writes++; atomicAppRecord(dir, name, value); } }), input = await pendingFixture("opencode");
  f.store.enqueue(input); const claimed = f.store.claim(claimRequest(f.store, input)), claim = claimed.claim!, identity = claim.identity;
  const check = () => {
    const before = f.store.readRecords(), priorWrites = writes;
    f.store.validateActiveClaim(identity); f.store.validateActiveClaim(identity);
    expect(f.store.readRecords()).toEqual(before); expect(writes).toBe(priorWrites);
    expect(f.stages.at(-1)).toMatchObject({ stage: "active-claim", identity, authorization: claim.authorization, snapshot: input.snapshot, chainId: claimed.chainId, revision: f.store.get(input.request.conversationId).revision });
  };
  check(); f.store.link(identity); check(); expect(() => f.store.link(identity)).toThrow(PendingInputDomainError);
  f.store.beforeNative(evidence(identity, "attempted")); check(); expect(() => f.store.beforeNative(evidence(identity, "attempted"))).toThrow(PendingInputDomainError);
  f.store.outcome(evidence(identity, "submitted", "accepted")); check(); f.store.settle(identity, "completed", settlement(f.store, identity));
  expect(() => f.store.validateActiveClaim(identity)).toThrow("unresolved claim identity");
});
test("validateActiveClaim rejects changed identities and passes live context-proof refusal without mutation", async () => {
  let blocked = false; const f = fixture({ validateLive: value => { if (blocked && value.stage === "active-claim") throw new PendingInputDomainError("context-changed", "Exact original context proof no longer valid"); } }), input = await pendingFixture("opencode");
  f.store.enqueue(input); const identity = f.store.claim(claimRequest(f.store, input)).claim!.identity; f.store.link(identity); const before = f.store.readRecords();
  for (const changed of [
    { ...identity, runId: id() }, { ...identity, nativeCommandId: `msg_${id()}` }, { ...identity, requestId: id() },
    { ...identity, source: { ...identity.source, nativeSessionId: `ses_${id()}` } }, { ...identity, source: { ...identity.source, authorityId: `sane-native-v1:oc:${"b".repeat(64)}` } }, { ...identity, source: { ...identity.source, cwd: "/another-checkout" } },
  ]) expect(() => f.store.validateActiveClaim(changed)).toThrow(PendingInputDomainError);
  blocked = true; expect(() => f.store.validateActiveClaim(identity)).toThrow("context proof"); expect(f.store.readRecords()).toEqual(before);
  blocked = false; const loaded = f.reload(); expect(() => loaded.validateActiveClaim(identity)).toThrow("Startup classification"); loaded.recover(); expect(() => loaded.validateActiveClaim(identity)).toThrow(PendingInputDomainError);
});
for (const unsafe of ["malformed", "symlink", "hardlink", "directory", "wrong-store", "unknown-keys"] as const) test(`optional load refuses ${unsafe}, never treating it as empty`, () => {
  const f = fixture(), path = join(f.dir, "pending-inputs.json"), record = { version: 1, storeId: f.storeId, nextSequence: 1, conversations: [] };
  if (unsafe === "malformed") writeFileSync(path, "{broken");
  else if (unsafe === "directory") mkdirSync(path);
  else if (unsafe === "symlink" || unsafe === "hardlink") { const target = join(f.dir, "target.json"); writeFileSync(target, JSON.stringify(record)); if (unsafe === "symlink") symlinkSync(target, path); else linkSync(target, path); }
  else writeFileSync(path, JSON.stringify(unsafe === "wrong-store" ? { ...record, storeId: id() } : { ...record, future: true }));
  expect(() => f.reload()).toThrow(PendingInputStorageError);
});
