import { describe, test, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { fixture, mutation } from "./fixtures.ts"
import type { HandoffRecipient, MutationContext } from "../src/contracts.ts"
import { isHandoffStatus, HANDOFF_STATUSES } from "../src/handoff.ts"

const system = (id: string): MutationContext => ({ actor: { kind: "system" }, correlationId: id })
function setup() {
  const f = fixture()
  const sender = f.ref("sender-approval")
  f.domain.registerConversation({ ref: sender, executionCheckout: f.checkout }, mutation)
  f.domain.createWorkstream({ id: "ws-approval", title: "Approval WS", type: "feature", defaultCheckout: f.checkout }, mutation)
  f.domain.associateConversation(sender, "ws-approval", mutation)
  const pin = f.domain.getConversation(sender)!.executionCheckout
  const recipient = (sessionId = randomUUID()): HandoffRecipient => ({
    ownerId: "app-store",
    sessionId,
    ref: null,
    harness: "cc",
    authorityId: f.authority.authorityId,
    checkout: pin,
  })
  const native = (ref: typeof sender, requestId: string): MutationContext => ({
    actor: { kind: "native", repositoryId: f.domain.repositoryId, ref },
    correlationId: requestId,
  })
  return { ...f, sender, recipient, native }
}

describe("handoff approval gate", () => {
  test("HANDOFF_STATUSES includes awaiting_approval", () => {
    expect(HANDOFF_STATUSES).toContain("awaiting_approval")
    expect(isHandoffStatus("awaiting_approval")).toBe(true)
    expect(isHandoffStatus("queued")).toBe(true)
    expect(isHandoffStatus("nope")).toBe(false)
  })

  test("admit inserts awaiting_approval and excludes from polling", () => {
    const f = setup()
    try {
      const h = f.domain.admitHandoff(
        f.sender,
        { requestId: "req-admit", to: "engineering", message: "hello", createNew: true },
        f.recipient(),
        f.native(f.sender, "req-admit"),
      )
      expect(h.status).toBe("awaiting_approval")
      expect(h.revision).toBe(0)
      expect(f.domain.listHandoffs()).toHaveLength(1)
      expect(f.domain.listHandoffsForPolling()).toHaveLength(0)
      expect(f.domain.findHandoff(f.sender, "req-admit")?.id).toBe(h.id)
    } finally { f.cleanup() }
  })

  test("admit is idempotent on sender+requestId with optimistic revision", () => {
    const f = setup()
    try {
      const args = { requestId: "req-idem", to: "engineering", message: "same", createNew: true }
      const first = f.domain.admitHandoff(f.sender, args, f.recipient(), f.native(f.sender, "req-idem"))
      const second = f.domain.admitHandoff(f.sender, args, f.recipient(randomUUID()), f.native(f.sender, "req-idem"))
      expect(second.id).toBe(first.id)
      expect(second.revision).toBe(first.revision)
      expect(() => f.domain.admitHandoff(
        f.sender,
        { ...args, message: "different" },
        f.recipient(),
        f.native(f.sender, "req-idem"),
      )).toThrow("Request ID is already bound")
    } finally { f.cleanup() }
  })

  test("approve awaiting_approval -> queued, then visible for polling", () => {
    const f = setup()
    try {
      const h = f.domain.admitHandoff(
        f.sender,
        { requestId: "req-approve", to: "engineering", message: "please", createNew: true },
        f.recipient(),
        f.native(f.sender, "req-approve"),
      )
      const approved = f.domain.advanceHandoff(h.id, h.revision, { status: "queued" }, system(h.id))
      expect(approved.status).toBe("queued")
      expect(approved.revision).toBe(h.revision + 1)
      expect(f.domain.listHandoffsForPolling().map(x => x.id)).toContain(h.id)
      // Stale revision must conflict.
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "queued" }, system(h.id))).toThrow("Handoff changed")
    } finally { f.cleanup() }
  })

  test("deny awaiting_approval -> failed requires evidence reason", () => {
    const f = setup()
    try {
      const h = f.domain.admitHandoff(
        f.sender,
        { requestId: "req-deny", to: "engineering", message: "deny me", createNew: true },
        f.recipient(),
        f.native(f.sender, "req-deny"),
      )
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "failed" }, system(h.id))).toThrow()
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "failed", evidence: "   " }, system(h.id))).toThrow()
      const denied = f.domain.advanceHandoff(h.id, h.revision, { status: "failed", evidence: "not needed now" }, system(h.id))
      expect(denied.status).toBe("failed")
      expect(denied.evidence).toBe("not needed now")
      expect(f.domain.listHandoffsForPolling()).toHaveLength(0)
    } finally { f.cleanup() }
  })

  test("invalid transitions from awaiting_approval are rejected", () => {
    const f = setup()
    try {
      const h = f.domain.admitHandoff(
        f.sender,
        { requestId: "req-invalid", to: "engineering", message: "x", createNew: true },
        f.recipient(),
        f.native(f.sender, "req-invalid"),
      )
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "acceptance_unknown", attemptId: "a", nativeCommandId: "c", runId: "r" }, system(h.id))).toThrow("Invalid handoff transition")
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "running", evidence: "e" }, system(h.id))).toThrow("Invalid handoff transition")
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "completed", evidence: "e" }, system(h.id))).toThrow("Invalid handoff transition")
      expect(() => f.domain.advanceHandoff(h.id, h.revision, { status: "queued", retry: true, evidence: "retry?" }, system(h.id))).toThrow("Approval does not use retry")
    } finally { f.cleanup() }
  })
})
