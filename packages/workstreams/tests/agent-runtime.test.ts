import { describe, expect, test } from "bun:test"
import {
  executeAttemptCandidates,
  type AgentEvent,
  type AttemptInputSeed,
  type ResolvedModelSpec,
} from "../src/index.ts"
import { resolveModelSpec } from "../src/lib/model.ts"
import {
  FakeAgentAttemptAdapter,
  type FakeAttemptPlan,
} from "./fixtures/fake-agent-runtime.ts"

const openCodeCandidate = resolveModelSpec("anthropic/claude-sonnet-4")
const cursorCandidate = resolveModelSpec("auto@cursor")

function inputSeed(overrides: Partial<AttemptInputSeed> = {}): AttemptInputSeed {
  return {
    repoRoot: "/repo",
    streamId: "stream-1",
    batchId: "batch-1",
    threadId: "thread-1",
    workSessionId: "session-1",
    logicalAgent: "builder",
    title: "Implement the task",
    prompt: "seed prompt",
    executionBackend: "sdk",
    ...overrides,
  }
}

function eventBase(attemptId: string): Omit<AgentEvent, "type"> {
  return {
    provider: "opencode",
    attemptId,
    workSessionId: "session-1",
    eventId: `${attemptId}:event`,
    timestamp: "2026-08-17T00:00:00.000Z",
  }
}

