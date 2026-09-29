import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, access, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { USAGE, runSaneAlpha } from "./sane.ts"

describe("sane dispatcher", () => {
  test("direct and dispatched installers accept YAML config and report errors before writes", async () => {
    const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "sane-model-cli-")))
    try {
      const config = join(temporaryDirectory, "my models.yaml")
      await Bun.write(config, "sane/worker/scout: openai/gpt-5\n")
      for (const [index, command] of [
        ["packages/sane-cli/src/install-sane-agent-context-packages.ts"],
        ["bin/sane.ts", "install", "context-packages"],
      ].entries()) {
        const home = join(temporaryDirectory, `home-${index}`)
        const run = async (...args: string[]) => {
          const child = Bun.spawn([process.execPath, ...command, ...args], {
            cwd: new URL("../", import.meta.url).pathname,
            env: { ...process.env, SANE_HOME: home }, stdout: "pipe", stderr: "pipe",
          })
          const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
          return { exit, stdout, stderr }
        }
        const dryRun = await run("--model-config", config, "--dry-run")
        expect(dryRun.exit, dryRun.stderr).toBe(0)
        await expect(access(home)).rejects.toThrow()
        expect((await run("--model-config", config)).exit).toBe(0)
        expect(await readFile(join(home, ".config/opencode/agents/sane/worker/scout.md"), "utf8")).toContain('model: "openai/gpt-5"')
        expect((await run("--model-config", config)).stdout).not.toContain("Created:")
        const invalid = await run("--model-config", join(temporaryDirectory, "missing.yaml"))
        expect(invalid.exit).toBe(1)
        expect(invalid.stderr).toContain("Could not load model config")
        expect(invalid.stderr).toContain("--model-config <path>")
        expect((await run("--model-config")).exit).toBe(1)
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  test("advertises supported shared-core commands rather than candidate roots", () => {
    for (const command of ["init", "create", "select", "view", "status", "validate", "approve", "provide", "job", "research", "sessions", "authority", "conversation", "phase", "audit"]) expect(USAGE).toContain(command)
    expect(USAGE).not.toContain("--state-root")
  })

  test("rejects retired and malformed operations without injectable alternate handlers", async () => {
    expect(await runSaneAlpha(["candidate", "init"])).toBe(1)
    expect(await runSaneAlpha(["create", "--unknown"])).toBe(1)
  })

  test("prints help successfully and rejects an unknown command", async () => {
    expect(await runSaneAlpha([])).toBe(0)
    expect(await runSaneAlpha(["--help"])).toBe(0)
    expect(await runSaneAlpha(["not-an-alpha-command"])).toBe(1)
  })
})
