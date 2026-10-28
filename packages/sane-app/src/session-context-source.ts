import { saneSessionText, sha256 } from "./agent-launch";
import type { Admission } from "./app-store";
import type { ContextMessageBinding, ContextMessageFragment } from "./context-message";
import type { Session } from "./history";
import { canonicalJSON } from "./prepared-input-codec";
import type { CatalogService } from "./catalog";
import { WorkstreamAdapterError, type ResolvedExecutionContext } from "./workstreams";

export type ContextBinding = (session: Session) => ContextMessageBinding;
export type SessionMessageSource = Readonly<{ fragment: ContextMessageFragment; check: () => void }>;
export type SessionContextSourcePorts = {
  storeId: string;
  resolveExecution: (sessionId: string) => Promise<ResolvedExecutionContext & { admission: Admission }>;
  catalog: Pick<CatalogService, "assertBinding">;
};

/** Reads admitted roots and retains their synchronous submission-time check. */
export function createSessionMessageSource({ storeId, resolveExecution, catalog }: SessionContextSourcePorts) {
  return async function sessionMessageSource(session: Session, assertCurrent: () => void): Promise<SessionMessageSource> {
    assertCurrent();
    const { admission, roots, domain } = await resolveExecution(session.sessionId);
    assertCurrent();
    const ref = { harness: admission.source.descriptor.harness, authorityId: admission.source.authorityId, nativeId: admission.nativeId! };
    const currentRoots = () => {
      catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId, admission.binding.executionCheckout, admission.binding.bindingRevision);
      if (!domain) return { workstreamId: null, artifactsRoot: null, executionCheckout: admission.binding.executionCheckout };
      const current = domain.resolveContext(ref);
      return { workstreamId: current.workstream?.id ?? null, artifactsRoot: current.artifactsRoot, executionCheckout: current.executionCheckout };
    };
    const pin = canonicalJSON({ admission: admission.binding, roots });
    const check = () => {
      assertCurrent();
      if (canonicalJSON({ admission: admission.binding, roots: currentRoots() }) !== pin) throw new WorkstreamAdapterError(409, "context-source-changed", "Session roots or workstream membership changed before submission");
    };
    check();
    const fragment: ContextMessageFragment = { id: "session", category: "session",
      text: saneSessionText(session, roots) ?? `# SANE Session\n\nWorkstream: none\nImplementation root: ${roots.executionCheckout}`,
      source: `app:${storeId}/admission:${admission.requestId}/session-roots`, revision: sha256(pin), reason: "Explicit lifecycle Session selection from admitted workstream roots" };
    return { fragment, check };
  };
}
