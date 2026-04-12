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
 * Used to signal when opencode run finishes (before session resume)
 * 
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the completion marker file
 */
export function getCompletionMarkerPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-complete.txt`
}

/**
 * Get the session file path for storing the opencode session ID
 * Used to capture the actual opencode session ID for workstream tracking
 * 
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the session ID file
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
 * Get the synthesis output file path for capturing synthesis agent output
 * Used for the synthesis agent to write its summary output
 * 
 * @param streamId - Stream/workstream ID (e.g., "001-my-workstream")
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Absolute path to the synthesis output file in /tmp
 */
export function getSynthesisOutputPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-synthesis.txt`
}

/**
 * Get the working agent session file path for synthesis mode
 * Used to capture the inner working agent's session ID
 * 
 * @param streamId - Stream/workstream ID (e.g., "001-my-workstream")
 * @param threadId - Thread ID (e.g., "01.01.02")
 * @returns Path to the working agent session file
 */
export function getWorkingAgentSessionPath(streamId: string, threadId: string): string {
  return `/tmp/workstream-${streamId}-${threadId}-working-session.txt`
}

/**
 * Get the synthesis log path for logging synthesis process info
 * Used to log timestamps, file sizes, and other synthesis metadata
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

function buildHeadlessCheck(): string {
  return `[ "\${${WORKSTREAM_HEADLESS_ENV}:-0}" = "1" ]`
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
 * Build the opencode run command with --title flag and session resume logic
 * Wrapped in sh -c to properly handle piped commands in tmux
 *
 * The command:
 * 1. Generates a unique tracking ID
 * 2. Runs opencode with a title containing the tracking ID
 * 3. Writes a completion marker file to signal first command done (for notification timing)
 * 4. After completion, searches for the session by tracking ID
 * 5. Writes the session ID to a temp file for workstream tracking (if threadId provided)
 * 6. Resumes the session with opencode TUI if found
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

  // Build session file write command if threadId provided
  const sessionFilePath = threadId && options.streamId
    ? getSessionFilePath(options.streamId, threadId)
    : ""
  const writeSessionCmd = threadId && options.streamId
    ? `\n    echo "$SESSION_ID" > "${sessionFilePath}"`
    : ""
  const resultWriteCmd = buildResultWriteCommand(options.streamId, threadId, "RUN_EXIT")
  const commandPrefix = buildCommandPrefix(options)
  const postRunAction = options.headless
    ? `echo "Headless mode detected - skipping session resume."\nexit $RUN_EXIT`
    : `if ${buildHeadlessCheck()}; then
  echo "Headless mode detected - skipping session resume."
  exit $RUN_EXIT
fi
if [ -n "$SESSION_ID" ]; then
  echo "Resuming session $SESSION_ID..."
  opencode --session "$SESSION_ID"
else
  echo "Press Enter to close."
  read
fi
exit $RUN_EXIT`

  // Build a shell script that:
  // 1. Generates a unique tracking ID (16 chars from nanosecond timestamp)
  // 2. Runs opencode run with the title containing the tracking ID
  // 3. Writes completion marker file (if threadId provided)
  // 4. After completion, searches for the session by tracking ID using jq
  // 5. Writes the session ID to a temp file for workstream tracking (if threadId provided)
  // 6. Resumes the session with opencode TUI if found
  return `${commandPrefix}sh -c '
TRACK_ID=$(date +%s%N | head -c 16)
TITLE="${escapedTitle}__id=$TRACK_ID"
RUN_EXIT=0
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Model: ${model}${variant ? ` (${variant})` : ""}"
echo "════════════════════════════════════════"
echo ""
cat "${escapedPath}" | opencode run --port ${port} --model "${model}"${variantFlag} --title "$TITLE"
RUN_EXIT=$?
echo ""
echo "Thread finished. Looking for session to resume..."
SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__id=$TRACK_ID\\")) | .id" | head -1)
  if [ -n "$SESSION_ID" ]; then${writeSessionCmd}
    echo "Session found: $SESSION_ID"
  else
    echo "Session not found."
  fi
else
  echo "jq not found - install jq to enable session resume"
fi
${resultWriteCmd}
${completionMarkerCmd}
${postRunAction}
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
 * - Session resume logic is NOT wrapped in retry (user Ctrl+C exits normally)
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

  // Build session file write command if threadId provided
  const sessionFilePath = threadId && options.streamId
    ? getSessionFilePath(options.streamId, threadId)
    : ""
  const writeSessionCmd = threadId && options.streamId
    ? `\n    echo "$SESSION_ID" > "${sessionFilePath}"`
    : ""
  const resultWriteCmd = buildResultWriteCommand(options.streamId, threadId, "FINAL_EXIT")
  const commandPrefix = buildCommandPrefix(options)
  const postRunAction = options.headless
    ? `echo "Headless mode detected - skipping session resume."\nexit $FINAL_EXIT`
    : `if ${buildHeadlessCheck()}; then
  echo "Headless mode detected - skipping session resume."
  exit $FINAL_EXIT
fi
if [ -n "$SESSION_ID" ]; then
  echo "Resuming session $SESSION_ID..."
  opencode --session "$SESSION_ID"
else
  echo "Press Enter to close."
  read
fi
exit $FINAL_EXIT`

  return `${commandPrefix}sh -c '
TRACK_ID=$(date +%s%N | head -c 16)
TITLE="${escapedTitle}__id=$TRACK_ID"
FINAL_EXIT=""
SESSION_ID=""
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Models: ${modelList}"
echo "════════════════════════════════════════"
echo ""
${modelAttempts}
if [ -z "$FINAL_EXIT" ]; then
  FINAL_EXIT=1
fi
echo ""
echo "Thread finished. Looking for session to resume..."
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__id=$TRACK_ID\\")) | .id" | head -1)
  if [ -n "$SESSION_ID" ]; then${writeSessionCmd}
    echo "Session found: $SESSION_ID"
  else
    echo "Session not found."
  fi
else
  echo "jq not found - install jq to enable session resume"
fi
${resultWriteCmd}
${completionMarkerCmd}
${postRunAction}
'`
}

/**
 * Options for building synthesis run command
 */
