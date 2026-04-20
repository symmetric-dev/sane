import { describe, expect, test } from "bun:test"

import { Database } from "bun:sqlite"

import { filesystemAuthoritativeSqliteStructuredStorageAdapter } from "../src"
import {
  bootstrapSqliteStructuredStorage,
  getSqliteStructuredStoragePath,
  SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION,
  SQLITE_STRUCTURED_STORAGE_TABLES,
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
})
