import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Run, Session } from "./history";
import type { MessageSnapshot } from "./oc-contract";
import type { ReconciledHistory } from "./reconcile";
import { TRANSCRIPT_PAGE_BYTES, type TranscriptMessage } from "./transcript-contract";
import { NativeHistoryCache, TranscriptService } from "./transcript-service";

const time = (second = 0) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
const query = (values: Record<string, string> = {}) => new URLSearchParams(values);
const snapshot = (id: string, role: MessageSnapshot["role"] = "user", patch: Partial<MessageSnapshot> = {}): MessageSnapshot => ({
  messageId: id, role, createdAt: time(1), status: "completed", parts: [{ id: `${id}:text`, type: "text", text: `  ${id}\n日本  ` }], ...patch,
});
const historyFor = (session: Session, messages: MessageSnapshot[]): ReconciledHistory => ({
  sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!, importedAt: time(10), activity: "idle", reason: "fixture only", coveredRunIds: [], messages,
});
const requestVersions = (messages: TranscriptMessage[]) => messages.map(({ id, version }) => ({ id, version }));

// Only structural history evidence is supplied; no native reader, SDK, or bridge.
function fixture(harness: Session["harness"] = "opencode") {
  const session: Session = { sessionId: "A", harness, nativeSessionId: harness === "opencode" ? "ses_A" : "native-A", authorityId: "fixture-authority", cwd: "/fixture", lastStatus: "unknown", lastRunId: null };
  const sessions = [session], runs: Run[] = [];
  let history: ReconciledHistory | undefined;
  const cache = { get: async () => history } as unknown as NativeHistoryCache;
  const service = new TranscriptService(() => sessions, () => runs, cache);
  const run = (id = "R"): Run => {
    const value: Run = { runId: id, sessionId: session.sessionId, cwd: session.cwd, status: "running", createdAt: time() };
    runs.push(value); return value;
  };
  const event = (run: Run, seq: number, kind: Event["kind"], data: unknown): Event => ({ runId: run.runId, sessionId: run.sessionId, seq, kind, data, time: time(seq) });
  return { session, sessions, runs, cache, service, run, event, history: (messages: MessageSnapshot[]) => { history = historyFor(session, messages); } };
}

test("empty projection and unchanged reads/replayed sequences retain revision, epoch, and full versions", async () => {
  const f = fixture();
  const empty = await f.service.page(f.session, query());
  expect(empty.messages).toEqual([]);
  expect(empty.coverage).toEqual({ firstId: null, lastId: null, firstIndex: null, lastIndex: null, totalMessages: 0, olderCursor: null, newerCursor: null });
  const run = f.run();
  const events = [f.event(run, 1, "submission", { text: "  prompt\n日本  " }), f.event(run, 2, "message", snapshot("msg_answer", "assistant"))];
  f.service.ingest(run, events);
  const first = await f.service.page(f.session, query());
  for (const envelope of first.messages) {
    const { version, ...message } = envelope;
    expect(version).toBe(createHash("sha256").update(JSON.stringify(message)).digest("base64url"));
  }
  expect(first.messages[0]!.parts).toEqual([{ type: "text", text: "  prompt\n日本  " }]);
  f.service.ingest(run, [...events, f.event(run, 3, "stderr", "diagnostic only")]);
  const repeated = await f.service.page(f.session, query());
  expect(repeated).toEqual(first);
  expect(repeated.messages[0]).toBe(first.messages[0]);
});

