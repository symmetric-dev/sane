import { expect, test } from "bun:test";
import { ChatStore } from "./store";
import { ApiError } from "./cc-client";
import type { ConversationClient, RunMetadata } from "./types";
import type { ReconciledHistory } from "../src/reconcile";

const history = (marker = "native"): ReconciledHistory => ({ sessionId: "A", nativeSessionId: "ses_A", importedAt: "2026-09-27T00:00:00Z", activity: "idle", reason: marker, coveredRunIds: ["accepted", "rejected"], messages: [{ messageId: "msg_accepted", role: "user", parts: [{ id: "text", type: "text", text: marker }], status: "completed", createdAt: "2026-09-27T00:00:00Z" }] });
function fixture(overrides: Partial<ConversationClient> = {}) {
  const client: ConversationClient = {
    config: async () => ({ authenticated: true, authRequired: false }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [{ id: "A", nativeSessionId: "ses_A", harness: "opencode", cwd: "/fixture", lastRunId: "accepted", status: "completed" }], availability: { canSend: true } }),
    runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }), models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => ({ interrupted: true }),
    reconcile: async () => ({ history: history() }), nativeHistory: async () => ({ history: history() }), submit: async () => ({ conversationId: "A", runId: "next" }), ...overrides,
  };
  const store = new ChatStore(client);
  store.state = { ...store.state, selected: "A", connected: true, availability: { canSend: true } };
  store.capabilities = () => ({ cancelRun: true });
  store.reconnect = () => {};
  return { store, client, poll: () => (store as any).poll() as Promise<void>, close: () => (store as any).stop() };
}

test("attached Claude requires an explicit per-submission acknowledgement, not transcript-idle inference", async () => {
  const submitted: any[] = [];
  const f = fixture({ submit: async input => { submitted.push(input); throw new Error("fixture response unavailable"); } });
  f.store.state.conversations = [{ id: "A", nativeSessionId: "A", harness: "claude-code", cwd: "/fixture", lastRunId: null, status: "unknown", attachment: { state: "ready" } }];
  f.store.executionUnavailable = () => ""; f.store.modelUnavailable = () => false;
  try {
    await f.store.send("new text"); expect(submitted).toEqual([]); expect(f.store.state.submissionError).toContain("Confirm external Claude");
    await f.store.send("new text", true); expect(submitted).toHaveLength(1); expect(submitted[0]).toMatchObject({ conversationId: "A", nativeStopped: true, text: "new text" });
    f.store.state.connected = true; f.store.state.availability = { canSend: true };
    await f.store.send("new text"); expect(submitted).toHaveLength(1);
  } finally { f.close(); }
});

for (const action of ["reply", "cancel", "reconcile"] as const) for (const staleFails of [false, true]) for (const oldFirst of [false, true]) {
  test(`${action}: A→B→A ignores stale ${staleFails ? "failure" : "success"}, old settles ${oldFirst ? "first" : "last"}`, async () => {
    const old = Promise.withResolvers<any>(), fresh = Promise.withResolvers<any>(); let calls = 0;
    const f = fixture({ [action]: () => (++calls === 1 ? old.promise : fresh.promise) });
    if (action === "reply" && (staleFails || oldFirst)) {
      f.store.state.conversations = ["A", "B"].map(id => ({ id, nativeSessionId: `ses_${id}`, harness: "opencode", cwd: "/fixture", lastRunId: null, status: "completed" }));
    }
    const run = () => action === "reply" ? f.store.reply("permission", { type: "permission", decision: "once" }) : f.store[action]();
    const result = (marker: string) => action === "reconcile" ? { history: history(marker) } : { interrupted: true };
    try {
      const previous = run(); f.store.choose("B"); f.store.choose("A");
      f.store.state.interactions = [{ id: "permission", type: "permission", title: "New pending permission" }];
      const current = run();
      const settleOld = async () => { if (staleFails) old.reject(new ApiError("stale denied", 401)); else old.resolve(result("stale")); await previous; };
      if (oldFirst) {
        await settleOld();
        expect(f.store.state.actionBusy).toBe(true);
        expect(f.store.state.actionNotice).toBe("");
        expect(f.store.state.interactionError).toBe("");
        expect(f.store.state.nativeHistory).toBeNull();
        expect(f.store.state.interactions).toHaveLength(1);
      }
      fresh.resolve(result("fresh")); await current;
      const notice = f.store.state.actionNotice;
      if (!oldFirst) await settleOld();
      expect(f.store.state.phase).not.toBe("login");
      expect(f.store.state.actionBusy).toBe(false);
      expect(f.store.state.actionNotice).toBe(notice);
      expect(f.store.state.interactionError).toBe("");
      if (action === "reconcile") expect(f.store.state.nativeHistory?.reason).toBe("fresh");
    } finally { f.close(); }
  });
}

