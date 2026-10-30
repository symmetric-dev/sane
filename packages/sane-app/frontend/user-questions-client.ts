import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isUserQuestionsRecord, parseUserQuestionAnswers, type UserQuestionAnswer, type UserQuestionsRecord } from "../shared/user-questions-contract";
import { ApiError, request } from "./cc-client";
import { pollWhileVisible } from "./visibility";
import type { Harness } from "./types";
import { getHarnessDescriptor } from "../shared/conversation/harness-capabilities";

type Answers = UserQuestionAnswer[];
type Operation = {
  kind: "answers" | "submit" | "dismiss" | "resume";
  requestId: string;
  expectedRevision: number;
  answers?: Answers;
  edit: number;
  uncertain: boolean;
};
export type UserQuestionsDraft = {
  form: UserQuestionsRecord;
  answers: Answers;
  dirty: boolean;
  edit: number;
  operation?: Operation;
  conflict: boolean;
  error: string;
};
const needsRecovery = (draft: UserQuestionsDraft) => draft.dirty || draft.conflict || !!draft.operation || !!draft.error;
// Native acceptance may remain unknown until the agent finishes its turn. The
// saved submission still settles the composer; this does not assert delivery.
const settledSubmission = (draft: UserQuestionsDraft) => draft.form.status === "submitted"
  && (draft.form.delivery?.state === "pending" || draft.form.delivery?.state === "claimed" || draft.form.delivery?.state === "unknown" || draft.form.delivery?.state === "accepted" || draft.form.delivery?.state === "wrapper-completed");
const actionable = (draft: UserQuestionsDraft) => needsRecovery(draft) || draft.form.status === "presented"
  || draft.form.status === "submitted" && !settledSubmission(draft);
// Acknowledged submissions settle the composer without waiting for delivery.
// Local recovery and paused or missing delivery remain actionable.
// Keep one submitted marker so reopened history survives delivery proof changes.
const settledState = (draft: UserQuestionsDraft) => needsRecovery(draft) ? null
  : draft.form.status === "dismissed" ? "dismissed"
  : settledSubmission(draft) ? "submitted" : null;
type Projection = { forms: readonly UserQuestionsDraft[]; loading: boolean; error: string };
export type UserQuestionsScope = { storeId: string; sessionId: string; harness: Harness; nativeSessionId: string; authorityId: string };
export const userQuestionsScopeKey = (scope: UserQuestionsScope) => JSON.stringify([scope.storeId, scope.sessionId, scope.harness, scope.nativeSessionId, scope.authorityId]);
const matchesScope = (form: UserQuestionsRecord, scope: UserQuestionsScope) => form.sessionId === scope.sessionId
  && form.native.harness === getHarnessDescriptor(scope.harness)?.nativeHarness
  && form.native.nativeId === scope.nativeSessionId && form.native.authorityId === scope.authorityId;