test("tail append and full in-place UPSERT preserve epoch/cursors and refresh only changed envelopes", async () => {
  const f = fixture(), run = f.run();
  f.service.ingest(run, [1, 2, 3].map(seq => f.event(run, seq, "message", snapshot(`msg_${seq}`))));
  const before = await f.service.page(f.session, query({ limit: "1" }));
  f.service.ingest(run, [f.event(run, 4, "message", snapshot("msg_4")), f.event(run, 5, "message", snapshot("msg_3", "user", { parts: [{ id: "text", type: "text", text: "replacement, not a delta" }] }))]);
  const after = await f.service.page(f.session, query());
  expect(after.epoch).toBe(before.epoch);
  expect(after.revision).not.toBe(before.revision);
  expect(after.messages.map(message => message.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
  const older = await f.service.page(f.session, query({ cursor: before.coverage.olderCursor!, limit: "1" }));
  expect(older.messages.map(message => message.id)).toEqual(["msg_2"]);
  const refreshed = await f.service.refresh(f.session, { epoch: before.epoch, messages: [...requestVersions(before.messages), { id: "unrecorded", version: "old" }] });
  expect(refreshed.upserts).toEqual([after.messages[2]!]);
  expect(refreshed.removedIds).toEqual(["unrecorded"]);
  expect(refreshed.processed).toBe(2);
  expect((await f.service.refresh(f.session, { epoch: after.epoch, messages: requestVersions(after.messages) })).upserts).toEqual([]);
});

test("output-only nested tool UPSERT changes the full version without changing epoch or unaffected message versions", async () => {
  const f = fixture(), run = f.run();
  const output = { content: [{ type: "text", text: "same visible text", detail: { result: [1, { value: "before" }] } }], metadata: { source: "fixture" } };
  const changedOutput = { ...output, content: [{ ...output.content[0]!, detail: { result: [1, { value: "after" }] } }] };
  const original = snapshot("msg_tool", "assistant", { parts: [
    { id: "text", type: "text", text: "unchanged message text" },
    { id: "reason", type: "reasoning", text: "unchanged reasoning" },
    { id: "call", type: "tool", name: "Read", status: "completed", input: { nested: { paths: ["fixture"] } }, output },
  ] });
  f.service.ingest(run, [f.event(run, 1, "message", snapshot("msg_stable")), f.event(run, 2, "message", original)]);
  const before = await f.service.page(f.session, query());
  f.service.ingest(run, [f.event(run, 3, "message", { ...original, parts: original.parts.map(part => part.type === "tool" ? { ...part, output: changedOutput } : part) })]);
  const after = await f.service.page(f.session, query());
  expect(after.epoch).toBe(before.epoch);
  expect(after.revision).not.toBe(before.revision);
  expect(after.coverage).toEqual(before.coverage);
  expect(after.messages[0]!.version).toBe(before.messages[0]!.version);
  expect(after.messages[1]!.version).not.toBe(before.messages[1]!.version);
  const { version, ...fullMessage } = after.messages[1]!;
  expect(version).toBe(createHash("sha256").update(JSON.stringify(fullMessage)).digest("base64url"));
  const expected = { ...before.messages[1]!, version, parts: before.messages[1]!.parts.map(part => part.type === "tool" ? { ...part, output: changedOutput } : part) };
  expect(after.messages[1]).toStrictEqual(expected);
  expect(before.messages[1]!.parts[2]).toMatchObject({ output });
  const refreshed = await f.service.refresh(f.session, { epoch: before.epoch, messages: requestVersions(before.messages) });
  expect(refreshed.epoch).toBe(before.epoch);
  expect(refreshed.processed).toBe(2);
  expect(refreshed.removedIds).toEqual([]);
  expect(refreshed.upserts).toStrictEqual([expected]);
});

test("a late submission inserted before existing output resets coverage rather than masquerading as append", async () => {
  const f = fixture(), run = f.run();
  f.service.ingest(run, [f.event(run, 1, "message", snapshot("msg_a", "assistant")), f.event(run, 2, "message", snapshot("msg_b"))]);
  const before = await f.service.page(f.session, query({ limit: "1" }));
  f.service.ingest(run, [f.event(run, 3, "submission", { text: "late recorded input" })]);
  const after = await f.service.page(f.session, query());
  expect(after.messages.map(message => message.id)).toEqual(["R:user", "msg_a", "msg_b"]);
  expect(after.epoch).not.toBe(before.epoch);
  await expect(f.service.page(f.session, query({ cursor: before.coverage.olderCursor! }))).rejects.toMatchObject({ status: 409, code: "transcript-reset" });
  await expect(f.service.refresh(f.session, { epoch: before.epoch, messages: requestVersions(before.messages) })).rejects.toMatchObject({ status: 409 });
});

test("equal-content native snapshot replacement and same-session identity changes reset epochs", async () => {
  const f = fixture();
  const messages = [snapshot("msg_1"), snapshot("msg_2")];
  f.history(messages);
  const first = await f.service.page(f.session, query({ limit: "1" }));
  f.history(messages);
  const replaced = await f.service.page(f.session, query({ limit: "1" }));
  expect(replaced.messages).toEqual(first.messages);
  expect(replaced.epoch).not.toBe(first.epoch);
  await expect(f.service.page(f.session, query({ cursor: first.coverage.olderCursor! }))).rejects.toMatchObject({ status: 409 });
  f.session.cwd = "/different-fixture";
  await expect(f.service.page(f.session, query({ cursor: replaced.coverage.olderCursor! }))).rejects.toMatchObject({ status: 409 });
});

test("signed older/newer pages have chronological nonoverlapping ranges and soft limits finish turns", async () => {
  const f = fixture();
  f.history([snapshot("u1"), snapshot("a1", "assistant"), snapshot("u2"), snapshot("a2", "assistant"), snapshot("a3", "assistant"), snapshot("u3")]);
  const latest = await f.service.page(f.session, query({ limit: "1" }));
  expect(latest.coverage).toMatchObject({ firstIndex: 5, lastIndex: 5, totalMessages: 6 });
  const older = await f.service.page(f.session, query({ cursor: latest.coverage.olderCursor!, limit: "1" }));
  expect(older.messages.map(message => message.id)).toEqual(["u2", "a2", "a3"]);
  expect(older.coverage).toMatchObject({ firstIndex: 2, lastIndex: 4 });
  expect(older.continuation).toEqual({ older: false, newer: false });
  const oldest = await f.service.page(f.session, query({ cursor: older.coverage.olderCursor!, limit: "1" }));
  expect(oldest.messages.map(message => message.id)).toEqual(["u1", "a1"]);
  const newer = await f.service.page(f.session, query({ cursor: oldest.coverage.newerCursor!, limit: "1" }));
  expect(newer.messages).toEqual(older.messages);
  expect(newer.coverage.firstIndex).toBe(oldest.coverage.lastIndex! + 1);
});

test("cursors reject tampering, foreign sessions and wrong kinds; restart yields reset only", async () => {
  const f = fixture();
  f.history([snapshot("msg_1"), snapshot("msg_2")]);
  f.run("R1"); f.run("R2");
  const page = await f.service.page(f.session, query({ limit: "1" }));
  const cursor = page.coverage.olderCursor!, [payload, signature] = cursor.split(".");
  const altered = `${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  await expect(f.service.page(f.session, query({ cursor: altered }))).rejects.toMatchObject({ status: 400, code: "transcript-input" });
  const other = { ...f.session, sessionId: "B", nativeSessionId: "ses_B" }; f.sessions.push(other);
  await expect(f.service.page(other, query({ cursor }))).rejects.toMatchObject({ status: 400 });
  const meta = await f.service.metadataPage(f.session, query({ limit: "1" }));
  await expect(f.service.page(f.session, query({ cursor: meta.nextCursor! }))).rejects.toMatchObject({ status: 400 });
  await expect(f.service.metadataPage(f.session, query({ cursor }))).rejects.toMatchObject({ status: 400 });
  const restarted = new TranscriptService(() => f.sessions, () => f.runs, f.cache);
  await expect(restarted.page(f.session, query({ cursor }))).rejects.toMatchObject({ status: 409, code: "transcript-reset" });
});

test("selectors and refresh requests fail closed on duplicates, malformed bounds and ambiguous targets", async () => {
  const f = fixture();
  for (const input of ["limit=0", "limit=101", "limit=01", "limit=1&limit=2", "unknown=1", "cursor=", "targetMessageId=x&targetRunId=R", "toolCallId=t", "targetKind=worker", "targetMessageId=%00"]) {
    await expect(f.service.page(f.session, new URLSearchParams(input))).rejects.toMatchObject({ status: 400, code: "transcript-input" });
  }
  const page = await f.service.page(f.session, query());
  await expect(f.service.page(f.session, query({ targetMessageId: "absent" }))).rejects.toMatchObject({ status: 404, code: "transcript-target-missing" });
  await expect(f.service.refresh(f.session, { epoch: page.epoch, messages: [{ id: "x", version: "v" }, { id: "x", version: "v" }] })).rejects.toMatchObject({ status: 400 });
  await expect(f.service.refresh(f.session, { epoch: page.epoch, messages: Array.from({ length: 101 }, (_, index) => ({ id: `m${index}`, version: "v" })) })).rejects.toMatchObject({ status: 400 });
});

test("bounded warnings invalidate metadata traversal, message-only changes do not, and terminal status clears connection", async () => {
  const f = fixture(), run = f.run(); f.run("R2");
  f.service.ingest(run, [f.event(run, 1, "message", snapshot("msg_a", "assistant"))]);
  const before = await f.service.metadataPage(f.session, query({ limit: "1" }));
  f.service.ingest(run, [f.event(run, 2, "message", snapshot("msg_a", "assistant", { parts: [{ id: "t", type: "text", text: "new text" }] }))]);
  const messageOnly = await f.service.metadataPage(f.session, query({ cursor: before.nextCursor! }));
  expect(messageOnly.metadataRevision).toBe(before.metadataRevision);
  expect(messageOnly.revision).not.toBe(before.revision);
  f.service.ingest(run, [f.event(run, 3, "status", { connection: "界".repeat(40), reason: "界".repeat(1000) })]);
  await expect(f.service.metadataPage(f.session, query({ cursor: before.nextCursor! }))).rejects.toMatchObject({ status: 409 });
  const warned = await f.service.metadataPage(f.session, query({ limit: "1" }));
  expect(warned.items[0]).toMatchObject({ kind: "run", run: { nativeConnection: "界".repeat(21), nativeReason: "界".repeat(682) } });
  expect(JSON.stringify(warned.items)).not.toContain("new text");
  f.service.ingest(run, [f.event(run, 4, "status", { status: "completed" })]);
  const cleared = await f.service.metadataPage(f.session, query());
  expect(cleared.items[0]).toMatchObject({ kind: "run", run: { nativeConnection: "", nativeReason: "" } });
  expect(cleared.metadataRevision).not.toBe(warned.metadataRevision);
});

test("OC full reasoning/tool payloads survive projection and usage excludes output and has no invented capacity", async () => {
  const f = fixture(), run = f.run();
  const input = { command: "  inspect\n日本  ", nested: [1, { enabled: true }] }, output = { content: ["raw", { detail: "full output" }] };
  f.service.ingest(run, [f.event(run, 1, "message", snapshot("msg_a", "assistant", {
    model: "provider/model", usage: { cost: 12, tokens: { input: 20, output: 9999, cache: { read: 30, write: 40 } } }, error: { message: "retained failure" },
    parts: [{ id: "reason", type: "reasoning", text: "  think\n日本  " }, { id: "call", type: "tool", name: "Read", input, output, status: "completed" }],
  }))]);
  const page = await f.service.page(f.session, query({ targetRunId: "R", toolCallId: "call" }));
  expect(page.usage).toEqual({ tokens: 90, model: "provider/model", time: time(1) });
  expect(page.messages[0]).toMatchObject({ error: { message: "retained failure" }, parts: [{ type: "reasoning", id: "reason", text: "  think\n日本  " }, { type: "tool", id: "call", toolCallId: "call", name: "Read", input, output, toolStatus: "completed", error: false }] });
  expect(page.target).toEqual({ messageId: "msg_a", toolCallId: "call" });
});

test("CC object and split raw stdout yield identical full messages, native aliases, tools, and authoritative usage", async () => {
  const object = fixture("claude-code"), raw = fixture("claude-code");
  const assistant = { type: "assistant", session_id: "native-A", uuid: "native-alias", message: { id: "assistant-id", model: "claude-model", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 500 }, content: [{ type: "text", text: "  answer\n日本  " }, { type: "thinking", thinking: "reason" }, { type: "tool_use", id: "call", name: "Read", input: { file: "fixture" } }] } };
  const output = [{ type: "text", text: "retained output" }];
  const result = { type: "user", session_id: "native-A", message: { content: [{ type: "tool_result", tool_use_id: "call", content: output, is_error: false }] } };
  const usage = { type: "result", session_id: "native-A", uuid: "result-id", modelUsage: { "claude-model": { contextWindow: 1000, inputTokens: 99999 } } };
  for (const [f, chunked] of [[object, false], [raw, true]] as const) {
    const run = f.run(), encoded = JSON.stringify(assistant), middle = Math.floor(encoded.length / 2);
    const records = chunked ? [[2, encoded.slice(0, middle)], [3, encoded.slice(middle) + "\n"], [4, JSON.stringify(result) + "\n"], [5, JSON.stringify(usage)]] as const : [[2, assistant], [4, result], [5, usage]] as const;
    const events = [f.event(run, 1, "submission", { text: "prompt" }), ...records.map(([seq, data]) => f.event(run, seq, "stdout", data))].map(event => ({ ...event, time: time(1) }));
    f.service.ingest(run, events);
  }
  const objectPage = await object.service.page(object.session, query({ targetMessageId: "native-alias", toolCallId: "call" }));
  const rawPage = await raw.service.page(raw.session, query({ targetMessageId: "native-alias", toolCallId: "call" }));
  expect(rawPage.messages).toEqual(objectPage.messages);
  expect(rawPage.usage).toEqual({ tokens: 60, model: "claude-model", time: time(1), capacity: 1000, percentage: 6 });
  expect(rawPage.target).toEqual({ messageId: "R:assistant:assistant-id", toolCallId: "call" });
  expect(rawPage.messages[1]).toMatchObject({ nativeIds: ["native-alias"], parts: [{ type: "text", text: "  answer\n日本  " }, { type: "reasoning", text: "reason" }, { type: "tool", input: { file: "fixture" }, output, error: false }] });
});

test("oversized messages stay whole and alone while older/newer navigation and exact targets make progress", async () => {
  const f = fixture(), huge = "界".repeat(TRANSCRIPT_PAGE_BYTES / 2);
  f.history([snapshot("u1"), snapshot("huge", "assistant", { parts: [{ id: "huge-tool", type: "tool", name: "Read", input: { full: huge }, output: huge, status: "completed" }] }), snapshot("u2"), snapshot("a2", "assistant")]);
  const latest = await f.service.page(f.session, query({ limit: "1" }));
  expect(latest.messages.map(message => message.id)).toEqual(["u2", "a2"]);
  const older = await f.service.page(f.session, query({ cursor: latest.coverage.olderCursor!, limit: "100" }));
  expect(older.messages).toHaveLength(1);
  expect(older.coverage).toMatchObject({ firstId: "huge", firstIndex: 1, lastIndex: 1, totalMessages: 4 });
  expect(older.continuation.older).toBe(true);
  expect(older.messages[0]!.parts[0]).toMatchObject({ input: { full: huge }, output: huge });
  const oldest = await f.service.page(f.session, query({ cursor: older.coverage.olderCursor! }));
  expect(oldest.messages.map(message => message.id)).toEqual(["u1"]);
  const newer = await f.service.page(f.session, query({ cursor: oldest.coverage.newerCursor! }));
  expect(newer.messages).toEqual(older.messages);
  const targeted = await f.service.page(f.session, query({ targetMessageId: "huge", toolCallId: "huge-tool", limit: "100" }));
  expect(targeted.messages).toEqual(older.messages);
  expect(targeted.target).toEqual({ messageId: "huge", toolCallId: "huge-tool" });
});

test("refresh admits one complete oversized UPSERT and reports the suffix boundary for subsequent progress", async () => {
  const f = fixture(), run = f.run(), huge = "x".repeat(TRANSCRIPT_PAGE_BYTES + 1);
  f.service.ingest(run, [f.event(run, 1, "message", snapshot("huge")), f.event(run, 2, "message", snapshot("small"))]);
  const before = await f.service.page(f.session, query());
  f.service.ingest(run, [f.event(run, 3, "message", snapshot("huge", "user", { parts: [{ id: "text", type: "text", text: huge }] })), f.event(run, 4, "message", snapshot("small", "user", { parts: [{ id: "text", type: "text", text: "updated" }] }))]);
  const requested = requestVersions(before.messages);
  const first = await f.service.refresh(f.session, { epoch: before.epoch, messages: requested });
  expect(first.processed).toBe(1);
  expect(first.upserts).toHaveLength(1);
  expect(first.upserts[0]!.parts).toEqual([{ type: "text", text: huge }]);
  const second = await f.service.refresh(f.session, { epoch: before.epoch, messages: requested.slice(first.processed) });
  expect(second.processed).toBe(1);
  expect(second.upserts[0]!.id).toBe("small");
  const removalFirst = await f.service.refresh(f.session, { epoch: before.epoch, messages: [{ id: "absent", version: "old" }, requested[0]!] });
  expect(removalFirst).toMatchObject({ removedIds: ["absent"], upserts: [], processed: 1 });
});

test("oversized CC tool messages retain native aliases and resolve the same full original-send worker target", async () => {
  const f = fixture("claude-code"), run = f.run(), huge = "output\n日本  ".repeat(TRANSCRIPT_PAGE_BYTES / 8);
  const resolutions: string[] = [];
  const service = new TranscriptService(() => f.sessions, () => f.runs, f.cache, async (session, kind, id) => {
    resolutions.push(`${session.sessionId}:${kind}:${id}`);
    return kind === "worker" && id === "worker-fixture" ? { kind: "worker", runId: run.runId, toolCallId: "send-call" } : undefined;
  });
  service.ingest(run, [
    f.event(run, 1, "submission", { text: "original prompt" }),
    f.event(run, 2, "stdout", { type: "assistant", session_id: "native-A", uuid: "send-alias", message: { id: "send-message", content: [{ type: "tool_use", id: "send-call", name: "Worker", input: { prompt: "  original worker instructions  " } }] } }),
    f.event(run, 3, "stdout", { type: "user", session_id: "native-A", message: { content: [{ type: "tool_result", tool_use_id: "send-call", content: huge }] } }),
  ]);
  const alias = await service.page(f.session, query({ targetMessageId: "send-alias", toolCallId: "send-call", limit: "100" }));
  const worker = await service.page(f.session, query({ targetKind: "worker", targetId: "worker-fixture", limit: "100" }));
  expect(alias.messages).toHaveLength(1);
  expect(alias.messages[0]).toMatchObject({ id: "R:assistant:send-message", nativeIds: ["send-alias"], parts: [{ type: "tool", toolCallId: "send-call", input: { prompt: "  original worker instructions  " }, output: huge }] });
  expect(worker.messages).toEqual(alias.messages);
  expect(worker.target).toEqual({ messageId: "R:assistant:send-message", toolCallId: "send-call" });
  expect(resolutions).toEqual(["A:worker:worker-fixture"]);
  await expect(service.page(f.session, query({ targetKind: "worker", targetId: "foreign-worker" }))).rejects.toMatchObject({ status: 404, code: "transcript-target-missing" });
});

test("scratch NativeHistoryCache coalesces reads, detects atomic replacement, validates identity, and forgets missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "transcript-cache-"));
  try {
    const f = fixture(), cache = new NativeHistoryCache(root), file = join(root, "A.native-history.json"), replacement = join(root, "replacement.json");
    await writeFile(file, JSON.stringify(historyFor(f.session, [snapshot("first")])));
    const [first, same] = await Promise.all([cache.get(f.session), cache.get(f.session)]);
    expect(same).toBe(first);
    expect(await cache.get(f.session)).toBe(first);
    await writeFile(replacement, JSON.stringify(historyFor(f.session, [snapshot("second")])));
    await rename(replacement, file);
    const second = await cache.get(f.session);
    expect(second).not.toBe(first);
    expect(second!.messages[0]!.messageId).toBe("second");
    await writeFile(replacement, JSON.stringify({ ...historyFor(f.session, []), nativeSessionId: "wrong" }));
    await rename(replacement, file);
    await expect(cache.get(f.session)).rejects.toThrow("identity mismatch");
    await writeFile(file, JSON.stringify(historyFor(f.session, [])));
    expect((await cache.get(f.session))!.messages).toEqual([]);
    await rm(file);
    expect(await cache.get(f.session)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
