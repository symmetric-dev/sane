import { expect, test } from "bun:test";
import { normalizeMessage, type NativeMessage } from "./opencode";
import { consume, createRun } from "../shared/conversation/cc-reducer";
import { transcriptMessages } from "../shared/conversation/transcript";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";

const error = { type: "APIError", message: "overloaded", data: { statusCode: 503, isRetryable: true } };
const retry = { attempt: 3, at: 500, error };
const native: NativeMessage = { id: "msg_retry", type: "assistant", time: { created: 300 }, content: [{ type: "text", text: "partial" }], error, retry };
const history = (message: NativeMessage): ReconciledHistory => ({ sessionId: "A", nativeSessionId: "ses_A", importedAt: "", activity: "active", reason: "fixture", coveredRunIds: [], observation: true, messages: [normalizeMessage(message)!] });

const malformedRetries: [string, unknown][] = [
  ["null", null], ["array", []], ["string", "retry"], ["number", 1], ["boolean", false],
  ["missing attempt", { at: 500, error }],
  ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"].map(value => [`invalid attempt ${String(value)} (${typeof value})`, { ...retry, attempt: value }] as [string, unknown]),
  ["missing timestamp", { attempt: 3, error }],
  ...[-1, NaN, Infinity, -Infinity, 8_640_000_000_000_001, "500", null].map(value => [`invalid timestamp ${String(value)} (${typeof value})`, { ...retry, at: value }] as [string, unknown]),
  ["missing error", { attempt: 3, at: 500 }],
  ...[null, [], "overloaded", false, 503, {}, { message: "overloaded" }, { type: "APIError" },
    { type: 503, message: "overloaded" }, { type: "APIError", message: null }]
    .map((value, index) => [`invalid structured error ${index}`, { ...retry, error: value }] as [string, unknown]),
];
for (const [name, malformed] of malformedRetries) test(`normalization rejects retry metadata with ${name}`, () => {
  const message = { ...native, retry: malformed } as NativeMessage;
  expect(() => normalizeMessage(message)).toThrow("Invalid native retry metadata");
});

test("valid retry boundaries preserve the complete structured error", () => {
  for (const valid of [{ ...retry, attempt: 1, at: 0 }, { ...retry, attempt: Number.MAX_SAFE_INTEGER, at: 8_640_000_000_000_000 }]) {
    expect(normalizeMessage({ ...native, retry: valid })).toMatchObject({ status: "running", retry: valid, error });
  }
});

for (const scenario of [
  { name: "unfinished retry", message: native, status: "running" },
  { name: "terminal retry failure", message: { ...native, time: { created: 300, completed: 400 } }, status: "failed" },
  { name: "completed retry evidence without error", message: { ...native, error: undefined, time: { created: 300, completed: 400 } }, status: "completed" },
  { name: "unfinished error without retry", message: { ...native, retry: undefined }, status: "failed" },
  { name: "nonassistant retry error", message: { ...native, type: "user" }, status: "failed" },
] as const) test(`${scenario.name} preserves structured diagnostics and status through normalization, journal, and transcript`, () => {
  const snapshot = normalizeMessage(scenario.message)!;
  expect(snapshot.status).toBe(scenario.status);
  expect(snapshot.retry).toEqual(scenario.message.retry); expect(snapshot.error).toEqual(scenario.message.error);
  const run = createRun({ id: "run", conversationId: "A", cwd: "/fixture", status: "running", createdAt: "", harness: "opencode" });
  consume(run, [{ seq: 1, time: "", runId: run.id, sessionId: "A", kind: "message", data: snapshot }]);
  for (const projected of [run.messages, transcriptMessages(history(scenario.message), []), transcriptMessages(null, [run])]) {
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: native.id, normalized: true, status: scenario.status });
    expect(projected[0]!.retry).toEqual(scenario.message.retry); expect(projected[0]!.error).toEqual(scenario.message.error);
  }
});

test("same-ID retry recovery replaces journal diagnostics and live observation overrides stale journal status", () => {
  const run = createRun({ id: "run", conversationId: "A", cwd: "/fixture", status: "running", createdAt: "", harness: "opencode" });
  const emit = (seq: number, message: NativeMessage) => consume(run, [{ seq, time: "", runId: run.id, sessionId: "A", kind: "message", data: normalizeMessage(message)! }]);
  emit(1, { ...native, time: { created: 100, completed: 200 } });
  const observed = transcriptMessages(history(native), [run]);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ runId: run.id, status: "running", retry, error, time: new Date(300).toISOString() });
  emit(2, native);
  expect(run.messages).toHaveLength(1); expect(run.messages[0]).toMatchObject({ status: "running", retry });
  emit(3, { ...native, retry: undefined, error: undefined, time: { created: 300, completed: 600 } });
  expect(run.messages).toHaveLength(1); expect(run.messages[0]!.status).toBe("completed");
  expect(run.messages[0]!.retry).toBeUndefined(); expect(run.messages[0]!.error).toBeUndefined();
});
