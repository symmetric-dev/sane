import {
  loadStructuredWorkstreamStateSync,
  modifyStructuredWorkstreamStateSync,
} from "./storage-adapter.ts"
import { buildCanonicalThreadExecutionState } from "./thread-execution.ts"

import type { StreamDocument } from "./types.ts"

export function initializeCanonicalExecutionStateFromPlan(
  repoRoot: string,
  streamId: string,
  doc: StreamDocument,
): number {
  const existingState = loadStructuredWorkstreamStateSync(repoRoot, streamId)

  return modifyStructuredWorkstreamStateSync(
    {
      repoRoot,
      streamId,
    },
    (workstreamState) => {
      const nextState = buildCanonicalThreadExecutionState({
        doc,
        existingState: existingState ?? workstreamState,
      })
      workstreamState.hierarchy = nextState.hierarchy
      workstreamState.threadRuntime = nextState.threadRuntime
      return nextState.hierarchy.threads.length
    },
  )
}
