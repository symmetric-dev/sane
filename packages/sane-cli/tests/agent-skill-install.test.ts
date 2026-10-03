import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AGENT_FILENAMES,
  GLOBAL_SUPPORT_SKILL_NAMES,
  ROLE_SKILL_NAMES,
  installSaneAgentContextPackages,
} from "../src/install-sane-agent-context-packages.ts"
import { ccAgentFilename } from "../src/agent-serialization.ts"

/**
 * Offline agent/skill loading confirmation. Installs into an isolated tmp
 * home from the real repo sources, then asserts every installed agent and
 * skill file parses and matches its source. No harness, no network, no spend.
 */
describe("agent-skill-install", () => {
  let temporaryDirectory: string
  let homeDirectory: string

  async function freshHome(): Promise<void> {
    temporaryDirectory = await mkdtemp(join(await realpath(tmpdir()), "sane-agent-skill-"))
    homeDirectory = join(temporaryDirectory, "home")
    await mkdir(homeDirectory, { recursive: true })
    await installSaneAgentContextPackages({ homeDirectory, write: () => {} })
  }

  async function cleanup(): Promise<void> {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  test("real-source CC package loads agents, settings, and skills with source parity", async () => {
    try {
      await freshHome()
      expect(AGENT_FILENAMES).toHaveLength(15)
      for (const filename of AGENT_FILENAMES) {
        const agentName = filename.slice(0, -3)
        const ccName = ccAgentFilename(agentName)
        const content = await readFile(join(homeDirectory, ".claude", "agents", ccName), "utf8")
        const match = /^---\n([\s\S]*?)\n---\n/.exec(content)
        expect(match, `${ccName} frontmatter`).not.toBeNull()
        const frontmatter = Bun.YAML.parse(match![1]!) as Record<string, unknown>
        expect(frontmatter.name).toBe(ccName.replace(/\.md$/, ""))
        expect(typeof frontmatter.description).toBe("string")
        expect((frontmatter.description as string).length).toBeGreaterThan(10)
        expect(frontmatter.tools).toBeUndefined()
        expect(frontmatter.mode).toBeUndefined()
        expect(frontmatter.permission).toBeUndefined()
        const body = content.slice(match![0].length).trim()
        expect(body.length).toBeGreaterThan(100)
        const oc = await readFile(join(homeDirectory, ".config", "opencode", "agents", filename), "utf8")
        const ocBody = oc.replace(/^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m, "").trim()
        expect(body).toBe(ocBody)
      }
      for (const filename of AGENT_FILENAMES) {
        const ccName = ccAgentFilename(filename.slice(0, -3))
        const settingsName = ccName.replace(/\.md$/, ".settings.json")
        const raw = await readFile(join(homeDirectory, ".claude", "sane-agent-settings", settingsName), "utf8")
        const parsed = JSON.parse(raw) as { permissions?: Record<string, string[]> }
        expect(parsed.permissions, settingsName).toBeDefined()
        expect(parsed.permissions!.deny, settingsName).toEqual(filename.startsWith("sane/worker/") ? ["Skill(sane-assistant-:*)"] : undefined)
        for (const list of Object.values(parsed.permissions!)) {
          expect(Array.isArray(list)).toBe(true)
        }
      }
      for (const skillName of ROLE_SKILL_NAMES) {
        const cc = await readFile(join(homeDirectory, ".claude", "skills", skillName, "SKILL.md"), "utf8")
        const shared = await readFile(join(homeDirectory, ".agents", "skills", skillName, "SKILL.md"), "utf8")
        expect(cc).toBe(shared)
        const match = /^---\n([\s\S]*?)\n---\n/.exec(cc)
        expect(match, `${skillName} frontmatter`).not.toBeNull()
        const frontmatter = Bun.YAML.parse(match![1]!) as Record<string, unknown>
        expect(frontmatter.name).toBeDefined()
        expect(frontmatter.description).toBeDefined()
      }
      for (const skillName of GLOBAL_SUPPORT_SKILL_NAMES) {
        const cc = await readFile(join(homeDirectory, ".claude", "skills", skillName, "SKILL.md"), "utf8")
        const oc = await readFile(join(homeDirectory, ".config", "opencode", "skills", skillName, "SKILL.md"), "utf8")
        expect(cc).toBe(oc)
      }
    } finally {
      if (temporaryDirectory) await cleanup()
    }
  })
})
