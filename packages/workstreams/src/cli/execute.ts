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
import { generateSessionId } from "../lib/session-id.ts"
import { startThreadSession, completeThreadSession } from "../lib/threads.ts"
import { getPromptContext, generateThreadPrompt } from "../lib/prompts.ts"
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

    let promptContext: ReturnType<typeof getPromptContext>
    let promptContent: string
    try {
        promptContext = getPromptContext(repoRoot, stream.id, resolvedThreadId)
        promptContent = generateThreadPrompt(promptContext)
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`)
        console.error(`\nHint: Run 'work approve plan', 'work approve revision', or 'work validate work' to create or verify thread WORK.md files.`)
        process.exit(1)
    }

    // Determine agent
    let agentName = cliArgs.agent
    if (!agentName) {
        agentName = promptContext.agentName
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

    const command = `printf '%s' "$GENERATED_THREAD_PROMPT" | opencode run --model "${primaryModel.model}"${variantFlag}`

    if (cliArgs.dryRun) {
        console.log("Would execute:")
        console.log(command)
        console.log(`\nThread: ${threadDisplayName}`)
        console.log(`Agent: ${agentName}`)
        console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`)
        console.log(`Prompt: generated in memory from thread context and ${promptContext.references.threadWorkPath}`)
        return
    }

    const modelString = primaryModel.variant
        ? `${primaryModel.model}:${primaryModel.variant}`
        : primaryModel.model
    const session = startThreadSession(
        repoRoot,
        stream.id,
        resolvedThreadId,
        agentName,
        modelString,
        generateSessionId(),
    )

    console.log(`Executing thread ${threadDisplayName} with agent "${agentName}" (${primaryModel.model})...`)
    console.log(`Session tracking: ${session ? resolvedThreadId : "unavailable"}`)
    console.log(`Prompt: generated in memory from thread context and ${promptContext.references.threadWorkPath}\n`)

    const childArgs = ["run", "--model", primaryModel.model]
    if (primaryModel.variant) {
        childArgs.push("--variant", primaryModel.variant)
    }

    const child = spawn("opencode", childArgs, {
        stdio: ["pipe", "inherit", "inherit"],
        cwd: repoRoot,
    })

    child.stdin?.end(promptContent)

    child.on("close", (code) => {
        // Determine session status based on exit code
        const sessionStatus: SessionStatus = code === 0 ? "completed" : "failed"
        
        if (session) {
            completeThreadSession(
                repoRoot,
                stream.id,
                resolvedThreadId,
                session.sessionId,
                sessionStatus,
                code ?? undefined
            )
        }
        
        process.exit(code ?? 0)
    })

    child.on("error", (err) => {
        if (session) {
            completeThreadSession(
                repoRoot,
                stream.id,
                resolvedThreadId,
                session.sessionId,
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
