/**
 * REQUIREMENTS.md generation, parsing, and validation helpers.
 */

import { existsSync } from "fs"
import { join, normalize, isAbsolute } from "path"

export const REQUIREMENTS_SECTION_ORDER = [
  "Summary",
  "Deliverables",
  "Dependencies",
  "Resources",
] as const

export type RequirementsSectionName = (typeof REQUIREMENTS_SECTION_ORDER)[number]

export interface RequirementsBulletEntry {
  raw: string
  line: number
  path?: string
}

export interface RequirementsDocument {
  summary: string
  deliverables: RequirementsBulletEntry[]
  dependencies: RequirementsBulletEntry[]
  resources: RequirementsBulletEntry[]
  headings: string[]
}

export interface RequirementsValidationError {
  line?: number
  section: RequirementsSectionName
  message: string
}

export interface RequirementsValidationResult {
  valid: boolean
  document: RequirementsDocument
  errors: RequirementsValidationError[]
  warnings: string[]
}

interface ParsedSection {
  heading: string
  content: string
  startLine: number
}

const BACKTICK_PATH_RE = /`([^`]+)`/
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g
const HTTP_URL_RE = /^https?:\/\//i
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

export function getRequirementsMdPath(repoRoot: string, streamId: string): string {
  return join(repoRoot, "work", streamId, "REQUIREMENTS.md")
}

export function generateRequirementsMd(): string {
  return `# Requirements

## Summary

<!-- Describe the workstream goal in freeform markdown. Do not use bullets in this section. -->

## Deliverables

<!-- Keep this section as bullets. List the concrete outputs this workstream must produce. -->
- Replace with a concrete deliverable

## Dependencies

<!-- Keep this section as bullets. Reference repo-relative code paths in backticks, for example: \`packages/workstreams/src/lib/generate.ts\` -->
- \`packages/workstreams/src/lib/generate.ts\`

## Resources

<!-- Keep this section as bullets. Reference workstream resource files under \`resources/\`, for example: \`resources/example-notes.md\` -->
- \`resources/example-notes.md\`
`
}

export function parseRequirementsDocument(content: string): RequirementsDocument {
  const sections = extractSections(content)
  const byHeading = new Map(sections.map((section) => [section.heading, section]))

  return {
    summary: getSectionMarkdown(byHeading.get("Summary")),
    deliverables: parseBulletSection(byHeading.get("Deliverables")),
    dependencies: parseBulletSection(byHeading.get("Dependencies"), true),
    resources: parseBulletSection(byHeading.get("Resources"), false, true),
    headings: sections.map((section) => section.heading),
  }
}

export function validateRequirementsDocument(args: {
  content: string
  repoRoot: string
  streamId: string
}): RequirementsValidationResult {
  const errors: RequirementsValidationError[] = []
  const warnings: string[] = []

  const sections = extractSections(args.content)
  const sectionNames = sections.map((section) => section.heading)
  const byHeading = new Map(sections.map((section) => [section.heading, section]))
  const document = parseRequirementsDocument(args.content)

  for (const heading of REQUIREMENTS_SECTION_ORDER) {
    if (!byHeading.has(heading)) {
      errors.push({
        section: heading,
        message: `Missing required heading: ${heading}`,
      })
    }
  }

  const order = sectionNames.filter((heading): heading is RequirementsSectionName =>
    REQUIREMENTS_SECTION_ORDER.includes(heading as RequirementsSectionName),
  )
  if (order.length === REQUIREMENTS_SECTION_ORDER.length) {
    for (let index = 0; index < REQUIREMENTS_SECTION_ORDER.length; index++) {
      if (order[index] !== REQUIREMENTS_SECTION_ORDER[index]) {
        errors.push({
          section: REQUIREMENTS_SECTION_ORDER[index]!,
          message: `Required headings must appear in order: ${REQUIREMENTS_SECTION_ORDER.join(", ")}`,
        })
        break
      }
    }
  }

  if (byHeading.has("Summary") && document.summary.trim().length === 0) {
    errors.push({
      section: "Summary",
      message: "Summary section is empty",
    })
  }

  if (byHeading.has("Deliverables") && document.deliverables.length === 0) {
    errors.push({
      section: "Deliverables",
      message: "Deliverables section must contain at least one bullet",
    })
  }

  if (byHeading.has("Dependencies") && document.dependencies.length === 0) {
    warnings.push("Dependencies section is empty")
  }

  if (byHeading.has("Resources") && document.resources.length === 0) {
    warnings.push("Resources section is empty")
  }

  for (const entry of document.dependencies) {
    if (!entry.path) {
      errors.push({
        line: entry.line,
        section: "Dependencies",
        message: "Dependency path entry is missing or invalid",
      })
      continue
    }

    if (!existsSync(join(args.repoRoot, entry.path))) {
      errors.push({
        line: entry.line,
        section: "Dependencies",
        message: `Dependency path does not exist in repo root: ${entry.path}`,
      })
    }
  }

  for (const entry of document.resources) {
    if (!entry.path) {
      errors.push({
        line: entry.line,
        section: "Resources",
        message: "Resource path entry is missing or invalid",
      })
      continue
    }

    if (isExternalResourceUrl(entry.path)) {
      continue
    }

    if (!entry.path.startsWith("resources/")) {
      errors.push({
        line: entry.line,
        section: "Resources",
        message: `Resource entry must be under resources/: ${entry.path}`,
      })
      continue
    }

    if (!existsSync(join(args.repoRoot, "work", args.streamId, entry.path))) {
      errors.push({
        line: entry.line,
        section: "Resources",
        message: `Referenced resource file does not exist under the workstream resources directory: ${entry.path}`,
      })
    }
  }

  return {
    valid: errors.length === 0,
    document,
    errors,
    warnings,
  }
}

