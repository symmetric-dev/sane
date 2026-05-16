import { existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"

import { formatThreadId, parseThreadId } from "./execution-ids.ts"
import { atomicWriteFile } from "./index.ts"
import { getWorkDir } from "./repo.ts"
import { listOrderedStageDirectories } from "./stage-directories.ts"
import { loadWorkstreamPlan } from "./consolidate.ts"

import type { StreamDocument } from "./types.ts"

export interface EnsureThreadWorkDocsResult {
  createdFiles: string[]
  preservedFiles: string[]
}

export interface GenerateThreadWorkMdArgs {
  stageDirectoryName: string
  threadId: string
  stageName: string
  batchName: string
  threadName: string
  summary: string
  details: string
}

export const THREAD_WORK_REQUIRED_SECTIONS = [
  "Objective",
  "Do",
  "Done When",
  "Files to Know",
  "Verify",
  "Locked Decisions",
  "Not In Scope",
  "If Blocked",
] as const

export type ThreadWorkRequiredSection = (typeof THREAD_WORK_REQUIRED_SECTIONS)[number]

export interface ThreadWorkValidationError {
  section: ThreadWorkRequiredSection | "File"
  message: string
}

export interface ThreadWorkValidationResult {
  valid: boolean
  errors: ThreadWorkValidationError[]
}

interface ParsedThreadWorkSection {
  heading: string
  content: string
}

const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g
const DEFAULT_THREAD_WORK_PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /^Add the thread objective here\.?$/i,
  /^Add the concrete work to perform here\.?$/i,
  /^Add a concrete completion condition here\.?$/i,
  /^Add the most important files to read first\.?$/i,
  /^Add the files or directories this thread is allowed to change\.?$/i,
  /^Add the files or boundaries this thread must not cross\.?$/i,
  /^Add a short verification step here\.?$/i,
  /^Add a locked decision here\.?$/i,
  /^Add an explicit out-of-scope boundary here\.?$/i,
  /^Add a short blocked-state instruction here\.?$/i,
  /^Replace with/i,
]

export function resolveStageDirectoryName(
  repoRoot: string,
  streamId: string,
  syntheticStageId: number,
): string {
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (loadedPlan?.source === "stages" && loadedPlan.stagePlanPaths.length > 0) {
    const stagePlanPath = loadedPlan.stagePlanPaths[syntheticStageId - 1]
    const stageDirectoryName = stagePlanPath?.split("/").slice(-2, -1)[0]
    if (stageDirectoryName) {
      return stageDirectoryName
    }
  }

  const stagesDir = join(getWorkDir(repoRoot), streamId, "stages")
  const stageDirectories = listOrderedStageDirectories(stagesDir)
  const directoryName = stageDirectories[syntheticStageId - 1]?.name
  return directoryName ?? syntheticStageId.toString().padStart(2, "0")
}

