/**
 * Index operations for workstream management
 */

import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs"
import { basename, dirname, join } from "path"
import * as lockfile from "proper-lockfile"
import type { WorkIndex, StreamMetadata, StreamStatus } from "./types.ts"
import { getIndexPath, getWorkDir } from "./repo.ts"

/**
 * Atomic write: write to temp file, then rename (atomic on POSIX)
 */
function atomicWriteJSON(path: string, data: object): void {
  atomicWriteFile(path, JSON.stringify(data, null, 2))
}

/**
 * Atomic write for any file content
 */
export function atomicWriteFile(path: string, content: string): void {
  const directory = dirname(path)
  const fileName = basename(path)
  let lastError: Error | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    const tempPath = join(
      directory,
      `.${fileName}.${process.pid}.${Date.now()}-${randomUUID().slice(0, 8)}.tmp`,
    )

    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(tempPath, content)

      try {
        renameSync(tempPath, path)
        return
      } catch (error) {
        const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT"
        if (!isEnoent) {
          throw error
        }

        mkdirSync(directory, { recursive: true })
        if (!existsSync(tempPath)) {
          writeFileSync(tempPath, content)
        }

        renameSync(tempPath, path)
        return
      }
    } catch (error) {
      lastError = error as Error
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT"
      if (!isEnoent || attempt === 1) {
        throw error
      }
    } finally {
      rmSync(tempPath, { force: true })
    }
  }

  throw lastError ?? new Error(`Failed to atomically write ${path}`)
}

/**
 * Execute a function with file lock on the index
 */
async function withIndexLock<T>(
  indexPath: string,
  fn: () => T
): Promise<T> {
  const release = await lockfile.lock(indexPath, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  })
  try {
    return fn()
  } finally {
    await release()
  }
}

/**
 * Read and parse the workstreams index.json, or create a new one
 */
export function getOrCreateIndex(repoRoot: string): WorkIndex {
  const indexPath = getIndexPath(repoRoot)

  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, "utf-8")
    return JSON.parse(content) as WorkIndex
  }

  return {
    version: "1.0.0",
    last_updated: new Date().toISOString(),
    streams: [],
  }
}

/**
 * Load the workstreams index, throwing if it doesn't exist
 */
