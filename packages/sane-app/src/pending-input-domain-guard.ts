import type { ConversationRef, RepositoryDiscovery } from "sane-core/contracts";
import type { RepositoryDomain } from "sane-core/server";
import type { PendingInputConversation, PendingInputPins } from "./pending-input-contract";
import { equal } from "./prepared-input-codec";
import { WorkstreamAdapterError, type WorkstreamMutation } from "./workstreams";

const sameRef = (a: ConversationRef, b: ConversationRef) => a.harness === b.harness && a.authorityId === b.authorityId && a.nativeId === b.nativeId;
const conflict = () => { throw new WorkstreamAdapterError(409, "pending-input-chain-active", "An affected durable input chain is active; remove waiting input before changing its domain pins"); };

/** Occupancy only: no claims, authorization, wakeups or pin rewriting. */
export function chainInRepository(pins: PendingInputPins, scope: { workspaceId?: string; repositoryId?: string; commonDir: string; roots: readonly string[] }) {
  return pins.catalog.workspaceId === scope.workspaceId
    || scope.repositoryId !== undefined && pins.context?.conversation.repositoryId === scope.repositoryId
    || pins.admission.binding.checkoutPin?.commonDir === scope.commonDir
    || scope.roots.includes(pins.catalog.cwd);
}

export function assertDomainInitializationIdle(records: readonly PendingInputConversation[], workspaceId: string, discovery: RepositoryDiscovery) {
  if (records.some(c => c.chain && chainInRepository(c.chain.pins, { workspaceId, commonDir: discovery.commonDir, roots: [discovery.primaryCheckout, discovery.invocationCheckout.path] }))) conflict();
}

export function assertPendingInputDomainMutation(records: readonly PendingInputConversation[], domain: RepositoryDomain, input: WorkstreamMutation) {
  if (input.kind === "create") return; // New workstreams do not rewrite existing pins.
  // End authority comes from the assignment, NEVER a supplied App session/ref.
  const assignment = input.kind === "phase/end" ? domain.listWorkstreams().flatMap(w => {
    const status = domain.getWorkstreamStatus(w.id); return [...status.activePhases, ...status.phaseHistory];
  }).find(a => a.id === input.assignmentId) : undefined;
  const ref = "ref" in input ? input.ref : assignment?.ref;
  const conversation = ref ? domain.getConversation(ref) : null;
  const checkout = input.kind === "default-checkout" && input.checkout !== null ? domain.validateExecutionCheckout(input.checkout) : null;
  const scope = { repositoryId: domain.repositoryId, commonDir: domain.context.commonDir, roots: [domain.primaryCheckout, domain.context.invocationCheckout.path] };
  if (input.kind === "default-checkout" && equal(domain.getWorkstream(input.workstreamId).defaultCheckout, checkout)) return;
  for (const record of records) {
    const pins = record.chain?.pins, context = pins?.context;
    if (!pins || !chainInRepository(pins, scope)) continue;
    const capturedRef = context?.conversation.ref ?? (pins.admission.nativeId ? {
      harness: pins.admission.source.descriptor.harness, authorityId: pins.admission.source.authorityId, nativeId: pins.admission.nativeId,
    } : null);
    if (input.kind === "default-checkout") {
      if (context?.membership?.workstreamId === input.workstreamId || context?.workstream?.id === input.workstreamId
        || capturedRef && domain.getConversation(capturedRef)?.workstreamId === input.workstreamId) conflict();
    } else if ((conversation && context?.conversation.id === conversation.id) || (ref && capturedRef && sameRef(capturedRef, ref))
      || (input.kind === "phase/end" && context?.assignments.some(a => a.id === input.assignmentId))) conflict();
  }
}
