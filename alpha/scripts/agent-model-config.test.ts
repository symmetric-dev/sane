import { describe, expect, test } from "bun:test"
import { injectAgentModel, loadAgentModelConfig, parseAgentModelConfig } from "./agent-model-config.ts"
import { AGENT_FILENAMES } from "./install-sane-agent-context-packages.ts"

describe("agent model YAML config", () => {
  test("supports comments, quoted values, empty mappings and every known agent", () => {
    const yaml = AGENT_FILENAMES.map((name) => `${name.slice(0, -3)}: 'openai/gpt-5' # model`).join("\n")
    expect(parseAgentModelConfig(yaml, AGENT_FILENAMES).size).toBe(11)
    expect(parseAgentModelConfig("{}", AGENT_FILENAMES).size).toBe(0)
  })

  test.each(["", "null", "[]", "hello", "unknown: openai/gpt-5", "sane-worker-scout.md: openai/gpt-5", ...[
    "null", "123", "{}", "[]", "''", "model", "'/model'", "'provider/'", "'provider/model name'",
  ].map((value) => `sane-worker-scout: ${value}`), "sane-worker-scout: ["])("rejects invalid config: %s", (yaml) => {
    expect(() => parseAgentModelConfig(yaml, AGENT_FILENAMES)).toThrow()
  })

  test("reports config read errors with the path", async () => {
    await expect(loadAgentModelConfig("/nonexistent/sane-models.yaml", AGENT_FILENAMES)).rejects.toThrow("/nonexistent/sane-models.yaml")
  })

  test.each(["\n", "\r\n"])("replaces existing model, preserving metadata values and exact body (%j)", (newline) => {
    const body = "\n# Body\r\nmodel: leave body alone\n---\n"
    const source = ["---", "description: |", "  Long description", "'model': >-", "  old/model", "permission:", "  edit: deny", "  model: nested/value", "---", ""].join(newline) + body
    const model = 'provider/a"b\\c:#'
    const result = injectAgentModel(source, model)
    const header = result.split(/\r?\n---/)[0]!.replace(/^---\r?\n/, "")
    expect(Bun.YAML.parse(header)).toEqual({ description: "Long description\n", permission: { edit: "deny", model: "nested/value" }, model })
    expect(result.endsWith(body)).toBe(true)
    expect(result.match(/^model:/gm)).toHaveLength(2) // one header, one untouched body
    expect(injectAgentModel(result, model)).toBe(result)
  })

  test("injects absent models and leaves unmapped content byte-identical", () => {
    expect(injectAgentModel("---\nmode: primary\n---\nBody", "openai/gpt-5")).toContain('model: "openai/gpt-5"\n---\nBody')
    expect(injectAgentModel("arbitrary\r\nbytes")).toBe("arbitrary\r\nbytes")
    expect(() => injectAgentModel("no header", "openai/gpt-5")).toThrow("frontmatter")
    expect(() => injectAgentModel("---\n[]\n---\n", "openai/gpt-5")).toThrow("mapping")
  })
})
