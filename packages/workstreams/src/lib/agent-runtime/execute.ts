import { randomUUID } from "node:crypto"
import { resolveModelSpec } from "../model.ts"
import type { ResolvedModelSpec } from "../types.ts"
import type {
  AgentAttemptAdapter,
  AgentAttemptError,
  AgentProvider,
  AttemptInput,
  AttemptInputSeed,
  AttemptResult,
  NativeAttempt,
} from "./contracts.ts"

export type AttemptAdapterFactory = (
  candidate: ResolvedModelSpec,
  input: AttemptInput,
) => AgentAttemptAdapter | Promise<AgentAttemptAdapter>

export interface ExecuteAttemptCandidatesOptions {
  /** Injectable for deterministic tests; production defaults to UUIDs. */
  createAttemptId?: () => string
  /** Injectable clock for deterministic normalized failure results. */
  now?: () => string
}

export interface AttemptCandidateOutcome {
  candidate: ResolvedModelSpec
  input: AttemptInput
  nativeAttempt?: NativeAttempt
  result: AttemptResult
}

export interface ExecuteAttemptCandidatesResult {
  /** The first completed result, or the terminal result after the last failure. */
  result: AttemptResult
  /** Every explicitly attempted candidate, in execution order. */
  attempts: readonly AttemptCandidateOutcome[]
}

function nowIso(now: () => string): string {
  return now()
}

/** Convert an unknown provider/adapter exception into persisted AgENV data. */
export function normalizeAttemptError(error: unknown): AgentAttemptError {
  if (error instanceof Error) {
    const errorWithFields = error as Error & {
      code?: unknown
      retryable?: unknown
      timedOut?: unknown
      diagnostic?: unknown
    }
    const code = typeof errorWithFields.code === "string" ? errorWithFields.code : undefined
    const timedOut =
      errorWithFields.timedOut === true ||
      error.name.toLowerCase().includes("timeout") ||
      code?.toLowerCase().includes("timeout") === true

    return {
      message: error.message,
      name: error.name,
      ...(code === undefined ? {} : { code }),
      ...(typeof errorWithFields.retryable === "boolean"
        ? { retryable: errorWithFields.retryable }
        : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(errorWithFields.diagnostic === undefined
        ? {}
        : { diagnostic: errorWithFields.diagnostic }),
    }
  }

  return { message: String(error) }
}

function failedResult(
  provider: AgentProvider,
  input: AttemptInput,
  error: unknown,
  nativeAttempt: NativeAttempt | undefined,
  now: () => string,
): AttemptResult {
  return {
    provider,
    attemptId: input.attemptId,
    workSessionId: input.workSessionId,
    eventId: `${input.attemptId}:failed`,
    timestamp: nowIso(now),
    ...(nativeAttempt?.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: nativeAttempt.nativeSessionId }),
    ...(nativeAttempt?.nativeRunId === undefined ? {} : { nativeRunId: nativeAttempt.nativeRunId }),
    status: "failed",
    error: normalizeAttemptError(error),
  }
}

