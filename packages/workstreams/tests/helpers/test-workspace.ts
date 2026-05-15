import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export interface TestWorkspace {
  repoRoot: string
  workDir: string
  streamId: string
}

export function createTestWorkstream(streamId: string = "001-test-stream"): TestWorkspace {
  const repoRoot = mkdtempSync(join(tmpdir(), "work-test-"))
  const workDir = join(repoRoot, "work", streamId)

  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(repoRoot, ".git"), { recursive: true })
  writeFileSync(join(workDir, "PLAN.md"), "# Test Plan\n\n## Thread 1\nSummary")
  writeFileSync(
    join(workDir, "workstream-state.json"),
    JSON.stringify(
        {
          version: "1.0.0",
          streamId,
          hierarchy: { stages: [], batches: [], threads: [] },
          approvals: [],
          threadRuntime: [],
          batchRuns: [],
        supervision: {
          version: "1.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          runs: [],
          checkpoint_pointers: [],
          branch_sessions: [],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [],
        },
      },
      null,
      2,
    ),
  )

  return { repoRoot, workDir, streamId }
}

export function cleanupTestWorkstream(workspace: TestWorkspace): void {
  if (existsSync(workspace.repoRoot)) {
    rmSync(workspace.repoRoot, { recursive: true, force: true })
  }
}

export async function withTestWorkstream(
  callback: (workspace: TestWorkspace) => Promise<void> | void,
  streamId: string = "001-test-stream",
): Promise<void> {
  const workspace = createTestWorkstream(streamId)
  try {
    await callback(workspace)
  } finally {
    cleanupTestWorkstream(workspace)
  }
}
