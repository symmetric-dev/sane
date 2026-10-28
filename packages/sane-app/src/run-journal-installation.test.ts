import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MetadataPublisher, captureMetadataDispatchBinding, type CommittedMetadataReceipt } from "./metadata-publication";
import { PendingActivationJournals } from "./pending-activation-journal";
import { prepareActivationWhileAdmitted, prepareRunJournalInstallation } from "./run-journal-installation";
import { RunJournalWriter } from "./run-journal";
import type { Event, Run, Session } from "./history";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/activation-installation-")); roots.push(directory);
  const storeId = crypto.randomUUID(), sessionId = crypto.randomUUID(), authorityId = `sane-native-v1:oc:${"c".repeat(64)}`;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt: new Date().toISOString() }));
  const meta = { version: 1, sessions: [] as Session[], runs: [] as Run[], reconciliationRequired: false };
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(meta));
  const failures: unknown[] = [], guards = { assertStorage() {}, failClosed: (error: unknown) => { failures.push(error); } };
  const writer = new RunJournalWriter(directory, guards), pending = new PendingActivationJournals(directory, storeId, writer, guards);
  const input = { sessionId, identity: { kind: "assistant" as const, role: "engineering" as const },
    activation: { saneExecution: { schema: 1 as const, revision: "a".repeat(64) }, saneContext: { version: 1, framework: "pinned framework", package: { schema: 1 as const, revision: "b".repeat(64), delivery: "standing-native-role" as const } } },
    source: { harnessId: "opencode" as const, authorityId, cwd: directory } };
  const run = (runId: string = crypto.randomUUID(), nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`): Run => ({ runId, sessionId, cwd: directory, createdAt: new Date().toISOString(), status: "running", nativeCommandId, nativePhase: "preparing", agent: "engineering", agentKind: "assistant", nativeAgentSelected: false });
  return { directory, storeId, meta, failures, guards, writer, pending, input, run };
}

test("the bridge installation seam retains actual preparation events and continues the same journal before metadata proof", async () => {
  const f = fixture(), publisher = new MetadataPublisher(f.directory, f.storeId, f.guards);
  let serial = Promise.resolve(), receipt: CommittedMetadataReceipt | undefined;
  const enqueue = (action: () => void) => serial = serial.then(action);
  let preparation!: ReturnType<PendingActivationJournals["prepare"]>;
  await enqueue(() => { preparation = f.pending.prepare(f.input); });
  const run = f.run(preparation.runId, preparation.nativeCommandId!);
  const session: Session = { sessionId: f.input.sessionId, harness: "opencode", authorityId: f.input.source.authorityId, nativeSessionId: "ses_fixture", cwd: f.directory,
    lastRunId: null, lastStatus: "unknown", agent: "engineering", agentKind: "assistant", nativeAgentSelected: false, ...f.input.activation };
  // The real bridge supplies its final ready-admission/lease assertion here.
  let admitted = true;
  const events = prepareRunJournalInstallation({ directory: f.directory, run, runs: f.meta.runs, hasEvents: () => false, isDeferred: () => false,
    hasPendingActivation: id => f.pending.hasPending(id), claimNew: target => f.writer.claimNew(target), preparation, assertPreparation: () => { expect(admitted).toBe(true); f.pending.assertCurrent(preparation, f.input); } });
  expect(events[0]).toBe(preparation.events[0]);
  session.lastRunId = run.runId; session.lastStatus = "running"; f.meta.sessions.push(session); f.meta.runs.push(run);
  const status = f.writer.reserve(run, events, "status", { status: "running" }); events.push(status.event);
  const statusCommit = enqueue(() => f.writer.commit(status));
  const snapshot = JSON.stringify(f.meta);
  const metadataCommit = enqueue(() => { receipt = publisher.commitSerialized(snapshot); });
  session.title = "Later mutable title";
  await statusCommit; await metadataCommit;
  const dispatch = { runId: run.runId, nativeCommandId: run.nativeCommandId!, source: { ...f.input.source, sessionId: session.sessionId, nativeSessionId: session.nativeSessionId! } };
  publisher.assertCommitted(receipt!, captureMetadataDispatchBinding(session, run, dispatch));
  const disk = readFileSync(join(f.directory, `${run.runId}.jsonl`), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  expect(disk.map(event => event.seq)).toEqual([1, 2]);
  expect(disk[0]).toEqual(preparation.events[0]!);
  expect(JSON.parse(readFileSync(join(f.directory, "metadata.json"), "utf8")).sessions[0].title).toBeUndefined();
  expect(f.meta.runs).toHaveLength(1);
  expect(f.failures).toEqual([]);
  admitted = false;
});

test("restart preparation is adopted without allocating new run or native command identities", () => {
  const f = fixture(), original = f.pending.prepare(f.input);
  const writer = new RunJournalWriter(f.directory, f.guards), pending = new PendingActivationJournals(f.directory, f.storeId, writer, f.guards);
  const restored = pending.prepare(f.input), run = f.run(restored.runId, restored.nativeCommandId!);
  expect(restored.runId).toBe(original.runId); expect(restored.nativeCommandId).toBe(original.nativeCommandId);
  const events = prepareRunJournalInstallation({ directory: f.directory, run, runs: [], hasEvents: () => false, isDeferred: () => false,
    hasPendingActivation: id => pending.hasPending(id), claimNew: target => writer.claimNew(target), preparation: restored, assertPreparation: () => pending.assertCurrent(restored, f.input) });
  const status = writer.reserve(run, events, "status", { status: "running" }); writer.commit(status);
  expect(status.event.seq).toBe(2);
  expect(events[0]).toBe(restored.events[0]);
});

test("another initial delivery cannot bypass an original pending activation with a fresh ID", () => {
  const f = fixture(); f.pending.prepare(f.input);
  expect(() => prepareRunJournalInstallation({ directory: f.directory, run: f.run(), runs: [], hasEvents: () => false, isDeferred: () => false,
    hasPendingActivation: id => f.pending.hasPending(id), claimNew: target => f.writer.claimNew(target) })).toThrow("original pending activation");
});

for (const kind of ["empty", "nonempty", "dangling-symlink"] as const) test(`fresh installation refuses an unexpected ${kind} journal rather than clearing it`, () => {
  const f = fixture(), run = f.run(), path = join(f.directory, `${run.runId}.jsonl`);
  if (kind === "dangling-symlink") symlinkSync(join(f.directory, "missing"), path); else writeFileSync(path, kind === "empty" ? "" : "unknown original bytes");
  expect(() => prepareRunJournalInstallation({ directory: f.directory, run, runs: [], hasEvents: () => false, isDeferred: () => false, hasPendingActivation: () => false, claimNew: target => f.writer.claimNew(target) })).toThrow("unexpected original journal");
});

test("missing namespace permits a genuinely fresh journal without a preparation claim", () => {
  const f = fixture();
  expect(prepareRunJournalInstallation({ directory: f.directory, run: f.run(), runs: [], hasEvents: () => false, isDeferred: () => false, hasPendingActivation: () => false, claimNew: target => f.writer.claimNew(target) })).toEqual([]);
});
test("a file appearing after fresh installation's absence check cannot be adopted by the first append", () => {
  const f = fixture(), run = f.run();
  const events = prepareRunJournalInstallation({ directory: f.directory, run, runs: [], hasEvents: () => false, isDeferred: () => false,
    hasPendingActivation: () => false, claimNew: target => f.writer.claimNew(target) });
  // Simulates a link callback or a writer during awaited harness preflight.
  const path = join(f.directory, `${run.runId}.jsonl`); writeFileSync(path, "");
  const first = f.writer.reserve(run, events, "status", { status: "running" });
  expect(() => f.writer.commit(first)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("");
  expect(f.failures.length).toBeGreaterThan(0);
});

test("changed lease and consumed Run refuse reinstallation without erasing preparation", () => {
  const f = fixture(), preparation = f.pending.prepare(f.input), run = f.run(preparation.runId, preparation.nativeCommandId!);
  const before = readFileSync(join(f.directory, `${run.runId}.jsonl`));
  const input = { directory: f.directory, run, runs: [] as Run[], hasEvents: () => false, isDeferred: () => false, hasPendingActivation: () => true, claimNew: (target: Run) => f.writer.claimNew(target), preparation,
    assertPreparation: () => { throw new Error("admission lease changed"); } };
  expect(() => prepareRunJournalInstallation(input)).toThrow("lease changed");
  expect(() => prepareRunJournalInstallation({ ...input, runs: [run] })).toThrow("already installed");
  expect(readFileSync(join(f.directory, `${run.runId}.jsonl`))).toEqual(before);
});

test("admission cancellation while queued is refused before preparation without poisoning storage", async () => {
  let admitted = true, prepared = false, storageFailed = false;
  const refusal = new Error("admission cancelled");
  const queued = Promise.resolve().then(() => prepareActivationWhileAdmitted(() => { if (!admitted) throw refusal; }, () => { prepared = true; }, error => error === refusal))
    .catch(error => { storageFailed = true; throw error; });
  admitted = false;
  expect(await queued).toEqual({ refused: refusal });
  expect(prepared).toBe(false); expect(storageFailed).toBe(false);
});

test("preparation and unexpected admission failures still escape to the existing fail-closed queue", () => {
  const failure = new Error("uncertain storage write");
  expect(() => prepareActivationWhileAdmitted(() => {}, () => { throw failure; }, () => true)).toThrow("uncertain storage write");
  expect(() => prepareActivationWhileAdmitted(() => { throw failure; }, () => {}, () => false)).toThrow("uncertain storage write");
});
