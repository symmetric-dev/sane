import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { FiArrowLeft } from "react-icons/fi";
import { ChatMessage, renderActivityInspectorBody, TranscriptContext, useTranscriptIndex } from "./thread";
import { ActivityInspector, useActivityInspection } from "./activity-inspector";
import { convertTranscriptMessage, projectTranscriptMessages } from "./transcript-runtime";
import { useActivityPresentation } from "./transcript-activity";
import { useNativeSubagents } from "./native-subagent-feature";

export function NativeSubagentView() {
  const feature = useNativeSubagents()!;
  const summary = feature.summary!;
  const snapshot = feature.snapshot;
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const name = summary.name ?? summary.toolName;
  const attention = [!!summary.warnings?.length && "recorded evidence warnings", summary.status === "unknown" && "unconfirmed status"].filter(Boolean).join(", ");
  const detailsLabel = `Native subagent details (${name})${attention ? `, attention needed: ${attention}` : ""}`;
  const countLabel = feature.summaryKnown ? `Recorded child tool calls: ${summary.toolCallCount}` : "Recorded child tool calls unavailable";
  const messages = useMemo(() => snapshot?.messages.map(message => ({ ...message, version: `${snapshot.revision}:${message.version ?? ""}` })) ?? [], [snapshot]);
  const transcriptIndex = useTranscriptIndex(messages);
  const runtimeMessages = useMemo(() => projectTranscriptMessages(messages), [messages]);
  const activities = useActivityPresentation({ sessionId: summary.parentSessionId, messages, workers: [], loading: !snapshot, animate: false, readOnly: true });
  const inspection = useActivityInspection({ scope: JSON.stringify(["native-subagent", summary.parentSessionId, summary.runId, summary.parentToolUseId]), active: !!snapshot, plan: activities.plan });
  const runtime = useExternalStoreRuntime({ messages: runtimeMessages, convertMessage: convertTranscriptMessage, isRunning: false, isSendDisabled: true, onNew: async () => { throw new Error("Native subagent activity is read-only."); } });
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), back = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const following = useRef(true);
  const programmedTop = useRef<number | null>(null);
  const capture = () => {
    const root = viewport.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const message = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => element.getBoundingClientRect().bottom > bounds.top);
    anchor.current = message ? { id: message.dataset.transcriptMessage!, offset: message.getBoundingClientRect().top - bounds.top } : null;
  };
  useLayoutEffect(() => {
    back.current?.focus();
    const root = viewport.current!, body = content.current!;
    const restore = () => {
      if (following.current) root.scrollTop = root.scrollHeight;
      else if (anchor.current) {
        const saved = anchor.current;
        const message = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => element.dataset.transcriptMessage === saved.id);
        if (message) root.scrollTop += message.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
      }
      programmedTop.current = root.scrollTop;
    };
    const resize = new ResizeObserver(restore); resize.observe(root); resize.observe(body);
    const mutations = new MutationObserver(restore); mutations.observe(body, { childList: true, subtree: true, characterData: true });
    restore();
    return () => { resize.disconnect(); mutations.disconnect(); };
  }, []);
  const pause = () => { following.current = false; capture(); };
  return <TranscriptContext.Provider value={{ sessionId: summary.parentSessionId, harness: summary.harness ?? "claude-code", messages, ...transcriptIndex, runs: [], workers: [], openWorker: () => {}, activities, activityScope: inspection.scope, inspectActivity: inspection.open, readOnly: true }}><section className="native-subagent-view" aria-label="Read-only native subagent activity">
    <header className="native-subagent-header">
      <nav className="native-subagent-nav" aria-label="Native subagent navigation">
        <button ref={back} type="button" className="text-button" onClick={feature.back}><FiArrowLeft aria-hidden="true" />Back to parent</button>
        <div className="native-subagent-nav-heading"><h2>{name}</h2><span className="native-subagent-badge">Native</span><span className="native-subagent-badge">Read-only</span></div>
        <div className="native-subagent-nav-summary"><span className={`status ${summary.status}`} role="status">{summary.status === "unknown" ? "unconfirmed" : summary.status}</span><span aria-hidden="true">·</span><span className="native-subagent-count" aria-label={countLabel} title={countLabel}>{feature.summaryKnown ? `${summary.toolCallCount} call${summary.toolCallCount === 1 ? "" : "s"}` : "Calls unavailable"}</span></div>
        <button type="button" className="worker-action" aria-label={detailsLabel} title={detailsLabel} aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}>Details{attention && <span className="native-subagent-attention" aria-hidden="true" />}</button>
      </nav>
      <div className="native-subagent-disclosure" id={detailsId} hidden={!detailsOpen}>
        <h4>Assignment</h4><p className="native-subagent-full-assignment">{summary.assignment || "No assignment recorded."}</p>
        <p className="muted">Recorded activity only, not a complete native session history. Counts reflect recorded child tool calls, not a native run total.{!feature.summaryKnown && " Recorded tool count unavailable."}</p>
        {summary.status === "unknown" && <p className="muted">Status is unconfirmed by recorded native evidence.</p>}
        {!!summary.warnings?.length && <div className="run-warning"><h4>Recorded evidence warnings</h4>{summary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </div>
    </header>
    <div ref={viewport} className="viewport native-subagent-viewport" style={{ overflowAnchor: "none" }} tabIndex={0} aria-label="Native subagent messages" onWheel={event => { if (event.deltaY < 0) pause(); }} onTouchStart={pause} onPointerDown={pause} onKeyDownCapture={event => { if (["ArrowUp", "PageUp", "Home", "Enter", " "].includes(event.key)) pause(); }} onClickCapture={pause} onScroll={event => {
      const root = event.currentTarget;
      if (event.target !== root) return;
      if (programmedTop.current !== null && Math.abs(root.scrollTop - programmedTop.current) < 1) { programmedTop.current = null; return; }
      following.current = root.scrollHeight - root.clientHeight - root.scrollTop < 4;
      capture();
    }}>
      <div ref={content} className="transcript">
        {feature.state.detailError && <p className="notice error" role="alert">Activity refresh unavailable: {feature.state.detailError}{snapshot && " Showing the last coherent recorded snapshot."}<button type="button" className="text-button" disabled={feature.state.detailLoading} onClick={feature.client.retryDetail}>Retry</button></p>}
        {snapshot?.nextCursor && <button type="button" className="text-button" disabled={feature.state.detailLoading} onClick={() => { pause(); feature.client.loadEarlier(); }}>Load earlier activity</button>}
        {feature.state.detailLoading && <p className="muted" role="status">{snapshot ? "Refreshing recorded activity…" : "Loading recorded activity…"}</p>}
        {!messages.length && snapshot && <p className="muted">No child messages have been recorded.{summary.returnedReport && " The returned report does not imply recorded child activity."}</p>}
        <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="native-subagent-thread"><ThreadPrimitive.Messages components={{ Message: ChatMessage }} /></ThreadPrimitive.Root></AssistantRuntimeProvider>
        {summary.returnedReport && <details className="native-subagent-returned-report"><summary>Returned report</summary><pre>{summary.returnedReport}</pre></details>}
      </div>
    </div>
    <footer className="native-subagent-footer"><button type="button" className="text-button" onClick={() => { following.current = true; anchor.current = null; if (viewport.current) { viewport.current.scrollTop = viewport.current.scrollHeight; programmedTop.current = viewport.current.scrollTop; } }}>Latest activity</button></footer>
  </section><ActivityInspector inspection={inspection} renderBody={renderActivityInspectorBody} /></TranscriptContext.Provider>;
}
