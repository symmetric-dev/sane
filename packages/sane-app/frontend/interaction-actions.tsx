import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiRefreshCw, FiSquare } from "react-icons/fi";
import { ChatButton, ChatCard, ChatCardBody, ChatNotice, ChatStatus } from "./chat-ui";
import { store, useStore } from "./store";
import { workerClient, type WorkerProjection } from "./worker-client";
import { WorkerPanelNotices } from "./worker-ui";
import "./interaction-actions.css";

export type InteractionSource = {
  id: string;
  label: string;
  loading: boolean;
  error?: string;
  partial?: boolean;
  retry?: () => void;
  disabled?: boolean;
  detail?: string;
};

type Feedback = { text: string; error: boolean };
type Props = {
  sessionId: string;
  scopeKey: string;
  active: boolean;
  workers: { total: number; active: number; idle: number; awaiting: number; uncertain: number };
  workerProjection: WorkerProjection;
  sources: readonly InteractionSource[];
  onFeedback: (notice: Feedback) => void;
};

/** Include auth lifetime as well as native identity; a same-ID login is not the same scope. */
function contextKey(state: ReturnType<typeof store.snapshot>, sessionId: string, scopeKey: string) {
  const conversation = state.conversations.find(row => row.id === sessionId);
  return JSON.stringify([
    scopeKey, sessionId, state.config?.storeId, conversation?.nativeSessionId,
    conversation?.authorityId, conversation?.harness, store.sessionNameScope(sessionId),
    state.selected, state.phase, state.config?.authenticated, state.connected, !!conversation,
  ]);
}

function contextReady(sessionId: string) {
  const state = store.snapshot();
  return !!sessionId && state.selected === sessionId && state.phase === "ready"
    && state.config?.authenticated === true && !!state.config.storeId && state.connected
    && state.conversations.some(row => row.id === sessionId);
}

/** Call unconditionally in the composer so pending operations outlive panel visibility.
 * The parent owns scrolling, navigation, and retained list feedback.
 */
