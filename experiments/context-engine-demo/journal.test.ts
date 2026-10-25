import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSubmissionEvidence } from "../../packages/sane-app/shared/conversation/dispatch-contract";
import { composeContextMessage } from "../../packages/sane-app/src/context-message";
import { decorateContextMessageEvidence, projectContextMessageRestart, recordContextMessageSubmission, type ContextMessageDispatchObservation } from "../../packages/sane-app/src/context-message-evidence";
import { createDispatchEvidence, DispatchPreNativeRefusal } from "../../packages/sane-app/src/dispatch-evidence";
import type { DemoJournalOwner } from "./contract";
import { createDemoJournal, createDemoReplayVariant, readDemoJournal } from "./journal";

const root = mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/demo-journal-tests.");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const path = () => join(root, randomUUID());
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const runId = randomUUID(), sessionId = randomUUID();
  const dispatch = { source: { harnessId: "mock-context-demo", sessionId, authorityId: "demo-authority", nativeSessionId: "demo-native", cwd: root },
    runId, nativeCommandId: `msg_${randomUUID()}`, requestId: randomUUID() };
  const messageId = dispatch.nativeCommandId;
  const owner: DemoJournalOwner = { schema: 1, type: "mock-context-demo-owner", dispatch, messageId, agent: { kind: "assistant", role: "execution" },
    run: { runId, sessionId, cwd: root, status: "running", createdAt: "2026-10-25T00:00:00.000Z", agent: "execution", agentKind: "assistant" },
    activation: { saneExecution: { schema: 1, revision: "a".repeat(64) }, saneContext: { version: 1, framework: "fixture-framework",
      package: { schema: 1, revision: "b".repeat(64), delivery: "standing-native-role" } } } };
  const message = composeContextMessage({ binding: dispatch.source, origin: "user", placement: { kind: "body-only" },
    body: `exact é😀 marker-looking [SANE AUTHORED BODY {}] ${randomUUID()}\r\n` });
  const submission = recordContextMessageSubmission(message, { messageId, text: message.transport.text }, dispatch);
  const observation = (submission: DispatchSubmissionEvidence["submission"], nativeAcceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown"): ContextMessageDispatchObservation => ({
    schema: 1, type: "context-message-dispatch", messageId, transportSha256: message.transport.sha256, boundary: "message",
    stage: submission === "attempted" ? "before-native" : "outcome", evidence: { ...dispatch, submission, nativeAcceptance } });
  const directory = path(), journal = createDemoJournal(directory, owner);
  const project = () => projectContextMessageRestart({ identity: dispatch, messageId }, readDemoJournal(directory).snapshot);
  return { directory, owner, dispatch, messageId, message, submission, observation, journal, project };
}
function accepted() {
  const f = fixture();
  f.journal.persist(f.submission, f.observation("attempted"));
  f.journal.persist(f.submission, f.observation("submitted", "accepted"));
  f.journal.seal();
  return f;
}
function files(directory: string) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name)).toString("base64")]));
}

