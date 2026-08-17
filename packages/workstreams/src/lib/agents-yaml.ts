/**
 * agents.yaml parser and manager
 *
 * Handles the agents.yaml configuration file at work/agents.yaml
 * which defines available agents with their descriptions and models.
 *
 * Supports multiple models per agent with optional variants for retry logic.
 * Agent assignments are stored in canonical execution item metadata.
 *
 * ## Schema
 *
 * The agents.yaml file supports one main section:
 *
 * 1. `agents`: List of working agents (perform tasks)
 *
 * Example configuration:
 *
 * ```yaml
 * agents:
 *   - name: "full-stack"
 *     description: "General purpose developer"
 *     best_for: "features, bugs, refactoring"
 *     models:
 *       - model: "claude-3-5-sonnet-20241022"
 *       - model: "gpt-4o"
 *         variant: "retry"
 * ```
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type {
    AgentsConfigYaml,
    AgentDefinitionYaml,
    ExecutionConfigYaml,
    ModelSpec,
    NormalizedModelSpec,
    ResolvedModelSpec,
} from "./types.ts"
import { getWorkDir } from "./repo.ts"
import { resolveModelSpec } from "./model.ts"
import type { ModelResolutionOptions } from "./model.ts"

/**
 * Get the agents.yaml file path
 */
export function getAgentsYamlPath(repoRoot: string): string {
    return join(getWorkDir(repoRoot), "agents.yaml")
}

/**
 * Normalize a ModelSpec to always have object form
 */
export function normalizeModelSpec(spec: ModelSpec): NormalizedModelSpec {
    if (typeof spec === "string") {
        return { model: spec }
    }
    return {
        model: spec.model,
        ...(spec.variant === undefined ? {} : { variant: spec.variant }),
        ...(spec.runtime === undefined ? {} : { runtime: spec.runtime }),
    }
}

/**
 * Parse agents.yaml content to extract AgentsConfigYaml
 *
 * Validates the YAML structure and ensures all required fields are present.
 *
 * @param content - Raw YAML string content
 * @returns Object containing the parsed config (if successful) and any validation errors
 */
