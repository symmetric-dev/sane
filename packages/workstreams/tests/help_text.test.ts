import { describe, expect, test } from "bun:test"

import { main as workMain } from "../bin/work.ts"
import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as tasksMain } from "../src/cli/tasks.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

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
    expect(validateOutput).not.toContain("work validate tasks")
    expect(validateOutput).not.toContain("tasks    Validate TASKS.md structure and content")
    expect(approveOutput).toContain("requires at least one stage")
    expect(approveOutput).toContain("work plan create --stages <n>")
    expect(approveOutput).toContain("plan approval also initializes execution state directly")
    expect(approveOutput).not.toContain("Usage:\n  work approve tasks")
  })

  test("main CLI help advertises requirements validation and hides context", async () => {
    const { stdout, stderr } = await captureHelpOutput(() => {
      workMain(["bun", "work", "--help", "--show-all-commands"])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toMatch(/^\s+validate\s+Validate plan or requirements$/m)
    expect(output).toMatch(/^\s+reset-batch-state\s+Reset one batch for a clean rerun$/m)
    expect(output).toMatch(/^\s+list\s+List threads in a workstream \[default\]$/m)
    expect(output).toMatch(/^\s+read\s+Read thread or compatibility task details$/m)
    expect(output).toContain("work validate requirements")
    expect(output).not.toMatch(/^\s+tasks\s+/m)
    expect(output).not.toMatch(/^\s+context\s+/m)
  })

  test("removed task workflow commands hard error with migration guidance", async () => {
    const originalExit = process.exit
    const originalRole = process.env.WORKSTREAM_ROLE
    const workspace = createTestWorkstream(`001-removed-task-workflow-${Date.now()}`)
    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      current_stream: workspace.streamId,
      streams: [
        {
          id: workspace.streamId,
          name: "removed-task-workflow",
          order: 1,
          size: "short",
          session_estimated: {
            length: 1,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          path: `work/${workspace.streamId}`,
          generated_by: { workstreams: "test" },
        },
      ],
    }
    saveIndex(workspace.repoRoot, index)
    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code ?? 0}`)
    }) as typeof process.exit
    process.env.WORKSTREAM_ROLE = "USER"

    try {
      const tasksOutput = await captureCliOutput(() => {
        try {
          tasksMain(["bun", "work-tasks", "generate", "--repo-root", workspace.repoRoot])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      const approveOutput = await captureCliOutput(async () => {
        try {
          await approveMain([
            "bun",
            "work-approve",
            "tasks",
            "--repo-root",
            workspace.repoRoot,
            "--stream",
            workspace.streamId,
          ])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      const validateOutput = await captureCliOutput(() => {
        try {
          validateMain([
            "bun",
            "work-validate",
            "tasks",
            "--repo-root",
            workspace.repoRoot,
            "--stream",
            workspace.streamId,
          ])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      expect(tasksOutput.stderr.join("\n")).toContain("removed in 0.9.0")
      expect(tasksOutput.stderr.join("\n")).toContain("work approve plan")
      expect(approveOutput.stderr.join("\n")).toContain("removed in 0.9.0")
      expect(approveOutput.stderr.join("\n")).toContain("work approve plan")
      expect(validateOutput.stderr.join("\n")).toContain("removed in 0.9.0")
      expect(validateOutput.stderr.join("\n")).toContain("work validate plan")
    } finally {
      cleanupTestWorkstream(workspace)
      if (originalRole === undefined) {
        delete process.env.WORKSTREAM_ROLE
      } else {
        process.env.WORKSTREAM_ROLE = originalRole
      }
      process.exit = originalExit
    }
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
