import { expect, test } from "bun:test"
import { openRepositoryDomain } from "../src/server.ts"
import type { MutationContext } from "../src/contracts.ts"
import { fixture, mutation } from "./fixtures.ts"

test("durable handoff identity and uncertain acceptance serialize only the recipient", () => {
  const f = fixture(true)
  try {
    const d = f.domain, sender = f.ref(crypto.randomUUID()), target = f.ref(crypto.randomUUID())
    d.createWorkstream({ id: "delivery", title: "Delivery", type: "feature" }, mutation)
    for (const ref of [sender, target]) { d.registerConversation({ ref, executionCheckout: f.checkout }, mutation); d.associateConversation(ref, "delivery", mutation) }
    d.assignPhase(target, "research", mutation)
    const input = { requestId: crypto.randomUUID(), to: "research" as const, message: "Read the available workstream artifacts.", target }
    const recipient = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID(), ref: target, harness: target.harness, authorityId: target.authorityId, checkout: d.getConversation(target)!.executionCheckout }
    const actor: MutationContext = { actor: { kind: "native", repositoryId: d.repositoryId, ref: sender }, correlationId: input.requestId }
    const owner: MutationContext = { actor: { kind: "system" }, correlationId: crypto.randomUUID() }
    const queued = d.admitHandoff(sender, input, recipient, actor)
    expect(queued.status).toBe("queued")
    expect(d.admitHandoff(sender, input, recipient, actor).id).toBe(queued.id)
    expect(() => d.admitHandoff(sender, { ...input, message: "Changed" }, recipient, actor)).toThrow("another handoff payload")
    const attempt = { status: "acceptance_unknown" as const, attemptId: crypto.randomUUID(), nativeCommandId: crypto.randomUUID(), runId: crypto.randomUUID() }
    const uncertain = d.advanceHandoff(queued.id, queued.revision, attempt, owner)
    const reopened = openRepositoryDomain(f.context)
    try {
      expect(reopened.findHandoff(sender, input.requestId)).toEqual(uncertain)
      expect(() => reopened.advanceHandoff(queued.id, 0, attempt, owner)).toThrow("changed")
      expect(() => reopened.advanceHandoff(queued.id, uncertain.revision, { status: "queued" }, owner)).toThrow("reconciled nonacceptance")
      const next = reopened.admitHandoff(sender, { ...input, requestId: crypto.randomUUID() }, recipient, actor)
      expect(() => reopened.advanceHandoff(next.id, next.revision, { ...attempt, attemptId: crypto.randomUUID() }, owner)).toThrow("active or uncertain")
      const retry = reopened.advanceHandoff(queued.id, uncertain.revision, { status: "queued", retry: true, evidence: "Native history inspection established nonacceptance." }, owner)
      expect(() => reopened.advanceHandoff(retry.id, retry.revision, attempt, owner)).toThrow("UNIQUE")
      const accepted = reopened.advanceHandoff(retry.id, retry.revision, { ...attempt, attemptId: crypto.randomUUID(), nativeCommandId: crypto.randomUUID(), runId: crypto.randomUUID() }, owner)
      expect(reopened.advanceHandoff(accepted.id, accepted.revision, { status: "accepted", evidence: "Native command identity observed." }, owner).status).toBe("accepted")
    } finally { reopened.close() }
  } finally { f.cleanup() }
})
