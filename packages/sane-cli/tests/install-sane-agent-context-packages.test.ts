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
} from "../src/install-sane-agent-context-packages.ts"

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

  test("installs all eleven agents and all five assistant role skills", async () => {
    const result = await installSaneAgentContextPackages(options())

    expect(result.dryRun).toBe(false)
    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.created).toHaveLength(16)
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

  test.each(["shorthand", "flow", "block", "model-only"])("applies %s YAML models before planning, without touching sources or unmapped files", async (form) => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    const source = join(sourceRoot, "opencode", "agents", AGENT_FILENAMES[0])
    const original = "---\nmode: primary\nvariant: high\n---\n\nOriginal body\n"
    const mapping = (model: string, variant: string) => `${AGENT_FILENAMES[0].slice(0, -3)}: ${form === "shorthand" ? model : form === "flow" ? `{ model: ${model}, variant: ${variant} }` : form === "block" ? `\n  model: ${model}\n  variant: ${variant}` : `{ model: ${model} }`}\n`
    await Bun.write(source, original)
    await Bun.write(modelConfigPath, mapping("openai/gpt-5", "low"))
    await installSaneAgentContextPackages(options({ modelConfigPath, dryRun: true }))
    await expectMissing(homeDirectory)
    await installSaneAgentContextPackages(options({ modelConfigPath }))
    const destination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    const installed = await readFile(destination, "utf8")
    expect(installed).toContain(form === "flow" || form === "block" ? 'variant: "low"' : "variant: high")
    expect(installed.endsWith("\nOriginal body\n")).toBe(true)
    expect(await readFile(source, "utf8")).toBe(original)
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[1]), "utf8")).toBe(`agent ${AGENT_FILENAMES[1]}\n`)
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).unchanged).toHaveLength(16)
    await Bun.write(modelConfigPath, mapping("anthropic/claude-sonnet-4-6", "medium"))
    await expect(installSaneAgentContextPackages(options({ modelConfigPath }))).rejects.toThrow("--overwrite")
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "anthropic/claude-sonnet-4-6"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).unchanged).toHaveLength(16)
    expect(await readFile(source, "utf8")).toBe(original)
    if (form === "flow" || form === "block") {
      expect(await readFile(destination, "utf8")).toContain('variant: "medium"')
      await Bun.write(modelConfigPath, mapping("anthropic/claude-sonnet-4-6", "low"))
      expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
      expect(await readFile(destination, "utf8")).toContain('variant: "medium"')
    }
  })

  test("invalid YAML config or mapped frontmatter fails before writes", async () => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    for (const yaml of ["unknown: openai/gpt-5", "[]", "invalid: [", "sane/worker/scout: openai/gpt-5", "sane/worker/scout: { model: openai/gpt-5, varient: low }", "sane/worker/scout:\n  model: openai/gpt-5\n  variant: null"]) {
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
    expect(result.unchanged).toHaveLength(16)
  })

  test("dry run validates and reports plans without creating a home directory", async () => {
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))

    expect(result.dryRun).toBe(true)
    expect(result.created).toHaveLength(16)
    expect(lines).toContain("Dry run: no files or directories were modified.")
    expect(lines.filter((line) => line.startsWith("Planned:"))).toHaveLength(16)
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
      "sane-design-assistant-role",
      "sane-engineering-assistant-role",
      "sane-execution-assistant-role",
      "sane-planning-assistant-role",
      "sane-research-assistant-role",
    ])
    expect(AGENT_FILENAMES).toEqual([
      "sane/assistant/design.md",
      "sane/assistant/engineering.md",
      "sane/assistant/execution.md",
      "sane/assistant/planning.md",
      "sane/assistant/research.md",
      "sane/worker/fixer.md",
      "sane/worker/grounder.md",
      "sane/worker/implementer.md",
      "sane/worker/researcher.md",
      "sane/worker/reviewer.md",
      "sane/worker/scout.md",
    ])
    expect(result.created).toHaveLength(16)
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
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/design.md"),
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
      "sane/worker/grounder.md",
      "sane/worker/implementer.md",
      "sane/worker/reviewer.md",
      "sane/worker/fixer.md",
      "sane/worker/researcher.md",
      "sane/worker/scout.md",
    ]) {
      const agent = await readFile(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", filename), "utf8")
      expect(agent).toContain("mode: subagent")
      expect(agent).toContain('"*": allow')
      expect(agent).toContain('"sane-*-assistant-role": deny')
      const metadata = Bun.YAML.parse(agent.split("---")[1]!) as { permission: { task: string | Record<string, string> } }
      expect(metadata.permission.task).toEqual(filename === "sane/worker/implementer.md"
        ? { "*": "deny", "sane/worker/scout": "allow" }
        : "deny")
      expect(agent).not.toContain("Read the `sane-coordination-assistant-role` skill.")
    }
    const reviewerAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/worker/reviewer.md"),
      "utf8",
    )
    expect(reviewerAgent).toContain("edit: deny")
  })

  test("the self-contained Research Worker agent enforces the delegated research contract", async () => {
    const workerAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/worker/researcher.md"),
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
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/worker/scout.md"),
      "utf8",
    )

    expect(scout).toContain("mode: subagent")
    expect(scout).toMatch(/edit:\s*deny/)
    expect(scout).toMatch(/(?:ask|question):\s*deny/)
    expect(scout).toMatch(/task:\s*deny/)
    expect(scout).toMatch(/webfetch:\s*deny/)
    expect(scout).toMatch(/websearch:\s*deny/)
    expect(scout).toMatch(/external_directory:\s*allow/)
    expect(scout).toMatch(/starting paths, supplied context, desired evidence, forbidden paths/i)
    expect(scout).toMatch(/open-ended repository discovery/i)
    expect(scout).toMatch(/broader authority or missing context/i)
    expect(scout).toMatch(/Inspect one bounded scope inside the implementation repository/i)
    expect(scout).toMatch(/invoking agent.*your parent/i)
    expect(scout).toMatch(/complete, self-contained\s+assignment/i)
    expect(scout).toMatch(/findings or blockers[\s\S]{0,80}inline handoff directly to your\s+parent/i)
    expect(scout).toMatch(/Read applicable repository instructions before inspecting/i)
    expect(scout).toMatch(/scoped source,[\s\S]{0,80}tests, configuration, callers/i)
    expect(scout).toMatch(/forbidden paths, and stop conditions/i)
    expect(scout).not.toContain("launching Engineering Assistant")
    expect(scout).toMatch(/repository instructions[\s\S]{0,180}source[\s\S]{0,100}tests[\s\S]{0,100}configuration/i)
    expect(scout).toMatch(/callers[\s\S]{0,100}(?:integration points|interfaces)/i)
    expect(scout).toMatch(/safe, non-destructive commands/i)
    expect(scout).toMatch(/precise repository[\s\S]{0,60}paths and line numbers/i)
    expect(scout).toMatch(/\*\*Observations\*\*[\s\S]{0,80}\*\*Inferences\*\*[\s\S]{0,80}\*\*Limitations\*\*/)
    expect(scout).toMatch(/inline handoff/i)
    expect(scout).toMatch(/Remain strictly read-only\. Never edit or create source, tests, configuration, planning artifacts/i)
    expect(scout).toMatch(/\*\*Complete\*\*[\s\S]{0,40}\*\*Partial\*\*[\s\S]{0,40}\*\*Blocked\*\*/)
  })

  test("the implementer delegates only supporting inspection and retains Job ownership", async () => {
    const implementer = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/worker/implementer.md"), "utf8",
    )
    expect(implementer).toMatch(/highly encouraged to launch `sane\/worker\/scout` agent for bounded, read-only supporting\s+inspection/)
    expect(implementer).toMatch(/Scout workers DO NOT have context of the workstream/i)
    expect(implementer).toMatch(/YOU read the context/i)
    expect(implementer).toMatch(/provide the absolute path/i)
    expect(implementer).toMatch(/You implement one bounded Job[\s\S]{0,120}Implementation Report/)
    expect(implementer).toMatch(/Create or update the report only at the supplied destination/)
    expect(implementer).toMatch(/path beyond the Job's expected surface/)
    expect(implementer).not.toMatch(/sane\/worker\/(researcher|reviewer|fixer|grounder)/)
    expect(implementer).not.toContain("or launch another agent.")
  })

  test("Engineering requires permission for Scout inspection and explicitly requested Researcher work", async () => {
    const engineeringAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/engineering.md"),
      "utf8",
    )
    const engineeringRole = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-engineering-assistant-role", "SKILL.md"),
      "utf8",
    )

    expect(engineeringAgent).toMatch(
      /task:\s*\n\s+"\*": deny\s*\n\s+"sane\/worker\/scout": ask\s*\n\s+"sane\/worker\/researcher": ask/,
    )
    expect(engineeringRole).toMatch(/internal codebase inspection[\s\S]{0,180}sane\/worker\/scout/i)
    expect(engineeringRole).toMatch(/normally confirms?[\s\S]{0,180}Engineering Assistance[\s\S]{0,180}sane\/worker\/scout/i)
    expect(engineeringRole).toMatch(/external evidence/i)
    expect(engineeringRole).toContain("`sane/worker/researcher`")
    expect(engineeringRole).toMatch(/explicitly requests bounded[\s\S]{0,80}external research/i)
    expect(engineeringRole).toMatch(/ordinary confirmation[\s\S]{0,100}not authorization[\s\S]{0,100}(?:launch|Researcher)/i)
    expect(engineeringRole).toMatch(/own synthesis|own[s]? synthesis/i)
    expect(engineeringRole).toMatch(/Scout[\s\S]{0,100}never writes[\s\S]{0,80}`REPORT\.md`/i)
  })

  test("assistant task permissions allow only their assigned worker agents", async () => {
    const researchAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/research.md"),
      "utf8",
    )
    const coordinationAgent = await readFile(
      join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/execution.md"),
      "utf8",
    )

    expect(researchAgent).toMatch(/task:\s*\n\s+"\*": deny\s*\n\s+"sane\/worker\/researcher": allow/)
    expect(researchAgent).not.toContain('"sane/worker/scout": allow')
    expect(coordinationAgent).toMatch(
      /task:\s*\n\s+"\*": deny\s*\n\s+"sane\/worker\/implementer": allow\s*\n\s+"sane\/worker\/reviewer": allow\s*\n\s+"sane\/worker\/fixer": allow/,
    )
    expect(coordinationAgent).not.toContain('"sane/worker/researcher": allow')
    expect(coordinationAgent).not.toContain('"sane/worker/scout": allow')
    const metadata = Bun.YAML.parse(coordinationAgent.split("---")[1]!) as { permission: { task: Record<string, string> } }
    expect(metadata.permission.task).toEqual({
      "*": "deny", "sane/worker/implementer": "allow",
      "sane/worker/reviewer": "allow", "sane/worker/fixer": "allow",
    })

    const researchRole = await readFile(
      join(DEFAULT_SOURCE_ROOT, "skills", "sane-research-assistant-role", "SKILL.md"),
      "utf8",
    )
    expect(researchRole).toMatch(/repository audits directly/i)
    expect(researchRole).toMatch(/no permission to launch Scout/i)
    expect(researchRole).toMatch(/sane\/worker\/researcher[\s\S]{0,100}external-evidence worker/i)
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

  test("Planning migration installs shipped models, preserves legacy customizations, and repeats unchanged", async () => {
    const oldAgent = join(homeDirectory, ".config", "opencode", "agents", "sane/assistant/execution.md")
    const oldSkill = join(homeDirectory, ".agents", "skills", "sane-execution-assistant-role", "SKILL.md")
    for (const path of [oldAgent, oldSkill]) {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, "preserve local execution customization\n")
    }
    const installOptions = {
      homeDirectory,
      modelConfigPath: join(DEFAULT_SOURCE_ROOT, "models.yaml"),
      overwrite: true,
      write: () => {},
    }
    const dryRun = await installSaneAgentContextPackages({ ...installOptions, dryRun: true })
    expect(dryRun.created).toHaveLength(16)
    const planningPath = join(homeDirectory, ".config", "opencode", "agents", "sane/assistant/planning.md")
    await expectMissing(planningPath)
    const result = await installSaneAgentContextPackages(installOptions)
    expect(result.created).toEqual(dryRun.created)
    const planning = await readFile(planningPath, "utf8")
    expect(planning).toContain('model: "opencode-go/muse-spark-1.3-contributor"')
    expect(planning).toContain('variant: "high"')
    expect(planning).toContain("Read the `sane-planning-assistant-role` skill.")
    const grounder = await readFile(join(homeDirectory, ".config", "opencode", "agents", "sane/worker/grounder.md"), "utf8")
    expect(grounder).toContain('model: "opencode-go/muse-spark-1.3-contributor"')
    expect(grounder).toContain('variant: "high"')
    expect(await readFile(join(homeDirectory, ".agents", "skills", "sane-planning-assistant-role", "SKILL.md"), "utf8"))
      .toContain("# SANE Planning Assistant Role")
    expect((await installSaneAgentContextPackages(installOptions)).unchanged).toHaveLength(16)
    for (const path of [oldAgent, oldSkill]) {
      expect(await readFile(path, "utf8")).toBe("preserve local execution customization\n")
    }
    await expectMissing(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/execution.md"))
    await expectMissing(join(DEFAULT_SOURCE_ROOT, "skills", "sane-execution-assistant-role", "SKILL.md"))
  })

  test("obsolete execution model keys fail before any destination write", async () => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    await Bun.write(modelConfigPath, "sane-assistant-legacy: { model: openai/gpt-5.6-sol, variant: low }\n")
    await expect(installSaneAgentContextPackages({ homeDirectory, modelConfigPath, write: () => {} }))
      .rejects.toThrow("Unknown agent in model config: sane-assistant-legacy")
    await expectMissing(homeDirectory)
  })

  test("Planning gates drafting and grounding before final approval and only delegates to Grounder", async () => {
    const agent = await readFile(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/assistant/planning.md"), "utf8")
    const metadata = Bun.YAML.parse(agent.split("---")[1]!) as { permission: { task: Record<string, string> } }
    expect(metadata.permission.task).toEqual({ "*": "deny", "sane/worker/grounder": "allow" })
    expect(agent).toMatch(/Pickup[\s\S]*Wait for user confirmation before proceeding/)
    const role = await readFile(join(DEFAULT_SOURCE_ROOT, "skills", "sane-planning-assistant-role", "SKILL.md"), "utf8")
    expect(role).toMatch(/explicit confirmation before creating or substantively updating Job Specs or\s+delegating grounding/)
    expect(role).toMatch(/Readiness confirmation is not breakdown confirmation/)
    expect(role).toMatch(/3\. After confirmation[\s\S]*draft Job Spec[\s\S]*4\. Delegate each draft[\s\S]*5\. Review every returned summary/)
    expect(role).toMatch(/targeted[\s\S]*renewed breakdown confirmation/)
    expect(role).toMatch(/Final execution approval covers the completed plan and Job Specs/)
    expect(role).toMatch(/Only after final user approval, and if the user asks to update State/)
    expect(role).toContain("selected Stage's `Execution` entry")
    expect(role).toMatch(/sole owner\/editor[\s\S]*factual corrections[\s\S]*revisions/)
    expect(role).toMatch(/Coordination, implementers, reviewers, and fixers never edit/)
    expect(role).toMatch(/required-start reads[\s\S]*conditional\s+references with concrete triggers/)
  })

  test("Coordination consumes compact plans and returns planning corrections through the user", async () => {
    const role = await readFile(join(DEFAULT_SOURCE_ROOT, "skills", "sane-coordination-assistant-role", "SKILL.md"), "utf8")
    expect(role).toMatch(/follows list order sequentially by default/)
    expect(role).toMatch(/run in parallel only when the approved plan\s+explicitly permits/)
    expect(role).toMatch(/runnable batch is a set of Jobs that can be launched together/i)
    expect(role).toMatch(/launch exactly one `sane\/worker\/implementer`\s+agent per attempt/)
    expect(role).toMatch(/Do not change Foundation approvals or Stage Design or Execution entries/)
    expect(role).toMatch(/planning corrections/)
    expect(role).toMatch(/goes to Planning through the user/)
    expect(role).toMatch(/After every Job in the batch has returned, launch one read-only/)
    expect(role).toContain("Confirm the applicable scope and attempt limit")
    expect(role).toMatch(/does not let the assistant\s+accept a Job outcome/)
    expect(role).toMatch(/only the user can set its final.*Approved.*Cancelled/i)
    expect(role).toMatch(/Stage Spec and Job Spec outcomes and handoff\s+obligations are addressed by actual reports and reviews/)
    expect(role).not.toMatch(/Job.Group|Stage Handoff Requirements|CAN edit/)
    for (const path of ["implementation/reports/", "implementation/briefs/STAGE_<two-digit-id>.md", "[~] Active", "[!] Blocked", "[✓] Approved", "[x] Cancelled"]) {
      expect(role).toContain(path)
    }
  })

  test("implementation and review contracts use guided context while preserving independent bounded quality", async () => {
    const agent = (name: string) => readFile(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", `sane-worker-${name}.md`), "utf8")
    const [implementer, reviewer, fixer, grounder, coordination] = await Promise.all([
      agent("implementer"), agent("reviewer"), agent("fixer"), agent("grounder"),
      readFile(join(DEFAULT_SOURCE_ROOT, "skills", "sane-coordination-assistant-role", "SKILL.md"), "utf8"),
    ])
    expect(grounder).toMatch(/conditional references with concrete triggers/)
    expect(grounder).toContain("hard read cap")
    expect(fixer).toMatch(/material missing, stale, or contradictory\s+planning context/i)
    expect(implementer).toMatch(/expected implementation surface/)
    expect(implementer).toMatch(/directly coupled defects or omissions/)
    expect(implementer).toMatch(/Create or update the report only at the supplied destination/)
    expect(coordination).toMatch(/## Required Context/)
    expect(coordination).toMatch(/## Optional Context/)
    expect(coordination).toMatch(/Report evidence:[\s\S]{0,120}only as needed to verify report/)
    expect(reviewer).toMatch(/Design Section\s+Spec\(s\), Job Spec\(s\), and bounded instructions/)
    expect(reviewer).toMatch(/independently inspect actual code, tests, and evidence/)
    expect(reviewer).toMatch(/Treat supplied implementation summaries[\s\S]{0,120}assertions to verify independently/)
    expect(reviewer).toMatch(/Do not expand the review into unrelated code/)
    expect(reviewer).toContain("self-fulfilling")
    expect(reviewer).toContain("criterion-level evidence")
    expect(reviewer).toContain("edit: deny")
    expect(reviewer).toMatch(/Keep the review isolated and read-only/)
    expect(reviewer).toMatch(/ordered by severity/)
    expect(fixer).toMatch(/never edit them, even for factual corrections/)
    expect(fixer).toContain("Planning handoff")
    expect(fixer).toContain("preserving its required structure")
  })

  test("Job Grounder grants no delegation or conversation and limits enrichment to the assigned spec", async () => {
    const grounder = await readFile(join(DEFAULT_SOURCE_ROOT, "opencode", "agents", "sane/worker/grounder.md"), "utf8")
    const metadata = Bun.YAML.parse(grounder.split("---")[1]!) as { mode: string; permission: Record<string, unknown> }
    expect(metadata.mode).toBe("subagent")
    expect(metadata.permission).toMatchObject({
      ask: "deny", question: "deny", task: "deny", webfetch: "deny", websearch: "deny",
      edit: "allow", skill: { "*": "allow", "sane-*-assistant-role": "deny" },
    })
    expect(grounder).toContain("# Job Grounder")
    expect(grounder).toMatch(/only edit the specs given to you in the workstream repository/)
    expect(grounder).toMatch(/Enrich the specs in place/)
    expect(grounder).toMatch(/one existing writable spec path/)
    expect(grounder).toMatch(/exact read-only context paths, confirmed boundaries and dependencies/)
    expect(grounder).toMatch(/conditional references with concrete triggers/)
    expect(grounder).toMatch(/hard read cap/)
    expect(grounder).toMatch(/Explain how expected predecessor\s+outputs connect/)
    expect(grounder).toMatch(/Verify command definitions against\s+actual repository scripts/)
    expect(grounder).toMatch(/blocker instead of discovering the wider workstream or creating another file/)
    expect(grounder).toMatch(/read-only inspection of the implementation repository/)
    expect(grounder).toMatch(/Return a summary to Planning/)
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
