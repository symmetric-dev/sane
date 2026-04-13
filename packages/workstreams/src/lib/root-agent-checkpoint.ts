import type { ExportedMessage, SessionExport } from "./session-export.ts"
import { extractMessageText } from "./session-export.ts"
import { loadSupervisorState, upsertCheckpointPointerLocked } from "./supervisor-state.ts"
import type {
  RootAgentBreakpointSelection,
  RootAgentCheckpointPointer,
} from "./types.ts"

export const DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS = ["SESSION_BREAKPOINT"] as const

export interface RootAgentCheckpointBoundary {
  message: ExportedMessage
  checkpointMessageIndex: number
  breakpointSelection: RootAgentBreakpointSelection
}

export interface RootAgentCheckpointValidationResult {
  valid: boolean
  reason?: "root_session_mismatch" | "checkpoint_message_missing" | "checkpoint_index_missing"
  resolvedMessageId?: string
  resolvedMessageIndex?: number
}

export interface RootAgentCheckpointSessionForkEligibility {
  valid: boolean
  canForkCurrentSession: boolean
  reason?: RootAgentCheckpointValidationResult["reason"]
  resolvedMessageId?: string
  resolvedMessageIndex?: number
  latestMessageIndex?: number
}

interface RootAgentLaunchMessageContext {
  launchMessage?: ExportedMessage
  launchMessageIndex?: number
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

export function formatRootAgentBreakpointSelection(selection: RootAgentBreakpointSelection): string {
  return selection.rationale
}

function normalizeBreakpointTags(breakpointTags?: readonly string[]): string[] {
  const normalized = new Set<string>()

  for (const tag of breakpointTags ?? DEFAULT_ROOT_AGENT_BREAKPOINT_TAGS) {
    if (typeof tag !== "string") {
      continue
    }

    const trimmed = tag.trim()
    if (trimmed.length > 0) {
      normalized.add(trimmed)
    }
  }

  return [...normalized]
}

function getLaunchMessageContext(sessionExport: SessionExport): RootAgentLaunchMessageContext {
  const messages = Array.isArray(sessionExport?.messages) ? sessionExport.messages : []
  const launchMessageIndex = messages.length - 1
  const launchMessage = messages[launchMessageIndex]

  if (launchMessage?.info?.role === "assistant") {
    return { launchMessage, launchMessageIndex }
  }

  return {}
}

function buildSelectionRationale(selection: Omit<RootAgentBreakpointSelection, "rationale">): string {
  const launchLabel = selection.launchMessageId
    ? `launch message ${selection.launchMessageId}`
    : typeof selection.launchMessageIndex === "number"
      ? `launch message-index ${selection.launchMessageIndex}`
      : undefined

  if (selection.strategy === "explicit_tag") {
    const tagLabel = selection.matchedTag
      ? `configured breakpoint tag "${selection.matchedTag}"`
      : "a configured breakpoint tag"

    return launchLabel
      ? `Selected the tagged user message because it matched ${tagLabel} before ${launchLabel}.`
      : `Selected the tagged user message because it matched ${tagLabel}.`
  }

  return launchLabel
    ? `Selected the previous user message before ${launchLabel} because no configured breakpoint tag was found.`
    : "Selected the latest user message because no configured breakpoint tag was found and the launch assistant message was not present in the exported transcript."
}

function buildBreakpointSelection(args: {
  strategy: RootAgentBreakpointSelection["strategy"]
  configuredTags: string[]
  matchedTag?: string
  launchContext: RootAgentLaunchMessageContext
}): RootAgentBreakpointSelection {
  const launchMessageId = getMessageId(args.launchContext.launchMessage)
  const selectionWithoutRationale: Omit<RootAgentBreakpointSelection, "rationale"> = {
    strategy: args.strategy,
    configuredTags: args.configuredTags,
    ...(args.matchedTag ? { matchedTag: args.matchedTag } : {}),
    ...(launchMessageId ? { launchMessageId } : {}),
    ...(typeof args.launchContext.launchMessageIndex === "number"
      ? { launchMessageIndex: args.launchContext.launchMessageIndex }
      : {}),
  }

  return {
    ...selectionWithoutRationale,
    rationale: buildSelectionRationale(selectionWithoutRationale),
  }
}

function findLatestTaggedUserBreakpointBoundary(args: {
  sessionExport: SessionExport
  configuredTags: string[]
  launchContext: RootAgentLaunchMessageContext
}): RootAgentCheckpointBoundary | null {
  if (args.configuredTags.length === 0) {
    return null
  }

  const messages = Array.isArray(args.sessionExport?.messages) ? args.sessionExport.messages : []
  const upperBoundExclusive =
    typeof args.launchContext.launchMessageIndex === "number"
      ? args.launchContext.launchMessageIndex
      : messages.length

  for (let index = upperBoundExclusive - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role !== "user") {
      continue
    }

    const messageText = extractMessageText(message)
    const matchedTag = args.configuredTags.find((tag) => messageText.includes(tag))
    if (!matchedTag) {
      continue
    }

    return {
      message,
      checkpointMessageIndex: index,
      breakpointSelection: buildBreakpointSelection({
        strategy: "explicit_tag",
        configuredTags: args.configuredTags,
        matchedTag,
        launchContext: args.launchContext,
      }),
    }
  }

