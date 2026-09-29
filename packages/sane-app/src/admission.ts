import { normalizeNativeSource, discoverRepository, revalidateCheckout } from "sane-core/server";
import type { ConversationRef } from "sane-core/contracts";
import { atomicAppRecord, validateAdmissions, type Admission, type AdmissionRecords, type SourceRecords } from "./app-store";
import type { CatalogService } from "./catalog";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";

/** Serialized by the bridge admission gate. All writes are synchronous durable publication. */
export class AdmissionService {
  private records: AdmissionRecords;
  constructor(private dataDir: string, initial: AdmissionRecords, private sources: SourceRecords, private catalog: CatalogService, private router: RepositoryRouter, private save = atomicAppRecord) { this.records = structuredClone(validateAdmissions(initial)); }
  get(sessionId: string): Admission | undefined { const a = this.records.admissions.find(a => a.sessionId === sessionId); return a && structuredClone(a); }
  list(): Admission[] { return structuredClone(this.records.admissions); }
  private persist(next: AdmissionRecords) { validateAdmissions(next); this.save(this.dataDir, "admissions.json", next); this.records = next; }
  private update(sessionId: string, change: Partial<Admission>) {
    const next = structuredClone(this.records), a = next.admissions.find(a => a.sessionId === sessionId);
    if (!a) throw new WorkstreamAdapterError(404, "admission-missing", "Unknown admission");
    Object.assign(a, change); this.persist(next); return structuredClone(a);
  }
  async begin(input: { sessionId: string; operation: "create" | "attach"; harness: "cc" | "oc"; cwd: string; workspaceId: string; worktreeId: string; nativeId: string | null; parent?: ConversationRef | null }) {
    if (this.get(input.sessionId)) throw new WorkstreamAdapterError(409, "admission-exists", "Use explicit same-identity admission retry");
    const configured = this.sources[input.harness], source = normalizeNativeSource(configured.descriptor);
    if (configured.authorityId !== source.authorityId) throw new WorkstreamAdapterError(409, "source-unavailable", "Native source requires explicit configuration refresh");
    const binding = await this.catalog.binding(input.workspaceId, input.worktreeId);
    if (binding.cwd !== input.cwd) throw new WorkstreamAdapterError(409, "execution-mismatch", "Use the canonical selected execution root");
    const workspace = await this.catalog.get(input.workspaceId);
    let domain: Admission["binding"]["domain"] = { mode: "app-only" }, checkoutPin: Admission["binding"]["checkoutPin"] = null;
    if (workspace.kind === "repository") {
      const inspected = await this.router.inspect(input.workspaceId);
      if (inspected.state !== "ready" && inspected.state !== "uninitialized") throw new WorkstreamAdapterError(409, inspected.code, inspected.message);
      checkoutPin = discoverRepository(input.cwd).invocationCheckout;
      if (inspected.state === "ready") { domain = { mode: "repository", repositoryId: inspected.context.repositoryId, primaryCheckout: inspected.context.primaryCheckout }; revalidateCheckout(inspected.context, checkoutPin); }
    }
    if (input.parent && domain.mode !== "repository") throw new WorkstreamAdapterError(409, "parent-domain-required", "Parents require repository registration");
    const a: Admission = { version: 1, requestId: crypto.randomUUID(), sessionId: input.sessionId, operation: input.operation, state: input.nativeId === null ? "intent" : "identity_known", source, binding: { workspaceId: input.workspaceId, worktreeId: input.worktreeId, bindingRevision: binding.bindingRevision, executionCheckout: input.cwd, checkoutPin, domain }, nativeId: input.nativeId, parent: input.parent ?? null, createdAt: new Date().toISOString(), error: null };
    this.persist({ version: 1, admissions: [...this.records.admissions, a] }); return structuredClone(a);
  }
  async createNative(sessionId: string, create: () => Promise<string>) {
    const a = this.get(sessionId);
    if (!a || a.state !== "intent" || a.nativeId !== null) throw new WorkstreamAdapterError(409, "native-creation-not-retryable", "Native creation may already have occurred; inspect native state, never blindly recreate");
    // Unknown BEFORE the request means a crash or lost response is never replayed.
    this.update(sessionId, { state: "native_creation_unknown" });
    const nativeId = await create();
    return this.update(sessionId, { nativeId, state: "identity_known" });
  }
  async register(sessionId: string) {
    const a = this.get(sessionId);
    if (!a || !a.nativeId || !["identity_known", "ready"].includes(a.state)) throw new WorkstreamAdapterError(409, "admission-pending", "Known native identity required for explicit retry");
    const source = normalizeNativeSource(a.source.descriptor);
    if (source.authorityId !== a.source.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Source identity changed");
    const b = a.binding, binding = await this.catalog.binding(b.workspaceId, b.worktreeId);
    if (binding.cwd !== b.executionCheckout || binding.bindingRevision !== b.bindingRevision) throw new WorkstreamAdapterError(409, "execution-mismatch", "Execution binding changed");
    const adapter = await this.router.forAdmission(a);
    if (adapter) {
      revalidateCheckout(adapter.domain.context, b.checkoutPin!);
      // Core retry is identity/pin/parent-only: it never reapplies membership or phases.
      adapter.register({ sessionId, harness: a.source.descriptor.harness === "cc" ? "claude-code" : "opencode", nativeSessionId: a.nativeId, authorityId: a.source.authorityId, cwd: b.executionCheckout }, a.parent);
    }
    return a;
  }
  ready(sessionId: string) {
    const a = this.get(sessionId);
    if (!a || a.state !== "identity_known") throw new WorkstreamAdapterError(409, "admission-pending", "Known identity must be durable before ready");
    return this.update(sessionId, { state: "ready", error: null });
  }
  async enroll(sessionId: string) {
    const a = this.get(sessionId);
    if (!a || a.state !== "ready" || a.binding.domain.mode !== "app-only") throw new WorkstreamAdapterError(409, "enrollment-invalid", "Only ready App-only conversations can enroll");
    const adapter = await this.router.forWorkspace(a.binding.workspaceId), pin = adapter.preflight(a.binding.executionCheckout);
    // Persist the exact intended domain before registration; failed enrollment stays pending.
    return this.update(sessionId, { operation: "enroll", state: "identity_known", binding: { ...a.binding, checkoutPin: pin, domain: { mode: "repository", repositoryId: adapter.repositoryId, primaryCheckout: adapter.domain.primaryCheckout } } });
  }
}