export interface SynthesisRunOptions {
  port: number
  /** Models for the synthesis agent (outer agent) */
  synthesisModels: NormalizedModelSpec[]
  /** Models for the working agent (inner agent) */
  workingModels: NormalizedModelSpec[]
  /** Path to the prompt file for the working agent */
  promptPath: string
  /** Thread title for display */
  threadTitle: string
  /** Stream/workstream ID for file paths */
  streamId: string
  /** Thread ID for file paths */
  threadId: string
  headless?: boolean
}

/**
 * Build the opencode run command with synthesis agent wrapping
 *
 * This creates a two-level agent execution (LEGACY APPROACH):
 * 1. Outer: Synthesis agent that orchestrates and summarizes
 * 2. Inner: Working agent that executes the actual task
 *
 * Flow:
 * - Generate unique tracking IDs for both agents
 * - Synthesis agent receives prompt with working agent command embedded
 * - Working agent executes the task (via opencode run)
 * - Synthesis agent summarizes after working agent completes
 * - Output written to synthesis output file for capture
 *
 * Error Handling:
 * - If synthesis agent fails, still capture working agent session ID if available
 * - If working agent crashes, synthesis agent notes this in summary
 * - If synthesis output file is empty/missing, consumers should log warning but not fail
 *
 * @deprecated Use {@link buildPostSynthesisCommand} instead. This "wrapper" approach
 * has been replaced by a post-session approach where the working agent runs first
 * with full TUI visibility, then synthesis runs headless after completion.
 * The new approach provides better user experience as users can see and interact
 * with the working agent directly, and resume directly into that session.
 *
 * @param options - Synthesis run configuration
 * @returns Shell command string for tmux execution
 * @throws Error if no synthesis models or working models are provided
 */
