import { discoverRepository, handoffInput, normalizeNativeSource, revalidateCheckout, DomainError } from "sane-core/server";
import type { ConversationRef, Handoff, HandoffExecutionConfig, HandoffRecipient, MutationContext } from "sane-core/contracts";
import { classifyCaller } from "../../sane-cli/src/cli-arguments";
import type { AdmissionService } from "./admission";
import type { CatalogService } from "./catalog";
import type { SourceRecords } from "./app-store";
import type { Session } from "./history";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";

const same = (a: ConversationRef, b: ConversationRef) => a.harness === b.harness && a.authorityId === b.authorityId && a.nativeId === b.nativeId;
const system = (id: string): MutationContext => ({ actor: { kind: "system" }, correlationId: id });

// C11 agent-facing native projections. The full Handoff row stays server-side
// (verbose form reachable via GET /api/handoffs?workspaceId= and the
// /api/handoffs/:id owner endpoints); the native replies carry only what the
// next action needs. runId is kept in the enqueue projection — a deviation
// from the drafted 5-key shape — for delivery correlation.
export function projectHandoffEnqueue(h: Handoff) {
  return { requestId: h.input.requestId, id: h.id, to: h.input.to, status: h.status, recipientSessionId: h.recipient.sessionId, runId: h.runId, ...(h.input.kickoff ? { workstreamId: h.workstreamId } : {}) };
}
export function projectHandoffStatus(h: Handoff) {
  return { id: h.id, status: h.status, revision: h.revision, ...(h.input.kickoff ? { workstreamId: h.workstreamId } : {}) };
}

// Legacy-minus-prefix recipient titles. Legacy `readyTitle` named handoff
// target sessions `[workstream] Role #index` where the index is the 1-based
// position in slot order; the workstream now renders separately in the UI, so
// recipient sessions are titled `<Role> #<n>` only (e.g. `Engineering #2`).
// Only handoff-created (createNew) sessions get auto-titles; reply/attach
// paths never rename. Deterministic and sync: no model calls for titles.
/** Display role for a phase slot, mirroring legacy `readyTitle` (`research:x` → `Research`). */
export function slotDisplayName(phase: string): string {
  const role = phase.split(":")[0] ?? "";
  if (!role) throw new WorkstreamAdapterError(400, "invalid-request", "Invalid phase slot.");
  return `${role[0]!.toUpperCase()}${role.slice(1)}`;
}

/** Stable recipient title for the n-th session in a slot (`Engineering #2`). */
export function handoffRecipientTitle(phase: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new WorkstreamAdapterError(400, "invalid-request", "Session index must be a positive integer.");
  return `${slotDisplayName(phase)} #${index}`;
}

export interface SlotAssignment { id: string; phase: string; startedAt: string }
/**
 * 1-based position of one assignment among its workstream's assignments for
 * the same exact phase, oldest first by (startedAt, id) — the current-domain
 * analogue of legacy `listSelectionsBySlot` order (updated_at, rowid), which
 * likewise counted every linked session for the slot. Ended assignments
 * count: legacy selections persisted after replacement, so callers pass
 * active + history rows. Falls back to 1 when the assignment is absent,
 * mirroring legacy `targetIndex`.
 */
