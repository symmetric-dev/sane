import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ASIDE_LIMITS, parseAsideSourceSnapshot } from "../shared/aside-contract";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";
import type { Session } from "./history";
import { canonicalJSON } from "./prepared-input-codec";
import { TranscriptService } from "./transcript-service";

const session: Session = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  harness: "claude-code", nativeSessionId: "22222222-2222-4222-8222-222222222222",
  authorityId: `sane-native-v1:cc:${"a".repeat(64)}`,
  cwd: "/repository", lastStatus: "unknown", lastRunId: null,
};
const at = "2026-10-31T12:00:00.000Z";

function history(): ReconciledHistory {
  return {
    sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!,
    importedAt: at, activity: "idle", reason: "Recorded reference", coveredRunIds: [],
    messages: [
      { messageId: "original-user", role: "user", createdAt: "", status: "completed", parts: [{ id: "question", type: "text", text: "Explain this concept" }] },
      { messageId: "original-assistant", role: "assistant", createdAt: "", status: "running", parts: [{ id: "tool-observation", type: "tool", name: "read", status: "running" }] },
    ],
  };
}

describe("aside App-transcript references", () => {
  test("captures the complete observation, including unavailable times and not-yet-observed tool input", async () => {
    const original = history();
    const transcripts = new TranscriptService(() => [session], () => [], { get: async () => original });
    const snapshot = await transcripts.captureAsideReference(session);
    expect(snapshot.kind).toBe("app-transcript");
    expect(snapshot.totalMessages).toBe(2);
    expect(snapshot.messages.map(message => message.id)).toEqual(["original-user", "original-assistant"]);
    expect(snapshot.messages.every(message => message.time === "")).toBe(true);
    expect(snapshot.messages[1]!.status).toBe("running");
    expect(Object.hasOwn(snapshot.messages[1]!.parts[0]!, "input")).toBe(false);
    expect(snapshot.boundaryMessageId).toBe("original-assistant");
    expect(snapshot.fingerprint).toBe(createHash("sha256").update(canonicalJSON(snapshot.messages)).digest("hex"));
    // The reference contract accepts native observations without manufacturing
    // a timestamp, a tool input, or successful complete-turn evidence.
    expect(parseAsideSourceSnapshot({
      storeId: "33333333-3333-4333-8333-333333333333",
      sessionId: session.sessionId, rootSessionId: session.sessionId,
      native: { harness: "cc", authorityId: session.authorityId, nativeId: session.nativeSessionId },
      binding: { workspaceId: "44444444-4444-4444-8444-444444444444", worktreeId: "55555555-5555-4555-8555-555555555555", bindingRevision: "revision", cwd: session.cwd },
      capturedAt: at, transcript: snapshot,
    }).transcript).toEqual(snapshot);
  });

  test("returns detached content and keeps the old capture unchanged when the main history advances", async () => {
    let observed = history();
    const transcripts = new TranscriptService(() => [session], () => [], { get: async () => observed });
    const first = await transcripts.captureAsideReference(session);
    const retained = structuredClone(first);
    const part = first.messages[0]!.parts[0]!;
    if (part.type === "text") part.text = "Local mutation";
    expect((await transcripts.captureAsideReference(session)).messages[0]!.parts[0]).toEqual({ type: "text", text: "Explain this concept" });
    observed = { ...observed, messages: [...observed.messages,
      { messageId: "later-main-message", role: "user", createdAt: at, status: "completed", parts: [{ id: "later-text", type: "text", text: "Continue main work" }] },
    ] };
    const later = await transcripts.captureAsideReference(session);
    expect(later.totalMessages).toBe(3);
    expect(later.fingerprint).not.toBe(retained.fingerprint);
    expect(retained.totalMessages).toBe(2);
    expect(retained.boundaryMessageId).toBe("original-assistant");
    expect(retained.messages.some(message => message.id === "later-main-message")).toBe(false);
  });

  test("rejects oversized history rather than returning a silently truncated reference", async () => {
    const original = history();
    original.messages[0]!.parts = [{ id: "large", type: "text", text: "x".repeat(ASIDE_LIMITS.snapshotBytes) }];
    const transcripts = new TranscriptService(() => [session], () => [], { get: async () => original });
    await expect(transcripts.captureAsideReference(session)).rejects.toMatchObject({ status: 413, code: "aside-snapshot-too-large" });
    expect(original.messages).toHaveLength(2);
    expect(original.messages[0]!.parts[0]).toMatchObject({ text: "x".repeat(ASIDE_LIMITS.snapshotBytes) });
  });
});
