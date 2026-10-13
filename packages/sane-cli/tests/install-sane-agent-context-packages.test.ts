import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  AGENT_FILENAMES,
  AgentContextPackageInstallationError,
  GLOBAL_SUPPORT_SKILL_NAMES,
  OPENCODE_CONFIG_PACKAGE_FILENAME,
  OPENCODE_PLUGIN_DEPENDENCY,
  OPENCODE_PLUGIN_VERSION,
  PLUGIN_SRC_FILES,
  PLUGIN_CORE_SRC_FILES,
  ROLE_SKILL_NAMES,
  installSaneAgentContextPackages,
  parseCliArguments,
  rewritePluginImports,
  type AgentContextPackageInstallationOptions,
} from "../src/install-sane-agent-context-packages.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

function agentFixture(filename: string): string {
  return `---\nmode: subagent\npermission:\n  task: deny\n---\nagent ${filename}\n`
}

function pluginIndexFixture(): string {
  return `import { Plugin } from "@opencode/plugin"\n// NATIVE_CONTEXT_UNAVAILABLE\n`
}

function pluginSrcFixture(filename: string): string {
  return `vendored ${filename}\n`
}

describe("install-sane-agent-context-packages", () => {
  let temporaryDirectory: string
  let homeDirectory: string
  let sourceRoot: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(await realpath(tmpdir()), "sane-agent-context-packages-"))
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
    for (const skillName of GLOBAL_SUPPORT_SKILL_NAMES) {
      const path = join(sourceRoot, ".opencode", "skills", skillName, "SKILL.md")
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, `global skill ${skillName}\n`)
    }
    const pluginIndex = join(sourceRoot, "opencode", "plugins", "sane", "index.ts")
    await mkdir(dirname(pluginIndex), { recursive: true })
    await Bun.write(pluginIndex, pluginIndexFixture())
    for (const filename of ["execution.ts", "execution-rpc.ts"]) await Bun.write(join(dirname(pluginIndex), filename), pluginSrcFixture(filename))
    for (const filename of PLUGIN_SRC_FILES) {
      const path = join(sourceRoot, "packages", "sane-cli", "src", filename)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, pluginSrcFixture(filename))
    }
    for (const filename of PLUGIN_CORE_SRC_FILES) {
      const path = join(sourceRoot, "packages", "sane-core", "src", filename)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, pluginSrcFixture(filename))
    }
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  function options(extra: AgentContextPackageInstallationOptions = {}) {
    return { homeDirectory, sourceRoot, runtimeOnly: false, write: () => {}, ...extra }
  }

  const retiredNames = ["sane-design-assistant-role", "sane-engineering-assistant-role", "sane-planning-assistant-role", "sane-execution-assistant-role", "sane-research-assistant-role"]

  async function seedRetiredSkills(): Promise<string[]> {
    const paths = retiredNames.map((name) => join(homeDirectory, ".agents", "skills", name))
    for (const path of paths) {
      await mkdir(join(path, "local", "nested"), { recursive: true })
      await Bun.write(join(path, "SKILL.md"), "old role\n")
      await Bun.write(join(path, "local", "nested", "custom.txt"), "local contents\n")
    }
    return paths
  }

  test("removes all five retired skill directories and local contents, preserves other skills, and repeats safely", async () => {
    const retired = await seedRetiredSkills()
    const preserved = ["sane-legacy-role", "sane-design-assistant-role-custom", "sane-feature-design-assistant-role", ...ROLE_SKILL_NAMES]
    for (const name of preserved) {
      const path = join(homeDirectory, ".agents", "skills", name)
      await mkdir(path, { recursive: true })
      await Bun.write(join(path, "custom.txt"), "keep\n")
    }
    const outside = join(temporaryDirectory, "outside.txt")
    await Bun.write(outside, "outside\n")
    await symlink(outside, join(retired[0]!, "local", "link"))
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ write: (line) => lines.push(line) }))
    expect(result.removed).toEqual(retired)
    for (const path of retired) {
      await expectMissing(path)
      expect(lines).toContain(`Removed: ${path}`)
    }
    for (const name of preserved) expect(await readFile(join(homeDirectory, ".agents", "skills", name, "custom.txt"), "utf8")).toBe("keep\n")
    for (const name of ROLE_SKILL_NAMES) expect(await readFile(join(homeDirectory, ".agents", "skills", name, "SKILL.md"), "utf8")).toBe(`skill ${name}\n`)
    expect(await readFile(outside, "utf8")).toBe("outside\n")
    expect(await installSaneAgentContextPackages(options())).toMatchObject({ created: [], updated: [], removed: [] })
  })

  test("dry run reports all retired directories without installing or removing contents", async () => {
    const retired = await seedRetiredSkills()
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))
    expect(result.removed).toEqual(retired)
    for (const path of retired) {
      expect(lines).toContain(`Planned removal: ${path}`)
      expect(await readFile(join(path, "local", "nested", "custom.txt"), "utf8")).toBe("local contents\n")
    }
    await expectMissing(join(homeDirectory, ".config"))
    await expectMissing(join(homeDirectory, ".agents", "skills", ROLE_SKILL_NAMES[0]))
  })

  test.each(["missing-source", "conflict", "invalid-config"])("installation preflight failure %s leaves retired skills intact", async (kind) => {
    const retired = await seedRetiredSkills()
    if (kind === "missing-source") await rm(join(sourceRoot, "skills", ROLE_SKILL_NAMES[0], "SKILL.md"))
    else {
      const destination = kind === "conflict"
        ? join(homeDirectory, ".agents", "skills", ROLE_SKILL_NAMES[0], "SKILL.md")
        : join(homeDirectory, ".config", "opencode", "package.json")
      await mkdir(dirname(destination), { recursive: true })
      await Bun.write(destination, "invalid\n")
    }
    await expect(installSaneAgentContextPackages(options())).rejects.toBeInstanceOf(AgentContextPackageInstallationError)
    for (const path of retired) expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("old role\n")
    await expectMissing(join(homeDirectory, ".config", "opencode", "agents"))
  })

  test.each(["file", "symlink", "dangling-symlink", "ancestor-symlink"])("rejects unsafe retired target %s before any writes or cleanup", async (kind) => {
    const retired = await seedRetiredSkills()
    const target = retired[4]!
    await rm(target, { recursive: true })
    const outside = join(temporaryDirectory, "outside")
    await mkdir(outside)
    await Bun.write(join(outside, "keep.txt"), "keep\n")
    if (kind === "file") await Bun.write(target, "keep\n")
    else if (kind === "ancestor-symlink") {
      await rm(join(homeDirectory, ".agents"), { recursive: true })
      await mkdir(join(outside, "skills", retiredNames[4]!), { recursive: true })
      await symlink(outside, join(homeDirectory, ".agents"))
    } else await symlink(kind === "symlink" ? outside : join(outside, "missing"), target)
    for (const dryRun of [false, true]) {
      await expect(installSaneAgentContextPackages(options({ overwrite: true, dryRun }))).rejects.toBeInstanceOf(AgentContextPackageInstallationError)
      await expectMissing(join(homeDirectory, ".config"))
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n")
      if (kind !== "ancestor-symlink") expect(await readFile(join(retired[0]!, "SKILL.md"), "utf8")).toBe("old role\n")
    }
  })

  test("installs listed agents and skills, the sane plugin, and the plugin runtime dep", async () => {
    const result = await installSaneAgentContextPackages(options())

    expect(result.dryRun).toBe(false)
    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual([])
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
    for (const skillName of GLOBAL_SUPPORT_SKILL_NAMES) {
      const destination = join(homeDirectory, ".config", "opencode", "skills", skillName, "SKILL.md")
      expect(result.created).toContain(destination)
      expect(await readFile(destination, "utf8")).toBe(`global skill ${skillName}\n`)
    }
    const installedIndex = join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts")
    expect(result.created).toContain(installedIndex)
    const installedContent = await readFile(installedIndex, "utf8")
    expect(installedContent).toBe(
      pluginIndexFixture(),
    )
    expect(installedContent).not.toContain("packages/sane-cli")
    for (const filename of ["execution.ts", "execution-rpc.ts"]) {
      const destination = join(dirname(installedIndex), filename)
      expect(result.created).toContain(destination)
      expect(await readFile(destination, "utf8")).toBe(pluginSrcFixture(filename))
    }
    for (const filename of PLUGIN_SRC_FILES) {
      const destination = join(
        homeDirectory,
        ".config",
        "opencode",
        "plugins",
        "sane",
        "runtime", "packages", "sane-cli", "src",
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
      dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: OPENCODE_PLUGIN_VERSION, "@opencode/client": "2.0.18", "@modelcontextprotocol/sdk": "^1.25.0" },
    })
  })

  test.each([false, true])("actual repository packaging loads the shared-domain native closure (runtime-only: %s)", async runtimeOnly => {
    await installSaneAgentContextPackages({ homeDirectory, runtimeOnly, write: () => {} })
    const installed = join(homeDirectory, ".config", "opencode", "plugins", "sane")
    // Bundlers do not traverse the URL-based repository reader worker entrypoint.
    const reader = await readFile(join(installed, "runtime/packages/sane-core/src/repository-reader.ts"), "utf8")
    expect(reader).toContain("repository-reader-worker.ts")
    const content = await readFile(join(installed, "index.ts"), "utf8")
    expect(content).toBe(rewritePluginImports(await readFile(join(import.meta.dir, "../../../opencode/plugins/sane/index.ts"), "utf8")))
    expect(content).not.toMatch(/sane-db|sane-src|sane-handoff-tool/)
    await expectMissing(join(installed, "sane-src"))
    await expectMissing(join(installed, "sane-core"))
    const modules = join(homeDirectory, ".config/opencode/node_modules")
    await mkdir(join(modules, "@opencode"), { recursive: true })
    await mkdir(join(modules, "@modelcontextprotocol"), { recursive: true })
    await symlink(join(import.meta.dir, "../../../node_modules/@opencode/plugin"), join(modules, "@opencode/plugin"))
    await symlink(join(import.meta.dir, "../node_modules/@opencode/client"), join(modules, "@opencode/client"))
    await symlink(join(import.meta.dir, "../node_modules/@modelcontextprotocol/sdk"), join(modules, "@modelcontextprotocol/sdk"))
    const workerBuild = await Bun.build({ entrypoints: [join(installed, "runtime/packages/sane-core/src/repository-reader-worker.ts")], target: "bun" })
    expect(workerBuild.success).toBe(true)
    const { SanePlugin } = await import(join(installed, "index.ts"))
    expect(typeof SanePlugin.setup).toBe("function")
    const execution = await import(join(installed, "execution.ts"))
    expect(typeof execution.registerExecutionOperations).toBe("function")
    expect((await import(join(installed, "execution-rpc.ts"))).SaneExecution).toBeDefined()
    await expectMissing(join(installed, "runtime/packages/sane-app"))
    const built = await Bun.build({
      entrypoints: [join(installed, "index.ts"), ...["native-claude-mcp.ts", "native-claude-hook.ts"].map(name => join(installed, "runtime/packages/sane-cli/src", name))],
      target: "bun",
      packages: "external",
    })
    expect(built.success).toBe(true)
    for (const output of built.outputs) expect(await output.text()).not.toContain("canonical-agent-operations")
    const native = await import(join(installed, "runtime/packages/sane-cli/src/native-caller.ts"))
    expect(typeof native.openNativeCaller).toBe("function")
    const configuration = await import(join(installed, "runtime/packages/sane-cli/src/native-configuration.ts"))
    const generated = configuration.nativeIntegrationConfiguration({ pluginDirectory: installed, registrationFile: join(homeDirectory, "service.json"), profileRoot: homeDirectory, bindingRoot: join(homeDirectory, "bindings"), bunExecutable: process.execPath })
    expect(generated.opencode.plugins[0].package).toBe(installed)
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js")
    expect(typeof Server).toBe("function")
  })

  test("runtime-only provisions clean native integrations without reading or publishing role assets", async () => {
    for (const directory of ["opencode/agents", "skills", ".opencode/skills"]) await rm(join(sourceRoot, directory), { recursive: true })
    const result = await installSaneAgentContextPackages(options({ runtimeOnly: true }))
    expect(result.removed).toEqual([])
    for (const directory of [".agents", ".claude/agents", ".claude/skills", ".claude/sane-agent-settings", ".config/opencode/agents", ".config/opencode/skills"]) await expectMissing(join(homeDirectory, directory))
    const oc = await Bun.file(join(homeDirectory, ".config/opencode/opencode.json")).json()
    expect(oc.plugins).toEqual([{ package: join(homeDirectory, ".config/opencode/plugins/sane"), options: { registrationFile: join(homeDirectory, ".local/state/opencode/service.json"), appConnectionFile: join(sourceRoot, "packages/sane-app/.data/native-handoff.json") } }])
    const cc = await Bun.file(join(homeDirectory, ".claude.json")).json()
    expect(cc.mcpServers.sane).toEqual({ type: "stdio", command: process.execPath, args: [join(homeDirectory, ".config/opencode/plugins/sane/runtime/packages/sane-cli/src/native-claude-mcp.ts"), join(homeDirectory, ".claude"), join(homeDirectory, ".claude/sane-bindings"), join(sourceRoot, "packages/sane-app/.data/native-handoff.json")] })
    const settings = await Bun.file(join(homeDirectory, ".claude/settings.json")).json()
    expect(settings.hooks.PreToolUse[0].matcher).toContain("mcp__sane__sane_worker_start")
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("native-claude-hook.ts")
    expect(await installSaneAgentContextPackages(options({ runtimeOnly: true }))).toMatchObject({ created: [], updated: [], removed: [] })
  })

  test("ordinary API and CLI defaults publish no markdown and preserve custom integration paths on repeat", async () => {
    const custom = {
      runtimeOnly: true,
      registrationFile: join(temporaryDirectory, "custom/service.json"),
      appConnectionFile: join(sourceRoot, "packages/sane-app/.data-fresh/native-handoff.json"),
      bindingRoot: join(temporaryDirectory, "custom/bindings"),
      bunExecutable: "/custom/bun",
    }
    await installSaneAgentContextPackages(options(custom))
    const paths = [".config/opencode/opencode.json", ".claude.json", ".claude/settings.json"]
    const before = await Promise.all(paths.map(path => readFile(join(homeDirectory, path), "utf8")))
    for (const defaults of [{ runtimeOnly: undefined }, parseCliArguments([])]) {
      expect(await installSaneAgentContextPackages(options(defaults))).toMatchObject({ created: [], updated: [], removed: [] })
      expect(await Promise.all(paths.map(path => readFile(join(homeDirectory, path), "utf8")))).toEqual(before)
    }
    await expectMissing(join(homeDirectory, ".config/opencode/agents"))
    await expectMissing(join(homeDirectory, ".agents"))
    await expectMissing(join(homeDirectory, ".claude/agents"))
    const replacement = join(temporaryDirectory, "replacement/native-handoff.json")
    await installSaneAgentContextPackages(options({ runtimeOnly: true, appConnectionFile: replacement, overwrite: true }))
    expect(JSON.parse(await readFile(join(homeDirectory, paths[0]!), "utf8")).plugins[0].options.appConnectionFile).toBe(replacement)
    expect(JSON.parse(await readFile(join(homeDirectory, paths[1]!), "utf8")).mcpServers.sane.args[3]).toBe(replacement)
    expect(await readFile(join(homeDirectory, paths[2]!), "utf8")).toBe(before[2])
    const bindingRoot = join(temporaryDirectory, "replacement/bindings")
    await installSaneAgentContextPackages(options({ runtimeOnly: true, bindingRoot, overwrite: true }))
    const hooks = JSON.parse(await readFile(join(homeDirectory, paths[2]!), "utf8")).hooks.PreToolUse
    expect(hooks).toHaveLength(1)
    expect(hooks[0].hooks[0].command).toContain(bindingRoot)
    expect(await installSaneAgentContextPackages(options({ runtimeOnly: undefined }))).toMatchObject({ created: [], updated: [], removed: [] })
  })

  test("conflicting installed hook roots require an explicit root and normalize only owned hooks", async () => {
    await installSaneAgentContextPackages(options({ runtimeOnly: true }))
    const path = join(homeDirectory, ".claude/settings.json")
    const settings = JSON.parse(await readFile(path, "utf8"))
    const old = settings.hooks.PreToolUse[0]
    const unrelated = { matcher: "Bash", hooks: [{ type: "command", command: "/custom/unknown-hook" }] }
    settings.hooks.PreToolUse.push({ ...old, hooks: [{ ...old.hooks[0], command: old.hooks[0].command.replace(join(homeDirectory, ".claude/sane-bindings"), join(homeDirectory, ".data-fresh/native-bindings")) }] }, unrelated)
    const before = JSON.stringify(settings)
    await Bun.write(path, before)
    await expect(installSaneAgentContextPackages(options({ runtimeOnly: true, overwrite: true }))).rejects.toThrow("Conflicting installed SANE hook")
    expect(await readFile(path, "utf8")).toBe(before)
    const bindingRoot = join(homeDirectory, ".data-fresh/native-bindings")
    await installSaneAgentContextPackages(options({ runtimeOnly: true, bindingRoot, overwrite: true }))
    const hooks = JSON.parse(await readFile(path, "utf8")).hooks.PreToolUse
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toEqual(unrelated)
    expect(hooks[1].hooks[0].command).toContain(bindingRoot)
    expect(await installSaneAgentContextPackages(options({ runtimeOnly: true }))).toMatchObject({ created: [], updated: [], removed: [] })
  })

  test("runtime-only dry-run creates no home and preserves existing assets and unrelated configuration", async () => {
    const runtime = { runtimeOnly: true, registrationFile: join(temporaryDirectory, "registration.json"), appConnectionFile: join(temporaryDirectory, "app/native-handoff.json") }
    const dry = await installSaneAgentContextPackages(options({ ...runtime, dryRun: true }))
    expect(dry.created).toContain(join(homeDirectory, ".claude.json"))
    await expectMissing(homeDirectory)
    const retired = await seedRetiredSkills()
    const assets = [".config/opencode/agents/sane/assistant/design.md", ".claude/agents/sane-worker-scout.md", ".claude/skills/review-opencode-sessions/SKILL.md"]
    for (const asset of assets) { await mkdir(dirname(join(homeDirectory, asset)), { recursive: true }); await Bun.write(join(homeDirectory, asset), "custom\n") }
    const settings = { env: { KEEP: "yes" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-stop" }] }], PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "keep-read" }] }] } }
    await Bun.write(join(homeDirectory, ".claude/settings.json"), JSON.stringify(settings))
    await Bun.write(join(homeDirectory, ".claude.json"), JSON.stringify({ unrelated: true, mcpServers: { other: { command: "keep" } } }))
    await Bun.write(join(homeDirectory, ".config/opencode/opencode.json"), JSON.stringify({ model: "keep/model", plugins: ["other-plugin"] }))
    await expect(installSaneAgentContextPackages(options(runtime))).rejects.toThrow("--overwrite")
    await installSaneAgentContextPackages(options({ ...runtime, overwrite: true, dryRun: true }))
    expect(await Bun.file(join(homeDirectory, ".claude/settings.json")).json()).toEqual(settings)
    const result = await installSaneAgentContextPackages(options({ ...runtime, overwrite: true }))
    expect(result.removed).toEqual([])
    for (const asset of assets) expect(await readFile(join(homeDirectory, asset), "utf8")).toBe("custom\n")
    for (const path of retired) expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("old role\n")
    const mergedSettings = await Bun.file(join(homeDirectory, ".claude/settings.json")).json()
    expect(mergedSettings.env).toEqual(settings.env)
    expect(mergedSettings.hooks.Stop).toEqual(settings.hooks.Stop)
    expect(mergedSettings.hooks.PreToolUse[0]).toEqual(settings.hooks.PreToolUse[0])
    expect(mergedSettings.hooks.PreToolUse).toHaveLength(2)
    expect(await Bun.file(join(homeDirectory, ".claude.json")).json()).toMatchObject({ unrelated: true, mcpServers: { other: { command: "keep" } } })
    const oc = await Bun.file(join(homeDirectory, ".config/opencode/opencode.json")).json()
    expect(oc.model).toBe("keep/model")
    expect(oc.plugins[0]).toBe("other-plugin")
    expect(oc.plugins[1].options).toEqual({ registrationFile: runtime.registrationFile, appConnectionFile: runtime.appConnectionFile })
  })

  test("runtime-only CLI and API reject irrelevant combinations before writing", async () => {
    expect(parseCliArguments(["--runtime-only", "--dry-run"])).toEqual({ runtimeOnly: true, dryRun: true, overwrite: false })
    expect(parseCliArguments(["--runtime-only", "--app-connection-file", "/fixture/app.json"])).toMatchObject({ appConnectionFile: "/fixture/app.json" })
    expect(parseCliArguments(["--binding-root", "/bindings"])).toMatchObject({ runtimeOnly: true, bindingRoot: "/bindings" })
    for (const args of [["--runtime-only", "--only", "review-opencode-sessions"], ["--runtime-only", "--model-config", "models.yaml"], ["--legacy-assets", "--binding-root", "/bindings"]]) expect(() => parseCliArguments(args)).toThrow()
    for (const extra of [{ onlySkill: "review-opencode-sessions" as const }, { modelConfigPath: "missing" }]) await expect(installSaneAgentContextPackages(options({ runtimeOnly: true, ...extra }))).rejects.toThrow("--runtime-only")
    await expectMissing(homeDirectory)
  })

  test.each([".claude.json", ".claude/settings.json", ".config/opencode/opencode.json"])("runtime-only rejects invalid config %s before provisioning", async filename => {
    const path = join(homeDirectory, filename)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, "invalid JSON")
    await expect(installSaneAgentContextPackages(options({ runtimeOnly: true, overwrite: true }))).rejects.toThrow("not valid JSON")
    expect(await readFile(path, "utf8")).toBe("invalid JSON")
    await expectMissing(join(homeDirectory, ".config/opencode/plugins"))
  })

  test.each(["sane-src", "sane-core"])("obsolete %s closure blocks even overwrite without mutation", async (name) => {
    const stale = join(homeDirectory, ".config", "opencode", "plugins", "sane", name, "writer.ts")
    await mkdir(dirname(stale), { recursive: true })
    await Bun.write(stale, "obsolete writer")
    for (const dryRun of [true, false]) {
      await expect(installSaneAgentContextPackages(options({ overwrite: true, dryRun }))).rejects.toThrow("Obsolete native plugin closure")
      expect(await readFile(stale, "utf8")).toBe("obsolete writer")
      await expectMissing(join(homeDirectory, ".agents"))
    }
  })

  test("installs the global review skill alone without changing existing agent packages", async () => {
    const agent = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    await mkdir(dirname(agent), { recursive: true })
    await Bun.write(agent, "locally customized agent\n")
    const retired = await seedRetiredSkills()
    const destination = join(homeDirectory, ".config", "opencode", "skills", "review-opencode-sessions", "SKILL.md")
    const ccDestination = join(homeDirectory, ".claude", "skills", "review-opencode-sessions", "SKILL.md")

    const planned = await installSaneAgentContextPackages(options({ onlySkill: "review-opencode-sessions", dryRun: true }))
    expect(planned.created).toEqual([destination, ccDestination])
    await expectMissing(destination)

    const installed = await installSaneAgentContextPackages(options({ onlySkill: "review-opencode-sessions" }))
    expect(installed).toMatchObject({ created: [destination, ccDestination], updated: [], unchanged: [], removed: [] })
    expect(await readFile(destination, "utf8")).toBe("global skill review-opencode-sessions\n")
    expect(await readFile(ccDestination, "utf8")).toBe("global skill review-opencode-sessions\n")
    expect(await readFile(agent, "utf8")).toBe("locally customized agent\n")
    for (const path of retired) expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("old role\n")
    expect(await installSaneAgentContextPackages(options({ onlySkill: "review-opencode-sessions" })))
      .toMatchObject({ created: [], updated: [], unchanged: [destination, ccDestination], removed: [] })
  })

  test.each(["shorthand", "flow", "block", "model-only"])("applies %s YAML models before planning, without touching sources or unmapped files", async (form) => {
    const modelConfigPath = join(temporaryDirectory, "models.yaml")
    const source = join(sourceRoot, "opencode", "agents", AGENT_FILENAMES[0])
    const original = "---\nmode: primary\nvariant: high\n---\n\nOriginal body\n"
    const mapping = (model: string, variant: string) => `${AGENT_FILENAMES[0].slice(0, -3)}: ${form === "shorthand" ? model : form === "flow" ? `{ model: ${model}, variant: ${variant} }` : form === "block" ? `\n  model: ${model}\n  variant: ${variant}` : `{ model: ${model} }`}\n`
    await Bun.write(source, original)
    await Bun.write(modelConfigPath, mapping("openai/gpt-5", "low"))
    if (form === "flow") {
      await installSaneAgentContextPackages(options({ modelConfigPath, dryRun: true }))
      await expectMissing(homeDirectory)
    }
    await installSaneAgentContextPackages(options({ modelConfigPath }))
    const destination = join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    const installed = await readFile(destination, "utf8")
    expect(installed).toContain(form === "flow" || form === "block" ? 'variant: "low"' : "variant: high")
    expect(installed.endsWith("\nOriginal body\n")).toBe(true)
    expect(await readFile(source, "utf8")).toBe(original)
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[1]), "utf8")).toBe(agentFixture(AGENT_FILENAMES[1]))
    // Parsing/variant differences belong to this matrix; exercise the full
    // installer conflict/overwrite lifecycle once, using an object override.
    if (form !== "flow") return
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).updated).toEqual([])
    await Bun.write(modelConfigPath, mapping("anthropic/claude-sonnet-4-6", "medium"))
    await expect(installSaneAgentContextPackages(options({ modelConfigPath }))).rejects.toThrow("--overwrite")
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "openai/gpt-5"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('model: "anthropic/claude-sonnet-4-6"')
    expect((await installSaneAgentContextPackages(options({ modelConfigPath }))).updated).toEqual([])
    expect(await readFile(source, "utf8")).toBe(original)
    expect(await readFile(destination, "utf8")).toContain('variant: "medium"')
    await Bun.write(modelConfigPath, mapping("anthropic/claude-sonnet-4-6", "low"))
    expect((await installSaneAgentContextPackages(options({ modelConfigPath, overwrite: true, dryRun: true }))).updated).toEqual([destination])
    expect(await readFile(destination, "utf8")).toContain('variant: "medium"')
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
      await installSaneAgentContextPackages({ sourceRoot, runtimeOnly: false, write: () => {} })
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

  test("dry run validates and reports plans without creating a home directory", async () => {
    const lines: string[] = []
    const result = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))

    expect(result.dryRun).toBe(true)
    expect(lines).toContain("Dry run: no files or directories were modified.")
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
    expect(await readFile(join(homeDirectory, ".config", "opencode", "agents", AGENT_FILENAMES[0]), "utf8"))
      .toContain('"sane/worker/scout": ask')
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
    expect(dryRun.updated).toEqual([])
    const planningDestination = join(homeDirectory, ".config", "opencode", "agents", "sane/assistant/planning.md")
    await expectMissing(planningDestination)
    const result = await installSaneAgentContextPackages(installOptions)
    expect(result.created).toEqual(dryRun.created)
    expect(await readFile(planningDestination, "utf8")).toBe(
      await readFile(join(sourceRoot, "opencode", "agents", "sane/assistant/planning.md"), "utf8"),
    )
    expect((await installSaneAgentContextPackages(installOptions))).toMatchObject({ created: [], updated: [] })
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
    expect(parseCliArguments([])).toEqual({ dryRun: false, overwrite: false, runtimeOnly: true })
    expect(parseCliArguments(["--model-config", "two words.yaml", "--dry-run"])).toEqual({ dryRun: true, overwrite: false, runtimeOnly: false, modelConfigPath: "two words.yaml" })
    for (const args of [["--model-config"], ["--model-config", "--overwrite"], ["--model-config", ""], ["--model-config", "a", "--model-config", "b"]]) {
      expect(() => parseCliArguments(args)).toThrow("--model-config")
    }
    expect(parseCliArguments(["--dry-run", "--overwrite"])).toEqual({ dryRun: true, overwrite: true, runtimeOnly: true })
    expect(parseCliArguments(["--only", "review-opencode-sessions", "--dry-run"]))
      .toEqual({ dryRun: true, overwrite: false, runtimeOnly: false, onlySkill: "review-opencode-sessions" })
    expect(() => parseCliArguments(["--only", "other-skill"])).toThrow("--only requires")
    expect(() => parseCliArguments(["--only", "review-opencode-sessions", "--model-config", "models.yaml"]))
      .toThrow("cannot be combined")
    expect(() => parseCliArguments(["destination"])).toThrow("does not accept positional")
    expect(() => parseCliArguments(["--unexpected"])).toThrow("Unknown option")
    expect(() => parseCliArguments(["--", "destination"])).toThrow("does not accept positional")
  })

  test("rewritePluginImports rewrites only the sane-cli source prefix", () => {
    expect(
      rewritePluginImports(
        `import { a } from "../../../packages/sane-cli/src/native-caller.ts"\nimport { Plugin } from "@opencode/plugin"\n`,
      ),
    ).toBe(`import { a } from "./runtime/packages/sane-cli/src/native-caller.ts"\nimport { Plugin } from "@opencode/plugin"\n`)
  })

  test("rejects a missing plugin source before making any destination mutation", async () => {
    await rm(join(sourceRoot, "opencode", "plugins", "sane", "index.ts"))
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("Required source")
    await expectMissing(homeDirectory)

  })

  test("plugin files follow the same overwrite and dry-run semantics", async () => {
    const lines: string[] = []
    const dryRun = await installSaneAgentContextPackages(options({ dryRun: true, write: (line) => lines.push(line) }))
    await expectMissing(homeDirectory)

    await installSaneAgentContextPackages(options())
    const installedIndex = join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts")
    await Bun.write(installedIndex, "user content\n")
    await expect(installSaneAgentContextPackages(options())).rejects.toThrow("--overwrite")
    expect(await readFile(installedIndex, "utf8")).toBe("user content\n")
    const result = await installSaneAgentContextPackages(options({ overwrite: true }))
    expect(result.updated).toContain(installedIndex)
    expect(await readFile(installedIndex, "utf8")).toContain("NATIVE_CONTEXT_UNAVAILABLE")
  })

  test("uses the source package.json plugin version for the config package dep", async () => {
    await Bun.write(
      join(sourceRoot, "package.json"),
      JSON.stringify({ devDependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "^9.9.9" } }),
    )
    await installSaneAgentContextPackages(options())
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    expect(JSON.parse(await readFile(configPackage, "utf8"))).toEqual({
      dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "^9.9.9", "@opencode/client": "2.0.18", "@modelcontextprotocol/sdk": "^1.25.0" },
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
        "@opencode/client": "2.0.18",
        "@modelcontextprotocol/sdk": "^1.25.0",
      },
    })
    expect((await installSaneAgentContextPackages(options({ overwrite: true }))).unchanged).toContain(
      configPackage,
    )
  })

  test("leaves a user-pinned plugin dep untouched and reports it unchanged", async () => {
    const configPackage = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
    await mkdir(dirname(configPackage), { recursive: true })
    const existing = `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: "1.2.10", "@opencode/client": "2.0.18", "@modelcontextprotocol/sdk": "^1.25.0" } }, null, 2)}\n`
    await Bun.write(configPackage, existing)

    const result = await installSaneAgentContextPackages(options())
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
