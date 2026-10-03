import { describe, expect, test } from "bun:test"
import { ccAgentFilename, parseSaneAgent, serializeCcAgent, serializeCcSettings, serializeOcAgent } from "../src/agent-serialization.ts"

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
  test("CC settings emit named skill and agent denies, never wildcard or tool-level denies", () => {
    const worker = `---\npermission:\n  ask: deny\n  edit: deny\n  skill:\n    "*": allow\n    "sane-assistant-*": deny\n    "repo-only": deny\n  task:\n    "*": deny\n    "sane/worker/scout": allow\n    "sane/worker/fixer": deny\n---\nbody\n`
    const settings = JSON.parse(serializeCcSettings(parseSaneAgent(worker, "sane/worker/implementer")))
    expect(settings.permissions).toEqual({
      allow: ["Agent(sane-worker-scout)"],
      deny: ["Skill(sane-assistant-:*)", "Skill(repo-only)", "Agent(sane-worker-fixer)"],
    })
    const rules = `---\npermissions:\n  - action: skill\n    resource: "*"\n    effect: allow\n  - action: skill\n    resource: "sane-assistant-*"\n    effect: deny\n  - action: subagent\n    resource: "*"\n    effect: deny\n  - action: subagent\n    resource: general\n    effect: deny\n---\nbody\n`
    expect(parseSaneAgent(rules, "sane/assistant/curation").ccPermissions)
      .toEqual({ allow: ["Skill"], ask: [], deny: ["Skill(sane-assistant-:*)", "Agent(general)"] })
    expect(JSON.parse(serializeCcSettings(parseSaneAgent(OC_AGENT, "sane/assistant/planning"))).permissions.deny).toBeUndefined()
  })
  test("untranslatable skill deny patterns fail fast", () => {
    for (const pattern of ["*-pickup", "sane-*-pickup", "sane-**"]) {
      const source = `---\npermission:\n  skill:\n    "${pattern}": deny\n---\nbody\n`
      expect(() => parseSaneAgent(source, "sane/worker/scout")).toThrow(`Agent sane/worker/scout has unsupported skill permission pattern "${pattern}"`)
    }
  })
})
