import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INSTALL_COMMAND_PATH = join(import.meta.dir, "..", "src", "commands", "install.ts")

describe("ag install tools", () => {
  let tempHome: string
  let sourceToolsDir: string
  let targetToolsDir: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "agenv-install-tools-"))
    sourceToolsDir = join(tempHome, "agenv", "agent", "tools")
    targetToolsDir = join(tempHome, ".config", "opencode", "tools")

    await mkdir(sourceToolsDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  test("installs tool files but skips test and spec artifacts", async () => {
    await writeFile(join(sourceToolsDir, "workstream.ts"), "export const tool = true\n")
    await writeFile(join(sourceToolsDir, "README.md"), "# tool docs\n")
    await writeFile(join(sourceToolsDir, "workstream.test.ts"), "throw new Error('should not install')\n")
    await writeFile(join(sourceToolsDir, "helper.spec.js"), "throw new Error('should not install')\n")

    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import { main } from ${JSON.stringify(INSTALL_COMMAND_PATH)}; main(["bun", "ag-install", "tools", "--opencode"])`,
      ],
      {
        cwd: tempHome,
        env: {
          ...process.env,
          HOME: tempHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain("Installed 2 tools")
    expect(existsSync(join(targetToolsDir, "workstream.ts"))).toBe(true)
    expect(existsSync(join(targetToolsDir, "README.md"))).toBe(true)
    expect(existsSync(join(targetToolsDir, "workstream.test.ts"))).toBe(false)
    expect(existsSync(join(targetToolsDir, "helper.spec.js"))).toBe(false)
    expect(await readFile(join(targetToolsDir, "workstream.ts"), "utf-8")).toContain("tool = true")
  })
})
