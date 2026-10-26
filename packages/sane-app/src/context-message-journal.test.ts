import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { composeContextMessage } from "./context-message";
import { recordContextMessageSubmission, type ContextMessageDispatchObservation, type ContextMessageSubmission } from "./context-message-evidence";
import { createContextMessageJournalPersistence } from "./context-message-journal";
import { RunJournalWriter } from "./run-journal";
import type { Event, Run } from "./history";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });
function fixture(harness = "opencode", live = false) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-journal-test-")); roots.push(root);
  const run: Run = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID(), cwd: root, status: "running", createdAt: new Date().toISOString(),
    ...(harness === "opencode" ? { nativeCommandId: `msg_${crypto.randomUUID()}` } : {}) };
  const identity: DispatchIdentity = { source: { harnessId: harness, sessionId: run.sessionId, authorityId: "fixture-authority", nativeSessionId: "fixture-native", cwd: root }, runId: run.runId, nativeCommandId: run.nativeCommandId ?? null };
  const messageId = harness === "claude-code" ? `${run.runId}:user${live ? `:${crypto.randomUUID()}` : ""}` : run.nativeCommandId!;
  const message = composeContextMessage({ body: "\uFEFF exact 😀\r\n[SANE CONTEXT MESSAGE v1]\n", binding: identity.source as any, origin: "user", placement: { kind: "body-only" } });
  const submission = recordContextMessageSubmission(message, { messageId, text: message.transport.text, ...(live ? { liveInput: true } : {}) }, identity);
  const events: Event[] = [], failures: unknown[] = [];
  let dead = false, metadataCommitted = true, ownerCurrent = true;
  const failClosed = (error: unknown) => { dead = true; failures.push(error); };
  const writer = new RunJournalWriter(root, { assertStorage: () => { if (dead) throw new Error("storage closed"); }, failClosed });
  const queued: (() => void)[] = [];
  const reserve = (kind: Event["kind"], data: unknown) => {
    const reservation = writer.reserve(run, events, kind, data); events.push(reservation.event);
    queued.push(() => writer.commit(reservation)); return reservation;
  };
  const persist = createContextMessageJournalPersistence({ writer, readIdentity: () => identity, readEvents: () => events,
    assertCurrent: () => { if (!ownerCurrent) throw new Error("original owner changed"); if (dead) throw new Error("storage closed"); },
    assertMetadataCommitted: () => { if (!metadataCommitted) throw new Error("metadata still queued"); },
    reserveObservation: observation => reserve("context", observation), failClosed });
  const observation = (stage: "before-native" | "outcome" = "before-native", outcome: "submitted" | "unknown" | "not-submitted" = "submitted"): ContextMessageDispatchObservation => ({
    schema: 1, type: "context-message-dispatch", messageId, transportSha256: message.transport.sha256,
    boundary: live ? "message" : "run-initial", stage, evidence: { ...identity, submission: stage === "before-native" ? "attempted" : outcome,
      nativeAcceptance: outcome === "not-submitted" && stage === "outcome" ? "not-accepted" : "unknown" },
  });
  const path = join(root, `${run.runId}.jsonl`);
  const read = () => fs.readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  return { root, run, writer, identity, events, submission, observation, persist, reserve, read, path, failures, queued,
    blockMetadata: () => { metadataCommitted = false; }, changeOwner: () => { ownerCurrent = false; } };
}