export function buildSynthesisRunCommand(options: SynthesisRunOptions): string {
  const {
    port,
    synthesisModels,
    workingModels,
    promptPath,
    threadTitle,
    streamId,
    threadId,
    headless = false,
  } = options

  if (synthesisModels.length === 0) {
    throw new Error("At least one synthesis model must be provided")
  }
  if (workingModels.length === 0) {
    throw new Error("At least one working model must be provided")
  }

  // Escape paths and title for shell safety
  const escapedPath = promptPath.replace(/'/g, "'\\''")
  const truncated = truncateTitle(threadTitle, 32)
  const escapedTitle = escapeForShell(truncated)

  // File paths for tracking
  const synthesisOutputPath = getSynthesisOutputPath(streamId, threadId)
  const workingSessionPath = getWorkingAgentSessionPath(streamId, threadId)
  const completionMarkerPath = getCompletionMarkerPath(streamId, threadId)
  const sessionFilePath = getSessionFilePath(streamId, threadId)

  // Build model lists for display
  const synthesisModelList = synthesisModels
    .map((m) => (m.variant ? `${m.model} (${m.variant})` : m.model))
    .join(" -> ")
  const workingModelList = workingModels
    .map((m) => (m.variant ? `${m.model} (${m.variant})` : m.model))
    .join(" -> ")

  // Build the working agent command that synthesis agent will execute
  // This is a simplified version without session resume (synthesis agent handles that)
  const workingModelAttempts = buildWorkingAgentModelAttempts(
    port,
    workingModels,
    escapedPath,
  )

  // Build synthesis model attempts for the outer agent
  const synthesisModelAttempts = buildSynthesisModelAttempts(
    port,
    synthesisModels,
    escapedTitle,
    workingModelAttempts,
    workingSessionPath,
    synthesisOutputPath,
  )
  const resultWriteCmd = buildResultWriteCommand(streamId, threadId, "FINAL_EXIT")
  const commandPrefix = buildCommandPrefix({ headless })
  const postRunAction = headless
    ? `echo "Headless mode detected - skipping session resume."\nexit $FINAL_EXIT`
    : `if ${buildHeadlessCheck()}; then
  echo "Headless mode detected - skipping session resume."
  exit $FINAL_EXIT
fi
if [ -n "$SESSION_ID" ]; then
  echo "Resuming synthesis session $SESSION_ID..."
  opencode --session "$SESSION_ID"
elif [ -n "$WORK_SESSION_ID" ]; then
  echo "Resuming working session $WORK_SESSION_ID..."
  opencode --session "$WORK_SESSION_ID"
else
  echo "Press Enter to close."
  read
fi
exit $FINAL_EXIT`

  return `${commandPrefix}sh -c '
SYNTH_TRACK_ID=$(date +%s%N | head -c 16)
WORK_TRACK_ID=$(date +%s%N | tail -c 16 | head -c 16)
SYNTH_TITLE="${escapedTitle}__synth_id=$SYNTH_TRACK_ID"
WORK_TITLE="${escapedTitle}__work_id=$WORK_TRACK_ID"
FINAL_EXIT=""
SESSION_ID=""
WORK_SESSION_ID=""
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Mode: Synthesis"
echo "Synthesis Models: ${synthesisModelList}"
echo "Working Models: ${workingModelList}"
echo "════════════════════════════════════════"
echo ""

# Initialize output files
echo "" > "${synthesisOutputPath}"
echo "" > "${workingSessionPath}"

${synthesisModelAttempts}

if [ -z "$FINAL_EXIT" ]; then
  FINAL_EXIT=1
fi

echo ""
echo "Synthesis complete. Looking for session to resume..."
if command -v jq >/dev/null 2>&1; then
  # Try to find synthesis agent session first
  SESSION_ID=$(opencode session list --max-count 30 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__synth_id=$SYNTH_TRACK_ID\\")) | .id" | head -1)
  if [ -n "$SESSION_ID" ]; then
    echo "$SESSION_ID" > "${sessionFilePath}"
    echo "Synthesis session found: $SESSION_ID"
  else
    # Fallback: try working agent session
    WORK_SESSION_ID=$(cat "${workingSessionPath}" 2>/dev/null | tr -d "\\n")
    if [ -n "$WORK_SESSION_ID" ]; then
      echo "$WORK_SESSION_ID" > "${sessionFilePath}"
      echo "Working session found: $WORK_SESSION_ID"
    else
      echo "No session found."
    fi
  fi
else
  echo "jq not found - install jq to enable session resume"
fi
${resultWriteCmd}
echo "done" > "${completionMarkerPath}"
${postRunAction}
'`
}

/**
 * Build the working agent model attempts (inner loop for synthesis)
 * This is a simplified version that doesn't include session resume
 */
function buildWorkingAgentModelAttempts(
  port: number,
  models: NormalizedModelSpec[],
  escapedPath: string,
): string {
  return models
    .map((m, i) => {
      const variantFlag = m.variant ? ` --variant \\"${m.variant}\\"` : ""
      const isLast = i === models.length - 1

      if (i === 0) {
        return `
START_TIME=$(date +%s)
echo \\"Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}\\"
cat \\"${escapedPath}\\" | opencode run --port ${port} --model \\"${m.model}\\"${variantFlag} --title \\"$WORK_TITLE\\"
WORK_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  WORK_FINAL_EXIT=$WORK_EXIT
else
  echo \\"\\"
  echo \\"Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s. Trying next...\\"
fi`
      } else if (isLast) {
        return `
if [ -z \\"$WORK_FINAL_EXIT\\" ]; then
  echo \\"Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}\\"
  cat \\"${escapedPath}\\" | opencode run --port ${port} --model \\"${m.model}\\"${variantFlag} --title \\"$WORK_TITLE\\"
  WORK_FINAL_EXIT=$?
fi`
      } else {
        return `
if [ -z \\"$WORK_FINAL_EXIT\\" ]; then
  START_TIME=$(date +%s)
  echo \\"Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}\\"
  cat \\"${escapedPath}\\" | opencode run --port ${port} --model \\"${m.model}\\"${variantFlag} --title \\"$WORK_TITLE\\"
  WORK_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    WORK_FINAL_EXIT=$WORK_EXIT
  else
    echo \\"\\"
    echo \\"Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s. Trying next...\\"
  fi
fi`
      }
    })
    .join("\n")
}

/**
 * Build the synthesis prompt that instructs synthesis agent to:
 * 1. Execute the working agent command
 * 2. Capture the working agent session ID
 * 3. Summarize the results after completion
 */
function buildSynthesisPrompt(
  workingAgentCmd: string,
  workingSessionPath: string,
  synthesisOutputPath: string,
): string {
  // The synthesis prompt tells the synthesis agent what to do
  // It will be piped to the synthesis agent via stdin
  return `You are a synthesis agent orchestrating a working agent session.

## Your Tasks

1. **Execute the working agent**: Run the following shell command to spawn the working agent:

\\\`\\\`\\\`bash
${workingAgentCmd}
\\\`\\\`\\\`

2. **Capture session ID**: After the working agent completes, find its session ID and save it:

\\\`\\\`\\\`bash
# Find working agent session by tracking ID
WORK_SESSION=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r '.[] | select(.title | contains("__work_id=")) | .id' | head -1)
echo "$WORK_SESSION" > "${workingSessionPath}"
\\\`\\\`\\\`

3. **Summarize results**: Review what the working agent accomplished and write a brief summary to the synthesis output file:

\\\`\\\`\\\`bash
echo "YOUR_SUMMARY_HERE" > "${synthesisOutputPath}"
\\\`\\\`\\\`

## Error Handling

- If the working agent fails or crashes, note this in your summary
- Always try to capture the working agent session ID, even on failure
- Write something to the synthesis output file even if it's just an error note

## Summary Guidelines

Your summary should include:
- What task was assigned to the working agent
- Whether it completed successfully
- Key changes or outcomes (if any)
- Any errors or issues encountered

Keep the summary concise (2-5 sentences).`
}

/**
 * Build the synthesis model attempts (outer loop)
 */
function buildSynthesisModelAttempts(
  port: number,
  models: NormalizedModelSpec[],
  escapedTitle: string,
  workingAgentCmd: string,
  workingSessionPath: string,
  synthesisOutputPath: string,
): string {
  // Build the synthesis prompt
  const synthesisPrompt = buildSynthesisPrompt(
    workingAgentCmd,
    workingSessionPath,
    synthesisOutputPath,
  )

  // Escape the prompt for shell embedding (it will be echo'd)
  const escapedPrompt = synthesisPrompt
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")

  return models
    .map((m, i) => {
      const variantFlag = m.variant ? ` --variant "${m.variant}"` : ""
      const isLast = i === models.length - 1

      if (i === 0) {
        return `
START_TIME=$(date +%s)
echo "Starting synthesis agent (model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""})..."
echo "${escapedPrompt}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$SYNTH_TITLE"
SYNTH_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  FINAL_EXIT=$SYNTH_EXIT
else
  echo ""
  echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s. Trying next..."
fi`
      } else if (isLast) {
        return `
if [ -z "$FINAL_EXIT" ]; then
  echo "Starting synthesis agent (model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""})..."
  echo "${escapedPrompt}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$SYNTH_TITLE"
  FINAL_EXIT=$?
fi`
      } else {
        return `
if [ -z "$FINAL_EXIT" ]; then
  START_TIME=$(date +%s)
  echo "Starting synthesis agent (model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""})..."
  echo "${escapedPrompt}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$SYNTH_TITLE"
  SYNTH_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    FINAL_EXIT=$SYNTH_EXIT
  else
    echo ""
    echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s. Trying next..."
  fi
fi`
      }
    })
    .join("\n")
}

/**
 * Options for building post-synthesis run command
 */
export interface PostSynthesisOptions {
  port: number
  /** Models for the working agent (runs first with TUI) */
  workingModels: NormalizedModelSpec[]
  /** Models for the synthesis agent (runs after, headless) */
  synthesisModels: NormalizedModelSpec[]
  /** Path to the prompt file for the working agent */
  promptPath: string
  /** Thread title for display */
  threadTitle: string
  /** Stream/workstream ID for file paths */
  streamId: string
  /** Thread ID for file paths */
  threadId: string
  headless?: boolean
}

/**
 * Build the opencode run command with post-session synthesis
 *
 * This creates a sequential two-phase execution:
 * 1. Working agent runs with full TUI (user can interact)
 * 2. After completion, synthesis agent runs headless to summarize
 *
 * Flow:
 * - Generate unique tracking ID for working agent
 * - Run working agent with full TUI
 * - Find working agent session ID by tracking ID
 * - Export session to JSON
 * - Extract assistant text messages using jq
 * - Run synthesis agent headless with context piped in
 * - Capture synthesis output to temp file
 * - Write completion marker (notification fires here, synthesis output available)
 * - Resume WORKING agent session (not synthesis) for user review
 *
 * Key benefits over legacy wrapper approach:
 * - Working agent runs first (not wrapped by synthesis)
 * - User sees working agent TUI directly and can interact with it
 * - Synthesis runs headless after completion, not blocking the user
 * - Completion marker written AFTER synthesis (so output is available for notifications)
 * - Session resume ALWAYS opens the working agent session (the one the user cares about),
 *   never the synthesis agent session.
 *
 * @param options - Post-synthesis run configuration
 * @returns Shell command string for tmux execution
 * @throws Error if no synthesis models or working models are provided
 */
export function buildPostSynthesisCommand(options: PostSynthesisOptions): string {
  const {
    port,
    workingModels,
    synthesisModels,
    promptPath,
    threadTitle,
    streamId,
    threadId,
    headless = false,
  } = options

  if (workingModels.length === 0) {
    throw new Error("At least one working model must be provided")
  }
  if (synthesisModels.length === 0) {
    throw new Error("At least one synthesis model must be provided")
  }

  // Escape paths and title for shell safety
  const escapedPath = promptPath.replace(/'/g, "'\\''")
  const truncated = truncateTitle(threadTitle, 32)
  const escapedTitle = escapeForShell(truncated)

  // File paths for tracking
  const completionMarkerPath = getCompletionMarkerPath(streamId, threadId)
  const sessionFilePath = getSessionFilePath(streamId, threadId)
  const exportedSessionPath = `/tmp/workstream-${streamId}-${threadId}-exported-session.json`
  const extractedContextPath = `/tmp/workstream-${streamId}-${threadId}-context.txt`
  const synthesisJsonPath = `/tmp/workstream-${streamId}-${threadId}-synthesis.json`
  const synthesisLogPath = getSynthesisLogPath(streamId, threadId)

  // Build model lists for display
  const workingModelList = workingModels
    .map((m) => (m.variant ? `${m.model} (${m.variant})` : m.model))
    .join(" -> ")
  const synthesisModelList = synthesisModels
    .map((m) => (m.variant ? `${m.model} (${m.variant})` : m.model))
    .join(" -> ")

  // Build working agent model attempts (with retry logic)
  const workingModelAttempts = buildPostSynthesisWorkingAgentAttempts(
    port,
    workingModels,
    escapedPath,
  )

  // Build synthesis agent model attempts (headless with --format json)
  const synthesisModelAttempts = buildPostSynthesisSynthesisAgentAttempts(
    port,
    synthesisModels,
    extractedContextPath,
    synthesisJsonPath,
  )

  // jq command to extract assistant text messages from exported session
  // Format: .messages[] | select(.info.role=="assistant") | .parts[] | select(.type=="text") | .text
  // Note: Use double quotes for the jq filter to avoid escaping issues inside sh -c '...'
  const jqExtractCommand = `jq -r ".messages[] | select(.info.role==\\"assistant\\") | .parts[] | select(.type==\\"text\\") | .text"`
  const resultWriteCmd = buildResultWriteCommand(streamId, threadId, "THREAD_FINAL_EXIT")
  const commandPrefix = buildCommandPrefix({ headless })
  const postRunAction = headless
    ? `echo "Headless mode detected - skipping session resume."\nexit $THREAD_FINAL_EXIT`
    : `if ${buildHeadlessCheck()}; then
  echo "Headless mode detected - skipping session resume."
  exit $THREAD_FINAL_EXIT
fi
if [ -n "$WORK_SESSION_ID" ]; then
  opencode --session "$WORK_SESSION_ID"
else
  echo "No working session available. Press Enter to close."
  read
fi
exit $THREAD_FINAL_EXIT`

  return `${commandPrefix}sh -c '
WORK_TRACK_ID=$(date +%s%N | head -c 16)
WORK_TITLE="${escapedTitle}__work_id=$WORK_TRACK_ID"
WORK_FINAL_EXIT=""
SYNTH_FINAL_EXIT=""
THREAD_FINAL_EXIT=""
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Mode: Post-Session Synthesis"
echo "Working Models: ${workingModelList}"
echo "Synthesis Models: ${synthesisModelList}"
echo "════════════════════════════════════════"
echo ""

# Phase 1: Run working agent with full TUI
echo "▶ Phase 1: Running working agent..."
echo ""
${workingModelAttempts}

echo ""
echo "Working agent finished (exit: $WORK_FINAL_EXIT)."
echo ""

# Find working agent session ID by tracking ID
WORK_SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  WORK_SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__work_id=$WORK_TRACK_ID\\")) | .id" | head -1)
fi

if [ -z "$WORK_SESSION_ID" ]; then
  echo "Warning: Could not find working agent session ID."
  echo "Synthesis will run without session context."
else
  echo "Found working session: $WORK_SESSION_ID"
  
  # Export session to JSON
  echo "Exporting session..."
  opencode export "$WORK_SESSION_ID" > "${exportedSessionPath}" 2>/dev/null
  
  # Extract assistant text messages using jq
  echo "Extracting context..."
  ${jqExtractCommand} "${exportedSessionPath}" > "${extractedContextPath}" 2>/dev/null
fi

# Phase 2: Run synthesis agent headless
echo ""
echo "▶ Phase 2: Running synthesis agent (headless)..."
echo ""
${synthesisModelAttempts}

echo ""
echo "Synthesis complete."

# Log synthesis metadata
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") Synthesis finished" >> "${synthesisLogPath}"
if [ -f "${synthesisJsonPath}" ]; then
  FILE_SIZE=$(wc -c < "${synthesisJsonPath}" 2>/dev/null || echo "0")
  echo "Synthesis output size: $FILE_SIZE bytes" >> "${synthesisLogPath}"
fi

# Save working session ID for workstream tracking
if [ -n "$WORK_SESSION_ID" ]; then
  echo "$WORK_SESSION_ID" > "${sessionFilePath}"
fi

# Resume WORKING agent session (not synthesis)
echo ""
echo "Opening working session for review..."
THREAD_FINAL_EXIT="$WORK_FINAL_EXIT"
if [ -n "$SYNTH_FINAL_EXIT" ] && [ "$SYNTH_FINAL_EXIT" -ne 0 ]; then
  THREAD_FINAL_EXIT="$SYNTH_FINAL_EXIT"
fi
if [ -z "$THREAD_FINAL_EXIT" ]; then
  THREAD_FINAL_EXIT=1
fi
${resultWriteCmd}

# Write completion marker only after canonical artifacts are stored.
echo "done" > "${completionMarkerPath}"
${postRunAction}
'`
}

/**
 * Build working agent model attempts for post-synthesis command
 * Similar to buildRetryRunCommand but without session resume logic
 */
function buildPostSynthesisWorkingAgentAttempts(
  port: number,
  models: NormalizedModelSpec[],
  escapedPath: string,
): string {
  return models
    .map((m, i) => {
      const variantFlag = m.variant ? ` --variant "${m.variant}"` : ""
      const isLast = i === models.length - 1

      if (i === 0) {
        return `
START_TIME=$(date +%s)
echo "Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$WORK_TITLE"
WORK_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  WORK_FINAL_EXIT=$WORK_EXIT
else
  echo ""
  echo "Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $WORK_EXIT). Trying next..."
fi`
      } else if (isLast) {
        return `
if [ -z "$WORK_FINAL_EXIT" ]; then
  echo "Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$WORK_TITLE"
  WORK_FINAL_EXIT=$?
fi`
      } else {
        return `
if [ -z "$WORK_FINAL_EXIT" ]; then
  START_TIME=$(date +%s)
  echo "Trying working model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m.model}"${variantFlag} --title "$WORK_TITLE"
  WORK_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    WORK_FINAL_EXIT=$WORK_EXIT
  else
    echo ""
    echo "Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $WORK_EXIT). Trying next..."
  fi
fi`
      }
    })
    .join("\n")
}

/**
 * Build synthesis agent model attempts for post-synthesis command
 * Runs headless with --format json to capture output
 */
function buildPostSynthesisSynthesisAgentAttempts(
  port: number,
  models: NormalizedModelSpec[],
  contextPath: string,
  outputJsonPath: string,
): string {
  return models
    .map((m, i) => {
      const variantFlag = m.variant ? ` --variant "${m.variant}"` : ""
      const isLast = i === models.length - 1

      // Build the synthesis command with context injection
      // The synthesis prompt file should contain placeholders or instructions
      // We pipe the prompt with context appended
      const synthCommand = `(echo "You are a synthesis agent reviewing a completed working agent session. Use the synthesizing-workstreams skill to continue"; echo ""; echo "## Working Agent Session Context"; echo ""; echo "The working agent session context follows below. Analyze it and provide your summary."; echo ""; cat "${contextPath}" 2>/dev/null || echo "(no context available)") | opencode run --port ${port} --model "${m.model}"${variantFlag} --format json > "${outputJsonPath}" 2>&1`

      if (i === 0) {
        return `
START_TIME=$(date +%s)
echo "Trying synthesis model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
${synthCommand}
SYNTH_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  SYNTH_FINAL_EXIT=$SYNTH_EXIT
else
  echo ""
  echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $SYNTH_EXIT). Trying next..."
fi`
      } else if (isLast) {
        return `
if [ -z "$SYNTH_FINAL_EXIT" ]; then
  echo "Trying synthesis model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
  ${synthCommand}
  SYNTH_FINAL_EXIT=$?
fi`
      } else {
        return `
if [ -z "$SYNTH_FINAL_EXIT" ]; then
  START_TIME=$(date +%s)
  echo "Trying synthesis model ${i + 1}/${models.length}: ${m.model}${m.variant ? ` (variant: ${m.variant})` : ""}"
  ${synthCommand}
  SYNTH_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    SYNTH_FINAL_EXIT=$SYNTH_EXIT
  else
    echo ""
    echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $SYNTH_EXIT). Trying next..."
  fi
fi`
      }
    })
    .join("\n")
}

/**
 * Build the opencode serve command for display (dry-run mode)
 */
export function buildServeCommand(port: number = DEFAULT_PORT): string {
  return `opencode serve --port ${port}`
}
