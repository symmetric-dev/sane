import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

function summarizeArray(values: string[], limit = 10): string[] {
  return values.slice(0, limit)
}

function readIndexSummary(repoRoot: string): Record<string, unknown> {
  const indexPath = join(repoRoot, "work", "index.json")
  if (!existsSync(indexPath)) {
    return {
      exists: false,
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      current_stream?: string
      streams?: Array<{ id?: string }>
    }

    const streamIds = (parsed.streams ?? [])
      .map((stream) => stream.id)
      .filter((streamId): streamId is string => typeof streamId === "string")
      .sort((left, right) => right.localeCompare(left))

    return {
      exists: true,
      currentStream: parsed.current_stream ?? null,
      streamCount: streamIds.length,
      sampleStreamIds: summarizeArray(streamIds),
    }
  } catch (error) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function createRepoRootDebugContext(repoRoot: string): Record<string, unknown> {
  const workDir = join(repoRoot, "work")
  const workDirExists = existsSync(workDir)
  const workstreamDirectories = workDirExists
    ? readdirSync(workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
    : []

  return {
    repoRoot,
    workDirExists,
    files: {
      indexJson: existsSync(join(workDir, "index.json")),
      sqlite: existsSync(join(workDir, "db.sqlite")),
      sqliteWal: existsSync(join(workDir, "db.sqlite-wal")),
      sqliteShm: existsSync(join(workDir, "db.sqlite-shm")),
    },
    index: readIndexSummary(repoRoot),
    workstreamDirectoryCount: workstreamDirectories.length,
    sampleWorkstreamDirectories: summarizeArray(workstreamDirectories),
  }
}

export function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause !== undefined ? { cause: serializeErrorForLog(error.cause) } : {}),
    }
  }

  return {
    message: String(error),
  }
}

export function logDashboardDiagnostic(event: string, details: Record<string, unknown>): void {
  console.error(
    `[dashboard-server] ${event}\n${JSON.stringify(details, null, 2)}`,
  )
}