export function loadIndex(repoRoot: string): WorkIndex {
  const indexPath = getIndexPath(repoRoot)

  if (!existsSync(indexPath)) {
    throw new Error(`No workstreams index found at ${indexPath}`)
  }

  const content = readFileSync(indexPath, "utf-8")

  try {
    return JSON.parse(content) as WorkIndex
  } catch (e) {
    throw new Error(
      `Failed to parse index.json at ${indexPath}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/**
 * Save the index.json (uses atomic write)
 * Fields are ordered: version, last_updated, current_stream, streams
 */
export function saveIndex(repoRoot: string, index: WorkIndex): void {
  const indexPath = getIndexPath(repoRoot)

  // Construct object with explicit field ordering
  const orderedIndex: WorkIndex = {
    version: index.version,
    last_updated: new Date().toISOString(),
    ...(index.current_stream !== undefined ? { current_stream: index.current_stream } : {}),
    streams: index.streams,
  }

  atomicWriteJSON(indexPath, orderedIndex)
}

/**
 * Save the index.json with file locking (async, safe for concurrent access)
 * Fields are ordered: version, last_updated, current_stream, streams
 */
export async function saveIndexSafe(repoRoot: string, index: WorkIndex): Promise<void> {
  const indexPath = getIndexPath(repoRoot)
  await withIndexLock(indexPath, () => {
    // Construct object with explicit field ordering
    const orderedIndex: WorkIndex = {
      version: index.version,
      last_updated: new Date().toISOString(),
      ...(index.current_stream !== undefined ? { current_stream: index.current_stream } : {}),
      streams: index.streams,
    }
    atomicWriteJSON(indexPath, orderedIndex)
  })
}

/**
 * Atomic read-modify-write operation on the index with file locking
 */
export async function modifyIndex<T>(
  repoRoot: string,
  fn: (index: WorkIndex) => T
): Promise<T> {
  const indexPath = getIndexPath(repoRoot)
  return withIndexLock(indexPath, () => {
    const index = loadIndex(repoRoot)
    const result = fn(index)
    saveIndex(repoRoot, index)
    return result
  })
}

/**
 * Find a stream by ID or name
 */
export function findStream(
  index: WorkIndex,
  streamIdOrName: string
): StreamMetadata | undefined {
  return index.streams.find(
    (s) => s.id === streamIdOrName || s.name === streamIdOrName
  )
}

/**
 * Find a stream by ID or name, throwing if not found
 */
export function getStream(index: WorkIndex, streamIdOrName: string): StreamMetadata {
  const stream = findStream(index, streamIdOrName)
  if (!stream) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }
  return stream
}

/**
 * Get the next stream order number
 */
export function getNextOrderNumber(index: WorkIndex): number {
  if (index.streams.length === 0) return 0
  return Math.max(...index.streams.map((s) => s.order)) + 1
}

/**
 * Format order number as 3-digit string
 */
export function formatOrderNumber(order: number): string {
  return order.toString().padStart(3, "0")
}

/**
 * Get the current stream ID from the index
 */
export function getCurrentStreamId(index: WorkIndex): string | undefined {
  return index.current_stream
}

/**
 * Get the current stream metadata, throwing if no current stream is set
 */
export function getCurrentStream(index: WorkIndex): StreamMetadata {
  if (!index.current_stream) {
    throw new Error("No current workstream set. Use 'work current --set <id>' to set one.")
  }
  return getStream(index, index.current_stream)
}

/**
 * Set the current stream by ID or name
 */
export function setCurrentStream(repoRoot: string, streamIdOrName: string): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getStream(index, streamIdOrName) // Validates stream exists
  index.current_stream = stream.id
  saveIndex(repoRoot, index)
  return stream
}

/**
 * Clear the current stream
 */
export function clearCurrentStream(repoRoot: string): void {
  const index = loadIndex(repoRoot)
  delete index.current_stream
  saveIndex(repoRoot, index)
}

/**
 * Resolve a stream ID, handling "current" as a special value
 * Returns the actual stream ID, or undefined if not specified and no current stream
 */
export function resolveStreamId(
  index: WorkIndex,
  streamIdOrName: string | undefined
): string | undefined {
  // If explicitly "current", use current stream
  if (streamIdOrName === "current") {
    return index.current_stream
  }
  // If specified, use that
  if (streamIdOrName) {
    return streamIdOrName
  }
  // Default to current stream
  return index.current_stream
}

/**
 * Get the stream, resolving "current" and defaulting to current stream
 * Throws if no stream specified and no current stream set
 */
export function getResolvedStream(
  index: WorkIndex,
  streamIdOrName: string | undefined
): StreamMetadata {
  const resolvedId = resolveStreamId(index, streamIdOrName)
  if (!resolvedId) {
    throw new Error("No workstream specified and no current workstream set. Use --stream <id> or 'work current --set <id>'")
  }
  return getStream(index, resolvedId)
}

/**
 * Set the stream status manually
 * Use this for on_hold status or to override computed status
 */
export function setStreamStatus(
  repoRoot: string,
  streamIdOrName: string,
  status: StreamStatus | undefined
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === streamIdOrName || s.name === streamIdOrName
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }

  const stream = index.streams[streamIndex]!

  if (status === undefined) {
    // Clear manual status - let it be computed
    delete stream.status
  } else {
    stream.status = status
  }

  stream.updated_at = new Date().toISOString()
  saveIndex(repoRoot, index)

  return stream
}

export interface DeleteStreamOptions {
  deleteFiles?: boolean
}

export interface DeleteStreamResult {
  deleted: boolean
  streamId: string
  streamPath: string
}

/**
 * Delete a stream from the index (and optionally its files)
 */
export async function deleteStream(
  repoRoot: string,
  streamIdOrName: string,
  options?: DeleteStreamOptions
): Promise<DeleteStreamResult> {
  return modifyIndex(repoRoot, (index) => {
    const streamIndex = index.streams.findIndex(
      (s) => s.id === streamIdOrName || s.name === streamIdOrName
    )

    if (streamIndex === -1) {
      throw new Error(`Workstream "${streamIdOrName}" not found`)
    }

    const stream = index.streams[streamIndex]!
    index.streams.splice(streamIndex, 1)

    // Clear current_stream if we're deleting it
    if (index.current_stream === stream.id) {
      delete index.current_stream
    }

    // Optionally delete stream directory
    if (options?.deleteFiles) {
      const streamDir = join(getWorkDir(repoRoot), stream.id)
      if (existsSync(streamDir)) {
        rmSync(streamDir, { recursive: true })
      }
    }

    return {
      deleted: true,
      streamId: stream.id,
      streamPath: stream.path,
    }
  })
}

/**
 * Set the GitHub metadata for a stream
 */
export function setStreamGitHubMeta(
  repoRoot: string,
  streamIdOrName: string,
  meta: { branch?: string } | undefined
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === streamIdOrName || s.name === streamIdOrName
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }

  const stream = index.streams[streamIndex]!

  if (meta === undefined) {
    delete stream.github
  } else {
    stream.github = {
      ...stream.github,
      ...meta,
    }
  }

  stream.updated_at = new Date().toISOString()
  saveIndex(repoRoot, index)

  return stream
}

/**
 * Set the planning session metadata for a stream
 */
export function setStreamPlanningSession(
  repoRoot: string,
  streamIdOrName: string,
  sessionId: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === streamIdOrName || s.name === streamIdOrName
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }

  const stream = index.streams[streamIndex]!

  stream.planningSession = {
    sessionId,
    createdAt: new Date().toISOString(),
  }

  stream.updated_at = new Date().toISOString()
  saveIndex(repoRoot, index)

  return stream
}

/**
 * Get the planning session ID for a stream
 */
export function getPlanningSessionId(
  repoRoot: string,
  streamIdOrName: string
): string | null {
  const index = loadIndex(repoRoot)
  const stream = findStream(index, streamIdOrName)
  
  if (!stream) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }

  return stream.planningSession?.sessionId ?? null
}
