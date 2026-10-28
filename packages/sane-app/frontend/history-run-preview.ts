import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, request } from "./cc-client";
import type { PreviewRun } from "./conversation-hooks";
import { invalidateCoalescedRequests } from "./request-coalescing";
import { store } from "./store";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";
import { isHarness, type Harness } from "../shared/conversation/harness-capabilities";

type Source = { harness?: string; authorityId?: string; nativeSessionId?: string; cwd: string };
type Identity = Source & { storeId: string; sessionId: string; harness: Harness; authorityId: string; nativeSessionId: string };
type Page = { session: Identity; runs: PreviewRun[]; total: number; nextCursor: string | null; hasMore: boolean };
type Snapshot = Page & { headIds: string[]; marker: string; fetchedAt: number; notice?: string };
type Result = { runs: PreviewRun[]; loading: boolean; loadingMore: boolean; error: string; total: number | null; hasMore: boolean };
type State = Result & { key: string; snapshot?: Snapshot; failed?: "head" | "more" };
const idle: Result = { runs: [], loading: false, loadingMore: false, error: "", total: null, hasMore: false };
const cache = new Map<string, Snapshot>();
const TTL = 30_000;
const scope = () => JSON.stringify([workspaceEpoch(), store.snapshot().phase, store.snapshot().config?.authenticated === true, store.snapshot().config?.storeId]);
let cacheScope = scope(), scopeGeneration = 0;
let cacheRows = store.snapshot().conversations;
function clearChangedScope() {
  const next = scope();
  if (next !== cacheScope) { cacheScope = next; scopeGeneration++; cache.clear(); }
  const rows = store.snapshot().conversations;
  if (rows === cacheRows) return;
  cacheRows = rows;
  if (!cache.size) return;
  // Missing/rebound summaries are authoritative even for unmounted previews.
  // Do not let a later same-ID visit revive their previous native namespace.
  const known = new Map(rows.map(row => [row.id, row]));
  for (const [key, snapshot] of cache) {
    const row = known.get(snapshot.session.sessionId);
    if (!row || (["harness", "authorityId", "nativeSessionId", "cwd"] as const)
      .some(field => row[field] !== snapshot.session[field])) cache.delete(key);
  }
}
subscribeWorkspace(clearChangedScope);
store.subscribe(clearChangedScope);
function remember(key: string, snapshot: Snapshot) {
  clearChangedScope();
  cache.delete(key);
  // Explicitly loaded long tails stay local to their mounted preview only.
  if (snapshot.runs.length > 400) return;
  cache.set(key, snapshot);
  let rows = [...cache.values()].reduce((count, item) => count + item.runs.length, 0);
  while (cache.size > 20 || rows > 400) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    rows -= cache.get(oldest)!.runs.length;
    cache.delete(oldest);
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
function invalid(): never { throw new Error("Invalid run preview response. Update the bridge and retry."); }
class PreviewIdentityError extends Error {
  constructor() { super("Conversation identity changed. Reopen this preview."); }
}
function sameSource(actual: Identity, expected: Source) {
  return actual.cwd === expected.cwd && (["harness", "authorityId", "nativeSessionId"] as const).every(key => expected[key] === undefined || actual[key] === expected[key]);
}
function validate(value: unknown, id: string, storeId: string, expected: Source, prior?: Snapshot): Page {
  if (!record(value) || !record(value.session) || !record(value.page) || !Array.isArray(value.runs)) invalid();
  const source = value.session;
  if (!text(source.storeId) || !text(source.sessionId) || !isHarness(source.harness)
    || !text(source.authorityId) || !text(source.nativeSessionId) || typeof source.cwd !== "string") invalid();
  if (source.storeId !== storeId || source.sessionId !== id) throw new PreviewIdentityError();
  const session: Identity = { storeId, sessionId: id, harness: source.harness, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId, cwd: source.cwd };
  if (!sameSource(session, expected) || prior && !sameSource(session, prior.session)) throw new PreviewIdentityError();
  if (!Number.isSafeInteger(value.total) || (value.total as number) < 0 || value.runs.length > 20
    || typeof value.page.hasMore !== "boolean" || !(value.page.nextCursor === null || text(value.page.nextCursor))
    || value.page.hasMore !== (value.page.nextCursor !== null) || value.page.hasMore && !value.runs.length) invalid();
  const ids = new Set(prior?.runs.map(run => run.id));
  let previous = prior?.runs.at(-1)?.createdAt;
  const runs = value.runs.map((row): PreviewRun => {
    if (!record(row) || !text(row.sessionId) || !text(row.runId) || ids.has(row.runId) || !text(row.status) || !date(row.createdAt)) invalid();
    if (row.sessionId !== id) throw new PreviewIdentityError();
    if (previous && Date.parse(row.createdAt) > Date.parse(previous)) invalid();
    previous = row.createdAt;
    ids.add(row.runId);
    for (const key of ["endedAt", "model", "effort", "agent", "profileId", "cwd"] as const) if (row[key] !== undefined && typeof row[key] !== "string") invalid();
    if (row.endedAt !== undefined && !date(row.endedAt)
      || row.agentKind !== undefined && row.agentKind !== "assistant" && row.agentKind !== "worker"
      || row.nativeAgentSelected !== undefined && typeof row.nativeAgentSelected !== "boolean") invalid();
    // Deliberate allowlist: never retain command/context/instruction payloads.
    return { id: row.runId, status: row.status, createdAt: row.createdAt, endedAt: row.endedAt as string | undefined,
      model: row.model as string | undefined, effort: row.effort as string | undefined, agent: row.agent as string | undefined,
      agentKind: row.agentKind as PreviewRun["agentKind"], nativeAgentSelected: row.nativeAgentSelected as boolean | undefined,
      profileId: row.profileId as string | undefined, cwd: row.cwd as string | undefined, harness: session.harness };
  });
  const total = value.total as number;
  const count = (prior?.runs.length ?? 0) + runs.length;
  if (count > total || value.page.hasMore && count >= total || !value.page.hasMore && count !== total
    || prior && (total !== prior.total || value.page.nextCursor !== null && value.page.nextCursor === prior.nextCursor)) invalid();
  return { session, runs, total, nextCursor: value.page.nextCursor as string | null, hasMore: value.page.hasMore };
}
function message(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return "Sign-in expired. Reconnect or sign in again before loading run previews.";
  if (error instanceof ApiError && error.status === 403) return "Access to this run preview is no longer available.";
  if (error instanceof ApiError && error.status === 404 && error.code === "session-run-preview-missing") return "This conversation no longer has an available run preview. Reopen it from the active catalog.";
  if (error instanceof ApiError && error.status === 404) return "Run preview unavailable: this conversation may be retired or missing, or the bridge needs updating. No legacy history was requested.";
  if (error instanceof ApiError && error.status === 410) return "This conversation is retired. Restore it before loading its run preview.";
  if (error instanceof ApiError && error.status === 423) return "This conversation is being retired. Reopen its preview after retirement finishes.";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "Run preview timed out. Retry to try again.";
  return error instanceof Error ? error.message : "Could not load run preview.";
}

/** No polling/native acquisition: only the lean head and explicit cursor reads. */
export function useHistoryRunPreview(previewId: string | null, provided?: Source): Result & { loadMore(): void; retry(): void; refresh(): void } {
  const auth = useSyncExternalStore(subscribeWorkspace, workspaceEpoch, workspaceEpoch);
  const observed = useSyncExternalStore(store.subscribe, () => {
    const state = store.snapshot(), row = state.conversations.find(item => item.id === previewId);
    return JSON.stringify([state.phase, state.config?.authenticated === true, state.config?.storeId ?? null,
      row ? [row.harness, row.authorityId ?? null, row.nativeSessionId ?? null, row.cwd] : null,
      row ? [row.lastRunId, row.lastRunStatus, row.lastRunEndedAt, row.status] : null]);
  });
  const [phase, authenticated, storeId, known, markers] = JSON.parse(observed) as [string, boolean, string | null, [string, string | null, string | null, string] | null, unknown];
  const knownSource = known ? { harness: known[0], authorityId: known[1] ?? undefined, nativeSessionId: known[2] ?? undefined, cwd: known[3] } : undefined;
  const source: Source | undefined = knownSource ? { harness: provided?.harness ?? knownSource.harness,
    authorityId: provided?.authorityId ?? knownSource.authorityId, nativeSessionId: provided?.nativeSessionId ?? knownSource.nativeSessionId,
    cwd: provided?.cwd ?? knownSource.cwd } : undefined;
  const sourceKey = JSON.stringify(source ? [source.harness, source.authorityId, source.nativeSessionId, source.cwd] : null);
  const marker = JSON.stringify(markers);
  const key = JSON.stringify([auth, storeId, scopeGeneration, previewId, sourceKey, known]);
  const available = !!previewId && !!source && !!knownSource && !!knownSource.authorityId && !!knownSource.nativeSessionId
    && isHarness(knownSource.harness)
    && source.harness === knownSource.harness && source.authorityId === knownSource.authorityId
    && source.nativeSessionId === knownSource.nativeSessionId && source.cwd === knownSource.cwd
    && phase === "ready" && authenticated && !!storeId;
  const [state, setState] = useState<State>({ ...idle, key: "" });
  const stateRef = useRef(state);
  const owner = useRef<{ key: string; run(mode: "head" | "more" | "refresh"): void; observe(marker: string): void } | null>(null);

  useEffect(() => {
    clearChangedScope();
    if (!available || !previewId || !source || !storeId) { owner.current = null; return; }
    let current = true;
    const generation = scopeGeneration;
    let controller: AbortController | undefined;
    let revision = 0;
    let latestMarker = marker;
    let attemptedMarker = "";
    const cached = cache.get(key);
    let lastHeadMarker = cached?.marker;
    const headUrl = `/api/sessions/${encodeURIComponent(previewId)}/runs/preview?limit=20`;
    if (cached) { cache.delete(key); cache.set(key, cached); }
    let local: State = { ...idle, key, snapshot: cached, runs: cached?.runs ?? [], total: cached?.total ?? null, hasMore: cached?.hasMore ?? false, error: cached?.notice ?? "" };
    const valid = () => current && generation === scopeGeneration && auth === workspaceEpoch() && phase === store.snapshot().phase
      && store.snapshot().config?.authenticated === true && storeId === store.snapshot().config?.storeId
      && store.snapshot().conversations.some(row => row.id === previewId && row.harness === source.harness
        && row.authorityId === source.authorityId && row.nativeSessionId === source.nativeSessionId && row.cwd === source.cwd);
    const publish = (next: State) => { if (valid()) { local = next; stateRef.current = next; setState(next); } };
    publish(local);
    const cancelInvalidOwner = () => { if (!valid()) controller?.abort(); };
    const unsubscribeStore = store.subscribe(cancelInvalidOwner);
    const unsubscribeWorkspace = subscribeWorkspace(cancelInvalidOwner);
    const run = (mode: "head" | "more" | "refresh", resetOnce = false) => {
      if (!valid() || controller && mode !== "refresh") return;
      if (controller && mode === "refresh" && local.loading && !local.snapshot) return;
      if (mode === "more" && (!local.snapshot?.hasMore || !local.snapshot.nextCursor)) return;
      if (mode === "refresh") { controller?.abort(); cache.delete(key); publish({ ...idle, key }); }
      const prior = local.snapshot;
      const requestMarker = latestMarker;
      if (mode !== "more") {
        // GET coalescing retains responses briefly. A newly observed marker or
        // explicit refresh must not reuse the previous head and bless it as fresh.
        // Retirement does not abort readers already consuming that response.
        if (mode === "refresh" || prior && prior.marker !== requestMarker
          || lastHeadMarker !== undefined && lastHeadMarker !== requestMarker) {
          invalidateCoalescedRequests(url => url === headUrl);
        }
        attemptedMarker = requestMarker;
        lastHeadMarker = requestMarker;
      }
      const requestRevision = ++revision;
      controller = new AbortController();
      const activeController = controller;
      const signal = AbortSignal.any([activeController.signal, AbortSignal.timeout(15_000)]);
      const live = () => valid() && requestRevision === revision && !activeController.signal.aborted;
      publish({ ...local, loading: mode !== "more", loadingMore: mode === "more", error: "", failed: undefined });
      const params = new URLSearchParams({ limit: "20" });
      if (mode === "more") params.set("cursor", prior!.nextCursor!);
      // Race the body too: shared GET transport ownership transfers at headers.
      let abortListener: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      void Promise.race([request(`/api/sessions/${encodeURIComponent(previewId)}/runs/preview?${params}`, { signal }), cancelled])
        .then(value => {
          if (!live()) return;
          signal.throwIfAborted();
          const page = validate(value, previewId, storeId, source, mode === "more" ? prior : undefined);
          if (mode === "head" && prior) {
            // Preserve the sealed cursor/depth. Never splice two memberships:
            // new/deleted runs require explicit Refresh to start a new snapshot.
            if (JSON.stringify(page.runs.map(row => row.id)) !== JSON.stringify(prior.headIds) || page.total !== prior.total) {
              const snapshot = { ...prior, marker: requestMarker, fetchedAt: Date.now(), notice: "History changed. Refresh to view the latest runs without mixing pages." };
              remember(key, snapshot);
              publish({ ...local, snapshot, loading: false, loadingMore: false, error: snapshot.notice });
              return;
            }
          }
          const snapshot: Snapshot = mode === "more" && prior
            ? { ...prior, runs: [...prior.runs, ...page.runs], nextCursor: page.nextCursor, hasMore: page.hasMore }
            : mode === "head" && prior
              ? { ...prior, runs: [...page.runs, ...prior.runs.slice(prior.headIds.length)], marker: requestMarker, fetchedAt: Date.now(), notice: undefined }
              : { ...page, headIds: page.runs.map(row => row.id), marker: requestMarker, fetchedAt: Date.now() };
          remember(key, snapshot);
          publish({ key, snapshot, runs: snapshot.runs, total: snapshot.total, hasMore: snapshot.hasMore, loading: false, loadingMore: false, error: snapshot.notice ?? "" });
        }).catch(error => {
          if (!live()) return;
          if (error instanceof ApiError && error.status === 409 && error.code === "session-run-preview-reset" && !resetOnce) {
            controller = undefined;
            cache.delete(key);
            publish({ ...idle, key });
            run("refresh", true);
            return;
          }
          // Authoritative absence/access loss and a changed source invalidate the
          // snapshot, not just this request. Never revive its cursor on Retry or
          // a fresh mount within the cache TTL. Keep transient failures below.
          if (error instanceof PreviewIdentityError || error instanceof ApiError && [401, 403, 404, 410, 423].includes(error.status)) {
            if (error instanceof ApiError && error.status === 401) cache.clear();
            else cache.delete(key);
            attemptedMarker = latestMarker;
            publish({ ...idle, key, failed: "head", error: message(error) });
            return;
          }
          publish({ ...local, loading: false, loadingMore: false, failed: mode === "more" ? "more" : "head", error: message(error) });
        }).finally(() => {
          if (abortListener) signal.removeEventListener("abort", abortListener);
          if (controller === activeController) {
            controller = undefined;
            if (valid() && attemptedMarker !== latestMarker) run("head");
          }
        });
    };
    owner.current = { key, run, observe: next => {
      latestMarker = next;
      if (attemptedMarker !== next) run("head");
    } };
    if (cached?.marker === marker) attemptedMarker = marker;
    if (!cached || cached.marker !== marker || Date.now() - cached.fetchedAt >= TTL) run("head");
    return () => {
      current = false; revision++; controller?.abort(); unsubscribeStore(); unsubscribeWorkspace();
      if (owner.current?.key === key) owner.current = null;
    };
    // Source identity is scalar-keyed; summary object churn never reacquires.
    // Marker changes are handled below without cancelling an explicit page read.
  }, [key, available]);

  useEffect(() => {
    const entry = owner.current;
    if (entry?.key === key) entry.observe(marker);
  }, [key, marker, state.loading, state.loadingMore]);

  const target = () => owner.current?.key === key ? owner.current : null;
  const result: Result = !previewId ? idle : !available ? { ...idle, error: "Conversation identity or authentication is unavailable. Reopen this preview when connected." }
    : state.key === key ? state : { ...idle, loading: true };
  return { ...result, loadMore: () => target()?.run("more"), retry: () => target()?.run(stateRef.current.failed ?? "head"), refresh: () => target()?.run("refresh") };
}
