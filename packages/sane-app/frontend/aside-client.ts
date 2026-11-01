import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  ASIDE_EXECUTION_AVAILABILITY, parseAsideCreateRequest, parseAsideDraftRequest,
  parseAsideLifecycleRequest, parseAsideRecord, summarizeAside,
  type AsideCreateRequest, type AsideDraftRequest, type AsideLifecycleRequest,
  type AsideLifecycle, type AsideRecord, type AsideSummary, type AsideTarget,
} from "../shared/aside-contract";

export type AsideScope = { storeId: string; sessionId: string };
export type AsideDraft = {
  record: AsideRecord; text: string; dirty: boolean; conflict: boolean; error: string;
  operation?: { kind: "draft" | "lifecycle"; uncertain: boolean };
};
type PendingCreate = AsideCreateRequest & { uncertain: boolean; error: string };
export type AsideController = {
  scopeKey: string; asides: readonly AsideSummary[]; selected: AsideDraft | undefined;
  loading: boolean; error: string; creating: boolean; pendingCreate?: PendingCreate;
  enabled: boolean; canCreate: boolean;
  create(target: AsideTarget, text: string): Promise<string | undefined>;
  retryCreate(): Promise<string | undefined>;
  open(id: string, options?: { refresh?: boolean }): Promise<void>;
  edit(id: string, text: string): void;
  save(id: string): Promise<void>;
  setLifecycle(id: string, state: AsideLifecycle): Promise<void>;
  refresh(): Promise<void>;
  reconcile(id: string): Promise<void>;
  reload(id: string): Promise<void>;
};

type Operation = ({ kind: "draft"; payload: AsideDraftRequest } | { kind: "lifecycle"; payload: AsideLifecycleRequest })
  & { edit: number; uncertain: boolean };
