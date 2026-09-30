import { describe, expect, test } from "bun:test"
import type { CallerEnvelope } from "../src/cli-arguments"
import { matchesOpenCodeWorkerPart, nativeWorkerInput, nativeWorkerInvocation, nativeWorkerRequestId, nativeWorkerSchemas, parseNativeWorkerRequest, projectNativeWorkerReply } from "../src/native-worker-contract"
import { OpenCodeWorkerInvocations } from "../src/native-opencode"

const workerId = "11111111-1111-4111-8111-111111111111"
const caller: CallerEnvelope = { version: 1, repository: "/repo", source: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/sources/service.json" }, authorityId: "authority-oc", nativeId: "native-parent" }
const invocation = { toolCallId: "tool-start", messageId: "message-parent" }
const ref = { workerId, revision: 2, notificationId: `worker-outcome:${workerId}:run-two` }

describe("strict shared native worker contract", () => {
  test("Code Mode hooks bind exact context; each inner callback has independent retry identity", () => {
    const tracker = new OpenCodeWorkerInvocations()
    const context = { sessionID: "ses-parent", messageID: "msg-parent", id: "outer-call", agent: "build" }
    const outer = { ...context, tool: "execute" }
    tracker.before(outer)
    const first = tracker.callback(context, "start"), second = tracker.callback(context, "start")
    expect(first.opencode?.wrapper).toBe("execute")
    expect(first.toolCallId).toBe(second.toolCallId)
    expect(first.opencode?.invocationId).not.toBe(second.opencode?.invocationId)
    expect(nativeWorkerRequestId(caller, first)).not.toBe(nativeWorkerRequestId(caller, second))
    expect(nativeWorkerRequestId(caller, first)).toBe(nativeWorkerRequestId(caller, structuredClone(first)))
    for (const changed of [{ sessionID: "other" }, { messageID: "other" }, { id: "other" }, { agent: "other" }]) {
      expect(tracker.callback({ ...context, ...changed }, "start").opencode?.wrapper).toBeUndefined()
    }
    const part = { type: "tool", id: context.id, name: "execute" }
    expect(matchesOpenCodeWorkerPart("start", first, context.messageID, part)).toBe(true)
    expect(matchesOpenCodeWorkerPart("status", first, context.messageID, part)).toBe(false)
    expect(matchesOpenCodeWorkerPart("start", first, "other-message", part)).toBe(false)
    expect(matchesOpenCodeWorkerPart("start", first, context.messageID, { ...part, id: "other" })).toBe(false)
    expect(matchesOpenCodeWorkerPart("start", { toolCallId: context.id, messageId: context.messageID }, context.messageID, part)).toBe(false)
    tracker.after(outer)
    const direct = tracker.callback(context, "start")
    expect(direct.opencode?.wrapper).toBeUndefined()
    expect(matchesOpenCodeWorkerPart("start", direct, context.messageID, part)).toBe(false)
    expect(matchesOpenCodeWorkerPart("start", direct, context.messageID, { ...part, name: "sane_worker_start" })).toBe(true)
    expect(matchesOpenCodeWorkerPart("start", first, context.messageID, { ...part, name: "sane_worker_start" })).toBe(false)
    tracker.before(outer); tracker.clear()
    expect(tracker.callback(context, "start").opencode?.wrapper).toBeUndefined()
  })

  test("callback provenance is strict OC-only transport data, not model input", () => {
    const tracker = new OpenCodeWorkerInvocations()
    const invocation = tracker.callback({ sessionID: caller.nativeId, messageID: "msg", id: "tool", agent: "build" }, "status")
    expect(parseNativeWorkerRequest({ operation: "status", caller, invocation, input: {} }).invocation).toEqual(invocation)
    expect(() => parseNativeWorkerRequest({ operation: "wait", caller, invocation, input: { ids: [workerId] } })).toThrow()
    const cc = { ...caller, source: { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/profile" } }
    expect(() => parseNativeWorkerRequest({ operation: "status", caller: cc, invocation, input: {} })).toThrow()
    expect(() => nativeWorkerInvocation({ ...invocation, opencode: { ...invocation.opencode, wrapper: "arbitrary" } })).toThrow()
    expect(() => nativeWorkerInvocation({ ...invocation, opencode: { ...invocation.opencode, invocationId: "invented" } })).toThrow()
    expect(() => nativeWorkerInput("status", { opencode: invocation.opencode })).toThrow()
  })
  test("cancel requires explicit nonempty IDs and cancel-all accepts no model-selected scope", () => {
    for (const args of [{}, { ids: [] }, { ids: ["not-a-uuid"] }, { ids: [workerId], includeDescendants: "true" }]) expect(() => nativeWorkerInput("cancel", args)).toThrow()
    expect(nativeWorkerInput("cancel", { ids: [workerId], includeDescendants: true })).toEqual({ ids: [workerId], includeDescendants: true })
    expect(() => nativeWorkerInput("cancel_all", { parentSessionId: workerId })).toThrow()
    expect(nativeWorkerInput("cancel_all", {})).toEqual({})
    expect(nativeWorkerSchemas.cancel.required).toEqual(["ids"])
  })

  test("acknowledgement requires exact strict bounded revision references", () => {
    expect(nativeWorkerInput("acknowledge", { refs: [ref] })).toEqual({ refs: [ref] })
    for (const bad of [
      { ...ref, workerId: "bad" }, { ...ref, revision: 0 }, { ...ref, revision: 1.5 },
      { ...ref, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...ref, notificationId: "" },
      { ...ref, notificationId: "has space" }, { ...ref, notificationId: "bad\u007f" },
      { ...ref, notificationId: "x".repeat(2049) }, { ...ref, extra: true },
      { workerId, revision: 2 },
    ]) expect(() => nativeWorkerInput("acknowledge", { refs: [bad] })).toThrow()
    for (const refs of [[], Array.from({ length: 257 }, () => ref)]) expect(() => nativeWorkerInput("acknowledge", { refs })).toThrow()
  })

  test("private invocation and admission IDs are not model arguments; transport key is bound to trusted identity", () => {
    const args = { worker: "tester", prompt: "Check behavior" }
    for (const key of ["requestId", "runId", "toolCallId", "messageId", "invocation", "_invocation"]) expect(() => nativeWorkerInput("start", { ...args, [key]: "invented" })).toThrow()
    const requestId = nativeWorkerRequestId(caller, invocation)
    const request = { operation: "start", caller, invocation, input: { ...args, requestId } }
    expect(parseNativeWorkerRequest(request)).toMatchObject(request)
    expect(() => parseNativeWorkerRequest({ ...request, invocation: { ...invocation, toolCallId: "different" } })).toThrow()
    expect(() => parseNativeWorkerRequest({ ...request, invocation: { toolCallId: invocation.toolCallId } })).toThrow()
    expect(() => parseNativeWorkerRequest({ ...request, input: { ...args, requestId: "invented" } })).toThrow()
  })

  test("wait defaults to nonblocking and rejects unbounded or unknown arguments", () => {
    expect(nativeWorkerInput("wait", { ids: [workerId] })).toEqual({ ids: [workerId], timeoutSec: 0 })
    for (const timeoutSec of [-1, 11, NaN, Infinity, "10"]) expect(() => nativeWorkerInput("wait", { ids: [workerId], timeoutSec })).toThrow()
    expect(() => nativeWorkerInput("status", { ids: [workerId], consume: true })).toThrow()
  })

  test("double projection retains exact result references and arbitration receipts, excludes private data", () => {
    const outcome = { status: "completed", at: "2026-09-29T10:00:00Z", summary: "result", log: null }
    const projected = projectNativeWorkerReply({ worker: { id: workerId, sessionId: workerId, runId: null, state: "completed", input: { prompt: "private prompt" }, launch: { model: "private model" }, parent: caller, outcome, results: [{ revision: ref.revision, runId: null, outcome, notification: { id: ref.notificationId, state: "claimed", deliveryId: "private-delivery" } }] }, receipts: [{ ...ref, state: "claimed", acknowledged: false }] })
    expect(projectNativeWorkerReply(projected)).toEqual(projected)
    expect(projected.worker!.latestResult).toMatchObject({ revision: 2, notificationId: ref.notificationId, notificationState: "claimed" })
    expect(projected.receipts).toEqual([{ ...ref, state: "claimed", acknowledged: false }])
    expect(JSON.stringify(projected)).not.toContain("private")
  })
})