function extractSections(content: string): ParsedSection[] {
  const lines = content.split(/\r?\n/)
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const match = line.match(/^##\s+(.+?)\s*$/)

    if (match?.[1]) {
      if (current) {
        current.content = current.content.replace(/\n+$/, "")
        sections.push(current)
      }

      current = {
        heading: match[1].trim(),
        content: "",
        startLine: index + 1,
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

function getSectionMarkdown(section?: ParsedSection): string {
  if (!section) {
    return ""
  }

  return stripComments(section.content).trim()
}

function parseBulletSection(
  section: ParsedSection | undefined,
  extractBacktickPath: boolean = false,
  extractResourceReference: boolean = false,
): RequirementsBulletEntry[] {
  if (!section) {
    return []
  }

  const lines = section.content.split(/\r?\n/)
  const entries: RequirementsBulletEntry[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (line.trim().startsWith("<!--")) {
      continue
    }

    const match = line.match(/^\s*-\s+(.+?)\s*$/)
    if (!match?.[1]) {
      continue
    }

    const raw = stripComments(match[1]).trim()
    if (!raw) {
      continue
    }

    const entry: RequirementsBulletEntry = {
      raw,
      line: section.startLine + index + 1,
    }

    if (extractResourceReference) {
      entry.path = extractNormalizedResourceReference(raw)
    } else if (extractBacktickPath) {
      entry.path = extractNormalizedBacktickPath(raw)
    }

    entries.push(entry)
  }

  return entries
}

function stripComments(value: string): string {
  return value.replace(HTML_COMMENT_RE, "")
}

function extractNormalizedBacktickPath(value: string): string | undefined {
  const match = value.match(BACKTICK_PATH_RE)
  const rawPath = match?.[1]?.trim()

  return normalizeRelativeBacktickPath(rawPath)
}

function extractNormalizedResourceReference(value: string): string | undefined {
  const match = value.match(BACKTICK_PATH_RE)
  const rawReference = match?.[1]?.trim()

  if (!rawReference) {
    return undefined
  }

  if (HTTP_URL_RE.test(rawReference)) {
    return isExternalResourceUrl(rawReference) ? rawReference : undefined
  }

  if (URI_SCHEME_RE.test(rawReference)) {
    return undefined
  }

  return normalizeRelativeBacktickPath(rawReference)
}

function normalizeRelativeBacktickPath(rawPath: string | undefined): string | undefined {

  if (!rawPath || isAbsolute(rawPath)) {
    return undefined
  }

  const normalizedPath = normalize(rawPath).replace(/\\/g, "/")
  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    return undefined
  }

  return normalizedPath
}

function isExternalResourceUrl(value: string): boolean {
  if (!HTTP_URL_RE.test(value)) {
    return false
  }

  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
