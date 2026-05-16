import { describe, expect, test } from "bun:test"

import { main as workMain } from "../bin/work.ts"
import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as assignMain } from "../src/cli/assign.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as readMain } from "../src/cli/read.ts"
import { main as updateMain } from "../src/cli/update.ts"
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
    expect(output).toContain("README.md")
    expect(output).toContain("resources/")
    expect(output).toContain("stages/")
    expect(output).toContain("Update README.md with the overall workstream context")
    expect(output).not.toContain("- files/")
    expect(output).toContain("work plan create --stages 3")
    expect(output).toContain("requires at least one stage")
    expect(output).toContain("thread WORK.md files are generated")
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
    expect(validateOutput).toContain("work validate work")
    expect(validateOutput).toContain("requirements  Validate requirements structure and content")
    expect(validateOutput).toContain("work          Validate generated per-thread WORK.md structure and content")
    expect(validateOutput).toContain("stage-local workstream model")
    expect(validateOutput).toContain("stage-local files under stages/<nn>/REQUIREMENTS.md")
    expect(validateOutput).toContain("post-approval / post-generation check")
    expect(validateOutput).not.toContain("When no root REQUIREMENTS.md exists")
    expect(validateOutput).not.toContain("work validate tasks")
    expect(approveOutput).toContain("requires at least\n  one stage")
    expect(approveOutput).toContain("work plan create --stages <n>")
    expect(approveOutput).toContain("Plan approval also initializes the execution hierarchy directly")
    expect(approveOutput).toContain("stages/*/PLAN.md (or a legacy root PLAN.md when present)")
    expect(approveOutput).not.toContain("Usage:\n  work approve tasks")
  })

  test("main CLI help advertises requirements validation and hides context", async () => {
    const { stdout, stderr } = await captureHelpOutput(() => {
      workMain(["bun", "work", "--help", "--show-all-commands"])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toMatch(/^\s+validate\s+Validate plan, requirements, or work docs$/m)
    expect(output).toMatch(/^\s+reset-batch-state\s+Reset one batch for a clean rerun$/m)
    expect(output).toMatch(/^\s+list\s+List threads in a workstream \[default\]$/m)
    expect(output).toMatch(/^\s+read\s+Read thread details$/m)
    expect(output).toContain("work validate requirements")
    expect(output).not.toMatch(/^\s+tasks\s+/m)
    expect(output).not.toMatch(/^\s+add-task\s+/m)
    expect(output).not.toMatch(/^\s+context\s+/m)
  })

  test("removed task flags are rejected by thread-first CLIs", async () => {
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
      const assignOutput = await captureCliOutput(async () => {
        try {
          await assignMain([
            "bun",
            "work-assign",
            "--repo-root",
            workspace.repoRoot,
            "--stream",
            workspace.streamId,
            "--task",
            "01.01.01.01",
            "--agent",
            "default",
          ])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      const readOutput = await captureCliOutput(() => {
        try {
          readMain([
            "bun",
            "work-read",
            "--repo-root",
            workspace.repoRoot,
            "--stream",
            workspace.streamId,
            "--task",
            "01.01.01.01",
          ])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      const updateOutput = await captureCliOutput(async () => {
        try {
          await updateMain([
            "bun",
            "work-update",
            "--repo-root",
            workspace.repoRoot,
            "--stream",
            workspace.streamId,
            "--task",
            "01.01.01.01",
            "--status",
            "completed",
          ])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      expect(assignOutput.stderr.join("\n")).toContain("Unknown argument: --task")
      expect(readOutput.stderr.join("\n")).toContain("Unknown argument: --task")
      expect(updateOutput.stderr.join("\n")).toContain("Unknown argument: --task")
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

  test("approve help no longer advertises task approval", async () => {
    const { stdout } = await captureHelpOutput(() => approveMain(["bun", "work-approve", "--help"]))
    const output = stdout.join("\n")
    expect(output).not.toContain("work approve tasks")
    expect(output).not.toContain("Tasks:")
  })
})
