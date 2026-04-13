import { describe, expect, test, mock, beforeEach } from "bun:test"
import {
  extractLastCompletedAssistantText,
  extractMessageText,
  extractTextMessages,
  findLastCompletedAssistantMessage,
  isTextPart,
  isToolPart,
  type SessionExport,
  type TextPart,
  type ToolPart,
  type MessagePart,
  type ExportedMessage,
} from "../src/lib/session-export"

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a minimal valid SessionExport for testing
 */
function createSessionExport(
  messages: ExportedMessage[] = []
): SessionExport {
  return {
    info: {
      id: "test-session-id",
      title: "Test Session",
      summary: { additions: 0, deletions: 0, files: 0 },
    },
    messages,
  }
}

/**
 * Create an assistant message with given parts
 */
function createAssistantMessage(parts: MessagePart[]): ExportedMessage {
  return {
    info: { id: "msg-1", role: "assistant" },
    parts,
  }
}

/**
 * Create a user message with given parts
 */
function createUserMessage(parts: MessagePart[]): ExportedMessage {
  return {
    info: { id: "msg-2", role: "user" },
    parts,
  }
}

// ============================================================================
// Type Guard Tests
// ============================================================================

describe("type guards", () => {
  describe("isTextPart", () => {
    test("returns true for text parts", () => {
      const textPart: TextPart = { type: "text", text: "hello" }
      expect(isTextPart(textPart)).toBe(true)
    })

    test("returns false for tool parts", () => {
      const toolPart: ToolPart = {
        type: "tool",
        tool: "read",
        state: { input: {}, output: "" },
      }
      expect(isTextPart(toolPart)).toBe(false)
    })

    test("returns false for step-start parts", () => {
      const part: MessagePart = { type: "step-start" }
      expect(isTextPart(part)).toBe(false)
    })

    test("returns false for step-finish parts", () => {
      const part: MessagePart = { type: "step-finish" }
      expect(isTextPart(part)).toBe(false)
    })

    test("returns false for patch parts", () => {
      const part: MessagePart = { type: "patch" }
      expect(isTextPart(part)).toBe(false)
    })
  })

  describe("isToolPart", () => {
    test("returns true for tool parts", () => {
      const toolPart: ToolPart = {
        type: "tool",
        tool: "bash",
        state: { input: { command: "ls" }, output: "file1.txt" },
      }
      expect(isToolPart(toolPart)).toBe(true)
    })

    test("returns false for text parts", () => {
      const textPart: TextPart = { type: "text", text: "hello" }
      expect(isToolPart(textPart)).toBe(false)
    })
  })
})

// ============================================================================
// extractTextMessages Tests
// ============================================================================

