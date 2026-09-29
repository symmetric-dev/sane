import { expect, test } from "bun:test";
import { defaultFilterFor, filterConversations, type ConversationFilterState } from "./conversation-filter";
import type { Conversation } from "./types";

const base: ConversationFilterState = {
  query: "",
  workspaceId: "all",
  worktreeId: "all",
  harness: "all",
  status: "all",
  workstreamId: "all",
  phase: "all",
};

function convo(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    harness: "opencode",
    cwd: "/repo",
    lastRunId: null,
    status: "completed",
    ...overrides,
  } as Conversation;
}

const conversations: Conversation[] = [
  convo({ id: "aaa", title: "Fix login bug", cwd: "/repo/app", harness: "opencode", status: "completed", workspaceId: "ws1", worktreeId: "wt1" }),
  convo({ id: "bbb", title: "Plan release", cwd: "/repo/other", harness: "claude-code", status: "running", workspaceId: "ws1", worktreeId: "wt2" }),
  convo({ id: "ccc", title: "Unrelated", cwd: "/elsewhere", harness: "opencode", status: "failed", workspaceId: "ws2", worktreeId: "wt3" }),
];

test("query matches title, cwd, id, and harness substring", () => {
  expect(filterConversations(conversations, { ...base, query: "login" }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, query: "bbb" }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, query: "/elsewhere" }).map(c => c.id)).toEqual(["ccc"]);
  expect(filterConversations(conversations, { ...base, query: "claude" }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, query: "LOGIN" }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, query: "" })).toHaveLength(3);
});

test("harness and status filters narrow results", () => {
  expect(filterConversations(conversations, { ...base, harness: "claude-code" }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, harness: "opencode" }).map(c => c.id)).toEqual(["aaa", "ccc"]);
  expect(filterConversations(conversations, { ...base, status: "running" }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, harness: "opencode", status: "failed" }).map(c => c.id)).toEqual(["ccc"]);
});

test("workspace and worktree scope filters", () => {
  expect(filterConversations(conversations, { ...base, workspaceId: "ws1", worktreeId: "all" }).map(c => c.id)).toEqual(["aaa", "bbb"]);
  expect(filterConversations(conversations, { ...base, workspaceId: "ws1", worktreeId: "wt2" }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, workspaceId: "unavailable" })).toHaveLength(0);
  const orphan = convo({ id: "ddd", workspaceId: null as any, worktreeId: null as any });
  expect(filterConversations([...conversations, orphan], { ...base, workspaceId: "unavailable" }).map(c => c.id)).toEqual(["ddd"]);
});

test("workstream join filters by membership and phase", () => {
  const workstreamMap = new Map([
    ["aaa", { workstreamId: "w1", phases: ["design"] }],
    ["bbb", { workstreamId: null, phases: [] }],
  ]);
  expect(filterConversations(conversations, { ...base, workstreamId: "w1" }, { workstreamMap }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, workstreamId: "workstream:w1" }, { workstreamMap }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, workstreamId: "unassigned" }, { workstreamMap }).map(c => c.id)).toEqual(["bbb"]);
  expect(filterConversations(conversations, { ...base, workstreamId: "unknown" }, { workstreamMap }).map(c => c.id)).toEqual(["ccc"]);
  expect(filterConversations(conversations, { ...base, phase: "design" }, { workstreamMap }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, workstreamId: "w1", phase: "design" }, { workstreamMap }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, workstreamId: "w1", phase: "engineering" }, { workstreamMap })).toHaveLength(0);
});

test("defaultFilterFor returns current workspace+worktree scope", () => {
  expect(defaultFilterFor("ws1", "wt1")).toMatchObject({ workspaceId: "ws1", worktreeId: "wt1", query: "", harness: "all", status: "all", workstreamId: "all", phase: "all" });
  expect(defaultFilterFor("ws1", null)).toMatchObject({ workspaceId: "ws1", worktreeId: "all" });
  expect(defaultFilterFor(null, null)).toMatchObject({ workspaceId: "all", worktreeId: "all" });
});

test("hidden conversations respect showDeleted toggle", () => {
  const hidden = convo({ id: "hid", hidden: true, workspaceId: "ws1", worktreeId: "wt1" });
  expect(filterConversations([...conversations, hidden], base).map(c => c.id)).not.toContain("hid");
  expect(filterConversations([...conversations, hidden], { ...base, showDeleted: true }).map(c => c.id)).toContain("hid");
});

test("fuzzy query tolerates typos via Fuse", () => {
  expect(filterConversations(conversations, { ...base, query: "logn" }).map(c => c.id)).toEqual(["aaa"]);
  expect(filterConversations(conversations, { ...base, query: "Plan releas" }).map(c => c.id)).toEqual(["bbb"]);
});
