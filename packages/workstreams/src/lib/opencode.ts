/**
 * opencode server management utilities
 *
 * Provides functions for starting, checking, and managing the opencode serve
 * backend which allows multiple client instances to share MCP and model cache.
 */

import { spawn, type ChildProcess } from "child_process"

const DEFAULT_PORT = 4096
const HEALTH_CHECK_INTERVAL_MS = 200
const DEFAULT_TIMEOUT_MS = 30000
export const WORKSTREAM_HEADLESS_ENV = "WORKSTREAM_HEADLESS"

export interface RunCommandOptions {
  headless?: boolean
  streamId?: string
}

/**
 * Get the server URL for a given port
 */
export function getServerUrl(port: number = DEFAULT_PORT): string {
  return `http://localhost:${port}`
}

/**
 * Check if the opencode server is running on the specified port
 * Makes a simple HTTP request to verify the server is responsive
 */
export async function isServerRunning(
  port: number = DEFAULT_PORT,
): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    })
    // Any response means the server is up (even if not 200)
    return response.ok || response.status < 500
  } catch {
    return false
  }
}

/**
 * Start the opencode server in the background
 * Returns the child process handle
 *
 * Note: The process is started detached so it continues running
 * after the parent process exits.
 */
export function startServer(
  port: number = DEFAULT_PORT,
  cwd?: string,
): ChildProcess {
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Unref so parent can exit while server continues
  child.unref()

  return child
}

/**
 * Wait for the server to become available
 * Polls until the server responds or timeout is reached
 */
export async function waitForServer(
  port: number = DEFAULT_PORT,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const running = await isServerRunning(port)
    if (running) {
      return true
    }
    // Wait before next check
    await new Promise((resolve) =>
      setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS),
    )
  }

  return false
}

/**
 * Truncate a string to maxLen chars, adding ellipsis if truncated
 */
function truncateTitle(title: string, maxLen: number = 32): string {
  if (title.length <= maxLen) return title
  return title.slice(0, maxLen - 1) + "…"
}

/**
 * Get the marker file path for a thread's first command completion
 * Used to signal when opencode run finishes.
 * 
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the completion marker file
 */
export function getCompletionMarkerPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-complete.txt`
}

/**
 * Get the legacy session file path for a thread.
 * Retained so reset/finalization flows can clean up obsolete temp artifacts safely.
 * 
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the legacy session ID file
 */
export function getSessionFilePath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-session.txt`
}

/**
 * Get the result file path for storing a thread run's final status/exit code
 * Used by finalization paths that cannot rely on a live tmux pane.
 */
export function getRunResultPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-result.json`
}

/**
 * Get the legacy synthesis output artifact path.
 * Retained so reset/cleanup flows can remove obsolete temp files safely.
 * 
 * @param streamId - Stream/workstream ID (e.g., "001-my-workstream")
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Absolute path to the synthesis output file in /tmp
 */
export function getSynthesisOutputPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-synthesis.txt`
}

/**
 * Get the working agent session file path.
 * 
 * @param streamId - Stream/workstream ID (e.g., "001-my-workstream")
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the working agent session file
 */
export function getWorkingAgentSessionPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-working-session.txt`
}

/**
 * Get the legacy synthesis log artifact path.
 * Retained so reset/cleanup flows can remove obsolete temp files safely.
 * 
 * @param streamId - Stream/workstream ID (e.g., "001-my-workstream")
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the synthesis log file
 */
export function getSynthesisLogPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-synthesis.log`
}

/**
 * Escape a string for use in shell commands wrapped in sh -c '...'
 * Handles both the outer single-quote wrapper and inner double-quoted strings
 */