function validateCandidate(candidate: ResolvedModelSpec, index: number): ResolvedModelSpec {
  try {
    return validateResolvedModelSpec(candidate)
  } catch (error) {
    throw new Error(
      `Invalid attempt candidate ${index + 1}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/**
 * Validate a resolved candidate at the AgENV boundary before provider startup.
 * The candidate's own runtime is used as the validation target; no fallback
 * runtime is selected here.
 */
export function validateResolvedModelSpec(candidate: ResolvedModelSpec): ResolvedModelSpec {
  return resolveModelSpec(candidate, { runtime: candidate.runtime })
}

function ensureFreshAttemptId(
  createAttemptId: () => string,
  usedAttemptIds: Set<string>,
): string {
  const attemptId = createAttemptId()
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw new Error("Attempt ID factory must return a non-empty string")
  }
  if (usedAttemptIds.has(attemptId)) {
    throw new Error(`Attempt ID factory returned a duplicate attempt ID: ${attemptId}`)
  }
  usedAttemptIds.add(attemptId)
  return attemptId
}

function normalizedProviderResult(
  result: AttemptResult,
  provider: AgentProvider,
  input: AttemptInput,
  nativeAttempt: NativeAttempt,
  now: () => string,
): AttemptResult {
  return {
    ...result,
    provider,
    attemptId: input.attemptId,
    workSessionId: input.workSessionId,
    eventId: result.eventId || `${input.attemptId}:${result.status}`,
    timestamp: result.timestamp || nowIso(now),
    ...(result.nativeSessionId === undefined && nativeAttempt.nativeSessionId !== undefined
      ? { nativeSessionId: nativeAttempt.nativeSessionId }
      : {}),
    ...(result.nativeRunId === undefined && nativeAttempt.nativeRunId !== undefined
      ? { nativeRunId: nativeAttempt.nativeRunId }
      : {}),
  } as AttemptResult
}

/**
 * Execute only the ordered candidates supplied by the caller.
 *
 * A new adapter, native attempt, and attempt ID are created for each candidate.
 * Failed candidates advance to the next explicit candidate; completed and
 * cancelled candidates stop the policy. No candidate is retried under a
 * synthesized runtime or repeated implicitly.
 */
export async function executeAttemptCandidates(
  adapterFactory: AttemptAdapterFactory,
  candidates: readonly ResolvedModelSpec[],
  input: AttemptInputSeed,
  prompt: string,
  options: ExecuteAttemptCandidatesOptions = {},
): Promise<ExecuteAttemptCandidatesResult> {
  if (candidates.length === 0) {
    throw new Error("At least one explicit attempt candidate is required")
  }

  const createAttemptId = options.createAttemptId ?? randomUUID
  const now = options.now ?? (() => new Date().toISOString())
  const validatedCandidates = candidates.map(validateCandidate)
  const usedAttemptIds = new Set<string>()
  const attempts: AttemptCandidateOutcome[] = []
  let lastResult: AttemptResult | undefined

  for (const candidate of validatedCandidates) {
    const attemptId = ensureFreshAttemptId(createAttemptId, usedAttemptIds)
    const attemptInput: AttemptInput = {
      ...input,
      attemptId,
      model: candidate,
      prompt,
    }

    let adapter: AgentAttemptAdapter | undefined
    let nativeAttempt: NativeAttempt | undefined
    let result: AttemptResult | undefined

    try {
      adapter = await adapterFactory(candidate, attemptInput)
      if (!adapter || typeof adapter !== "object") {
        throw new Error("Attempt adapter factory returned no adapter")
      }
      if (adapter.provider !== candidate.runtime) {
        throw new Error(
          `Attempt adapter provider "${adapter.provider}" does not match candidate runtime "${candidate.runtime}"`,
        )
      }

      nativeAttempt = await adapter.startAttempt(attemptInput)
      if (nativeAttempt.provider !== candidate.runtime) {
        throw new Error(
          `Native attempt provider "${nativeAttempt.provider}" does not match candidate runtime "${candidate.runtime}"`,
        )
      }
      if (nativeAttempt.attemptId !== attemptId) {
        throw new Error(
          `Native attempt ID "${nativeAttempt.attemptId}" does not match input attempt ID "${attemptId}"`,
        )
      }

      result = normalizedProviderResult(
        await adapter.run(nativeAttempt, prompt),
        candidate.runtime,
        attemptInput,
        nativeAttempt,
        now,
      )
    } catch (error) {
      result = failedResult(candidate.runtime, attemptInput, error, nativeAttempt, now)
    } finally {
      if (adapter) {
        try {
          await adapter.close()
        } catch (closeError) {
          // Cleanup failure must not hide a provider result. If startup/run
          // already failed, the original failure remains the useful outcome.
          if (result === undefined) {
            result = failedResult(candidate.runtime, attemptInput, closeError, nativeAttempt, now)
          }
        }
      }
    }

    const outcome: AttemptCandidateOutcome = {
      candidate,
      input: attemptInput,
      ...(nativeAttempt === undefined ? {} : { nativeAttempt }),
      result: result!,
    }
    attempts.push(outcome)
    lastResult = result

    if (result!.status !== "failed") {
      return { result: result!, attempts }
    }
  }

  return { result: lastResult!, attempts }
}