export function parseAgentsYaml(content: string): {
    config: AgentsConfigYaml | null
    errors: string[]
} {
    const errors: string[] = []

    try {
        const parsed = parseYaml(content)

        if (!parsed || typeof parsed !== "object") {
            errors.push("Invalid YAML: expected object at root")
            return { config: null, errors }
        }

        if (!Array.isArray(parsed.agents)) {
            errors.push("Invalid YAML: expected 'agents' array at root")
            return { config: null, errors }
        }

        let execution: ExecutionConfigYaml | undefined
        if (parsed.execution !== undefined) {
            if (!parsed.execution || typeof parsed.execution !== "object" || Array.isArray(parsed.execution)) {
                errors.push("Invalid YAML: expected 'execution' to be an object")
            } else if (parsed.execution.defaultRuntime !== undefined) {
                try {
                    // Validate the configured runtime through the same
                    // AgENV-owned path used for model references.
                    resolveModelSpec(parsed.execution.defaultRuntime === "cursor" ? "auto" : "provider/model", {
                        defaultRuntime: parsed.execution.defaultRuntime,
                    })
                    execution = { defaultRuntime: parsed.execution.defaultRuntime }
                } catch (error) {
                    errors.push(
                        `Invalid execution.defaultRuntime: ${error instanceof Error ? error.message : String(error)}`,
                    )
                }
            } else {
                execution = {}
            }
        }

        const agents: AgentDefinitionYaml[] = []

        for (let i = 0; i < parsed.agents.length; i++) {
            const agent = parsed.agents[i]
            const prefix = `Agent ${i + 1}`

            if (!agent || typeof agent !== "object") {
                errors.push(`${prefix}: expected object`)
                continue
            }

            if (!agent.name || typeof agent.name !== "string") {
                errors.push(`${prefix}: missing or invalid 'name'`)
                continue
            }

            if (!agent.description || typeof agent.description !== "string") {
                errors.push(`Agent "${agent.name}": missing or invalid 'description'`)
                continue
            }

            if (!agent.best_for || typeof agent.best_for !== "string") {
                errors.push(`Agent "${agent.name}": missing or invalid 'best_for'`)
                continue
            }

            if (!Array.isArray(agent.models) || agent.models.length === 0) {
                errors.push(`Agent "${agent.name}": 'models' must be a non-empty array`)
                continue
            }

            // Validate each model through the runtime-aware resolver. Retain
            // the original syntax in the parsed config so legacy callers
            // still receive strings/objects rather than a forced OpenCode
            // representation.
            const validModels: ModelSpec[] = []
            for (let j = 0; j < agent.models.length; j++) {
                const model = agent.models[j]
                let modelSpec: ModelSpec

                if (typeof model === "string") {
                    modelSpec = model
                } else if (model && typeof model === "object" && model.model) {
                    modelSpec = {
                        model: model.model,
                        ...(model.variant === undefined ? {} : { variant: model.variant }),
                        ...(model.runtime === undefined ? {} : { runtime: model.runtime }),
                    } as ModelSpec
                } else {
                    errors.push(
                        `Agent "${agent.name}": model ${j + 1} must be a string or object with 'model' field`
                    )
                    continue
                }

                try {
                    resolveModelSpec(modelSpec, {
                        defaultRuntime: execution?.defaultRuntime,
                    })
                    validModels.push(modelSpec)
                } catch (error) {
                    errors.push(
                        `Agent "${agent.name}": model ${j + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (validModels.length === 0) {
                errors.push(`Agent "${agent.name}": no valid models found`)
                continue
            }

            agents.push({
                name: agent.name,
                description: agent.description,
                best_for: agent.best_for,
                models: validModels,
            })
        }

        return {
            config: {
                agents,
                ...(execution === undefined ? {} : { execution }),
            },
            errors,
        }
    } catch (e) {
        errors.push(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`)
        return { config: null, errors }
    }
}

/**
 * Generate agents.yaml content from AgentsConfigYaml
 */
export function generateAgentsYaml(config: AgentsConfigYaml): string {
    return stringifyYaml(config, {
        indent: 2,
        lineWidth: 120,
    })
}

/**
 * Load AgentsConfigYaml from work/agents.yaml
 * Returns null if the file doesn't exist
 */
export function loadAgentsConfig(repoRoot: string): AgentsConfigYaml | null {
    const path = getAgentsYamlPath(repoRoot)
    if (!existsSync(path)) {
        return null
    }

    const content = readFileSync(path, "utf-8")
    const { config, errors } = parseAgentsYaml(content)

    if (errors.length > 0) {
        console.warn("Warnings parsing agents.yaml:", errors.join(", "))
    }

    return config
}

/**
 * Save AgentsConfigYaml to work/agents.yaml
 */
export function saveAgentsConfigYaml(
    repoRoot: string,
    config: AgentsConfigYaml
): void {
    const path = getAgentsYamlPath(repoRoot)
    const dir = dirname(path)

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    const content = generateAgentsYaml(config)
    writeFileSync(path, content, "utf-8")
}

/**
 * List all available agents from YAML config
 */
export function listAgentsYaml(config: AgentsConfigYaml): AgentDefinitionYaml[] {
    return config.agents
}

/**
 * Get an agent by name from YAML config
 */
export function getAgentYaml(
    config: AgentsConfigYaml,
    name: string
): AgentDefinitionYaml | null {
    return config.agents.find((a) => a.name === name) || null
}

/**
 * Get all models for an agent as normalized specs
 */
export function getAgentModels(
    config: AgentsConfigYaml,
    agentName: string,
    options: ModelResolutionOptions = {},
): ResolvedModelSpec[] {
    const agent = getAgentYaml(config, agentName)
    if (!agent) {
        return []
    }
    return agent.models.map((spec) =>
        resolveModelSpec(spec, {
            ...options,
            defaultRuntime: options.defaultRuntime ?? config.execution?.defaultRuntime,
        }),
    )
}

/**
 * Get the primary (first) model for an agent
 * Returns null if agent not found or has no models
 */
export function getPrimaryModel(
    config: AgentsConfigYaml,
    agentName: string,
    options: ModelResolutionOptions = {},
): ResolvedModelSpec | null {
    const models = getAgentModels(config, agentName, options)
    return models.length > 0 ? models[0]! : null
}