  return null
}

export function findLatestRootAgentCheckpointBoundary(
  sessionExport: SessionExport,
  options: {
    breakpointTags?: readonly string[]
  } = {},
): RootAgentCheckpointBoundary | null {
  if (!Array.isArray(sessionExport?.messages) || sessionExport.messages.length === 0) {
    return null
  }

  const configuredTags = normalizeBreakpointTags(options.breakpointTags)
  const launchContext = getLaunchMessageContext(sessionExport)
  const taggedBoundary = findLatestTaggedUserBreakpointBoundary({
    sessionExport,
    configuredTags,
    launchContext,
  })

  if (taggedBoundary) {
    return taggedBoundary
  }

  const upperBoundExclusive =
    typeof launchContext.launchMessageIndex === "number"
      ? launchContext.launchMessageIndex
      : sessionExport.messages.length

  for (let index = upperBoundExclusive - 1; index >= 0; index -= 1) {
    const message = sessionExport.messages[index]
    if (message?.info?.role === "user") {
      return {
        message,
        checkpointMessageIndex: index,
        breakpointSelection: buildBreakpointSelection({
          strategy: "previous_user_before_launch",
          configuredTags,
          launchContext,
        }),
      }
    }
  }

  return null
}

export function createRootAgentCheckpointPointer(args: {
  rootSessionId: string
  sessionExport: SessionExport
  checkpointCreatedAt: string
  breakpointTags?: readonly string[]
}): RootAgentCheckpointPointer {
  const configuredTags = normalizeBreakpointTags(args.breakpointTags)
  const boundary = findLatestRootAgentCheckpointBoundary(args.sessionExport, {
    breakpointTags: configuredTags,
  })

  if (!boundary) {
    throw new Error(
      configuredTags.length > 0
        ? `Failed to capture checkpoint pointer metadata: no tagged user message matched configured breakpoint tags (${configuredTags.join(", ")}) and no previous user message was found before branch launch.`
        : "Failed to capture checkpoint pointer metadata: no previous user message was found before branch launch.",
    )
  }

  return {
    rootSessionId: args.rootSessionId,
    checkpointMessageIndex: boundary.checkpointMessageIndex,
    checkpointCreatedAt: args.checkpointCreatedAt,
    ...(getMessageId(boundary.message) ? { checkpointMessageId: getMessageId(boundary.message) } : {}),
    breakpointSelection: boundary.breakpointSelection,
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

export function getRootAgentCheckpointSessionForkEligibility(args: {
  pointer: RootAgentCheckpointPointer
  sessionExport: SessionExport
}): RootAgentCheckpointSessionForkEligibility {
  const validation = validateRootAgentCheckpointPointer(args)

  if (!validation.valid) {
    return {
      valid: false,
      canForkCurrentSession: false,
      reason: validation.reason,
    }
  }

  const latestMessageIndex = Array.isArray(args.sessionExport?.messages)
    ? args.sessionExport.messages.length - 1
    : undefined

  return {
    valid: true,
    canForkCurrentSession:
      typeof latestMessageIndex === "number" &&
      latestMessageIndex >= 0 &&
      validation.resolvedMessageIndex === latestMessageIndex,
    resolvedMessageId: validation.resolvedMessageId,
    resolvedMessageIndex: validation.resolvedMessageIndex,
    latestMessageIndex,
  }
}

export async function refreshRootAgentCheckpointPointer(args: {
  repoRoot: string
  streamId: string
  rootSessionId: string
  sessionExport: SessionExport
  checkpointCreatedAt: string
  breakpointTags?: readonly string[]
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
        breakpointSelection: latest.breakpointSelection,
      }

      await upsertCheckpointPointerLocked(args.repoRoot, args.streamId, refreshed)
      return refreshed
    }
  }

  await upsertCheckpointPointerLocked(args.repoRoot, args.streamId, latest)
  return latest
}
