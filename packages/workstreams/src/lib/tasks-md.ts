/**
 * TASKS.md parser and generator
 *
 * Handles the human-readable TASKS.md intermediate format.
 */

import { Lexer, type Token, type Tokens } from "marked"
import type { Task, StreamDocument } from "./types.ts"
import { formatTaskId, parseTaskId } from "./tasks.ts"

/**
 * Detect which stages in a StreamDocument are new (have no tasks yet)
 *
 * @param doc - StreamDocument parsed from PLAN.md
 * @param existingTasks - Array of existing tasks from tasks.json
 * @returns Array of stage numbers that have no tasks, sorted ascending
 */
export function detectNewStages(
  doc: StreamDocument,
  existingTasks: Task[],
): number[] {
  // Extract unique stage IDs from existing tasks using parseTaskId
  const stagesWithTasks = new Set<number>()
  for (const task of existingTasks) {
    try {
      const { stage } = parseTaskId(task.id)
      stagesWithTasks.add(stage)
    } catch {
      // Skip invalid task IDs
    }
  }

  // Get all stage IDs from PLAN.md
  const allStageIds = doc.stages.map((stage) => stage.id)

  // Find stages that are in PLAN.md but not in tasks.json
  const newStages = allStageIds.filter((stageId) => !stagesWithTasks.has(stageId))

  // Return sorted ascending
  return newStages.sort((a, b) => a - b)
}

/**
 * Regex pattern to extract agent assignment from thread headers
 * Matches: "Thread 01: Router @agent:backend-expert"
 * Also matches: "Thread 01: Router @agent: backend-expert"
 * Also matches: "Thread 01: Router @agent:" (empty placeholder)
 * Captures: thread id, thread name, agent name (optional)
 */
const THREAD_HEADER_REGEX = /^Thread\s+(\d+):\s*([^@]*?)(?:\s+@agent:\s*([a-zA-Z0-9_-]*))?\s*$/i

/**
 * Generate TASKS.md content from a StreamDocument (PLAN.md structure)
 * Creates empty task checkboxes for each thread.
 */