export function slotSessionIndex(assignments: readonly SlotAssignment[], phase: string, assignmentId: string): number {
  const ordered = assignments.filter(a => a.phase === phase)
    .sort((a, b) => a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const position = ordered.findIndex(a => a.id === assignmentId);
  return position >= 0 ? position + 1 : 1;
}

export class HandoffService {
  constructor(private admissions: AdmissionService, private catalog: CatalogService, private router: RepositoryRouter, private sources: SourceRecords, private sessions: () => Session[], private assertAvailable: () => void, private ownerId: string, private resolveRecipient: (to: string, checkout: string) => Promise<{ harness: HandoffRecipient["harness"]; executionConfig: HandoffExecutionConfig }>) {}
  private async caller(envelope: unknown) {
    const classified = classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(envelope) });
    if (classified.actorKind !== "native") throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Qualified sender required.");
    const e = classified.envelope, source = normalizeNativeSource(e.source);
    if (source.authorityId !== e.authorityId) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Sender authority changed.");
    const discovery = discoverRepository(e.repository);
    if (discovery.primaryCheckout !== e.repository) throw new DomainError("INVALID_CONTEXT", "Canonical repository authority required.");
    const matches = (await this.catalog.list()).workspaces.filter(w => w.kind === "repository" && w.commonDir === discovery.commonDir);
    if (matches.length !== 1) throw new DomainError("INVALID_CONTEXT", "Repository must be registered in the running App.");
    const adapter = await this.router.forWorkspace(matches[0]!.workspaceId);
    const ref: ConversationRef = { harness: e.source.harness, authorityId: e.authorityId, nativeId: e.nativeId };
    return { adapter, ref, context: adapter.domain.resolveContext(ref) };
  }
  async enqueue(envelope: unknown, input: unknown): Promise<Handoff> {
    const args = handoffInput(input), { adapter, ref, context } = await this.caller(envelope), domain = adapter.domain;
    const old = domain.findHandoff(ref, args.requestId);
    if (old) {
      if (JSON.stringify(old.input) !== JSON.stringify(args)) throw new DomainError("CONFLICT", "Request ID is already bound to another handoff payload.");
      return old;
    }
    // Kickoff: sender without a workstream creates one (idempotent per requestId) and never joins it.
    const workstream = args.kickoff ? (this.assertAvailable(), domain.kickoffWorkstream(ref, args)) : context.workstream;
    if (!workstream) throw new DomainError("INVALID_CONTEXT", "Sender has no workstream.");
    let recipient: HandoffRecipient;
    if (args.createNew) {
      const checkout = args.checkout ? domain.validateExecutionCheckout(args.checkout) : workstream.defaultCheckout;
      if (!checkout) throw new DomainError("INVALID_CHECKOUT", "New recipient requires an explicit checkout or workstream default.");
      revalidateCheckout(domain.context, checkout);
      const resolved = await this.resolveRecipient(args.to, checkout.path);
      const source = normalizeNativeSource(this.sources[resolved.harness].descriptor);
      if (source.authorityId !== this.sources[resolved.harness].authorityId) throw new DomainError("SOURCE_UNAVAILABLE", "Recipient source requires configuration refresh.");
      recipient = { ownerId: this.ownerId, sessionId: crypto.randomUUID(), ref: null, ...resolved, authorityId: source.authorityId, checkout };
    } else {
      const linked = domain.getStatus(workstream.id).activePhases.filter(a => a.phase === args.to);
      const candidates = this.admissions.list().filter(a => a.state === "ready" && a.nativeId && a.binding.domain.mode === "repository" && a.binding.domain.repositoryId === domain.repositoryId && this.sessions().some(s => s.sessionId === a.sessionId && s.attachment?.state !== "pending")).filter(a => linked.some(l => same(l.ref, { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! })));
      const selected = args.target ? candidates.filter(a => same(args.target!, { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! })) : candidates;
      if (selected.length !== 1) throw new DomainError(selected.length > 1 ? "AMBIGUOUS_TARGET" : "NOT_FOUND", selected.length > 1 ? "Several linked App recipients are eligible; select an exact qualified target." : "No linked App-managed or attached recipient is eligible; select or explicitly create one.");
      const admission = selected[0]!;
      await this.router.execution(admission);
      const target = { harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId! };
      recipient = { ownerId: this.ownerId, sessionId: admission.sessionId, ref: target, harness: target.harness, authorityId: target.authorityId, checkout: domain.getConversation(target)!.executionCheckout };
    }
    this.assertAvailable();
    return domain.admitHandoff(ref, args, recipient, { actor: { kind: "native", repositoryId: domain.repositoryId, ref }, correlationId: args.requestId });
  }
  async status(envelope: unknown, requestId: string) {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new DomainError("INVALID_INPUT", "Request ID required.");
    const { adapter, ref } = await this.caller(envelope);
    return adapter.domain.findHandoff(ref, requestId);
  }
  async list(workspaceId: string) { return (await this.router.forWorkspace(workspaceId)).domain.listHandoffs(); }
  async prepareRecipient(workspaceId: string, handoffId: string, create: (handoff: Handoff) => Promise<void>) {
    const domain = (await this.router.forWorkspace(workspaceId)).domain, h = domain.getHandoff(handoffId);
    this.assertAvailable();
    if (h.recipient.ownerId !== this.ownerId) throw new WorkstreamAdapterError(409, "handoff-owner-mismatch", "Delivery belongs to another App store");
    if (h.status !== "queued") throw new WorkstreamAdapterError(409, "handoff-not-queued", "Delivery is not queued");
    revalidateCheckout(domain.context, h.recipient.checkout);
    if (!h.recipient.ref) {
      await create(h);
      const admission = this.admissions.get(h.recipient.sessionId);
      if (!admission || admission.state !== "ready" || !admission.nativeId) throw new WorkstreamAdapterError(409, "admission-pending", "Recipient admission requires reconciliation");
      await this.router.execution(admission);
      const ref = { harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId };
      if (ref.harness !== h.recipient.harness || ref.authorityId !== h.recipient.authorityId || admission.binding.executionCheckout !== h.recipient.checkout.path) throw new DomainError("CONFLICT", "Recipient admission differs from queued request.");
      const conversation = domain.getConversation(ref)!;
      if (conversation.workstreamId && conversation.workstreamId !== h.workstreamId) throw new DomainError("CONFLICT", "Recipient membership changed.");
      if (!conversation.workstreamId) domain.associateConversation(ref, h.workstreamId, system(h.id));
      domain.assignPhase(ref, h.input.to, system(h.id));
      return domain.bindHandoffRecipient(h.id, ref, h.revision, system(h.id));
    }
    const admission = this.admissions.get(h.recipient.sessionId);
    if (!admission || !admission.nativeId || !same(h.recipient.ref, { harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId })) throw new DomainError("CONFLICT", "Recipient admission changed.");
    await this.router.execution(admission);
    return h;
  }
}
