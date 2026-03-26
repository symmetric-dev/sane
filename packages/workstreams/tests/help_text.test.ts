import { describe, expect, test } from "bun:test"

import { main as workMain } from "../bin/work.ts"
import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

async function captureHelpOutput(run: () => void | Promise<void>) {
  const originalExit = process.exit

  process.exit = ((code?: number) => {
    throw new Error(`Process exited with code ${code ?? 0}`)
  }) as typeof process.exit

  try {
    return await captureCliOutput(async () => {
      try {
        await run()
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Process exited with code 0")) {
          throw error
        }
      }
    })
  } finally {
    process.exit = originalExit
  }
}

describe("draft-first help text", () => {
  test("work create help describes draft-first lifecycle", async () => {
    const { stdout, stderr } = await captureHelpOutput(() => {
      createMain(["bun", "work-create", "--help"])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toContain("Create a draft workstream container")
    expect(output).toContain("work create --name my-feature")
    expect(output).toContain("REQUIREMENTS.md")
    expect(output).toContain("resources/")
    expect(output).toContain("work validate requirements")
    expect(output).not.toContain("- files/")
    expect(output).toContain("work plan create --stages 3")
    expect(output).toContain("empty drafts warn but still succeed")
    expect(output).toContain("requires at least one stage")
  })

  test("validate and approve help reflect draft-plan semantics", async () => {
    const [{ stdout: validateStdout, stderr: validateStderr }, { stdout: approveStdout, stderr: approveStderr }] = await Promise.all([
      captureHelpOutput(() => validateMain(["bun", "work-validate", "--help"])),
      captureHelpOutput(() => approveMain(["bun", "work-approve", "--help"])),
    ])

    const validateOutput = validateStdout.join("\n")
    const approveOutput = approveStdout.join("\n")

    expect(validateStderr).toHaveLength(0)
    expect(approveStderr).toHaveLength(0)
    expect(validateOutput).toContain("work validate requirements")
    expect(validateOutput).toContain("requirements  Validate REQUIREMENTS.md structure and content")
    expect(validateOutput).toContain("Use 'work validate requirements' after updating REQUIREMENTS.md or files in resources/.")
    expect(validateOutput).toContain("Draft plans with an empty Stages section are valid")
    expect(approveOutput).toContain("requires at least one stage")
    expect(approveOutput).toContain("work plan create --stages <n>")
  })

  test("main CLI help advertises requirements validation and hides context", async () => {
    const { stdout, stderr } = await captureHelpOutput(() => {
      workMain(["bun", "work", "--help", "--show-all-commands"])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toMatch(/^\s+validate\s+Validate plan, tasks, or requirements$/m)
    expect(output).toContain("work validate requirements")
    expect(output).not.toMatch(/^\s+context\s+/m)
  })

  test("work context is no longer an available main CLI command", async () => {
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code ?? 0}`)
    }) as typeof process.exit

    try {
      const { stdout, stderr } = await captureCliOutput(() => {
        try {
          workMain(["bun", "work", "context"])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      expect(stdout).toHaveLength(0)
      expect(stderr.join("\n")).toContain('Error: Unknown command "context"')
      expect(stderr.join("\n")).not.toContain("context,")
    } finally {
      process.exit = originalExit
    }
  })
})
