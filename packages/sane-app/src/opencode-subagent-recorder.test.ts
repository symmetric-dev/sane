import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { OpenCodeSubagentRecorder } from "./opencode-subagent-recorder";
import { RunJournalWriter } from "./run-journal";
import type { Event, Run, Session } from "./history";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(blocked = false) {
  const root = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/subagent-journal-test-")); roots.push(root);
  const session: Session = { sessionId: crypto.randomUUID(), harness: "opencode", nativeSessionId: "ses_fixture", authorityId: "fixture", cwd: root, lastStatus: "unknown", lastRunId: null };
  const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd: root, status: "running", createdAt: new Date().toISOString() };
  const events: Event[] = [{ seq: 1, time: run.createdAt, runId: run.runId, sessionId: session.sessionId, kind: "message", data: {
    messageId: "msg_parent", role: "assistant", parts: [{ type: "tool", id: "tool_fixture", name: "subagent", input: { agent: "fixture" } }],
  } }];
  let release!: () => void;
  const pause = blocked ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const calls: string[] = [], appended: unknown[] = [], failures: unknown[] = [];
  const writer = new RunJournalWriter(root, { assertStorage() {}, failClosed: error => { failures.push(error); } });
  // All native methods are offline fakes; the real SDK is never instantiated.
  const oc = { activity: async () => { calls.push("activity"); await pause; return {}; }, request: async () => { calls.push("request"); return { data: undefined }; }, path: () => "/fixture" } as any;
  const recorder = new OpenCodeSubagentRecorder(oc, () => events, async (_run, kind, data) => { appended.push({ kind, data }); }, () => false, () => true, candidate => writer.canAppend(candidate.runId));
  // Observe an existing private flight only to await deterministic fake I/O;
  // do not call drain() first, since its stopped flag would hide eligibility bugs.
  const flight = () => [...(recorder as any).flights.values()][0] as Promise<void> | undefined;
  return { session, run, writer, recorder, calls, appended, failures, flight, release: () => release() };
}

test("excluded originals refuse startup resume and manual forced refresh non-fatally", async () => {
  const f = fixture(); f.writer.excludeOriginal(f.run.runId);
  f.recorder.resume(f.session, f.run);
  f.recorder.refresh(f.session, f.run);
  f.recorder.refresh(f.session, f.run, "tool_fixture", true);
  await f.recorder.drain();
  expect(f.calls).toEqual([]);
  expect(f.appended).toEqual([]);
  expect(f.failures).toEqual([]);
  expect(f.writer.canAppend(f.run.runId)).toBe(false);
  expect(f.writer.canAppend(crypto.randomUUID())).toBe(true);
});

test("a flight rechecks per-run append eligibility after awaited observation", async () => {
  const f = fixture(true); f.recorder.refresh(f.session, f.run);
  const pending = f.flight(); expect(pending).toBeDefined();
  f.writer.excludeOriginal(f.run.runId); f.release(); await pending;
  expect(f.appended).toEqual([]);
  expect(f.failures).toEqual([]);
  await f.recorder.drain();
});

test("non-excluded recorder still captures its normal bounded recovery warning", async () => {
  const f = fixture(); f.recorder.refresh(f.session, f.run);
  await f.flight();
  expect(f.calls).toEqual(["activity", "request"]);
  expect(f.appended).toHaveLength(1);
  expect(f.failures).toEqual([]);
  await f.recorder.drain();
});
