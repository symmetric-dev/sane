import { isStoredAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { CanonicalExecutionRef, CanonicalExecutionSnapshot } from "./canonical-execution-store";
import type { ContextPackage, ContextPackageRef } from "./context-package";
import type { SaneSessionContext } from "./history";

export type CanonicalActivation = { saneExecution: CanonicalExecutionRef; saneContext: SaneSessionContext };

/** Loaders must retain their store's file/path and pinned-byte integrity checks.
 * These small interfaces do not import a store implementation at runtime. */
export type CanonicalExecutionLoader = { load: (ref: CanonicalExecutionRef) => Promise<CanonicalExecutionSnapshot> };
export type CanonicalContextLoader = { load: (ref: ContextPackageRef) => Promise<{ bundle: ContextPackage }> };
export type CanonicalActivationLoaders = { execution: CanonicalExecutionLoader; context: CanonicalContextLoader };

/** Caller-owned source/binding, ownership and cancellation assertions. Invoked
 * before and after loader awaits; assertions may themselves be asynchronous.
 * This is a dispatch-time check, not an execution-time lease for queued input. */
export type CanonicalValidationGuards = { assertCurrent: () => void | Promise<void> };

const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function assertIdentity(identity: StoredSaneAgentIdentity): void {
  if (!identity || (identity.kind === "assistant" ? !isStoredAssistantAgentId(identity.role) : identity.kind !== "worker" || !isWorkerAgentId(identity.role))) throw new Error("Canonical execution requires a valid identity");
}

async function guardedLoad<T>(load: () => Promise<T>, guards?: CanonicalValidationGuards): Promise<T> {
  if (guards) await guards.assertCurrent();
  const result = await load();
  if (guards) await guards.assertCurrent();
  return result;
}

/** Execution-policy-only validation for a trusted pinned ref and role identity.
 * No context loader or context assets are used. It preserves the complete pinned
 * native-child, model and permission policies for the existing harness adapters.
 *
 * The store owns pinned-byte integrity and the authored policy representation;
 * do not re-hash or re-parse its typed snapshot here. This checks the selected
 * role, not historical activation delivery. Explicit context-bearing dispatch
 * still validates its selected context. No mutable decisions are cached here. */
export async function validateCanonicalExecution(ref: CanonicalExecutionRef, identity: StoredSaneAgentIdentity, store: CanonicalExecutionLoader, guards?: CanonicalValidationGuards): Promise<CanonicalExecutionSnapshot> {
  assertIdentity(identity);
  if (!ref || ref.schema !== 1 || !revision(ref.revision)) throw new Error("Invalid canonical execution reference");
  // Copy pins before the first await; caller mutation cannot select another load.
  const pin = { schema: 1 as const, revision: ref.revision }, name = `sane/${identity.kind}/${identity.role}`;
  const execution = await guardedLoad(() => store.load(pin), guards);
  if (execution.policy.spec.name !== name) throw new Error("Canonical execution role differs from its trusted identity");
  return execution;
}

/** Paired validation for an explicit context-bearing activation. Ordinary
 * body-only continuation does not need to prove historical activation delivery. */
export async function validateCanonicalActivation(pair: CanonicalActivation, identity: StoredSaneAgentIdentity, stores: CanonicalActivationLoaders, guards?: CanonicalValidationGuards): Promise<CanonicalExecutionSnapshot> {
  if (!pair.saneContext?.package || !pair.saneExecution || pair.saneExecution.schema !== 1) throw new Error("Canonical activation requires paired context and execution references");
  assertIdentity(identity);
  const trustedIdentity = { ...identity }, contextRef = { ...pair.saneContext.package };
  if (contextRef.schema !== 1 || !revision(contextRef.revision) || contextRef.delivery !== "standing-native-role" || contextRef.activation !== undefined && contextRef.activation !== "upgrade") throw new Error("Invalid context package reference");
  const [execution, context] = await Promise.all([
    validateCanonicalExecution(pair.saneExecution, trustedIdentity, stores.execution, guards),
    guardedLoad(() => stores.context.load(contextRef), guards),
  ]);
  const role = context.bundle.assets.find(asset => asset.kind === "role");
  if (context.bundle.revision !== contextRef.revision || context.bundle.identity.kind !== trustedIdentity.kind || context.bundle.identity.role !== trustedIdentity.role || !role || execution.policy.spec.body !== role.text) throw new Error("Canonical activation context and execution role bytes differ");
  if (guards) await guards.assertCurrent();
  return execution;
}
