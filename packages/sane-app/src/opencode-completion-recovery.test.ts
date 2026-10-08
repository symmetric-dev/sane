import { expect, test } from "bun:test";
import { OpenCodeError, type NativeMessage, type OpenCodeAdapter } from "./opencode";
import { verifyOpenCodeCompletion as verifyOperatorCompletion, type OperatorCompletionRequest } from "./opencode-completion-recovery";

const request: OperatorCompletionRequest = { nativeSessionId: "ses_A", cwd: "/fixture", commandId: "msg_command" };
const message = (id: string, type: string, created: number, extra: Partial<NativeMessage> = {}): NativeMessage => ({ id: `msg_${id}`, type, time: { created }, ...extra });
function fixture() {
  const state = { session: { id: "ses_A", location: { directory: "/fixture" }, time: { created: 1, updated: 90, idle: 80 as number | undefined }, outcome: undefined as "succeeded" | "failed" | "interrupted" | undefined, revert: undefined as unknown }, active: false, pending: false };
  const messages = [message("command", "user", 10), message("answer", "assistant", 20, { time: { created: 20, completed: 70 } }), message("idle", "idle", 80, { outcome: "succeeded" })];
  let reads = 0;
  const calls: string[] = [];
  const f = { state, messages, calls, second: () => {}, historyActivity: "idle" as "idle" | "active" };
  const native: Pick<OpenCodeAdapter, "activity" | "history"> = {
    async activity(id, cwd) { expect([id, cwd]).toEqual(["ses_A", "/fixture"]); calls.push("activity"); if (++reads === 2) f.second(); return structuredClone(state); },
    async history(id, cwd) { expect([id, cwd]).toEqual(["ses_A", "/fixture"]); calls.push("history"); return { rawMessages: messages, messages: [], activity: f.historyActivity }; },
  };
  return { ...f, f, native };
}
async function rejected(native: Pick<OpenCodeAdapter, "activity" | "history">, pattern: string, input = request) {
  try { await verifyOperatorCompletion(native, input); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(OpenCodeError); expect((error as OpenCodeError).status).toBe(409); expect((error as Error).message).toContain(pattern); }
}

