import { ASSISTANT_AGENT_IDS, ASSISTANT_AGENT_DESCRIPTIONS, ASSISTANT_AGENT_LABELS, type AssistantAgentId } from "../../sane-core/src/agent-catalog.ts"

export type SaneAgentKind = "assistant" | "worker"

/** CC permission profile derived from the OC permission block. */
export interface CcPermissions {
  allow: string[]
  ask: string[]
}

/** Harness-neutral view of one SANE agent file. OC stays the source of body text. */
export interface SaneAgentSpec {
  /** OC path-derived name, e.g. `sane/assistant/design`. */
  name: string
  kind: SaneAgentKind
  /** Short id, e.g. `design` or `sane/worker/scout`. Assistants use the bare slot. */
  shortId: string
  description: string
  temperature?: number
  body: string
  ccPermissions: CcPermissions
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function splitFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(content)
  if (!match || match.index !== 0) throw new Error("Agent must have YAML frontmatter.")
  const metadata: unknown = Bun.YAML.parse(match[2]!)
  if (!isMapping(metadata)) throw new Error("Agent frontmatter must be a YAML mapping.")
  return { metadata, body: content.slice(match[0].length) }
}

/** Parse an OC agent file into the canonical spec. Body text is preserved verbatim. */
export function parseSaneAgent(content: string, agentName: string): SaneAgentSpec {
  let parsed: { metadata: Record<string, unknown>; body: string }
  try {
    parsed = splitFrontmatter(content)
  } catch (error) {
    throw new Error(`Agent ${agentName} ${(error as Error).message.charAt(0).toLowerCase()}${(error as Error).message.slice(1)}`)
  }
  const { metadata, body } = parsed
  const kind: SaneAgentKind = agentName.startsWith("sane/assistant/") ? "assistant" : "worker"
  const shortId = kind === "assistant" ? agentName.slice("sane/assistant/".length) : agentName
  const description = typeof metadata.description === "string" ? metadata.description : ""
  const temperature = typeof metadata.temperature === "number" ? metadata.temperature : undefined
  return { name: agentName, kind, shortId, description, ...(temperature === undefined ? {} : { temperature }), body, ccPermissions: deriveCcPermissions(metadata) }
}

/**
 * Translate an OC permission block to a CC permission profile.
 * Mapping: read→Read, glob→Glob, grep→Grep, edit→Edit+Write, bash/shell→Bash,
 * ask/question→AskUserQuestion, skill→Skill, task/subagent entries→Agent(name).
 * `list` is covered by Glob; `external_directory` has no CC equivalent.
 * Deny rules are intentionally dropped: CC evaluates deny with precedence, so
 * a deny would also block the specifically named workers.
 */
function deriveCcPermissions(metadata: Record<string, unknown>): CcPermissions {
  const allow: string[] = []
  const ask: string[] = []
  const push = (list: string[], ...tools: string[]) => {
    for (const tool of tools) if (!allow.includes(tool) && !ask.includes(tool) && !list.includes(tool)) list.push(tool)
  }
  const applyDecision = (ccTools: string[], decision: unknown) => {
    if (decision === "allow") push(allow, ...ccTools)
    else if (decision === "ask") push(ask, ...ccTools)
  }
  const TOOL_MAP: Record<string, string[]> = {
    ask: ["AskUserQuestion"],
    question: ["AskUserQuestion"],
    read: ["Read"],
    glob: ["Glob"],
    grep: ["Grep"],
    edit: ["Edit", "Write"],
    bash: ["Bash"],
    shell: ["Bash"],
    skill: ["Skill"],
  }
  const permission = metadata.permission
  if (isMapping(permission)) {
    for (const [tool, decision] of Object.entries(permission)) {
      if (tool === "task") continue
      if (tool === "list" || tool === "external_directory") continue
      const ccTools = TOOL_MAP[tool]
      if (ccTools) applyDecision(ccTools, decision)
    }
    const task = permission.task
    if (isMapping(task)) {
      for (const [worker, decision] of Object.entries(task)) {
        if (worker === "*") continue
        applyDecision([`Agent(${ccAgentName(worker)})`], decision)
      }
    }
  }
  const permissions = metadata.permissions
  if (Array.isArray(permissions)) {
    for (const rule of permissions) {
      if (!isMapping(rule) || rule.resource !== "*" || rule.action === "subagent") continue
      const ccTools = typeof rule.action === "string" ? TOOL_MAP[rule.action] : undefined
      if (ccTools) applyDecision(ccTools, rule.effect)
    }
    for (const rule of permissions) {
      if (!isMapping(rule) || rule.action !== "subagent" || typeof rule.resource !== "string" || rule.resource === "*") continue
      applyDecision([`Agent(${ccAgentName(rule.resource)})`], rule.effect)
    }
  }
  return { allow, ask }
}

/**
 * Serialize the CC settings profile for one agent. Only allow/ask are
 * emitted; deny is never emitted (precedence trap, see above).
 */
export function serializeCcSettings(spec: SaneAgentSpec): string {
  const permissions: Record<string, string[]> = {}
  if (spec.ccPermissions.allow.length) permissions.allow = spec.ccPermissions.allow
  if (spec.ccPermissions.ask.length) permissions.ask = spec.ccPermissions.ask
  return `${JSON.stringify({ permissions }, null, 2)}\n`
}

/**
 * OC serialization: the OC file is the canonical body carrier, so this is the
 * validated original content (model injection applied separately). Kept as an
 * explicit serializer so OC and CC share one parse path.
 */
export function serializeOcAgent(originalContent: string, _spec: SaneAgentSpec): string {
  return originalContent
}

/** CC agent file name for global install: `sane/assistant/design` -> `sane-assistant-design.md`. */
export function ccAgentFilename(agentName: string): string {
  return `${agentName.replaceAll("/", "-")}.md`
}

/** CC subagent name: must be lowercase alphanumeric + hyphens. */
export function ccAgentName(agentName: string): string {
  return agentName.replaceAll("/", "-").toLowerCase()
}

/**
 * CC serialization (global `~/.claude/agents/`). Per product decision CC agents
 * keep all permissions: no `tools` restriction is emitted, so every tool stays
 * available. Only name + description + body are serialized.
 */
export function serializeCcAgent(spec: SaneAgentSpec): string {
  const name = ccAgentName(spec.name)
  const description = spec.description || spec.shortId
  const header = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n`
  const body = spec.body.startsWith("\n") ? spec.body.slice(1) : spec.body
  return `${header}\n${body}`
}

/** Picker choices: assistants only. */
export interface AssistantAgentChoice {
  id: AssistantAgentId
  label: string
  description: string
}

export function assistantAgentChoices(): AssistantAgentChoice[] {
  return ASSISTANT_AGENT_IDS.map((id) => ({
    id,
    label: ASSISTANT_AGENT_LABELS[id]!,
    description: ASSISTANT_AGENT_DESCRIPTIONS[id]!,
  }))
}