describe("inactive context evidence adapter on the same journal", () => {
  test("flushes the actual reserved submission and predecessors; outcomes never duplicate text", () => {
    const f = fixture();
    f.reserve("status", { status: "running" });
    f.reserve("submission", f.submission);
    f.persist(f.submission, f.observation());
    expect(f.read().map(event => event.kind)).toEqual(["status", "submission", "context"]);
    f.persist(f.submission, f.observation("outcome"));
    const bytes = fs.readFileSync(f.path, "utf8");
    for (const commit of f.queued) commit();
    expect(fs.readFileSync(f.path, "utf8")).toBe(bytes);
    expect(f.read().filter(event => event.kind === "submission")).toHaveLength(1);
    expect(f.read().filter(event => event.kind === "context")).toHaveLength(2);
    expect(f.read().filter(event => JSON.stringify(event.data).includes('"text":'))).toHaveLength(1);
    expect(f.failures).toEqual([]);
  });

  test("identical observations can be verified durably without appending again or authorizing a send", () => {
    const f = fixture(); f.reserve("submission", f.submission);
    f.persist(f.submission, f.observation());
    const before = fs.readFileSync(f.path);
    f.persist(f.submission, f.observation());
    expect(fs.readFileSync(f.path)).toEqual(before);
  });

  for (const which of ["bare", "missing", "duplicate", "copied"] as const) test(`refuses ${which} standard submission rather than manufacturing or retrofitting it`, () => {
    const f = fixture();
    if (which === "bare") f.reserve("submission", { messageId: f.submission.messageId, text: f.submission.text });
    if (which === "duplicate") { f.reserve("submission", f.submission); f.reserve("submission", f.submission); }
    if (which === "copied") { const record = f.reserve("submission", f.submission); f.events[0] = structuredClone(record.event); }
    expect(() => f.persist(f.submission, f.observation())).toThrow();
    expect(fs.existsSync(f.path)).toBe(false);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  test("a journal fence cannot pretend to flush pending metadata", () => {
    const f = fixture(); f.reserve("submission", f.submission); f.blockMetadata();
    expect(() => f.persist(f.submission, f.observation())).toThrow("metadata still queued");
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test("changed original owner fails before any boundary write", () => {
    const f = fixture(); f.reserve("submission", f.submission); f.changeOwner();
    expect(() => f.persist(f.submission, f.observation())).toThrow("owner changed");
    expect(fs.existsSync(f.path)).toBe(false);
  });

  for (const which of ["message", "hash", "identity", "bytes"] as const) test(`refuses inconsistent ${which} evidence`, () => {
    const f = fixture(); f.reserve("submission", f.submission);
    const fact = structuredClone(f.observation());
    const submission = structuredClone(f.submission) as ContextMessageSubmission;
    if (which === "message") (fact as any).messageId += "other";
    if (which === "hash") (fact as any).transportSha256 = "f".repeat(64);
    if (which === "identity") (fact.evidence as any).runId = crypto.randomUUID();
    if (which === "bytes") (submission as any).text += "other";
    expect(() => f.persist(submission, fact)).toThrow();
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test("non-withheld outcome requires the message's original attempt", () => {
    const f = fixture(); f.reserve("submission", f.submission);
    expect(() => f.persist(f.submission, f.observation("outcome"))).toThrow("original attempt");
  });
  test("a copied or invented attempt in memory cannot substitute for an original reservation", () => {
    for (const copied of [false, true]) {
      const f = fixture(); f.reserve("submission", f.submission);
      if (copied) {
        f.persist(f.submission, f.observation());
        f.events[1] = structuredClone(f.events[1]!);
      } else f.events.push({ seq: 2, time: f.run.createdAt, runId: f.run.runId, sessionId: f.run.sessionId, kind: "context", data: f.observation() });
      const before = fs.existsSync(f.path) ? fs.readFileSync(f.path) : null;
      expect(() => f.persist(f.submission, f.observation("outcome"))).toThrow("original run journal reservation");
      expect(fs.existsSync(f.path) ? fs.readFileSync(f.path) : null).toEqual(before);
    }
  });
  test("genuine owner withholding can be observed without inventing an attempt", () => {
    const f = fixture(); f.reserve("submission", f.submission);
    f.persist(f.submission, f.observation("outcome", "not-submitted"));
    expect(f.read().map(event => (event.data as any).stage).filter(Boolean)).toEqual(["outcome"]);
  });

  test("CC initial and live-input boundaries retain separate message identities", () => {
    for (const live of [false, true]) {
      const f = fixture("claude-code", live); f.reserve("submission", f.submission);
      f.persist(f.submission, f.observation());
      expect((f.read().at(-1)!.data as any).boundary).toBe(live ? "message" : "run-initial");
    }
    const live = fixture("claude-code", true); live.reserve("submission", live.submission);
    expect(() => live.persist(live.submission, { ...live.observation(), boundary: "run-initial" })).toThrow("original message");
  });

  test("failed boundary fsync cannot be repaired by later queued submission callbacks", () => {
    const f = fixture(); f.reserve("submission", f.submission);
    const broken = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("boundary fsync failed"); });
    try { expect(() => f.persist(f.submission, f.observation())).toThrow("boundary fsync failed"); }
    finally { broken.mockRestore(); }
    const bytes = fs.readFileSync(f.path);
    for (const commit of f.queued) expect(commit).toThrow("reconciliation");
    expect(fs.readFileSync(f.path)).toEqual(bytes);
  });
});
