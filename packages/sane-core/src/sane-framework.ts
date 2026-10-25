import { readFileSync } from "node:fs"
import type { StoredSaneAgentIdentity } from "./agent-catalog.ts"
import { parseContextMarkdown } from "./context-markdown.ts"

const FRAMEWORK_FILES = {
  core: "core.md",
  assistant: "assistant.md",
  "assignment-discipline": "worker-assignment-discipline.md",
  "worker-protocol": "worker-protocol.md",
  "branch-continuation": "branch-continuation.md",
} as const
export type FrameworkName = keyof typeof FRAMEWORK_FILES

export function frameworkSource(name: FrameworkName): string {
  if (!Object.hasOwn(FRAMEWORK_FILES, name)) throw new Error("Unknown framework context fragment")
  return `context/framework/${FRAMEWORK_FILES[name]}`
}

export function readFramework(name: FrameworkName) {
  const source = frameworkSource(name)
  const parsed = parseContextMarkdown(readFileSync(new URL(`../../../${source}`, import.meta.url), "utf8"))
  if (!parsed.body.trim()) throw new Error(`Empty framework context: ${source}`)
  return { source, text: parsed.body.trimEnd(), description: parsed.description }
}

export function standingFrameworkNames(identity: StoredSaneAgentIdentity): FrameworkName[] {
  if (identity.kind === "utility") return []
  const names: FrameworkName[] = ["core"]
  if (identity.kind === "assistant") {
    names.push("assistant")
    if (identity.role === "planning" || identity.role === "execution") names.push("assignment-discipline")
  }
  return names
}

export function frameworkNames(identity: StoredSaneAgentIdentity): FrameworkName[] {
  if (identity.kind === "utility") return []
  return [...standingFrameworkNames(identity), "branch-continuation", ...(identity.kind === "worker" ? ["worker-protocol" as const] : [])]
}
