/**
 * CLI: Execute
 *
 * Executes a thread prompt via opencode with the assigned agent's model.
 */

import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { spawn } from "child_process"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { loadAgentsConfig, getAgentModels } from "../lib/agents-yaml.ts"
import {
  readTasksFile,
  parseTaskId,
  parseThreadId,
  getTasksByThread,
  startTaskSession,
  completeTaskSession,
} from "../lib/tasks.ts"
import { getThreadMetadata } from "../lib/threads.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import type { StreamDocument, SessionStatus } from "../lib/types.ts"

interface ExecuteCliArgs {
    repoRoot?: string
    streamId?: string
    threadId?: string
    agent?: string
    dryRun?: boolean
}

interface ResolvedThread {
    threadId: string  // Numeric format: "01.01.01"
    threadName: string
    stageName: string
    batchName: string
}

function printHelp(): void {
    console.log(`
work execute - Execute a thread prompt via opencode

Usage:
  work execute --thread "01.01.01" [options]
  work execute --thread "Dependencies & Config" [options]

Required:
  --thread, -t     Thread ID ("01.01.02") or thread name ("My Thread Name")

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --agent, -a      Override agent (uses thread's assigned agent if not specified)
  --dry-run        Show the command that would be run without executing
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Executes a thread by piping its prompt to opencode with the correct model.
  The model is determined from the assigned agent's definition in AGENTS.md.

  Threads can be specified by:
  - Numeric ID: "01.01.01" (stage.batch.thread)
  - Thread name: "Dependencies & Config" (case-insensitive, partial match)

  The agent's model field must be in "provider/model" format, e.g.:
  - google/gemini-3-flash-preview
  - anthropic/claude-sonnet-4

Examples:
  work execute --thread "01.01.01"
  work execute --thread "dependencies"
  work execute --thread "Server Module" --agent "backend-expert"
  work execute --thread "01.01.01" --dry-run
`)
}

function parseCliArgs(argv: string[]): ExecuteCliArgs | null {
    const args = argv.slice(2)
    const parsed: Partial<ExecuteCliArgs> = {}

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]

        switch (arg) {
            case "--repo-root":
            case "-r":
                if (!next) {
                    console.error("Error: --repo-root requires a value")
                    return null
                }
                parsed.repoRoot = next
                i++
                break

            case "--stream":
            case "-s":
                if (!next) {
                    console.error("Error: --stream requires a value")
                    return null
                }
                parsed.streamId = next
                i++
                break

            case "--thread":
            case "-t":
                if (!next) {
                    console.error("Error: --thread requires a value")
                    return null
                }
                parsed.threadId = next
                i++
                break

            case "--agent":
            case "-a":
                if (!next) {
                    console.error("Error: --agent requires a value")
                    return null
                }
                parsed.agent = next
                i++
                break

            case "--dry-run":
                parsed.dryRun = true
                break

            case "--help":
            case "-h":
                printHelp()
                process.exit(0)
        }
    }

    return parsed as ExecuteCliArgs
}

/**
 * Check if a string looks like a numeric thread ID (e.g., "01.02.03")
 */
function isNumericThreadId(threadId: string): boolean {
    const parts = threadId.split(".")
    if (parts.length !== 3) return false
    return parts.every((p) => /^\d+$/.test(p))
}

/**
 * Resolve a thread name to a numeric thread ID by searching the PLAN.md
 * Returns the first matching thread (case-insensitive, partial match)
 */
function resolveThreadByName(
    doc: StreamDocument,
    threadName: string
): ResolvedThread | null {
    const searchName = threadName.toLowerCase()

    for (const stage of doc.stages) {
        for (const batch of stage.batches) {
            for (const thread of batch.threads) {
                // Check for partial case-insensitive match
                if (thread.name.toLowerCase().includes(searchName)) {
                    const stageNum = stage.id.toString().padStart(2, "0")
                    const batchNum = batch.id.toString().padStart(2, "0")
                    const threadNum = thread.id.toString().padStart(2, "0")

                    return {
                        threadId: `${stageNum}.${batchNum}.${threadNum}`,
                        threadName: thread.name,
                        stageName: stage.name,
                        batchName: batch.name,
                    }
                }
            }
        }
    }

    return null
}

/**
 * Build the prompt file path for a thread
 * First checks tasks.json -> runtime_state.threads for a stored path, then falls back to PLAN.md reconstruction
 */
