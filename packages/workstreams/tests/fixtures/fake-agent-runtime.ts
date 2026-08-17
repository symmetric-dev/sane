import type {
  AgentAttemptAdapter,
  AgentAttemptError,
  AgentEvent,
  AgentProvider,
  AttemptInput,
  AttemptResult,
  CancelResult,
  NativeAttempt,
  ProviderMetadata,
  ReconciliationResult,
} from "../../src/lib/agent-runtime/index.ts"

export type FakeRunOutcome =
  | {
      status: "completed"
      result?: unknown
      providerMetadata?: ProviderMetadata
    }
  | {
      status: "failed"
      error: AgentAttemptError
      providerMetadata?: ProviderMetadata
    }
  | {
      status: "cancelled"
      reason?: string
      providerMetadata?: ProviderMetadata
    }

export interface FakeAttemptPlan {
  outcome: FakeRunOutcome
  events?: readonly AgentEvent[]
  startupError?: unknown
  runError?: unknown
  runDelayMs?: number
  nativeSessionId?: string
  nativeRunId?: string
  nativeMetadata?: ProviderMetadata
  cancelStatus?: CancelResult["status"]
}

export class FakeAgentAttemptAdapter implements AgentAttemptAdapter {
  readonly executionBackend = "sdk" as const
  readonly startCalls: AttemptInput[] = []
  readonly runCalls: Array<{ attempt: NativeAttempt; prompt: string }> = []
  readonly cancelCalls: NativeAttempt[] = []
  readonly nativeAttempts: NativeAttempt[] = []
  closeCalls = 0

  private readonly inputs = new Map<string, AttemptInput>()

  constructor(
    readonly provider: AgentProvider,
    private readonly plan: FakeAttemptPlan,
  ) {}

  async startAttempt(input: AttemptInput): Promise<NativeAttempt> {
    this.startCalls.push(input)
    if (this.plan.startupError !== undefined) {
      throw this.plan.startupError
    }

    const nativeAttempt: NativeAttempt = {
      provider: this.provider,
      attemptId: input.attemptId,
      nativeSessionId:
        this.plan.nativeSessionId ?? `fake-session-${this.provider}-${input.attemptId}`,
      nativeRunId: this.plan.nativeRunId ?? `fake-run-${input.attemptId}`,
      ...(this.plan.nativeMetadata === undefined ? {} : { metadata: this.plan.nativeMetadata }),
    }
    this.inputs.set(input.attemptId, input)
    this.nativeAttempts.push(nativeAttempt)
    return nativeAttempt
  }

  async run(attempt: NativeAttempt, prompt: string): Promise<AttemptResult> {
    this.runCalls.push({ attempt, prompt })
    if (this.plan.runDelayMs !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.plan.runDelayMs))
    }
    if (this.plan.runError !== undefined) {
      throw this.plan.runError
    }

    const input = this.inputs.get(attempt.attemptId)
    if (!input) {
      throw new Error(`Fake attempt was not started: ${attempt.attemptId}`)
    }

    const outcome = this.plan.outcome
    return {
      provider: this.provider,
      attemptId: attempt.attemptId,
      workSessionId: input.workSessionId,
      eventId: `${attempt.attemptId}:${outcome.status}`,
      timestamp: new Date().toISOString(),
      nativeSessionId: attempt.nativeSessionId,
      nativeRunId: attempt.nativeRunId,
      status: outcome.status,
      ...(outcome.status === "completed" ? { result: outcome.result } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      ...(outcome.status === "cancelled" ? { reason: outcome.reason } : {}),
      ...(outcome.providerMetadata === undefined
        ? {}
        : { providerMetadata: outcome.providerMetadata }),
    } as AttemptResult
  }

  async *events(attempt: NativeAttempt): AsyncIterable<AgentEvent> {
    if (!this.inputs.has(attempt.attemptId)) {
      throw new Error(`Fake attempt was not started: ${attempt.attemptId}`)
    }
    for (const event of this.plan.events ?? []) {
      yield event
    }
  }

  async cancel(attempt: NativeAttempt): Promise<CancelResult> {
    this.cancelCalls.push(attempt)
    const input = this.inputs.get(attempt.attemptId)
    if (!input) {
      return {
        provider: this.provider,
        attemptId: attempt.attemptId,
        workSessionId: "unknown",
        eventId: `${attempt.attemptId}:cancel-failed`,
        timestamp: new Date().toISOString(),
        status: "not_found",
        cancelled: false,
        acknowledged: false,
      }
    }

    const status = this.plan.cancelStatus ?? "cancelled"
    return {
      provider: this.provider,
      attemptId: attempt.attemptId,
      workSessionId: input.workSessionId,
      eventId: `${attempt.attemptId}:cancel`,
      timestamp: new Date().toISOString(),
      nativeSessionId: attempt.nativeSessionId,
      nativeRunId: attempt.nativeRunId,
      status,
      cancelled: status === "cancelled",
      acknowledged: status === "cancelled" || status === "already_terminal",
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async reconcile(nativeSessionId: string): Promise<ReconciliationResult> {
    return {
      provider: this.provider,
      nativeSessionId,
      status: "unknown",
      timestamp: new Date().toISOString(),
    }
  }
}
