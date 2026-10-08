import { afterEach, expect, test } from "bun:test";
import { chatStatuses } from "./chat-status";
import { store, type State } from "./store";
import { createRun } from "../shared/conversation/cc-reducer";

const prior = store.state;
afterEach(() => { store.state = prior; });
function fixture(): State {
  const run = createRun({ id: "run", conversationId: "A", cwd: "/fixture", harness: "opencode", status: "running", createdAt: "" });
  return { ...prior, selected: "A", connected: true, loading: false, connectionError: "", availability: { canSend: true },
    conversations: [{ id: "A", harness: "opencode", cwd: "/fixture", lastRunId: run.id, status: "running" }], runs: [run],
    messages: [{ id: "msg_retry", runId: run.id, role: "assistant", normalized: true, status: "running", time: "", parts: [],
      retry: { attempt: 3, at: 500, error: { message: "overloaded" } } }], compactions: [], pendingCompacts: {}, interactions: [] };
}
function statuses(state: State) {
  store.state = state;
  return chatStatuses(state, { workspaceReady: true });
}

test("latest normalized retry in its active run shows attempt and busy recovery status", () => {
  expect(statuses(fixture()).find(s => s.id === "run")).toMatchObject({ text: "Retrying model connection", busy: true,
    detail: "Native retry attempt 3. Waiting for the model connection to recover." });
});

test("active native continuation can show imported retry without an app run", () => {
  const state = fixture(); state.runs = []; state.messages[0]!.runId = "native-import";
  state.conversations[0]!.status = "completed"; state.conversations[0]!.nativeActivity = "active";
  expect(statuses(state).find(s => s.id === "run")).toMatchObject({ text: "Retrying model connection", busy: true });
});

const exclusions: [string, (state: State) => void][] = [
  ["terminal failure", s => { s.messages[0]!.status = "failed"; }],
  ["terminal success", s => { s.messages[0]!.status = "completed"; }],
  ["unnormalized assistant", s => { s.messages[0]!.normalized = false; }],
  ["user message", s => { s.messages[0]!.role = "user"; }],
  ["system message", s => { s.messages[0]!.role = "system"; }],
  ["missing retry", s => { s.messages[0]!.retry = undefined; }],
  ["older assistant before newer assistant", s => { s.messages.push({ ...s.messages[0]!, id: "msg_new", retry: undefined }); }],
  ["older assistant before user", s => { s.messages.push({ ...s.messages[0]!, id: "msg_new", role: "user", retry: undefined }); }],
  ["different run", s => { s.messages[0]!.runId = "old-run"; }],
  ["inactive execution despite running message", s => { s.runs[0]!.status = "completed"; s.conversations[0]!.status = "completed"; }],
  ["conversation status alone", s => { s.runs = []; }],
  ["idle native observation", s => { s.runs = []; s.messages[0]!.runId = "native-import"; s.conversations[0]!.status = "completed"; s.conversations[0]!.nativeActivity = "idle"; }],
  ["disconnected bridge", s => { s.connected = false; }],
  ["connection error", s => { s.connectionError = "offline"; }],
  ["native connection unavailable", s => { s.runs[0]!.nativeConnection = "unavailable"; }],
  ["foreign completion boundary", s => { s.runs[0]!.nativeCompletionBoundary = { messageId: "msg_foreign", type: "user" }; }],
];
for (const [name, change] of exclusions) test(`retry metadata does not show live recovery for ${name}`, () => {
  const state = fixture(); change(state);
  expect(statuses(state).some(s => s.text === "Retrying model connection")).toBe(false);
});

test("native uncertainty and completion verification retain their own status over retry metadata", () => {
  const state = fixture(); state.runs[0]!.nativeConnection = "unavailable";
  expect(statuses(state).find(s => s.id === "run")?.text).toBe("Assistant connection unavailable");
  state.runs[0]!.nativeConnection = "connected";
  state.runs[0]!.nativeCompletionBoundary = { messageId: "msg_foreign", type: "synthetic" };
  expect(statuses(state).find(s => s.id === "run")?.text).toBe("Run completion needs verification");
});
