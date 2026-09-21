import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  AGENT_FILENAMES,
  AgentContextPackageInstallationError,
  OPENCODE_CONFIG_PACKAGE_FILENAME,
  OPENCODE_PLUGIN_DEPENDENCY,
  OPENCODE_PLUGIN_VERSION,
  PLUGIN_FILENAMES,
  PLUGIN_SRC_FILES,
  ROLE_SKILL_NAMES,
  installSaneAgentContextPackages,
  parseCliArguments,
  rewritePluginImports,
} from "../src/install-sane-agent-context-packages.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

function agentFixture(filename: string): string {
  return `---\nmode: subagent\npermission:\n  task: deny\n---\nagent ${filename}\n`
}

function pluginIndexFixture(): string {
  return `import { Plugin } from "@opencode/plugin"\nimport { openSaneDb } from "../../../packages/sane-cli/src/sane-db.ts"\nplugin sane/index.ts\n`
}

function pluginSrcFixture(filename: string): string {
  return `vendored ${filename}\n`
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
      await Bun.write(path, agentFixture(filename))
    }
    for (const skillName of ROLE_SKILL_NAMES) {
      const path = join(sourceRoot, "skills", skillName, "SKILL.md")
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, `skill ${skillName}\n`)
    }
    const pluginIndex = join(sourceRoot, "opencode", "plugins", "sane", "index.ts")
    await mkdir(dirname(pluginIndex), { recursive: true })
    await Bun.write(pluginIndex, pluginIndexFixture())
    for (const filename of PLUGIN_SRC_FILES) {
      const path = join(sourceRoot, "packages", "sane-cli", "src", filename)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, pluginSrcFixture(filename))
    }
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  function options(extra: { modelConfigPath?: string; dryRun?: boolean; overwrite?: boolean; write?: (line: string) => void } = {}) {
    return { homeDirectory, sourceRoot, write: () => {}, ...extra }
  }

  test("installs all eleven agents, all fifteen assistant lifecycle skills, the sane plugin, and the plugin runtime dep", async () => {
    const result = await installSaneAgentContextPackages(options())

    expect(result.dryRun).toBe(false)
    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.created).toHaveLength(38)
    for (const filename of AGENT_FILENAMES) {
      expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", filename), "utf8")).toBe(
        agentFixture(filename),
      )
    }
    for (const skillName of ROLE_SKILL_NAMES) {
      expect(await readFile(join(homeDirectory, ".agents", "skills", skillName, "SKILL.md"), "utf8")).toBe(
        `skill ${skillName}\n`,
      )
    }
    expect(PLUGIN_FILENAMES).toHaveLength(11)
    const installedIndex = join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts")
    expect(result.created).toContain(installedIndex)
    const installedContent = await readFile(installedIndex, "utf8")
    expect(installedContent).toBe(
      `import { Plugin } from "@opencode/plugin"\nimport { openSaneDb } from "./sane-src/sane-db.ts"\nplugin sane/index.ts\n`,
    )
    expect(installedContent).not.toContain("packages/sane-cli")
    for (const filename of PLUGIN_SRC_FILES) {
      const destination = join(
        homeDirectory,
        ".config",
        "opencode",
        "plugins",
        "sane",
        "sane-src",
        filename,
      )
      expect(result.created).toContain(destination)
      expect(await readFile(destination, "utf8")).toBe(pluginSrcFixture(filename))
    }
    const configPackage = join(
      homeDirectory,
      ".config",
      "opencode",
      OPENCODE_CONFIG_PACKAGE_FILENAME,
    )
    expect(result.created).toContain(configPackage)
    expect(JSON.parse(await readFile(configPackage, "utf8"))).toEqual({
      dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: OPENCODE_PLUGIN_VERSION },
    })
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
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[1]), "utf8")).toBe(agentFixture(AGENT_FILENAMES[1]))
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).unchanged).toHaveLength(38)
    await Bun.write(modelConfigPath, mapping("anthropic/claude-sonnet-4-6", "medium"))
    await expect(installSaneAgentContextPackages(options({ modelConfigPath }))).rejects.toThrow("--overwrite")
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "anthropic/claude-sonnet-4-6"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).unchanged).toHaveLength(38)
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
    for (const yaml of ["unknown: openai/gpt-5", "[]", "invalid: [", "sane/worker/scout: { model: openai/gpt-5, varient: low }", "sane/worker/scout:\n  model: openai/gpt-5\n  variant: null"]) {
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
    ).toBe(agentFixture(AGENT_FILENAMES[0]))
  })

  test("installs only listed skill resources with nested paths and exact bytes, then repeats unchanged", async () => {
    const skillName = "sane-assistant-execution-assistance"
    const files = ["FIX_AND_CORRECTION_POLICY.md", "nested/RETRY_POLICY.md", "nested/data.bin"]
    const contents = [Buffer.from("fix policy\n"), Buffer.from("retry policy\n"), Buffer.from([0, 255, 128, 10])]
    const destinations = files.map((file) => join(homeDirectory, ".agents", "skills", skillName, "resources", file))
    for (const [index, file] of files.entries()) {
      const source = join(sourceRoot, "skills", skillName, "resources", file)
      await mkdir(dirname(source), { recursive: true })
      await Bun.write(source, contents[index]!)
    }
    for (const file of [`${skillName}/other.txt`, "sane-execution-assistant-role/resources/legacy.md", "unlisted/resources/other.md"]) {
      const source = join(sourceRoot, "skills", file)
      await mkdir(dirname(source), { recursive: true })
      await Bun.write(source, "excluded\n")
    }
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    await Bun.write(modelConfigPath, "sane/worker/scout: openai/gpt-5\n")
    const result = await installSaneAgentContextPackages(options({ modelConfigPath }))
    expect(result.created).toHaveLength(41)
    for (const [index, destination] of destinations.entries()) {
      expect(result.created).toContain(destination)
      expect(await readFile(destination)).toEqual(contents[index]!)
    }
    await expectMissing(join(homeDirectory, ".agents", "skills", skillName, "other.txt"))
    await expectMissing(join(homeDirectory, ".agents", "skills", "sane-execution-assistant-role"))
    await expectMissing(join(homeDirectory, ".agents", "skills", "unlisted"))
    await expectMissing(join(homeDirectory, ".agents", "skills", ROLE_SKILL_NAMES[0], "resources"))
    const repeated = await installSaneAgentContextPackages(options({ modelConfigPath }))
    expect(repeated.created).toEqual([])
    expect(repeated.updated).toEqual([])
    expect(repeated.unchanged).toHaveLength(41)
  })

  test("resource files follow overwrite and dry-run semantics before any writes", async () => {
    const relative = join("skills", ROLE_SKILL_NAMES[0], "resources", "nested", "policy.md")
    const source = join(sourceRoot, relative)
    const destination = join(homeDirectory, ".agents", relative)
    await mkdir(dirname(source), { recursive: true })
    await Bun.write(source, "policy\n")
    expect((await installSaneAgentContextPackages(options({ dryRun: true }))).created).toContain(destination)
    await expectMissing(homeDirectory)
    await installSaneAgentContextPackages(options())
    await Bun.write(destination, "custom policy\n")
    const agentDestination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    await rm(agentDestination)
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("--overwrite")
    await expectMissing(agentDestination)
    const dryRun = await installSaneAgentContextPackages(options({ overwrite: true, dryRun: true }))
    expect(dryRun.updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toBe("custom policy\n")
    await expectMissing(agentDestination)
    expect((await installSaneAgentContextPackages(options({ overwrite: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toBe("policy\n")
  })

  test.each(["file-root", "symlink-root", "symlink-file", "symlink-directory", "dangling-symlink"])("rejects invalid resource source %s before mutations", async (kind) => {
    const resources = join(sourceRoot, "skills", ROLE_SKILL_NAMES[0], "resources")
    const target = join(temporaryDirectory, "target")
    await mkdir(target)
    await Bun.write(join(target, "policy.md"), "policy\n")
    if (kind === "file-root") {
      await Bun.write(resources, "not a directory\n")
    } else if (kind === "symlink-root") {
      await symlink(target, resources)
    } else {
      await mkdir(join(resources, "nested"), { recursive: true })
      await Bun.write(join(resources, "valid.md"), "valid\n")
      await symlink(kind === "symlink-directory" ? target : join(target, kind === "symlink-file" ? "policy.md" : "missing"), join(resources, "nested", "invalid"))
    }
    for (const dryRun of [false, true]) {
      await expect(installSaneAgentContextPackages(options({ overwrite: true, dryRun }))).rejects.toBeInstanceOf(AgentContextPackageInstallationError)
      await expectMissing(homeDirectory)
    }
  })

  test.each(["directory", "symlink", "parent-symlink"])("rejects resource destination %s before other writes", async (kind) => {
    const relative = join("skills", ROLE_SKILL_NAMES[0], "resources", "nested", "policy.md")
    const source = join(sourceRoot, relative)
    const destination = join(homeDirectory, ".agents", relative)
    await mkdir(dirname(source), { recursive: true })
    await Bun.write(source, "policy\n")
    const target = join(temporaryDirectory, "target")
    await mkdir(target)
    await Bun.write(join(target, "policy.md"), "untouched\n")
    if (kind === "parent-symlink") {
      await mkdir(dirname(dirname(destination)), { recursive: true })
      await symlink(target, dirname(destination))
    } else {
      await mkdir(dirname(destination), { recursive: true })
      if (kind === "directory") await mkdir(destination)
      else await symlink(join(target, "policy.md"), destination)
    }
    await expect(installSaneAgentContextPackages(options({ overwrite: true }))).rejects.toBeInstanceOf(AgentContextPackageInstallationError)
    await expectMissing(join(homeDirectory, ".config"))
    expect(await readFile(join(target, "policy.md"), "utf8")).toBe("untouched\n")
  })

  test("repeats as a no-op when every destination is identical", async () => {
    await installSaneAgentContextPackages(options())
    const result = await installSaneAgentContextPackages(options())

    expect(result).toMatchObject({ created: [], updated: [] })
    expect(result.unchanged).toHaveLength(38)
  })

  test("dry run validates and reports plans without creating a home directory", async () => {
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))

    expect(result.dryRun).toBe(true)
    expect(result.created).toHaveLength(38)
    expect(lines).toContain("Dry run: no files or directories were modified.")
    expect(lines.filter((line) => line.startsWith("Planned:"))).toHaveLength(38)
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
    expect(await readFile(destination, "utf8")).toBe(agentFixture(filename))
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

  test("rejects invalid frontmatter task permissions before any destination write", async () => {
    const agentName = AGENT_FILENAMES[0].slice(0, -3)
    const source = join(sourceRoot, "opencode", "agents", AGENT_FILENAMES[0])
    const cases: [string, string][] = [
      [
        `---\nmode: primary\npermission:\n  task:\n    "*": deny\n    "sane/worker/nonexistent": allow\n---\nbody\n`,
        `Unknown agent in ${agentName} task permissions: sane/worker/nonexistent`,
      ],
      [
        `---\nmode: primary\npermission:\n  task:\n    "*": sometimes\n---\nbody\n`,
        `Invalid decision for * in ${agentName} task permissions: expected allow, ask, or deny.`,
      ],
      [
        `---\nmode: subagent\npermission:\n  task: maybe\n---\nbody\n`,
        `Invalid decision for * in ${agentName} task permissions: expected allow, ask, or deny.`,
      ],
      [
        `---\nmode: subagent\npermission:\n  task:\n    - deny\n---\nbody\n`,
        `Agent ${agentName} task permissions must be deny or a mapping of agent names to decisions.`,
      ],
      [`no frontmatter here\n`, `Agent ${agentName} must have YAML frontmatter.`],
    ]
    for (const [content, message] of cases) {
      await Bun.write(source, content)
      await expect(installSaneAgentContextPackages(options({ overwrite: true }))).rejects.toThrow(message)
      await expectMissing(homeDirectory)
    }

    await Bun.write(
      source,
      `---\nmode: primary\npermission:\n  task:\n    "*": deny\n    "sane/worker/scout": ask\n---\nbody\n`,
    )
    const result = await installSaneAgentContextPackages(options())
    expect(result.created).toHaveLength(38)
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0]), "utf8"))
      .toContain('"sane/worker/scout": ask')
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

  test("preserves unrelated legacy files and repeats unchanged", async () => {
    const oldAgent = join(homeDirectory, ".config", "opencode", "agents", "sane-assistant-execution.md")
    const oldSkill = join(homeDirectory, ".agents", "skills", "sane-feature-product-assistant-role", "SKILL.md")
    for (const path of [oldAgent, oldSkill]) {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, "preserve local execution customization\n")
    }
    const installOptions = { ...options(), overwrite: true }
    const dryRun = await installSaneAgentContextPackages({ ...installOptions, dryRun: true })
    expect(dryRun.created).toHaveLength(38)
    expect(dryRun.updated).toEqual([])
    const planningDestination = join(homeDirectory, ".config", "opencode", "agents", "sane/assistant/planning.md")
    await expectMissing(planningDestination)
    const result = await installSaneAgentContextPackages(installOptions)
    expect(result.created).toEqual(dryRun.created)
    expect(await readFile(planningDestination, "utf8")).toBe(
      await readFile(join(sourceRoot, "opencode", "agents", "sane/assistant/planning.md"), "utf8"),
    )
    expect((await installSaneAgentContextPackages(installOptions)).unchanged).toHaveLength(38)
    for (const path of [oldAgent, oldSkill]) {
      expect(await readFile(path, "utf8")).toBe("preserve local execution customization\n")
    }
  })

  test("obsolete execution model keys fail before any destination write", async () => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    await Bun.write(modelConfigPath, "sane-assistant-legacy: { model: openai/gpt-5.6-sol, variant: low }\n")
    await expect(installSaneAgentContextPackages({ homeDirectory, modelConfigPath, write: () => {} }))
      .rejects.toThrow("Unknown agent in model config: sane-assistant-legacy")
    await expectMissing(homeDirectory)
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

  test("rewritePluginImports rewrites only the sane-cli source prefix", () => {
    expect(
      rewritePluginImports(
        `import { a } from "../../../packages/sane-cli/src/sane-db.ts"\nimport { Plugin } from "@opencode/plugin"\n`,
      ),
    ).toBe(`import { a } from "./sane-src/sane-db.ts"\nimport { Plugin } from "@opencode/plugin"\n`)
  })

  test("rejects a missing plugin source before making any destination mutation", async () => {
    await rm(join(sourceRoot, "opencode", "plugins", "sane", "index.ts"))
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("Required source")
    await expectMissing(homeDirectory)

    await Bun.write(join(sourceRoot, "opencode", "plugins", "sane", "index.ts"), pluginIndexFixture())
    await rm(join(sourceRoot, "packages", "sane-cli", "src", PLUGIN_SRC_FILES[0]))
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("Required source")
    await expectMissing(homeDirectory)
  })

  test("plugin files follow the same overwrite and dry-run semantics", async () => {
    const lines: string[] = []
    const dryRun = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))
    expect(dryRun.created).toHaveLength(38)
    await expectMissing(homeDirectory)

    await installSaneAgentContextPackages(options())
    const installedIndex = join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts")
    await Bun.write(installedIndex, "user content\n")
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("--overwrite")
    expect(await readFile(installedIndex, "utf8")).toBe("user content\n")
    const result = await installSaneAgentContextPackages(options({ overwrite: true }))
    expect(result.updated).toContain(installedIndex)
    expect(await readFile(installedIndex, "utf8")).toContain("./sane-src/")
  })

  test("uses the source package.json plugin version for the config package dep", async () => {
    await Bun.write(
      join(sourceRoot, "package.json"),
      JSON.stringify({ devDependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "^9.9.9" } }),
    )
    await installSaneAgentContextPackages(options())
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    expect(JSON.parse(await readFile(configPackage, "utf8"))).toEqual({
      dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "^9.9.9" },
    })
  })

  test("merges the plugin dep into an existing config package without touching other keys", async () => {
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    await mkdir(dirname(configPackage), { recursive: true })
    await Bun.write(
      configPackage,
      JSON.stringify({ name: "user-config", dependencies: { "some-other": "^1.0.0" } }, null, 2),
    )

    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("--overwrite")
    expect(JSON.parse(await readFile(configPackage, "utf8"))).toEqual({
      name: "user-config",
      dependencies: { "some-other": "^1.0.0" },
    })

    const result = await installSaneAgentContextPackages(options({ overwrite: true }))
    expect(result.updated).toContain(configPackage)
    expect(JSON.parse(await readFile(configPackage, "utf8"))).toEqual({
      name: "user-config",
      dependencies: {
        "some-other": "^1.0.0",
        [OPENCODE_PLUGIN_DEPENDENCY]: OPENCODE_PLUGIN_VERSION,
      },
    })
    expect((await installSaneAgentContextPackages(options({ overwrite: true }))).unchanged).toContain(
      configPackage,
    )
  })

  test("leaves a user-pinned plugin dep untouched and reports it unchanged", async () => {
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    await mkdir(dirname(configPackage), { recursive: true })
    const existing = `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "1.2.10" } }, null, 2)}\n`
    await Bun.write(configPackage, existing)

    const result = await installSaneAgentContextPackages(options())
    expect(result.created).toHaveLength(37)
    expect(result.unchanged).toContain(configPackage)
    expect(await readFile(configPackage, "utf8")).toBe(existing)
  })

  test("rejects a non-JSON config package before any destination write", async () => {
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    await mkdir(dirname(configPackage), { recursive: true })
    await Bun.write(configPackage, "not json\n")

    await expect(installSaneAgentContextPackages(options({ overwrite: true }))).rejects.toThrow(
      "not valid JSON",
    )
    expect(await readFile(configPackage, "utf8")).toBe("not json\n")
    await expectMissing(join(homeDirectory, ".config", "opencode", "agents"))
  })
})
