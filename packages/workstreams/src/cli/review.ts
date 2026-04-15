/**
 * CLI: Workstream Review
 *
 * Output PLAN.md or tasks for review.
 */

import { existsSync, readFileSync } from "fs"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream, resolveStreamId, findStream } from "../lib/index.ts"
import { getStreamPlanMdPath } from "../lib/consolidate.ts"
import { getStreamPreview } from "../lib/stream-parser.ts"
import { getTasks } from "../lib/tasks.ts"
import {
    parseGitLog,
    groupCommitsByStage,
    identifyHumanCommits,
    getWorkstreamCommits,
    getCurrentBranch,
    getDefaultBranch,
    type ParsedCommit,
    type CommitsByStage,
} from "../lib/git/log.ts"

interface ReviewCliArgs {
    repoRoot?: string
    streamId?: string
    subcommand?: "plan" | "tasks" | "commits"
    summary: boolean
    json: boolean
    // Commits-specific options
    stage?: number
    files: boolean
}

export function isApprovalCommitSubject(subject: string): boolean {
    // Match only known automated approval commit subject shapes.
    return [
        /^Plan approved: .+/i,
        /^Tasks approved: .+/i,
        /^Stage \d+ approved: .+/i,
        /^Approve stage \d+: .+/i,
        /^approve plan for \S+$/i,
    ].some((pattern) => pattern.test(subject))
}

function printHelp(): void {
    console.log(`
work review - Review workstream artifacts

Usage:
  work review plan [--summary] [--stream <stream-id>]
  work review tasks [--stream <stream-id>]
  work review commits [--stage <num>] [--files] [--stream <stream-id>]

Subcommands:
  plan     Output full PLAN.md content
  tasks    Output tasks from tasks.json (confirms state even if empty)
  commits  Show commits grouped by stage for a workstream

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --summary        For plan: show Stage/Batch structure only (no thread details)
  --stage <num>    For commits: show commits for a specific stage only
  --files          For commits: include detailed file changes
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Review full PLAN.md
  work review plan

  # Review plan structure only (stages and batches)
  work review plan --summary

  # Review tasks
  work review tasks

  # Review commits for current workstream
  work review commits

  # Review commits for specific stage
  work review commits --stage 1

  # Review commits with file details
  work review commits --files

  # Review as JSON
  work review plan --json
`)
}

function parseCliArgs(argv: string[]): ReviewCliArgs | null {
    const args = argv.slice(2)
    const parsed: ReviewCliArgs = { summary: false, json: false, files: false }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]

        // Handle subcommand
        if (arg === "plan" && !parsed.subcommand) {
            parsed.subcommand = "plan"
            continue
        }
        if (arg === "tasks" && !parsed.subcommand) {
            parsed.subcommand = "tasks"
            continue
        }
        if (arg === "commits" && !parsed.subcommand) {
            parsed.subcommand = "commits"
            continue
        }

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

            case "--summary":
                parsed.summary = true
                break

            case "--json":
            case "-j":
                parsed.json = true
                break

            case "--stage":
                if (!next) {
                    console.error("Error: --stage requires a value")
                    return null
                }
                const stageNum = parseInt(next, 10)
                if (isNaN(stageNum) || stageNum <= 0) {
                    console.error("Error: --stage must be a positive number")
                    return null
                }
                parsed.stage = stageNum
                i++
                break

            case "--files":
                parsed.files = true
                break

            case "--help":
            case "-h":
                printHelp()
                process.exit(0)
        }
    }

    return parsed
}

/**
 * Format commit output for human-readable display
 */
function formatCommitOutput(
    streamId: string,
    branchName: string,
    commitsByStage: CommitsByStage[],
    humanCommits: ParsedCommit[],
    options: { files: boolean; stageFilter?: number }
): string {
    const lines: string[] = []

    lines.push(`Workstream: ${streamId}`)
    lines.push(`Branch: ${branchName}`)
    lines.push("")

    // Filter stages if requested
    const stagesToShow = options.stageFilter
        ? commitsByStage.filter((s) => s.stageNumber === options.stageFilter)
        : commitsByStage

    if (stagesToShow.length === 0 && options.stageFilter) {
        lines.push(`No commits found for stage ${options.stageFilter}`)
        return lines.join("\n")
    }

    for (const stage of stagesToShow) {
        lines.push(`## Stage ${String(stage.stageNumber).padStart(2, "0")}${stage.stageName ? `: ${stage.stageName}` : ""}`)
        lines.push("")

        // Separate stage approval commits from implementation commits
        const approvalCommits = stage.commits.filter((c) =>
            isApprovalCommitSubject(c.subject)
        )
        const implementationCommits = stage.commits.filter(
            (c) => !isApprovalCommitSubject(c.subject)
        )

        // Show stage approval commit(s)
        if (approvalCommits.length > 0) {
            lines.push("### Stage Approval Commit")
            for (const commit of approvalCommits) {
                lines.push(formatCommit(commit, options.files))
            }
            lines.push("")
        }

        // Show implementation commits
        if (implementationCommits.length > 0) {
            lines.push("### Implementation Commits")
            for (const commit of implementationCommits) {
                lines.push(formatCommit(commit, options.files))
            }
            lines.push("")
        }
    }

    // Show human commits (commits without workstream trailers)
    const relevantHumanCommits = options.stageFilter
        ? [] // Don't show human commits when filtering by stage
        : humanCommits

    if (relevantHumanCommits.length > 0) {
        lines.push("## Human Commits (manual/external)")
        lines.push("")
        for (const commit of relevantHumanCommits) {
            lines.push(formatCommit(commit, options.files))
        }
        lines.push("")
    }

    return lines.join("\n")
}

