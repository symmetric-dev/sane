/**
 * PLAN.md parsing utilities
 *
 * This module parses structured markdown from PLAN.md files using the marked lexer.
 * It extracts the stream document structure including stages, batches, and threads.
 */

import { Lexer, type Token, type Tokens } from "marked"
import type {
  StreamDocument,
  StageDefinition,
  BatchDefinition,
  ThreadDefinition,
  ConstitutionDefinition,
  StageQuestion,
  ConsolidateError,
} from "./types.ts"

/**
 * Parse state for tracking current position in the document
 */
interface ParseState {
  currentStage: number | null
  currentSection:
  | "definition"
  | "constitution"
  | "questions"
  | "batches"
  | null
  currentBatch: number | null
  currentThread: number | null
  currentThreadSection:
  | "summary"
  | "details"
  | null
}

/**
 * Extract text content from tokens, handling various token types
 */
function extractTextFromTokens(tokens: Token[]): string {
  let text = ""
  for (const token of tokens) {
    if (token.type === "paragraph") {
      const para = token as Tokens.Paragraph
      text += para.text + "\n"
    } else if (token.type === "text") {
      const txt = token as Tokens.Text
      text += txt.text + "\n"
    }
  }
  return text.trim()
}

/**
 * Extract list items from tokens
 */
function extractListItems(tokens: Token[]): string[] {
  const items: string[] = []
  for (const token of tokens) {
    if (token.type === "list") {
      const list = token as Tokens.List
      for (const item of list.items) {
        items.push(item.text.trim())
      }
    }
  }
  return items
}

/**
 * Extract stream name from H1 heading
 * Expected format: "# Plan: {streamName}"
 */
function extractStreamName(tokens: Token[]): string | null {
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading
      if (heading.depth === 1) {
        const match = heading.text.match(/^Plan:\s*(.+)$/i)
        if (match) {
          return match[1]!.trim()
        }
      }
    }
  }
  return null
}

/**
 * Find section content by H2 heading name
 */
function findSectionContent(tokens: Token[], sectionName: string): Token[] {
  const sectionTokens: Token[] = []
  let inSection = false

  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading
      if (heading.depth === 2) {
        if (heading.text.toLowerCase() === sectionName.toLowerCase()) {
          inSection = true
          continue
        } else if (inSection) {
          // End of section when we hit another H2
          break
        }
      }
    }
    if (inSection) {
      sectionTokens.push(token)
    }
  }

  return sectionTokens
}

/**
 * Extract summary section content
 */
function extractSummary(tokens: Token[]): string {
  const sectionTokens = findSectionContent(tokens, "Summary")
  return extractTextFromTokens(sectionTokens)
}

/**
 * Extract references section as list items
 */
function extractReferences(tokens: Token[]): string[] {
  const sectionTokens = findSectionContent(tokens, "References")
  return extractListItems(sectionTokens)
}

/**
 * Parse stage number and name from H3 heading
 * Expected format: "### Stage {n}: {stageName}"
 */
function parseStageHeading(text: string): { number: number; name: string } | null {
  const match = text.match(/^Stage\s+(\d+):\s*(.*)$/i)
  if (match) {
    return {
      number: parseInt(match[1]!, 10),
      name: match[2]!.trim(),
    }
  }
  return null
}

/**
 * Parse batch number and name from H5 heading
 * Expected format: "##### Batch {nn}: {batchName}"
 * Batch numbers are zero-padded (00, 01, 02...)
 */
function parseBatchHeading(text: string): { number: number; prefix: string; name: string } | null {
  const match = text.match(/^Batch\s+(\d{1,2}):\s*(.*)$/i)
  if (match) {
    const num = parseInt(match[1]!, 10)
    return {
      number: num,
      prefix: num.toString().padStart(2, "0"),
      name: match[2]!.trim(),
    }
  }
  return null
}

/**
 * Parse thread number and name from H6 heading (inside batches)
 * Expected format: "###### Thread {x}: {threadName}"
 */
