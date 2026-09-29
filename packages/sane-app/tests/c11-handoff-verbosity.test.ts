/**
 * C11 Phase 2 — handoff reply verbosity budgets (pure, no server boot).
 *
 * The native handoff enqueue/status replies are projected to the approved
 * agent-facing shapes; the full Handoff row stays server-side (reachable via
 * GET /api/handoffs?workspaceId= and the /api/handoffs/:id owner endpoints).
 * The client-side guard in native-handoff.ts enforces the same shapes even if
 * the server regresses.
 */
import { describe, test, expect } from "bun:test";
import type { Handoff } from "sane-core/contracts";
import { projectHandoffEnqueue, projectHandoffStatus } from "../src/handoff";
import { projectNativeHandoffReply } from "../../sane-cli/src/native-handoff";

function fullHandoff(message: string): Handoff {
  return {
    id: "h-123",
    repositoryId: "repo-1",
    sender: { harness: "oc", authorityId: "auth-1", nativeId: "ses_sender" },
    workstreamId: "ws-1",
    input: { requestId: "req-1", to: "engineering", message },
    recipient: {
      ownerId: "store-1",
      sessionId: "sess-recipient",
      ref: { harness: "oc", authorityId: "auth-1", nativeId: "ses_recipient" },
      harness: "oc",
      authorityId: "auth-1",
      checkout: { path: "/repo", commit: "abc123", dirty: false },
    },
    status: "queued",
    revision: 3,
    attemptId: "att-1",
    nativeCommandId: "msg_abc",
    runId: "run-1",
    evidence: "some evidence",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("C11 handoff reply verbosity", () => {
  test("enqueue projection carries only the approved keys (plus runId for delivery correlation)", () => {
    const projected = projectHandoffEnqueue(fullHandoff("do the thing"));
    expect(projected).toEqual({
      requestId: "req-1",
      id: "h-123",
      to: "engineering",
      status: "queued",
      recipientSessionId: "sess-recipient",
      runId: "run-1",
    });
    expect(JSON.stringify(projected)).not.toContain("do the thing");
  });

  test("enqueue reply has no input.message echo and stays ≤600B with a short message", () => {
    const body = JSON.stringify({ handoff: projectHandoffEnqueue(fullHandoff("short message")) });
    expect(body).not.toContain("short message");
    expect(body.length).toBeLessThanOrEqual(600);
  });

  test("enqueue projection does not echo a 32KB message", () => {
    const body = JSON.stringify({ handoff: projectHandoffEnqueue(fullHandoff("x".repeat(32 * 1024))) });
    expect(body.length).toBeLessThanOrEqual(600);
  });

  test("status projection carries only id/status/revision and stays ≤600B", () => {
    const projected = projectHandoffStatus(fullHandoff("short message"));
    expect(projected).toEqual({ id: "h-123", status: "queued", revision: 3 });
    const body = JSON.stringify({ handoff: projected });
    expect(body).not.toContain("short message");
    expect(body).not.toContain("sess-recipient");
    expect(body.length).toBeLessThanOrEqual(600);
  });

  test("client guard strips a regressed full-row enqueue reply to the approved shape", () => {
    const regressed = fullHandoff("secret payload") as unknown;
    expect(projectNativeHandoffReply(regressed, false)).toEqual({
      requestId: "req-1",
      id: "h-123",
      to: "engineering",
      status: "queued",
      recipientSessionId: "sess-recipient",
      runId: "run-1",
    });
    const body = JSON.stringify({ handoff: projectNativeHandoffReply(regressed, false) });
    expect(body).not.toContain("secret payload");
    expect(body.length).toBeLessThanOrEqual(600);
  });

  test("client guard strips a regressed full-row status reply; null passes through", () => {
    const regressed = fullHandoff("secret payload") as unknown;
    expect(projectNativeHandoffReply(regressed, true)).toEqual({ id: "h-123", status: "queued", revision: 3 });
    expect(projectNativeHandoffReply(null, true)).toBeNull();
    expect(projectNativeHandoffReply(undefined, false)).toBeUndefined();
  });
});
