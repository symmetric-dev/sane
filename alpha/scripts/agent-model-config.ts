import { readFile } from "node:fs/promises"

export type AgentModelConfig = ReadonlyMap<string, string>

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function validateModel(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[^\s/\x00-\x1f\x7f]+\/[^\s\x00-\x1f\x7f]+$/.test(value)) {
    throw new Error("Expected a nonempty provider/model string without whitespace.")
  }
}

/** Parse a flat YAML mapping using the installer's source manifest as authority. */
export function parseAgentModelConfig(yaml: string, agentFilenames: readonly string[]): AgentModelConfig {
  const parsed: unknown = Bun.YAML.parse(yaml)
  if (!isMapping(parsed)) throw new Error("Model config must be a flat YAML mapping.")
  const knownNames = new Set(agentFilenames.map((filename) => filename.replace(/\.md$/, "")))
  const models = new Map<string, string>()
  for (const [name, model] of Object.entries(parsed)) {
    if (!knownNames.has(name)) throw new Error(`Unknown agent in model config: ${name}`)
    try {
      validateModel(model)
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

/** Only mapped agents are transformed. The Markdown body is never reserialized. */
export function injectAgentModel(content: string, model?: string): string {
  if (model === undefined) return content
  validateModel(model)
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(content)
  if (!match || match.index !== 0) throw new Error("Mapped agent must have YAML frontmatter.")
  const metadata: unknown = Bun.YAML.parse(match[2]!)
  if (!isMapping(metadata)) throw new Error("Agent frontmatter must be a YAML mapping.")
  // Reserializing the mapping handles quoted keys, multiline values and existing
  // model fields without accidentally changing nested fields or creating duplicates.
  delete metadata.model
  const newline = match[1]!.endsWith("\r\n") ? "\r\n" : "\n"
  const header = Bun.YAML.stringify(metadata, null, 2).trimEnd().replace(/\r?\n/g, newline)
  // JSON string quoting is also valid YAML and prevents scalar interpretation.
  return match[1] + (header === "{}" || !header ? "" : header + newline)
    + `model: ${JSON.stringify(model)}` + newline + match[3]
    + content.slice(match[0].length)
}