function escapeForShell(str: string): string {
  // First escape single quotes for the outer sh -c '...' wrapper
  // Then escape double quotes, $, and backticks for inner double-quoted strings
  return str
    .replace(/'/g, "'\\''")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
}

function buildCommandPrefix(options?: RunCommandOptions): string {
  return options?.headless ? `${WORKSTREAM_HEADLESS_ENV}=1 ` : ""
}

function buildResultWriteCommand(
  streamId: string | undefined,
  threadId: string | undefined,
  exitVarName: string,
): string {
  if (!streamId || !threadId) {
    return ""
  }

  const resultPath = getRunResultPath(streamId, threadId)
  const shellExitVar = `$${exitVarName}`
  const shellExitVarWithDefault = "${" + exitVarName + ":-1}"

  return `
RESULT_STATUS="failed"
if [ ${shellExitVar} -eq 0 ] 2>/dev/null; then
  RESULT_STATUS="completed"
fi
printf '{"status":"%s","exitCode":%s}\n' "$RESULT_STATUS" "${shellExitVarWithDefault}" > "${resultPath}"`
}

/**
 * Build the opencode run command for a workstream thread.
 * Wrapped in sh -c to properly handle piped commands in tmux.
 *
 * The command:
 * 1. Runs opencode with the provided title
 * 2. Writes result metadata (if threadId provided)
 * 3. Writes a completion marker file (if threadId provided)
 * 
 * @param threadId - Optional thread ID for completion marker (e.g., "01.01.02")
 */
export function buildRunCommand(
  port: number,
  model: string,
  promptPath: string,
  threadTitle: string,
  variant?: string,
  threadId?: string,
  options: RunCommandOptions = {},
): string {
  // Escape single quotes in paths by replacing ' with '\''
  const escapedPath = promptPath.replace(/'/g, "'\\''")
  // Truncate and escape the title for shell safety
  const truncated = truncateTitle(threadTitle, 32)
  const escapedTitle = escapeForShell(truncated)

  // Build variant flag if specified
  const variantFlag = variant ? ` --variant "${variant}"` : ""

  // Build completion marker path if threadId provided
  const completionMarkerCmd = threadId && options.streamId
    ? `\necho "done" > "${getCompletionMarkerPath(options.streamId, threadId)}"`
    : ""

  const resultWriteCmd = buildResultWriteCommand(options.streamId, threadId, "RUN_EXIT")
  const commandPrefix = buildCommandPrefix(options)

  // Build a shell script that:
  // 1. Runs opencode with the provided title
  // 2. Writes result metadata (if threadId provided)
  // 3. Writes completion marker file (if threadId provided)
  return `${commandPrefix}sh -c '
RUN_EXIT=0
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Model: ${model}${variant ? ` (${variant})` : ""}"
echo "════════════════════════════════════════"
echo ""
cat "${escapedPath}" | opencode run --port ${port} --model "${model}"${variantFlag} --title "${escapedTitle}"
RUN_EXIT=$?
${resultWriteCmd}
${completionMarkerCmd}
exit $RUN_EXIT
'`
}

import type { NormalizedModelSpec } from "./types.ts"

/** Early failure threshold in seconds - retry only if exit happens faster than this */
const EARLY_FAILURE_THRESHOLD_SECONDS = 10

/**
 * Build the opencode run command with retry logic for multiple models
 *
 * Retry logic:
 * - Only retries if opencode exits within EARLY_FAILURE_THRESHOLD_SECONDS (early failure)
 * - Tries each model in order until one succeeds or runs past the threshold
 * - Writes completion marker file after first command finishes (if threadId provided)
 *
 * @param threadId - Optional thread ID for completion marker (e.g., "01.01.02")
 */
export function buildRetryRunCommand(
  port: number,
  models: NormalizedModelSpec[],
  promptPath: string,
  threadTitle: string,
  threadId?: string,
  options: RunCommandOptions = {},
): string {
  if (models.length === 0) {
    throw new Error("At least one model must be provided")
  }

  // If only one model, use simple command without retry logic
  if (models.length === 1) {
    const m = models[0]!
    return buildRunCommand(port, m.model, promptPath, threadTitle, m.variant, threadId, options)
  }

  // Escape single quotes in paths by replacing ' with '\''
  const escapedPath = promptPath.replace(/'/g, "'\\''")
  // Truncate and escape the title for shell safety
  const truncated = truncateTitle(threadTitle, 32)
  const escapedTitle = escapeForShell(truncated)

  // Build model attempt blocks
  const modelAttempts = models
    .map((m, i) => {
      const variantFlag = m.variant ? ` --variant "${m.variant}"` : ""
      const isLast = i === models.length - 1

      if (i === 0) {
        // First model - always try
        return `
  START_TIME=$(date +%s)
  echo "Trying model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$TITLE"
  EXIT_CODE=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  
  if [ $EXIT_CODE -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    FINAL_EXIT=$EXIT_CODE
  else
    echo ""
    echo "Model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit code: $EXIT_CODE, elapsed: \${ELAPSED}s). Trying next model..."
  fi`
      } else if (isLast) {
        // Last model - no retry after this
        return `
  if [ -z "$FINAL_EXIT" ]; then
    START_TIME=$(date +%s)
    echo "Trying model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
    cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$TITLE"
    FINAL_EXIT=$?
  fi`
      } else {
        // Middle models - check if should retry
        return `
  if [ -z "$FINAL_EXIT" ]; then
    START_TIME=$(date +%s)
    echo "Trying model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
    cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$TITLE"
    EXIT_CODE=$?
    ELAPSED=$(($(date +%s) - START_TIME))
    
    if [ $EXIT_CODE -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
      FINAL_EXIT=$EXIT_CODE
    else
      echo ""
      echo "Model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit code: $EXIT_CODE, elapsed: \${ELAPSED}s). Trying next model..."
    fi
  fi`
      }
    })
    .join("\n")

  const modelList = models.map(m => m.variant ? `${m.model} (${m.variant})` : m.model).join(" -> ")

  // Build completion marker command if threadId provided
  const completionMarkerCmd = threadId && options.streamId
    ? `echo "done" > "${getCompletionMarkerPath(options.streamId, threadId)}"`
    : ""

  const resultWriteCmd = buildResultWriteCommand(options.streamId, threadId, "FINAL_EXIT")
  const commandPrefix = buildCommandPrefix(options)

  return `${commandPrefix}sh -c '
FINAL_EXIT=""
TITLE="${escapedTitle}"
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Models: ${modelList}"
echo "════════════════════════════════════════"
echo ""
${modelAttempts}
if [ -z "$FINAL_EXIT" ]; then
  FINAL_EXIT=1
fi
${resultWriteCmd}
${completionMarkerCmd}
exit $FINAL_EXIT
'`
}

/**
 * Build the opencode serve command for display (dry-run mode)
 */
export function buildServeCommand(port: number = DEFAULT_PORT): string {
  return `opencode serve --port ${port}`
}
