import { describe, expect, test } from "bun:test"
import { ccAgentFilename, parseSaneAgent, serializeCcAgent, serializeOcAgent } from "../src/agent-serialization.ts"

const OC_AGENT = `---\ndescription: Helps the user plan.\nmode: primary\ntemperature: 0.2\npermission:\n  task:\n    "*": deny\n---\n\nYou are a planner.\n`

describe("agent serialization", () => {
  test("parses OC source into the canonical spec", () => {
    const spec = parseSaneAgent(OC_AGENT, "sane/assistant/planning")
    expect(spec.kind).toBe("assistant")
    expect(spec.shortId).toBe("planning")
    expect(spec.description).toBe("Helps the user plan.")
    expect(spec.body).toContain("You are a planner.")
  })
  test("OC serialization preserves the source verbatim", () => {
    const spec = parseSaneAgent(OC_AGENT, "sane/assistant/planning")
    expect(serializeOcAgent(OC_AGENT, spec)).toBe(OC_AGENT)
  })
  test("CC serialization keeps all permissions (no tools restriction)", () => {
    const spec = parseSaneAgent(OC_AGENT, "sane/assistant/planning")
    const cc = serializeCcAgent(spec)
    expect(cc).toContain('name: "sane-assistant-planning"')
    expect(cc).toContain("Helps the user plan.")
    expect(cc).toContain("You are a planner.")
    expect(cc).not.toMatch(/tools:/)
    expect(ccAgentFilename("sane/assistant/planning")).toBe("sane-assistant-planning.md")
  })
})
