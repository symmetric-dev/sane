import { expect, test } from "bun:test";
import type { Run } from "./history";
import { workerObservationEvidence } from "./worker-observation-evidence";

function fixture() {
  const worker = { sessionId: "worker-session" };
  const run: Run = { runId: "worker-run", sessionId: worker.sessionId, cwd: "/fixture", createdAt: "2026-10-01T00:00:00.000Z", status: "completed", nativeCommandId: "msg_first", nativePhase: "sending" };
  const runs = [run];
  const events = new Map<string, { seq: number }[]>([[run.runId, [{ seq: 1 }]]]);
  const deliveryRunIds = new Set<string>();
  return { run, runs, events, deliveryRunIds, key: () => workerObservationEvidence(worker, runs, events, deliveryRunIds) };
}

test("native command and phase changes independently invalidate evidence", () => {
  const f = fixture(), initial = f.key();
  f.run.nativeCommandId = "msg_second";
  expect(f.key()).not.toBe(initial);
  f.run.nativeCommandId = "msg_first";
  expect(f.key()).toBe(initial);
  f.run.nativePhase = "accepted";
  expect(f.key()).not.toBe(initial);
});

test("event count and last sequence independently invalidate evidence", () => {
  const f = fixture(), initial = f.key();
  f.events.get(f.run.runId)!.push({ seq: 1 });
  const appended = f.key();
  expect(appended).not.toBe(initial);
  f.events.get(f.run.runId)![1] = { seq: 2 };
  expect(f.key()).not.toBe(appended);
});

test("delivery-referenced runs contribute globally, in history order, once", () => {
  const f = fixture();
  const other: Run = { ...f.run, runId: "delivery-run", sessionId: "other-session" };
  f.runs.unshift(other);
  const initial = f.key();
  f.deliveryRunIds.add(other.runId);
  f.deliveryRunIds.add(f.run.runId);
  const referenced = f.key();
  expect(referenced).not.toBe(initial);
  expect(JSON.parse(referenced).map((row: unknown[]) => row[0])).toEqual([other.runId, f.run.runId]);
  f.events.set(other.runId, [{ seq: 7 }]);
  expect(f.key()).not.toBe(referenced);
  const withEvents = f.key();
  other.status = "interrupted";
  expect(f.key()).not.toBe(withEvents);
  f.runs.reverse();
  expect(JSON.parse(f.key()).map((row: unknown[]) => row[0])).toEqual([f.run.runId, other.runId]);
});

test("unchanged history is stable and unrelated runs and events are excluded", () => {
  const f = fixture(), initial = f.key();
  expect(f.key()).toBe(initial);
  f.runs[0] = { ...f.run };
  f.events.set(f.run.runId, [{ seq: 1 }]);
  f.runs.push({ ...f.run, runId: "unrelated", sessionId: "unrelated-session" });
  f.events.set("unrelated", [{ seq: 99 }]);
  expect(f.key()).toBe(initial);
});

test("fingerprint preserves every observed field and missing versus empty event logs", () => {
  const f = fixture();
  f.run.operation = "prompt";
  f.run.endedAt = "2026-10-01T00:01:00.000Z";
  expect(JSON.parse(f.key())).toEqual([[
    f.run.runId, f.run.sessionId, "prompt", "completed", f.run.endedAt, "msg_first", "sending", 1, 1,
  ]]);
  f.events.delete(f.run.runId);
  const missing = f.key();
  expect(JSON.parse(missing)[0].slice(-2)).toEqual([null, null]);
  f.events.set(f.run.runId, []);
  expect(f.key()).not.toBe(missing);
  expect(JSON.parse(f.key())[0].slice(-2)).toEqual([0, null]);
});
