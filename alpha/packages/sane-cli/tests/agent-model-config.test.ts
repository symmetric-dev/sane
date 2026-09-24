import { describe, expect, test } from "bun:test"
import { injectAgentModel, loadAgentModelConfig, parseAgentModelConfig } from "../src/agent-model-config.ts"
import { AGENT_FILENAMES } from "../src/install-sane-agent-context-packages.ts"

describe("agent model YAML config", () => {
  test("supports comments, quoted values, empty mappings and every known agent", () => {
    const yaml = AGENT_FILENAMES.map((name) => `${name.slice(0, -3)}: 'openai/gpt-5' # model`).join("\n")
    const config = parseAgentModelConfig(yaml, AGENT_FILENAMES)
    for (const name of AGENT_FILENAMES) expect(config.get(name.slice(0, -3))).toBe("openai/gpt-5")
    expect(parseAgentModelConfig("{}", AGENT_FILENAMES).size).toBe(0)
  })

  test.each(["", "null", "[]", "hello", "unknown: openai/gpt-5", "sane/worker/scout.md: openai/gpt-5", ...[
    "null", "123", "{}", "[]", "''", "model", "'/model'", "'provider/'", "'provider/model name'",
  ].map((value) => `sane/worker/scout: ${value}`), "sane/worker/scout: ["])("rejects invalid config: %s", (yaml) => {
    expect(() => parseAgentModelConfig(yaml, AGENT_FILENAMES)).toThrow()
  })

  test("reports config read errors with the path", async () => {
    await expect(loadAgentModelConfig("/nonexistent/sane-models.yaml", AGENT_FILENAMES)).rejects.toThrow("/nonexistent/sane-models.yaml")
  })

  test("supports mixed shorthand, flow and block objects", () => {
    const config = parseAgentModelConfig(`
sane/worker/scout: openai/gpt-5
sane/assistant/execution: { model: "openai/gpt-6-astra", variant: low }
sane/assistant/engineering:
  model: openai/gpt-6-astra
  variant: high
sane/worker/fixer: { model: openai/gpt-5 }
`, AGENT_FILENAMES)
    expect(config.get("sane/worker/scout")).toBe("openai/gpt-5")
    expect(config.get("sane/assistant/execution")).toEqual({ model: "openai/gpt-6-astra", variant: "low" })
    expect(config.get("sane/assistant/engineering")).toEqual({ model: "openai/gpt-6-astra", variant: "high" })
    expect(config.get("sane/worker/fixer")).toEqual({ model: "openai/gpt-5" })
  })

  test.each([
    "{ variant: low }", "{ model: null }", "{ model: 123 }", "{ model: [] }",
    "{ model: {} }", "{ model: invalid }", "{ model: 'provider/model name' }",
    ...["null", "123", "false", "[]", "{}", "''", "'   '"].map((variant) => `{ model: openai/gpt-5, variant: ${variant} }`),
    "{ model: openai/gpt-5, varient: low }", "{ model: openai/gpt-5, extra: true }",
  ])("rejects malformed object: %s", (value) => {
    expect(() => parseAgentModelConfig(`sane/worker/scout: ${value}`, AGENT_FILENAMES)).toThrow("Invalid model for sane/worker/scout")
  })

  test.each(["\n", "\r\n"])("objects replace or preserve top-level variant (%j)", (newline) => {
    const body = "\n# Body\r\nvariant: untouched\n---\n"
    const source = ["---", "model: old/model", "'variant': >-", "  high", "nested:", "  variant: nested", "---", ""].join(newline) + body
    for (const override of ["openai/gpt-6-astra", { model: "openai/gpt-6-astra" }, { model: "openai/gpt-6-astra", variant: "low" }]) {
      const result = injectAgentModel(source, override)
      const header = result.split(/\r?\n---/)[0]!.replace(/^---\r?\n/, "")
      expect(Bun.YAML.parse(header)).toEqual({ model: "openai/gpt-6-astra", variant: typeof override === "object" && "variant" in override ? "low" : "high", nested: { variant: "nested" } })
      expect(result.endsWith(body)).toBe(true)
      expect(injectAgentModel(result, override)).toBe(result)
    }
    expect(injectAgentModel("---\n{}\n---\nBody", { model: "openai/gpt-6-astra", variant: "true" })).toContain('variant: "true"')
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
