import { contextHash, validateContextDelivery, type ContextDelivery } from "./context-package";
import type { Event, Run, Session } from "./history";

/** validate must load trusted pinned inputs independently of the supplied delivery
 * and call validateContextComposition (or an equivalent trusted attestation).
 * Optional in the type for migration compatibility; mandatory for dispatch. */
export type ContextProvider = ((sessionId: string) => Promise<ContextDelivery | null>) & {
  validate?: (delivery: ContextDelivery) => Promise<void> | void;
};
export type ContextEmitter = (run: Run, kind: Event["kind"], data: unknown) => Promise<void>;

async function validateProvided(delivery: ContextDelivery, provider: ContextProvider) {
  validateContextDelivery(delivery);
  if (!provider.validate) throw new Error("Trusted canonical context composition validator is unavailable");
  // Validation code cannot change the bytes being dispatched.
  await provider.validate(structuredClone(delivery));
}

export async function prepareContextDelivery(session: Session, run: Run, provider: ContextProvider | undefined, emit: ContextEmitter, guard: () => void): Promise<ContextDelivery | null> {
  if (!session.saneContext?.package) return null;
  if (!provider) throw new Error("Canonical context provider is unavailable");
  guard();
  const provided = await provider(session.sessionId);
  const delivery = provided && structuredClone(provided);
  guard();
  if (delivery) await validateProvided(delivery, provider);
  guard();
  if (!delivery || run.sessionId !== session.sessionId || delivery.binding.sessionId !== run.sessionId || delivery.binding.nativeSessionId !== session.nativeSessionId
    || delivery.binding.authorityId !== session.authorityId || delivery.binding.harness !== session.harness || delivery.binding.cwd !== run.cwd
    || delivery.packageRevision !== session.saneContext.package.revision) throw new Error("Canonical context delivery binding mismatch");
  // Persist exact bytes and provenance before any native mutation. A receipt is
  // a separate event: prepared text is not evidence of native consumption.
  await emit(run, "context", { type: "canonical-context", stage: "prepared", delivery: structuredClone(delivery) });
  guard();
  return delivery;
}

export async function assertContextCurrent(delivery: ContextDelivery | null, provider: ContextProvider | undefined, guard: () => void) {
  if (!delivery) return;
  validateContextDelivery(delivery);
  if (!provider) throw new Error("Canonical context provider is unavailable");
  guard();
  const provided = await provider(delivery.binding.sessionId);
  const current = provided && structuredClone(provided);
  guard();
  if (current) await validateProvided(current, provider);
  guard();
  if (!current || current.payloadHash !== delivery.payloadHash || current.packageRevision !== delivery.packageRevision
    || Object.keys(delivery.binding).some(key => current.binding[key as keyof typeof current.binding] !== delivery.binding[key as keyof typeof delivery.binding])
    || JSON.stringify(current.segments) !== JSON.stringify(delivery.segments)) throw new Error("Context dependencies changed before dispatch; prompt withheld");
}

export function contextReceipt(delivery: ContextDelivery, stage: "configured" | "stored-readback", channel: string) {
  validateContextDelivery(delivery);
  return { type: "canonical-context", stage, channel, binding: { ...delivery.binding }, packageRevision: delivery.packageRevision,
    staticHash: delivery.staticHash, dynamicHash: delivery.dynamicHash, payloadHash: delivery.payloadHash,
    provenanceHash: contextHash(JSON.stringify(delivery.segments)) };
}
