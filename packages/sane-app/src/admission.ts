import { DomainError, normalizeNativeSource, discoverRepository, revalidateCheckout } from "sane-core/server";
import type { ConversationRef, GrokSourceDescriptor } from "sane-core/contracts";
import { atomicAppRecord, validateStoredAdmissions, type Admission, type StoredAdmissions, type StoredSourceRecords } from "./app-store";
import type { CatalogService } from "./catalog";
import { uuid } from "./history";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";
import { toSessionHarness } from "./harness-names";
import type { GrokSourceRecord } from "./app-sources";

/** App-only create record, not a core repository ConversationRef or receipt. */
export type GrokCreateAdmission = Omit<Admission, "source" | "operation" | "nativeId" | "binding" | "parent"> & {
  source: { descriptor: GrokSourceDescriptor; authorityId: string };
  operation: "create";
  nativeId: string;
  binding: Admission["binding"] & { checkoutPin: null; domain: { mode: "app-only" } };
  parent: null;
};

/** Serialized by the bridge admission gate. All writes are synchronous durable publication. */
export class AdmissionService {
  private records: StoredAdmissions;
  constructor(private dataDir: string, initial: StoredAdmissions, private sources: StoredSourceRecords, private catalog: CatalogService, private router: RepositoryRouter, private save = atomicAppRecord) { this.records = structuredClone(validateStoredAdmissions(initial)); }
  get(sessionId: string): Admission | undefined { const a = this.records.admissions.find(a => a.sessionId === sessionId); return a && structuredClone(a); }
  /** Configured pin only: no home resolution, stat, or other filesystem work. */
  getGrokSourcePin(): GrokSourceRecord | null {
    const pin = this.sources.version === 2 ? this.sources.gk : undefined;
    return pin ? structuredClone(pin) : null;
  }
  getGrokCreate(sessionId: string): GrokCreateAdmission | undefined {
    const a = this.records.admissions.find(row => row.sessionId === sessionId);
    // Stored v2 rows include gk without widening core NativeAuthority.
    const harness: string | undefined = a?.source.descriptor.harness;
    return a && harness === "gk" && a.operation === "create" && a.nativeId !== null ? structuredClone(a) as unknown as GrokCreateAdmission : undefined;
  }
  getByNative(ref: ConversationRef): Admission | undefined {
    const a = this.records.admissions.find(a => a.source.descriptor.harness === ref.harness && a.source.authorityId === ref.authorityId && a.nativeId === ref.nativeId);
    return a && structuredClone(a);
  }
  list(): Admission[] { return structuredClone(this.records.admissions); }
  private persist(next: StoredAdmissions) { validateStoredAdmissions(next); this.save(this.dataDir, "admissions.json", next); this.records = next; }
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
    this.persist({ version: this.records.version, admissions: [...this.records.admissions, a] }); return structuredClone(a);
  }
  /**
   * Create-only Grok admission. The caller allocates the native UUID before the
   * prompt. This does not register a repository conversation, call `register`,
   * `toSessionHarness`, or the router, and it does not send a prompt. A
   * repository workspace is refused, not recorded as app-only. Open does not
   * migrate; only this explicit create publishes admissions version 2.
   * Production wiring must call it inside the bridge admission gate.
   */
  async beginGrokCreate(input: { sessionId: string; nativeId: string; cwd: string; workspaceId: string; worktreeId: string; authorityId?: string | null; parent?: ConversationRef | null }) {
    if (input.parent != null) throw new WorkstreamAdapterError(409, "grok-parent-refused", "Grok create refuses a parent; attach and enroll are unavailable");
    if (!uuid(input.sessionId)) throw new WorkstreamAdapterError(409, "invalid-session", "Grok session id must be a UUID");
    if (!uuid(input.nativeId)) throw new WorkstreamAdapterError(409, "invalid-native-id", "Grok native id must be a caller-allocated UUID");
    const gk = this.sources.version === 2 ? this.sources.gk : undefined;
    if (!gk) throw new WorkstreamAdapterError(409, "grok-unconfigured", "Grok source is unconfigured");
    if (gk.authorityId === null || input.authorityId === null) throw new WorkstreamAdapterError(409, "grok-unresolved", "Grok authority is unresolved");
    if (input.authorityId !== undefined && input.authorityId !== gk.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Grok authority does not match the configured home");
    // Refuse a registered repository without refreshing every worktree. The
    // selected binding below still receives its full filesystem validation once.
    const workspace = await this.catalog.registered(input.workspaceId);
    if (workspace.kind === "repository") throw new WorkstreamAdapterError(409, "grok-repository-refused", "Grok create refuses a repository workspace");
    let normalizedAuthority: string;
    try { normalizedAuthority = normalizeNativeSource(gk.descriptor).authorityId; }
    catch (error) {
      if (error instanceof DomainError) throw new WorkstreamAdapterError(409, "source-mismatch", "Grok authority does not match the configured home");
      throw error;
    }
    if (normalizedAuthority !== gk.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Grok authority does not match the configured home");
    const catalogBinding = await this.catalog.binding(input.workspaceId, input.worktreeId);
    if (catalogBinding.cwd !== input.cwd) throw new WorkstreamAdapterError(409, "execution-mismatch", "Use the canonical selected execution root");
    // Check current records after the awaited catalog work, contiguous with
    // publication. The production admission gate remains the serialization owner.
    const same = (left: string | null, right: string) => left !== null && left.toLowerCase() === right.toLowerCase();
    if (this.records.admissions.some(row => same(row.sessionId, input.sessionId))) throw new WorkstreamAdapterError(409, "admission-exists", "Grok admission refuses a duplicate session id; no retry");
    if (this.records.admissions.some(row => same(row.nativeId, input.nativeId))) throw new WorkstreamAdapterError(409, "admission-exists", "Grok admission refuses a duplicate native id; no replay");
    const source = structuredClone({ descriptor: gk.descriptor, authorityId: gk.authorityId });
    const a = {
      version: 1 as const, requestId: crypto.randomUUID(), sessionId: input.sessionId, operation: "create" as const, state: "identity_known" as const,
      source, binding: { workspaceId: input.workspaceId, worktreeId: input.worktreeId, bindingRevision: catalogBinding.bindingRevision, executionCheckout: input.cwd, checkoutPin: null, domain: { mode: "app-only" as const } },
      nativeId: input.nativeId, parent: null, createdAt: new Date().toISOString(), error: null,
    } satisfies GrokCreateAdmission;
    // The v2 App codec already validates this closed Grok row; do not widen
    // core NativeAuthority/ConversationRef just to store an App-only create.
    this.persist({ version: 2, admissions: [...this.records.admissions, a as unknown as Admission] });
    return structuredClone(a);
  }
  /** Grok create is not repository registration, native replay, ready, or enroll. */
  private refuseGrokRepository(a: Admission | undefined): void {
    const harness: string | undefined = a?.source.descriptor.harness;
    if (harness === "gk") throw new WorkstreamAdapterError(501, "unsupported-harness-operation", "Grok admission is create-only and is not a repository conversation");
  }
  async createNative(sessionId: string, create: () => Promise<string>) {
    const a = this.get(sessionId);
    this.refuseGrokRepository(a);
    if (!a || a.state !== "intent" || a.nativeId !== null) throw new WorkstreamAdapterError(409, "native-creation-not-retryable", "Native creation may already have occurred; inspect native state, never blindly recreate");
    // Unknown BEFORE the request means a crash or lost response is never replayed.
    this.update(sessionId, { state: "native_creation_unknown" });
    const nativeId = await create();
    return this.update(sessionId, { nativeId, state: "identity_known" });
  }
  async register(sessionId: string) {
    const a = this.get(sessionId);
    this.refuseGrokRepository(a);
    if (!a || !a.nativeId || !["identity_known", "ready"].includes(a.state)) throw new WorkstreamAdapterError(409, "admission-pending", "Known native identity required for explicit retry");
    const source = normalizeNativeSource(a.source.descriptor);
    if (source.authorityId !== a.source.authorityId) throw new WorkstreamAdapterError(409, "source-mismatch", "Source identity changed");
    const b = a.binding, binding = await this.catalog.binding(b.workspaceId, b.worktreeId);
    if (binding.cwd !== b.executionCheckout || binding.bindingRevision !== b.bindingRevision) throw new WorkstreamAdapterError(409, "execution-mismatch", "Execution binding changed");
    const adapter = await this.router.forAdmission(a);
    if (adapter) {
      revalidateCheckout(adapter.domain.context, b.checkoutPin!);
      // Core retry is identity/pin/parent-only: it never reapplies membership or phases.
      adapter.register({ sessionId, harness: toSessionHarness(a.source.descriptor.harness), nativeSessionId: a.nativeId, authorityId: a.source.authorityId, cwd: b.executionCheckout }, a.parent);
    }
    return a;
  }
  ready(sessionId: string) {
    const a = this.get(sessionId);
    this.refuseGrokRepository(a);
    if (!a || a.state !== "identity_known") throw new WorkstreamAdapterError(409, "admission-pending", "Known identity must be durable before ready");
    return this.update(sessionId, { state: "ready", error: null });
  }
  async enroll(sessionId: string) {
    const a = this.get(sessionId);
    this.refuseGrokRepository(a);
    if (!a || a.state !== "ready" || a.binding.domain.mode !== "app-only") throw new WorkstreamAdapterError(409, "enrollment-invalid", "Only ready App-only conversations can enroll");
    const adapter = await this.router.forWorkspace(a.binding.workspaceId), pin = adapter.preflight(a.binding.executionCheckout);
    // Persist the exact intended domain before registration; failed enrollment stays pending.
    return this.update(sessionId, { operation: "enroll", state: "identity_known", binding: { ...a.binding, checkoutPin: pin, domain: { mode: "repository", repositoryId: adapter.repositoryId, primaryCheckout: adapter.domain.primaryCheckout } } });
  }
}