describe("isolated synchronous demo journal", () => {
  test("roundtrip uses one standard text copy and exact original observation sequence/source", () => {
    const f = accepted(), read = readDemoJournal(f.directory);
    expect(read.owner).toEqual(f.owner);
    expect(read.issues).toEqual([]);
    expect(read.snapshot.coverage.state).toBe("complete");
    expect(f.project().fact).toBe("accepted");
    const events = read.snapshot.events;
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.filter(event => event.kind === "submission")).toHaveLength(1);
    expect(events[1]!.data).toEqual(f.submission);
    expect(read.snapshot.observations.map(record => [record.source, record.order])).toEqual([
      [join(f.directory, "events.jsonl"), 3], [join(f.directory, "events.jsonl"), 4],
    ]);
    const raw = readFileSync(join(f.directory, "events.jsonl"), "utf8");
    expect(raw.split(JSON.stringify(f.submission.text).slice(1, -1)).length - 1).toBe(1);
    expect(Object.isFrozen(read.owner)).toBe(true);
  });

  test("append can supply the one actual submission; persist verifies and reuses it", () => {
    const f = fixture();
    f.journal.append("submission", f.submission);
    f.journal.persist(f.submission, f.observation("attempted"));
    f.journal.seal();
    expect(f.project().fact).toBe("attempt-unresolved");
    expect(readDemoJournal(f.directory).snapshot.events.filter(event => event.kind === "submission")).toHaveLength(1);
  });

  test("closed unknown outcome has complete coverage but unresolved attempt, not permission to resend", () => {
    const f = fixture();
    f.journal.persist(f.submission, f.observation("attempted"));
    f.journal.persist(f.submission, f.observation("unknown"));
    f.journal.seal();
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("complete");
    expect(f.project().fact).toBe("attempt-unresolved");
  });

  test("unsealed readable records remain partial, even with an accepted outcome", () => {
    const f = fixture();
    f.journal.persist(f.submission, f.observation("attempted"));
    f.journal.persist(f.submission, f.observation("submitted", "accepted"));
    expect(readDemoJournal(f.directory).owner).toEqual(f.owner);
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
    expect(f.project().fact).toBe("unknown");
  });

  test("fresh dedicated directories only; closed writers cannot append", () => {
    const f = accepted();
    expect(() => createDemoJournal(f.directory, f.owner)).toThrow();
    expect(() => f.journal.append("status", { status: "completed" })).toThrow("closed");
    expect(() => f.journal.persist(f.submission, f.observation("submitted", "accepted"))).toThrow("closed");
    const before = files(f.directory); f.journal.seal();
    expect(files(f.directory)).toEqual(before);
  });

  for (const variant of ["duplicate", "foreign-source", "foreign-message", "foreign-hash", "foreign-run", "changed-submission"] as const) {
    test(`rejects ${variant} synchronously and seal remains partial`, () => {
      const f = fixture();
      f.journal.persist(f.submission, f.observation("attempted"));
      const observation = structuredClone(f.observation("submitted", "accepted"));
      if (variant === "foreign-source") (observation.evidence.source as any).cwd = "/foreign";
      if (variant === "foreign-message") (observation as any).messageId = "foreign";
      if (variant === "foreign-hash") (observation as any).transportSha256 = "0".repeat(64);
      if (variant === "foreign-run") (observation.evidence as any).runId = randomUUID();
      expect(() => variant === "duplicate" ? f.journal.append("submission", f.submission)
        : f.journal.persist(variant === "changed-submission" ? { ...f.submission, text: "different" } : f.submission, observation)).toThrow();
      f.journal.persist(f.submission, f.observation("submitted", "accepted"));
      f.journal.seal();
      expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
      expect(f.project().fact).toBe("unknown");
    });
  }

  test("fail is sticky despite subsequent successful finish records", () => {
    const f = fixture(); f.journal.fail("injected owner health failure");
    f.journal.persist(f.submission, f.observation("attempted"));
    f.journal.persist(f.submission, f.observation("submitted", "accepted"));
    f.journal.append("status", { status: "completed" }); f.journal.seal();
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
    expect(f.project().fact).toBe("unknown");
  });

  test("genuine original synchronous refusal records withholding without a before-native attempt", () => {
    const f = fixture(); let sends = 0;
    const refusal = new DispatchPreNativeRefusal(new Error("fixture owner withheld"));
    const hooks = decorateContextMessageEvidence({ submission: f.submission, boundary: "message",
      readActualSubmission: () => ({ identity: f.dispatch, messageId: f.messageId, text: f.submission.text }),
      hooks: { beforeNative: () => { throw refusal; } }, persist: f.journal.persist, failClosed: error => f.journal.fail(String(error)) });
    const owner = createDispatchEvidence(f.dispatch, hooks, error => f.journal.fail(String(error)));
    expect(() => { owner.beforeNative(); sends++; }).toThrow();
    expect(owner.recognizesRefusal(refusal)).toBe(true);
    owner.finish(); f.journal.seal();
    expect(sends).toBe(0); expect(f.project().fact).toBe("withheld");
    expect(readDemoJournal(f.directory).snapshot.observations.every(record => (record.value as ContextMessageDispatchObservation).stage === "outcome")).toBe(true);
  });

  test("real synchronous append-open failure prevents the scripted effect and stays partial after recovery", () => {
    const f = fixture(), log = join(f.directory, "events.jsonl"), saved = join(f.directory, "events.saved");
    renameSync(log, saved); mkdirSync(log);
    let sends = 0;
    const hooks = decorateContextMessageEvidence({ submission: f.submission, boundary: "message", hooks: {},
      readActualSubmission: () => ({ identity: f.dispatch, messageId: f.messageId, text: f.submission.text }),
      persist: f.journal.persist, failClosed: error => f.journal.fail(String(error)) });
    const owner = createDispatchEvidence(f.dispatch, hooks, () => {});
    expect(() => { owner.beforeNative(); sends++; }).toThrow();
    expect(sends).toBe(0);
    rmSync(log, { recursive: true }); renameSync(saved, log);
    owner.finish(); f.journal.seal();
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
    expect(f.project().fact).toBe("unknown");
  });

  test("submission and observation fsync finishes synchronously before the boundary returns", () => {
    const f = fixture(), original = fs.fsyncSync, order: string[] = [];
    const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => { original(fd); order.push("fsync-complete"); });
    try {
      f.journal.persist(f.submission, f.observation("attempted")); order.push("native-effect");
      expect(order).toEqual(["fsync-complete", "native-effect"]);
      const records = readDemoJournal(f.directory).snapshot.events;
      expect(records.filter(event => event.kind === "submission")).toHaveLength(1);
      expect(records.filter(event => event.kind === "context" && (event.data as any).type === "context-message-dispatch")).toHaveLength(1);
    } finally { sync.mockRestore(); }
    f.journal.seal(); expect(f.project().fact).toBe("attempt-unresolved");
  });

  test("injected append fsync failure throws before effect; visible but uncommitted bytes never become complete", () => {
    const f = fixture(); let sends = 0;
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("injected fsync failure"); });
    try {
      expect(() => { f.journal.persist(f.submission, f.observation("attempted")); sends++; }).toThrow("injected fsync failure");
      expect(sends).toBe(0);
    } finally { sync.mockRestore(); }
    expect(() => f.journal.seal()).toThrow();
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
    expect(f.project().fact).toBe("unknown");
  });

  test("injected directory-fsync failure after checkpoint rename invalidates the visible checkpoint", () => {
    const f = fixture(); f.journal.persist(f.submission, f.observation("attempted"));
    const original = fs.fsyncSync;
    const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("injected directory fsync failure");
      original(fd);
    });
    try { expect(() => f.journal.seal()).toThrow("injected directory fsync failure"); }
    finally { sync.mockRestore(); }
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
    expect(f.project().fact).toBe("unknown");
    f.journal.seal(); // later success must retain the earlier storage failure
    expect(readDemoJournal(f.directory).snapshot.coverage.state).toBe("partial");
  });

  test("missing owner at boundary fails closed rather than accepting detached evidence", () => {
    const f = fixture(); rmSync(join(f.directory, "owner.json"));
    expect(() => f.journal.persist(f.submission, f.observation("attempted"))).toThrow();
    expect(f.project().fact).toBe("unknown");
  });

  test("external truncation is not silently recreated or blessed on seal", () => {
    const f = fixture(); f.journal.persist(f.submission, f.observation("attempted"));
    writeFileSync(join(f.directory, "events.jsonl"), "");
    expect(() => f.journal.persist(f.submission, f.observation("submitted", "accepted"))).toThrow("changed outside");
    expect(() => f.journal.seal()).toThrow();
    expect(f.project().fact).toBe("unknown");
  });

  test("checkpoint binds exact owner/log length/hash/count and pairing refs", () => {
    const f = accepted(), checkpoint = JSON.parse(readFileSync(join(f.directory, "checkpoint.json"), "utf8"));
    const bytes = readFileSync(join(f.directory, "events.jsonl"));
    expect(checkpoint.log).toEqual({ byteLength: bytes.length, sha256: digest(bytes), eventCount: 4, lastSeq: 4 });
    expect(checkpoint.ownerSha256).toBe(digest(readFileSync(join(f.directory, "owner.json"))));
    const owner = JSON.parse(readFileSync(join(f.directory, "owner.json"), "utf8"));
    owner.owner.activation.saneExecution.revision = "c".repeat(64);
    writeFileSync(join(f.directory, "owner.json"), JSON.stringify(owner) + "\n");
    expect(readDemoJournal(f.directory).owner?.activation.saneExecution.revision).toBe("c".repeat(64));
    expect(f.project().fact).toBe("unknown");
  });

  for (const corruption of ["missing-log", "missing-checkpoint", "missing-owner", "truncated", "terminated-corruption", "torn", "torn-utf8", "count", "hash", "length", "invalid-owner"] as const) {
    test(`${corruption} cannot become complete and replay does not write`, () => {
      const f = accepted(), log = join(f.directory, "events.jsonl"), checkpointPath = join(f.directory, "checkpoint.json");
      if (corruption === "missing-log") rmSync(log);
      if (corruption === "missing-checkpoint") rmSync(checkpointPath);
      if (corruption === "missing-owner") rmSync(join(f.directory, "owner.json"));
      if (corruption === "truncated") { const raw = readFileSync(log, "utf8"); writeFileSync(log, raw.slice(0, raw.lastIndexOf("\n", raw.length - 2) + 1)); }
      if (corruption === "terminated-corruption") appendFileSync(log, '{"seq":garbage}\n');
      if (corruption === "torn") appendFileSync(log, '{"seq":');
      if (corruption === "torn-utf8") appendFileSync(log, Buffer.concat([Buffer.from('{"seq":5,"data":"'), Buffer.from([0xf0, 0x9f])]));
      if (["count", "hash", "length"].includes(corruption)) {
        const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
        if (corruption === "count") checkpoint.log.eventCount++;
        if (corruption === "hash") checkpoint.log.sha256 = "0".repeat(64);
        if (corruption === "length") checkpoint.log.byteLength++;
        writeFileSync(checkpointPath, JSON.stringify(checkpoint) + "\n");
      }
      if (corruption === "invalid-owner") {
        const ownerPath = join(f.directory, "owner.json"), owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        owner.owner.run.runId = "not-a-uuid"; writeFileSync(ownerPath, JSON.stringify(owner));
      }
      const before = files(f.directory), result = readDemoJournal(f.directory);
      expect(result.snapshot.coverage.state).toBe("partial");
      expect(f.project().fact).toBe("unknown"); expect(files(f.directory)).toEqual(before);
      if (corruption === "invalid-owner" || corruption === "missing-owner") expect(result.owner).toBeNull();
      else expect(result.owner).toEqual(f.owner);
      if (corruption === "torn" || corruption === "torn-utf8") expect(result.snapshot.events).toHaveLength(4);
    });
  }

  test("wholly absent journal is unavailable", () => {
    const read = readDemoJournal(path());
    expect(read.owner).toBeNull(); expect(read.snapshot.coverage.state).toBe("unavailable");
  });

  for (const kind of ["torn", "missing"] as const) test(`owned ${kind} variant copies only journal files, source untouched, original source retained`, () => {
    const f = accepted(), destination = path();
    writeFileSync(join(f.directory, "do-not-copy.txt"), "fixture-only");
    const before = files(f.directory); createDemoReplayVariant(f.directory, destination, kind);
    expect(files(f.directory)).toEqual(before);
    expect(readdirSync(destination).sort()).toEqual(kind === "torn" ? ["checkpoint.json", "events.jsonl", "owner.json"] : ["checkpoint.json", "owner.json"]);
    const read = readDemoJournal(destination), variantBefore = files(destination);
    expect(read.owner).toEqual(f.owner); expect(read.snapshot.coverage.state).toBe("partial");
    expect(read.snapshot.coverage.source).toBe(join(f.directory, "events.jsonl"));
    expect(projectContextMessageRestart({ identity: f.dispatch, messageId: f.messageId }, read.snapshot).fact).toBe("unknown");
    expect(files(destination)).toEqual(variantBefore);
    expect(() => createDemoReplayVariant(f.directory, destination, kind)).toThrow();
  });

  test("unclosed source cannot produce a supposedly closed replay variant", () => {
    const f = fixture(); expect(() => createDemoReplayVariant(f.directory, path(), "torn")).toThrow();
  });
});
