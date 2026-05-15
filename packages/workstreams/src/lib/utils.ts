/**
 * Shared utility functions for workstream management
 */

import type { ExecutionStatus, StageStatus } from "./types.ts"

/**
 * Item that can be resolved by name or index
 */
export interface NamedItem {
  id: number
  name: string
}

/**
 * Resolve a name or index to a stage/batch/thread definition
 * Supports:
 * - Numeric index (1, 2, 3...)
 * - Exact name match (case-insensitive)
 * - Partial name match (case-insensitive)
 *
 * @param input - The user input (number or name string)
 * @param items - Array of items to search
 * @param itemType - Type name for error messages (e.g., "stage", "batch", "thread")
 * @returns The matched item
 * @throws Error if no match found or input is ambiguous
 */
export function resolveByNameOrIndex<T extends NamedItem>(
  input: string,
  items: T[],
  itemType: string,
): T {
  const trimmed = input.trim()

  // Try numeric index first
  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && num >= 1) {
    const item = items.find((i) => i.id === num)
    if (item) return item
    throw new Error(
      `${itemType} ${num} not found. Available: ${items.map((i) => i.id).join(", ")}`,
    )
  }

  // Try exact name match (case-insensitive)
  const lowerInput = trimmed.toLowerCase()
  const exactMatch = items.find((i) => i.name.toLowerCase() === lowerInput)
  if (exactMatch) return exactMatch

  // Try partial name match (case-insensitive)
  const partialMatches = items.filter((i) =>
    i.name.toLowerCase().includes(lowerInput),
  )

  if (partialMatches.length === 1) {
    return partialMatches[0]!
  }

  if (partialMatches.length > 1) {
    throw new Error(
      `Ambiguous ${itemType} name "${trimmed}". Matches: ${partialMatches.map((i) => `"${i.name}"`).join(", ")}`,
    )
  }

  // No match found
  const availableNames = items.map((i) => `${i.id}: "${i.name}"`).join(", ")
  throw new Error(
    `${itemType} "${trimmed}" not found. Available: ${availableNames}`,
  )
}

/**
 * Parse a stage/batch/thread argument that can be a number or name
 * Returns { isNumeric: true, value: number } or { isNumeric: false, value: string }
 */
export function parseNameOrIndex(input: string): {
  isNumeric: boolean
  numericValue?: number
  stringValue: string
} {
  const trimmed = input.trim()
  const num = parseInt(trimmed, 10)

  if (!isNaN(num) && num >= 1 && String(num) === trimmed) {
    return { isNumeric: true, numericValue: num, stringValue: trimmed }
  }

  return { isNumeric: false, stringValue: trimmed }
}

/**
 * Convert kebab-case to Title Case
 */
export function toTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * Get current date in YYYY-MM-DD format
 */
export function getDateString(): string {
  return new Date().toISOString().split("T")[0] ?? ""
}

/**
 * Validate stream name is kebab-case
 */
export function validateStreamName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

/**
 * Parse a positive integer from string
 */
export function parsePositiveInt(value: string, name: string): number {
  const num = parseInt(value, 10)
  if (isNaN(num) || num < 1) {
    throw new Error(`${name} must be a positive integer. Got: "${value}"`)
  }
  return num
}

/**
 * Convert status to markdown checkbox
 */
export function statusToCheckbox(status: ExecutionStatus): string {
  switch (status) {
    case "completed":
      return "[x]"
    case "in_progress":
      return "[~]"
    case "blocked":
      return "[!]"
    case "cancelled":
      return "[-]"
    default:
      return "[ ]"
  }
}

/**
 * Parse task status from markdown checkbox
 */
export function parseExecutionStatus(line: string): ExecutionStatus {
  if (line.includes("[x]") || line.includes("[X]")) return "completed"
  if (line.includes("[~]")) return "in_progress"
  if (line.includes("[!]")) return "blocked"
  if (line.includes("[-]")) return "cancelled"
  return "pending"
}

/**
 * Parse stage status from status text
 */
export function parseStageStatus(statusText: string): StageStatus {
  const lower = statusText.toLowerCase()
  if (lower.includes("complete") || lower.includes("✅")) return "complete"
  if (lower.includes("progress") || lower.includes("🔄")) return "in_progress"
  if (lower.includes("blocked") || lower.includes("⚠️")) return "blocked"
  return "pending"
}

/**
 * Set a nested field value using dot notation
 */
export function setNestedField(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".")
  let current: Record<string, unknown> = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!part) continue
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  const lastPart = parts[parts.length - 1]
  if (!lastPart) return
  current[lastPart] = value
}

/**
 * Get a nested field value using dot notation
 */
export function getNestedField(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".")
  let current: unknown = obj

  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

/**
 * Parse value string to appropriate type (for CLI inputs)
 */
export function parseValue(value: string): unknown {
  // Boolean
  if (value === "true") return true
  if (value === "false") return false

  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)

  // JSON
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value)
    } catch {
      // Fall through to string
    }
  }

  // String
  return value
}