function parseThreadHeading(text: string): { number: number; name: string } | null {
  const match = text.match(/^Thread\s+(\d+):\s*(.*)$/i)
  if (match) {
    return {
      number: parseInt(match[1]!, 10),
      name: match[2]!.trim(),
    }
  }
  return null
}

/**
 * Detect constitution subsection from bold text
 * Expected formats: "**Inputs:**", "**Structure:**", "**Outputs:**"
 */
function detectConstitutionSection(
  text: string
): "inputs" | "structure" | "outputs" | null {
  const lower = text.toLowerCase()
  if (lower.includes("structure")) return "structure"
  if (lower.includes("inputs")) return "inputs"
  if (lower.includes("outputs")) return "outputs"
  return null
}

/**
 * Detect thread subsection from bold text
 * Expected formats: "**Summary:**", "**Details:**"
 */
function detectThreadSection(
  text: string
): "summary" | "details" | null {
  const trimmed = text.trim().toLowerCase()
  // Match start of line, optional bold, "summary"/"details", optional bold/colon
  if (/^\**summary/i.test(trimmed)) return "summary"
  if (/^\**details/i.test(trimmed)) return "details"
  return null
}

/**
 * Parse stage questions from checklist items
 * Supports both [ ] (unresolved) and [x] (resolved) formats
 * 
 * Note: Input items may contain nested content (like "- **Decision:** ...")
 * which should be stripped to get just the question text.
 */
function parseQuestions(items: string[]): StageQuestion[] {
  return items.map((item) => {
    // Check if it's a checkbox item - match only the first line
    // Use multiline mode (m flag) so $ matches end of line, not just end of string
    const checkMatch = item.match(/^\[([x ])\]\s*(.*)$/im)
    if (checkMatch) {
      return {
        question: checkMatch[2]!.trim(),
        resolved: checkMatch[1]!.toLowerCase() === "x",
      }
    }
    // Plain text item - extract just the first line as the question
    const firstLine = item.split('\n')[0]!.trim()
    return {
      question: firstLine,
      resolved: false,
    }
  })
}

/**
 * Parse the full PLAN.md content into a StreamDocument
 */
export function parseStreamDocument(
  content: string,
  errors: ConsolidateError[]
): StreamDocument | null {
  const lexer = new Lexer()
  const tokens = lexer.lex(content)

  // Extract stream name
  const streamName = extractStreamName(tokens)
  if (!streamName) {
    errors.push({
      section: "Header",
      message: 'Missing or invalid workstream name. Expected "# Plan: {name}"',
    })
    return null
  }

  // Extract summary
  const summary = extractSummary(tokens)
  if (!summary) {
    errors.push({
      section: "Summary",
      message: "Missing or empty Summary section",
    })
  }

  // Extract references
  const references = extractReferences(tokens)

  // Parse stages
  const stages = parseStages(tokens, errors)

  return {
    streamName,
    summary: summary || "",
    references,
    stages,
  }
}

/**
 * Parse all stages from the Stages section.
 */