type Draft = Omit<AsideDraft, "operation"> & { edit: number; operation?: Operation; readError?: string };
// Mutable recovery metadata only. Never duplicate immutable source transcripts
// in browser storage; restored identities must be verified by GET before use.
type RestoredDraft = Pick<Draft, "text" | "edit" | "conflict" | "error" | "operation" | "readError"> & {
  id: string; revision: number; draft: string;
};
type Projection = Pick<AsideController, "asides" | "selected" | "loading" | "error" | "creating" | "pendingCreate">;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type AsideTransport = (path: string, init?: RequestInit) => Promise<unknown>;
export class AsideRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const scopeKey = (scope: AsideScope) => JSON.stringify([scope.storeId, scope.sessionId]);
const storageKey = (scope: AsideScope) => `sane:asides:v2:${scopeKey(scope)}`;
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function check(value: unknown, message = "Invalid aside response."): asserts value { if (!value) throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const message = (error: unknown) => error instanceof Error ? error.message : "Asides are unavailable.";
const recovery = (draft: Draft) => draft.dirty || draft.conflict || !!draft.operation || !!draft.error || !!draft.readError;
function validText(text: unknown): asserts text is string {
  parseAsideDraftRequest({ requestId: "validate", expectedRevision: 1, text });
}
function execution(value: Record<string, unknown>) {
  const state = object(value.execution);
  check(state.available === ASIDE_EXECUTION_AVAILABILITY.available && state.code === ASIDE_EXECUTION_AVAILABILITY.code,
    "Aside execution availability is unrecognized. No execution is enabled.");
}
// In-memory evidence is shared with the draft owner, never browser persistence.
// Freeze only newly accepted sources; subsequent revisions reuse that source.
function freezeEvidence(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeEvidence(child);
  Object.freeze(value);
}
let timingSerial = 0;
/** Payload-free User Timing stages. Retain only the latest measure per stage. */
export function startAsideTiming(stage: "capture-create" | "open" | "summary" | "navigation" | "hydrate"): (record?: boolean) => void {
  const name = `sane:aside:${stage}`, mark = `${name}:${++timingSerial}`;
  let pending = true;
  try { globalThis.performance?.mark(mark); } catch { /* Diagnostics must not affect recovery. */ }
  return (record = true) => {
    if (!pending) return;
    pending = false;
    try {
      if (record) {
        globalThis.performance?.clearMeasures(name);
        globalThis.performance?.measure(name, mark);
      }
    } catch { /* User Timing is optional. */ }
    finally { try { globalThis.performance?.clearMarks(mark); } catch { /* Optional. */ } }
  };
}
function summary(value: unknown, scope: AsideScope): AsideSummary {
  const v = object(value);
  check(Object.keys(v).every(key => ["id", "sourceSessionId", "rootSessionId", "purpose", "lifecycle", "revision", "createdAt", "updatedAt", "question"].includes(key)));
  check(uuid(v.id) && v.sourceSessionId === scope.sessionId && uuid(v.rootSessionId)
    && ["discussion", "question-explanation"].includes(v.purpose as string)
    && ["open", "archived", "discarded"].includes(v.lifecycle as string)
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 1
    && typeof v.createdAt === "string" && v.createdAt.length <= 64 && Number.isFinite(Date.parse(v.createdAt))
    && typeof v.updatedAt === "string" && v.updatedAt.length <= 64 && Number.isFinite(Date.parse(v.updatedAt))
    && Date.parse(v.createdAt) <= Date.parse(v.updatedAt));
  check(v.revision !== 1 || v.lifecycle === "open" && v.createdAt === v.updatedAt);
  if (v.purpose === "question-explanation") {
    const q = object(v.question);
    check(Object.keys(q).length === 2 && Object.keys(q).every(key => key === "formId" || key === "questionIndex"));
    parseAsideCreateRequest({ requestId: "validate", draft: "", target: { kind: "question", formId: q.formId, questionIndex: q.questionIndex } });
  } else check(v.question === undefined);
  return structuredClone(v) as AsideSummary;
}
async function transport(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init,
    headers: { "Content-Type": "application/json", ...init.headers }, signal: init.signal ?? AbortSignal.timeout(25000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    check(body && typeof body.error === "string" && typeof body.code === "string",
      `Aside request failed (${response.status}) with an unrecognized response; its outcome is unconfirmed.`);
    throw new AsideRequestError(body.error, response.status, body.code);
  }
  return response.json();
}
function browserStorage(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}
type PrecommitRejection = { status: number; code: string };
const precommitCodes: Readonly<Record<number, readonly string[]>> = {
  400: ["aside-input", "aside-invalid"],
  404: ["aside-missing", "aside-not-found", "aside-question-missing", "aside-source-not-found"],
  405: ["aside-method-not-allowed"],
  409: ["aside-conflict", "aside-source-changed", "aside-source-identity", "aside-source-not-ready",
    "aside-source-binding", "aside-question-source", "aside-source-invalid", "aside-source-unavailable"],
  413: ["aside-input"],
  429: ["aside-limit"],
};
function definiteRejection(error: unknown): PrecommitRejection | undefined {
  // Routes recheck request authority AFTER awaiting a possibly committed write.
  // In particular, auth failures and aside-interrupted are NOT rejection proof.
  // Unknown status/code pairs, malformed responses and all 5xx stay uncertain.
  const failure = error as { status?: unknown; code?: unknown } | null;
  const status = failure?.status, code = failure?.code;
  return typeof status === "number" && typeof code === "string" && precommitCodes[status]?.includes(code)
    ? { status, code } : undefined;
}

/** Durable local recovery owner. No composer, native session, or submission access.
 * The caller's synchronous endpoint guard is checked before EVERY request, including
 * follow-up reads. Responses may only update this immutable originating scope. */
export class AsideSession {
  readonly scope: AsideScope;
  private state: Projection = { asides: [], selected: undefined, loading: false, error: "", creating: false };
  private drafts = new Map<string, Draft>();
  private references = new Map<string, AsideRecord>();
  private recordRequests = new Map<string, { generation: number; promise: Promise<AsideRecord> }>();
  private accessGeneration = 0;
  private accessToken: unknown;
  // A receipt/cache hit proves immutable source identity, not mutable freshness.
  private stale = new Set<string>();
  private restored = new Map<string, RestoredDraft>();
  private selectedId?: string;
  private selectionRevision = 0;
  private listeners = new Set<() => void>();
  private mutations = new Set<string>();
  private reading = 0;
  private createRejection?: PrecommitRejection;
  private readonly storage: Storage | undefined;
  private readonly send: AsideTransport;
  private allowEndpoint: () => boolean;
  private allowCreate: () => boolean;
  constructor(scope: AsideScope, options: {
    transport?: AsideTransport; storage?: Storage | null;
    allowEndpoint: () => boolean; canCreate?: () => boolean; accessToken?: unknown;
  }) {
    this.scope = Object.freeze({ ...scope });
    this.send = options.transport ?? transport;
    this.storage = options.storage === null ? undefined : options.storage ?? browserStorage();
    this.allowEndpoint = options.allowEndpoint;
    this.allowCreate = options.canCreate ?? options.allowEndpoint;
    this.accessToken = options.accessToken ?? options.allowEndpoint;
    this.restore();
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setAccess(allowEndpoint: () => boolean, canCreate: () => boolean, token: unknown = allowEndpoint) {
    if (token !== this.accessToken) this.retireAccess(this.accessToken);
    this.accessToken = token;
    this.allowEndpoint = allowEndpoint; this.allowCreate = canCreate;
  }
  /** Retire reads only: immutable evidence, draft ownership and exact write
   * recovery survive unmount/reauthentication. An old hook cannot retire a new owner. */
  retireAccess(token: unknown) {
    if (token !== this.accessToken) return;
    ++this.accessGeneration;
    ++this.reading;
    this.recordRequests.clear();
  }
  private readCurrent(generation: number) { return generation === this.accessGeneration && this.endpoint(); }
  hasUnsavedWork = () => !!this.state.pendingCreate || this.restored.size > 0
    || [...this.drafts.values()].some(draft => draft.dirty || draft.conflict || draft.operation);
  private endpoint() { return uuid(this.scope.storeId) && uuid(this.scope.sessionId) && this.allowEndpoint(); }
  private async request(path: string, init?: RequestInit) {
    check(this.endpoint(), "The aside's App store or source is no longer active. Local recovery is retained.");
    return this.send(path, init);
  }
  private record(value: unknown, id?: string): AsideRecord {
    const record = parseAsideRecord(value);
    check(record.source.storeId === this.scope.storeId && record.source.sessionId === this.scope.sessionId
      && (!id || record.id === id), "Aside does not match its store, source, or requested identity.");
    const known = this.references.get(record.id);
    check(!known || JSON.stringify(known.source) === JSON.stringify(record.source) && known.createdAt === record.createdAt,
      "Aside immutable source changed.");
    if (known) record.source = known.source;
    else freezeEvidence(record.source);
    return Object.freeze(record);
  }
  private response(value: unknown, id?: string): AsideRecord {
    const body = object(value); execution(body); return this.record(body.aside, id);
  }
  /** Persisted recovery never populates this validated cache. Borrowing is safe:
   * the record and its complete source tree are frozen before publication. */
  readCached = (id: string, borrow = false): AsideRecord | undefined => {
    const record = this.endpoint() && this.references.get(id);
    return record ? borrow ? record : structuredClone(record) : undefined;
  };
  private retainReference(record: AsideRecord) {
    const known = this.references.get(record.id);
    if (known && known.revision === record.revision) check(known.draft === record.draft && known.lifecycle === record.lifecycle,
      "Aside revision has inconsistent contents.");
    if (!known || known.revision < record.revision) this.references.set(record.id, record);
  }
  private fetchRecord(id: string, fresh = false): Promise<AsideRecord> {
    check(this.endpoint() && uuid(id), "The aside's App store or source is no longer active. Local recovery is retained.");
    const generation = this.accessGeneration;
    const existing = this.recordRequests.get(id);
    // A post-mutation projection or explicit reload must not join a read that
    // began before the write/action. Only ordinary reference misses coalesce.
    if (existing?.generation === generation && !fresh) return existing.promise;
    const pending = { generation, promise: this.request(`/api/asides/${encodeURIComponent(id)}`).then(body => {
      check(this.readCurrent(generation), "Aside reference access changed. Local recovery is retained.");
      return this.response(body, id);
    }) };
    this.recordRequests.set(id, pending);
    const clear = () => { if (this.recordRequests.get(id) === pending) this.recordRequests.delete(id); };
    void pending.promise.then(clear, clear);
    return pending.promise;
  }
  getReference = async (id: string): Promise<AsideRecord> => {
    check(this.endpoint() && uuid(id), "The aside's App store or source is no longer active.");
    const cached = this.readCached(id, true);
    if (cached) return cached;
    const generation = this.accessGeneration;
    const record = await this.fetchRecord(id);
    check(this.readCurrent(generation), "Aside reference access changed. Local recovery is retained.");
    this.merge(record);
    this.confirmRead(record);
    return this.references.get(id)!;
  };
  private confirmRead(record: AsideRecord) {
    const latest = this.drafts.get(record.id)?.record;
    const summary = this.state.asides.find(item => item.id === record.id);
    if (latest && record.revision >= latest.revision && (!summary || record.revision >= summary.revision)) this.stale.delete(record.id);
  }
  private restore() {
    try {
      const raw = this.storage?.getItem(storageKey(this.scope));
      if (!raw) return;
      const value = object(JSON.parse(raw));
      check(value.version === 2 && value.scopeKey === scopeKey(this.scope) && Array.isArray(value.drafts));
      for (const item of value.drafts) {
        try {
          const d = object(item);
          check(uuid(d.id) && Number.isSafeInteger(d.revision) && (d.revision as number) >= 1);
          validText(d.text); validText(d.draft);
          check(Number.isSafeInteger(d.edit) && (d.edit as number) >= 0 && typeof d.conflict === "boolean");
          let operation: Operation | undefined;
          if (d.operation !== undefined) {
            const op = object(d.operation);
            check(Number.isSafeInteger(op.edit) && (op.edit as number) >= 0 && (op.edit as number) <= (d.edit as number));
            if (op.kind === "draft") operation = { kind: "draft", payload: parseAsideDraftRequest(op.payload), edit: op.edit as number, uncertain: true };
            else { check(op.kind === "lifecycle"); operation = { kind: "lifecycle", payload: parseAsideLifecycleRequest(op.payload), edit: op.edit as number, uncertain: true }; }
            check(operation.payload.expectedRevision <= (d.revision as number));
          }
          this.restored.set(d.id, { id: d.id, revision: d.revision as number, draft: d.draft, text: d.text, edit: d.edit as number,
            conflict: d.conflict, error: operation ? "An earlier operation is unconfirmed. Reconcile its original request." : typeof d.error === "string" ? d.error : "",
            readError: typeof d.readError === "string" ? d.readError : undefined, operation });
        } catch { /* A corrupt or cross-scope record must never be published. */ }
      }
      if (value.pendingCreate !== undefined) {
        try {
          const p = object(value.pendingCreate);
          const pending = parseAsideCreateRequest({ requestId: p.requestId, target: p.target, draft: p.draft });
          // An interrupted in-flight request had uncertain=false but no error.
          // Only a persisted, explicit rejection remains replaceable on reload.
          this.createRejection = definiteRejection(value.createRejection);
          const definite = !!this.createRejection && p.uncertain === false && typeof p.error === "string" && p.error.length > 0;
          this.state = { ...this.state, pendingCreate: { ...pending, uncertain: !definite,
            error: definite ? p.error as string : "An earlier creation is unconfirmed. Retry the original request." } };
        } catch { this.state = { ...this.state, error: "An invalid local creation request was not restored." }; }
      }
      if (typeof value.selectedId === "string" && this.restored.has(value.selectedId)) this.selectedId = value.selectedId;
    } catch { this.state = { ...this.state, error: "Aside local recovery could not be read. Server data can still be refreshed." }; }
  }
  private publish(change: Partial<Projection> = {}) {
    const selected = this.drafts.get(this.selectedId ?? "");
    this.state = { ...this.state, ...change, selected: selected ? {
      ...selected, error: [selected.error, selected.readError].filter(Boolean).join(" "),
    } : undefined };
    try {
      const drafts: RestoredDraft[] = [...this.restored.values(), ...[...this.drafts.values()].filter(recovery).map(d => ({
        id: d.record.id, revision: d.record.revision, draft: d.record.draft, text: d.text,
        edit: d.edit, conflict: d.conflict, error: d.error, readError: d.readError, operation: d.operation,
      }))];
      if (drafts.length || this.state.pendingCreate) {
        check(this.storage, "Browser storage is unavailable.");
        this.storage.setItem(storageKey(this.scope), JSON.stringify({
          version: 2, scopeKey: scopeKey(this.scope), selectedId: this.selectedId, drafts, pendingCreate: this.state.pendingCreate,
          createRejection: this.createRejection,
        }));
      }
      else this.storage?.removeItem(storageKey(this.scope));
    } catch {
      const warning = "Local recovery could not be stored for reload. Keep this tab open; unsaved work remains in memory.";
      if (!this.state.error.includes(warning)) this.state = { ...this.state, error: [this.state.error, warning].filter(Boolean).join(" ") };
    }
    for (const listener of this.listeners) listener();
    publishAsideCount(this.scope, this.state.asides.length);
  }
  private update(id: string, change: (draft: Draft) => Draft) {
    const draft = this.drafts.get(id);
    if (draft) { this.drafts.set(id, change(draft)); this.publish(); }
  }
  private summaries(incoming: readonly AsideSummary[]) {
    const known = new Map(this.state.asides.map(item => [item.id, item]));
    for (const item of incoming) if (!known.has(item.id) || known.get(item.id)!.revision <= item.revision) known.set(item.id, item);
    return [...known.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  private validateSummary(item: AsideSummary) {
    const known = this.references.get(item.id);
    if (!known) return;
    const original = summarizeAside(known);
    check(item.rootSessionId === original.rootSessionId && item.purpose === original.purpose && item.createdAt === original.createdAt
      && JSON.stringify(item.question) === JSON.stringify(original.question), "Aside summary does not match its immutable source.");
  }
  private merge(record: AsideRecord) {
    this.retainReference(record);
    const restored = this.restored.get(record.id);
    if (restored) {
      check(record.revision >= restored.revision, "Server aside predates the retained local revision. Local recovery is retained.");
      const wasDirty = restored.text !== restored.draft;
      const text = wasDirty || restored.conflict || restored.operation?.kind === "draft" ? restored.text : record.draft;
      this.drafts.set(record.id, { record, text, dirty: text !== record.draft, edit: restored.edit,
        conflict: restored.conflict || !restored.operation && wasDirty && record.revision > restored.revision,
        error: restored.error, operation: restored.operation });
      this.restored.delete(record.id);
      this.publish({ asides: this.summaries([summarizeAside(record)]) });
      return;
    }
    const current = this.drafts.get(record.id);
    if (current && current.record.revision > record.revision) return;
    if (current && current.record.revision === record.revision) {
      check(current.record.draft === record.draft && current.record.lifecycle === record.lifecycle, "Aside revision has inconsistent contents.");
      if (current.readError) this.update(record.id, draft => ({ ...draft, readError: undefined }));
      return;
    }
    // Read errors and clean lifecycle intents do not pin stale server text.
    // Keep mutation/recovery errors distinct from a transient failed GET.
    const preserveText = current && (current.dirty || current.conflict || current.operation?.kind === "draft");
    const text = preserveText ? current.text : record.draft;
    this.drafts.set(record.id, current ? { ...current, record, text, dirty: text !== record.draft, readError: undefined,
      conflict: current.conflict || !current.operation && current.dirty }
      : { record, text: record.draft, dirty: false, conflict: false, error: "", edit: 0 });
    this.publish({ asides: this.summaries([summarizeAside(record)]) });
  }
  private readRecord = async (id: string, discard = false, fresh = false): Promise<boolean> => {
    if (!this.endpoint() || !uuid(id)) return false;
    const generation = this.accessGeneration;
    const edit = this.drafts.get(id)?.edit;
    try {
      const record = await this.fetchRecord(id, fresh);
      if (!this.readCurrent(generation)) return false;
      const current = this.drafts.get(id);
      // Even an explicit reload cannot discard edits typed AFTER its invocation.
      if (discard && !this.restored.has(id) && !current?.operation && current?.edit === edit && (!current || record.revision >= current.record.revision)) {
        this.retainReference(record);
        this.drafts.set(id, { record, text: record.draft, dirty: false, conflict: false, error: "", edit: (edit ?? 0) + 1 });
        this.publish({ asides: this.summaries([summarizeAside(record)]), error: "" });
      } else { this.merge(record); this.publish({ error: "" }); }
      this.confirmRead(record);
      return !this.stale.has(id);
    } catch (error) {
      if (!this.readCurrent(generation)) return false;
      if (this.drafts.has(id)) this.update(id, draft => ({ ...draft, readError: message(error) }));
      else this.publish({ error: message(error) });
      return false;
    }
  };
  open = async (id: string, options: { refresh?: boolean } = {}): Promise<void> => {
    if (!this.endpoint() || !uuid(id)) return;
    ++this.selectionRevision;
    this.selectedId = id; this.publish();
    if (options.refresh || !this.drafts.has(id) || this.stale.has(id)) await this.readRecord(id, false, options.refresh);
  };
  refresh = async (revalidate = true): Promise<void> => {
    if (!this.endpoint()) return;
    const generation = ++this.reading;
    const accessGeneration = this.accessGeneration;
    this.publish({ loading: true });
    try {
      const body = object(await this.request(`/api/sessions/${encodeURIComponent(this.scope.sessionId)}/asides`));
      if (generation !== this.reading || !this.readCurrent(accessGeneration)) return;
      execution(body); check(Array.isArray(body.asides));
      const asides = body.asides.map(item => summary(item, this.scope));
      check(new Set(asides.map(item => item.id)).size === asides.length, "Duplicate aside identities.");
      asides.forEach(item => this.validateSummary(item));
      if (generation !== this.reading) return;
      for (const item of asides) if (item.revision > (this.drafts.get(item.id)?.record.revision ?? 0)) this.stale.add(item.id);
      this.publish({ asides: this.summaries(asides), loading: false, error: "" });
      await Promise.all([...new Set([...(this.selectedId ? [this.selectedId] : []), ...this.restored.keys()])]
        .filter(id => revalidate || !this.drafts.has(id) || this.stale.has(id)).map(id => this.readRecord(id, false, revalidate)));
    } catch (error) { if (generation === this.reading && this.readCurrent(accessGeneration)) this.publish({ loading: false, error: message(error) }); }
  };
  edit = (id: string, text: string): void => {
    const draft = this.drafts.get(id);
    if (!this.endpoint() || !draft || draft.record.lifecycle !== "open") return;
    try { validText(text); }
    catch (error) { this.update(id, current => ({ ...current, error: message(error) })); return; }
    this.update(id, current => ({ ...current, text, edit: current.edit + 1, dirty: text !== current.record.draft,
      error: current.operation || current.conflict ? current.error : "" }));
  };
  create = async (target: AsideTarget, text: string): Promise<string | undefined> => {
    const previous = this.state.pendingCreate;
    if (!this.endpoint() || !this.allowCreate() || this.state.creating
      || previous && (previous.uncertain || !previous.error)) return;
    try {
      const payload = parseAsideCreateRequest({ requestId: crypto.randomUUID(), target, draft: text });
      // Persist intent BEFORE the first await, including before transport invocation.
      this.createRejection = undefined;
      this.publish({ pendingCreate: { ...payload, uncertain: false, error: "" }, error: "" });
      return await this.retryCreate();
    } catch (error) { this.publish({ error: message(error) }); }
  };
  retryCreate = async (): Promise<string | undefined> => {
    const pending = this.state.pendingCreate;
    if (!pending || this.state.creating || !this.endpoint()) return;
    const payload = { requestId: pending.requestId, target: pending.target, draft: pending.draft };
    const selectionRevision = this.selectionRevision;
    this.createRejection = undefined;
    this.publish({ creating: true, pendingCreate: { ...pending, uncertain: false, error: "" } });
    try {
      const finishTiming = startAsideTiming("capture-create");
      let body: unknown;
      try {
        body = await this.request(`/api/sessions/${encodeURIComponent(this.scope.sessionId)}/asides`, {
          method: "POST", body: JSON.stringify(payload),
        });
      } finally { finishTiming(); }
      const record = this.response(body);
      const q = record.source.question;
      check(record.revision === 1 && record.draft === payload.draft && (payload.target.kind === "conversation" ? !q
        : q?.formId === payload.target.formId && q.questionIndex === payload.target.questionIndex), "Creation acknowledgement does not match the original intent.");
      this.retainReference(record);
      // An uncertain request may replay its historical revision-one receipt.
      // Keep its immutable capture immediately, without replacing restored text
      // or delaying normal navigation on a second multi-MiB download.
      const reconcile = pending.uncertain || this.restored.has(record.id);
      if (!this.restored.has(record.id)) this.merge(record);
      if (reconcile) this.stale.add(record.id);
      // The list may observe this commit before its POST body arrives. A fresh
      // acknowledgement satisfies that summary only up to its own revision.
      else this.confirmRead(record);
      // A late creation belongs in the list, but must not displace a saved
      // aside explicitly opened while its acknowledgement was in flight.
      if (this.selectionRevision === selectionRevision) this.selectedId = record.id;
      this.publish({ asides: this.summaries([summarizeAside(record)]), pendingCreate: undefined, creating: false, error: "" });
      if (reconcile || this.stale.has(record.id)) void this.readRecord(record.id, false, true);
      return record.id;
    } catch (error) {
      this.createRejection = definiteRejection(error);
      this.publish({ creating: false, pendingCreate: { ...pending, uncertain: !this.createRejection,
        error: `${message(error)} ${this.createRejection ? "The request was rejected." : "Its outcome is unconfirmed."} The original creation request is retained.` } });
    }
  };
  save = async (id: string): Promise<void> => {
    const edit = this.drafts.get(id)?.edit;
    if (this.stale.has(id) && (!await this.readRecord(id) || this.drafts.get(id)?.edit !== edit)) return;
    const draft = this.drafts.get(id);
    if (!this.endpoint() || this.mutations.has(id) || !draft?.dirty || draft.operation || draft.conflict || draft.record.lifecycle !== "open") return;
    const operation: Operation = { kind: "draft", payload: parseAsideDraftRequest({ requestId: crypto.randomUUID(),
      expectedRevision: draft.record.revision, text: draft.text }), edit: draft.edit, uncertain: false };
    this.update(id, current => ({ ...current, operation, error: "" }));
    await this.perform(id, operation);
  };
  setLifecycle = async (id: string, lifecycle: AsideLifecycle): Promise<void> => {
    if (this.stale.has(id) && !await this.readRecord(id)) return;
    const draft = this.drafts.get(id);
    if (!this.endpoint() || this.mutations.has(id) || !draft || draft.operation || draft.conflict || draft.record.lifecycle === "discarded" || draft.record.lifecycle === lifecycle) return;
    try {
      const operation: Operation = { kind: "lifecycle", payload: parseAsideLifecycleRequest({ requestId: crypto.randomUUID(),
        expectedRevision: draft.record.revision, lifecycle }), edit: draft.edit, uncertain: false };
      this.update(id, current => ({ ...current, operation, error: "" }));
      await this.perform(id, operation);
    } catch (error) { this.update(id, current => ({ ...current, error: message(error) })); }
  };
  reconcile = async (id: string): Promise<void> => {
    const operation = this.drafts.get(id)?.operation;
    if (!this.endpoint() || !operation || this.mutations.has(id)) return;
    this.update(id, draft => ({ ...draft, operation: { ...operation, uncertain: false }, error: "" }));
    await this.perform(id, operation);
  };
  /** UI confirms before invoking. Unresolved intent must be reconciled, not erased. */
  reload = async (id: string): Promise<void> => {
    if (this.drafts.get(id)?.operation) return;
    await this.readRecord(id, true, true);
  };
  private async perform(id: string, operation: Operation): Promise<void> {
    if (this.mutations.has(id)) return;
    this.mutations.add(id);
    let locked = true;
    const unlock = () => { if (locked) { this.mutations.delete(id); locked = false; } };
    let acknowledgedRevision: number | undefined;
    try {
      const record = this.response(await this.request(`/api/asides/${encodeURIComponent(id)}/${operation.kind}`, {
        method: "POST", body: JSON.stringify(operation.payload),
      }), id);
      check(record.revision === operation.payload.expectedRevision + 1 && (operation.kind === "draft"
        ? record.draft === operation.payload.text : record.lifecycle === operation.payload.lifecycle), "Operation acknowledgement does not match its original intent.");
      acknowledgedRevision = record.revision;
      this.retainReference(record);
      this.update(id, current => {
        if (current.operation?.payload.requestId !== operation.payload.requestId) return current;
        const latest = current.record.revision > record.revision ? current.record : record;
        const text = recovery(current) || current.edit !== operation.edit ? current.text : latest.draft;
        return { ...current, record: latest, text, dirty: text !== latest.draft,
          conflict: current.conflict || latest.revision > record.revision && text !== latest.draft, error: "" };
      });
      this.publish({ asides: this.summaries([summarizeAside(this.drafts.get(id)!.record)]) });
      // Remain visibly busy through reconciliation. Otherwise the UI could
      // install an unsent second operation while this mutation lock is held.
      await this.readRecord(id, false, true);
    } catch (error) {
      if (this.drafts.get(id)?.operation?.payload.requestId !== operation.payload.requestId) return;
      if (acknowledgedRevision !== undefined) {
        this.update(id, draft => ({ ...draft, readError: message(error) }));
        return;
      }
      const rejection = definiteRejection(error);
      if (rejection?.status === 409 && rejection.code === "aside-conflict") {
        unlock();
        this.update(id, draft => ({ ...draft, operation: undefined, conflict: true,
          error: "The server version changed. Local text is retained; explicitly reload to discard it." }));
        await this.readRecord(id, false, true);
      } else if (rejection) {
        unlock();
        this.update(id, draft => ({ ...draft, operation: undefined, error: `${message(error)} The request was rejected; local text is retained.` }));
      } else {
        this.update(id, draft => ({ ...draft, operation: { ...operation, uncertain: true },
          error: `${message(error)} The original operation is retained; reconcile it before continuing.` }));
      }
    } finally {
      // Unlock before publishing idle so subscribers never see an idle owner
      // that would reject their next explicit action. Never release a newer lock.
      unlock();
      const confirmedRevision = acknowledgedRevision;
      if (confirmedRevision !== undefined) this.update(id, current => current.operation?.payload.requestId === operation.payload.requestId
        ? { ...current, operation: undefined, conflict: current.conflict || current.record.revision > confirmedRevision && current.dirty }
        : current);
    }
  }
}

const empty: Projection = { asides: [], selected: undefined, loading: false, error: "", creating: false };
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};
// Owners outlive the drawer/thread component: navigation must neither lose
// in-memory recovery (even with storage disabled) nor stop unload warnings.
const sessions = new Map<string, AsideSession>();
export function readCachedAside(scope: AsideScope, id: string, options: { borrow?: boolean } = {}): AsideRecord | undefined {
  return sessions.get(scopeKey(scope))?.readCached(id, options.borrow);
}
/** Share the owner's scoped GET promise on cache misses, including child mount. */
export async function getAsideReference(scope: AsideScope, id: string, current: () => boolean): Promise<AsideRecord> {
  check(current() && uuid(scope.storeId) && uuid(scope.sessionId) && uuid(id), "Aside reference scope is no longer active.");
  const key = scopeKey(scope);
  let owner = sessions.get(key);
  if (!owner) {
    owner = new AsideSession(scope, { allowEndpoint: current, canCreate: () => false });
    sessions.set(key, owner);
  }
  return owner.getReference(id);
}
type AsideListRequest = Readonly<AsideScope & { trigger: HTMLButtonElement }>;
const sidebarListeners = new Set<() => void>();
let sidebarCounts: Readonly<Record<string, number>> = {};
let listRequest: AsideListRequest | null = null;
const subscribeSidebar = (listener: () => void) => { sidebarListeners.add(listener); return () => { sidebarListeners.delete(listener); }; };
const notifySidebar = () => { for (const listener of sidebarListeners) listener(); };
function publishAsideCount(scope: AsideScope, count: number) {
  const key = scopeKey(scope);
  // Discard retains records, so observed totals only grow within an App store.
  if (count <= (sidebarCounts[key] ?? 0)) return;
  sidebarCounts = { ...sidebarCounts, [key]: count };
  notifySidebar();
}
export const asideCountFor = (scope: AsideScope, counts: Readonly<Record<string, number>>) => counts[scopeKey(scope)] ?? 0;
export function useAsideCounts() { return useSyncExternalStore(subscribeSidebar, () => sidebarCounts, () => sidebarCounts); }
export function useAsideListRequest() { return useSyncExternalStore(subscribeSidebar, () => listRequest, () => listRequest); }
/** Sidebar selection opens the existing source's drawer, never a working aside session. */
export function requestAsideList(scope: AsideScope, trigger: HTMLButtonElement) {
  if (!uuid(scope.storeId) || !uuid(scope.sessionId)) return;
  listRequest = { ...scope, trigger };
  notifySidebar();
}
export function consumeAsideListRequest(request: AsideListRequest) {
  if (listRequest !== request) return;
  listRequest = null;
  notifySidebar();
}
let unloadWarningInstalled = false;
function installUnloadWarning() {
  if (unloadWarningInstalled || typeof window === "undefined") return;
  window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
    if (![...sessions.values()].some(session => session.hasUnsavedWork())) return;
    event.preventDefault(); event.returnValue = "";
  });
  unloadWarningInstalled = true;
}

/** Access is historical App read/draft access, never native-send readiness. */
export function useAsides(scope: AsideScope | null, options: { enabled: boolean; canCreate: boolean; authority?: unknown }): AsideController {
  const key = scope ? scopeKey(scope) : "";
  const access = useRef({ key, ...options, mounted: true, token: {} });
  // Synchronous render fencing prevents callbacks retained by an old view from
  // reaching a newly selected store/backend before effect cleanup runs.
  const previous = access.current;
  const changed = previous.key !== key || previous.enabled !== options.enabled || previous.authority !== options.authority;
  if (changed) sessions.get(previous.key)?.retireAccess(previous.token);
  access.current = { ...previous, key, ...options, token: changed ? {} : previous.token };
  let owner = sessions.get(key);
  if (scope && !owner) {
    owner = new AsideSession(scope, {
      allowEndpoint: () => access.current.mounted && access.current.enabled && access.current.key === key,
      canCreate: () => access.current.canCreate,
      accessToken: access.current.token,
    });
    sessions.set(key, owner);
  }
  owner?.setAccess(() => access.current.mounted && access.current.enabled && access.current.key === key, () => access.current.canCreate, access.current.token);
  const state = useSyncExternalStore(owner?.subscribe ?? noSubscribe, owner?.snapshot ?? emptySnapshot, owner?.snapshot ?? emptySnapshot);
  useEffect(() => {
    access.current.mounted = true;
    installUnloadWarning();
    return () => {
      access.current.mounted = false;
      sessions.get(access.current.key)?.retireAccess(access.current.token);
    };
  }, []);
  useEffect(() => { if (options.enabled) void owner?.refresh(false); }, [owner, options.enabled, options.authority]);
  return {
    ...state, scopeKey: key, enabled: !!owner && options.enabled, canCreate: !!owner && options.enabled && options.canCreate,
    create: (target, text) => owner?.create(target, text) ?? Promise.resolve(undefined),
    retryCreate: () => owner?.retryCreate() ?? Promise.resolve(undefined),
    open: (id, options) => owner?.open(id, options) ?? Promise.resolve(), edit: (id, text) => owner?.edit(id, text),
    save: id => owner?.save(id) ?? Promise.resolve(), setLifecycle: (id, lifecycle) => owner?.setLifecycle(id, lifecycle) ?? Promise.resolve(),
    refresh: () => owner?.refresh() ?? Promise.resolve(), reconcile: id => owner?.reconcile(id) ?? Promise.resolve(),
    reload: id => owner?.reload(id) ?? Promise.resolve(),
  };
}
