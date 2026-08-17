import { getRepoRoot } from "../lib/repo.ts"
import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { executeSdkBatch } from "../lib/agent-runtime/batch-executor.ts"

export interface BatchExecutorCliArgs {
  repoRoot?: string
  streamId?: string
  batchId: string
  runtime?: string
  port?: number
  noServer?: boolean
  silent?: boolean
  runId?: string
  ownerToken?: string
}

function printHelp(): void {
  console.log(`
work-sdk batch-executor - Run one detached SDK batch

Usage:
  work-sdk batch-executor --batch-id SS.BB --execution-backend sdk [options]

Options:
  --repo-root, -r        Repository root (auto-detected if omitted)
  --stream, -s           Workstream ID or name (uses current if omitted)
  --batch-id, --batch    Canonical batch ID
  --execution-backend    Must be "sdk"
  --runtime              Force a provider runtime for this batch
  --port                 OpenCode server port
  --no-server            Do not start OpenCode; require an existing server
  --silent               Disable notifications (reserved for worker parity)
  --run-id               Manager-prepared canonical run ID
  --owner-token          Manager-prepared SDK ownership token
  --help, -h             Show this help message
`)
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function parseBatchExecutorArgs(argv: string[]): BatchExecutorCliArgs | null {
  const args = argv.slice(2)
  let executionBackend: string | undefined
  let repoRoot: string | undefined
  let streamId: string | undefined
  let batchId: string | undefined
  let runtime: string | undefined
  let port: number | undefined
  let noServer = false
  let silent = false
  let runId: string | undefined
  let ownerToken: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    const value = (): string | null => {
      if (!next || next.startsWith("--")) return null
      index += 1
      return next
    }

    switch (arg) {
      case "--repo-root":
      case "-r":
        repoRoot = value() ?? undefined
        if (!repoRoot) return null
        break
      case "--stream":
      case "-s":
        streamId = value() ?? undefined
        if (!streamId) return null
        break
      case "--batch-id":
      case "--batch": {
        const parsed = value()
        if (!parsed) return null
        if (batchId !== undefined && batchId !== parsed) return null
        batchId = parsed
        break
      }
      case "--execution-backend":
        executionBackend = value() ?? undefined
        if (!executionBackend) return null
        break
      case "--runtime":
        runtime = value() ?? undefined
        if (!runtime) return null
        break
      case "--port": {
        const parsed = value()
        if (!parsed) return null
        port = parsePositiveInteger(parsed)
        if (port === undefined) return null
        break
      }
      case "--no-server":
        noServer = true
        break
      case "--silent":
        silent = true
        break
      case "--run-id":
        runId = value() ?? undefined
        if (!runId) return null
        break
      case "--owner-token":
        ownerToken = value() ?? undefined
        if (!ownerToken) return null
        break
      case "--help":
      case "-h":
        printHelp()
        return null
      default:
        return null
    }
  }

  if (executionBackend !== "sdk" || !batchId) return null

  return {
    ...(repoRoot ? { repoRoot } : {}),
    streamId,
    batchId,
    ...(runtime ? { runtime } : {}),
    ...(port === undefined ? {} : { port }),
    ...(noServer ? { noServer: true } : {}),
    ...(silent ? { silent: true } : {}),
    ...(runId ? { runId } : {}),
    ...(ownerToken ? { ownerToken } : {}),
  }
}

/**
 * Run the internal worker command. Provider output is emitted only by the
 * provider SDK and is intentionally not copied to this command's stdout; the
 * supervision helper redirects this process's descriptors to executor.log.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const parsed = parseBatchExecutorArgs(argv)
  if (!parsed) {
    if (argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) return 0
    console.error("Error: invalid batch-executor arguments")
    console.error("\nRun with --help for usage information.")
    return 2
  }

  try {
    const repoRoot = parsed.repoRoot ?? getRepoRoot()
    const streamId = parsed.streamId ?? getResolvedStream(loadIndex(repoRoot), undefined).id
    const result = await executeSdkBatch({
      repoRoot,
      streamId,
      batchId: parsed.batchId,
      runtimeOverride: parsed.runtime,
      serverPort: parsed.port,
      noServer: parsed.noServer,
      runId: parsed.runId,
      ownerToken: parsed.ownerToken,
    })
    console.log(`[batch-executor] batch ${result.batch.batchId} finished: ${result.batch.status}`)
    return result.batch.status === "completed" ? 0 : 1
  } catch (error) {
    console.error(`[batch-executor] ${(error as Error).message}`)
    return 1
  }
}
