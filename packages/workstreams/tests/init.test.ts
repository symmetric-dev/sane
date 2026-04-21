import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  existsSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { main as initMain } from "../src/cli/init.ts"
import { getStructuredStorageSqlitePath } from "../src/index.ts"
import { loadIndex } from "../src/lib/index.ts"

describe("work init", () => {
  let tempDir: string
  let workDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "work-init-test-"))
    mkdirSync(join(tempDir, ".git"))
    workDir = join(tempDir, "work")
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("should initialize work/ directory and default files", async () => {
    await initMain(["bun", "work", "init", "--repo-root", tempDir])

    expect(existsSync(workDir)).toBe(true)
    expect(existsSync(join(workDir, "index.json"))).toBe(true)
    expect(existsSync(join(workDir, "agents.yaml"))).toBe(true)
    expect(existsSync(join(workDir, "notifications.json"))).toBe(false)
    expect(existsSync(join(workDir, "supervisor.json"))).toBe(false)

    const indexContent = JSON.parse(
      readFileSync(join(workDir, "index.json"), "utf-8"),
    )
    expect(indexContent.version).toBe("1.0.0")
    expect(indexContent.streams).toEqual([])

    const agentsContent = readFileSync(join(workDir, "agents.yaml"), "utf-8")
    expect(agentsContent).toContain("agents:")
    expect(agentsContent).toContain("name: default")

  })

  it("should not overwrite existing files without --force", async () => {
    mkdirSync(workDir, { recursive: true })
    const customContent = "custom content"
    writeFileSync(join(workDir, "agents.yaml"), customContent)

    await initMain(["bun", "work", "init", "--repo-root", tempDir])

    const agentsContent = readFileSync(join(workDir, "agents.yaml"), "utf-8")
    expect(agentsContent).toBe(customContent)
    expect(existsSync(join(workDir, "notifications.json"))).toBe(false)
  })

  it("should overwrite existing files with --force", async () => {
    mkdirSync(workDir, { recursive: true })
    const customContent = "custom content"
    writeFileSync(join(workDir, "agents.yaml"), customContent)

    await initMain(["bun", "work", "init", "--repo-root", tempDir, "--force"])

    const agentsContent = readFileSync(join(workDir, "agents.yaml"), "utf-8")
    expect(agentsContent).not.toBe(customContent)
    expect(agentsContent).toContain("agents:")

    expect(existsSync(join(workDir, "notifications.json"))).toBe(false)
    expect(existsSync(join(workDir, "supervisor.json"))).toBe(false)
  })

  it("should bootstrap sqlite storage when --sqlite is provided", async () => {
    await initMain(["bun", "work", "init", "--repo-root", tempDir, "--sqlite"])

    expect(existsSync(getStructuredStorageSqlitePath(tempDir))).toBe(true)
    expect(existsSync(join(workDir, "index.json"))).toBe(false)

    const projectedIndex = loadIndex(tempDir)
    expect(projectedIndex.streams).toEqual([])
  })

  it("should not create index.json for fresh sqlite bootstrap even with --force", async () => {
    await initMain(["bun", "work", "init", "--repo-root", tempDir, "--sqlite", "--force"])

    expect(existsSync(getStructuredStorageSqlitePath(tempDir))).toBe(true)
    expect(existsSync(join(workDir, "index.json"))).toBe(false)
  })

  it("should hydrate orphan legacy workstream directories into sqlite during init without creating index.json", async () => {
    const streamId = "001-orphan-legacy-stream"
    const orphanWorkDir = join(workDir, streamId)
    mkdirSync(orphanWorkDir, { recursive: true })
    writeFileSync(join(orphanWorkDir, "PLAN.md"), "# Legacy plan\n")
    writeFileSync(
      join(orphanWorkDir, "tasks.json"),
      JSON.stringify(
        {
          version: "2.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Import orphaned stream",
              thread_name: "Hydration thread",
              batch_name: "Hydration batch",
              stage_name: "Hydration stage",
              status: "pending",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    )

    await initMain(["bun", "work", "init", "--repo-root", tempDir, "--sqlite"])

    expect(existsSync(getStructuredStorageSqlitePath(tempDir))).toBe(true)
    expect(existsSync(join(workDir, "index.json"))).toBe(false)

    const projectedIndex = loadIndex(tempDir)
    expect(projectedIndex.streams.map((stream) => stream.id)).toEqual([streamId])
    expect(projectedIndex.streams[0]?.name).toBe("orphan-legacy-stream")
  })

  it("should bootstrap sqlite storage for an existing work directory without --force", async () => {
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, "index.json"), JSON.stringify({
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      streams: [],
    }, null, 2))

    await initMain(["bun", "work", "init", "--repo-root", tempDir, "--sqlite"])

    expect(existsSync(getStructuredStorageSqlitePath(tempDir))).toBe(true)
    const indexContent = JSON.parse(readFileSync(join(workDir, "index.json"), "utf-8"))
    expect(indexContent.streams).toEqual([])
  })
})