/**
 * Group files by directory for better readability
 */
function groupFilesByDirectory(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    
    for (const file of files) {
        // Extract directory (everything before the last /)
        const lastSlash = file.lastIndexOf("/")
        const dir = lastSlash >= 0 ? file.substring(0, lastSlash) : "."
        const basename = lastSlash >= 0 ? file.substring(lastSlash + 1) : file
        
        const existing = groups.get(dir) || []
        existing.push(basename)
        groups.set(dir, existing)
    }
    
    return groups
}

/**
 * Format a single commit for display
 */
function formatCommit(commit: ParsedCommit, showFiles: boolean): string {
    // Handle date formatting with fallback for invalid dates
    let dateStr = "unknown"
    if (commit.date) {
        try {
            const parsed = new Date(commit.date)
            if (!isNaN(parsed.getTime())) {
                const isoDate = parsed.toISOString().split("T")[0]
                dateStr = isoDate ?? "unknown" // YYYY-MM-DD
            }
        } catch {
            // If date parsing throws an error, keep "unknown"
            dateStr = "unknown"
        }
    }
    
    // Build file change summary
    const stats = commit.fileStats
    const statsParts: string[] = []
    if (stats.added > 0) statsParts.push(`+${stats.added}`)
    if (stats.modified > 0) statsParts.push(`~${stats.modified}`)
    if (stats.deleted > 0) statsParts.push(`-${stats.deleted}`)
    if (stats.renamed > 0) statsParts.push(`→${stats.renamed}`)
    
    const statsStr = statsParts.length > 0 ? ` (${statsParts.join(" ")})` : ""
    
    let line = `- ${commit.shortSha} [${dateStr}] ${commit.subject}${statsStr}`

    if (showFiles && commit.files.length > 0) {
        // Group files by directory for better readability
        const grouped = groupFilesByDirectory(commit.files)
        
        // Sort directories for consistent output
        const sortedDirs = Array.from(grouped.keys()).sort()
        
        // If only one directory or very few files, keep it simple
        if (sortedDirs.length === 1 && commit.files.length <= 3) {
            line += `\n  Files: ${commit.files.join(", ")}`
        } else {
            // Show grouped by directory
            line += "\n  Files:"
            for (const dir of sortedDirs) {
                const files = grouped.get(dir)!
                if (dir === ".") {
                    line += `\n    ${files.join(", ")}`
                } else {
                    line += `\n    ${dir}/: ${files.join(", ")}`
                }
            }
        }
    }

    return line
}

/**
 * Format output as JSON
 */
function formatCommitsJsonOutput(
    streamId: string,
    branchName: string,
    commitsByStage: CommitsByStage[],
    humanCommits: ParsedCommit[],
    options: { stageFilter?: number }
): string {
    const stagesToShow = options.stageFilter
        ? commitsByStage.filter((s) => s.stageNumber === options.stageFilter)
        : commitsByStage

    const output = {
        workstream: streamId,
        branch: branchName,
        stages: stagesToShow.map((stage) => ({
            stageNumber: stage.stageNumber,
            stageName: stage.stageName,
            commits: stage.commits.map((c) => ({
                sha: c.sha,
                shortSha: c.shortSha,
                author: c.author,
                authorEmail: c.authorEmail,
                date: c.date,
                subject: c.subject,
                files: c.files,
                trailers: c.trailers,
            })),
        })),
        humanCommits: options.stageFilter
            ? []
            : humanCommits.map((c) => ({
                sha: c.sha,
                shortSha: c.shortSha,
                author: c.author,
                authorEmail: c.authorEmail,
                date: c.date,
                subject: c.subject,
                files: c.files,
            })),
    }

    return JSON.stringify(output, null, 2)
}

