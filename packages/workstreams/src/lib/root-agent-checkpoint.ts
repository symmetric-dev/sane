import type { ExportedMessage, SessionExport } from "./session-export.ts"
import { extractMessageText } from "./session-export.ts"
import { loadSupervisorState, upsertCheckpointPointerLocked } from "./supervisor-state.ts"
import type { RootAgentCheckpointPointer } from "./types.ts"

export interface RootAgentCheckpointBoundary {
  message: ExportedMessage
  checkpointMessageIndex: number
}

export interface RootAgentCheckpointValidationResult {
  valid: boolean
  reason?: "root_session_mismatch" | "checkpoint_message_missing" | "checkpoint_index_missing"
  resolvedMessageId?: string
  resolvedMessageIndex?: number
}

function getMessageId(message: ExportedMessage | null | undefined): string | undefined {
  const messageId = message?.info?.id
  return typeof messageId === "string" && messageId.trim().length > 0 ? messageId : undefined
}

export function formatRootAgentCheckpointPointer(pointer: Pick<
  RootAgentCheckpointPointer,
  "checkpointMessageId" | "checkpointMessageIndex"
>): string {
  if (pointer.checkpointMessageId) {
    return `message ${pointer.checkpointMessageId}`
  }

  return `message-index ${pointer.checkpointMessageIndex}`
}

export function findLatestRootAgentCheckpointBoundary(
  sessionExport: SessionExport,
): RootAgentCheckpointBoundary | null {
  if (!Array.isArray(sessionExport?.messages) || sessionExport.messages.length === 0) {
    return null
  }

  let legacyAssistantFallback: RootAgentCheckpointBoundary | null = null

  for (let index = sessionExport.messages.length - 1; index >= 0; index -= 1) {
    const message = sessionExport.messages[index]
    if (!message?.info) {
      continue
    }

    if (message.info.role !== "assistant") {
      return { message, checkpointMessageIndex: index }
    }

    if (typeof message.info.time?.completed === "number") {
      return { message, checkpointMessageIndex: index }
    }

    if (!legacyAssistantFallback && extractMessageText(message).trim().length > 0) {
      legacyAssistantFallback = { message, checkpointMessageIndex: index }
    }
  }

  return legacyAssistantFallback ?? {
    message: sessionExport.messages[sessionExport.messages.length - 1]!,
    checkpointMessageIndex: sessionExport.messages.length - 1,
  }
}

export function createRootAgentCheckpointPointer(args: {
  rootSessionId: string
  sessionExport: SessionExport
  checkpointCreatedAt: string
}): RootAgentCheckpointPointer {
  const boundary = findLatestRootAgentCheckpointBoundary(args.sessionExport)

  if (!boundary) {
    throw new Error(
      "Failed to capture checkpoint pointer metadata: root session transcript had no messages to anchor.",
    )
  }

  return {
    rootSessionId: args.rootSessionId,
    checkpointMessageIndex: boundary.checkpointMessageIndex,
    checkpointCreatedAt: args.checkpointCreatedAt,
    ...(getMessageId(boundary.message) ? { checkpointMessageId: getMessageId(boundary.message) } : {}),
  }
}

export function loadRootAgentCheckpointPointer(args: {
  repoRoot: string
  streamId: string
  rootSessionId: string
}): RootAgentCheckpointPointer | undefined {
  return loadSupervisorState(args.repoRoot, args.streamId)?.checkpoint_pointers.find(
    (pointer) => pointer.rootSessionId === args.rootSessionId,
  )
}

export function validateRootAgentCheckpointPointer(args: {
  pointer: RootAgentCheckpointPointer
  sessionExport: SessionExport
}): RootAgentCheckpointValidationResult {
  if (args.sessionExport?.info?.id && args.pointer.rootSessionId !== args.sessionExport.info.id) {
    return { valid: false, reason: "root_session_mismatch" }
  }

  if (args.pointer.checkpointMessageId) {
    const resolvedMessageIndex = args.sessionExport.messages.findIndex(
      (message) => getMessageId(message) === args.pointer.checkpointMessageId,
    )

    if (resolvedMessageIndex >= 0) {
      return {
        valid: true,
        resolvedMessageId: args.pointer.checkpointMessageId,
        resolvedMessageIndex,
      }
    }

    return { valid: false, reason: "checkpoint_message_missing" }
  }

  const message = args.sessionExport.messages[args.pointer.checkpointMessageIndex]
  if (!message) {
    return { valid: false, reason: "checkpoint_index_missing" }
  }

  return {
    valid: true,
    resolvedMessageId: getMessageId(message),
    resolvedMessageIndex: args.pointer.checkpointMessageIndex,
  }
}

export async function refreshRootAgentCheckpointPointer(args: {
  repoRoot: string
  streamId: string
  rootSessionId: string
  sessionExport: SessionExport
  checkpointCreatedAt: string
}): Promise<RootAgentCheckpointPointer> {
  const existing = loadRootAgentCheckpointPointer(args)
  const latest = createRootAgentCheckpointPointer(args)

  if (existing) {
    const validation = validateRootAgentCheckpointPointer({
      pointer: existing,
      sessionExport: args.sessionExport,
    })

    if (
      validation.valid &&
      validation.resolvedMessageIndex === latest.checkpointMessageIndex &&
      validation.resolvedMessageId === latest.checkpointMessageId
    ) {
      const refreshed: RootAgentCheckpointPointer = {
        ...existing,
        checkpointMessageIndex: latest.checkpointMessageIndex,
        checkpointCreatedAt: args.checkpointCreatedAt,
        ...(latest.checkpointMessageId ? { checkpointMessageId: latest.checkpointMessageId } : {}),
      }

      await upsertCheckpointPointerLocked(args.repoRoot, args.streamId, refreshed)
      return refreshed
    }
  }

  await upsertCheckpointPointerLocked(args.repoRoot, args.streamId, latest)
  return latest
}
