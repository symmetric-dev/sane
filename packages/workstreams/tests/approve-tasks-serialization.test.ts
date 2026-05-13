import { describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"

import { serializeTasksMdToJson } from "../src/cli/approve/tasks.ts"
import { saveIndex } from "../src/lib/index.ts"
import { bootstrapSqliteStructuredStorage } from "../src/lib/sqlite-storage.ts"
import { hydrateLegacyFilesystemStateToSqliteSync } from "../src/lib/storage-adapter.ts"
import { getTasks, readTasksFile } from "../src/lib/tasks.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

describe("tasks approval serialization", () => {
  test("replaces removed stages instead of merging stale tasks", () => {
    const workspace = createTestWorkstream(`001-approve-tasks-${Date.now()}`)

    try {
      const index: WorkIndex = {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        current_stream: workspace.streamId,
        streams: [
          {
            id: workspace.streamId,
            name: "approve-tasks",
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
            generated_by: { workstreams: "1.0.0" },
          },
        ],
      }
      saveIndex(workspace.repoRoot, index)

      writeFileSync(
        `${workspace.workDir}/tasks.json`,
        JSON.stringify(
          {
            version: "2.0.0",
            stream_id: workspace.streamId,
            last_updated: new Date().toISOString(),
            runtime_state: {
              version: "1.0.0",
              last_updated: new Date().toISOString(),
              threads: [],
              batches: {},
              supervision: {
                version: "1.0.0",
                stream_id: workspace.streamId,
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
            tasks: [
              {
                id: "01.01.01.01",
                name: "Keep task",
                stage_name: "Keep stage",
                batch_name: "Keep batch",
                thread_name: "Keep thread",
                created_at: "2026-05-13T00:00:00.000Z",
                updated_at: "2026-05-13T00:00:00.000Z",
                status: "completed",
              },
              {
                id: "06.01.01.01",
                name: "Remove task",
                stage_name: "Remove stage",
                batch_name: "Remove batch",
                thread_name: "Remove thread",
                created_at: "2026-05-13T00:00:00.000Z",
                updated_at: "2026-05-13T00:00:00.000Z",
                status: "pending",
              },
            ],
          },
          null,
          2,
        ),
      )

      bootstrapSqliteStructuredStorage(workspace.repoRoot)
      hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
        streamId: workspace.streamId,
        projectLegacyRuntimeCompatibilityArtifacts: true,
      })

      writeFileSync(
        `${workspace.workDir}/TASKS.md`,
        `# Tasks: ${workspace.streamId}

## Stage 01: Keep stage

### Batch 01: Keep batch

#### Thread 01: Keep thread @agent:
- [ ] Task 01.01.01.01: Keep task
`,
      )

      const result = serializeTasksMdToJson(workspace.repoRoot, workspace.streamId)
      expect(result.success).toBe(true)

      expect(readTasksFile(workspace.repoRoot, workspace.streamId)?.tasks.map((task) => task.id)).toEqual([
        "01.01.01.01",
      ])

      expect(getTasks(workspace.repoRoot, workspace.streamId).map((task) => task.id)).toEqual(["01.01.01.01"])
      expect(getTasks(workspace.repoRoot, workspace.streamId)[0]?.status).toBe("completed")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