function parseStages(
  tokens: Token[],
  errors: ConsolidateError[]
): StageDefinition[] {
  const stages: StageDefinition[] = []
  const stagesTokens = findSectionContent(tokens, "Stages")

  let currentStage: StageDefinition | null = null
  let state: ParseState = {
    currentStage: null,
    currentSection: null,
    currentBatch: null,
    currentThread: null,
    currentThreadSection: null,
  }

  let definitionBuffer: string[] = []
  let constitutionBuffer: string[] = []
  let questionsBuffer: string[] = []
  let currentBatch: BatchDefinition | null = null
  let batchSummaryBuffer: string[] = []
  let currentThread: ThreadDefinition | null = null
  let threadSummaryBuffer: string[] = []
  let threadDetailsBuffer: string[] = []

  function saveCurrentThread() {
    if (currentThread && currentBatch) {
      currentThread.summary = threadSummaryBuffer.join("\n").trim()
      currentThread.details = threadDetailsBuffer.join("\n").trim()
      currentBatch.threads.push(currentThread)
    }
    currentThread = null
    threadSummaryBuffer = []
    threadDetailsBuffer = []
  }

  function saveCurrentBatch() {
    if (currentBatch && currentStage) {
      saveCurrentThread()
      currentBatch.summary = batchSummaryBuffer.join("\n").trim()
      currentStage.batches.push(currentBatch)
    }
    currentBatch = null
    batchSummaryBuffer = []
  }

  function saveCurrentStage() {
    if (currentStage) {
      currentStage.definition = definitionBuffer.join("\n").trim()
      currentStage.constitution = constitutionBuffer.join("\n").trim()
      currentStage.questions = parseQuestions(questionsBuffer)
      saveCurrentBatch()
      stages.push(currentStage)
    }
    currentStage = null
    definitionBuffer = []
    constitutionBuffer = []
    questionsBuffer = []
  }

  for (const token of stagesTokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading

      // H3: Stage N: {name}
      if (heading.depth === 3) {
        const stageInfo = parseStageHeading(heading.text)
        if (stageInfo) {
          saveCurrentStage()
          currentStage = {
            id: stageInfo.number,
            name: stageInfo.name,
            definition: "",
            constitution: "",
            questions: [],
            batches: [],
          }
          state.currentStage = stageInfo.number
          state.currentSection = null
          state.currentBatch = null
          state.currentThread = null
        }
      }

      // H4: Stage sections
      if (heading.depth === 4 && currentStage) {
        const lower = heading.text.toLowerCase()
        if (lower.includes("definition")) {
          state.currentSection = "definition"
        } else if (lower.includes("constitution")) {
          state.currentSection = "constitution"
        } else if (lower.includes("questions")) {
          state.currentSection = "questions"
        } else if (lower.includes("batches")) {
          state.currentSection = "batches"
          state.currentBatch = null
          state.currentThread = null
        } else {
          // Unknown H4 section (e.g., "Problem Analysis") - reset section state
          // to avoid capturing its content as questions or other data
          state.currentSection = null
        }
      }

      // H5: Batch NN: {name}
      if (heading.depth === 5 && state.currentSection === "batches") {
        const batchInfo = parseBatchHeading(heading.text)
        if (batchInfo && currentStage) {
          saveCurrentBatch()
          currentBatch = {
            id: batchInfo.number,
            prefix: batchInfo.prefix,
            name: batchInfo.name,
            summary: "",
            threads: [],
          }
          state.currentBatch = batchInfo.number
          state.currentThread = null
          state.currentThreadSection = null
          continue
        }
      }

      // H6: Thread N: {name} (inside batches)
      if (heading.depth === 6 && state.currentSection === "batches" && currentBatch) {
        const threadInfo = parseThreadHeading(heading.text)
        if (threadInfo) {
          saveCurrentThread()
          currentThread = {
            id: threadInfo.number,
            name: threadInfo.name,
            summary: "",
            details: "",
          }
          state.currentThread = threadInfo.number
          state.currentThreadSection = null
        }
      }

      continue
    }

    // Handle paragraph content
    if (token.type === "paragraph") {
      const para = token as Tokens.Paragraph
      let text = para.text // Use let so we can modify it if needed

      // Check for bold section markers in constitution
      if (state.currentSection === "constitution") {
        // Just treat everything as text
      }

      // Check for bold section markers in thread
      if (state.currentSection === "batches" && currentThread) {
        const threadSection = detectThreadSection(text)
        if (threadSection) {
          state.currentThreadSection = threadSection

          // Strip the header from the text
          // Example: "**Summary:** Content..." -> "Content..."
          text = text.replace(/^\s*\**\s*(summary|details)\s*:?\s*\**\s*:?\s*/i, "").trim()

          // If no content remains, we can skip processing
          if (!text) {
            continue
          }
        }
      }

      // Add content to appropriate buffer
      if (state.currentSection === "definition") {
        // Skip HTML comments
        if (!text.startsWith("<!--")) {
          definitionBuffer.push(text)
        }
      } else if (state.currentSection === "constitution") {
        if (!text.startsWith("<!--")) {
          constitutionBuffer.push(text)
        }
      } else if (state.currentSection === "batches" && currentBatch && !currentThread) {
        // Batch summary (text before any thread)
        if (!text.startsWith("<!--")) {
          batchSummaryBuffer.push(text)
        }
      } else if (state.currentSection === "batches" && currentThread) {
        // Skip HTML comments
        if (!text.startsWith("<!--")) {
          if (state.currentThreadSection === "summary") {
            threadSummaryBuffer.push(text)
          } else if (state.currentThreadSection === "details") {
            threadDetailsBuffer.push(text)
          }
        }
      }
    }

    // Handle list items
    if (token.type === "list") {
      const list = token as Tokens.List

      if (state.currentSection === "constitution") {
        const items = list.items.map((item) => item.text.trim())
        constitutionBuffer.push(...items.map((item) => `- ${item}`))
      } else if (state.currentSection === "questions") {
        // For questions, preserve checkbox state from marked's task list parsing
        const questionItems = list.items.map((item) => {
          if (item.task) {
            // marked parsed this as a task list item - use its checked property
            const prefix = item.checked ? "[x]" : "[ ]"
            return `${prefix} ${item.text.trim()}`
          }
          return item.text.trim()
        })
        questionsBuffer.push(...questionItems)
      } else if (state.currentSection === "batches" && currentThread) {
        // Lists in threads go to details (any content)
        if (state.currentThreadSection === "details") {
          const items = list.items.map((item) => item.text.trim())
          threadDetailsBuffer.push(...items.map(item => `- ${item}`))
        }
      }
    }

    // Handle code blocks in threads (any content goes to details)
    if (token.type === "code" && state.currentSection === "batches" && currentThread) {
      if (state.currentThreadSection === "details") {
        const code = token as Tokens.Code
        threadDetailsBuffer.push("```" + (code.lang || "") + "\n" + code.text + "\n```")
      }
    }
  }

  // Save the last stage
  saveCurrentStage()

  return stages
}

