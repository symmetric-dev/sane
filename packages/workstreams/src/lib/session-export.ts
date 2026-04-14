/**
 * Session Export Utilities
 *
 * Functions for exporting opencode sessions and extracting text messages
 * for synthesis context.
 */

import { spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIAGNOSTIC_SNIPPET_LENGTH = 240
const SESSION_EXPORT_TEMP_PREFIX = "agenv-session-export-"

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

interface JsonEnvelopeScanComplete {
  kind: "complete"
  endIndex: number
}

interface JsonEnvelopeScanIncomplete {
  kind: "incomplete"
  reason: "unterminated_string" | "unbalanced_delimiter"
}

type JsonEnvelopeScanResult = JsonEnvelopeScanComplete | JsonEnvelopeScanIncomplete

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

function getCompletedTimestamp(message: ExportedMessage | null | undefined): number | undefined {
  return hasCompletedTimestamp(message) ? message!.info.time!.completed : undefined
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
    const { stdout, stderr } = await exportSessionToTempFile(sanitizedId)
    return parseSessionExportOutput(stdout, { stderr })
  } catch (error) {
    if (error instanceof Error) {
      const commandError = error as Error & {
        code?: number | string
        signal?: NodeJS.Signals
        stdout?: string | Buffer
        stderr?: string | Buffer
      }

      if (
        Object.prototype.hasOwnProperty.call(commandError, "stdout") ||
        Object.prototype.hasOwnProperty.call(commandError, "stderr")
      ) {
        throw new Error(
          formatSessionExportCommandFailure({
            error: commandError,
            sessionId: sanitizedId,
          }),
        )
      }

      throw new Error(`Failed to export session: ${error.message}`)
    }
    throw new Error("Failed to export session: unknown error")
  }
}

export function createSessionExportChildStdio(stdoutFileDescriptor: number): ["ignore", number, "pipe"] {
  return ["ignore", stdoutFileDescriptor, "pipe"]
}

async function exportSessionToTempFile(sessionId: string): Promise<{ stdout: string; stderr: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), SESSION_EXPORT_TEMP_PREFIX))
  const tempFile = join(tempDir, `${sessionId}.json`)

  let stderr = ""
  let stdoutHandle: Awaited<ReturnType<typeof open>> | undefined

  try {
    stdoutHandle = await open(tempFile, "w")
    const child = spawn("opencode", ["export", sessionId], {
      stdio: createSessionExportChildStdio(stdoutHandle.fd),
    })

    if (!child.stderr) {
      throw new Error("Failed to capture stderr from opencode export")
    }

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => {
          resolve({ code, signal })
        })
      },
    )

    await stdoutHandle.close()
    stdoutHandle = undefined

    const stdout = await readFile(tempFile, "utf8")

    if (result.code !== null && result.code !== 0) {
      throw Object.assign(new Error(`Process exited with code ${String(result.code)}`), {
        code: result.code ?? undefined,
        signal: result.signal ?? undefined,
        stdout,
        stderr,
      })
    }

    if (result.signal) {
      throw Object.assign(new Error(`Process exited with signal ${result.signal}`), {
        code: result.code ?? undefined,
        signal: result.signal,
        stdout,
        stderr,
      })
    }

    return { stdout, stderr }
  } finally {
    await stdoutHandle?.close().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
}

export function formatSessionExportCommandFailure(args: {
  error: Error & {
    code?: number | string
    signal?: NodeJS.Signals
    stdout?: string | Buffer
    stderr?: string | Buffer
  }
  sessionId: string
}): string {
  const stdout = stringifyCommandStream(args.error.stdout)
  const stderr = stringifyCommandStream(args.error.stderr)
  const code = args.error.code !== undefined ? `exit code ${String(args.error.code)}` : "non-zero exit"
  const signal = args.error.signal ? `, signal ${args.error.signal}` : ""
  const stdoutSnippet = stdout ? `; stdout preview: ${createDiagnosticSnippet(stdout)}` : ""
  const stderrSnippet = stderr ? `; stderr preview: ${createDiagnosticSnippet(stderr)}` : ""

  return `Failed to export session: opencode export ${args.sessionId} failed with ${code}${signal}: ${args.error.message}${stdoutSnippet}${stderrSnippet}`
}

function stringifyCommandStream(stream: string | Buffer | undefined): string {
  if (typeof stream === "string") {
    return stream
  }

  if (stream instanceof Buffer) {
    return stream.toString("utf8")
  }

  return ""
}

function createDiagnosticSnippet(text: string, maxLength = DIAGNOSTIC_SNIPPET_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return "<empty>"
  }

  if (normalized.length <= maxLength) {
    return JSON.stringify(normalized)
  }

  return `${JSON.stringify(normalized.slice(0, maxLength))}…`
}

function validateSessionExportShape(exportData: unknown): SessionExport {
  if (!exportData || typeof exportData !== "object") {
    throw new Error("Invalid export format: expected top-level JSON object")
  }

  const candidate = exportData as SessionExport
  if (!candidate.info || !Array.isArray(candidate.messages)) {
    throw new Error("Invalid export format: missing info or messages")
  }

  return candidate
}

