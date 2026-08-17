import { describe, expect, test } from "bun:test"
import {
  isValidCursorModel,
  isValidOpenCodeModel,
  resolveModelSpec,
} from "../src/lib/model.ts"
import { getAgentModels, parseAgentsYaml } from "../src/lib/agents-yaml.ts"

describe("model/runtime normalization", () => {
  test("defaults omitted runtime to OpenCode", () => {
    expect(resolveModelSpec("anthropic/claude-sonnet-4")).toEqual({
      model: "anthropic/claude-sonnet-4",
      runtime: "opencode",
    })
  })

  test("uses execution.defaultRuntime for omitted model runtimes", () => {
    const parsed = parseAgentsYaml(`execution:
  defaultRuntime: cursor
agents:
  - name: cursor-agent
    description: Cursor worker
    best_for: Cursor tasks
    models:
      - auto
      - { model: composer-1, variant: fast }
`)

    expect(parsed.errors).toEqual([])
    expect(parsed.config?.execution?.defaultRuntime).toBe("cursor")
    expect(getAgentModels(parsed.config!, "cursor-agent")).toEqual([
      { model: "auto", runtime: "cursor" },
      { model: "composer-1", variant: "fast", runtime: "cursor" },
    ])
  })

  test("resolves explicit string runtime suffixes", () => {
    expect(resolveModelSpec("auto@cursor")).toEqual({
      model: "auto",
      runtime: "cursor",
    })
    expect(resolveModelSpec("anthropic/claude-sonnet-4@opencode")).toEqual({
      model: "anthropic/claude-sonnet-4",
      runtime: "opencode",
    })
    expect(resolveModelSpec({ model: "auto", variant: "fast", runtime: "cursor" })).toEqual({
      model: "auto",
      variant: "fast",
      runtime: "cursor",
    })
  })

  test("rejects unknown and empty runtime suffixes", () => {
    expect(() => resolveModelSpec("auto@unknown")).toThrow(/Unknown model runtime/)
    expect(() => resolveModelSpec("auto@")).toThrow(/empty runtime/)
  })

  test("rejects structured model suffixes but lets an explicit override win", () => {
    expect(() => resolveModelSpec({ model: "auto@cursor" })).toThrow(
      /must not contain a runtime suffix/,
    )
    expect(
      resolveModelSpec(
        { model: "openai/gpt-5", runtime: "cursor" },
        { runtime: "opencode" },
      ),
    ).toEqual({ model: "openai/gpt-5", runtime: "opencode" })
  })

  test("validates Cursor model rules without requiring a slash", () => {
    expect(isValidCursorModel("auto")).toBe(true)
    expect(isValidCursorModel("composer-1")).toBe(true)
    expect(isValidCursorModel("cursor/model")).toBe(false)
    expect(isValidCursorModel("")).toBe(false)
    expect(isValidCursorModel("   ")).toBe(false)
    expect(() => resolveModelSpec("cursor/model", { runtime: "cursor" })).toThrow(
      /Cursor model/,
    )
  })

  test("validates OpenCode provider/model rules", () => {
    expect(isValidOpenCodeModel("anthropic/claude-sonnet-4")).toBe(true)
    expect(isValidOpenCodeModel("/claude-sonnet-4")).toBe(false)
    expect(isValidOpenCodeModel("anthropic/")).toBe(false)
    expect(isValidOpenCodeModel("anthropic//model")).toBe(false)
    expect(() => resolveModelSpec("claude-sonnet-4")).toThrow(/OpenCode models/)
  })

  test("supports explicit CLI/runtime overrides", () => {
    expect(resolveModelSpec("auto", { runtimeOverride: "cursor" })).toEqual({
      model: "auto",
      runtime: "cursor",
    })
    expect(resolveModelSpec("gpt-5@opencode", { runtimeOverride: "cursor" })).toEqual({
      model: "gpt-5",
      runtime: "cursor",
    })
    expect(() =>
      resolveModelSpec("openai/gpt-5@opencode", { runtimeOverride: "cursor" }),
    ).toThrow(/Cursor model/)
    expect(
      getAgentModels(
        {
          agents: [
            {
              name: "worker",
              description: "worker",
              best_for: "tests",
              models: ["auto"],
            },
          ],
        },
        "worker",
        { runtime: "cursor" },
      ),
    ).toEqual([{ model: "auto", runtime: "cursor" }])
    expect(
      getAgentModels(
        {
          agents: [
            {
              name: "forced-worker",
              description: "worker",
              best_for: "tests",
              models: ["gpt-5@opencode", { model: "composer-1", runtime: "opencode" }],
            },
          ],
        },
        "forced-worker",
        { runtimeOverride: "cursor" },
      ),
    ).toEqual([
      { model: "gpt-5", runtime: "cursor" },
      { model: "composer-1", runtime: "cursor" },
    ])
  })
})