const sameAnswers = (a: Answers, b: Answers) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) => error instanceof Error ? error.message : "Questions are unavailable.";
const draftKey = (scope: UserQuestionsScope) => `sane:user-questions:v2:${userQuestionsScopeKey(scope)}`;
function restoreDrafts(scope: UserQuestionsScope): UserQuestionsDraft[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(draftKey(scope)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((draft): UserQuestionsDraft[] => {
      try {
        if (!draft || !isUserQuestionsRecord(draft.form) || !matchesScope(draft.form, scope)
          || !Number.isSafeInteger(draft.edit) || draft.edit < 0 || typeof draft.conflict !== "boolean") return [];
        const answers = parseUserQuestionAnswers(draft.form.input, draft.answers);
        let operation: Operation | undefined;
        if (draft.operation !== undefined) {
          const op = draft.operation;
          if (!op || !["answers", "submit", "dismiss", "resume"].includes(op.kind) || typeof op.requestId !== "string" || !op.requestId
            || op.requestId.length > 4096 || op.requestId.trim() !== op.requestId || /[\u0000-\u001f\u007f]/.test(op.requestId)
            || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 1 || op.expectedRevision > draft.form.revision
            || !Number.isSafeInteger(op.edit) || op.edit < 0 || op.edit > draft.edit) return [];
          const hasAnswers = op.kind === "answers" || op.kind === "submit";
          if (!hasAnswers && op.answers !== undefined) return [];
          operation = {
            kind: op.kind, requestId: op.requestId, expectedRevision: op.expectedRevision, edit: op.edit, uncertain: true,
            ...(hasAnswers ? { answers: parseUserQuestionAnswers(draft.form.input, op.answers) } : {}),
          };
        }
        return [{ form: draft.form, answers, edit: draft.edit, dirty: !sameAnswers(answers, draft.form.answers), conflict: draft.conflict,
          error: operation ? "An earlier operation is unconfirmed. Reconcile its original request before continuing." : typeof draft.error === "string" ? draft.error : "",
          ...(operation ? { operation } : {}),
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

/** One owner per store/native scope. Navigation retains drafts and original operation identities. */
class QuestionsSession {
  private state: Projection = { forms: [], loading: true, error: "" };
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private reading = 0;
  writable = false;
  allowEndpoint = () => false;
  endpointEpoch = () => 0;
  constructor(readonly scope: UserQuestionsScope) { this.state = { forms: restoreDrafts(scope), loading: true, error: "" }; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: Projection) {
    this.state = state;
    // Keep unsaved edits and exact pending operations across a same-tab refresh.
    // Confirmed drafts live on the server; this is not another source of truth.
    try {
      const pending = state.forms.filter(draft => draft.dirty || draft.operation || draft.conflict);
      if (pending.length) sessionStorage.setItem(draftKey(this.scope), JSON.stringify(pending));
      else sessionStorage.removeItem(draftKey(this.scope));
    } catch { /* Storage may be disabled; beforeunload still warns about unsaved work. */ }
    this.listeners.forEach(listener => listener());
  }
  private find(id: string) { return this.state.forms.find(draft => draft.form.id === id); }
  private update(id: string, change: (draft: UserQuestionsDraft) => UserQuestionsDraft) {
    this.publish({ ...this.state, forms: this.state.forms.map(draft => draft.form.id === id ? change(draft) : draft) });
  }
  private cancelTimer(id: string) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  private schedule(id: string) {
    this.cancelTimer(id);
    const draft = this.find(id);
    if (!this.writable || !draft?.dirty || draft.operation || draft.conflict || draft.error || draft.form.status !== "presented") return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.mutate(id, "answers"); }, 650));
  }
  setWritable(writable: boolean) {
    this.writable = writable;
    if (!writable) for (const id of this.timers.keys()) this.cancelTimer(id);
    else for (const draft of this.state.forms) this.schedule(draft.form.id);
  }
  beginRead() { this.publish({ ...this.state, loading: true }); }
  /** Flush only already-authorized drafts; mutations keep their originating session URL after navigation. */
  flush = () => {
    for (const draft of this.state.forms) {
      this.cancelTimer(draft.form.id);
      if (this.writable && draft.dirty && !draft.operation && !draft.conflict && !draft.error) void this.mutate(draft.form.id, "answers", true);
    }
  };
  edit = (id: string, index: number, answer: UserQuestionAnswer) => {
    const draft = this.find(id);
    if (!this.writable || !this.allowEndpoint() || this.state.loading || this.state.error || !draft || draft.form.status !== "presented"
      || draft.operation && draft.operation.kind !== "answers" || !Number.isInteger(index) || index < 0 || index >= draft.answers.length) return;
    try {
      const answers = parseUserQuestionAnswers(draft.form.input, draft.answers.map((value, i) => i === index ? answer : value));
      this.update(id, current => ({ ...current, answers, edit: current.edit + 1, dirty: !sameAnswers(answers, current.form.answers),
        error: current.operation || current.conflict ? current.error : "" }));
    } catch (error) {
      this.update(id, current => ({ ...current, error: `Answer not saved: ${message(error)}` }));
      return;
    }
    this.schedule(id);
  };
  private merge(form: UserQuestionsRecord) {
    const current = this.find(form.id);
    if (!current) {
      this.publish({ ...this.state, forms: [...this.state.forms, { form, answers: form.answers, dirty: false, edit: 0, conflict: false, error: "" }] });
      return;
    }
    if (form.revision < current.form.revision) return;
    const op = current.operation;
    const confirmed = !!op && form.revision > op.expectedRevision && (op.kind === "submit" && form.submission?.requestId === op.requestId && sameAnswers(form.submission.answers, op.answers!)
      || op.kind === "dismiss" && form.dismissal?.requestId === op.requestId);
    if (confirmed) {
      this.update(form.id, draft => ({ ...draft, form, answers: form.answers, dirty: false, operation: undefined, conflict: false, error: "" }));
      return;
    }
    if (form.revision === current.form.revision) return;
    this.update(form.id, draft => {
      // Polling is never an acknowledgement of an unidentifiable draft save.
      // A local edit remains intact until the save's exact operation is reconciled.
      if (draft.dirty || draft.operation || draft.conflict) return { ...draft, form, conflict: draft.conflict || !draft.operation, error: draft.error };
      return { ...draft, form, answers: form.answers, conflict: false, error: "" };
    });
  }
  read = async (signal?: AbortSignal) => {
    if (!this.allowEndpoint()) return;
    const generation = ++this.reading;
    const epoch = this.endpointEpoch();
    try {
      const data = await request(`/api/sessions/${encodeURIComponent(this.scope.sessionId)}/user-questions`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : undefined });
      if (!Array.isArray(data.forms) || data.forms.some((form: unknown) => !isUserQuestionsRecord(form) || !matchesScope(form, this.scope))) throw new Error("Questions do not match this conversation's native identity.");
      if (signal?.aborted || generation !== this.reading || !this.allowEndpoint() || epoch !== this.endpointEpoch()) return;
      for (const form of data.forms as UserQuestionsRecord[]) this.merge(form);
      this.publish({ ...this.state, loading: false, error: "" });
      for (const draft of this.state.forms) this.schedule(draft.form.id);
    } catch (error) {
      if (!signal?.aborted && generation === this.reading && this.allowEndpoint() && epoch === this.endpointEpoch()) this.publish({ ...this.state, loading: false, error: message(error) });
    }
  };
  reload = (id: string) => {
    const draft = this.find(id);
    if (!this.writable || !this.allowEndpoint() || !draft || draft.operation) return;
    this.cancelTimer(id);
    this.update(id, current => ({ ...current, answers: current.form.answers, dirty: false, conflict: false, error: "", edit: current.edit + 1 }));
    void this.read();
  };
  mutate = async (id: string, kind: Operation["kind"], keepalive = false) => {
    const draft = this.find(id);
    if (!this.writable || !this.allowEndpoint() || !draft || draft.operation || draft.conflict || this.state.error || this.state.loading) return;
    if (kind !== "resume" && draft.form.status !== "presented") return;
    if (kind === "resume" && (draft.form.status !== "submitted" || draft.form.delivery?.state !== "paused")) return;
    if (kind === "answers" && !draft.dirty) return;
    this.cancelTimer(id);
    const operation: Operation = {
      kind, requestId: crypto.randomUUID(), expectedRevision: draft.form.revision,
      ...(kind === "answers" || kind === "submit" ? { answers: draft.answers } : {}),
      edit: draft.edit, uncertain: false,
    };
    this.update(id, current => ({ ...current, operation, error: "" }));
    await this.perform(id, operation, keepalive);
  };
  reconcile = async (id: string) => {
    const operation = this.find(id)?.operation;
    if (!this.writable || !this.allowEndpoint() || this.state.loading || this.state.error || !operation?.uncertain) return;
    // Replay the SAME operation, revision and payload. Never invent a new request id after a timeout.
    this.update(id, draft => ({ ...draft, operation: { ...operation, uncertain: false }, error: "" }));
    await this.perform(id, operation);
  };
  private async perform(id: string, operation: Operation, keepalive = false) {
    const epoch = this.endpointEpoch();
    try {
      const { requestId, expectedRevision, answers, kind } = operation;
      if (!this.allowEndpoint()) throw new Error("The App store or native session changed.");
      const data = await request(`/api/sessions/${encodeURIComponent(this.scope.sessionId)}/user-questions/${encodeURIComponent(id)}/${kind}`, {
        method: "POST", body: JSON.stringify({ requestId, expectedRevision, ...(answers ? { answers } : {}) }), keepalive,
      });
      if (!this.allowEndpoint() || epoch !== this.endpointEpoch() || !isUserQuestionsRecord(data.form) || data.form.id !== id || !matchesScope(data.form, this.scope) || data.form.revision <= expectedRevision
        || kind === "answers" && !sameAnswers(data.form.answers, operation.answers!)
        || kind === "submit" && data.form.submission?.requestId !== requestId
        || kind === "submit" && !sameAnswers(data.form.submission?.answers ?? [], operation.answers!)
        || kind === "dismiss" && data.form.dismissal?.requestId !== requestId) throw new Error("The operation acknowledgement is unconfirmed. Reconcile the original request.");
      this.update(id, draft => {
        if (draft.operation?.requestId !== requestId) return draft;
        // An older acknowledgement must not replace a newer cross-tab projection.
        const form = data.form.revision >= draft.form.revision ? data.form as UserQuestionsRecord : draft.form;
        const laterEdit = draft.edit !== operation.edit;
        const answers = kind === "answers" && laterEdit ? draft.answers : form.answers;
        const dirty = !sameAnswers(answers, form.answers);
        return { ...draft, form, answers, dirty, operation: undefined, conflict: form.revision > data.form.revision && dirty, error: "" };
      });
      // If editing was disabled during the request, newer edits remain persisted
      // locally. Do not start another write until this exact scope is active again.
      this.schedule(id);
    } catch (error) {
      if (this.find(id)?.operation?.requestId !== operation.requestId) return;
      if (!this.allowEndpoint() || epoch !== this.endpointEpoch()) {
        this.update(id, draft => ({ ...draft, operation: { ...operation, uncertain: true }, error: "The App store or native session changed. The original request and local answers are retained in their original scope." }));
      } else if (error instanceof ApiError && error.status === 409) {
        this.update(id, draft => ({ ...draft, operation: undefined, conflict: true, error: "The server version changed. Your local answers have been kept." }));
        await this.read();
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        this.update(id, draft => ({ ...draft, operation: undefined, error: `${message(error)} The request was rejected; local answers have been kept.` }));
      } else {
        this.update(id, draft => ({ ...draft, operation: { ...operation, uncertain: true }, error: `${message(error)} The original request is retained; its outcome is not yet confirmed.` }));
      }
    }
  }
}

const sessions = new Map<string, QuestionsSession>();
const sessionFor = (scope: UserQuestionsScope) => {
  const key = userQuestionsScopeKey(scope);
  let session = sessions.get(key);
  if (!session) { session = new QuestionsSession(scope); sessions.set(key, session); }
  return session;
};
const emptyProjection: Projection = { forms: [], loading: false, error: "" };
const emptySnapshot = () => emptyProjection;
const noSubscribe = (_listener: () => void) => () => {};

/** A missing store/native identity is not a reusable cache scope. No reads or writes occur until it is known. */
export function useUserQuestions(scope: UserQuestionsScope | null, { enabled, editable, running, refreshKey }: { enabled: boolean; editable: boolean; running: boolean; refreshKey?: unknown }) {
  const scopeKey = scope ? userQuestionsScopeKey(scope) : "";
  const session = useMemo(() => scope ? sessionFor(scope) : null, [scope]);
  const access = useRef({ scope, mounted: true, epoch: 0 });
  const previousScope = access.current.scope;
  if (previousScope?.storeId !== scope?.storeId || previousScope?.sessionId === scope?.sessionId
    && (previousScope ? userQuestionsScopeKey(previousScope) : "") !== scopeKey) access.current.epoch++;
  access.current.scope = scope;
  if (session) {
    session.endpointEpoch = () => access.current.epoch;
    session.allowEndpoint = () => {
      const current = access.current.scope;
      // A different conversation within the SAME App store may flush its own URL.
      // A switched store or a rebound native identity must never receive that write.
      return access.current.mounted && !!current && current.storeId === session.scope.storeId
        && (current.sessionId !== session.scope.sessionId || userQuestionsScopeKey(current) === userQuestionsScopeKey(session.scope));
    };
  }
  const state = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.snapshot ?? emptySnapshot, session?.snapshot ?? emptySnapshot);
  const [view, setView] = useState<{ scopeKey: string; id: string; expanded: boolean; settled: ReturnType<typeof settledState>; reveal?: object } | null>(null);
  useEffect(() => {
    access.current.mounted = true;
    return () => { access.current.mounted = false; };
  }, []);
  useEffect(() => {
    session?.setWritable(enabled && editable);
  }, [session, enabled, editable]);
  useEffect(() => () => { session?.flush(); session?.setWritable(false); }, [session]);
  useEffect(() => { if (session && enabled) session.beginRead(); }, [session, enabled]);
  useEffect(() => {
    if (!session || !enabled) return;
    return pollWhileVisible(async signal => { await session.read(signal); return running || session.snapshot().forms.some(draft => draft.form.status === "presented" || draft.form.delivery?.state === "pending" || draft.form.delivery?.state === "claimed") ? 3000 : 60_000; }, { sessionIds: [session.scope.sessionId], onWake: () => {} });
  }, [session, enabled, running]);
  useEffect(() => {
    if (!enabled || !session) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void session.read(controller.signal), 700);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, enabled, refreshKey]);
  useEffect(() => {
    if (!session) return;
    const flush = () => session.flush();
    const hidden = () => { if (document.hidden) flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!session.snapshot().forms.some(draft => draft.dirty || draft.operation || draft.conflict)) return;
      flush(); event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("beforeunload", beforeUnload); };
  }, [session]);
  const preferred = state.forms.find(draft => draft.form.status === "presented") ?? state.forms.filter(actionable).at(-1);
  const viewed = view?.scopeKey === scopeKey ? state.forms.find(draft => draft.form.id === view.id) : undefined;
  // A selection made before submission acknowledgement cannot pin its settled
  // submitted panel. Explicitly reopened history survives delivery proof changes.
  const activeView = viewed && view?.settled === settledState(viewed) ? view : null;
  useEffect(() => {
    if (view?.scopeKey === scopeKey && !activeView) setView(current => current === view ? null : current);
  }, [view, scopeKey, activeView]);
  const selected = activeView ? viewed : preferred;
  const defaultExpanded = !!selected && actionable(selected);
  const expanded = activeView ? activeView.expanded : defaultExpanded;
  const canClose = !!activeView && !!selected && settledState(selected) !== null;
  return {
    ...state, scopeKey, selected, expanded, canClose, revealRequest: activeView?.reveal,
    editable: !!session && enabled && editable && !state.loading && !state.error,
    open: (id: string) => {
      const draft = session?.snapshot().forms.find(item => item.form.id === id);
      if (draft) setView({ scopeKey, id, expanded: true, settled: settledState(draft), reveal: {} });
    },
    toggle: () => {
      const draft = session?.snapshot().forms.find(item => item.form.id === selected?.form.id);
      if (draft) setView({ scopeKey, id: draft.form.id, expanded: !expanded, settled: settledState(draft) });
    },
    close: () => {
      const draft = session?.snapshot().forms.find(item => item.form.id === activeView?.id);
      // Closing settled submitted history is view-only, even before delivery.
      // Never conceal paused/missing delivery or local recovery that
      // appeared after the close button was rendered.
      if (canClose && draft && settledState(draft) !== null) setView(current => current === activeView ? null : current);
    },
    edit: (id: string, index: number, answer: UserQuestionAnswer) => session?.edit(id, index, answer),
    mutate: (id: string, kind: Operation["kind"]) => session?.mutate(id, kind),
    reconcile: (id: string) => session?.reconcile(id), reload: (id: string) => session?.reload(id), retry: () => void session?.read(),
  };
}
export type UserQuestionsController = ReturnType<typeof useUserQuestions>;
