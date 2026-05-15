/**
 * Stage report generation
 *
 * Generates stage completion reports from execution item data.
 * Reports aggregate execution item reports by batch/thread for stage-gate review.
 */

import { join } from "path"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import type { ExecutionItem, ExecutionStatus, StageDefinition, ConsolidateError } from "./types.ts"
import { loadIndex, findStream } from "./index.ts"
import { listThreadExecutionItems } from "./thread-execution.ts"
import { getWorkDir } from "./repo.ts"
import { resolveByNameOrIndex } from "./utils.ts"
import { parseStreamDocument } from "./stream-parser.ts"

export interface StageReportData {
    stageNumber: number
    stageName: string
    stagePrefix: string
    streamId: string
    streamName: string
    generatedAt: string
    status: "complete" | "in_progress" | "pending" | "blocked"
    batches: BatchReportData[]
    metrics: StageMetrics
}

export interface BatchReportData {
    batchNumber: number
    batchName: string
    threads: ThreadReportData[]
}

export interface ThreadReportData {
    threadNumber: number
    threadName: string
    items: ItemReportData[]
}

export interface ItemReportData {
    id: string
    name: string
    status: ExecutionStatus
    report?: string
}

export interface StageMetrics {
    totalItems: number
    completed: number
    inProgress: number
    pending: number
    blocked: number
    cancelled: number
    completionRate: number
}

/**
 * Generate a stage report
 */
export function generateStageReport(
    repoRoot: string,
    streamId: string,
    stageRef: number | string,
): StageReportData {
    const index = loadIndex(repoRoot)
    const stream = findStream(index, streamId)
    if (!stream) {
        throw new Error(`Workstream "${streamId}" not found`)
    }

    // Parse PLAN.md to get stage info
    const workDir = getWorkDir(repoRoot)
    const planPath = join(workDir, stream.id, "PLAN.md")
    const planContent = readFileSync(planPath, "utf-8")
    const errors: ConsolidateError[] = []
    const planDoc = parseStreamDocument(planContent, errors)

    if (!planDoc) {
        throw new Error(`Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`)
    }

    // Resolve stage reference using resolveByNameOrIndex
    const stageRefStr = typeof stageRef === "number" ? stageRef.toString() : stageRef
    const stageDef = resolveByNameOrIndex<StageDefinition>(stageRefStr, planDoc.stages, "stage")
    const stageNumber = stageDef.id
    const stagePrefix = stageNumber.toString().padStart(2, "0")

    // Get all items for this stage
    const allTasks = listThreadExecutionItems(repoRoot, stream.id)
    const stageTasks = allTasks.filter((t) => {
        const [stageId = "00"] = t.id.split(".")
        return (Number.parseInt(stageId, 10) || 0) === stageNumber
    })

    // Calculate metrics
    const metrics = calculateStageMetrics(stageTasks)

    // Determine overall stage status
    const status = determineStageStatus(stageTasks, metrics)

    // Group tasks into batch/thread hierarchy
    const batches = groupTasksIntoBatches(stageTasks, stageDef.batches)

    return {
        stageNumber,
        stageName: stageDef.name,
        stagePrefix,
        streamId: stream.id,
        streamName: stream.name,
        generatedAt: new Date().toISOString(),
        status,
        batches,
        metrics,
    }
}

/**
 * Calculate metrics for a set of items
 */
function calculateStageMetrics(items: ExecutionItem[]): StageMetrics {
    const total = items.length
    const completed = items.filter((item) => item.status === "completed").length
    const inProgress = items.filter((item) => item.status === "in_progress").length
    const pending = items.filter((item) => item.status === "pending").length
    const blocked = items.filter((item) => item.status === "blocked").length
    const cancelled = items.filter((item) => item.status === "cancelled").length

    return {
        totalItems: total,
        completed,
        inProgress,
        pending,
        blocked,
        cancelled,
        completionRate: total > 0 ? (completed / total) * 100 : 0,
    }
}

/**
 * Determine overall stage status from item statuses
 */
function determineStageStatus(
    items: ExecutionItem[],
    metrics: StageMetrics,
): "complete" | "in_progress" | "pending" | "blocked" {
    if (items.length === 0) return "pending"
    if (metrics.blocked > 0) return "blocked"
    if (metrics.completed === metrics.totalItems) return "complete"
    if (metrics.inProgress > 0 || metrics.completed > 0) return "in_progress"
    return "pending"
}

/**
 * Group tasks into batches and threads
 */
