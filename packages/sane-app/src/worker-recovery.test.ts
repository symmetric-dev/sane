import { expect, test } from "bun:test";
import type { Event } from "./history";
import { workerTerminationUncertainty } from "./worker-recovery";

const status = (seq: number, data: unknown): Event => ({ seq, time: "2026-09-29T10:00:00.000Z", runId: "run", sessionId: "session", kind: "status", data });
const proof = (seq: number, throughSeq: number) => status(seq, { status: "interrupted", reconciliation: { kind: "termination-confirmed", throughSeq } });

test("typed termination uncertainty requires a known cause, not unrelated status prose", () => {
  const storage = status(1, { status: "failed", reason: "Storage failure; operator reconciliation required" });
  const unrelated = status(2, { status: "failed", reason: "A nested error said termination unconfirmed; operator reconciliation required" });
  const wrongCause = status(3, { status: "interrupted", termination: { kind: "unconfirmed", cause: "storage-failure" } });
  const restart = status(4, { status: "interrupted", termination: { kind: "unconfirmed", cause: "server-restart" } });
  const group = status(5, { status: "failed", termination: { kind: "unconfirmed", cause: "process-group" } });
  expect(workerTerminationUncertainty([storage, unrelated, wrongCause])).toBeUndefined();
  expect(workerTerminationUncertainty([storage, restart])).toBe(restart);
  expect(workerTerminationUncertainty([restart, group])).toBe(group);
});

test("historical termination status records decode exactly without treating storage prose as termination", () => {
  const restart = status(1, { status: "interrupted", reason: "server restarted; verify old CLI process has stopped" });
  const group = status(2, { status: "failed", reason: "Process termination unconfirmed; operator reconciliation required" });
  const malformed = status(3, { status: "failed", reason: "Process termination unconfirmed; operator reconciliation required", termination: { kind: "unconfirmed", cause: "storage-failure" } });
  expect(workerTerminationUncertainty([restart])).toBe(restart);
  expect(workerTerminationUncertainty([group])).toBe(group);
  expect(workerTerminationUncertainty([malformed])).toBeUndefined();
});

test("confirmation covers only earlier uncertainty up to throughSeq", () => {
  const earlier = status(2, { termination: { kind: "unconfirmed", cause: "server-restart" } });
  const later = status(4, { termination: { kind: "unconfirmed", cause: "process-group" } });
  expect(workerTerminationUncertainty([earlier, proof(3, 1)])).toBe(earlier);
  expect(workerTerminationUncertainty([earlier, proof(3, 3)])).toBe(earlier);
  expect(workerTerminationUncertainty([earlier, proof(3, 2)])).toBeUndefined();
  expect(workerTerminationUncertainty([earlier, proof(3, 2), later])).toBe(later);
  expect(workerTerminationUncertainty([earlier, later, proof(5, 2)])).toBe(later);
  expect(workerTerminationUncertainty([earlier, later, proof(5, 4)])).toBeUndefined();
});