function formatSummary(preview: ReturnType<typeof getStreamPreview>): string {
    const lines: string[] = []

    if (!preview.streamName) {
        return "Could not parse PLAN.md - invalid format"
    }

    lines.push(`# ${preview.streamName}`)
    lines.push("")

    for (const stage of preview.stages) {
        lines.push(`## Stage ${stage.number}: ${stage.name}`)
        for (const batch of stage.batches) {
            lines.push(`   - Batch ${batch.prefix}: ${batch.name} (${batch.threadCount} threads)`)
        }
        lines.push("")
    }

    const { open, resolved } = preview.questionCounts
    if (open > 0 || resolved > 0) {
        lines.push(`Open Questions: ${open} | Resolved: ${resolved}`)
    }

    return lines.join("\n")
}

export function main(argv: string[] = process.argv): void {
    const cliArgs = parseCliArgs(argv)
    if (!cliArgs) {
        console.error("\nRun with --help for usage information.")
        process.exit(1)
    }

    // Validate subcommand
    if (!cliArgs.subcommand) {
        console.error("Error: subcommand required (plan, tasks, or commits)")
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

    // Load index and find workstream (uses current if not specified)
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

    if (cliArgs.subcommand === "plan") {
        const planMdPath = getStreamPlanMdPath(repoRoot, stream.id)
        if (!existsSync(planMdPath)) {
            console.error(`Error: PLAN.md not found at ${planMdPath}`)
            process.exit(1)
        }

        const content = readFileSync(planMdPath, "utf-8")

        if (cliArgs.summary) {
            const preview = getStreamPreview(content)
            if (cliArgs.json) {
                console.log(JSON.stringify({
                    streamName: preview.streamName,
                    stageCount: preview.stageCount,
                    stages: preview.stages.map(s => ({
                        number: s.number,
                        name: s.name,
                        batches: s.batches.map(b => ({
                            prefix: b.prefix,
                            name: b.name,
                            threadCount: b.threadCount
                        }))
                    })),
                    questionCounts: preview.questionCounts
                }, null, 2))
            } else {
                console.log(formatSummary(preview))
            }
        } else {
            if (cliArgs.json) {
                console.log(JSON.stringify({ content }, null, 2))
            } else {
                console.log(content)
            }
        }
    } else if (cliArgs.subcommand === "tasks") {
        const tasks = getTasks(repoRoot, stream.id)

        if (cliArgs.json) {
            console.log(JSON.stringify({ tasks, count: tasks.length }, null, 2))
        } else {
            if (tasks.length === 0) {
                console.log("No tasks found.")
                console.log("\nUse 'work add-task' to add tasks to this workstream.")
            } else {
                console.log(`Tasks (${tasks.length} total):\n`)
                for (const task of tasks) {
                    const statusIcon = {
                        pending: "○",
                        in_progress: "◐",
                        completed: "●",
                        blocked: "⊘",
                        cancelled: "✗"
                    }[task.status] || "○"
                    console.log(`  ${statusIcon} ${task.id}: ${task.name}`)
                }
            }
        }
    } else if (cliArgs.subcommand === "commits") {
        // Get branch name from stream metadata or construct it
        let branchName: string
        if (stream.github?.branch) {
            branchName = stream.github.branch
        } else {
            // Fallback: construct branch name from stream ID
            branchName = `workstream/${stream.id}`
        }

        // Check if we're on the workstream branch
        try {
            const currentBranch = getCurrentBranch(repoRoot)
            if (currentBranch !== branchName) {
                console.warn(
                    `Warning: Currently on branch "${currentBranch}", but workstream branch is "${branchName}"`
                )
                console.warn("Commits will be shown for the workstream branch.")
                console.warn("")
            }
        } catch (e) {
            // Ignore errors getting current branch
        }

        // Parse git log for the workstream branch
        let commits: ParsedCommit[]
        try {
            const baseBranch = getDefaultBranch(repoRoot)
            commits = parseGitLog(repoRoot, branchName, baseBranch)
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`)
            process.exit(1)
        }

        if (commits.length === 0) {
            console.log(`No commits found for workstream "${stream.id}" on branch "${branchName}"`)
            return
        }

        // Filter commits for this workstream
        const workstreamCommits = getWorkstreamCommits(commits, stream.id)

        // Group commits by stage
        const commitsByStage = groupCommitsByStage(workstreamCommits, stream.id)

        // Identify human commits (those without workstream trailers)
        const humanCommits = identifyHumanCommits(commits)

        // Format and output
        if (cliArgs.json) {
            const output = formatCommitsJsonOutput(
                stream.id,
                branchName,
                commitsByStage,
                humanCommits,
                { stageFilter: cliArgs.stage }
            )
            console.log(output)
        } else {
            const output = formatCommitOutput(
                stream.id,
                branchName,
                commitsByStage,
                humanCommits,
                { files: cliArgs.files, stageFilter: cliArgs.stage }
            )
            console.log(output)
        }
    }
}

// Run if called directly
if (import.meta.main) {
    main()
}
