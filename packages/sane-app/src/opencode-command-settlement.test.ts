import { expect, test } from "bun:test";
import { settleCommandInterval } from "./opencode-command-settlement";
import { OpenCodeAdapter, type NativeMessage } from "./opencode";

function fixture() {
  const session = { id: "ses_fixture", location: { directory: "/fixture" }, outcome: "succeeded", time: { created: 1, updated: 2, idle: 9 } };
  const messages: NativeMessage[] = [
    { id: "msg_command", type: "user", time: { created: 2 } },
    { id: "msg_retry", type: "assistant", time: { created: 3, completed: 4 }, error: { type: "provider.transport", message: "WebSocket closed with code 1012" } },
    { id: "msg_continuation", type: "synthetic", time: { created: 5 }, text: "Any future native continuation wording" },
    { id: "msg_answer", type: "assistant", time: { created: 6, completed: 8 }, content: [{ type: "text", text: "Done" }] },
    { id: "msg_idle", type: "idle", time: { created: 9 }, outcome: "succeeded" },
  ];
  return { session, messages };
}

for (const outcome of ["succeeded", "failed", "interrupted"] as const) test(`sealed continuation interval preserves native ${outcome}`, () => {
  const { session, messages } = fixture(); session.outcome = outcome; messages.at(-1)!.outcome = outcome;
  expect(settleCommandInterval(messages, "msg_command", session, structuredClone(session))).toEqual({
    kind: "quiescent-command-interval", commandId: "msg_command", terminalMessageId: "msg_idle", outcome,
    nativeCreatedAt: 1, nativeUpdatedAt: 2, continuationIds: ["msg_continuation"],
  });
});

const defects: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "foreign user": f => { f.messages[2]!.type = "user"; },
  "missing command": f => { f.messages.shift(); },
  "duplicate identity": f => { f.messages[2]!.id = "msg_command"; },
  "work after idle": f => { f.messages.push({ id: "msg_more", type: "synthetic", time: { created: 10 } }); },
  "unfinished tool": f => { f.messages[3]!.content = [{ type: "tool", state: { status: "running" } }]; },
  "unfinished assistant": f => { delete f.messages[3]!.time.completed; },
  "unfinished compaction": f => { f.messages[3]!.type = "compaction"; f.messages[3]!.status = "running"; },
  "foreign outcome": f => { f.session.outcome = "failed"; },
  "foreign idle": f => { f.session.time.idle = 10; },
  "invalid time": f => { f.messages[2]!.time.created = NaN; },
  "completion after idle": f => { f.messages[3]!.time.completed = 10; },
  "unknown message": f => { f.messages[2]!.type = "future-command"; },
};
for (const [name, mutate] of Object.entries(defects)) test(`automatic settlement refuses ${name}`, () => {
  const f = fixture(); mutate(f);
  expect(settleCommandInterval(f.messages, "msg_command", f.session, f.session)).toBeUndefined();
});

test("restart, identity drift and revert cannot reuse a stale settlement certificate", () => {
  const { session, messages } = fixture();
  for (const after of [
    { ...session, id: "ses_other" }, { ...session, location: { directory: "/other" } },
    { ...session, time: { ...session.time, created: 2 } }, { ...session, time: { ...session.time, updated: 3 } },
    { ...session, time: { ...session.time, idle: 10 } }, { ...session, revert: { messageID: "msg_command" } },
  ]) expect(settleCommandInterval(messages, "msg_command", session, after)).toBeUndefined();
});

function adapterFixture() {
  const f = fixture(), adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const state = { active: false, inbox: [] as unknown[], reads: 0, confirmations: 0, mutate: () => {} };
  adapter.request = async <T>(path: string, method = "GET"): Promise<T> => {
    expect(method).toBe("GET"); // Reconciliation never submits, interrupts, or deletes.
    if (path.includes("/message?")) { state.reads++; return { data: [...f.messages].reverse(), cursor: { next: "unrelated-older-history" } } as T; }
    if (path.endsWith("/active")) return { data: state.active ? { ses_fixture: { type: "running" } } : {} } as T;
    if (path.endsWith("/inbox")) return { data: state.inbox } as T;
    if (++state.confirmations === 3) state.mutate();
    return { data: structuredClone(f.session) } as T;
  };
  return { ...f, adapter, state };
}

for (const policy of [undefined, "native-queued-handoff"] as const) test(`automatic settlement crosses retry without operator action (${policy ?? "ordinary"})`, async () => {
  const f = adapterFixture();
  const result = await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture", policy);
  expect(result.observation).toEqual({ kind: "exact-terminal", outcome: "succeeded" });
  expect(result.settlement?.continuationIds).toEqual(["msg_continuation"]);
  expect(result.boundary).toBeUndefined(); expect(result.messages).toEqual(f.messages);
  expect(f.state.reads).toBe(1); expect(f.state.confirmations).toBe(3);
  // A fresh adapter after restart derives the same proof, without local state.
  const restarted = adapterFixture();
  expect((await restarted.adapter.observeCommand("ses_fixture", "msg_command", "/fixture", policy)).settlement).toEqual(result.settlement);
});

for (const busy of ["active", "inbox"] as const) test(`automatic settlement waits for ${busy} to clear`, async () => {
  const f = adapterFixture();
  if (busy === "active") f.state.active = true;
  else f.state.inbox = [{ id: "msg_pending", type: "synthetic" }];
  expect((await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture")).observation.kind).toBe("foreign-boundary");
  f.state.active = false; f.state.inbox = [];
  expect((await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture")).observation.kind).toBe("exact-terminal");
});

for (const race of ["active", "inbox", "history"] as const) test(`settlement rechecks ${race} before releasing ownership`, async () => {
  const f = adapterFixture();
  f.state.mutate = () => {
    if (race === "active") f.state.active = true;
    else if (race === "inbox") f.state.inbox = [{ id: "msg_new" }];
    else f.session.time.updated++;
  };
  expect((await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture")).observation.kind).toBe("unavailable");
});

test("repeated internal retry, restart, instruction and compaction context require no notice allowlist", async () => {
  const f = adapterFixture();
  f.messages.splice(3, 0,
    { id: "msg_restart", type: "synthetic", time: { created: 5 }, metadata: { notice: "new-restart-format" } },
    { id: "msg_instructions", type: "synthetic", time: { created: 5 }, metadata: { futureContext: true } },
    { id: "msg_compact", type: "compaction", time: { created: 5, completed: 6 }, status: "completed" },
  );
  expect((await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture")).observation).toEqual({ kind: "exact-terminal", outcome: "succeeded" });
});

for (const laterInput of ["synthetic", "user"]) test(`reconnect after later ${laterInput} execution preserves original first terminal`, async () => {
  const f = adapterFixture();
  f.messages.at(-1)!.outcome = "failed";
  f.messages.push({ id: "msg_later", type: laterInput, time: { created: 10 } },
    { id: "msg_later_answer", type: "assistant", time: { created: 11, completed: 12 } },
    { id: "msg_later_idle", type: "idle", time: { created: 13 }, outcome: "succeeded" });
  f.session.time.idle = 13;
  const result = await f.adapter.observeCommand("ses_fixture", "msg_command", "/fixture");
  expect(result.observation).toEqual({ kind: "exact-terminal", outcome: "failed" });
  expect(result.settlement?.terminalMessageId).toBe("msg_idle");
  expect(result.messages.at(-1)?.id).toBe("msg_idle");
});