export function useInteractionActions({ sessionId, scopeKey, active, workers, workerProjection, sources, onFeedback }: Props): ReactNode {
  const key = useStore(state => contextKey(state, sessionId, scopeKey));
  const identity = useRef({ key });
  const latest = useRef({ sessionId, scopeKey, active, workers, sources, onFeedback });
  latest.current = { sessionId, scopeKey, active, workers, sources, onFeedback };
  const mounted = useRef(false);
  const flights = useRef(new Set<object>());
  const reads = useRef(new Map<string, object>());
  const [, render] = useState(0);
  const [feedback, setFeedback] = useState<{ token: object; notice: Feedback } | null>(null);
  const [confirmation, setConfirmation] = useState<{ token: object; visit: object } | null>(null);
  const confirmationRef = useRef(confirmation);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  // Observe store transitions synchronously too: A -> B -> A must retire A's
  // callbacks even when React batches those updates into a single render.
  const reconcile = () => {
    const props = latest.current;
    const next = contextKey(store.snapshot(), props.sessionId, props.scopeKey);
    if (identity.current.key !== next) identity.current = { key: next };
    return identity.current;
  };
  const token = reconcile();
  const visit = useRef({ token, active });
  if (visit.current.token !== token || visit.current.active !== active) {
    visit.current = { token, active };
    confirmationRef.current = null;
    if (confirmation) setConfirmation(null);
  }
  const currentVisit = visit.current;
  const current = (captured: object, requireActive = false) => mounted.current
    && reconcile() === captured && contextReady(latest.current.sessionId)
    && (!requireActive || latest.current.active);

  useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = store.subscribe(() => { reconcile(); });
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useLayoutEffect(() => {
    if (confirmation && confirmation.visit === currentVisit && active) keepButton.current?.focus({ preventScroll: true });
  }, [confirmation, currentVisit, active]);

  const announce = (captured: object, notice: Feedback) => {
    if (!current(captured)) return;
    setFeedback({ token: captured, notice });
    latest.current.onFeedback(notice);
  };
  const ready = active && contextReady(sessionId);
  const busy = flights.current.has(token);
  const confirming = confirmation?.token === token && confirmation.visit === currentVisit && active;
  const notice = feedback?.token === token ? feedback.notice : null;

  const beginConfirmation = () => {
    if (!current(token, true) || visit.current !== currentVisit || flights.current.has(token) || latest.current.workers.total <= 0) return;
    // The scope is captured now, not reconstructed from a stale Confirm callback.
    const next = { token, visit: currentVisit };
    confirmationRef.current = next;
    setConfirmation(next);
  };
  const keepWorkers = () => {
    if (!current(token, true) || visit.current !== currentVisit || flights.current.has(token)) return;
    confirmationRef.current = null;
    setConfirmation(null);
    cancelButton.current?.focus({ preventScroll: true });
  };
  const cancel = async () => {
    const confirmed = confirmationRef.current;
    if (!confirmed || confirmed !== confirmation || confirmed.token !== token || confirmed.visit !== visit.current
      || !current(token, true) || flights.current.has(token) || latest.current.workers.total <= 0) return;
    const parent = latest.current.sessionId;
    flights.current.add(token); // Synchronous lock, before any callback or await.
    confirmationRef.current = null;
    setConfirmation(null);
    announce(token, { text: "Requesting worker cancellation… Inspect worker status for confirmation.", error: false });
    try {
      // Parent feedback can synchronously navigate; re-check immediately at the write.
      if (!current(token)) return;
      // Do not substitute main-conversation/native cancellation or abort on hide.
      await workerClient.stop(parent, { all: true });
      announce(token, { text: "Cancellation requested; inspect worker status for confirmation", error: false });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      announce(token, {
        text: `Cancellation acceptance is unconfirmed. The request may have been received; inspect worker status before retrying.${detail}`,
        error: true,
      });
    } finally {
      flights.current.delete(token);
      if (current(token)) render(value => value + 1);
    }
  };
  const refresh = async (id: string) => {
    if (!current(token, true) || visit.current !== currentVisit || reads.current.get(id) === token) return;
    const source = latest.current.sources.find(row => row.id === id);
    if (!source?.retry || source.disabled || source.loading) return;
    reads.current.set(id, token);
    render(value => value + 1);
    try {
      // Source callbacks are GET refreshes only; the source owner fences its data.
      await source.retry();
    } catch (error) {
      announce(token, {
        text: `${source.label} refresh could not be confirmed. Known items may be incomplete.${error instanceof Error ? ` ${error.message}` : ""}`,
        error: true,
      });
    } finally {
      if (reads.current.get(id) === token) reads.current.delete(id);
      if (current(token)) render(value => value + 1);
    }
  };

  return <div className="interaction-actions-content">
    <ChatCard density="compact" aria-labelledby={`${id}-workers`}>
      <ChatCardBody className="interaction-actions-section">
        <h3 id={`${id}-workers`}>Workers</h3>
        <dl className="interaction-actions-counts">
          {([["Total", workers.total], ["Active", workers.active], ["Idle", workers.idle], ["Awaiting", workers.awaiting], ["Unconfirmed", workers.uncertain]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <WorkerPanelNotices projection={workerProjection} />
        <p>Includes nested SANE workers, regardless of current filters. Does not stop the main conversation or native subagents.</p>
        {confirming ? <div className="interaction-actions-confirmation" role="group" aria-labelledby={`${id}-confirm`} aria-describedby={`${id}-confirm-detail`}>
          <strong id={`${id}-confirm`}>Cancel all workers in this conversation tree?</strong>
          <p id={`${id}-confirm-detail`}>This requests cancellation, including idle assignments. Worker status may take time to update.</p>
          <div className="interaction-actions-buttons">
            <ChatButton variant="danger" icon={<FiSquare size={13} />} disabled={!ready || workers.total <= 0} busy={busy} onClick={() => void cancel()}>Confirm cancellation</ChatButton>
            <ChatButton ref={keepButton} disabled={busy} onClick={keepWorkers}>Keep workers</ChatButton>
          </div>
        </div> : <div className="interaction-actions-buttons">
          <ChatButton ref={cancelButton} variant="danger" icon={<FiSquare size={13} />} disabled={!ready || workers.total <= 0} busy={busy} aria-expanded={false} onClick={beginConfirmation}>Cancel all workers…</ChatButton>
          {workers.total === 0 && <span className="interaction-actions-muted">No known workers to cancel.</span>}
        </div>}
        {!ready && <p role="status">Worker controls are unavailable until this conversation is selected, authenticated, and connected.</p>}
        {busy && <ChatNotice tone="info" role="status">Requesting worker cancellation… Inspect worker status for confirmation.</ChatNotice>}
        {notice && (!busy || notice.error) && <ChatNotice tone={notice.error ? "warning" : "info"} role={notice.error ? "alert" : "status"}>{notice.text}</ChatNotice>}
      </ChatCardBody>
    </ChatCard>
    <ChatCard density="compact" aria-labelledby={`${id}-sources`}>
      <ChatCardBody className="interaction-actions-section">
        <h3 id={`${id}-sources`}>Sources &amp; coverage</h3>
        <p>Refreshes only read source data. Known items can remain visible while loading or after an error; incomplete coverage is not evidence that no interactions exist.</p>
        <ul className="interaction-actions-sources">{sources.map(source => {
          const loading = source.loading || reads.current.get(source.id) === token;
          return <li key={source.id} className="interaction-actions-source">
            <div className="interaction-actions-source-heading">
              <strong>{source.label}</strong>
              <ChatStatus tone={source.error || source.partial ? "warning" : "neutral"} busy={loading}>{loading ? "Loading…" : source.error ? "Refresh unavailable" : source.partial ? "Partial coverage" : "Available"}</ChatStatus>
              {source.retry && <ChatButton variant="ghost" icon={<FiRefreshCw size={13} />} disabled={!ready || source.disabled} busy={loading} aria-label={`${source.error ? "Retry" : "Refresh"} ${source.label}`} onClick={() => void refresh(source.id)}>{source.error ? "Retry" : "Refresh"}</ChatButton>}
            </div>
            {source.detail && <p>{source.detail}</p>}
            {source.partial && <p>Coverage is partial; additional items may not be loaded.</p>}
            {source.error && <ChatNotice tone="warning" role="alert">{source.error} Known items may be stale or incomplete.</ChatNotice>}
            {source.disabled && <p>Refresh is temporarily unavailable for this source.</p>}
          </li>;
        })}</ul>
        {!sources.length && <p>No source status is available for this conversation.</p>}
      </ChatCardBody>
    </ChatCard>
  </div>;
}

/** Compatibility wrapper; use the hook above when the panel conditionally mounts. */
export function InteractionActions(props: Props): ReactNode {
  return useInteractionActions(props);
}
