import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { validateMetadata, type Metadata, type Run, type Session } from "./history";
import { captureMetadataDispatchBinding, MetadataCommitProofError, MetadataPublisher, type CommittedMetadataReceipt } from "./metadata-publication";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(harness: "opencode" | "claude-code" = "opencode", configured = true) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/metadata-publication-test-")); roots.push(root);
  const storeId = crypto.randomUUID(), createdAt = "2026-10-25T10:00:00.000Z";
  const run: Run = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID(), cwd: root, status: "running", createdAt,
    ...(harness === "opencode" ? { nativeCommandId: "msg_metadata", nativePhase: "preparing" as const } : {}),
    ...(configured ? { agent: "engineering", agentKind: "assistant", nativeAgentSelected: true, profileId: "template:engineering", model: "test-model", effort: "high", saneExecution: { schema: 1, revision: "b".repeat(64) }, saneContextVersion: 1 } as const : {}) };
  const session: Session = { sessionId: run.sessionId, harness, nativeSessionId: harness === "opencode" ? "ses_metadata" : crypto.randomUUID(),
    authorityId: `sane-native-v1:${harness === "opencode" ? "oc" : "cc"}:${"a".repeat(64)}`, cwd: root, lastRunId: run.runId, lastStatus: run.status,
    ...(configured ? { agent: "engineering", agentKind: "assistant", nativeAgentSelected: true, profileId: "template:engineering", model: "test-model", effort: "high",
      saneExecution: { schema: 1, revision: "b".repeat(64) }, attachment: { state: "ready", source: "native" },
      saneContext: { version: 1, framework: "exact framework", package: { schema: 1, revision: "c".repeat(64), delivery: "standing-native-role" } } } as const : {}) };
  const metadata = { version: 1, sessions: [session], runs: [run], reconciliationRequired: false };
  validateMetadata(metadata);
  const dispatch: DispatchIdentity = { source: { harnessId: harness, sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!, authorityId: session.authorityId!, cwd: root },
    runId: run.runId, nativeCommandId: run.nativeCommandId ?? null };
  const path = join(root, "metadata.json"), manifestPath = join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt }), { mode: 0o600 });
  fs.writeFileSync(path, JSON.stringify(metadata), { mode: 0o600 });
  const failures: unknown[] = [];
  let guard: () => void = () => {}, fail: (error: unknown) => void = error => { failures.push(error); };
  const deps = { assertStorage: () => guard(), failClosed: (error: unknown) => fail(error) };
  const publisher = new MetadataPublisher(root, storeId, deps);
  return { root, storeId, metadata, session, run, dispatch, path, manifestPath, publisher, failures, deps,
    binding: () => captureMetadataDispatchBinding(session, run, dispatch),
    serialize: () => JSON.stringify(metadata),
    guard: (action: () => void) => { guard = action; }, fail: (action: (error: unknown) => void) => { fail = action; } };
}
const absent = {} as CommittedMetadataReceipt;