for (const outcome of ["succeeded", "failed", "interrupted"] as const) test(`explicit operator verification records ${outcome} with unknown synthetics`, async () => {
  const f = fixture();
  f.messages.splice(1, 0, message("unknown", "synthetic", 15, { text: "arbitrary prose", metadata: { arbitrary: true } }));
  f.messages.at(-1)!.outcome = outcome;
  const result = await verifyOperatorCompletion(f.native, request);
  expect(result).toMatchObject({ ...request, nativeCreatedAt: 1, terminalMessageId: "msg_idle", outcome, boundaryIds: [{ messageId: "msg_unknown", type: "synthetic" }] });
  expect(result.activityDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(f.calls).toEqual(["activity", "history", "activity"]);
});

test("valid pinned identity is mandatory at runtime", async () => {
  const f = fixture();
  await rejected(f.native, "explicit operator", { ...request, commandId: undefined } as unknown as OperatorCompletionRequest);
  expect(f.calls).toEqual([]);
});

for (const field of ["active", "pending"] as const) for (const read of [1, 2]) test(`${field} on activity read ${read} rejects`, async () => {
  const f = fixture();
  if (read === 1) f.state[field] = true; else f.f.second = () => { f.state[field] = true; };
  await rejected(f.native, "busy");
});

for (const [name, mutate] of [
  ["identity", (f: ReturnType<typeof fixture>) => { f.state.session.id = "ses_B"; }],
  ["directory", (f: ReturnType<typeof fixture>) => { f.state.session.location.directory = "/other"; }],
  ["creation", (f: ReturnType<typeof fixture>) => { f.state.session.time.created = 2; }],
  ["updated", (f: ReturnType<typeof fixture>) => { f.state.session.time.updated++; }],
  ["idle", (f: ReturnType<typeof fixture>) => { f.state.session.time.idle = 81; }],
] as const) test(`changed ${name} rejects`, async () => {
  const f = fixture(); f.f.second = () => mutate(f); await rejected(f.native, "changed");
});

const badHistories: [string, (messages: NativeMessage[]) => void, string][] = [
  ["missing command", m => { m.shift(); }, "missing"],
  ["wrong command type", m => { m[0]!.type = "synthetic"; }, "not a user"],
  ["duplicate command", m => { m.unshift(m[0]!); }, "duplicate"],
  ["newer user", m => { m.splice(2, 0, message("newer", "user", 50)); }, "newer user"],
  ["after idle", m => { m.push(message("late", "synthetic", 85)); }, "after the latest idle"],
  ["no idle", m => { m.pop(); }, "missing terminal"],
  ["unknown outcome", m => { m.at(-1)!.outcome = "unknown"; }, "outcome"],
  ["unfinished assistant", m => { delete m[1]!.time.completed; }, "unfinished"],
  ["unfinished tool", m => { m[1]!.content = [{ type: "tool", state: { status: "running" } }]; }, "tool content"],
  ["missing tool state", m => { m[1]!.content = [{ type: "tool" }]; }, "tool content"],
  ["unfinished compaction", m => { m.splice(2, 0, message("compact", "compaction", 50, { status: "running" })); }, "unfinished"],
  ["invalid compaction", m => { m.splice(2, 0, message("compact", "compaction", 50, { status: "running", time: { created: 50, completed: 60 } })); }, "compaction status"],
  ["invalid timestamp", m => { m[1]!.time.created = NaN; }, "timestamps"],
  ["reversed completion", m => { m[1]!.time.completed = 19; }, "timestamps"],
  ["completion after idle", m => { m[1]!.time.completed = 81; }, "timestamps"],
  ["unknown message", m => { m.splice(2, 0, message("unknown", "unknown", 50)); }, "unknown native"],
  ["invalid retry", m => { m[1]!.retry = {} as never; }, "retry metadata"],
];
for (const [name, mutate, reason] of badHistories) test(`${name} fails closed`, async () => {
  const f = fixture(); mutate(f.messages); await rejected(f.native, reason);
});

test("completed failed retry is historical, unfinished retry still blocks", async () => {
  const f = fixture(), error = { type: "APIError", message: "overloaded" };
  f.messages[1]!.error = error; f.messages[1]!.retry = { attempt: 2, at: 50, error };
  expect((await verifyOperatorCompletion(f.native, request)).outcome).toBe("succeeded");
  delete f.messages[1]!.time.completed;
  await rejected(f.native, "unfinished");
});

test("completed compaction is included as an operator boundary", async () => {
  const f = fixture();
  f.messages.splice(2, 0, message("compact", "compaction", 50, { status: "completed", time: { created: 50, completed: 60 } }));
  expect((await verifyOperatorCompletion(f.native, request)).boundaryIds).toEqual([{ messageId: "msg_compact", type: "compaction" }]);
});

test("full-history budget and active history fail closed", async () => {
  const f = fixture(); f.f.historyActivity = "active"; await rejected(f.native, "active");
  f.f.historyActivity = "idle"; f.messages.push(...Array(10000).fill(f.messages[1])); await rejected(f.native, "oversized");
});

test("sequence order, not timestamps or ID sorting, determines newer users", async () => {
  const f = fixture(); f.messages.splice(2, 0, message("aaa", "user", 10)); await rejected(f.native, "newer user");
});

test("stable native idle timestamp rejects stale terminal history", async () => {
  const f = fixture(); f.state.session.time.idle = 85;
  await rejected(f.native, "timestamp differs");
});

test("stable native outcome rejects contradictory terminal history", async () => {
  const f = fixture(); f.state.session.outcome = "failed";
  await rejected(f.native, "outcome differs");
});

for (const outcome of ["succeeded", "failed", "interrupted"] as const) test(`matching native idle and ${outcome} outcome verifies`, async () => {
  const f = fixture(); f.state.session.outcome = outcome; f.messages.at(-1)!.outcome = outcome;
  expect((await verifyOperatorCompletion(f.native, request)).outcome).toBe(outcome);
});

test("absent optional native idle and outcome still permits terminal evidence", async () => {
  const f = fixture(); f.state.session.time.idle = undefined;
  expect((await verifyOperatorCompletion(f.native, request)).terminalMessageId).toBe("msg_idle");
});

for (const read of [1, 2]) test(`native revert on read ${read} rejects even when command remains visible`, async () => {
  const f = fixture();
  if (read === 1) f.state.session.revert = { messageID: "msg_answer" };
  else f.f.second = () => { f.state.session.revert = { messageID: "msg_answer" }; };
  await rejected(f.native, "native revert is present");
});

test("null revert is an unreverted session", async () => {
  const f = fixture(); f.state.session.revert = null;
  expect((await verifyOperatorCompletion(f.native, request)).outcome).toBe("succeeded");
});
