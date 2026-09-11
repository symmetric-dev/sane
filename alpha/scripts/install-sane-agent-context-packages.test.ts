import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  AGENT_FILENAMES,
  AgentContextPackageInstallationError,
  DEFAULT_SOURCE_ROOT,
  ROLE_SKILL_NAMES,
  installSaneAgentContextPackages,
  parseCliArguments,
} from "./install-sane-agent-context-packages.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

describe("install-sane-agent-context-packages", () => {
  let temporaryDirectory: string
  let homeDirectory: string
  let sourceRoot: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "sane-agent-context-packages-"))
    homeDirectory = join(temporaryDirectory, "home")
    sourceRoot = join(temporaryDirectory, "source")
    for (const filename of AGENT_FILENAMES) {
      const path = join(sourceRoot, "opencode", "agents", filename)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, `agent ${filename}\n`)
    }
    for (const skillName of ROLE_SKILL_NAMES) {
      const path = join(sourceRoot, "skills", skillName, "SKILL.md")
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, `skill ${skillName}\n`)
    }
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  function options(extra: { dryRun?: boolean; overwrite?: boolean; write?: (line: string) => void } = {}) {
    return { homeDirectory, sourceRoot, write: () => {}, ...extra }
  }

  test("installs all nine agents and all six generic role skills", async () => {
    const result = await installSaneAgentContextPackages(options())

    expect(result.dryRun).toBe(false)
    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.created).toHaveLength(15)
    for (const filename of AGENT_FILENAMES) {
      expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", filename), "utf8")).toBe(
        `agent ${filename}\n`,
      )
    }
    for (const skillName of ROLE_SKILL_NAMES) {
      expect(await readFile(join(homeDirectory, ".agents", "skills", skillName, "SKILL.md"), "utf8")).toBe(
        `skill ${skillName}\n`,
      )
    }
  })

  test("uses SANE_HOME when no home directory option is provided", async () => {
    const previousSaneHome = process.env.SANE_HOME
    process.env.SANE_HOME = homeDirectory
    try {
      await installSaneAgentContextPackages({ sourceRoot, write: () => {} })
    } finally {
      if (previousSaneHome === undefined) delete process.env.SANE_HOME
      else process.env.SANE_HOME = previousSaneHome
    }

    expect(
      await readFile(
        join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0]),
        "utf8",
      ),
    ).toBe(`agent ${AGENT_FILENAMES[0]}\n`)
  })

  test("repeats as a no-op when every destination is identical", async () => {
    await installSaneAgentContextPackages(options())
    const result = await installSaneAgentContextPackages(options())

    expect(result).toMatchObject({ created: [], updated: [] })
    expect(result.unchanged).toHaveLength(15)
  })

  test("dry run validates and reports plans without creating a home directory", async () => {
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))

    expect(result.dryRun).toBe(true)
    expect(result.created).toHaveLength(15)
    expect(lines).toContain("Dry run: no files or directories were modified.")
    expect(lines.filter((line) => line.startsWith("Planned:"))).toHaveLength(15)
    await expectMissing(homeDirectory)
  })

  test("refuses a differing regular destination without --overwrite", async () => {
    await installSaneAgentContextPackages(options())
    const destination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    await Bun.write(destination, "user content\n")

    await expect(installSaneAgentContextPackages(options())).rejects.toBeInstanceOf(
      AgentContextPackageInstallationError,
    )
    expect(await readFile(destination, "utf8")).toBe("user content\n")
  })

  test("overwrites only a differing regular destination when requested", async () => {
    await installSaneAgentContextPackages(options())
    const filename = AGENT_FILENAMES[0]
    const destination = join(homeDirectory, ".config", "opencode", "agents", filename)
    await Bun.write(destination, "user content\n")

    const result = await installSaneAgentContextPackages(options({ overwrite: true }))

    expect(result.updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toBe(`agent ${filename}\n`)
  })

  test("never overwrites a non-regular destination, including with --overwrite", async () => {
    await installSaneAgentContextPackages(options())
    const destination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    await rm(destination)
    await mkdir(destination)

    await expect(installSaneAgentContextPackages(options({ overwrite: true }))).rejects.toThrow(
      "not a regular file",
    )
    expect((await lstat(destination)).isDirectory()).toBe(true)
  })

  test("rejects a non-directory destination parent before creating any files", async () => {
    await mkdir(homeDirectory, { recursive: true })
    await Bun.write(join(homeDirectory, ".config"), "not a directory\n")

    await expect(installSaneAgentContextPackages(options())).rejects.toThrow(
      "Destination parent is not a directory",
    )
    await expectMissing(join(homeDirectory, ".agents"))
  })

  test("rejects an invalid source before making any destination mutation", async () => {
    await rm(join(sourceRoot, "skills", ROLE_SKILL_NAMES[0], "SKILL.md"))

    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("Required source")
    await expectMissing(homeDirectory)
  })

  test("the default source manifest validates six generic skills using the root PRD", async () => {
    const result = await installSaneAgentContextPackages({
      homeDirectory,
      dryRun: true,
      write: () => {},
    })

    expect(ROLE_SKILL_NAMES).toEqual([
      "sane-coordination-assistant-role",
      "sane-product-assistant-role",
      "sane-research-assistant-role",
      "sane-design-assistant-role",
      "sane-engineering-assistant-role",
      "sane-execution-assistant-role",
    ])
    expect(AGENT_FILENAMES).toEqual([
      "sane-assistant-coordination.md",
      "sane-assistant-design.md",
      "sane-assistant-engineering.md",
      "sane-assistant-execution.md",
      "sane-assistant-product.md",
      "sane-assistant-research.md",
      "sane-worker-fixer.md",
      "sane-worker-implementer.md",
      "sane-worker-reviewer.md",
    ])
    expect(result.created).toHaveLength(15)
    for (const skillName of ROLE_SKILL_NAMES) {
      expect(await readFile(join(DEFAULT_SOURCE_ROOT, "skills", skillName, "SKILL.md"), "utf8")).not.toBe("")
    }
    const productSkill = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-product-assistant-role", "SKILL.md"),
      "utf8",
    )
    const designSkill = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-design-assistant-role", "SKILL.md"),
      "utf8",
    )
    const researchSkill = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-research-assistant-role", "SKILL.md"),
      "utf8",
    )
    expect(productSkill).toContain("`PRD.md`")
    expect(designSkill).toContain("`PRD.md`")
    expect(productSkill).not.toContain("`FOUNDATION.md`")
    expect(designSkill).not.toContain("`FOUNDATION.md`")
    expect(researchSkill).toContain("`research/TECHNICAL_REFERENCE.md`")
    expect(researchSkill).not.toContain("`research/INDEX.md`")
    expect(researchSkill).not.toContain("`research/TECH_BRIEF.md`")
    const productAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-assistant-product.md"),
      "utf8",
    )
    const designAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-assistant-design.md"),
      "utf8",
    )
    for (const [agent, skillName] of [
      [productAgent, "sane-product-assistant-role"],
      [designAgent, "sane-design-assistant-role"],
    ]) {
      expect(agent).toContain(`Read the \`${skillName}\` skill.`)
      expect(agent).not.toContain("sane-feature-")
      expect(agent).not.toContain("sane-foundation-")
      expect(agent).not.toContain("explicitly declared by the user")
      expect(agent).not.toContain("workstream `type` file")
    }
    for (const filename of ["sane-worker-implementer.md", "sane-worker-reviewer.md", "sane-worker-fixer.md"]) {
      const agent = await readFile(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", filename), "utf8")
      expect(agent).toContain("mode: subagent")
      expect(agent).toContain('"*": allow')
      expect(agent).toContain('"sane-*-assistant-role": deny')
      expect(agent).toContain("task: deny")
      expect(agent).not.toContain("Read the `sane-coordination-assistant-role` skill.")
    }
    const reviewerAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-worker-reviewer.md"),
      "utf8",
    )
    expect(reviewerAgent).toContain("edit: deny")
  })

  test("does not delete previously installed typed skill directories", async () => {
    await installSaneAgentContextPackages(options())
    const legacySkill = join(
      homeDirectory,
      ".agents",
      "skills",
      "sane-feature-product-assistant-role",
      "SKILL.md",
    )
    await mkdir(dirname(legacySkill), { recursive: true })
    await Bun.write(legacySkill, "user-directed legacy skill\n")

    await installSaneAgentContextPackages(options())

    expect(await readFile(legacySkill, "utf8")).toBe("user-directed legacy skill\n")
  })

  test("validates CLI options and rejects positional arguments", () => {
    expect(parseCliArguments([])).toEqual({ dryRun: false, overwrite: false })
    expect(parseCliArguments(["--dry-run", "--overwrite"])).toEqual({ dryRun: true, overwrite: true })
    expect(() => parseCliArguments(["destination"])).toThrow("does not accept positional")
    expect(() => parseCliArguments(["--unexpected"])).toThrow("Unknown option")
    expect(() => parseCliArguments(["--", "destination"])).toThrow("does not accept positional")
  })
})