export function getThreadWorkMdRelativePath(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string {
  const parsedThreadId = parseThreadId(threadId)
  const stageDirectoryName = resolveStageDirectoryName(repoRoot, streamId, parsedThreadId.stage)

  return join(streamId, "stages", stageDirectoryName, "threads", threadId, "WORK.md")
}

export function getThreadWorkMdPath(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string {
  return join(getWorkDir(repoRoot), getThreadWorkMdRelativePath(repoRoot, streamId, threadId))
}

export function generateThreadWorkMd(args: GenerateThreadWorkMdArgs): string {
  const summary = args.summary.trim()
  const details = args.details.trim()

  return `# Thread ${args.threadId} — ${args.threadName}

## Objective

<!-- Explain the thread goal in 1-3 sentences so the objective is unambiguous. -->
${summary || "<!-- Add the thread objective here. -->"}

## Do

<!-- Describe the concrete work to perform in this thread. Keep it actionable and specific. -->
${details || "<!-- Add the concrete work to perform here. -->"}

## Done When

<!-- Describe the observable completion conditions for this thread. -->
- <!-- Add a concrete completion condition here. -->

## Files to Know

<!-- Keep this short. Use the groups below with path + reason. -->

### READ

- \`./WORK.md\` — this thread's execution contract
- \`../../REQUIREMENTS.md\` — stage requirements
- \`../../../README.md\` — overall workstream context
- <!-- Add the most important files to read first. -->

### ALLOWED

- <!-- Add the files or directories this thread is allowed to change. -->

### FORBIDDEN

- <!-- Add the files or boundaries this thread must not cross. -->

## Verify

<!-- Keep this short. List the checks that prove the thread is done. -->
- <!-- Add a short verification step here. -->

## Locked Decisions

<!-- Keep this short. Record decisions this thread must not reopen. -->
- <!-- Add a locked decision here. -->

## Not In Scope

<!-- Keep this short. State what this thread must avoid changing. -->
- <!-- Add an explicit out-of-scope boundary here. -->

## If Blocked

<!-- Keep this short. State what to capture before stopping. -->
- <!-- Add a short blocked-state instruction here. -->
`
}

export function validateThreadWorkMd(content: string): ThreadWorkValidationResult {
  const errors: ThreadWorkValidationError[] = []
  const sections = parseThreadWorkSections(content)
  const byHeading = new Map(sections.map((section) => [section.heading, section]))

  for (const heading of THREAD_WORK_REQUIRED_SECTIONS) {
    const section = byHeading.get(heading)
    if (!section) {
      errors.push({
        section: heading,
        message: `Missing required heading: ${heading}`,
      })
      continue
    }

    if (!hasMeaningfulThreadWorkSectionContent(heading, section.content)) {
      errors.push({
        section: heading,
        message: `${heading} section must contain real content`,
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

function parseThreadWorkSections(content: string): ParsedThreadWorkSection[] {
  const lines = content.split(/\r?\n/)
  const sections: ParsedThreadWorkSection[] = []
  let current: ParsedThreadWorkSection | null = null

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/)

    if (match?.[1]) {
      if (current) {
        current.content = current.content.replace(/\n+$/, "")
        sections.push(current)
      }

      current = {
        heading: match[1].trim(),
        content: "",
      }
      continue
    }

    if (current) {
      current.content += `${line}\n`
    }
  }

  if (current) {
    current.content = current.content.replace(/\n+$/, "")
    sections.push(current)
  }

  return sections
}

function hasMeaningfulThreadWorkSectionContent(
  sectionName: ThreadWorkRequiredSection,
  content: string,
): boolean {
  const cleanedLines = stripHtmlComments(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0)

  if (cleanedLines.length === 0) {
    return false
  }

  return cleanedLines.some((line) => !isPlaceholderOnlyLine(sectionName, line))
}

function stripHtmlComments(value: string): string {
  return value.replace(HTML_COMMENT_RE, "")
}

function isPlaceholderOnlyLine(sectionName: ThreadWorkRequiredSection, value: string): boolean {
  const normalized = value.trim()
  if (!normalized) {
    return true
  }

  if (sectionName === "Files to Know") {
    if (/^#{3}\s+(READ|ALLOWED|FORBIDDEN)$/i.test(normalized)) {
      return true
    }

    if (/^`?\.\/WORK\.md`?\s+—\s+this thread's execution contract$/i.test(normalized)) {
      return true
    }

    if (/^`?\.\.\/\.\.\/REQUIREMENTS\.md`?\s+—\s+stage requirements$/i.test(normalized)) {
      return true
    }

    if (/^`?\.\.\/\.\.\/\.\.\/README\.md`?\s+—\s+overall workstream context$/i.test(normalized)) {
      return true
    }
  }

  if (sectionName === "Locked Decisions" && /^Stage directory:\s+`.+`$/i.test(normalized)) {
    return true
  }

  for (const pattern of DEFAULT_THREAD_WORK_PLACEHOLDER_PATTERNS) {
    if (pattern.test(normalized)) {
      return true
    }
  }

  return /^Add\b/i.test(normalized)
}

export function ensureThreadWorkDocsForPlan(
  repoRoot: string,
  streamId: string,
  doc: StreamDocument,
): EnsureThreadWorkDocsResult {
  const result: EnsureThreadWorkDocsResult = {
    createdFiles: [],
    preservedFiles: [],
  }

  for (const stage of doc.stages) {
    const stageDirectoryName = resolveStageDirectoryName(repoRoot, streamId, stage.id)

    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        const threadId = formatThreadId(stage.id, batch.id, thread.id)
        const workMdPath = getThreadWorkMdPath(repoRoot, streamId, threadId)
        const relativePath = join("work", getThreadWorkMdRelativePath(repoRoot, streamId, threadId))

        if (existsSync(workMdPath)) {
          result.preservedFiles.push(relativePath)
          continue
        }

        mkdirSync(dirname(workMdPath), { recursive: true })
        atomicWriteFile(
          workMdPath,
          generateThreadWorkMd({
            stageDirectoryName,
            threadId,
            stageName: stage.name,
            batchName: batch.name,
            threadName: thread.name,
            summary: thread.summary,
            details: thread.details,
          }),
        )
        result.createdFiles.push(relativePath)
      }
    }
  }

  return result
}