function scanJsonEnvelope(stdout: string, startIndex: number): JsonEnvelopeScanResult {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < stdout.length; index++) {
    const char = stdout[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{" || char === "[") {
      depth += 1
      continue
    }

    if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) {
        return { kind: "complete", endIndex: index }
      }
    }
  }

  if (inString) {
    return { kind: "incomplete", reason: "unterminated_string" }
  }

  return { kind: "incomplete", reason: "unbalanced_delimiter" }
}

function findJsonPayload(stdout: string):
  | {
      kind: "success"
      payload: string
      prefix: string
      suffix: string
    }
  | {
      kind: "incomplete"
      reason: "unterminated_string" | "unbalanced_delimiter"
      preview: string
    }
  | {
      kind: "missing"
      preview: string
    } {
  let incompleteCandidate:
    | {
        reason: "unterminated_string" | "unbalanced_delimiter"
        preview: string
      }
    | undefined

  const firstNonWhitespaceIndex = stdout.search(/\S/)
  if (firstNonWhitespaceIndex >= 0) {
    const firstNonWhitespaceChar = stdout[firstNonWhitespaceIndex]
    if (firstNonWhitespaceChar === "{" || firstNonWhitespaceChar === "[") {
      const scan = scanJsonEnvelope(stdout, firstNonWhitespaceIndex)
      if (scan.kind === "incomplete") {
        return {
          kind: "incomplete",
          reason: scan.reason,
          preview: createDiagnosticSnippet(stdout.slice(firstNonWhitespaceIndex)),
        }
      }

      const payload = stdout.slice(firstNonWhitespaceIndex, scan.endIndex + 1)
      try {
        JSON.parse(payload)
        return {
          kind: "success",
          payload,
          prefix: stdout.slice(0, firstNonWhitespaceIndex),
          suffix: stdout.slice(scan.endIndex + 1),
        }
      } catch {
        // Fall through to the broader mixed-output scan below.
      }
    }
  }

  for (let index = 0; index < stdout.length; index++) {
    const char = stdout[index]
    if (char !== "{" && char !== "[") {
      continue
    }

    const scan = scanJsonEnvelope(stdout, index)
    if (scan.kind === "incomplete") {
      incompleteCandidate ??= {
        reason: scan.reason,
        preview: createDiagnosticSnippet(stdout.slice(index)),
      }
      continue
    }

    const payload = stdout.slice(index, scan.endIndex + 1)
    try {
      JSON.parse(payload)
      return {
        kind: "success",
        payload,
        prefix: stdout.slice(0, index),
        suffix: stdout.slice(scan.endIndex + 1),
      }
    } catch {
      continue
    }
  }

  if (incompleteCandidate) {
    return {
      kind: "incomplete",
      reason: incompleteCandidate.reason,
      preview: incompleteCandidate.preview,
    }
  }

  return {
    kind: "missing",
    preview: createDiagnosticSnippet(stdout),
  }
}

export function parseSessionExportOutput(
  stdout: string,
  options: { stderr?: string } = {},
): SessionExport {
  const trimmedStdout = stdout.trim()
  const trimmedStderr = options.stderr?.trim() ?? ""
  const stderrNote = trimmedStderr
    ? `; stderr was not empty: ${createDiagnosticSnippet(trimmedStderr)}`
    : ""

  if (!trimmedStdout) {
    throw new Error(`Failed to parse session export JSON: stdout was empty${stderrNote}`)
  }

  try {
    return validateSessionExportShape(JSON.parse(trimmedStdout))
  } catch (error) {
    const payload = findJsonPayload(stdout)
    if (payload.kind === "success") {
      const exportData = validateSessionExportShape(JSON.parse(payload.payload))
      return exportData
    }

    if (payload.kind === "incomplete") {
      const detail =
        payload.reason === "unterminated_string"
          ? "stdout appears truncated/incomplete (unterminated JSON string)"
          : "stdout appears truncated/incomplete (unbalanced JSON delimiters)"
      throw new Error(
        `Failed to parse session export JSON: ${detail}; stdout preview: ${payload.preview}${stderrNote}`,
      )
    }

    const parseMessage = error instanceof Error ? error.message : "Unknown JSON parse failure"
    throw new Error(
      `Failed to parse session export JSON: ${parseMessage}; stdout preview: ${payload.preview}${stderrNote}`,
    )
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

  let lastCompletedAssistantMessage: ExportedMessage | null = null
  let lastCompletedTimestamp = Number.NEGATIVE_INFINITY

  for (const message of exportData.messages) {
    if (!message) {
      continue
    }

    const messageText = extractMessageText(message)
    const completedTimestamp = getCompletedTimestamp(message)
    if (!isAssistantMessage(message) || !messageText || completedTimestamp === undefined) {
      continue
    }

    if (completedTimestamp >= lastCompletedTimestamp) {
      lastCompletedAssistantMessage = message
      lastCompletedTimestamp = completedTimestamp
    }
  }

  if (lastCompletedAssistantMessage) {
    return lastCompletedAssistantMessage
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
