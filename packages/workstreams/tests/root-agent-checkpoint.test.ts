import { describe, expect, test } from "bun:test"
import type { ExportedMessage, SessionExport } from "../src/lib/session-export.ts"
import {
  createRootAgentCheckpointPointer,
  DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS,
  findLatestRootAgentCheckpointBoundary,
  formatRootAgentBreakpointSelection,
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
  test("findLatestRootAgentCheckpointBoundary prefers the latest tagged user breakpoint before launch", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-tagged", role: "user", text: `Pause here\n${DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0]}` }),
      createMessage({ id: "msg-user-2", role: "user", text: "Launch the branch from the most recent request" }),
      createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
    ])

    expect(findLatestRootAgentCheckpointBoundary(sessionExport)).toMatchObject({
      checkpointMessageIndex: 0,
      message: {
        info: { id: "msg-tagged", role: "user" },
      },
      breakpointSelection: {
        strategy: "explicit_tag",
        matchedTag: DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0],
        launchMessageId: "msg-launch",
      },
    })
  })

  test("findLatestRootAgentCheckpointBoundary supports custom breakpoint tags", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-custom", role: "user", text: "Use CUSTOM_BREAKPOINT here" }),
      createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
    ])

    expect(
      findLatestRootAgentCheckpointBoundary(sessionExport, {
        breakpointTags: ["CUSTOM_BREAKPOINT"],
      }),
    ).toMatchObject({
      checkpointMessageIndex: 0,
      message: {
        info: { id: "msg-custom", role: "user" },
      },
      breakpointSelection: {
        strategy: "explicit_tag",
        matchedTag: "CUSTOM_BREAKPOINT",
      },
    })
  })

  test("findLatestRootAgentCheckpointBoundary supports explicit previous_user mode", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-tagged", role: "user", text: `Pause here\n${DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0]}` }),
      createMessage({ id: "msg-latest-user", role: "user", text: "Use the latest user request instead" }),
      createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
    ])

    expect(
      findLatestRootAgentCheckpointBoundary(sessionExport, {
        breakpointMode: "previous_user",
      }),
    ).toMatchObject({
      checkpointMessageIndex: 1,
      message: {
        info: { id: "msg-latest-user", role: "user" },
      },
      breakpointSelection: {
        strategy: "previous_user_before_launch",
        launchMessageId: "msg-launch",
        rationale:
          "Selected the previous user message before launch message msg-launch because breakpoint mode was set to previous_user.",
      },
    })
  })

  test("createRootAgentCheckpointPointer supports explicit prefer_tagged mode", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointMode: "prefer_tagged",
      sessionExport: createSessionExport([
        createMessage({ id: "msg-tagged", role: "user", text: `Pause here\n${DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0]}` }),
        createMessage({ id: "msg-latest-user", role: "user", text: "Launch the branch from the most recent request" }),
        createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
      ]),
    })

    expect(pointer.checkpointMessageId).toBe("msg-tagged")
    expect(pointer.breakpointSelection).toMatchObject({
      strategy: "explicit_tag",
      matchedTag: DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0],
    })
  })

  test("createRootAgentCheckpointPointer stores user-message id and selection rationale", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      sessionExport: createSessionExport([
        createMessage({ id: "msg-user-1", role: "user", text: "Launch the branch" }),
        createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
      ]),
    })

    expect(pointer).toEqual({
      rootSessionId: "root-session-1",
      checkpointMessageId: "msg-user-1",
      checkpointMessageIndex: 0,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointSelection: {
        strategy: "previous_user_before_launch",
        configuredTags: [...DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS],
        launchMessageId: "msg-launch",
        launchMessageIndex: 1,
        rationale:
          "Selected the previous user message before launch message msg-launch because no configured breakpoint tag was found.",
      },
    })
    expect(formatRootAgentCheckpointPointer(pointer)).toBe("message msg-user-1")
    expect(formatRootAgentBreakpointSelection(pointer.breakpointSelection!)).toBe(
      "Selected the previous user message before launch message msg-launch because no configured breakpoint tag was found.",
    )
  })

  test("createRootAgentCheckpointPointer falls back to message index when ids are unavailable", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      sessionExport: createSessionExport([
        createMessage({ role: "user", text: "Launch the branch" }),
        createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
      ]),
    })

    expect(pointer).toEqual({
      rootSessionId: "root-session-1",
      checkpointMessageIndex: 0,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointSelection: {
        strategy: "previous_user_before_launch",
        configuredTags: [...DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS],
        launchMessageId: "msg-launch",
        launchMessageIndex: 1,
        rationale:
          "Selected the previous user message before launch message msg-launch because no configured breakpoint tag was found.",
      },
    })
    expect(formatRootAgentCheckpointPointer(pointer)).toBe("message-index 0")
  })

  test("createRootAgentCheckpointPointer uses previous_user mode even when an older tag exists", () => {
    const pointer = createRootAgentCheckpointPointer({
      rootSessionId: "root-session-1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointMode: "previous_user",
      sessionExport: createSessionExport([
        createMessage({ id: "msg-tagged", role: "user", text: `Pause here\n${DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS[0]}` }),
        createMessage({ id: "msg-user-2", role: "user", text: "Launch the branch from the latest user request" }),
        createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
      ]),
    })

    expect(pointer).toEqual({
      rootSessionId: "root-session-1",
      checkpointMessageId: "msg-user-2",
      checkpointMessageIndex: 1,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointSelection: {
        strategy: "previous_user_before_launch",
        configuredTags: [...DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS],
        launchMessageId: "msg-launch",
        launchMessageIndex: 2,
        rationale:
          "Selected the previous user message before launch message msg-launch because breakpoint mode was set to previous_user.",
      },
    })
  })

  test("validateRootAgentCheckpointPointer prefers checkpointMessageId over a stale index", () => {
    const sessionExport = createSessionExport([
      createMessage({ id: "msg-0", role: "user", text: "Earlier" }),
      createMessage({ id: "msg-1", role: "assistant", text: "Middle", completedAt: 20 }),
      createMessage({ id: "msg-2", role: "user", text: "Latest" }),
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
          createMessage({ id: "msg-launch", role: "assistant", text: "launch_supervision_branch" }),
        ]),
      })

      expect(refreshed).toEqual({
        rootSessionId: "root-session-1",
        checkpointMessageId: "msg-new",
        checkpointMessageIndex: 1,
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        breakpointSelection: {
          strategy: "previous_user_before_launch",
          configuredTags: [...DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS],
          launchMessageId: "msg-launch",
          launchMessageIndex: 2,
          rationale:
            "Selected the previous user message before launch message msg-launch because no configured breakpoint tag was found.",
        },
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

  test("createRootAgentCheckpointPointer throws when no tagged or previous user message exists", () => {
    expect(() =>
      createRootAgentCheckpointPointer({
        rootSessionId: "root-session-1",
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        sessionExport: createSessionExport([
          createMessage({ id: "msg-assistant-1", role: "assistant", text: "Only assistant history", completedAt: 10 }),
        ]),
      }),
    ).toThrow(
      "Failed to capture checkpoint pointer metadata: no tagged user message matched configured breakpoint tags (SESSION_BREAKPOINT) and no previous user message was found before branch launch.",
    )
  })
})
