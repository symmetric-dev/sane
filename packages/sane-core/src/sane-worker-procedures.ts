import { readFileSync } from "node:fs"
import { isWorkerAgentId, type WorkerAgentId } from "./agent-catalog.ts"
import { parseContextMarkdown } from "./context-markdown.ts"

export function workerProcedureSource(role: WorkerAgentId): string {
  if (!isWorkerAgentId(role)) throw new Error("Unknown worker procedure role")
  return `context/worker-procedures/${role}.md`
}

/** Unpinned launches read authored files; canonical launches use their reserved package bytes. */
export function readWorkerProcedure(role: WorkerAgentId): string {
  const source = workerProcedureSource(role)
  const { body: text } = parseContextMarkdown(readFileSync(new URL(`../../../${source}`, import.meta.url), "utf8"), false)
  if (!text.trim()) throw new Error(`Empty worker procedure: ${source}`)
  return text
}
