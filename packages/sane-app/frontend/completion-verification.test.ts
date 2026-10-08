import { afterEach, expect, test } from "bun:test";
import { ChatStore, completionVerificationTarget, store, type State } from "./store";
import { conversationClient, ApiError } from "./cc-client";
import { chatStatuses } from "./chat-status";
import { createRun } from "../shared/conversation/cc-reducer";
import type { ConversationClient } from "./types";

const originalFetch = globalThis.fetch, originalState = store.state;
const runId = "00000000-0000-4000-8000-000000000001";
afterEach(() => { globalThis.fetch = originalFetch; store.state = originalState; });
function fixture(verifyCompletion: ConversationClient["verifyCompletion"] = async () => ({ status: "completed", evidence: {} })) {
  const local = new ChatStore({ ...conversationClient, verifyCompletion });
  local.reconnect = () => {};
  const run = createRun({ id: runId, conversationId: "A", cwd: "/fixture", harness: "opencode", nativeSessionId: "ses_A", nativeCommandId: "msg_A", status: "running", createdAt: "" });
  run.nativeCompletionBoundary = { messageId: "foreign", type: "synthetic" };
  local.state = { ...local.state, phase: "ready", selected: "A", connected: true, loading: false,
    conversations: [{ id: "A", harness: "opencode", nativeSessionId: "ses_A", cwd: "/fixture", lastRunId: runId, status: "running" }], runs: [run] };
  return local;
}

test("owned prompt boundary exposes captured verification identity", () => {
  const local = fixture(); store.state = local.state;
  expect(chatStatuses(local.state, { workspaceReady: true }).find(s => s.id === "run")).toMatchObject({
    action: "verify-completion", verificationTarget: { sessionId: "A", runId, nativeSessionId: "ses_A", nativeCommandId: "msg_A" },
  });
});
const exclusions: [string, (s: State) => void][] = [
  ["non-UUID run identity", s => { s.runs[0]!.id = "invalid"; s.conversations[0]!.lastRunId = "invalid"; }],
  ["worker conversation", s => { s.conversations[0]!.agentKind = "worker"; }],
  ["worker run", s => { s.runs[0]!.agentKind = "worker"; }],
  ["compaction", s => { s.runs[0]!.operation = "compact"; }],
  ["queued delivery", s => { s.runs[0]!.nativeDelivery = "queue"; }],
  ["foreign native session", s => { s.runs[0]!.nativeSessionId = "other"; }],
  ["missing command", s => { s.runs[0]!.nativeCommandId = undefined; }],
  ["missing boundary", s => { s.runs[0]!.nativeCompletionBoundary = null; }],
  ["completed", s => { s.runs[0]!.status = "completed"; }],
  ["old run", s => { s.conversations[0]!.lastRunId = "newer"; }],
  ["Claude", s => { s.conversations[0]!.harness = "claude-code"; }],
];
for (const [name, change] of exclusions) test(`verification excludes ${name}`, () => {
  const local = fixture(); change(local.state); expect(completionVerificationTarget(local.state)).toBeUndefined();
});

test("failure is visible; explicit retry preserves request ID, body and target; success reconnects", async () => {
  const calls: unknown[][] = []; let refreshes = 0;
  const local = fixture(async (...args) => { calls.push(args); if (calls.length === 1) throw new ApiError("Native execution is busy", 409); return { status: "failed", evidence: {} }; });
  local.reconnect = () => { refreshes++; };
  const target = completionVerificationTarget(local.state)!;
  await local.prepareCompletionVerification(target)!();
  expect(local.state.interactionError).toContain("Native execution is busy");
  await local.prepareCompletionVerification(target)!();
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject(["A", runId, { requestId: runId, confirm: true, nativeSessionId: "ses_A", nativeCommandId: "msg_A" }]);
  expect(local.state.actionBusy).toBe(false); expect(local.state.interactionError).toBe(""); expect(refreshes).toBe(1);
});

test("new stores retry identical recovery bodies after reload while another run has a distinct ID", async () => {
  const calls: Parameters<NonNullable<ConversationClient["verifyCompletion"]>>[] = [];
  const verify: NonNullable<ConversationClient["verifyCompletion"]> = async (...args) => {
    calls.push(args);
    throw new Error("Audit persisted but terminal persistence failed");
  };
  for (let reload = 0; reload < 2; reload++) {
    const local = fixture(verify);
    await local.prepareCompletionVerification(completionVerificationTarget(local.state)!)!();
  }
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]![2].requestId).toBe(runId);
  const nextRunId = "00000000-0000-4000-8000-000000000002";
  const other = fixture(verify);
  other.state.runs[0]!.id = nextRunId;
  other.state.conversations[0]!.lastRunId = nextRunId;
  await other.prepareCompletionVerification(completionVerificationTarget(other.state)!)!();
  expect(calls[2]![2].requestId).toBe(nextRunId);
  expect(calls[2]![2].requestId).not.toBe(calls[0]![2].requestId);
});

test("confirmation is fenced against selection round trips and replaced native commands", async () => {
  let calls = 0; const local = fixture(async () => { calls++; return { status: "completed" }; });
  const target = completionVerificationTarget(local.state)!;
  const confirm = local.prepareCompletionVerification(target)!;
  // Selection epoch is what fences an A -> B -> A navigation, even with the same IDs.
  (local as any).selectionEpoch++;
  await confirm(); expect(calls).toBe(0);
  const fresh = local.prepareCompletionVerification(target)!;
  local.state.runs[0]!.nativeCommandId = "replacement";
  await fresh(); expect(calls).toBe(0);
});

test("in-flight verification is single-shot and cannot update a new selection", async () => {
  const deferred = Promise.withResolvers<{ status: "completed" }>(); let calls = 0, refreshes = 0;
  const local = fixture(() => { calls++; return deferred.promise; }); local.reconnect = () => { refreshes++; };
  const confirm = local.prepareCompletionVerification(completionVerificationTarget(local.state)!)!;
  const pending = confirm(); await confirm(); expect(calls).toBe(1);
  (local as any).selectionEpoch++; local.state.selected = "B"; local.state.actionNotice = "New conversation";
  deferred.resolve({ status: "completed" }); await pending;
  expect(local.state.actionNotice).toBe("New conversation"); expect(refreshes).toBe(0);
});

test("client posts authenticated exact recovery identity and propagates native refusal", async () => {
  const input = { requestId: crypto.randomUUID(), nativeSessionId: "ses_A", nativeCommandId: "msg_A", confirm: true as const, reason: "User requested reconciliation" };
  globalThis.fetch = (async (url, init) => {
    expect(url).toBe("/api/sessions/A%2FB/runs/run%2F1/verify-completion");
    expect(init?.method).toBe("POST"); expect(init?.credentials).toBe("same-origin"); expect(JSON.parse(init!.body as string)).toEqual(input);
    return Response.json({ error: "Native execution is busy", code: "busy" }, { status: 409 });
  }) as typeof fetch;
  await expect(conversationClient.verifyCompletion!("A/B", "run/1", input)).rejects.toThrow("Native execution is busy");
});