describe("extractTextMessages", () => {
  describe("basic extraction", () => {
    test("extracts text from single assistant message", () => {
      const session = createSessionExport([
        createAssistantMessage([{ type: "text", text: "Hello world" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Hello world")
    })

    test("extracts and joins multiple text parts in single message", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("First part\nSecond part")
    })

    test("extracts and joins text from multiple assistant messages", () => {
      const session = createSessionExport([
        createAssistantMessage([{ type: "text", text: "Message one" }]),
        createAssistantMessage([{ type: "text", text: "Message two" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Message one\n\nMessage two")
    })
  })

  describe("filtering", () => {
    test("ignores user messages", () => {
      const session = createSessionExport([
        createUserMessage([{ type: "text", text: "User text" }]),
        createAssistantMessage([{ type: "text", text: "Assistant text" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Assistant text")
      expect(result).not.toContain("User text")
    })

    test("ignores tool parts", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "Before tool" },
          {
            type: "tool",
            tool: "bash",
            state: { input: {}, output: "tool output" },
          },
          { type: "text", text: "After tool" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Before tool\nAfter tool")
      expect(result).not.toContain("tool output")
    })

    test("ignores step-start and step-finish parts", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "step-start" },
          { type: "text", text: "Content" },
          { type: "step-finish" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Content")
    })

    test("ignores patch parts", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "Before patch" },
          { type: "patch" },
          { type: "text", text: "After patch" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Before patch\nAfter patch")
    })
  })

  describe("edge cases - empty data", () => {
    test("returns empty string for null input", () => {
      const result = extractTextMessages(null as unknown as SessionExport)
      expect(result).toBe("")
    })

    test("returns empty string for undefined input", () => {
      const result = extractTextMessages(undefined as unknown as SessionExport)
      expect(result).toBe("")
    })

    test("returns empty string for empty messages array", () => {
      const session = createSessionExport([])
      const result = extractTextMessages(session)
      expect(result).toBe("")
    })

    test("returns empty string when no assistant messages", () => {
      const session = createSessionExport([
        createUserMessage([{ type: "text", text: "User only" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("")
    })

    test("returns empty string when assistant has no text parts", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "tool", tool: "bash", state: { input: {}, output: "" } },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("")
    })
  })

  describe("edge cases - malformed data", () => {
    test("returns empty string when messages is not an array", () => {
      const session = {
        info: { id: "1", title: "test", summary: { additions: 0, deletions: 0, files: 0 } },
        messages: "not an array",
      } as unknown as SessionExport

      const result = extractTextMessages(session)
      expect(result).toBe("")
    })

    test("handles messages with undefined parts", () => {
      const session = createSessionExport([
        {
          info: { id: "1", role: "assistant" },
          parts: undefined as unknown as MessagePart[],
        },
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("")
    })

    test("handles messages with non-array parts", () => {
      const session = createSessionExport([
        {
          info: { id: "1", role: "assistant" },
          parts: "not an array" as unknown as MessagePart[],
        },
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("")
    })

    test("handles null message in array", () => {
      const session = createSessionExport([
        null as unknown as ExportedMessage,
        createAssistantMessage([{ type: "text", text: "Valid message" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Valid message")
    })

    test("handles message with null info", () => {
      const session = createSessionExport([
        {
          info: null as unknown as { id: string; role: "assistant" },
          parts: [{ type: "text", text: "Should be skipped" }],
        },
        createAssistantMessage([{ type: "text", text: "Valid" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Valid")
    })
  })

  describe("edge cases - whitespace handling", () => {
    test("skips empty text strings", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "" },
          { type: "text", text: "Valid" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Valid")
    })

    test("skips whitespace-only text strings", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "   " },
          { type: "text", text: "Valid" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Valid")
    })

    test("preserves internal whitespace in text", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "text", text: "Line 1\n\nLine 2  with  spaces" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Line 1\n\nLine 2  with  spaces")
    })
  })

  describe("complex scenarios", () => {
    test("handles interleaved user and assistant messages", () => {
      const session = createSessionExport([
        createUserMessage([{ type: "text", text: "User 1" }]),
        createAssistantMessage([{ type: "text", text: "Assistant 1" }]),
        createUserMessage([{ type: "text", text: "User 2" }]),
        createAssistantMessage([{ type: "text", text: "Assistant 2" }]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Assistant 1\n\nAssistant 2")
    })

    test("handles mixed part types in messages", () => {
      const session = createSessionExport([
        createAssistantMessage([
          { type: "step-start" },
          { type: "text", text: "Analyzing code" },
          { type: "tool", tool: "read", state: { input: {}, output: "code..." } },
          { type: "text", text: "Found issues" },
          { type: "tool", tool: "edit", state: { input: {}, output: "done" } },
          { type: "text", text: "Fixed problems" },
          { type: "step-finish" },
        ]),
      ])

      const result = extractTextMessages(session)
      expect(result).toBe("Analyzing code\nFound issues\nFixed problems")
    })

    test("handles realistic session with multiple messages and mixed content", () => {
      const session: SessionExport = {
        info: {
          id: "abc123",
          title: "Fix bug in parser",
          summary: { additions: 10, deletions: 5, files: 2 },
        },
        messages: [
          createUserMessage([{ type: "text", text: "Please fix the parser" }]),
          createAssistantMessage([
            { type: "step-start" },
            { type: "text", text: "I'll analyze the parser code." },
            { type: "tool", tool: "read", state: { input: { path: "parser.ts" }, output: "..." } },
            { type: "text", text: "Found the bug in line 42." },
          ]),
          createUserMessage([{ type: "text", text: "Great, fix it" }]),
          createAssistantMessage([
            { type: "text", text: "Applying the fix now." },
            { type: "tool", tool: "edit", state: { input: {}, output: "..." } },
            { type: "text", text: "Done! The parser should work correctly." },
            { type: "step-finish" },
          ]),
        ],
      }

      const result = extractTextMessages(session)
      expect(result).toContain("I'll analyze the parser code.")
      expect(result).toContain("Found the bug in line 42.")
      expect(result).toContain("Applying the fix now.")
      expect(result).toContain("Done! The parser should work correctly.")
      expect(result).not.toContain("Please fix the parser")
      expect(result).not.toContain("Great, fix it")
    })
  })
})

describe("extractMessageText", () => {
  test("joins text parts from a single message", () => {
    expect(
      extractMessageText(
        createAssistantMessage([
          { type: "text", text: "Accomplished work" },
          { type: "tool", tool: "bash", state: { input: {}, output: "ignored" } },
          { type: "text", text: "Reason for yield" },
        ]),
      ),
    ).toBe("Accomplished work\nReason for yield")
  })

  test("returns empty string for malformed messages", () => {
    expect(extractMessageText(null as unknown as ExportedMessage)).toBe("")
    expect(
      extractMessageText({
        info: { id: "msg-1", role: "assistant" },
        parts: undefined as unknown as MessagePart[],
      }),
    ).toBe("")
  })
})

describe("findLastCompletedAssistantMessage", () => {
  test("prefers the last assistant message with a completion timestamp", () => {
    const earlierCompleted = createAssistantMessage([{ type: "text", text: "Earlier report" }])
    earlierCompleted.info.id = "msg-earlier"
    earlierCompleted.info.time = { created: 1, completed: 2 }

    const finalCompleted = createAssistantMessage([{ type: "text", text: "Final report" }])
    finalCompleted.info.id = "msg-final"
    finalCompleted.info.time = { created: 3, completed: 4 }

    const incompleteLater = createAssistantMessage([{ type: "text", text: "Streaming draft" }])
    incompleteLater.info.id = "msg-draft"
    incompleteLater.info.time = { created: 5 }

    const session = createSessionExport([
      earlierCompleted,
      createUserMessage([{ type: "text", text: "Thanks" }]),
      finalCompleted,
      incompleteLater,
    ])

    expect(findLastCompletedAssistantMessage(session)?.info.id).toBe("msg-final")
  })

  test("falls back to the last assistant message with text when completion metadata is missing", () => {
    const first = createAssistantMessage([{ type: "text", text: "First" }])
    first.info.id = "msg-first"

    const last = createAssistantMessage([{ type: "text", text: "Last without completed" }])
    last.info.id = "msg-last"

    const session = createSessionExport([first, last])

    expect(findLastCompletedAssistantMessage(session)?.info.id).toBe("msg-last")
  })

  test("returns null when there is no assistant text to extract", () => {
    const session = createSessionExport([
      createUserMessage([{ type: "text", text: "Only user content" }]),
    ])

    expect(findLastCompletedAssistantMessage(session)).toBeNull()
  })
})

describe("extractLastCompletedAssistantText", () => {
  test("extracts the final completed assistant report text", () => {
    const earlier = createAssistantMessage([{ type: "text", text: "Earlier report" }])
    earlier.info.time = { created: 1, completed: 2 }

    const final = createAssistantMessage([
      { type: "text", text: "Accomplished work: updated parent monitor." },
      { type: "text", text: "Reason for yielding: batch paused for Root Agent review." },
    ])
    final.info.time = { created: 3, completed: 4 }

    const session = createSessionExport([earlier, final])

    expect(extractLastCompletedAssistantText(session)).toBe(
      "Accomplished work: updated parent monitor.\nReason for yielding: batch paused for Root Agent review.",
    )
  })
})
