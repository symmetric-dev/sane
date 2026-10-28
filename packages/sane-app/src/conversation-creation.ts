import type { AdmissionService } from "./admission";
import type { Admission } from "./app-store";
import type { NativeHarness } from "./harness-names";
import { WorkstreamAdapterError } from "./workstreams";

export type NativeConversationCreation =
  | { readonly harness: NativeHarness; readonly kind: "allocated"; readonly allocate: () => string }
  | { readonly harness: NativeHarness; readonly kind: "created"; readonly create: () => Promise<string> };

/** Create-only pre-prompt sequencing, not attachment, branching, or general retry.
 * Callers prepare their workflow before entering here; allocation happens only
 * when beginning admission. Source, checkout, and binding checks stay with
 * AdmissionService, and native allocation/creation stays with the native owner.
 * There is deliberately no model-prompt port.
 */
export function beginConversationCreation(
  admissions: Pick<AdmissionService, "begin"> & Partial<Pick<AdmissionService, "beginGrokCreate">>,
  input: Omit<Parameters<AdmissionService["begin"]>[0], "operation" | "harness" | "nativeId">,
  native: NativeConversationCreation,
): Promise<Admission> {
  if (native.harness === "gk") {
    if (native.kind !== "allocated") throw new WorkstreamAdapterError(409, "invalid-native-creation", "Grok creation requires a caller-allocated UUID; no other native adapter may create it");
    if (!admissions.beginGrokCreate) throw new WorkstreamAdapterError(409, "grok-admission-unavailable", "Grok creation requires its qualified admission service");
    return admissions.beginGrokCreate({ ...input, nativeId: native.allocate(), deferReady: true });
  }
  return admissions.begin({
    ...input,
    operation: "create",
    harness: native.harness,
    nativeId: native.kind === "allocated" ? native.allocate() : null,
  });
}

/** Finish the bounded create sequence using the caller's already-known admission.
 * AdmissionService owns the unknown-before-native transition; uncertainty is
 * never permission to recreate. Known identities never allocate or create again.
 * The caller owns publication guards and metadata/worker/catalog ordering,
 * including skipping existing handoff metadata while still associating it.
 * Registration retains its existing checks; no new post-publication checks or
 * reply refresh are introduced here.
 */
export async function completeConversationCreation<T>(
  admissions: Pick<AdmissionService, "createNative" | "register" | "ready">,
  admission: Admission,
  native: NativeConversationCreation,
  publish: (admission: Admission) => Promise<T>,
): Promise<{ admission: Admission; value: T }> {
  let a = admission;
  if (a.state === "intent") {
    if (native.kind === "allocated") {
      throw new WorkstreamAdapterError(409, "native-creation-not-retryable", "Native creation may already have occurred; inspect native state, never blindly recreate");
    }
    a = await admissions.createNative(a.sessionId, native.create);
  }
  if (!a.nativeId || a.state === "native_creation_unknown") {
    throw new WorkstreamAdapterError(409, "native_creation_unknown", "Reconcile recipient creation before retry");
  }
  const value = await publish(a);
  await admissions.register(a.sessionId);
  if (a.state !== "ready") admissions.ready(a.sessionId);
  return { admission: a, value };
}
