import { createHash } from "node:crypto";
import { isStoredAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { CanonicalExecutionRef, CanonicalExecutionSnapshot } from "./canonical-execution-store";
import type { CanonicalAgentOperations } from "./canonical-agent-operations";
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

const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const temperature = (value: unknown) => value === undefined || typeof value === "number" && Number.isFinite(value);

function assertIdentity(identity: StoredSaneAgentIdentity): void {
  if (!identity || (identity.kind === "assistant" ? !isStoredAssistantAgentId(identity.role) : identity.kind !== "worker" || !isWorkerAgentId(identity.role))) throw new Error("Canonical execution requires a valid identity");
}

/** Validate the stored representation, without rebuilding policy from today's
 * authored files or translating permissions/models for a particular harness. */
function assertPolicy(value: unknown): asserts value is CanonicalAgentOperations {
  const fail = (): never => { throw new Error("Invalid canonical execution policy"); };
  if (!mapping(value) || value.schema !== 1 || !mapping(value.source) || typeof value.source.markdown !== "string" || !mapping(value.spec) || !Array.isArray(value.permissions) || !temperature(value.temperature)) fail();
  const policy = value as CanonicalAgentOperations, spec = policy.spec;
  const match = typeof spec.name === "string" ? /^sane\/(assistant|worker)\/([a-z][a-z-]*)$/.exec(spec.name) : null;
  if (!match || spec.kind !== match[1] || spec.shortId !== (spec.kind === "assistant" ? match[2] : spec.name)
    || typeof spec.description !== "string" || typeof spec.body !== "string" || !temperature(spec.temperature)
    || !mapping(spec.ccPermissions) || !strings(spec.ccPermissions.allow) || !strings(spec.ccPermissions.ask) || !strings(spec.ccPermissions.deny)) fail();
  for (const rule of policy.permissions) {
    if (!mapping(rule) || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "ask", "deny"].includes(rule.effect)) fail();
  }
  if (policy.model !== undefined && (!mapping(policy.model) || typeof policy.model.providerID !== "string" || !/^[^/\s#]+$/.test(policy.model.providerID)
    || typeof policy.model.id !== "string" || !/^[^\s#]+$/.test(policy.model.id)
    || policy.model.variant !== undefined && (typeof policy.model.variant !== "string" || !/^[^\s#]+$/.test(policy.model.variant)))) fail();
  const override = policy.source.modelOverride;
  if (override !== undefined && typeof override !== "string" && (!mapping(override) || typeof override.model !== "string" || override.variant !== undefined && typeof override.variant !== "string")) fail();
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
 * This CANNOT establish context/execution pairing or activation delivery. An
 * ordinary new-engine dispatch may use it only after the caller has verified
 * appropriate durable activation/pairing evidence for its exact session binding.
 * Context-bearing dispatch still needs full paired/selected-context validation.
 * No mutable binding or permission decisions are cached here. */
export async function validateCanonicalExecution(ref: CanonicalExecutionRef, identity: StoredSaneAgentIdentity, store: CanonicalExecutionLoader, guards?: CanonicalValidationGuards): Promise<CanonicalExecutionSnapshot> {
  assertIdentity(identity);
  if (!ref || ref.schema !== 1 || !revision(ref.revision)) throw new Error("Invalid canonical execution reference");
  // Copy pins before the first await; caller mutation cannot select another load.
  const pin = { schema: 1 as const, revision: ref.revision }, name = `sane/${identity.kind}/${identity.role}`;
  const execution = await guardedLoad(() => store.load(pin), guards);
  if (!execution || execution.schema !== 1 || !Array.isArray(execution.children) || execution.revision !== pin.revision) throw new Error("Canonical execution snapshot changed");
  assertPolicy(execution.policy);
  if (execution.policy.spec.name !== name) throw new Error("Canonical execution role differs from its trusted identity");
  const names = new Set<string>();
  for (const child of execution.children) {
    assertPolicy(child);
    if (child.spec.kind !== "worker" || names.has(child.spec.name)) throw new Error("Invalid canonical native child policy");
    names.add(child.spec.name);
  }
  const body = { schema: execution.schema, policy: execution.policy, children: execution.children };
  if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== pin.revision) throw new Error("Canonical execution snapshot changed");
  return execution;
}

/** Full paired activation validation. Existing CC/OC callers keep using this,
 * including ordinary sends, until bridge integration is explicitly changed. */
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