export function generateTasksMdFromPlan(
  streamName: string,
  doc: StreamDocument,
): string {
  if (doc.stages.length === 0) {
    throw new Error(
      "Cannot generate TASKS.md from a draft plan with no stages. Scaffold stages first with 'work plan create'.",
    )
  }

  const lines: string[] = []

  lines.push(`# Tasks: ${streamName}`)
  lines.push("")

  for (const stage of doc.stages) {
    const stageIdPadded = stage.id.toString().padStart(2, "0")
    lines.push(`## Stage ${stageIdPadded}: ${stage.name}`)
    lines.push("")

    for (const batch of stage.batches) {
      lines.push(`### Batch ${batch.prefix}: ${batch.name}`)
      lines.push("")

      for (const thread of batch.threads) {
        const threadIdPadded = thread.id.toString().padStart(2, "0")
        // Include @agent: placeholder for agent assignment
        lines.push(`#### Thread ${threadIdPadded}: ${thread.name} @agent:`)
        // Add a placeholder task to guide the user
        const taskId = formatTaskId(stage.id, batch.id, thread.id, 1)
        lines.push(`- [ ] Task ${taskId}: `)
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

/**
 * Generate TASKS.md content from existing Tasks
 * Groups tasks by Stage -> Batch -> Thread.
 */
export function generateTasksMdFromTasks(
  streamName: string,
  tasks: Task[],
): string {
  const lines: string[] = []

  lines.push(`# Tasks: ${streamName}`)
  lines.push("")

  // Group tasks
  const tasksByStage = new Map<number, Map<string, Map<number, Task[]>>>()
  const stageNames = new Map<number, string>()
  const batchNames = new Map<string, string>() // Keyed by batch_name for simplicity, or we can store properly
  const threadNames = new Map<string, string>() // Keyed by thread_name? No, thread ID/Name association is loose in tasks.
  const threadAgents = new Map<string, string | undefined>() // Track agent assignments per thread

  // We need to group by ID hierarchy: Stage ID -> Batch ID -> Thread ID
  // But Task objects store names, not IDs directly (except in ID string).
  // We parse the ID to get the hierarchy.

  for (const task of tasks) {
    try {
      const { stage, batch, thread } = parseTaskId(task.id)

      if (!tasksByStage.has(stage)) {
        tasksByStage.set(stage, new Map())
        stageNames.set(stage, task.stage_name)
      }

      const batches = tasksByStage.get(stage)!
      // Use formatted batch (e.g. "00") as key
      const batchKey = batch.toString().padStart(2, "0")

      const stageBatchKey = `${stage}.${batchKey}`
      if (!batches.has(batchKey)) {
        batches.set(batchKey, new Map())
        batchNames.set(stageBatchKey, task.batch_name)
      }

      const threads = batches.get(batchKey)!

      const threadKey = `${stage}.${batchKey}.${thread}`
      if (!threads.has(thread)) {
        threads.set(thread, [])
        threadNames.set(threadKey, task.thread_name)
        threadAgents.set(threadKey, task.assigned_agent)
      }

      threads.get(thread)!.push(task)
    } catch (e) {
      // Ignore invalid IDs
      continue
    }
  }

  // Sort and output
  const sortedStages = Array.from(tasksByStage.keys()).sort((a, b) => a - b)

  for (const stageId of sortedStages) {
    const batches = tasksByStage.get(stageId)!
    const stageIdPadded = stageId.toString().padStart(2, "0")
    const stageName = stageNames.get(stageId) || `Stage ${stageIdPadded}`
    lines.push(`## Stage ${stageIdPadded}: ${stageName}`)
    lines.push("")

    const sortedBatches = Array.from(batches.keys()).sort() // "00", "01" sorts correctly

    for (const batchKey of sortedBatches) {
      const threads = batches.get(batchKey)!
      const stageBatchKey = `${stageId}.${batchKey}`
      const batchName = batchNames.get(stageBatchKey) || `Batch ${batchKey}`
      lines.push(`### Batch ${batchKey}: ${batchName}`)
      lines.push("")

      const sortedThreads = Array.from(threads.keys()).sort((a, b) => a - b)

      for (const threadId of sortedThreads) {
        const threadTasks = threads.get(threadId)!
        // Sort tasks by ID
        threadTasks.sort((a, b) =>
          a.id.localeCompare(b.id, undefined, { numeric: true }),
        )

        const threadKey = `${stageId}.${batchKey}.${threadId}`
        const threadName =
          threadNames.get(threadKey) ||
          `Thread ${threadId}`
        const threadIdPadded = threadId.toString().padStart(2, "0")
        const agentAssignment = threadAgents.get(threadKey)
        const agentSuffix = agentAssignment ? ` @agent:${agentAssignment}` : ""
        lines.push(`#### Thread ${threadIdPadded}: ${threadName}${agentSuffix}`)

        for (const task of threadTasks) {
          const check =
            task.status === "completed"
              ? "x"
              : task.status === "in_progress"
                ? "~"
                : task.status === "blocked"
                  ? "!"
                  : task.status === "cancelled"
                    ? "-"
                    : " "

          lines.push(`- [${check}] Task ${task.id}: ${task.name}`)
          if (task.report) {
            lines.push(`  > Report: ${task.report}`)
          }
        }
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

/**
 * Generate TASKS.md content for a revision workflow.
 * Combines existing tasks (preserving status) with empty placeholders for new stages.
 *
 * @param streamName - Name of the workstream
 * @param existingTasks - Existing tasks with their current status
 * @param doc - StreamDocument containing all stages (including new ones)
 * @param newStageNumbers - Array of stage IDs that are new (have no tasks yet)
 * @returns TASKS.md content with existing tasks and new stage placeholders
 */
export function generateTasksMdForRevision(
  streamName: string,
  existingTasks: Task[],
  doc: StreamDocument,
  newStageNumbers: number[],
): string {
  const lines: string[] = []
  const newStageSet = new Set(newStageNumbers)

  lines.push(`# Tasks: ${streamName}`)
  lines.push("")

  // Group existing tasks by stage for efficient lookup
  const tasksByStage = new Map<number, Task[]>()
  for (const task of existingTasks) {
    try {
      const { stage } = parseTaskId(task.id)
      if (!tasksByStage.has(stage)) {
        tasksByStage.set(stage, [])
      }
      tasksByStage.get(stage)!.push(task)
    } catch {
      // Skip invalid task IDs
    }
  }

  // Process all stages from the document in order
  for (const stage of doc.stages) {
    const stageIdPadded = stage.id.toString().padStart(2, "0")
    lines.push(`## Stage ${stageIdPadded}: ${stage.name}`)
    lines.push("")

    if (newStageSet.has(stage.id)) {
      // New stage: generate empty placeholders (like generateTasksMdFromPlan)
      for (const batch of stage.batches) {
        lines.push(`### Batch ${batch.prefix}: ${batch.name}`)
        lines.push("")

        for (const thread of batch.threads) {
          const threadIdPadded = thread.id.toString().padStart(2, "0")
          // Include @agent: placeholder for agent assignment
          lines.push(`#### Thread ${threadIdPadded}: ${thread.name} @agent:`)
          // Add a placeholder task to guide the user
          const taskId = formatTaskId(stage.id, batch.id, thread.id, 1)
          lines.push(`- [ ] Task ${taskId}: `)
          lines.push("")
        }
      }
    } else {
      // Existing stage: output existing tasks with status markers
      const stageTasks = tasksByStage.get(stage.id) || []

      // Group tasks by batch and thread
      const tasksByBatch = new Map<number, Map<number, Task[]>>()
      const batchNames = new Map<number, string>()
      const threadNames = new Map<string, string>()
      const threadAgents = new Map<string, string | undefined>()

      for (const task of stageTasks) {
        try {
          const { batch, thread } = parseTaskId(task.id)

          if (!tasksByBatch.has(batch)) {
            tasksByBatch.set(batch, new Map())
            batchNames.set(batch, task.batch_name)
          }

          const threads = tasksByBatch.get(batch)!
          const threadKey = `${batch}.${thread}`

          if (!threads.has(thread)) {
            threads.set(thread, [])
            threadNames.set(threadKey, task.thread_name)
            threadAgents.set(threadKey, task.assigned_agent)
          }

          threads.get(thread)!.push(task)
        } catch {
          // Skip invalid task IDs
        }
      }

      // Sort and output batches
      const sortedBatches = Array.from(tasksByBatch.keys()).sort((a, b) => a - b)

      for (const batchId of sortedBatches) {
        const threads = tasksByBatch.get(batchId)!
        const batchKey = batchId.toString().padStart(2, "0")
        const batchName = batchNames.get(batchId) || `Batch ${batchKey}`
        lines.push(`### Batch ${batchKey}: ${batchName}`)
        lines.push("")

        const sortedThreads = Array.from(threads.keys()).sort((a, b) => a - b)

        for (const threadId of sortedThreads) {
          const threadTasks = threads.get(threadId)!
          // Sort tasks by ID
          threadTasks.sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true }),
          )

          const threadKey = `${batchId}.${threadId}`
          const threadName = threadNames.get(threadKey) || `Thread ${threadId}`
          const threadIdPadded = threadId.toString().padStart(2, "0")
          const agentAssignment = threadAgents.get(threadKey)
          const agentSuffix = agentAssignment ? ` @agent:${agentAssignment}` : ""
          lines.push(`#### Thread ${threadIdPadded}: ${threadName}${agentSuffix}`)

          for (const task of threadTasks) {
            const check =
              task.status === "completed"
                ? "x"
                : task.status === "in_progress"
                  ? "~"
                  : task.status === "blocked"
                    ? "!"
                    : task.status === "cancelled"
                      ? "-"
                      : " "

            lines.push(`- [${check}] Task ${task.id}: ${task.name}`)
            if (task.report) {
              lines.push(`  > Report: ${task.report}`)
            }
          }
          lines.push("")
        }
      }
    }
  }

  return lines.join("\n")
}

/**
 * Parse TASKS.md content to extract Tasks
 */
export function parseTasksMd(
  content: string,
  streamId: string,
): { tasks: Task[]; errors: string[] } {
  const lexer = new Lexer()
  const tokens = lexer.lex(content)
  const tasks: Task[] = []
  const errors: string[] = []

  let currentStage: { id: number; name: string } | null = null
  let currentBatch: { id: number; name: string } | null = null
  let currentThread: { id: number; name: string; assigned_agent?: string } | null = null

  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading

      // H2: Stage N: {name}
      if (heading.depth === 2) {
        const match = heading.text.match(/^Stage\s+(\d+):\s*(.*)$/i)
        if (match) {
          currentStage = {
            id: parseInt(match[1]!, 10),
            name: match[2]!.trim(),
          }
          currentBatch = null
          currentThread = null
        } else {
          // Warning?
        }
      }

      // H3: Batch NN: {name}
      else if (heading.depth === 3 && currentStage) {
        const match = heading.text.match(/^Batch\s+(\d{1,2}):\s*(.*)$/i)
        if (match) {
          currentBatch = {
            id: parseInt(match[1]!, 10),
            name: match[2]!.trim(),
          }
          currentThread = null
        }
      }

      // H4: Thread N: {name} [@agent:agent-name]
      else if (heading.depth === 4 && currentStage && currentBatch) {
        const match = heading.text.match(THREAD_HEADER_REGEX)
        if (match) {
          currentThread = {
            id: parseInt(match[1]!, 10),
            name: match[2]!.trim(),
            assigned_agent: match[3] || undefined,
          }
        }
      }
    }

    if (
      token.type === "list" &&
      currentStage &&
      currentBatch &&
      currentThread
    ) {
      const list = token as Tokens.List
      for (const item of list.items) {
        let text: string | undefined = item.text
        let statusChar = ""

        if (item.task) {
          // It was parsed as a GFM task ([ ] or [x])
          statusChar = item.checked ? "x" : " "
        } else {
          // Not a GFM task (e.g. [~], [!], [-]), check explicitly
          // marked puts the full text in item.text including the brackets
          const checkMatch = text.match(/^\s*\[([xX~!\-\s])\]\s+(.*)$/)
          if (checkMatch && checkMatch[1]) {
            statusChar = checkMatch[1].toLowerCase()
            text = checkMatch[2]
          } else {
            continue // Not a task item
          }
        }

        if (text) {
          // Check for report in text
          let report: string | undefined
          const reportMatch = text.match(/>\s*Report:\s*(.*)/i)
          if (reportMatch) {
            report = reportMatch[1]!.trim()
            // Remove report from text for description parsing, assuming it's at the end
            text = text.replace(/>\s*Report:\s*.*$/i, "").trim()
          }

          // Now parse "Task ID: Desc" from text
          // Use 'm' flag to handle multiline if marked preserves it, but we cleaned it above check
          // We'll just take the first line as description if there are newlines still
          const contentMatch = text.match(/^\s*(?:Task\s+([\d\.]+):\s*)?([^\n]*)/i)

          if (contentMatch) {
            const idString = contentMatch[1]
            const description = contentMatch[2]?.trim()

            if (description) {
              // Determine status
              const status =
                statusChar === "x"
                  ? "completed"
                  : statusChar === "~"
                    ? "in_progress"
                    : statusChar === "!"
                      ? "blocked"
                      : statusChar === "-"
                        ? "cancelled"
                        : "pending"

              let taskId = idString

              if (taskId) {
                // Validate ID matches hierarchy
                try {
                  const parsed = parseTaskId(taskId)
                  if (
                    parsed.stage !== currentStage.id ||
                    parsed.batch !== currentBatch.id ||
                    parsed.thread !== currentThread.id
                  ) {
                    errors.push(
                      `Task ID ${taskId} does not match hierarchy (Stage ${currentStage.id}, Batch ${currentBatch.id}, Thread ${currentThread.id})`,
                    )
                    continue
                  }
                } catch (e) {
                  errors.push(`Invalid task ID format: ${taskId}`)
                  continue
                }
              } else {
                errors.push(
                  `Task missing ID: "${description}". Format should be "- [ ] Task 01.01.01.01: Description"`,
                )
                continue
              }

              const now = new Date().toISOString()
              const task: Task = {
                id: taskId!,
                name: description,
                stage_name: currentStage.name,
                batch_name: currentBatch.name,
                thread_name: currentThread.name,
                status,
                created_at: now,
                updated_at: now,
                report,
                assigned_agent: currentThread.assigned_agent,
              }

              tasks.push(task)
            }
          }
        }
      }
    }
  }

  return { tasks, errors }
}

/**
 * Serialize TASKS.md content and apply thread agent assignments to provided tasks.
 * 
 * This function parses the TASKS.md content to extract thread-level agent assignments,
 * then applies those assignments to all tasks that belong to each thread.
 * 
 * @param content - TASKS.md content with @agent: annotations
 * @param tasks - Array of tasks to update with agent assignments
 * @returns Updated tasks with assigned_agent populated from thread headers
 */
export function serializeTasksMd(content: string, tasks: Task[]): Task[] {
  const lexer = new Lexer()
  const tokens = lexer.lex(content)
  
  // Map thread key (stage.batch.thread) to agent name
  const threadAgents = new Map<string, string>()
  
  let currentStage: number | null = null
  let currentBatch: number | null = null
  
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading
      
      // H2: Stage N: {name}
      if (heading.depth === 2) {
        const match = heading.text.match(/^Stage\s+(\d+):/i)
        if (match) {
          currentStage = parseInt(match[1]!, 10)
          currentBatch = null
        }
      }
      
      // H3: Batch NN: {name}
      else if (heading.depth === 3 && currentStage !== null) {
        const match = heading.text.match(/^Batch\s+(\d{1,2}):/i)
        if (match) {
          currentBatch = parseInt(match[1]!, 10)
        }
      }
      
      // H4: Thread N: {name} @agent:{agent-name}
      else if (heading.depth === 4 && currentStage !== null && currentBatch !== null) {
        const match = heading.text.match(THREAD_HEADER_REGEX)
        if (match && match[3]) {
          const threadId = parseInt(match[1]!, 10)
          const agentName = match[3]
          const stageKey = currentStage.toString().padStart(2, "0")
          const batchKey = currentBatch.toString().padStart(2, "0")
          const threadKey = threadId.toString().padStart(2, "0")
          const fullKey = `${stageKey}.${batchKey}.${threadKey}`
          threadAgents.set(fullKey, agentName)
        }
      }
    }
  }
  
  // Apply agent assignments to tasks
  return tasks.map(task => {
    try {
      const { stage, batch, thread } = parseTaskId(task.id)
      const stageKey = stage.toString().padStart(2, "0")
      const batchKey = batch.toString().padStart(2, "0")
      const threadKey = thread.toString().padStart(2, "0")
      const fullKey = `${stageKey}.${batchKey}.${threadKey}`
      
      const agentName = threadAgents.get(fullKey)
      if (agentName) {
        return { ...task, assigned_agent: agentName }
      }
      return task
    } catch {
      // Invalid task ID, return as-is
      return task
    }
  })
}
