/**
 * CLI Utilities
 *
 * Reusable utilities for CLI argument parsing and help text formatting.
 * Provides consistent patterns across workstream CLI commands.
 */

/**
 * Common CLI argument definitions used across commands
 */
export interface CommonCliArgs {
  repoRoot?: string
  streamId?: string
  dryRun?: boolean
  help?: boolean
}

/**
 * Argument definition for CLI parsing
 */
export interface ArgDefinition {
  /** Long form of argument (e.g., "--stream") */
  long: string
  /** Short form of argument (e.g., "-s") */
  short?: string
  /** Alternative long forms (e.g., "--plan" as alias for "--stream") */
  aliases?: string[]
  /** Description for help text */
  description: string
  /** Whether this argument takes a value */
  takesValue: boolean
  /** Whether this argument is required */
  required?: boolean
  /** Default value if not provided */
  defaultValue?: string | number | boolean
  /** Value type for validation */
  valueType?: "string" | "number" | "boolean"
}

/**
 * Parse result for a single argument
 */
export interface ParsedArg {
  value: string | number | boolean | undefined
  provided: boolean
}

/**
 * CLI parsing error
 */
export interface ParseError {
  arg: string
  message: string
}

/**
 * Result of CLI argument parsing
 */
export interface ParseResult<T> {
  success: boolean
  args: T | null
  errors: ParseError[]
  showHelp: boolean
}

/**
 * Common argument definitions reusable across commands
 */
export const COMMON_ARGS: Record<string, ArgDefinition> = {
  repoRoot: {
    long: "--repo-root",
    short: "-r",
    description: "Repository root (auto-detected if omitted)",
    takesValue: true,
    valueType: "string",
  },
  stream: {
    long: "--stream",
    short: "-s",
    aliases: ["--plan", "-p"],
    description: "Workstream ID or name (uses current if not specified)",
    takesValue: true,
    valueType: "string",
  },
  batch: {
    long: "--batch",
    short: "-b",
    description: 'Batch ID (format: "SS.BB", e.g., "01.02")',
    takesValue: true,
    valueType: "string",
  },
  thread: {
    long: "--thread",
    short: "-t",
    description: 'Thread ID (format: "SS.BB.TT", e.g., "01.01.02")',
    takesValue: true,
    valueType: "string",
  },
  agent: {
    long: "--agent",
    short: "-a",
    description: "Agent name to use",
    takesValue: true,
    valueType: "string",
  },
  port: {
    long: "--port",
    short: "-p",
    description: "OpenCode server port (default: 4096)",
    takesValue: true,
    valueType: "number",
    defaultValue: 4096,
  },
  dryRun: {
    long: "--dry-run",
    description: "Show commands without executing",
    takesValue: false,
  },
  json: {
    long: "--json",
    short: "-j",
    description: "Output as JSON",
    takesValue: false,
  },
  silent: {
    long: "--silent",
    description: "Disable notification sounds",
    takesValue: false,
  },
  help: {
    long: "--help",
    short: "-h",
    description: "Show this help message",
    takesValue: false,
  },
}

/**
 * Format a section of help text with proper indentation
 */
export function formatHelpSection(
  title: string,
  items: Array<{ label: string; description: string }>,
  labelWidth: number = 20,
): string {
  const lines: string[] = [`${title}:`]
  for (const item of items) {
    const padding = " ".repeat(Math.max(1, labelWidth - item.label.length))
    lines.push(`  ${item.label}${padding}${item.description}`)
  }
  return lines.join("\n")
}

/**
 * Format argument definitions into help text
 */
export function formatArgsHelp(
  args: ArgDefinition[],
  labelWidth: number = 22,
): string {
  const items = args.map((arg) => {
    const flags = [arg.long]
    if (arg.short) flags.unshift(arg.short)
    if (arg.aliases) flags.push(...arg.aliases)

    let label = flags.join(", ")
    if (arg.takesValue) {
      const valueName = arg.long.replace(/^--/, "").toUpperCase().replace(/-/g, "_")
      label += ` <${valueName}>`
    }

    let description = arg.description
    if (arg.required) description = `(Required) ${description}`

    return { label, description }
  })

  return formatHelpSection("Options", items, labelWidth)
}

/**
 * Build a standard help message with usage, description, options, and examples
 */
export function buildHelpMessage(options: {
  command: string
  description: string
  usage: string[]
  args: ArgDefinition[]
  examples?: string[]
  notes?: string[]
}): string {
  const sections: string[] = [
    `${options.command} - ${options.description}`,
    "",
    "Usage:",
    ...options.usage.map((u) => `  ${u}`),
    "",
    formatArgsHelp(options.args),
  ]

  if (options.examples && options.examples.length > 0) {
    sections.push("", "Examples:")
    for (const example of options.examples) {
      sections.push(`  ${example}`)
    }
  }

  if (options.notes && options.notes.length > 0) {
    sections.push("", ...options.notes)
  }

  return sections.join("\n")
}

/**
 * Parse batch ID "SS.BB" into stage and batch numbers
 * Returns null if the format is invalid
 */
export function parseBatchId(
  batchId: string,
): { stage: number; batch: number } | null {
  const parts = batchId.split(".")
  if (parts.length !== 2) return null

  const stage = parseInt(parts[0]!, 10)
  const batch = parseInt(parts[1]!, 10)

  if (isNaN(stage) || isNaN(batch)) return null
  if (stage < 1 || batch < 1) return null

  return { stage, batch }
}

/**
 * Parse thread ID "SS.BB.TT" into stage, batch, and thread numbers
 * Returns null if the format is invalid
 */
export function parseThreadIdFormat(
  threadId: string,
): { stage: number; batch: number; thread: number } | null {
  const parts = threadId.split(".")
  if (parts.length !== 3) return null

  const stage = parseInt(parts[0]!, 10)
  const batch = parseInt(parts[1]!, 10)
  const thread = parseInt(parts[2]!, 10)

  if (isNaN(stage) || isNaN(batch) || isNaN(thread)) return null
  if (stage < 1 || batch < 1 || thread < 1) return null

  return { stage, batch, thread }
}

/**
 * Check if a string looks like a numeric ID (e.g., "01.02.03")
 */
export function isNumericId(id: string, expectedParts: number = 3): boolean {
  const parts = id.split(".")
  if (parts.length !== expectedParts) return false
  return parts.every((p) => /^\d+$/.test(p))
}

/**
 * Format a numeric ID with zero-padding
 * @param parts Array of numbers to format
 * @param padding Number of digits for zero-padding (default: 2)
 */
export function formatNumericId(parts: number[], padding: number = 2): string {
  return parts.map((p) => p.toString().padStart(padding, "0")).join(".")
}

/**
 * Make a string safe for use in file paths
 * Replaces special characters with hyphens and lowercases
 */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
}
