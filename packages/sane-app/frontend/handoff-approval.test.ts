import { expect, test } from "bun:test";
import { capabilitiesFor, getHarnessDescriptor } from "../shared/conversation/harness-capabilities";
import { pendingHandoffApprovals, pendingInteractions } from "./interaction-presentation";
import { ChatStore, type State } from "./store";
import type { Conversation, Interaction } from "./types";

const sender = (): Conversation => ({ id: "sender-A", harness: "claude-code", nativeSessionId: "native-A", cwd: "/fixture", lastRunId: null, status: "completed" } as Conversation);
const approval = (revision = 4): Interaction => ({ id: "approval-1", type: "handoff-approval", title: "Handoff to Engineering", description: "Deploy report?", handoffId: "handoff-1", requestId: "request-1", revision });
const baseState = (overrides: Partial<State> = {}): State => ({
  phase: "ready", conversations: [sender()], conversationsReady: true, selected: "sender-A", runs: [], messages: [], drafts: {},
  connected: true, loading: false, sending: false, availability: { canSend: true }, connectionError: "", submissionError: "", authError: "",
  models: [], modelsLoading: false, modelsError: "", modelsLoaded: false, modelsCwd: "", interactions: [], handoffApprovals: [approval()],
  interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false, ...overrides,
} as State);

test("handoff capabilities are supported on both harnesses (sender-session, App-owned)", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    const descriptor = getHarnessDescriptor(harness)!;
    expect(descriptor.operations.listHandoffApprovals.supported).toBe(true);
    expect(descriptor.operations.handoffReply.supported).toBe(true);
    const caps = capabilitiesFor(harness, undefined);
    expect(caps.listHandoffApprovals).toBe(true);
    expect(caps.handoffReplies).toBe(true);
  }
  // Explicit false still narrows; omitted stays on static default.
  expect(capabilitiesFor("opencode", { handoffReplies: false }).handoffReplies).toBe(false);
  expect(capabilitiesFor("opencode", {}).handoffReplies).toBe(true);
});

test("pendingInteractions includes sender handoff approvals and dedupes inbox duplicates", () => {
  const caps = { listInteractions: true, permissionReplies: true, questionReplies: true, listHandoffApprovals: true, handoffReplies: true } as const;
  expect(pendingInteractions(baseState(), caps).map(i => i.id)).toEqual(["approval-1"]);
  expect(pendingHandoffApprovals(baseState(), caps).map(i => i.id)).toEqual(["approval-1"]);
  // Capability loss hides the approval without deleting it.
  expect(pendingInteractions(baseState(), { ...caps, handoffReplies: false })).toEqual([]);
  expect(pendingInteractions(baseState(), { ...caps, listHandoffApprovals: false })).toEqual([]);
  // Replaced conversations never take over the composer.
  expect(pendingInteractions(baseState({ conversations: [{ ...sender(), replacedBy: "B" } as Conversation] }), caps)).toEqual([]);
  // Same approval arriving via both polls dedupes to one composer card.
  const dup = baseState({ interactions: [approval()], handoffApprovals: [approval()] });
  expect(pendingInteractions(dup, caps).length).toBe(1);
});

test("store.replyHandoff attaches to the sender sessionId and clears the approval", async () => {
  const calls: string[] = [];
  const client: any = {
    config: async () => ({ authenticated: true, authRequired: false }),
    login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [sender()], availability: { canSend: true } }),
    runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }),
    models: async () => [], interactions: async () => [], reply: async () => {},
    handoffApprovals: async (id: string) => { calls.push(`list:${id}`); return [approval()]; },
    replyHandoff: async (id: string, approvalId: string, reply: unknown) => { calls.push(`reply:${id}:${approvalId}:${JSON.stringify(reply)}`); },
    cancel: async () => ({ interrupted: false }), submit: async () => ({ conversationId: "sender-A", runId: "R" }),
  };
  const chat = new ChatStore(client);
  (chat as any).state = { ...baseState(), config: { authenticated: true, authRequired: false } };
  chat.executionUnavailable = () => "";
  (chat as any).reconnect = () => {};
  try {
    // Poll helper path uses the sender sessionId.
    const listed = await client.handoffApprovals("sender-A");
    expect(listed[0].handoffId).toBe("handoff-1");
    expect(listed[0].revision).toBe(4);
    expect(calls).toEqual(["list:sender-A"]);
    await chat.replyHandoff("approval-1", { decision: "deny", message: "Not yet", expectedRevision: 4 });
    expect(chat.snapshot().handoffApprovals).toEqual([]);
    expect(calls[1]).toBe(`reply:sender-A:approval-1:{"decision":"deny","message":"Not yet","expectedRevision":4}`);
    // Allow without a message also attaches to the sender.
    (chat as any).state = { ...baseState(), config: { authenticated: true, authRequired: false } };
    await chat.replyHandoff("approval-1", { decision: "allow", expectedRevision: 4 });
    expect(calls[2]).toBe(`reply:sender-A:approval-1:{"decision":"allow","expectedRevision":4}`);
    // Stale/missing revision never sends; the approval stays pending.
    (chat as any).state = { ...baseState(), config: { authenticated: true, authRequired: false } };
    const before = calls.length;
    await chat.replyHandoff("approval-1", { decision: "allow", expectedRevision: -1 } as any);
    expect(calls.length).toBe(before);
    expect(chat.snapshot().handoffApprovals.length).toBe(1);
  } finally {
    (chat as any).stop?.();
  }
});