function getPromptFilePath(
    repoRoot: string,
    streamId: string,
    threadId: string
): string | null {
    const workDir = getWorkDir(repoRoot)
    
    // First, try canonical runtime_state.threads metadata
    const threadMeta = getThreadMetadata(repoRoot, streamId, threadId)
    if (threadMeta?.promptPath) {
        return join(workDir, threadMeta.promptPath)
    }
    
    // Fallback: reconstruct from PLAN.md (legacy behavior)
    const planPath = join(workDir, streamId, "PLAN.md")

    if (!existsSync(planPath)) {
        return null
    }

    const planContent = readFileSync(planPath, "utf-8")
    const errors: { message: string }[] = []
    const doc = parseStreamDocument(planContent, errors)

    if (!doc) {
        return null
    }

    // Parse thread ID: "01.02.03" -> stage 1, batch 2, thread 3
    const parts = threadId.split(".").map((p) => parseInt(p, 10))
    if (parts.length !== 3 || parts.some(isNaN)) {
        return null
    }
    const [stageNum, batchNum, threadNum] = parts

    const stage = doc.stages.find((s) => s.id === stageNum)
    if (!stage) return null

    const batch = stage.batches.find((b) => b.id === batchNum)
    if (!batch) return null

    const thread = batch.threads.find((t) => t.id === threadNum)
    if (!thread) return null

    // Build path matching prompt.ts logic
    const safeStageName = stage.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
    const safeBatchName = batch.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
    const safeThreadName = thread.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()

    const stagePrefix = stageNum!.toString().padStart(2, "0")

    return join(
        workDir,
        streamId,
        "prompts",
        `${stagePrefix}-${safeStageName}`,
        `${batch.prefix}-${safeBatchName}`,
        `${safeThreadName}.md`
    )
}

/**
 * Get the assigned agent name for a thread from tasks.json
 */
function getThreadAssignedAgent(
    repoRoot: string,
    streamId: string,
    threadId: string
): string | undefined {
    const tasksFile = readTasksFile(repoRoot, streamId)
    if (!tasksFile) return undefined

    // Parse thread ID to match task IDs that belong to this thread
    const parts = threadId.split(".").map((p) => parseInt(p, 10))
    if (parts.length !== 3) return undefined
    const [stageNum, batchNum, threadNum] = parts

    // Find first task in this thread that has an assigned agent
    for (const task of tasksFile.tasks) {
        try {
            const parsed = parseTaskId(task.id)
            if (parsed.stage === stageNum && parsed.batch === batchNum && parsed.thread === threadNum) {
                if (task.assigned_agent) {
                    return task.assigned_agent
                }
            }
        } catch {
            // Skip invalid task IDs
        }
    }

    return undefined
}

