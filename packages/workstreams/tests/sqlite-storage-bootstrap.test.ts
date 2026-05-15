import { describe, expect, test } from "bun:test"

import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { join } from "path"

import { filesystemAuthoritativeSqliteStructuredStorageAdapter } from "../src"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage"
import {
  bootstrapSqliteStructuredStorage,
  getSqliteStructuredStoragePath,
  SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION,
  SQLITE_STRUCTURED_STORAGE_TABLES,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "../src/lib/sqlite-storage"
import { cleanupTestWorkstream, createTestWorkstream, withTestWorkstream } from "./helpers"

describe("sqlite structured storage bootstrap", () => {
  test("bootstraps work/db.sqlite with the initial schema", () => {
    const workspace = createTestWorkstream(`001-sqlite-bootstrap-${Date.now()}`)

    try {
      const result = bootstrapSqliteStructuredStorage(workspace.repoRoot)

      expect(result.databasePath).toBe(getSqliteStructuredStoragePath(workspace.repoRoot))
      expect(result.schemaVersion).toBe(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION)
      expect(result.tables).toEqual(SQLITE_STRUCTURED_STORAGE_TABLES)

      const database = new Database(result.databasePath, { readonly: true })

      try {
        const tables = database
          .query<{ name: string }, []>(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
          )
          .all()
          .map((row) => row.name)

        expect(tables).toEqual([...SQLITE_STRUCTURED_STORAGE_TABLES].sort())

        const schemaVersion = database
          .query<{ value: string }, [string]>(
            "SELECT value FROM structured_storage_metadata WHERE key = ?1",
          )
          .get("schema_version")

        expect(schemaVersion?.value).toBe(String(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION))
      } finally {
        database.close()
      }
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("dual-write adapter bootstraps sqlite on first structured-storage access", async () => {
    await withTestWorkstream(async (workspace) => {
      const workspaceState = await filesystemAuthoritativeSqliteStructuredStorageAdapter.loadWorkspaceState(
        workspace.repoRoot,
      )

      expect(workspaceState.workstreams).toEqual([])

      const database = new Database(getSqliteStructuredStoragePath(workspace.repoRoot), {
        readonly: true,
      })

      try {
        const row = database
          .query<{ current_stream_id: string | null }, []>(
            "SELECT current_stream_id FROM workspace_state WHERE singleton_id = 1",
          )
          .get()

        expect(row?.current_stream_id ?? null).toBeNull()
      } finally {
        database.close()
      }
    }, `001-sqlite-adapter-${Date.now()}`)
  })

  test("waits for transient writer locks instead of failing immediately", async () => {
    const workspace = createTestWorkstream(`001-sqlite-busy-timeout-${Date.now()}`)

    try {
      const result = bootstrapSqliteStructuredStorage(workspace.repoRoot)
      const readyPath = join(workspace.repoRoot, "work", ".sqlite-lock-ready")
      const holdMs = 350
      const locker = Bun.spawn(
        [
          process.execPath,
          "-e",
          [
            'import { writeFileSync } from "fs"',
            'import { Database } from "bun:sqlite"',
            'const db = new Database(process.env.DB_PATH!)',
            'db.exec("PRAGMA journal_mode = WAL")',
            'db.exec("BEGIN IMMEDIATE")',
            'writeFileSync(process.env.READY_PATH!, "ready")',
            'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HOLD_MS ?? "0"))',
            'db.exec("COMMIT")',
            'db.close()',
          ].join(";"),
        ],
        {
          env: {
            ...process.env,
            DB_PATH: result.databasePath,
            READY_PATH: readyPath,
            HOLD_MS: String(holdMs),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      try {
        const timeoutAt = Date.now() + 2_000
        while (!existsSync(readyPath) && Date.now() < timeoutAt) {
          await Bun.sleep(10)
        }

        expect(existsSync(readyPath)).toBeTrue()

        const startedAt = Date.now()
        syncStructuredStorageWorkstreamStateToSqlite(
          workspace.repoRoot,
          createEmptyStructuredStorageWorkstreamState(workspace.streamId),
        )
        const elapsedMs = Date.now() - startedAt

        expect(elapsedMs).toBeGreaterThanOrEqual(150)
      } finally {
        const exitCode = await locker.exited
        const stderr = await new Response(locker.stderr).text()
        const stdout = await new Response(locker.stdout).text()
        expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: 0 })
      }
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

})