describe("provider-neutral agent attempt contracts", () => {
  test("persists native IDs before run and normalizes a successful attempt", async () => {
    const adapter = new FakeAgentAttemptAdapter("opencode", {
      outcome: { status: "completed", result: "done" },
    })
    const input = {
      ...inputSeed(),
      attemptId: "attempt-success",
      model: openCodeCandidate,
    }

    const native = await adapter.startAttempt(input)
    expect(native).toMatchObject({
      provider: "opencode",
      attemptId: "attempt-success",
      nativeSessionId: "fake-session-opencode-attempt-success",
      nativeRunId: "fake-run-attempt-success",
    })
    expect(adapter.runCalls).toHaveLength(0)

    const result = await adapter.run(native, input.prompt)
    expect(result).toMatchObject({
      status: "completed",
      provider: "opencode",
      attemptId: "attempt-success",
      nativeSessionId: native.nativeSessionId,
      result: "done",
    })
  })

  test("supports normalized lifecycle events with correlation IDs and timestamps", async () => {
    const attemptId = "attempt-events"
    const events = [
      { ...eventBase(attemptId), type: "started" },
      { ...eventBase(attemptId), type: "assistant", text: "working" },
      { ...eventBase(attemptId), type: "tool", toolName: "write_file", phase: "started" },
      { ...eventBase(attemptId), type: "status", status: "running", progress: 0.5 },
      { ...eventBase(attemptId), type: "progress", progress: 0.75 },
      { ...eventBase(attemptId), type: "usage", usage: { totalTokens: 12 } },
      { ...eventBase(attemptId), type: "completed", result: "done" },
    ] satisfies AgentEvent[]
    const adapter = new FakeAgentAttemptAdapter("opencode", {
      outcome: { status: "completed" },
      events,
    })
    const native = await adapter.startAttempt({
      ...inputSeed(),
      attemptId,
      model: openCodeCandidate,
    })

    const observed: AgentEvent[] = []
    for await (const event of adapter.events(native)) {
      observed.push(event)
    }

    expect(observed.map((event) => event.type)).toEqual([
      "started",
      "assistant",
      "tool",
      "status",
      "progress",
      "usage",
      "completed",
    ])
    expect(observed.every((event) => event.attemptId === attemptId)).toBe(true)
    expect(observed.every((event) => event.timestamp.length > 0)).toBe(true)
  })

  test("represents provider failure", async () => {
    const adapter = new FakeAgentAttemptAdapter("opencode", {
      outcome: {
        status: "failed",
        error: { message: "provider rejected the request", code: "PROVIDER_ERROR" },
      },
    })
    const native = await adapter.startAttempt({
      ...inputSeed(),
      attemptId: "attempt-failure",
      model: openCodeCandidate,
    })

    await expect(adapter.run(native, "prompt")).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_ERROR" },
    })
  })

  test("represents explicit cancellation and timeout-like failure", async () => {
    const cancellationAdapter = new FakeAgentAttemptAdapter("cursor", {
      outcome: { status: "cancelled", reason: "user requested cancellation" },
    })
    const cancellationAttempt = await cancellationAdapter.startAttempt({
      ...inputSeed({ threadId: "thread-cancel", workSessionId: "session-cancel" }),
      attemptId: "attempt-cancel",
      model: cursorCandidate,
    })
    await expect(cancellationAdapter.cancel(cancellationAttempt)).resolves.toMatchObject({
      status: "cancelled",
      cancelled: true,
      acknowledged: true,
    })

    const timeoutAdapter = new FakeAgentAttemptAdapter("opencode", {
      outcome: {
        status: "failed",
        error: { message: "provider timed out", code: "TIMEOUT", timedOut: true },
      },
    })
    const timeoutAttempt = await timeoutAdapter.startAttempt({
      ...inputSeed({ threadId: "thread-timeout" }),
      attemptId: "attempt-timeout",
      model: openCodeCandidate,
    })
    await expect(timeoutAdapter.run(timeoutAttempt, "prompt")).resolves.toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", timedOut: true },
    })
  })

  test("runs parallel independent attempts with separate adapters and native IDs", async () => {
    const adapters: FakeAgentAttemptAdapter[] = []
    const factory = (candidate: ResolvedModelSpec) => {
      const adapter = new FakeAgentAttemptAdapter(candidate.runtime, {
        outcome: { status: "completed", result: candidate.model },
        runDelayMs: 5,
      })
      adapters.push(adapter)
      return adapter
    }

    const [first, second] = await Promise.all([
      executeAttemptCandidates(factory, [openCodeCandidate], inputSeed(), "first prompt"),
      executeAttemptCandidates(
        factory,
        [cursorCandidate],
        inputSeed({ threadId: "thread-2", workSessionId: "session-2" }),
        "second prompt",
      ),
    ])

    expect(first.result.status).toBe("completed")
    expect(second.result.status).toBe("completed")
    expect(first.attempts[0]?.nativeAttempt?.nativeSessionId).not.toBe(
      second.attempts[0]?.nativeAttempt?.nativeSessionId,
    )
    expect(adapters).toHaveLength(2)
    expect(adapters.every((adapter) => adapter.closeCalls === 1)).toBe(true)
  })

  test("uses only explicit ordered fallback candidates and fresh IDs", async () => {
    const candidates = [cursorCandidate, openCodeCandidate]
    const adapters: FakeAgentAttemptAdapter[] = []
    const factory = (candidate: ResolvedModelSpec) => {
      const plan: FakeAttemptPlan =
        candidate.runtime === "cursor"
          ? {
              outcome: {
                status: "failed",
                error: { message: "Cursor unavailable", code: "UNAVAILABLE" },
              },
            }
          : { outcome: { status: "completed", result: "fallback succeeded" } }
      const adapter = new FakeAgentAttemptAdapter(candidate.runtime, plan)
      adapters.push(adapter)
      return adapter
    }

    const execution = await executeAttemptCandidates(
      factory,
      candidates,
      inputSeed(),
      "fallback prompt",
      {
        createAttemptId: (() => {
          let sequence = 0
          return () => `attempt-${++sequence}`
        })(),
      },
    )

    expect(execution.result).toMatchObject({ status: "completed", result: "fallback succeeded" })
    expect(execution.attempts.map((attempt) => attempt.candidate.runtime)).toEqual([
      "cursor",
      "opencode",
    ])
    expect(execution.attempts.map((attempt) => attempt.input.attemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ])
    expect(execution.attempts[0]?.nativeAttempt?.nativeSessionId).not.toBe(
      execution.attempts[1]?.nativeAttempt?.nativeSessionId,
    )
    expect(adapters.map((adapter) => adapter.startCalls).flat()).toHaveLength(2)
  })

  test("does not retry a failed model/runtime implicitly", async () => {
    const adapters: FakeAgentAttemptAdapter[] = []
    const factory = (candidate: ResolvedModelSpec) => {
      const adapter = new FakeAgentAttemptAdapter(candidate.runtime, {
        outcome: { status: "failed", error: { message: "failed once", code: "FAILED" } },
      })
      adapters.push(adapter)
      return adapter
    }

    const execution = await executeAttemptCandidates(
      factory,
      [openCodeCandidate],
      inputSeed(),
      "no implicit retry",
    )

    expect(execution.result.status).toBe("failed")
    expect(execution.attempts).toHaveLength(1)
    expect(adapters).toHaveLength(1)
    expect(adapters[0]?.startCalls).toHaveLength(1)
  })

  test("rejects invalid candidates before fake provider startup", async () => {
    const startupCalls: ResolvedModelSpec[] = []
    const invalidCursorCandidate = {
      model: "provider/model",
      runtime: "cursor",
    } as ResolvedModelSpec

    await expect(
      executeAttemptCandidates(
        (candidate) => {
          startupCalls.push(candidate)
          return new FakeAgentAttemptAdapter(candidate.runtime, {
            outcome: { status: "completed" },
          })
        },
        [invalidCursorCandidate],
        inputSeed(),
        "invalid candidate",
      ),
    ).rejects.toThrow(/Invalid attempt candidate/)
    expect(startupCalls).toHaveLength(0)
  })
})