describe("bridge-owned synchronous metadata publication", () => {
  test("real exact-byte publication fsyncs file then directory and returns an opaque frozen receipt", () => {
    const f = fixture(), bytes = JSON.stringify(f.metadata, null, 2) + "\n", previous = fs.statSync(f.path);
    const sync = fs.fsyncSync, order: string[] = [];
    const spy = spyOn(fs, "fsyncSync").mockImplementation(fd => { order.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); sync(fd); });
    let receipt: CommittedMetadataReceipt;
    try { receipt = f.publisher.commitSerialized(bytes); } finally { spy.mockRestore(); }
    expect(order).toEqual(["file", "directory"]);
    expect(fs.readFileSync(f.path, "utf8")).toBe(bytes);
    expect(fs.statSync(f.path).ino).not.toBe(previous.ino);
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
    expect(Object.isFrozen(receipt!)).toBe(true); expect(Reflect.ownKeys(receipt!)).toEqual([]);
    f.publisher.assertCommitted(receipt!, f.binding());
    expect(f.failures).toEqual([]);
  });

  test("same-byte publications still mint distinct original receipts; copies and foreign receipts cannot prove them", () => {
    const f = fixture(), g = fixture(), first = f.publisher.commitSerialized(f.serialize()), inode = fs.statSync(f.path).ino;
    const second = f.publisher.commitSerialized(f.serialize());
    expect(second).not.toBe(first); expect(fs.statSync(f.path).ino).not.toBe(inode);
    f.publisher.assertCommitted(first, f.binding()); f.publisher.assertCommitted(second, f.binding());
    const foreign = g.publisher.commitSerialized(g.serialize());
    for (const receipt of [absent, { ...first }, structuredClone(first), foreign, undefined, null]) {
      expect(() => f.publisher.assertCommitted(receipt as CommittedMetadataReceipt, f.binding())).toThrow(MetadataCommitProofError);
    }
    expect(f.failures).toEqual([]); f.publisher.assertCommitted(second, f.binding());
  });

  test("initial disk bytes and queued snapshots never mint proof, and a queue fence is not provided", () => {
    const f = fixture();
    let latest: CommittedMetadataReceipt | undefined;
    const captured = f.serialize(), queued = () => { latest = f.publisher.commitSerialized(captured); };
    expect(() => f.publisher.assertCommitted(latest!, f.binding())).toThrow("publication may still be queued");
    expect(Object.keys(f.publisher)).toEqual([]);
    queued(); f.publisher.assertCommitted(latest!, f.binding());
    expect(f.failures).toEqual([]);
  });

  test("enqueue-time serialized bytes and trusted binding survive later live-object mutations", () => {
    const f = fixture(), captured = f.serialize(), binding = f.binding();
    f.session.saneContext!.framework = "mutated"; f.run.model = "other-model";
    const receipt = f.publisher.commitSerialized(captured);
    expect(fs.readFileSync(f.path, "utf8")).toBe(captured);
    expect(binding.session.saneContext!.framework).toBe("exact framework");
    expect(Object.isFrozen(binding.session.saneContext)).toBe(true);
    f.publisher.assertCommitted(receipt, binding);
    expect(() => f.publisher.assertCommitted(receipt, f.binding())).toThrow(MetadataCommitProofError);
  });

  test("title/status/native progress and unrelated sessions do not invalidate matching config", () => {
    const f = fixture(), binding = f.binding(), original = f.publisher.commitSerialized(f.serialize());
    f.session.title = "New title"; f.session.hidden = true; f.session.titleRevision = 1;
    f.run.nativePhase = "accepted"; f.run.nativeAcceptedAt = Date.now();
    f.run.status = "completed"; f.run.endedAt = "2026-10-25T10:01:00.000Z"; f.session.lastStatus = "completed";
    f.metadata.reconciliationRequired = true;
    f.metadata.sessions.push({ sessionId: crypto.randomUUID(), harness: "opencode", nativeSessionId: "ses_unrelated", authorityId: f.session.authorityId!, cwd: f.root, lastRunId: null, lastStatus: "unknown" });
    const latest = f.publisher.commitSerialized(f.serialize());
    f.publisher.assertCommitted(original, binding); f.publisher.assertCommitted(latest, binding);
    expect(f.failures).toEqual([]);
  });

  const configChanges: [string, (metadata: Metadata) => void][] = [
    ["source authority", m => { m.sessions[0]!.authorityId = `sane-native-v1:oc:${"d".repeat(64)}`; }],
    ["source native ID", m => { m.sessions[0]!.nativeSessionId = "ses_changed"; }],
    ["source harness", m => { Object.assign(m.sessions[0]!, { harness: "claude-code", nativeSessionId: crypto.randomUUID(), authorityId: `sane-native-v1:cc:${"a".repeat(64)}` }); }],
    ["source app ID", m => { m.sessions[0]!.sessionId = crypto.randomUUID(); m.runs[0]!.sessionId = m.sessions[0]!.sessionId; }],
    ["source cwd", m => { m.sessions[0]!.cwd += "/other"; m.runs[0]!.cwd += "/other"; }],
    ["session model", m => { m.sessions[0]!.model = "other"; }],
    ["session model omitted", m => { delete m.sessions[0]!.model; }],
    ["session effort", m => { m.sessions[0]!.effort = "low"; }],
    ["session profile", m => { m.sessions[0]!.profileId = "base:oc"; }],
    ["nativeAgentSelected false", m => { m.sessions[0]!.nativeAgentSelected = false; }],
    ["nativeAgentSelected omitted", m => { delete m.sessions[0]!.nativeAgentSelected; }],
    ["role and kind", m => { Object.assign(m.sessions[0]!, { agent: "implementer", agentKind: "worker", profileId: "worker:implementer" }); }],
    ["execution revision", m => { m.sessions[0]!.saneExecution!.revision = "d".repeat(64); }],
    ["execution omitted", m => { delete m.sessions[0]!.saneExecution; }],
    ["context bytes", m => { m.sessions[0]!.saneContext!.framework += "other"; }],
    ["context version", m => { m.sessions[0]!.saneContext!.version = 2; m.runs[0]!.saneContextVersion = 2; }],
    ["context revision", m => { m.sessions[0]!.saneContext!.package!.revision = "d".repeat(64); }],
    ["context omitted", m => { delete m.sessions[0]!.saneContext; delete m.sessions[0]!.saneExecution; delete m.runs[0]!.saneContextVersion; }],
    ["attachment", m => { m.sessions[0]!.attachment!.state = "pending"; }],
    ["attachment omitted", m => { delete m.sessions[0]!.attachment; }],
    ["run model", m => { m.runs[0]!.model = "other"; }],
    ["run model omitted", m => { delete m.runs[0]!.model; }],
    ["run effort", m => { m.runs[0]!.effort = "low"; }],
    ["run profile", m => { m.runs[0]!.profileId = "base:oc"; }],
    ["run nativeAgentSelected", m => { m.runs[0]!.nativeAgentSelected = false; }],
    ["run execution", m => { m.runs[0]!.saneExecution!.revision = "d".repeat(64); }],
    ["run context omitted", m => { delete m.runs[0]!.saneContextVersion; }],
    ["run role kind", m => { Object.assign(m.runs[0]!, { agent: "implementer", agentKind: "worker" }); }],
    ["run native ID", m => { m.runs[0]!.nativeCommandId = "msg_changed"; }],
    ["run identity", m => { m.runs[0]!.runId = crypto.randomUUID(); m.sessions[0]!.lastRunId = m.runs[0]!.runId; }],
    ["run/source removal", m => { m.sessions = []; m.runs = []; }],
  ];
  for (const [name, change] of configChanges) test(`latest committed ${name} change refuses old proof without poisoning storage`, () => {
    const f = fixture(), binding = f.binding(), receipt = f.publisher.commitSerialized(f.serialize());
    const next = structuredClone(f.metadata); change(next); validateMetadata(next);
    f.publisher.commitSerialized(JSON.stringify(next));
    expect(() => f.publisher.assertCommitted(receipt, binding)).toThrow(MetadataCommitProofError);
    expect(f.failures).toEqual([]);
    const restored = f.publisher.commitSerialized(f.serialize()); f.publisher.assertCommitted(restored, binding);
  });

  test("an old receipt cannot borrow latest matching pins if its own snapshot lacked them", () => {
    const f = fixture("opencode", false), original = f.publisher.commitSerialized(f.serialize());
    f.session.model = "new-model"; f.run.model = "new-model";
    const latest = f.publisher.commitSerialized(f.serialize()), binding = f.binding();
    expect(() => f.publisher.assertCommitted(original, binding)).toThrow("configuration changed");
    f.publisher.assertCommitted(latest, binding);
  });

  test("omitted session harness defaults to CC in the trusted projection; no activation ID is invented", () => {
    const f = fixture("claude-code", false); delete f.session.harness;
    const binding = f.binding();
    expect(binding.source.harnessId).toBe("claude-code");
    expect(Object.keys(binding).sort()).toEqual(["nativeCommandId", "run", "runId", "session", "source"]);
    expect(binding.session).not.toHaveProperty("activationId");
  });

  test("CC queued followup pins are independent of optional dispatch request IDs", () => {
    for (const requestId of [undefined, crypto.randomUUID()]) {
      const f = fixture("claude-code", false);
      f.run.queuedFollowupId = crypto.randomUUID();
      const dispatch = { ...f.dispatch, ...(requestId ? { requestId } : {}) }, binding = captureMetadataDispatchBinding(f.session, f.run, dispatch);
      const receipt = f.publisher.commitSerialized(f.serialize()); f.publisher.assertCommitted(receipt, binding);
      f.run.queuedFollowupId = crypto.randomUUID(); f.publisher.commitSerialized(f.serialize());
      expect(() => f.publisher.assertCommitted(receipt, binding)).toThrow("configuration changed");
    }
  });
  test("compact request IDs correlate with the explicit request on the run", () => {
      const f = fixture("claude-code", false), requestId = crypto.randomUUID();
      f.run.operation = "compact"; f.run.compact = { requestId, instructions: "exact" };
      const dispatch = { ...f.dispatch, requestId }, binding = captureMetadataDispatchBinding(f.session, f.run, dispatch);
      const receipt = f.publisher.commitSerialized(f.serialize()); f.publisher.assertCommitted(receipt, binding);
      expect(() => captureMetadataDispatchBinding(f.session, f.run, { ...dispatch, requestId: crypto.randomUUID() })).toThrow("correlation changed");
      f.run.compact!.requestId = crypto.randomUUID();
      f.publisher.commitSerialized(f.serialize());
      expect(() => f.publisher.assertCommitted(receipt, binding)).toThrow("correlation changed");
  });

  test("a dispatch/source/run pairing mismatch is rejected at capture", () => {
    const f = fixture();
    for (const dispatch of [{ ...f.dispatch, runId: crypto.randomUUID() }, { ...f.dispatch, nativeCommandId: "msg_other" }, { ...f.dispatch, source: { ...f.dispatch.source, harnessId: "claude-code" } }]) {
      expect(() => captureMetadataDispatchBinding(f.session, f.run, dispatch)).toThrow("correlation changed");
    }
    expect(() => captureMetadataDispatchBinding(f.session, { ...f.run, sessionId: crypto.randomUUID() }, f.dispatch)).toThrow("correlation changed");
  });

  test("native compact admission progress is not requested dispatch configuration", () => {
    const f = fixture(), requestId = crypto.randomUUID(), dispatch = { ...f.dispatch, requestId };
    f.run.operation = "compact"; f.run.compact = { requestId };
    const binding = captureMetadataDispatchBinding(f.session, f.run, dispatch), receipt = f.publisher.commitSerialized(f.serialize());
    f.run.compact.nativeRequestId = f.run.nativeCommandId; f.run.compact.nativeAdmittedId = "msg_coalesced";
    f.publisher.commitSerialized(f.serialize()); f.publisher.assertCommitted(receipt, binding);
  });

  for (const target of ["manifest", "metadata"] as const) for (const mutation of ["bytes", "samebytes replacement", "symlink", "hardlink", "missing"] as const) {
    test(`physical ${target} ${mutation} fails closed permanently, including proof calls`, () => {
      const f = fixture(), receipt = f.publisher.commitSerialized(f.serialize()), path = target === "manifest" ? f.manifestPath : f.path;
      const bytes = fs.readFileSync(path);
      if (mutation === "bytes") fs.writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
      else {
        fs.renameSync(path, path + ".original");
        if (mutation === "samebytes replacement") fs.writeFileSync(path, bytes);
        if (mutation === "symlink") fs.symlinkSync(path + ".original", path);
        if (mutation === "hardlink") fs.linkSync(path + ".original", path);
      }
      expect(() => f.publisher.assertCommitted(receipt, f.binding())).toThrow();
      expect(f.failures).toHaveLength(1);
      const remaining = fs.readdirSync(f.root).sort();
      expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("reconciliation required");
      expect(fs.readdirSync(f.root).sort()).toEqual(remaining);
      expect(f.failures).toHaveLength(1);
    });
  }

  for (const symlink of [false, true]) test(`canonical root ${symlink ? "symlink" : "replacement inode"} refuses publication`, () => {
    const f = fixture(), moved = f.root + "-moved"; roots.push(moved);
    fs.renameSync(f.root, moved);
    if (symlink) fs.symlinkSync(moved, f.root); else fs.mkdirSync(f.root);
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("root changed");
    expect(f.failures).toHaveLength(1);
    expect(fs.readFileSync(join(moved, "metadata.json"), "utf8")).toBe(f.serialize());
  });

  test("constructor validates store ID, manifest, metadata and synchronous ownership without creating files", () => {
    for (const which of ["storeId", "manifest", "metadata", "async guard"] as const) {
      const f = fixture(), failures: unknown[] = [];
      if (which === "manifest") fs.writeFileSync(f.manifestPath, "{}");
      if (which === "metadata") fs.writeFileSync(f.path, "{}");
      const before = fs.readdirSync(f.root).sort();
      expect(() => new MetadataPublisher(f.root, which === "storeId" ? crypto.randomUUID() : f.storeId, {
        assertStorage: which === "async guard" ? (async () => {}) : () => {}, failClosed: error => { failures.push(error); },
      })).toThrow();
      expect(failures).toHaveLength(1); expect(fs.readdirSync(f.root).sort()).toEqual(before);
    }
  });

  for (const stage of ["file fsync", "rename", "directory fsync"] as const) test(`${stage} failure never returns proof, retries, rolls back, or deletes other data`, () => {
    const f = fixture(), receipt = f.publisher.commitSerialized(f.serialize()), before = fs.readFileSync(f.path), other = join(f.root, ".unrelated.tmp");
    fs.writeFileSync(other, "keep"); f.session.title = "Published maybe";
    const sync = fs.fsyncSync;
    const spy = stage === "rename" ? spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); })
      : spyOn(fs, "fsyncSync").mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory() === (stage === "directory fsync")) throw new Error(`${stage} failed`);
        sync(fd);
      });
    try { expect(() => f.publisher.commitSerialized(f.serialize())).toThrow(`${stage} failed`); } finally { spy.mockRestore(); }
    expect(f.failures).toHaveLength(1);
    expect(fs.readFileSync(other, "utf8")).toBe("keep");
    expect(fs.readFileSync(f.path)).toEqual(stage === "directory fsync" ? Buffer.from(f.serialize()) : before);
    const after = fs.readFileSync(f.path);
    expect(() => f.publisher.assertCommitted(receipt, f.binding())).toThrow("reconciliation required");
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("reconciliation required");
    expect(fs.readFileSync(f.path)).toEqual(after);
    if (stage !== "directory fsync") expect(fs.readdirSync(f.root).filter(name => /^\.metadata\.json\..+\.tmp$/.test(name))).toHaveLength(1);
  });

  test("tampering during directory fsync is detected before a receipt can escape", () => {
    const f = fixture(), sync = fs.fsyncSync;
    const spy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd); if (fs.fstatSync(fd).isDirectory()) fs.writeFileSync(f.manifestPath, "changed");
    });
    try { expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("manifest.json changed"); } finally { spy.mockRestore(); }
    expect(f.failures).toHaveLength(1);
  });

  test("invalid snapshots fail before creating a tempfile and are sticky", () => {
    const f = fixture(), before = fs.readdirSync(f.root).sort();
    expect(() => f.publisher.commitSerialized("{broken")).toThrow();
    expect(fs.readdirSync(f.root).sort()).toEqual(before);
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("reconciliation required");
    expect(f.failures).toHaveLength(1);
  });

  for (const asynchronous of ["promise", "thenable"] as const) test(`mandatory ownership ${asynchronous} is refused before publication`, () => {
    const f = fixture(), before = fs.readFileSync(f.path);
    f.guard(() => (asynchronous === "promise" ? Promise.resolve() : { then: (resolve: () => void) => resolve() }) as any);
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("complete synchronously");
    expect(fs.readFileSync(f.path)).toEqual(before); expect(f.failures).toHaveLength(1);
  });

  test("mandatory failClosed thenables are checked, rejection is consumed, and original failure stays sticky", () => {
    const f = fixture(); let calls = 0;
    f.fail((() => { calls++; return Promise.reject(new Error("async failClosed")); }) as any);
    f.guard(() => { throw new Error("ownership lost"); });
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("ownership lost");
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("reconciliation required"); expect(calls).toBe(1);
  });

  test("reentry poisons publication even if a mandatory callback swallows its refusal", () => {
    const f = fixture(), before = fs.readFileSync(f.path);
    f.guard(() => { try { f.publisher.commitSerialized(f.serialize()); } catch {} });
    expect(() => f.publisher.commitSerialized(f.serialize())).toThrow("reconciliation required");
    expect(fs.readFileSync(f.path)).toEqual(before); expect(f.failures).toHaveLength(1);
  });
});