function groupTasksIntoBatches(
    tasks: ExecutionItem[],
    batchDefs: { id: number; name: string; threads: { id: number; name: string }[] }[],
): BatchReportData[] {
    const batches: BatchReportData[] = []

    // Create a lookup map for batch/thread names
    const batchMap = new Map<number, { name: string; threads: Map<number, string> }>()
    for (const batch of batchDefs) {
        const threadMap = new Map<number, string>()
        for (const thread of batch.threads) {
            threadMap.set(thread.id, thread.name)
        }
        batchMap.set(batch.id, { name: batch.name, threads: threadMap })
    }

    // Group items by batch and thread
    const grouped = new Map<number, Map<number, ExecutionItem[]>>()
    for (const task of tasks) {
        const [, batchId = "00", threadId = "00"] = task.id.split(".")
        const parsed = {
            batch: Number.parseInt(batchId, 10) || 0,
            thread: Number.parseInt(threadId, 10) || 0,
        }
        if (!grouped.has(parsed.batch)) {
            grouped.set(parsed.batch, new Map())
        }
        const batchTasks = grouped.get(parsed.batch)!
        if (!batchTasks.has(parsed.thread)) {
            batchTasks.set(parsed.thread, [])
        }
        batchTasks.get(parsed.thread)!.push(task)
    }

    // Convert to BatchReportData
    const sortedBatches = Array.from(grouped.keys()).sort((a, b) => a - b)
    for (const batchNum of sortedBatches) {
        const batchInfo = batchMap.get(batchNum)
        const batchName = batchInfo?.name ?? `Batch ${batchNum.toString().padStart(2, "0")}`
        const batchTasks = grouped.get(batchNum)!

        const threads: ThreadReportData[] = []
        const sortedThreads = Array.from(batchTasks.keys()).sort((a, b) => a - b)
        for (const threadNum of sortedThreads) {
            const threadName =
                batchInfo?.threads.get(threadNum) ??
                `Thread ${threadNum.toString().padStart(2, "0")}`
            const threadTasks = batchTasks.get(threadNum)!

            // Sort tasks by ID
            threadTasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

            threads.push({
                threadNumber: threadNum,
                threadName,
                items: threadTasks.map((t) => ({
                    id: t.id,
                    name: t.name,
                    status: t.status,
                    report: t.report,
                })),
            })
        }

        batches.push({
            batchNumber: batchNum,
            batchName,
            threads,
        })
    }

    return batches
}

/**
 * Format stage report as markdown
 */
export function formatStageReportMarkdown(report: StageReportData): string {
    const lines: string[] = []

    lines.push(`# Stage Report: ${report.stageName} (Stage ${report.stagePrefix})`)
    lines.push("")
    lines.push(`> **Generated:** ${report.generatedAt}  `)
    lines.push(`> **Status:** ${formatStatus(report.status)} (${report.metrics.completed}/${report.metrics.totalItems} items)`)
    lines.push("")

    lines.push("## Summary")
    lines.push("")
    lines.push(`Stage ${report.stagePrefix} (${report.stageName}) progress summary.`)
    lines.push("")

    lines.push("## Completed Work")
    lines.push("")

    for (const batch of report.batches) {
        lines.push(`### Batch ${batch.batchNumber.toString().padStart(2, "0")}: ${batch.batchName}`)
        lines.push("")

        for (const thread of batch.threads) {
            const completedCount = thread.items.filter((item) => item.status === "completed").length
            lines.push(`**Thread: ${thread.threadName}** (${completedCount}/${thread.items.length} items)`)

            for (const item of thread.items) {
                const statusIcon = getStatusIcon(item.status)
                lines.push(`- ${statusIcon} ${item.name}`)
                if (item.report) {
                    lines.push(`  > ${item.report}`)
                }
            }
            lines.push("")
        }
    }

    // Issues section
    const blockedItems = report.batches
        .flatMap((b) => b.threads)
        .flatMap((t) => t.items)
        .filter((item) => item.status === "blocked")

    lines.push("## Issues & Blockers")
    lines.push("")
    if (blockedItems.length > 0) {
        for (const item of blockedItems) {
            lines.push(`- **${item.id}:** ${item.name}`)
            if (item.report) {
                lines.push(`  > ${item.report}`)
            }
        }
    } else {
        lines.push("No blocked items in this stage.")
    }
    lines.push("")

    // Metrics table
    lines.push("## Metrics")
    lines.push("")
    lines.push("| Metric | Value |")
    lines.push("|--------|-------|")
    lines.push(`| Items | ${report.metrics.completed}/${report.metrics.totalItems} complete |`)
    lines.push(`| Completion Rate | ${report.metrics.completionRate.toFixed(1)}% |`)
    lines.push(`| Batches | ${report.batches.length} |`)
    lines.push(`| Threads | ${report.batches.reduce((acc, b) => acc + b.threads.length, 0)} |`)
    lines.push(`| Blocked | ${report.metrics.blocked} |`)
    lines.push("")

    return lines.join("\n")
}

function formatStatus(status: string): string {
    switch (status) {
        case "complete":
            return "Complete"
        case "in_progress":
            return "In Progress"
        case "pending":
            return "Pending"
        case "blocked":
            return "Blocked"
        default:
            return status
    }
}

function getStatusIcon(status: ExecutionStatus): string {
    switch (status) {
        case "completed":
            return "✓"
        case "in_progress":
            return "◐"
        case "pending":
            return "○"
        case "blocked":
            return "✗"
        case "cancelled":
            return "−"
        default:
            return "?"
    }
}

/**
 * Save a stage report to the reports directory
 */
export function saveStageReport(
    repoRoot: string,
    streamId: string,
    report: StageReportData,
): string {
    const workDir = getWorkDir(repoRoot)
    const reportsDir = join(workDir, streamId, "reports")

    // Ensure reports directory exists
    mkdirSync(reportsDir, { recursive: true })

    // Format filename: {stage-prefix}-{stage-name-slug}.md
    const slug = report.stageName.toLowerCase().replace(/\s+/g, "-")
    const filename = `${report.stagePrefix}-${slug}.md`
    const outputPath = join(reportsDir, filename)

    const content = formatStageReportMarkdown(report)
    writeFileSync(outputPath, content)

    return outputPath
}
