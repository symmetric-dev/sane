import { expect, test } from "bun:test";
import { summarizeAside } from "../shared/aside-contract";
import { sessionListProjection } from "./session-list-projection";
import { sessionListResponse, type SessionListResponseInput } from "./session-list-response";
import { capturedAt, ids, sessionFixture, sourceFixture } from "./aside-fixtures";

function input(): SessionListResponseInput {
  return {
    rows: [{ session: sessionFixture(), availability: { canSend: true },
      association: { association: "resolved", workspaceId: ids.workspace, worktreeId: ids.worktree } }],
    runs: [], events: new Map(), indexes: sessionListProjection([], [], [], []),
    native: { active: {}, error: "" }, availability: { canSend: true },
  };
}

test("conversation lists count every tracked aside lifecycle without exposing reference snapshots or drafts", () => {
  const summary = summarizeAside({ version: 1, id: ids.other, source: sourceFixture(), purpose: "discussion",
    lifecycle: "open", draft: "Private aside draft", revision: 1, createdAt: capturedAt, updatedAt: capturedAt });
  const request = input();
  request.asides = [summary, { ...summary, id: "archived", lifecycle: "archived", revision: 2 },
    { ...summary, id: "discarded", lifecycle: "discarded", revision: 2 },
    { ...summary, id: "another-source", sourceSessionId: ids.other }];
  const row = sessionListResponse(request, { followupPending: () => false }).sessions[0]!;
  expect(row.asideCount).toBe(3);
  expect(row.asideCounts).toEqual({ open: 1, archived: 1, discarded: 1, total: 3 });
  expect(row.availability.canSend).toBe(true);
  expect(JSON.stringify(row)).not.toContain("Private aside draft");
  expect(JSON.stringify(row)).not.toContain("Observed answer");
  expect(Object.hasOwn(row, "source")).toBe(false);
});

test("aside counts are optional for legacy callers and zero for sources without records", () => {
  const request = input();
  expect(Object.hasOwn(sessionListResponse(request, { followupPending: () => false }).sessions[0]!, "asideCount")).toBe(false);
  request.asides = [];
  expect(sessionListResponse(request, { followupPending: () => false }).sessions[0]!).toMatchObject({
    asideCount: 0, asideCounts: { open: 0, archived: 0, discarded: 0, total: 0 },
  });
});
