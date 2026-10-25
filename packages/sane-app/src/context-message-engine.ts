import type { StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { CanonicalExecutionRef } from "./canonical-execution-store";
import { validateCanonicalExecution, type CanonicalExecutionLoader } from "./canonical-activation-validation";
import { composeContextMessage, decodeContextMessage, validateTrustedContextMessage, type ContextMessage, type ContextMessageBinding, type ContextMessageInput } from "./context-message";

/** Inactive preparation seam. No transport, journal writer, queue, or activation
 * registry lives here. Callers choose placement from lifecycle intent, NEVER
 * from resume/process/revision changes or serialized composition metadata. */
export type ContextMessageGuards = Readonly<{
  assertOwnership: () => void | Promise<void>;
  assertSource: () => void | Promise<void>;
  assertNotCancelled: () => void | Promise<void>;
}>;
export type OrdinaryContextMessageInput = Extract<ContextMessageInput, { placement: { kind: "body-only" } }>;
export type SelectedContextMessageInput = Exclude<ContextMessageInput, OrdinaryContextMessageInput>;
type Validation = (message: ContextMessage, guards: ContextMessageGuards) => void | Promise<void>;

export type ContextMessagePreparation = Readonly<{ guards: ContextMessageGuards }> & (
  | Readonly<{
    kind: "ordinary";
    /** Mandatory fresh independent authored body, source and placement read.
     * This reader must not call a context/package provider, even for SANE input. */
    readCurrentOrdinary: () => OrdinaryContextMessageInput | Promise<OrdinaryContextMessageInput>;
    policy: Readonly<{ kind: "base" }> | Readonly<{
      kind: "sane";
      validateExecution: Validation;
      /** Required owner-owned durable activation AND context/execution pairing
       * check for this exact binding. Execution-only validation cannot prove it.
       * Missing/uncertain history must refuse; it does not mean fresh session. */
      assertDurableActivationPairing: Validation;
    }>;
  }>
  | Readonly<{
    kind: "context";
    /** Rebuild independently selected intent, pinned verified package files and
     * dynamic state. Do not derive the selection/body from the candidate message.
     * Package loaders retain their own path and pinned-byte integrity checks. */
    readCurrentContext: () => SelectedContextMessageInput | Promise<SelectedContextMessageInput>;
    /** Checks selected pinned sources and execution/context pairing as applicable.
     * Required even for fragment-only updates; no silent context trust bypass. */
    validateSelectedContext: (input: SelectedContextMessageInput, guards: ContextMessageGuards) => void | Promise<void>;
  }>
);

export async function assertContextMessageGuards(guards: ContextMessageGuards): Promise<void> {
  await guards.assertOwnership();
  await guards.assertSource();
  await guards.assertNotCancelled();
}

async function guarded<T>(guards: ContextMessageGuards, read: () => T | Promise<T>): Promise<T> {
  await assertContextMessageGuards(guards);
  const value = await read();
  await assertContextMessageGuards(guards);
  return value;
}

/** Prepare from independently supplied trusted inputs, then immediately refresh
 * those dependencies. The result is immutable composition, NOT submission proof.
 * Revalidate again after journal/admission awaits and immediately before send. */
export async function prepareContextMessage(input: ContextMessageInput, preparation: ContextMessagePreparation): Promise<ContextMessage> {
  const trusted = structuredClone(input);
  await assertContextMessageGuards(preparation.guards);
  const message = composeContextMessage(trusted);
  return assertContextMessageCurrent(message, preparation);
}

/** Reject any changed body, binding, placement, ordered selection, provenance,
 * package revision or bytes. Validates twice around policy checks: asynchronous
 * validation must not leave the earlier dependency snapshot as the final read.
 * Nothing here grants an execution-time lease. The owner must also use its
 * synchronous final source/ownership/cancellation gate at beforeNative, and
 * revalidate after any intervening awaits (including queue waits).
 *
 * Ordinary input cannot reach a context reader or paired validator through this
 * API. Injected ordinary callbacks must uphold the same no-context-read contract.
 * Base input has no SANE activation requirement. */
export async function assertContextMessageCurrent(value: unknown, preparation: ContextMessagePreparation): Promise<ContextMessage> {
  const { guards } = preparation;
  await assertContextMessageGuards(guards);
  const message = decodeContextMessage(value);
  if ((message.placement.kind === "body-only") !== (preparation.kind === "ordinary")) throw new Error("Context message preparation path differs from explicit placement");
  if (preparation.kind === "ordinary") {
    const refresh = async () => {
      const input = await guarded(guards, async () => {
        const current = await preparation.readCurrentOrdinary();
        if (current.placement.kind !== "body-only") throw new Error("Ordinary validation must not select context");
        return composeContextMessage(current);
      });
      // Compose inside the guarded read to snapshot mutable provider results.
      const expected: OrdinaryContextMessageInput = { body: input.body.text, binding: input.binding, origin: input.origin, placement: { ...input.placement, kind: "body-only" } };
      return validateTrustedContextMessage(message, expected);
    };
    await refresh();
    if (preparation.policy.kind === "sane") {
      const policy = preparation.policy;
      await guarded(guards, () => policy.assertDurableActivationPairing(message, guards));
      await guarded(guards, () => policy.validateExecution(message, guards));
      await guarded(guards, () => policy.assertDurableActivationPairing(message, guards));
    }
    await refresh();
  } else {
    const refresh = async () => {
      const input = await guarded(guards, async () => {
        const current = structuredClone(await preparation.readCurrentContext());
        if (!["bootstrap", "selected"].includes(current.placement.kind)) throw new Error("Context validation requires explicit selected context");
        validateTrustedContextMessage(message, current);
        return current;
      });
      await guarded(guards, () => preparation.validateSelectedContext(input, guards));
    };
    await refresh();
    await refresh();
    // A validator can await: finish with an independent source read, not its
    // pre-validation snapshot. Source/version gates must cover later native I/O.
    await guarded(guards, async () => validateTrustedContextMessage(message, await preparation.readCurrentContext()));
  }
  await assertContextMessageGuards(guards);
  return message;
}

/** Concrete execution-only policy adapter for the ordinary SANE fast path.
 * Trusted pins/identity come from live owner state, not composition metadata.
 * Deliberately accepts NO context loader. The separate required durable-pairing
 * callback still belongs to the lifecycle owner. */
export function canonicalContextMessageExecutionValidator(dependencies: Readonly<{
  readTrustedExecution: (binding: ContextMessageBinding) => Readonly<{ ref: CanonicalExecutionRef; identity: StoredSaneAgentIdentity }> | Promise<Readonly<{ ref: CanonicalExecutionRef; identity: StoredSaneAgentIdentity }>>;
  execution: CanonicalExecutionLoader;
}>): Validation {
  return async (message, guards) => {
    const trusted = await guarded(guards, async () => structuredClone(await dependencies.readTrustedExecution(message.binding)));
    await validateCanonicalExecution(trusted.ref, trusted.identity, dependencies.execution, { assertCurrent: () => assertContextMessageGuards(guards) });
    const current = await guarded(guards, async () => structuredClone(await dependencies.readTrustedExecution(message.binding)));
    if (current.ref.schema !== trusted.ref.schema || current.ref.revision !== trusted.ref.revision
      || current.identity.kind !== trusted.identity.kind || current.identity.role !== trusted.identity.role) throw new Error("Canonical execution selection changed before dispatch");
  };
}