/**
 * Get a preview of the stream structure (just titles and counts)
 */
export function getStreamPreview(content: string): {
  streamName: string | null
  summary: string
  stageCount: number
  stages: {
    number: number
    name: string
    batchCount: number
    threadCount: number
    batches: {
      number: number
      prefix: string
      name: string
      threadCount: number
      threads: { number: number; name: string }[]
    }[]
  }[]
  questionCounts: { open: number; resolved: number }
} {
  const errors: ConsolidateError[] = []
  const doc = parseStreamDocument(content, errors)

  if (!doc) {
    return {
      streamName: null,
      summary: "",
      stageCount: 0,
      stages: [],
      questionCounts: { open: 0, resolved: 0 },
    }
  }

  let openQuestions = 0
  let resolvedQuestions = 0

  const stages = doc.stages.map((stage) => {
    for (const q of stage.questions) {
      if (q.resolved) resolvedQuestions++
      else openQuestions++
    }

    // Count total threads across all batches
    const totalThreads = stage.batches.reduce((sum, batch) => sum + batch.threads.length, 0)

    return {
      number: stage.id,
      name: stage.name,
      batchCount: stage.batches.length,
      threadCount: totalThreads,
      batches: stage.batches.map((batch) => ({
        number: batch.id,
        prefix: batch.prefix,
        name: batch.name,
        threadCount: batch.threads.length,
        threads: batch.threads.map((t) => ({
          number: t.id,
          name: t.name,
        })),
      })),
    }
  })

  return {
    streamName: doc.streamName,
    summary: doc.summary.slice(0, 200) + (doc.summary.length > 200 ? "..." : ""),
    stageCount: doc.stages.length,
    stages,
    questionCounts: { open: openQuestions, resolved: resolvedQuestions },
  }
}
