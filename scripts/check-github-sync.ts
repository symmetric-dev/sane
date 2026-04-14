#!/usr/bin/env bun
/**
 * Test GitHub sync functionality
 * Usage: bun run ./scripts/check-github-sync.ts
 *
 * Tests stage-level sync functions directly without using the CLI
 */

import { getGitHubAuth } from "../packages/workstreams/src/lib/github/auth.ts"
import { loadGitHubConfig, isGitHubEnabled } from "../packages/workstreams/src/lib/github/config.ts"
import { syncStageIssues, isStageComplete } from "../packages/workstreams/src/lib/github/sync.ts"
import { loadIndex } from "../packages/workstreams/src/lib/index.ts"
import { readTasksFile } from "../packages/workstreams/src/lib/tasks.ts"
import { loadWorkstreamGitHub } from "../packages/workstreams/src/lib/github/workstream-github.ts"

const repoRoot = process.cwd()

interface ThreadSummary {
  stageNumber: string
  stageName: string
  taskCount: number
  completedCount: number
  isComplete: boolean
  hasIssue: boolean
  issueNumber?: number
  issueState?: string
}

async function getStageSummaries(repoRoot: string, streamId: string): Promise<ThreadSummary[]> {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const githubData = await loadWorkstreamGitHub(repoRoot, streamId)
  const stages = new Map<string, ThreadSummary>()

  for (const task of tasksFile.tasks) {
    const stageNumber = task.id.split(".")[0]
    if (!stageNumber) {
      continue
    }

    if (!stages.has(stageNumber)) {
      const stageIssue = githubData?.stages[stageNumber]
      stages.set(stageNumber, {
        stageNumber,
        stageName: task.stage_name,
        taskCount: 0,
        completedCount: 0,
        isComplete: false,
        hasIssue: Boolean(stageIssue),
        issueNumber: stageIssue?.issue_number,
        issueState: stageIssue?.state,
      })
    }

    const summary = stages.get(stageNumber)!
    summary.taskCount++
    if (task.status === "completed" || task.status === "cancelled") {
      summary.completedCount++
    }
  }

  for (const [stageNumber, summary] of stages.entries()) {
    summary.isComplete = isStageComplete(repoRoot, streamId, parseInt(stageNumber, 10))
  }

  return Array.from(stages.values()).sort((a, b) => a.stageNumber.localeCompare(b.stageNumber))
}

async function main() {
  console.log("=== GitHub Sync Test ===\n")

  // Check prerequisites
  const token = getGitHubAuth()
  if (!token) {
    console.log("❌ No GitHub authentication found!")
    process.exit(1)
  }
  console.log("✅ Authentication found")

  const enabled = await isGitHubEnabled(repoRoot)
  if (!enabled) {
    console.log("❌ GitHub integration is not enabled!")
    console.log("   Run: work github enable")
    process.exit(1)
  }
  console.log("✅ GitHub integration enabled")

  const config = await loadGitHubConfig(repoRoot)
  console.log(`✅ Repository: ${config.owner}/${config.repo}`)

  // Get current workstream
  const index = loadIndex(repoRoot)
  const currentStreamId = index.current_stream
  if (!currentStreamId) {
    console.log("\n❌ No current workstream set")
    console.log("   Run: work current --set <stream-id>")
    process.exit(1)
  }

  const stream = index.streams.find(s => s.id === currentStreamId)
  if (!stream) {
    console.log(`\n❌ Workstream "${currentStreamId}" not found`)
    process.exit(1)
  }

  console.log(`\n--- Workstream: ${stream.id} ---`)

  // Get stage summaries
  const summaries = await getStageSummaries(repoRoot, stream.id)
  if (summaries.length === 0) {
    console.log("No tasks found")
    process.exit(0)
  }

  // Display stage status
  console.log("\n--- Stage Status ---")
  console.log("Stage | Complete | Issue     | State")
  console.log("------|----------|-----------|-------")

  let stagesWithIssues = 0
  let completedWithOpenIssues = 0

  for (const s of summaries) {
    const complete = s.isComplete ? "✅" : "❌"
    const issue = s.hasIssue ? `#${s.issueNumber?.toString().padStart(3)}` : "  -  "
    const state = s.issueState || "-"
    console.log(`${s.stageNumber}    | ${complete} ${s.completedCount}/${s.taskCount}    | ${issue}     | ${state}`)

    if (s.hasIssue) stagesWithIssues++
    if (s.isComplete && s.hasIssue && s.issueState === "open") {
      completedWithOpenIssues++
    }
  }

  console.log("")
  console.log(`Total stages: ${summaries.length}`)
  console.log(`Stages with issues: ${stagesWithIssues}`)
  console.log(`Completed with open issues: ${completedWithOpenIssues}`)

  // Parse command
  const arg = process.argv[2]

  if (arg === "--check-stage") {
    const stageArg = process.argv[3]
    if (!stageArg) {
      console.log("\n❌ Please provide stage number: --check-stage <stage-number>")
      process.exit(1)
    }

    const stageNumber = parseInt(stageArg, 10)
    if (Number.isNaN(stageNumber)) {
      console.log("\n❌ Invalid stage number")
      process.exit(1)
    }

    console.log(`\n--- Checking Stage ${stageArg.padStart(2, "0")} ---`)
    const complete = isStageComplete(repoRoot, stream.id, stageNumber)
    console.log(`Stage complete: ${complete ? "Yes" : "No"}`)
  } else if (arg === "--dry-run") {
    console.log("\n--- Sync Dry Run ---")
    console.log("Would sync the following:")

    for (const s of summaries) {
      if (s.isComplete && s.hasIssue && s.issueState === "open") {
        console.log(`  Close #${s.issueNumber}: [${s.stageNumber}] ${s.stageName}`)
      }
    }

    if (completedWithOpenIssues === 0) {
      console.log("  (nothing to sync)")
    }
  } else if (arg === "--sync") {
    if (completedWithOpenIssues === 0) {
      console.log("\n✅ Nothing to sync - no completed threads with open issues")
      process.exit(0)
    }

    console.log(`\n--- Running Sync ---`)
    console.log(`Will close ${completedWithOpenIssues} issue(s)`)
    console.log("\n⚠️  This will close real GitHub issues!")
    console.log("   Press Ctrl+C within 5 seconds to cancel...")

    await new Promise(resolve => setTimeout(resolve, 5000))

    try {
      const result = await syncStageIssues(repoRoot, stream.id)
      console.log("\n✅ Sync completed!")
      console.log(`   Closed: ${result.closed.length}`)
      console.log(`   Unchanged: ${result.unchanged.length}`)
      console.log(`   Errors: ${result.errors.length}`)

      if (result.closed.length > 0) {
        console.log("\nClosed issues:")
        for (const item of result.closed) {
          console.log(`   #${item.issueNumber}: [${item.stageNumber}] ${item.stageName}`)
        }
      }

      if (result.errors.length > 0) {
        console.log("\nErrors:")
        for (const item of result.errors) {
          console.log(`   #${item.issueNumber}: ${item.error}`)
        }
      }
    } catch (e) {
      console.log("\n❌ Sync failed:", (e as Error).message)
    }
  } else {
    console.log("\n--- Commands ---")
    console.log("  --check-stage <num>  Check if a stage is complete (e.g., 01)")
    console.log("  --dry-run            Show what stage sync would do without executing")
    console.log("  --sync               Sync stage issue states (closes completed stages)")
    console.log("")
    console.log("Note: --sync has a 5-second delay before execution")
  }
}

main().catch(console.error)
