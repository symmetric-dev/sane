export interface ParsedExecutionItemId {
  stage: number
  batch: number
  thread: number
  item: number
}

export interface ParsedThreadId {
  stage: number
  batch: number
  thread: number
}

export function parseExecutionItemId(itemId: string): ParsedExecutionItemId {
  const parts = itemId.split(".")
  if (parts.length !== 4) {
    throw new Error(
      `Invalid execution item ID format: ${itemId}. Expected "stage.batch.thread.item" (e.g., "01.01.02.03")`,
    )
  }

  const parsed = parts.map((part) => Number.parseInt(part, 10))
  if (parsed.some(Number.isNaN)) {
    throw new Error(
      `Invalid execution item ID format: ${itemId}. Expected "stage.batch.thread.item" (e.g., "01.01.02.03")`,
    )
  }

  return {
    stage: parsed[0]!,
    batch: parsed[1]!,
    thread: parsed[2]!,
    item: parsed[3]!,
  }
}

export function formatExecutionItemId(
  stage: number,
  batch: number,
  thread: number,
  item: number,
): string {
  return [stage, batch, thread, item].map((value) => value.toString().padStart(2, "0")).join(".")
}

export function parseThreadId(threadId: string): ParsedThreadId {
  const parts = threadId.split(".")
  if (parts.length !== 3) {
    throw new Error(
      `Invalid thread ID format: ${threadId}. Expected "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  const parsed = parts.map((part) => Number.parseInt(part, 10))
  if (parsed.some(Number.isNaN)) {
    throw new Error(
      `Invalid thread ID format: ${threadId}. Expected "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  return {
    stage: parsed[0]!,
    batch: parsed[1]!,
    thread: parsed[2]!,
  }
}

export function formatThreadId(stage: number, batch: number, thread: number): string {
  return [stage, batch, thread].map((value) => value.toString().padStart(2, "0")).join(".")
}
