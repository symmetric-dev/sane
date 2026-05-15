/**
 * Interactive prompts for CLI commands
 *
 * Provides readline-based prompts for interactive stage/batch/thread selection.
 */

import * as readline from "readline"
import type { StageDefinition, BatchDefinition, ThreadDefinition } from "./types.ts"

export interface SelectionResult<T> {
  index: number
  value: T
}

/**
 * Create a readline interface for interactive prompts
 */
export function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
}

/**
 * Display numbered list and prompt for selection
 * Accepts either a number or partial name match
 */
export async function selectFromList<T>(
  rl: readline.Interface,
  prompt: string,
  items: T[],
  displayFn: (item: T, index: number) => string
): Promise<SelectionResult<T>> {
  // Display items
  console.log(`\n${prompt}`)
  items.forEach((item, i) => {
    console.log(`  ${i + 1}. ${displayFn(item, i)}`)
  })

  // Get selection
  return new Promise((resolve, reject) => {
    rl.question("\nEnter number or name: ", (answer) => {
      const trimmed = answer.trim()

      // Try number first
      const num = parseInt(trimmed, 10)
      if (!isNaN(num) && num >= 1 && num <= items.length) {
        resolve({ index: num - 1, value: items[num - 1]! })
        return
      }

      // Try name match (case-insensitive partial match)
      const lowerAnswer = trimmed.toLowerCase()
      const matchIndex = items.findIndex((item) =>
        displayFn(item, 0).toLowerCase().includes(lowerAnswer)
      )

      if (matchIndex >= 0) {
        resolve({ index: matchIndex, value: items[matchIndex]! })
        return
      }

      reject(new Error(`Invalid selection: "${trimmed}"`))
    })
  })
}

/**
 * Prompt for text input
 */
export async function promptText(
  rl: readline.Interface,
  prompt: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim())
    })
  })
}

/**
 * Interactive stage selection from parsed PLAN.md
 */
export async function selectStage(
  rl: readline.Interface,
  stages: StageDefinition[]
): Promise<SelectionResult<StageDefinition>> {
  return selectFromList(
    rl,
    "Select stage:",
    stages,
    (stage) => `Stage ${stage.id.toString().padStart(2, "0")}: ${stage.name || "(unnamed)"}`
  )
}

/**
 * Interactive batch selection from a stage
 */
export async function selectBatch(
  rl: readline.Interface,
  batches: BatchDefinition[]
): Promise<SelectionResult<BatchDefinition>> {
  return selectFromList(
    rl,
    "Select batch:",
    batches,
    (batch) => `Batch ${batch.prefix}: ${batch.name || "(unnamed)"}`
  )
}

/**
 * Interactive thread selection from a batch
 */
export async function selectThread(
  rl: readline.Interface,
  threads: ThreadDefinition[]
): Promise<SelectionResult<ThreadDefinition>> {
  return selectFromList(
    rl,
    "Select thread:",
    threads,
    (thread) => `Thread ${thread.id}: ${thread.name || "(unnamed)"}`
  )
}

// ============================================
// FIX COMMAND INTERACTIVE UI
// ============================================

import type { ExecutionItem } from "./types.ts"

/**
 * Thread status information for display
 */
export interface ThreadStatus {
  threadId: string // e.g., "01.01.01"
  threadName: string
  status: "completed" | "failed" | "incomplete"
  sessionsCount: number
  lastAgent?: string
}

/**
 * Action type for fix command
 */
export type FixAction = "resume" | "retry" | "change-agent" | "new-stage"

/**
 * Calculate the status of a thread based on its execution items
 */
export function calculateThreadStatus(items: ExecutionItem[]): "completed" | "failed" | "incomplete" {
  if (items.length === 0) return "incomplete"
  
  const allCompleted = items.every(t => t.status === "completed" || t.status === "cancelled")
  if (allCompleted) return "completed"
  if (items.some((t) => t.status === "blocked")) return "failed"
  
  return "incomplete"
}

/**
 * Get the last agent that worked on a thread
 */
export function getLastAgent(tasks: ExecutionItem[]): string | undefined {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i]
    if (task?.assignedAgent) {
      return task.assignedAgent
    }
  }
  return undefined
}

