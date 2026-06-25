import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readlink, readFile, symlink } from "node:fs/promises"
import { existsSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const AGENV_ROOT = join(import.meta.dir, "..", "..", "..")

describe("install.sh", () => {
  let tempDir: string
  let mockHome: string
  let mockAgenvHome: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-install-test-"))
    mockHome = tempDir
    mockAgenvHome = join(mockHome, "agenv")

    // Create mock agenv structure
    await mkdir(join(mockAgenvHome, "bin"), { recursive: true })
    await mkdir(join(mockAgenvHome, "packages", "cli", "bin"), { recursive: true })
    await mkdir(join(mockAgenvHome, "packages", "workstreams", "bin"), { recursive: true })

    // Create mock CLI files
    await writeFile(
      join(mockAgenvHome, "packages", "cli", "bin", "ag.ts"),
      "#!/usr/bin/env bun\nconsole.log('ag')",
    )
    await writeFile(
      join(mockAgenvHome, "packages", "workstreams", "bin", "work.ts"),
      "#!/usr/bin/env bun\nconsole.log('work')",
    )

    // Create mock package.json
    await writeFile(
      join(mockAgenvHome, "package.json"),
      JSON.stringify({ name: "agenv", workspaces: ["packages/*"] }),
    )

    // Create mock shell config files
    await writeFile(join(mockHome, ".zshrc"), "# existing zshrc\n")
    await writeFile(join(mockHome, ".bashrc"), "# existing bashrc\n")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function runInstallScript(
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const installScript = join(AGENV_ROOT, "install.sh")

    const proc = Bun.spawn(["bash", installScript, ...args], {
      cwd: mockAgenvHome,
      env: {
        ...process.env,
        HOME: mockHome,
        AGENV_HOME: mockAgenvHome,
        SHELL: "/bin/zsh",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { exitCode, stdout, stderr }
  }

  describe("symlink creation", () => {
    test("creates ag symlink", async () => {
      const { exitCode } = await runInstallScript()

      expect(exitCode).toBe(0)

      const agSymlink = join(mockAgenvHome, "bin", "ag")
      expect(existsSync(agSymlink)).toBe(true)
      expect(lstatSync(agSymlink).isSymbolicLink()).toBe(true)

      const target = await readlink(agSymlink)
      expect(target).toBe(join(mockAgenvHome, "packages", "cli", "bin", "ag.ts"))
    })

    test("creates work symlink", async () => {
      const { exitCode } = await runInstallScript()

      expect(exitCode).toBe(0)

      const workSymlink = join(mockAgenvHome, "bin", "work")
      expect(existsSync(workSymlink)).toBe(true)
      expect(lstatSync(workSymlink).isSymbolicLink()).toBe(true)

      const target = await readlink(workSymlink)
      expect(target).toBe(join(mockAgenvHome, "packages", "workstreams", "bin", "work.ts"))
    })

    test("removes legacy plan symlink if it exists", async () => {
      // Create legacy plan symlink using Node's symlink function
      const planSymlink = join(mockAgenvHome, "bin", "plan")
      // Point to an existing file so lstat works properly
      const existingFile = join(mockAgenvHome, "packages", "cli", "bin", "ag.ts")
      await symlink(existingFile, planSymlink)

      // Use try/catch with lstatSync to check if symlink exists (existsSync follows symlinks)
      let symlinkExists = false
      try {
        const stat = lstatSync(planSymlink)
        symlinkExists = stat.isSymbolicLink()
      } catch {
        symlinkExists = false
      }
      expect(symlinkExists).toBe(true)

      const { exitCode, stdout } = await runInstallScript()

      expect(exitCode).toBe(0)
      expect(stdout).toContain("Removing legacy plan symlink")

      // After install, the plan symlink should be removed
      let symlinkStillExists = false
      try {
        lstatSync(planSymlink)
        symlinkStillExists = true
      } catch {
        symlinkStillExists = false
      }
      expect(symlinkStillExists).toBe(false)
    })
  })

  describe("shell config detection", () => {
    test("adds PATH to .zshrc for zsh shell", async () => {
      const { exitCode } = await runInstallScript([], { SHELL: "/bin/zsh" })

      expect(exitCode).toBe(0)

      const zshrc = await readFile(join(mockHome, ".zshrc"), "utf-8")
      expect(zshrc).toContain("agenv/bin")
      expect(zshrc).toContain("export PATH")
    })

    test("adds PATH to .bashrc for bash shell", async () => {
      const { exitCode } = await runInstallScript([], { SHELL: "/bin/bash" })

      expect(exitCode).toBe(0)

      const bashrc = await readFile(join(mockHome, ".bashrc"), "utf-8")
      expect(bashrc).toContain("agenv/bin")
      expect(bashrc).toContain("export PATH")
    })

    test("does not duplicate PATH if already configured", async () => {
      // Pre-configure PATH in .zshrc
      await writeFile(
        join(mockHome, ".zshrc"),
        '# existing zshrc\nexport PATH="$HOME/agenv/bin:$PATH"\n',
      )

      const { exitCode, stdout } = await runInstallScript()

      expect(exitCode).toBe(0)
      expect(stdout).toContain("PATH already configured")

      const zshrc = await readFile(join(mockHome, ".zshrc"), "utf-8")
      // Should only appear once
      const matches = zshrc.match(/agenv\/bin/g)
      expect(matches?.length).toBe(1)
    })
  })

  describe("output messages", () => {
    test("shows success message with available commands", async () => {
      const { exitCode, stdout } = await runInstallScript()

      expect(exitCode).toBe(0)
      expect(stdout).toContain("AgEnv installed successfully!")
      expect(stdout).toContain("ag work")
      expect(stdout).toContain("ag install skills")
      expect(stdout).toContain("work")
    })

    test("shows symlink creation messages", async () => {
      const { stdout } = await runInstallScript()

      expect(stdout).toContain("Creating ag command symlink")
      expect(stdout).toContain("Creating work command symlink")
    })

    test("shows immediate shell usage instructions", async () => {
      const { stdout } = await runInstallScript()

      expect(stdout).toContain("To use now in this shell")
      expect(stdout).toContain("rehash 2>/dev/null || hash -r 2>/dev/null || true")
      expect(stdout).toContain(`${mockAgenvHome}/bin`)
    })
  })

  describe("--skills-only flag", () => {
    test("skips CLI setup when --skills-only is passed", async () => {
      // Note: This test may fail if bun/ag commands are not available
      // We just verify the script logic recognizes the flag
      const { stdout } = await runInstallScript(["--skills-only"])

      // Should not contain regular installation messages
      expect(stdout).not.toContain("Creating ag command symlink")
    })
  })
})

describe("shell config detect_shell_config function", () => {
  test.each([
    ["/bin/zsh", ".zshrc"],
    ["/bin/bash", ".bashrc"],
    ["/usr/bin/zsh", ".zshrc"],
  ])("SHELL=%s should use %s", async (shell, expectedConfig) => {
    const tempDir = await mkdtemp(join(tmpdir(), "shell-detect-test-"))
    const mockHome = tempDir
    const mockAgenvHome = join(mockHome, "agenv")

    try {
      // Setup mock environment
      await mkdir(join(mockAgenvHome, "bin"), { recursive: true })
      await mkdir(join(mockAgenvHome, "packages", "cli", "bin"), { recursive: true })
      await mkdir(join(mockAgenvHome, "packages", "workstreams", "bin"), { recursive: true })

      await writeFile(
        join(mockAgenvHome, "packages", "cli", "bin", "ag.ts"),
        "#!/usr/bin/env bun\nconsole.log('ag')",
      )
      await writeFile(
        join(mockAgenvHome, "packages", "workstreams", "bin", "work.ts"),
        "#!/usr/bin/env bun\nconsole.log('work')",
      )
      await writeFile(
        join(mockAgenvHome, "package.json"),
        JSON.stringify({ name: "agenv" }),
      )

      // Create both shell configs
      await writeFile(join(mockHome, ".zshrc"), "# zshrc\n")
      await writeFile(join(mockHome, ".bashrc"), "# bashrc\n")

      const installScript = join(AGENV_ROOT, "install.sh")
      const proc = Bun.spawn(["bash", installScript], {
        cwd: mockAgenvHome,
        env: {
          ...process.env,
          HOME: mockHome,
          AGENV_HOME: mockAgenvHome,
          SHELL: shell,
        },
        stdout: "pipe",
        stderr: "pipe",
      })

      await proc.exited

      // Check which config file was modified
      const configPath = join(mockHome, expectedConfig)
      const content = await readFile(configPath, "utf-8")
      expect(content).toContain("agenv/bin")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("ag install profiles", () => {
  async function createMockAgenv(home: string): Promise<string> {
    const agenvHome = join(home, "agenv")

    await mkdir(join(agenvHome, "agent", "skills", "planning-work"), { recursive: true })
    await mkdir(join(agenvHome, "agent", "skills", "managing-work"), { recursive: true })
    await mkdir(join(agenvHome, "agent", "tools"), { recursive: true })

    await writeFile(
      join(agenvHome, "agent", "skills", "planning-work", "SKILL.md"),
      "---\nname: planning-work\n---\n",
    )
    await writeFile(
      join(agenvHome, "agent", "skills", "managing-work", "SKILL.md"),
      "---\nname: managing-work\n---\n",
    )
    await writeFile(
      join(agenvHome, "agent", "tools", "workstream.ts"),
      [
        "export const link_planning_session = {}",
        "export const launch_supervision_branch = {}",
      ].join("\n"),
    )

    return agenvHome
  }

  async function runAgInstall(
    home: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const agCli = join(AGENV_ROOT, "packages", "cli", "bin", "ag.ts")
    const proc = Bun.spawn(["bun", agCli, "install", ...args], {
      cwd: AGENV_ROOT,
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { exitCode, stdout, stderr }
  }

  test("manual profile is the default and excludes management resources", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenv-install-profile-test-"))
    try {
      await createMockAgenv(tempDir)

      const skillsResult = await runAgInstall(tempDir, ["skills", "--opencode"])
      expect(skillsResult.exitCode).toBe(0)
      expect(existsSync(join(tempDir, ".config", "opencode", "skills", "planning-work"))).toBe(true)
      expect(existsSync(join(tempDir, ".config", "opencode", "skills", "managing-work"))).toBe(false)

      const toolsResult = await runAgInstall(tempDir, ["tools", "--opencode"])
      expect(toolsResult.exitCode).toBe(0)
      const installedTool = await readFile(
        join(tempDir, ".config", "opencode", "tools", "workstream.ts"),
        "utf-8",
      )
      expect(installedTool).not.toContain("export const launch_supervision_branch")
      expect(installedTool).toContain("const launch_supervision_branch")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("managed profile includes management resources", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenv-install-managed-profile-test-"))
    try {
      await createMockAgenv(tempDir)

      const skillsResult = await runAgInstall(tempDir, ["skills", "--opencode", "--profile", "managed"])
      expect(skillsResult.exitCode).toBe(0)
      expect(existsSync(join(tempDir, ".config", "opencode", "skills", "managing-work"))).toBe(true)

      const toolsResult = await runAgInstall(tempDir, ["tools", "--opencode", "--profile", "managed"])
      expect(toolsResult.exitCode).toBe(0)
      const installedTool = await readFile(
        join(tempDir, ".config", "opencode", "tools", "workstream.ts"),
        "utf-8",
      )
      expect(installedTool).toContain("export const launch_supervision_branch")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
