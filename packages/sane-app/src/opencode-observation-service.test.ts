import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Session } from "./history";
import { OpenCodeError, type NativeMessage, type OpenCodeAdapter } from "./opencode";
import { OpenCodeObservationService } from "./opencode-observation-service";
import { TranscriptService } from "./transcript-service";

let now = 10_000;
let restoreClock: () => void;
beforeEach(() => {
  now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
});
afterEach(() => restoreClock());

const message = (id: string, type = "user", created = 100): NativeMessage => ({
  id: `msg_${id}`, type, time: { created, ...(type === "assistant" ? { completed: created + 1 } : {}) },
  ...(type === "assistant" ? { content: [{ type: "text", text: id }] } : { text: id }),
});
const page = (data: NativeMessage[], next: string | null = null) => ({ data, cursor: { next } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture() {
  const session: Session = { sessionId: "A", harness: "opencode", authorityId: "mock", nativeSessionId: "ses_A", cwd: "/fixture", lastStatus: "unknown", lastRunId: null };
  const requests: { path: string; method: string; timeout?: number }[] = [];
  const activities: { id: string; cwd: string }[] = [];
  let active = false, pending = false, revert: unknown = undefined;
  let read: (path: string) => Promise<unknown> = async path => path === "/api/session/active" ? { data: {} } : page([message("one")]);
  let state = async (id: string, cwd: string) => ({ active, pending, session: { id, location: { directory: cwd }, time: { created: 1, updated: 2 }, revert } });
  const adapter = {
    path: (id: string) => `/api/session/${id}`,
    request: async (path: string, method: string, _body: unknown, _headers: unknown, timeout?: number) => { requests.push({ path, method, timeout }); return read(path); },
    activity: async (id: string, cwd: string) => { activities.push({ id, cwd }); return state(id, cwd); },
  } as unknown as Pick<OpenCodeAdapter, "request" | "activity" | "path">;
  const service = new OpenCodeObservationService(adapter);
  return { session, service, requests, activities,
    read: (value: typeof read) => { read = value; },
    state: (value: typeof state) => { state = value; },
    activity: (a: boolean, p = false) => { active = a; pending = p; },
    revert: (value: unknown) => { revert = value; },
  };
}

for (const active of [false, true]) test(`same-identity ${active ? "active" : "idle"} reads coalesce and TTL expires exactly at 1 second`, async () => {
  const f = fixture(), gate = deferred<unknown>(); f.activity(active); f.read(async () => gate.promise);
  const first = f.service.get(f.session), second = f.service.get({ ...f.session });
  gate.resolve(page([message("one")]));
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b); expect(a.activity).toBe(active ? "active" : "idle");
  expect(f.requests).toHaveLength(1); expect(f.activities).toHaveLength(2);
  now += 999; expect(await f.service.get(f.session)).toBe(a); expect(f.requests).toHaveLength(1);
  now++; expect(await f.service.get(f.session)).toBe(a); expect(f.requests).toHaveLength(2);
  expect(f.requests.every(request => request.method === "GET" && request.timeout! > 0 && request.timeout! <= 15_000)).toBe(true);
});

test("active-session endpoint coalesces, caches only successful values, and never fabricates idle on failure", async () => {
  const f = fixture(), gate = deferred<unknown>(); f.read(async () => gate.promise);
  const a = f.service.active(), b = f.service.active(); gate.resolve({ data: { ses_A: { type: "busy" } } });
  const [first, second] = await Promise.all([a, b]); expect(first).toEqual({ ses_A: { type: "busy" } }); expect(second).toBe(first);
  now += 999; expect(await f.service.active()).toBe(first); expect(f.requests).toHaveLength(1);
  now++; f.read(async () => { throw new Error("offline"); });
  await expect(f.service.active()).rejects.toBeInstanceOf(OpenCodeError);
  f.read(async () => ({ data: { ses_A: { type: "idle" } } }));
  expect(await f.service.active()).toEqual({ ses_A: { type: "idle" } }); expect(f.requests).toHaveLength(3);
});

for (const change of [{ authorityId: "other" }, { nativeSessionId: "ses_B" }, { cwd: "/other" }, { sessionId: "B" }]) {
  test(`GET cache is scoped to pinned identity ${Object.keys(change)[0]}`, async () => {
    const f = fixture(), first = await f.service.get(f.session), changed = { ...f.session, ...change };
    expect(f.service.peek(changed)).toBeUndefined();
    const second = await f.service.get(changed); expect(second).not.toBe(first); expect(f.requests).toHaveLength(2);
    expect(f.activities.at(-1)).toEqual({ id: changed.nativeSessionId!, cwd: changed.cwd });
  });
}

test("superseded in-flight identity cannot publish into the replacement cache", async () => {
  const f = fixture(), gate = deferred<unknown>();
  f.read(async path => path.includes("ses_A/") ? gate.promise : page([message("new")]));
  const old = f.service.get(f.session);
  // Attach a rejection handler before releasing either read, without asking
  // Bun's promise matcher to wait before the gate can be released.
  const outcome = old.catch(error => error);
  const replacement = { ...f.session, nativeSessionId: "ses_B" };
  const fresh = await f.service.get(replacement); gate.resolve(page([message("old")]));
  expect(await outcome).toMatchObject({ status: 409 });
  expect(f.service.peek(replacement)).toBe(fresh); expect(f.service.peek(f.session)).toBeUndefined();
});

test("overlapping incremental pages append once and UPSERT complete content without replacing the prefix", async () => {
  const f = fixture(); f.read(async () => page([message("three", "assistant"), message("two"), message("one")]));
  const first = await f.service.get(f.session); now += 1000;
  const changed = { ...message("three", "assistant"), content: [{ type: "text", text: "full replacement" }] };
  f.read(async () => page([message("four"), changed, message("two")], "older-cursor"));
  const second = await f.service.get(f.session);
  expect(second.messages.map(m => m.messageId)).toEqual(["msg_one", "msg_two", "msg_three", "msg_four"]);
  expect(second.messages[2]!.parts).toEqual([{ id: "msg_three:part:0", type: "text", text: "full replacement" }]);
  expect(first.messages[2]!.parts[0]).toMatchObject({ text: "three" });
  expect(f.requests).toHaveLength(2);
});

test("unfinished old tool is reread outside the overlap while finished prefix is not reread", async () => {
  const f = fixture();
  const old = { ...message("tool", "assistant"), content: [{ type: "tool", id: "call", name: "Read", state: { status: "running", input: { file: "a" } } }] };
  f.read(async () => page([message("tail"), old, message("finished", "assistant")]));
  const first = await f.service.get(f.session); now += 1000;
  f.read(async path => path.endsWith("/message/msg_tool") ? { data: { ...old, content: [{ ...old.content[0]!, state: { status: "completed", input: { file: "a" }, content: { full: "output" } } }] } } : page([message("new"), message("tail")], "older"));
  const next = await f.service.get(f.session);
  expect(next.messages.map(m => m.messageId)).toEqual(["msg_finished", "msg_tool", "msg_tail", "msg_new"]);
  expect(next.messages[1]!.parts[0]).toMatchObject({ type: "tool", status: "completed", output: { full: "output" } });
  expect(first.messages[1]!.parts[0]).toMatchObject({ status: "running" });
  expect(f.requests.map(r => r.path).filter(path => /\/message\/msg_/.test(path))).toEqual(["/api/session/ses_A/message/msg_tool"]);
});

test("assistant retry can reset creation time in overlap without changing native order or duplicating its ID", async () => {
  const f = fixture();
  f.read(async () => page([message("answer", "assistant"), message("prompt")]));
  const prior = await f.service.get(f.session); now += 1000;
  const retry = { attempt: 2, at: 350, error: { type: "APIError", message: "overloaded", data: { statusCode: 503 } } };
  f.read(async () => page([{ ...message("answer", "assistant"), time: { created: 300 }, error: retry.error, retry }], "older"));
  const next = await f.service.get(f.session);
  expect(next.messages.map(m => m.messageId)).toEqual(["msg_prompt", "msg_answer"]);
  expect(next.messages[1]).toMatchObject({ createdAt: new Date(300).toISOString(), status: "running", retry, error: retry.error });
  expect(prior.messages[1]).toMatchObject({ createdAt: new Date(100).toISOString(), status: "completed" });
});

for (const change of [
  { name: "nonassistant creation", original: message("guard"), changed: message("guard", "user", 200), error: "Conflicting immutable native message identity" },
  { name: "assistant type", original: message("guard", "assistant"), changed: message("guard", "user"), error: "Conflicting immutable native message identity" },
  { name: "assistant session", original: message("guard", "assistant"), changed: { ...message("guard", "assistant", 200), sessionID: "ses_other" }, error: "Invalid native observation message identity or timestamp" },
]) test(`retry timestamp relaxation preserves ${change.name} guard and prior projection`, async () => {
  const f = fixture(); f.read(async () => page([change.original]));
  const prior = await f.service.get(f.session); now += 1000;
  f.read(async () => page([change.changed]));
  await expect(f.service.get(f.session)).rejects.toThrow(change.error);
  expect(f.service.peek(f.session)).toBe(prior);
});

test("completed error plus retry is refreshed outside overlap until recovered, while terminal neighbors are retained", async () => {
  const f = fixture(), retry = { attempt: 1, at: 150, error: { type: "APIError", message: "overloaded" } };
  const failed = { ...message("retry", "assistant"), error: retry.error, retry };
  f.read(async () => page([message("tail"), failed, { ...message("failed", "assistant"), error: retry.error }, { ...message("done", "assistant"), retry }]));
  const prior = await f.service.get(f.session); now += 1000;
  expect(prior.messages[2]).toMatchObject({ status: "failed", retry });
  f.read(async path => path.endsWith("/message/msg_retry")
    ? { data: { ...message("retry", "assistant", 300), content: [{ type: "text", text: "recovered" }] } }
    : page([message("new"), message("tail")], "older"));
  const next = await f.service.get(f.session);
  expect(next.messages.map(m => m.messageId)).toEqual(["msg_done", "msg_failed", "msg_retry", "msg_tail", "msg_new"]);
  expect(next.messages[2]).toMatchObject({ status: "completed", createdAt: new Date(300).toISOString(), parts: [{ text: "recovered" }] });
  expect(next.messages[2]!.retry).toBeUndefined(); expect(next.messages[2]!.error).toBeUndefined();
  expect(f.requests.filter(r => /\/message\/msg_/.test(r.path)).map(r => r.path)).toEqual(["/api/session/ses_A/message/msg_retry"]);
  now += 1000; f.read(async () => page([message("new")], "older"));
  await f.service.get(f.session);
  expect(f.requests.filter(r => /\/message\/msg_/.test(r.path))).toHaveLength(1);
});

test("native queued delivery order wins over creation timestamps, including incremental overlap", async () => {
  const f = fixture(); f.read(async () => page([message("answer", "assistant", 300), message("prompt", "user", 100)]));
  await f.service.get(f.session); now += 1000;
  f.read(async () => page([message("queued_answer", "assistant", 400), message("queued", "user", 150), message("answer", "assistant", 300)], "older"));
  expect((await f.service.get(f.session)).messages.map(m => m.messageId)).toEqual(["msg_prompt", "msg_answer", "msg_queued", "msg_queued_answer"]);
});

test("native text and reasoning provider state is not mistaken for tool execution state", async () => {
  const f = fixture();
  const native = { ...message("provider", "assistant"), content: [
    { type: "reasoning", text: "", state: { itemId: "reasoning-item", reasoningEncryptedContent: "private-provider-payload" } },
    { type: "text", text: "visible continuation", state: { itemId: "text-item", phase: "final" } },
  ] } as unknown as NativeMessage;
  f.read(async () => page([native]));
  const history = await f.service.get(f.session);
  expect(history.messages[0]!.parts).toEqual([
    { id: "msg_provider:part:0", type: "reasoning", text: "" },
    { id: "msg_provider:part:1", type: "text", text: "visible continuation" },
  ]);
  expect(JSON.stringify(history)).not.toContain("private-provider-payload");
});

test("revert bypasses overlap and a complete read replaces removed history rather than retaining stale prefix", async () => {
  const f = fixture(); f.read(async () => page([message("tail"), message("removed")])); await f.service.get(f.session); now += 1000;
  f.revert({ messageID: "msg_tail" });
  f.read(async path => path.includes("cursor=") ? page([message("replacement")]) : page([message("tail")], "older"));
  expect((await f.service.get(f.session)).messages.map(m => m.messageId)).toEqual(["msg_replacement", "msg_tail"]);
  expect(f.requests.at(-1)!.path).toContain("cursor=older"); now += 1000;
  f.read(async () => page([message("tail")]));
  expect((await f.service.get(f.session)).messages.map(m => m.messageId)).toEqual(["msg_tail"]);
});

test("unavailable or malformed reads reject while retaining the previous active projection", async () => {
  const f = fixture(); f.activity(false, true); const prior = await f.service.get(f.session); expect(prior.activity).toBe("active"); now += 1000;
  for (const response of [() => { throw new Error("offline"); }, () => ({ data: [], cursor: "invalid" }), () => page([{ ...message("one"), time: { created: -1 } }])]) {
    f.read(async () => response()); await expect(f.service.get(f.session)).rejects.toBeInstanceOf(OpenCodeError);
    expect(f.service.peek(f.session)).toBe(prior);
  }
  f.read(async () => page([message("one")])); f.activity(false);
  expect((await f.service.get(f.session)).activity).toBe("idle");
});

test("changed native directory or immutable message identity fails closed", async () => {
  const f = fixture(), prior = await f.service.get(f.session); now += 1000;
  f.read(async () => page([message("one", "user", 200)]));
  await expect(f.service.get(f.session)).rejects.toMatchObject({ status: 409 }); expect(f.service.peek(f.session)).toBe(prior);
  f.state(async id => ({ active: false, pending: false, session: { id, location: { directory: "/wrong" }, time: { created: 1, updated: 2 }, revert: undefined } }));
  await expect(f.service.get(f.session)).rejects.toMatchObject({ status: 409 }); expect(f.service.peek(f.session)).toBe(prior);
});

test("100-page/10,000-message budget never publishes a truncated history", async () => {
  const f = fixture(), prior = await f.service.get(f.session); now += 1000; let pages = 0;
  f.read(async () => { const n = pages++; return page(Array.from({ length: 100 }, (_, i) => message(`budget_${n * 100 + i}`)), `cursor_${n}`); });
  await expect(f.service.get(f.session)).rejects.toThrow("10,000-message page budget");
  expect(pages).toBe(100); expect(f.service.peek(f.session)).toBe(prior);
});

test("provider payloads larger than 16 MiB do not block display history or change its revision", async () => {
  const f = fixture();
  const native = { ...message("provider", "assistant"), content: [
    { type: "reasoning", text: "", state: { reasoningEncryptedContent: "x".repeat(17 * 1024 * 1024) } },
    { type: "text", text: "visible answer" },
  ] };
  f.read(async () => page([native as unknown as NativeMessage]));
  const first = await f.service.get(f.session);
  expect(first.messages[0]!.parts).toEqual([
    { id: "msg_provider:part:0", type: "reasoning", text: "" },
    { id: "msg_provider:part:1", type: "text", text: "visible answer" },
  ]);
  expect(JSON.stringify(first).length).toBeLessThan(2048);
  now += 1000;
  f.read(async () => page([{ ...native, content: [
    { ...native.content[0]!, state: { reasoningEncryptedContent: "different provider state" } }, native.content[1]!,
  ] } as unknown as NativeMessage]));
  expect(await f.service.get(f.session)).toBe(first);
});

test("compaction evidence remains complete when normalization exceeds 16 MiB", async () => {
  const f = fixture();
  const oversized = { ...message("compaction", "compaction"), status: "failed", error: "x".repeat(8 * 1024 * 1024) };
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(16 * 1024 * 1024);
  f.read(async () => page([oversized]));
  const history = await f.service.get(f.session);
  expect(history.messages[0]!.error).toBe(oversized.error);
  expect(history.messages[0]!.compaction).toMatchObject({ lifecycle: "failed", error: oversized.error });
});

test("incremental history can cross 16 MiB without losing its prefix or new content", async () => {
  const f = fixture(), large = "x".repeat(9 * 1024 * 1024);
  f.read(async () => page([message("tail"), { ...message("large_old"), text: large }]));
  const prior = await f.service.get(f.session); now += 1000;
  f.read(async () => page([{ ...message("large_new"), text: large }, message("tail")], "older"));
  const next = await f.service.get(f.session);
  expect(next.messages.map(m => m.messageId)).toEqual(["msg_large_old", "msg_tail", "msg_large_new"]);
  expect(next.messages[0]).toBe(prior.messages[0]);
  expect(next.messages[2]!.parts[0]).toMatchObject({ text: large });
  expect(f.service.peek(f.session)).toBe(next);
});

test("cold oversized history supports latest, older, targeted pages and refresh without truncating messages", async () => {
  const f = fixture(), large = "x".repeat(17 * 1024 * 1024);
  f.read(async path => path.includes("cursor=")
    ? page([{ ...message("large_old"), text: large }])
    : page([message("latest")], "older"));
  const transcripts = new TranscriptService(() => [f.session], () => [], f.service);
  const latest = await transcripts.page(f.session, new URLSearchParams());
  expect(latest.messages.map(m => m.id)).toEqual(["msg_latest"]);
  expect(latest.coverage.totalMessages).toBe(2);
  expect(f.requests).toHaveLength(2);
  const older = await transcripts.page(f.session, new URLSearchParams({ cursor: latest.coverage.olderCursor! }));
  expect(older.messages.map(m => m.id)).toEqual(["msg_large_old"]);
  expect(older.messages[0]!.parts[0]).toMatchObject({ text: large });
  expect(older.coverage.olderCursor).toBeNull();
  const target = await transcripts.page(f.session, new URLSearchParams({ targetMessageId: "msg_large_old" }));
  expect(target.messages).toEqual(older.messages);
  now += 1000;
  f.read(async () => page([{ ...message("latest"), text: "updated" }, { ...message("large_old"), text: large + "!" }]));
  const refreshed = await transcripts.refresh(f.session, { epoch: latest.epoch, messages: older.messages.map(({ id, version }) => ({ id, version })) });
  expect(refreshed.removedIds).toEqual([]);
  expect(refreshed.upserts).toHaveLength(1);
  expect(refreshed.upserts[0]!.parts[0]).toMatchObject({ text: large + "!" });
});

test("exactly 10,000 messages can publish, but incremental append beyond the retained-message budget cannot", async () => {
  const f = fixture(); let pages = 0;
  f.read(async () => {
    const n = pages++;
    return page(Array.from({ length: 100 }, (_, i) => message(`limit_${9999 - n * 100 - i}`)), n === 99 ? null : `cursor_${n}`);
  });
  const prior = await f.service.get(f.session);
  expect(prior.messages).toHaveLength(10_000); expect(prior.messages[0]!.messageId).toBe("msg_limit_0"); expect(prior.messages.at(-1)!.messageId).toBe("msg_limit_9999");
  now += 1000; f.read(async () => page([message("limit_10000"), message("limit_9999")], "older"));
  await expect(f.service.get(f.session)).rejects.toThrow("history exceeds 10,000 messages"); expect(f.service.peek(f.session)).toBe(prior);
});

test("15-second total deadline fails without publishing even if individual mocked requests resolve", async () => {
  const f = fixture(), prior = await f.service.get(f.session); now += 1000;
  const monotonic = spyOn(performance, "now"); let elapsed = 0; monotonic.mockImplementation(() => elapsed);
  try {
    f.read(async () => { elapsed = 15_001; return page([message("late")]); });
    await expect(f.service.get(f.session)).rejects.toThrow("15-second budget"); expect(f.service.peek(f.session)).toBe(prior);
  } finally { monotonic.mockRestore(); }
});
