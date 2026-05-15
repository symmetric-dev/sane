/**
 * Approve CLI - Removed TASKS.md workflow shim
 *
 * Keep this command surface so older habits get a clear migration error,
 * but do not retain the removed TASKS.md approval implementation here.
 */

import { printRemovedTaskWorkflowError } from "../../lib/removed-workflows.ts"

export async function handleTasksApproval(
  _repoRoot: string,
  _stream: unknown,
  _cliArgs: unknown,
): Promise<void> {
  printRemovedTaskWorkflowError(
    "Use 'work approve plan' instead; it now initializes execution state and compatibility task data directly.",
  )
}
