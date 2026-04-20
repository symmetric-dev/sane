import { join } from "path"

import { getBatchStatusFilePath, readBatchStatus, writeBatchStatus, writeBatchStatusLocked } from "./batch-status.ts"
import { loadIndex, modifyIndex, saveIndex, saveIndexSafe } from "./index.ts"
import { getWorkDir } from "./repo.ts"
import { loadSupervisorState, modifySupervisorState, saveSupervisorState } from "./supervisor-state.ts"
import { modifyTasksFile, readTasksFile, writeTasksFile } from "./tasks.ts"
import { loadThreads, modifyThreads, saveThreads } from "./threads.ts"
import type {
  PersistedBatchStatusFile,
  SupervisorStateFile,
  TasksFile,
  ThreadsJson,
  WorkIndex,
} from "./types.ts"

export interface StructuredStorageAdapter {
  readonly kind: string
  getWorkstreamRoot(repoRoot: string, streamId: string): string
  index: {
    load(repoRoot: string): WorkIndex
    save(repoRoot: string, index: WorkIndex): void
    saveSafe(repoRoot: string, index: WorkIndex): Promise<void>
    modify<T>(repoRoot: string, fn: (index: WorkIndex) => T): Promise<T>
  }
  tasks: {
    read(repoRoot: string, streamId: string): TasksFile | null
    write(repoRoot: string, streamId: string, tasksFile: TasksFile): void
    modify<T>(repoRoot: string, streamId: string, fn: (tasksFile: TasksFile) => T | Promise<T>): Promise<T>
  }
  threads: {
    load(repoRoot: string, streamId: string): ThreadsJson | null
    save(repoRoot: string, streamId: string, threadsFile: ThreadsJson): void
    modify<T>(repoRoot: string, streamId: string, fn: (threadsFile: ThreadsJson) => T): Promise<T>
  }
  batchRuns: {
    getFilePath(repoRoot: string, streamId: string, batchId: string): string
    read(repoRoot: string, streamId: string, batchId: string): PersistedBatchStatusFile | null
    write(repoRoot: string, streamId: string, batchStatus: PersistedBatchStatusFile): void
    writeLocked(repoRoot: string, streamId: string, batchStatus: PersistedBatchStatusFile): Promise<void>
  }
  supervision: {
    load(repoRoot: string, streamId: string): SupervisorStateFile | null
    save(repoRoot: string, streamId: string, supervisorState: SupervisorStateFile): void
    modify<T>(
      repoRoot: string,
      streamId: string,
      fn: (supervisorState: SupervisorStateFile) => T | Promise<T>,
    ): Promise<T>
  }
}

export function createFilesystemStructuredStorageAdapter(): StructuredStorageAdapter {
  return {
    kind: "filesystem",
    getWorkstreamRoot(repoRoot: string, streamId: string): string {
      return join(getWorkDir(repoRoot), streamId)
    },
    index: {
      load: loadIndex,
      save: saveIndex,
      saveSafe: saveIndexSafe,
      modify: modifyIndex,
    },
    tasks: {
      read: readTasksFile,
      write: writeTasksFile,
      modify: modifyTasksFile,
    },
    threads: {
      load: loadThreads,
      save: saveThreads,
      modify: modifyThreads,
    },
    batchRuns: {
      getFilePath: getBatchStatusFilePath,
      read: readBatchStatus,
      write: writeBatchStatus,
      writeLocked: writeBatchStatusLocked,
    },
    supervision: {
      load: loadSupervisorState,
      save: saveSupervisorState,
      modify: modifySupervisorState,
    },
  }
}

export const filesystemStructuredStorageAdapter = createFilesystemStructuredStorageAdapter()

export function getStructuredStorageAdapter(): StructuredStorageAdapter {
  return filesystemStructuredStorageAdapter
}