for (const failing of ["runs", "events"] as const) test(`native snapshot reloads after transient ${failing} failure`, async () => {
  let reads = 0, fail = true;
  const meta: RunMetadata = { id: "accepted", conversationId: "A", nativeCommandId: "msg_accepted", cwd: "/fixture", status: "completed", createdAt: "2026-09-27T00:00:00Z" };
  const f = fixture({ nativeHistory: async () => { reads++; return { history: history() }; },
    runs: async () => { if (fail && failing === "runs") throw new Error("transient runs failure"); return [meta]; },
    events: async () => { if (fail && failing === "events") throw new Error("transient events failure"); return { events: [], nextCursor: 0, status: "completed" }; },
  });
  f.store.state.phase = "ready";
  try {
    await f.poll(); expect(f.store.state.connected).toBe(false); expect(f.store.state.nativeHistory).toBeUndefined();
    f.close(); fail = false; await f.poll();
    expect(reads).toBe(2); expect(f.store.state.nativeHistory?.reason).toBe("native");
    expect(f.store.state.messages.map(m => m.id)).toEqual(["msg_accepted"]);
  } finally { f.close(); }
});

test("legacy overbroad coverage cannot hide a rejected App submission absent from native history", async () => {
  const f = fixture({ runs: async () => ["accepted", "rejected"].map(id => ({ id, conversationId: "A", nativeCommandId: `msg_${id}`, cwd: "/fixture", status: id === "rejected" ? "failed" : "completed", createdAt: "2026-09-27T00:00:00Z" })),
    events: async run => ({ events: [{ seq: 1, time: run.createdAt, runId: run.id, sessionId: "A", kind: "submission", data: { messageId: `msg_${run.id}`, text: run.id } }], nextCursor: 1, status: run.status }),
  });
  f.store.state.phase = "ready";
  try {
    await f.poll();
    expect(f.store.state.messages.some(m => m.id === "msg_rejected" && m.parts.some(p => p.type === "text" && p.text === "rejected"))).toBe(true);
    expect(f.store.state.messages.some(m => m.runId === "rejected" && m.status === "failed")).toBe(true);
    expect(f.store.state.messages.filter(m => m.id === "msg_accepted")).toHaveLength(1);
  } finally { f.close(); }
});

test("successful reconcile invalidates an older snapshot read even when reconnect is deferred", async () => {
  const old = Promise.withResolvers<{ history: ReconciledHistory }>();
  const entered = Promise.withResolvers<void>();
  const f = fixture({ nativeHistory: async () => { entered.resolve(); return old.promise; }, reconcile: async () => ({ history: history("new import") }) });
  f.store.state.phase = "ready";
  try {
    const poll = f.poll(); await entered.promise;
    await f.store.reconcile();
    old.resolve({ history: history("obsolete read") }); await poll;
    expect(f.store.state.nativeHistory?.reason).toBe("new import");
    expect(f.store.state.actionBusy).toBe(false);
  } finally { f.close(); }
});

test("draft edited during an accepted submission survives; ambiguous rejection preserves draft without retry", async () => {
  const pending = Promise.withResolvers<{ conversationId: string; runId: string }>(); let calls = 0;
  const f = fixture({ submit: async () => { calls++; return pending.promise; } });
  f.store.executionUnavailable = () => ""; f.store.modelUnavailable = () => false;
  try {
    const sending = f.store.send("original  prompt");
    f.store.setDraft({ text: "editing first line 日本\nnew draft  " });
    pending.resolve({ conversationId: "A", runId: "next" }); await sending;
    expect(f.store.draft().text).toBe("editing first line 日本\nnew draft  ");
    f.client.submit = async () => { calls++; throw new Error("acknowledgement lost"); };
    f.store.state.connected = true; f.store.state.availability = { canSend: true };
    await f.store.send(f.store.draft().text);
    expect(f.store.draft().text).toBe("editing first line 日本\nnew draft  ");
    expect(f.store.state.submissionError).toContain("Acceptance is unknown"); expect(calls).toBe(2);
  } finally { f.close(); }
});
