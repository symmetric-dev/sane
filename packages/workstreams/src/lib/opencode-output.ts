/**
 * JSONL output parsing for opencode runs.
 *
 * Parses `opencode run --format json` output and extracts assistant text.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs"

interface JsonlEvent {
  type: string
}

export interface JsonlTextEvent extends JsonlEvent {
  type: "text"
  part: {
    text: string
  }
}

export interface JsonlStepEvent extends JsonlEvent {
  type: "step_start" | "step_finish"
  [key: string]: unknown
}

export interface OpencodeJsonlParseResult {
  text: string
  logs: string[]
  success: boolean
}

export function parseOpencodeJsonlText(content: string): OpencodeJsonlParseResult {
  const logs: string[] = []
  const textParts: string[] = []
  let success = true

  logs.push(`Starting JSONL parse (${content.length} bytes)`)

  const lines = content.split("\n").filter((line) => line.trim() !== "")
  logs.push(`Found ${lines.length} non-empty lines`)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    try {
      const event = JSON.parse(line) as JsonlEvent

      if (event.type === "text") {
        const textEvent = event as JsonlTextEvent
        if (textEvent.part?.text) {
          textParts.push(textEvent.part.text)
          logs.push(`Line ${i + 1}: Extracted text (${textEvent.part.text.length} chars)`)
        } else {
          logs.push(`Line ${i + 1}: Text event missing part.text field`)
        }
      } else {
        logs.push(`Line ${i + 1}: Skipped event type "${event.type}"`)
      }
    } catch (error) {
      logs.push(
        `Line ${i + 1}: JSON parse error - ${error instanceof Error ? error.message : String(error)}`,
      )
      success = false
    }
  }

  const text = textParts.join("")
  logs.push(`Parsing complete: ${textParts.length} text parts, ${text.length} total chars`)

  return { text, logs, success }
}

export function parseOpencodeJsonlFile(
  filePath: string,
  logPath?: string,
): OpencodeJsonlParseResult {
  const logs: string[] = []

  try {
    if (!existsSync(filePath)) {
      logs.push(`ERROR: File not found: ${filePath}`)
      return { text: "", logs, success: false }
    }

    logs.push(`Reading file: ${filePath}`)
    const content = readFileSync(filePath, "utf-8")
    logs.push(`Read ${content.length} bytes`)

    const result = parseOpencodeJsonlText(content)
    const allLogs = [...logs, ...result.logs]

    if (logPath) {
      try {
        appendFileSync(logPath, `${allLogs.join("\n")}\n`)
        allLogs.push(`Debug logs written to: ${logPath}`)
      } catch (error) {
        allLogs.push(
          `WARNING: Failed to write logs to ${logPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    return {
      text: result.text,
      logs: allLogs,
      success: result.success,
    }
  } catch (error) {
    logs.push(
      `ERROR: Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { text: "", logs, success: false }
  }
}