export async function main(argv: string[] = process.argv): Promise<void> {
    const cliArgs = parseCliArgs(argv)
    if (!cliArgs) {
        console.error("\nRun with --help for usage information.")
        process.exit(1)
    }

    if (!cliArgs.threadId) {
        console.error("Error: --thread is required")
        console.error("\nRun with --help for usage information.")
        process.exit(1)
    }

    // Auto-detect repo root if not provided
    let repoRoot: string
    try {
        repoRoot = cliArgs.repoRoot ?? getRepoRoot()
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }

    let index
    try {
        index = loadIndex(repoRoot)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }

    let stream
    try {
        stream = getResolvedStream(index, cliArgs.streamId)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }

    // Resolve thread ID (could be numeric or name)
    let resolvedThreadId = cliArgs.threadId
    let threadDisplayName = cliArgs.threadId

    if (!isNumericThreadId(cliArgs.threadId)) {
        // Try to resolve by name
        const workDir = getWorkDir(repoRoot)
        const planPath = join(workDir, stream.id, "PLAN.md")

        if (!existsSync(planPath)) {
            console.error(`Error: PLAN.md not found for stream ${stream.id}`)
            process.exit(1)
        }

        const planContent = readFileSync(planPath, "utf-8")
        const errors: { message: string }[] = []
        const doc = parseStreamDocument(planContent, errors)

        if (!doc) {
            console.error("Error: Could not parse PLAN.md")
            process.exit(1)
        }

        const resolved = resolveThreadByName(doc, cliArgs.threadId)
        if (!resolved) {
            console.error(`Error: Could not find thread matching "${cliArgs.threadId}"`)
            console.error("\nAvailable threads:")
            for (const stage of doc.stages) {
                for (const batch of stage.batches) {
                    for (const thread of batch.threads) {
                        const id = `${stage.id.toString().padStart(2, "0")}.${batch.id.toString().padStart(2, "0")}.${thread.id.toString().padStart(2, "0")}`
                        console.error(`  ${id}: ${thread.name}`)
                    }
                }
            }
            process.exit(1)
        }

        resolvedThreadId = resolved.threadId
        threadDisplayName = `${resolved.threadName} (${resolved.threadId})`
        console.log(`Resolved thread: "${cliArgs.threadId}" → ${threadDisplayName}`)
    }

    // Get prompt file path
    const promptPath = getPromptFilePath(repoRoot, stream.id, resolvedThreadId)
    if (!promptPath) {
        console.error(`Error: Could not find thread ${resolvedThreadId} in stream ${stream.id}`)
        process.exit(1)
    }

    if (!existsSync(promptPath)) {
        console.error(`Error: Prompt file not found: ${promptPath}`)
        console.error(`\nHint: Run 'work prompt --thread "${resolvedThreadId}"' to generate it first.`)
        process.exit(1)
    }

    // Determine agent
    let agentName = cliArgs.agent
    if (!agentName) {
        agentName = getThreadAssignedAgent(repoRoot, stream.id, resolvedThreadId)
    }

    if (!agentName) {
        // Default to "default" agent if no assignment
        agentName = "default"
    }

    // Get agent config
    const agentsConfig = loadAgentsConfig(repoRoot)
    if (!agentsConfig) {
        console.error("Error: No agents.yaml found. Run 'work init' to create one.")
        process.exit(1)
    }

    const models = getAgentModels(agentsConfig, agentName)
    if (models.length === 0) {
        console.error(`Error: Agent "${agentName}" not found in agents.yaml`)
        console.error(`\nAvailable agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`)
        process.exit(1)
    }

    // Use first model for single execute (no retry logic in simple execute)
    const primaryModel = models[0]!
    const variantFlag = primaryModel.variant ? ` --variant "${primaryModel.variant}"` : ""

    // Build and execute command
    const command = `cat "${promptPath}" | opencode run --model "${primaryModel.model}"${variantFlag}`

    if (cliArgs.dryRun) {
        console.log("Would execute:")
        console.log(command)
        console.log(`\nThread: ${threadDisplayName}`)
        console.log(`Agent: ${agentName}`)
        console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`)
        console.log(`Prompt: ${promptPath}`)
        return
    }

    // Get all tasks in this thread for session tracking
    const threadParsed = parseThreadId(resolvedThreadId)
    const threadTasks = getTasksByThread(
        repoRoot,
        stream.id,
        threadParsed.stage,
        threadParsed.batch,
        threadParsed.thread
    )

    // Start sessions for all tasks in the thread
    const modelString = primaryModel.variant
        ? `${primaryModel.model}:${primaryModel.variant}`
        : primaryModel.model
    
    const sessionIds: Map<string, string> = new Map()
    for (const task of threadTasks) {
        const session = startTaskSession(
            repoRoot,
            stream.id,
            task.id,
            agentName,
            modelString
        )
        if (session) {
            sessionIds.set(task.id, session.sessionId)
        }
    }

    console.log(`Executing thread ${threadDisplayName} with agent "${agentName}" (${primaryModel.model})...`)
    console.log(`Session tracking: ${sessionIds.size} task(s)`)
    console.log(`Prompt: ${promptPath}\n`)

    // Execute via shell to handle pipe
    const child = spawn("sh", ["-c", command], {
        stdio: "inherit",
        cwd: repoRoot,
    })

    child.on("close", (code) => {
        // Determine session status based on exit code
        const sessionStatus: SessionStatus = code === 0 ? "completed" : "failed"
        
        // Complete all sessions for this thread
        for (const [taskId, sessionId] of sessionIds) {
            completeTaskSession(
                repoRoot,
                stream.id,
                taskId,
                sessionId,
                sessionStatus,
                code ?? undefined
            )
        }
        
        process.exit(code ?? 0)
    })

    child.on("error", (err) => {
        // Mark all sessions as failed on error
        for (const [taskId, sessionId] of sessionIds) {
            completeTaskSession(
                repoRoot,
                stream.id,
                taskId,
                sessionId,
                "failed"
            )
        }
        
        console.error(`Error executing command: ${err.message}`)
        process.exit(1)
    })
}

// Run if called directly
if (import.meta.main) {
    await main()
}
