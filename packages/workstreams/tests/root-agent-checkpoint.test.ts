import { describe, expect, test } from "bun:test"
import type { ExportedMessage, SessionExport } from "../src/lib/session-export.ts"
import {
  createRootAgentCheckpointPointer,
  findLatestRootAgentCheckpointBoundary,
  formatRootAgentCheckpointPointer,
  loadRootAgentCheckpointPointer,
  refreshRootAgentCheckpointPointer,
  validateRootAgentCheckpointPointer,
} from "../src/lib/root-agent-checkpoint.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers/test-workspace.ts"

function createSessionExport(messages: ExportedMessage[]): SessionExport {
  return {
    info: {
      id: "root-session-1",
      title: "Root session",
      summary: { additions: 0, deletions: 0, files: 0 },
    },
    messages,
  }
}

function createMessage(args: {
  id?: string
  role: "user" | "assistant"
  text: string
  completedAt?: number
}): ExportedMessage {
  return {
    info: {
      id: args.id ?? "",
      role: args.role,
      ...(typeof args.completedAt === "number"
        ? { time: { created: args.completedAt - 1, completed: args.completedAt } }
        : {}),
    },
    parts: [{ type: "text", text: args.text }],
  }
}

describe("root-agent-checkpoint", () => {
  test("findLatestRootAgentCheckpointBoundary prefers the latest transcript-safe boundary", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-assistant-1", role: "assistant", text: "Earlier", completedAt: 10 }),
      createMessage({ id: "msg-user-1", role: "user", text: "Launch the branch" }),
      createMessage({ id: "msg-assistant-draft", role: "assistant", text: "Draft response" }),
    ])

    expect(findLatestRootAgentCheckpointBoundary(sessionExport)).toMatchObject({
      checkpointMessageIndex: 1,
      message: {
        info: { id: "msg-user-1", role: "user" },
      },
    })
  })

  test("createRootAgentCheckpointPointer stores message id and index when both are available", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      sessionExport: createSessionExport([
        createMessage({ id: "msg-assistant-1", role: "assistant", text: "Done", completedAt: 10 }),
      ]),
    })

    expect(pointer).toEqual({
      rootSessionId: "root-session-1",
      checkpointMessageId: "msg-assistant-1",
      checkpointMessageIndex: 0,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
    })
    expect(formatRootAgentCheckpointPointer(pointer)).toBe("message msg-assistant-1")
  })

  test("createRootAgentCheckpointPointer falls back to message index when ids are unavailable", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      sessionExport: createSessionExport([
        createMessage({ role: "assistant", text: "Done", completedAt: 10 }),
      ]),
    })

    expect(pointer).toEqual({
      rootSessionId: "root-session-1",
      checkpointMessageIndex: 0,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
    })
    expect(formatRootAgentCheckpointPointer(pointer)).toBe("message-index 0")
  })

  test("validateRootAgentCheckpointPointer prefers checkpointMessageId over a stale index", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-0", role: "assistant", text: "Earlier", completedAt: 10 }),
      createMessage({ id: "msg-1", role: "assistant", text: "Middle", completedAt: 20 }),
      createMessage({ id: "msg-2", role: "assistant", text: "Latest", completedAt: 30 }),
    ])

    expect(
      validateRootAgentCheckpointPointer({
        pointer: {
          rootSessionId: "root-session-1",
          checkpointMessageId: "msg-2",
          checkpointMessageIndex: 0,
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        },
        sessionExport,
      }),
    ).toEqual({
      valid: true,
      resolvedMessageId: "msg-2",
      resolvedMessageIndex: 2,
    })
  })

  test("refreshRootAgentCheckpointPointer updates persisted checkpoint metadata", async () => {
    const workspace = createTestWorkstream("001-root-agent-checkpoint-refresh")

    try {
      const refreshed = await refreshRootAgentCheckpointPointer({
        repoRoot: workspace.repoRoot,
        streamId: workspace.streamId,
        rootSessionId: "root-session-1",
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        sessionExport: createSessionExport([
          createMessage({ id: "msg-old", role: "assistant", text: "Earlier", completedAt: 10 }),
          createMessage({ id: "msg-new", role: "user", text: "Launch the branch" }),
        ]),
      })

      expect(refreshed).toEqual({
        rootSessionId: "root-session-1",
        checkpointMessageId: "msg-new",
        checkpointMessageIndex: 1,
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      })

      expect(
        loadRootAgentCheckpointPointer({
          repoRoot: workspace.repoRoot,
          streamId: workspace.streamId,
          rootSessionId: "root-session-1",
        }),
      ).toEqual(refreshed)
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
