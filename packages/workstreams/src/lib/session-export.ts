/**
 * Session Export Utilities
 *
 * Functions for exporting opencode sessions and extracting text messages
 * for synthesis context.
 */

import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// ============================================================================
// Types - MessagePart Discriminated Union
// ============================================================================

/**
 * Text content part from assistant or user messages
 */
export interface TextPart {
  type: "text"
  text: string
}

/**
 * Tool invocation part with input/output state
 */
export interface ToolPart {
  type: "tool"
  tool: string
  state: {
    input: Record<string, unknown>
    output: string
  }
}

/**
 * Step start marker for agent processing phases
 */
export interface StepStartPart {
  type: "step-start"
  [key: string]: unknown
}

/**
 * Step finish marker for agent processing phases
 */
export interface StepFinishPart {
  type: "step-finish"
  [key: string]: unknown
}

/**
 * Patch part for file modifications
 */
export interface PatchPart {
  type: "patch"
  [key: string]: unknown
}

/**
 * Discriminated union of all message part types
 */
export type MessagePart =
  | TextPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | PatchPart

// ============================================================================
// Types - Session Export Structure
// ============================================================================

/**
 * Message info metadata
 */
export interface MessageInfo {
  id: string
  role: "user" | "assistant"
  time?: {
    created?: number
    completed?: number
  }
  finish?: string
  [key: string]: unknown
}

/**
 * Individual message in an exported session
 */
export interface ExportedMessage {
  info: MessageInfo
  parts: MessagePart[]
}

/**
 * Session summary statistics
 */
export interface SessionSummary {
  additions: number
  deletions: number
  files: number
}

/**
 * Session info metadata
 */
export interface SessionInfo {
  id: string
  title: string
  summary: SessionSummary
  [key: string]: unknown
}

/**
 * Complete session export structure matching opencode export JSON output
 */
export interface SessionExport {
  info: SessionInfo
  messages: ExportedMessage[]
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a part is a text part
 */
export function isTextPart(part: MessagePart): part is TextPart {
  return part.type === "text"
}

/**
 * Type guard to check if a part is a tool part
 */
export function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "tool"
}

function isAssistantMessage(message: ExportedMessage | null | undefined): boolean {
  return message?.info?.role === "assistant"
}

function hasCompletedTimestamp(message: ExportedMessage | null | undefined): boolean {
  return typeof message?.info?.time?.completed === "number"
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Export a session by running `opencode export <sessionId>` and parsing the JSON output
 *
 * @param sessionId - The session ID to export
 * @returns Parsed session export data
 * @throws Error if the command fails or returns invalid JSON
 */
export async function exportSession(sessionId: string): Promise<SessionExport> {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Invalid session ID: must be a non-empty string")
  }

  // Sanitize session ID to prevent command injection
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  if (sanitizedId !== sessionId) {
    throw new Error("Invalid session ID: contains invalid characters")
  }

  try {
    const { stdout } = await execAsync(`opencode export "${sanitizedId}"`, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large sessions
    })

    const exportData = JSON.parse(stdout) as SessionExport

    // Validate basic structure
    if (!exportData.info || !Array.isArray(exportData.messages)) {
      throw new Error("Invalid export format: missing info or messages")
    }

    return exportData
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse session export JSON: ${error.message}`)
    }
    if (error instanceof Error) {
      throw new Error(`Failed to export session: ${error.message}`)
    }
    throw new Error("Failed to export session: unknown error")
  }
}

// ============================================================================
// Text Extraction Functions
// ============================================================================

/**
 * Extract text content from all assistant messages in a session export
 *
 * Filters for assistant messages only and extracts only `type: "text"` parts,
 * concatenating them with newlines between messages.
 *
 * @param exportData - The session export data
 * @returns Concatenated text from assistant messages, or empty string on failure
 */
export function extractTextMessages(exportData: SessionExport): string {
  // Handle edge cases: null, undefined, or malformed data
  if (!exportData) {
    return ""
  }

  if (!exportData.messages || !Array.isArray(exportData.messages)) {
    return ""
  }

  // Filter to assistant messages only
  const assistantMessages = exportData.messages.filter(
    (msg) => msg?.info?.role === "assistant"
  )

  if (assistantMessages.length === 0) {
    return ""
  }

  // Extract text parts from each assistant message
  const textParts: string[] = []

  for (const message of assistantMessages) {
    if (!message.parts || !Array.isArray(message.parts)) {
      continue
    }

    // Collect all text parts from this message
    const messageTexts = message.parts
      .filter((part): part is TextPart => isTextPart(part))
      .map((part) => part.text)
      .filter((text) => text && typeof text === "string" && text.trim() !== "")

    if (messageTexts.length > 0) {
      // Join text parts within a message with newlines
      textParts.push(messageTexts.join("\n"))
    }
  }

  if (textParts.length === 0) {
    return ""
  }

  // Join messages with double newlines for separation
  return textParts.join("\n\n")
}

/**
 * Extract text content from a single exported message.
 *
 * Returns only non-empty text parts joined by newlines.
 */
export function extractMessageText(message: ExportedMessage | null | undefined): string {
  if (!message?.parts || !Array.isArray(message.parts)) {
    return ""
  }

  return message.parts
    .filter((part): part is TextPart => isTextPart(part))
    .map((part) => part.text)
    .filter((text) => text && typeof text === "string" && text.trim() !== "")
    .join("\n")
}

/**
 * Find the last completed assistant message in a session export.
 *
 * If no assistant message has a completion timestamp, this falls back to the
 * last assistant message that still has extractable text so older exports do
 * not lose the final report.
 */
export function findLastCompletedAssistantMessage(
  exportData: SessionExport,
): ExportedMessage | null {
  if (!exportData?.messages || !Array.isArray(exportData.messages)) {
    return null
  }

  for (let i = exportData.messages.length - 1; i >= 0; i--) {
    const message = exportData.messages[i]
    if (!message) {
      continue
    }

    if (isAssistantMessage(message) && hasCompletedTimestamp(message) && extractMessageText(message)) {
      return message
    }
  }

  for (let i = exportData.messages.length - 1; i >= 0; i--) {
    const message = exportData.messages[i]
    if (!message) {
      continue
    }

    if (isAssistantMessage(message) && extractMessageText(message)) {
      return message
    }
  }

  return null
}

/**
 * Extract the text from the last completed assistant message.
 */
export function extractLastCompletedAssistantText(exportData: SessionExport): string {
  return extractMessageText(findLastCompletedAssistantMessage(exportData))
}

/**
 * Export a session and extract text messages in a single operation
 *
 * Convenience function that combines exportSession and extractTextMessages.
 *
 * @param sessionId - The session ID to export
 * @returns Extracted text content from assistant messages
 * @throws Error if export fails (returns empty string on extraction failure)
 */
export async function exportAndExtractText(sessionId: string): Promise<string> {
  const exportData = await exportSession(sessionId)
  return extractTextMessages(exportData)
}
