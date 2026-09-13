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

  function options(extra: { modelConfigPath?: string; dryRun?: boolean; overwrite?: boolean; write?: (line: string) => void } = {}) {
    return { homeDirectory, sourceRoot, write: () => {}, ...extra }
  }

  test("installs all eleven agents and all six assistant role skills", async () => {
    const result = await installSaneAgentContextPackages(options())

    expect(result.dryRun).toBe(false)
    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.created).toHaveLength(17)
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

  test("applies YAML models before planning, without touching sources or unmapped files", async () => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    const source = join(sourceRoot, "opencode", "agents", AGENT_FILENAMES[0])
    const original = "---\nmode: primary\n---\n\nOriginal body\n"
    await Bun.write(source, original)
    await Bun.write(modelConfigPath, `${AGENT_FILENAMES[0].slice(0, -3)}: openai/gpt-5\n`)
    await installSaneAgentContextPackages(options({ modelConfigPath, dryRun: true }))
    await expectMissing(homeDirectory)
    await installSaneAgentContextPackages(options({ modelConfigPath }))
    const destination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    expect(await readFile(source, "utf8")).toBe(original)
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[1]), "utf8")).toBe(`agent ${AGENT_FILENAMES[1]}\n`)
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).unchanged).toHaveLength(17)
    await Bun.write(modelConfigPath, `${AGENT_FILENAMES[0].slice(0, -3)}: anthropic/claude-sonnet-4-6\n`)
    await expect(installSaneAgentContextPackages(options({ modelConfigPath }))).rejects.toThrow("--overwrite")
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "anthropic/claude-sonnet-4-6"')
  })

  test("invalid YAML config or mapped frontmatter fails before writes", async () => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    for (const yaml of ["unknown: openai/gpt-5", "[]", "invalid: [", "sane-worker-scout: openai/gpt-5"]) {
      await Bun.write(modelConfigPath, yaml)
      await expect(installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true }))).rejects.toThrow()
      await expectMissing(homeDirectory)
    }
    await rm(modelConfigPath)
    await expect(installSaneAgentContextPackages(options({ modelConfigPath }))).rejects.toThrow("Could not load model config")
    await expectMissing(homeDirectory)
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
    expect(result.unchanged).toHaveLength(17)
  })

  test("dry run validates and reports plans without creating a home directory", async () => {
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))

    expect(result.dryRun).toBe(true)
    expect(result.created).toHaveLength(17)
    expect(lines).toContain("Dry run: no files or directories were modified.")
    expect(lines.filter((line) => line.startsWith("Planned:"))).toHaveLength(17)
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

  test("the default source manifest validates all registered agents and role skills", async () => {
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
      "sane-worker-researcher.md",
      "sane-worker-reviewer.md",
      "sane-worker-scout.md",
    ])
    expect(result.created).toHaveLength(17)
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
    expect(researchSkill).toContain("`research/workstream/BASELINE.md`")
    expect(researchSkill).toContain("`research/stage-<two-digit-id>/BASELINE.md`")
    expect(researchSkill).toContain("`resources/RESEARCH_BASELINE_TEMPLATE.md` for either assigned scope")
    expect(researchSkill).toMatch(/topic reports[\s\S]*authoritative\s+evidence records/i)
    expect(researchSkill).toMatch(/Only the coordinating Research Assistant assigned to a scope[\s\S]*updates that scope's baseline/i)
    expect(researchSkill).toMatch(/Delegated agents[\s\S]*never a baseline/i)
    expect(researchSkill).toMatch(/no baseline hierarchy,[\s\S]*inheritance/i)
    expect(researchSkill).not.toContain("`research/TECHNICAL_REFERENCE.md`")
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
    for (const filename of [
      "sane-worker-implementer.md",
      "sane-worker-reviewer.md",
      "sane-worker-fixer.md",
      "sane-worker-researcher.md",
      "sane-worker-scout.md",
    ]) {
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

  test("the self-contained Research Worker agent enforces the delegated research contract", async () => {
    const workerAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-worker-researcher.md"),
      "utf8",
    )
    expect(workerAgent).toContain("mode: subagent")
    expect(workerAgent).toMatch(/ask:\s*deny/)
    expect(workerAgent).toMatch(/task:\s*deny/)
    expect(workerAgent).toMatch(/webfetch:\s*allow/)
    expect(workerAgent).toMatch(/websearch:\s*allow/)
    expect(workerAgent).not.toMatch(/(?:Read|Load) the `sane-[^`]*worker[^`]*` skill/i)
    expect(workerAgent).toMatch(/(?:write|edit)[\s\S]{0,80}only[\s\S]{0,80}assigned[\s\S]{0,80}(?:`REPORT\.md`|report)/i)
    expect(workerAgent).toMatch(/(?:never|do not)[\s\S]{0,100}(?:edit|update|write)[\s\S]{0,100}baseline/i)
    expect(workerAgent).toMatch(/(?:do not|never)[\s\S]{0,180}(?:ask questions of the user|user-question|pickup|approval|delivery)/i)
    expect(workerAgent).toMatch(/external evidence|external-evidence/i)
    expect(workerAgent).toMatch(/exact supplied local files[\s\S]{0,100}read-only/i)
    expect(workerAgent).toMatch(/internal source[\s\S]{0,180}belongs to the SANE[\s\S]{0,40}Scout Worker/i)
    expect(workerAgent).toMatch(/non-destructive[\s\S]{0,120}(?:command|verification)/i)
    expect(workerAgent).toMatch(/unless\s+the\s+assignment explicitly authorizes/i)
    expect(workerAgent).toMatch(/never edit[\s\S]{0,180}(?:implementation source|tests)[\s\S]{0,80}configuration/i)
    expect(workerAgent).toMatch(/(?:do not|never)[\s\S]{0,100}(?:install|update)[\s\S]{0,120}dependenc/i)
    expect(workerAgent).toMatch(/(?:run )?migrations/i)
    expect(workerAgent).toMatch(/deploy/i)
    expect(workerAgent).toMatch(/implementation repository as read-only[\s\S]{0,180}(?:otherwise mutate it|never)/i)
    expect(workerAgent).toMatch(/(?:live[\s-](?:service|credential)|access[\s\S]{0,40}credentials?)/i)
    expect(workerAgent).toMatch(/baseline[\s\S]{0,100}revision/i)
    expect(workerAgent).toMatch(/(?:relationship|relat(?:e|ion))[\s\S]{0,120}baseline|baseline[\s\S]{0,120}(?:relationship|relat(?:e|ion))/i)
    expect(workerAgent).toMatch(/concise handoff[\s\S]{0,120}launching assistant/i)
    expect(workerAgent).toMatch(/\*\*Complete\*\*[\s\S]{0,40}\*\*Partial\*\*[\s\S]{0,40}\*\*Blocked\*\*/)
  })

  test("the Scout is a bounded read-only inline implementation inspector", async () => {
    const scout = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-worker-scout.md"),
      "utf8",
    )

    expect(scout).toContain("mode: subagent")
    expect(scout).toMatch(/edit:\s*deny/)
    expect(scout).toMatch(/(?:ask|question):\s*deny/)
    expect(scout).toMatch(/task:\s*deny/)
    expect(scout).toMatch(/webfetch:\s*deny/)
    expect(scout).toMatch(/websearch:\s*deny/)
    expect(scout).toMatch(/external_directory:\s*allow/)
    expect(scout).toMatch(/exact external workstream-context path|exact workstream artifacts? supplied/i)
    expect(scout).toMatch(/does not authorize external discovery|must not discover wider workstream context/i)
    expect(scout).toMatch(/exact supplied scope|exact, bounded scope/i)
    expect(scout).toMatch(/repository instructions[\s\S]{0,180}source[\s\S]{0,100}tests[\s\S]{0,100}configuration/i)
    expect(scout).toMatch(/callers[\s\S]{0,100}(?:integration points|interfaces)/i)
    expect(scout).toMatch(/safe, non-destructive commands/i)
    expect(scout).toMatch(/precise repository[\s\S]{0,60}paths and line numbers/i)
    expect(scout).toMatch(/\*\*Observations\*\*[\s\S]{0,80}\*\*Inferences\*\*[\s\S]{0,80}\*\*Limitations\*\*/)
    expect(scout).toMatch(/inline handoff/i)
    expect(scout).toMatch(/never create or update[\s\S]{0,60}(?:Research )?`REPORT\.md`/i)
    expect(scout).toMatch(/\*\*Complete\*\*[\s\S]{0,40}\*\*Partial\*\*[\s\S]{0,40}\*\*Blocked\*\*/)
  })

  test("Engineering routes internal inspection to Scout and explicit external research to Researcher", async () => {
    const engineeringAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-assistant-engineering.md"),
      "utf8",
    )
    const engineeringRole = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-engineering-assistant-role", "SKILL.md"),
      "utf8",
    )

    expect(engineeringAgent).toMatch(
      /task:\s*\n\s+"\*": deny\s*\n\s+"sane-worker-scout": allow\s*\n\s+"sane-worker-researcher": allow/,
    )
    expect(engineeringRole).toMatch(/internal codebase inspection[\s\S]{0,180}sane-worker-scout/i)
    expect(engineeringRole).toMatch(/normally confirms?[\s\S]{0,180}Engineering Assistance[\s\S]{0,180}sane-worker-scout/i)
    expect(engineeringRole).toMatch(/external evidence/i)
    expect(engineeringRole).toContain("`sane-worker-researcher`")
    expect(engineeringRole).toMatch(/explicitly requests bounded[\s\S]{0,80}external research/i)
    expect(engineeringRole).toMatch(/ordinary confirmation[\s\S]{0,100}not authorization[\s\S]{0,100}(?:launch|Researcher)/i)
    expect(engineeringRole).toMatch(/own synthesis|own[s]? synthesis/i)
    expect(engineeringRole).toMatch(/Scout[\s\S]{0,100}never writes[\s\S]{0,80}`REPORT\.md`/i)
  })

  test("assistant task permissions allow only their assigned worker agents", async () => {
    const researchAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-assistant-research.md"),
      "utf8",
    )
    const coordinationAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane-assistant-coordination.md"),
      "utf8",
    )

    expect(researchAgent).toMatch(/task:\s*\n\s+"\*": deny\s*\n\s+"sane-worker-researcher": allow/)
    expect(researchAgent).not.toContain('"sane-worker-scout": allow')
    expect(coordinationAgent).toMatch(
      /task:\s*\n\s+"\*": deny\s*\n\s+"sane-worker-implementer": allow\s*\n\s+"sane-worker-reviewer": allow\s*\n\s+"sane-worker-fixer": allow/,
    )
    expect(coordinationAgent).not.toContain('"sane-worker-researcher": allow')
    expect(coordinationAgent).not.toContain('"sane-worker-scout": allow')

    const researchRole = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-research-assistant-role", "SKILL.md"),
      "utf8",
    )
    expect(researchRole).toMatch(/repository audits directly/i)
    expect(researchRole).toMatch(/no permission to launch Scout/i)
    expect(researchRole).toMatch(/sane-worker-researcher[\s\S]{0,100}external-evidence worker/i)
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
    expect(parseCliArguments(["--model-config", "two words.yaml", "--dry-run"])).toEqual({ dryRun: true, overwrite: false, modelConfigPath: "two words.yaml" })
    for (const args of [["--model-config"], ["--model-config", "--overwrite"], ["--model-config", ""], ["--model-config", "a", "--model-config", "b"]]) {
      expect(() => parseCliArguments(args)).toThrow("--model-config")
    }
    expect(parseCliArguments(["--dry-run", "--overwrite"])).toEqual({ dryRun: true, overwrite: true })
    expect(() => parseCliArguments(["destination"])).toThrow("does not accept positional")
    expect(() => parseCliArguments(["--unexpected"])).toThrow("Unknown option")
    expect(() => parseCliArguments(["--", "destination"])).toThrow("does not accept positional")
  })
})