/**
 * Get total session count across all execution items in a thread
 */
export function getSessionCount(items: ExecutionItem[]): number {
  return items.length
}

/**
 * Build thread status information from execution items
 */
export function buildThreadStatuses(
  allItems: ExecutionItem[],
  threadIds: string[]
): ThreadStatus[] {
  return threadIds.map(threadId => {
    const threadItems = allItems.filter(t => t.threadId === threadId)
    const firstItem = threadItems[0]
    
    return {
      threadId,
      threadName: firstItem?.threadName || "(unknown)",
      status: calculateThreadStatus(threadItems),
      sessionsCount: getSessionCount(threadItems),
      lastAgent: getLastAgent(threadItems)
    }
  })
}

/**
 * Display thread status table
 */
export function displayThreadStatusTable(statuses: ThreadStatus[]): void {
  console.log("\nThread Status:")
  console.log("─".repeat(80))
  console.log(
    `${"Thread".padEnd(12)} ${"Status".padEnd(12)} ${"Sessions".padEnd(10)} ${"Last Agent".padEnd(20)}`
  )
  console.log("─".repeat(80))
  
  for (const status of statuses) {
    const statusDisplay = status.status.padEnd(12)
    const sessionsDisplay = status.sessionsCount.toString().padEnd(10)
    const agentDisplay = (status.lastAgent || "-").padEnd(20)
    
    console.log(
      `${status.threadId.padEnd(12)} ${statusDisplay} ${sessionsDisplay} ${agentDisplay}`
    )
  }
  
  console.log("─".repeat(80))
  console.log()
}

/**
 * Prompt for thread selection from status table
 */
export async function selectThreadFromStatuses(
  rl: readline.Interface,
  statuses: ThreadStatus[]
): Promise<SelectionResult<ThreadStatus>> {
  displayThreadStatusTable(statuses)
  
  return selectFromList(
    rl,
    "Select a thread to fix:",
    statuses,
    (status) => `${status.threadId} - ${status.threadName} (${status.status})`
  )
}

/**
 * Prompt for action selection
 */
export async function selectFixAction(
  rl: readline.Interface,
  threadStatus: ThreadStatus
): Promise<FixAction> {
  const actions: { action: FixAction; label: string; description: string }[] = []
  
  // Resume is only available if there's a current session
  if (threadStatus.status === "incomplete" && threadStatus.sessionsCount > 0) {
    actions.push({
      action: "resume",
      label: "Resume",
      description: "Continue the existing session"
    })
  }
  
  // Retry is available for failed or incomplete threads
  if (threadStatus.status === "failed" || threadStatus.status === "incomplete") {
    actions.push({
      action: "retry",
      label: "Retry",
      description: "Start a new session with the same agent"
    })
  }
  
  // Change agent is available for any non-completed thread
  if (threadStatus.status !== "completed") {
    actions.push({
      action: "change-agent",
      label: "Change Agent",
      description: "Retry with a different agent"
    })
  }
  
  // New stage is always available
  actions.push({
    action: "new-stage",
    label: "New Stage",
    description: "Create a new fix stage"
  })
  
  console.log("\nAvailable actions:")
  actions.forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.label} - ${a.description}`)
  })
  
  const result = await selectFromList(
    rl,
    "\nSelect action:",
    actions,
    (a) => a.label
  )
  
  return result.value.action
}

/**
 * Agent option for selection
 */
export interface AgentOption {
  name: string
  description: string
  bestFor: string
}

/**
 * Prompt for agent selection
 */
export async function selectAgent(
  rl: readline.Interface,
  agents: AgentOption[]
): Promise<SelectionResult<AgentOption>> {
  console.log("\nAvailable agents:")
  agents.forEach((agent, i) => {
    console.log(`  ${i + 1}. ${agent.name}`)
    console.log(`     ${agent.description}`)
    console.log(`     Best for: ${agent.bestFor}`)
    console.log()
  })
  
  return selectFromList(
    rl,
    "Select an agent:",
    agents,
    (agent) => agent.name
  )
}

/**
 * Confirmation prompt
 */
export async function confirmAction(
  rl: readline.Interface,
  message: string
): Promise<boolean> {
  const answer = await promptText(rl, `${message} (y/n): `)
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
}
