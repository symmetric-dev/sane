import { readFile } from "node:fs/promises"

export type AgentModelOverride = string | { readonly model: string; readonly variant?: string }
export type AgentModelConfig = ReadonlyMap<string, AgentModelOverride>

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function validateModel(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[^\s/\x00-\x1f\x7f]+\/[^\s\x00-\x1f\x7f]+$/.test(value)) {
    throw new Error("Expected a nonempty provider/model string without whitespace.")
  }
}

function validateOverride(value: unknown): asserts value is AgentModelOverride {
  if (typeof value === "string") {
    validateModel(value)
    return
  }
  if (!isMapping(value)) throw new Error("Expected a model string or an object with model and optional variant.")
  for (const key of Object.keys(value)) {
    if (key !== "model" && key !== "variant") throw new Error(`Unknown model config field: ${key}`)
  }
  validateModel(value.model)
  if (Object.hasOwn(value, "variant") && (typeof value.variant !== "string" || !value.variant.trim())) {
    throw new Error("Expected variant to be a nonempty string.")
  }
}

/** Parse agent overrides using the installer's source manifest as authority. */
export function parseAgentModelConfig(yaml: string, agentFilenames: readonly string[]): AgentModelConfig {
  const parsed: unknown = Bun.YAML.parse(yaml)
  if (!isMapping(parsed)) throw new Error("Model config must be a YAML mapping of agent names to overrides.")
  const knownNames = new Set(agentFilenames.map((filename) => filename.replace(/\.md$/, "")))
  const models = new Map<string, AgentModelOverride>()
  for (const [name, model] of Object.entries(parsed)) {
    if (!knownNames.has(name)) throw new Error(`Unknown agent in model config: ${name}`)
    try {
      validateOverride(model)
    } catch (error) {
      throw new Error(`Invalid model for ${name}: ${(error as Error).message}`)
    }
    models.set(name, model)
  }
  return models
}

export async function loadAgentModelConfig(path: string, agentFilenames: readonly string[]): Promise<AgentModelConfig> {
  try {
    return parseAgentModelConfig(await readFile(path, "utf8"), agentFilenames)
  } catch (error) {
    throw new Error(`Could not load model config ${path}: ${(error as Error).message}`)
  }
}

const TASK_PERMISSION_DECISIONS = new Set(["allow", "ask", "deny"])

/**
 * Validate an agent's `permission.task` block using the installer's source
 * manifest as authority. Only structural rules are checked: frontmatter must
 * exist and be a mapping, every task key must be "*" or a known agent name,
 * and every decision must be allow, ask, or deny. Prose is never inspected.
 */
export function validateAgentTaskPermissions(
  content: string,
  agentName: string,
  agentFilenames: readonly string[],
): void {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(content)
  if (!match || match.index !== 0) throw new Error(`Agent ${agentName} must have YAML frontmatter.`)
  const metadata: unknown = Bun.YAML.parse(match[2]!)
  if (!isMapping(metadata)) throw new Error(`Agent ${agentName} frontmatter must be a YAML mapping.`)
  const permission = metadata.permission
  if (permission === undefined) return
  if (!isMapping(permission)) throw new Error(`Agent ${agentName} permission must be a YAML mapping.`)
  const task = permission.task
  if (task === undefined) return
  if (typeof task === "string") {
    validateTaskDecision(agentName, "*", task)
    return
  }
  if (!isMapping(task)) {
    throw new Error(`Agent ${agentName} task permissions must be deny or a mapping of agent names to decisions.`)
  }
  const knownNames = new Set(agentFilenames.map((filename) => filename.replace(/\.md$/, "")))
  for (const [key, decision] of Object.entries(task)) {
    if (key !== "*" && !knownNames.has(key)) {
      throw new Error(`Unknown agent in ${agentName} task permissions: ${key}`)
    }
    validateTaskDecision(agentName, key, decision)
  }
}

function validateTaskDecision(agentName: string, key: string, decision: unknown): void {
  if (typeof decision !== "string" || !TASK_PERMISSION_DECISIONS.has(decision)) {
    throw new Error(
      `Invalid decision for ${key} in ${agentName} task permissions: expected allow, ask, or deny.`,
    )
  }
}

/** Only mapped agents are transformed. The Markdown body is never reserialized. */
export function injectAgentModel(content: string, override?: AgentModelOverride): string {
  if (override === undefined) return content
  validateOverride(override)
  const { model, variant } = typeof override === "string" ? { model: override } : override
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(content)
  if (!match || match.index !== 0) throw new Error("Mapped agent must have YAML frontmatter.")
  const metadata: unknown = Bun.YAML.parse(match[2]!)
  if (!isMapping(metadata)) throw new Error("Agent frontmatter must be a YAML mapping.")
  // Reserializing the mapping handles quoted keys, multiline values and existing
  // model fields without accidentally changing nested fields or creating duplicates.
  delete metadata.model
  if (variant !== undefined) delete metadata.variant
  const newline = match[1]!.endsWith("\r\n") ? "\r\n" : "\n"
  const header = Bun.YAML.stringify(metadata, null, 2).trimEnd().replace(/\r?\n/g, newline)
  // JSON string quoting is also valid YAML and prevents scalar interpretation.
  return match[1] + (header === "{}" || !header ? "" : header + newline)
    + `model: ${JSON.stringify(model)}` + newline
    + (variant === undefined ? "" : `variant: ${JSON.stringify(variant)}` + newline) + match[3]
    + content.slice(match[0].length)
}
