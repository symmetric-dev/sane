import type { RootAgentBranchScope } from "../types.ts"

export type BranchLaunchScope = RootAgentBranchScope

export function normalizeOptionalLaunchString(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function describeScopeLabel(scope: BranchLaunchScope | undefined, batch?: string): string {
  return scope?.level === "stage"
    ? `stage ${scope.stageId}`
    : `batch ${scope?.batchId ?? batch ?? "(next resumable batch)"}`
}

export function buildScopeInstructionBlock(
  scope: BranchLaunchScope | undefined,
  batch?: string,
): string[] {
  const scopeLabel = describeScopeLabel(scope, batch)

  if (scope?.level === "stage") {
    return [
      `Stay inside ${scopeLabel}; do not drift into later stages even if the broader workstream has more incomplete batches.`,
      `Before each supervise pass, inspect the persisted state of ${scopeLabel} and identify the next incomplete or resumable batch within that stage.`,
      "work supervise itself is still a single-batch primitive.",
      `After each review/fix cycle, inspect persisted workstream and supervisor state again to decide whether the same batch must resume, another batch in ${scopeLabel} remains, or ${scopeLabel} is complete.`,
      `Yield as soon as ${scopeLabel} is complete or policy says to stop.`,
    ]
  }

  return [
    "Keep this supervision session focused on one bounded batch supervision pass.",
    `Yield as soon as ${scopeLabel} is done or policy says to stop.`,
  ]
}

export function buildSupervisionPrompt(args: {
  scope?: BranchLaunchScope
  batch?: string
}): string {
  const batchTarget = args.batch ? `batch ${args.batch}` : "the next resumable batch"
  const scopeLabel = describeScopeLabel(args.scope, args.batch)
  const scopeInstructions = buildScopeInstructionBlock(args.scope, args.batch)
  const initialSuperviseCommand =
    args.scope?.level === "stage"
      ? "Start by inspecting persisted stage state and running `work supervise --batch \"<next batch in this stage>\"` for the next incomplete or resumable batch in that stage."
      : args.scope?.level === "batch" || args.batch
        ? `Start by running \`work supervise --batch "${args.scope?.batchId ?? args.batch}"\`.`
        : "Start by running `work supervise`."
  const nextStepsInstruction =
    args.scope?.level === "stage"
      ? "In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation stage."
      : "In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation batch."

  return [
    args.scope?.level === "stage"
      ? `Please supervise ${scopeLabel} for this workstream, one batch at a time until the stage is done or you must yield by policy.`
      : `Please supervise ${batchTarget} for this workstream.`,
    "Use the supervising-workstreams skill.",
    ...scopeInstructions,
    "",
    initialSuperviseCommand,
    "Reuse plain `work supervise` when the current batch is already resumable; only add `--batch` when you need to pick the next bounded batch inside your scope.",
    "Then follow the supervising-workstreams skill, using persisted workstream state to decide whether to rerun the current batch, continue within the same scope, run a fix subagent, or yield by policy.",
    "",
    "When you yield back, return a semi-structured final report with these headings exactly:",
    "## Accomplished",
    "## Issues Found",
    "## Fixes Applied",
    "## What is Next",
    "",
    `${nextStepsInstruction} If a section has nothing to report, write \"None.\"`,
  ].join("\n")
}

export function inferStageIdFromBatchId(batchId?: string): string | undefined {
  if (!batchId) {
    return undefined
  }

  const [stageId, batchSuffix] = batchId.split(".")
  return stageId && batchSuffix && stageId.length > 0 && batchSuffix.length > 0
    ? stageId
    : undefined
}

export function resolveLegacyLaunchTarget(args: {
  scope?: string
  stage?: string
  batch?: string
  target?: string
}): string | undefined {
  const normalizedTarget = normalizeOptionalLaunchString(args.target)
  if (normalizedTarget) {
    return normalizedTarget
  }

  const normalizedStage = normalizeOptionalLaunchString(args.stage)
  if (args.scope === "stage" && normalizedStage) {
    return normalizedStage
  }

  return normalizeOptionalLaunchString(args.batch)
}

export function resolveLaunchScope(args: {
  scope?: string
  target?: string
}): BranchLaunchScope | undefined {
  const requestedScope = normalizeOptionalLaunchString(args.scope)
  const target = normalizeOptionalLaunchString(args.target)

  if (requestedScope === "stage") {
    const stageId = target
    if (!stageId) {
      throw new Error(
        "Stage scope requires --target with a stage id (for example: 10).",
      )
    }

    return {
      level: "stage",
      stageId,
    }
  }

  if (requestedScope && requestedScope !== "batch") {
    throw new Error(
      `Invalid supervision scope \"${requestedScope}\". Expected \"stage\" or \"batch\".`,
    )
  }

  if (!target) {
    return undefined
  }

  const stageId = inferStageIdFromBatchId(target)
  if (!stageId) {
    throw new Error(
      `Batch scope requires a stage-qualified batch id (received \"${target}\").`,
    )
  }

  return {
    level: "batch",
    stageId,
    batchId: target,
  }
}

export function doLaunchScopesMatch(
  left: BranchLaunchScope | undefined,
  right: BranchLaunchScope | undefined,
): boolean {
  if (!left && !right) {
    return true
  }

  if (!left || !right || left.level !== right.level) {
    return false
  }

  if (left.level === "stage" && right.level === "stage") {
    return left.stageId === right.stageId
  }

  if (left.level === "batch" && right.level === "batch") {
    return left.stageId === right.stageId && left.batchId === right.batchId
  }

  return false
}
