import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FiArrowUpRight, FiBriefcase, FiInfo } from "react-icons/fi";
import type { NativeSubagentKey, NativeSubagentSummary } from "../src/native-subagent-contract";
import { nativeSubagentId } from "./native-subagent-presentation";
import { NativeSubagentClient, useNativeSubagentClient } from "./native-subagent-client";
import type { ToolPart } from "./types";
import "./native-subagent.css";

type Selection = { client: NativeSubagentClient; summary: NativeSubagentSummary; trigger: HTMLButtonElement; viewport: HTMLElement | null };
export type NativeSubagentFeature = ReturnType<typeof useNativeSubagentFeature>;
export const NativeSubagentContext = createContext<NativeSubagentFeature | null>(null);
export const useNativeSubagents = () => useContext(NativeSubagentContext);

export function useNativeSubagentFeature(sessionId: string, enabled: boolean, visible: boolean, identity = sessionId) {
  const { client, state } = useNativeSubagentClient(sessionId, enabled, identity);
  const [selection, setSelection] = useState<Selection | null>(null);
  const restore = useRef<Selection | null>(null);
  const active = selection?.client === client && selection.summary.parentSessionId === sessionId ? selection : null;
  const id = active ? nativeSubagentId(active.summary) : "";
  useEffect(() => { setSelection(null); restore.current = null; }, [client]);
  useEffect(() => { client.activate(enabled && visible && active ? active.summary : null); return () => client.activate(null); }, [client, enabled, visible, id]);
  useLayoutEffect(() => {
    const saved = restore.current;
    if (selection || !saved || !visible) return;
    if (saved.client !== client) { restore.current = null; return; }
    const frame = requestAnimationFrame(() => {
      const replacement = saved.viewport?.isConnected ? [...saved.viewport.querySelectorAll<HTMLButtonElement>("[data-native-subagent-trigger]")].find(button => button.dataset.nativeSubagentTrigger === nativeSubagentId(saved.summary)) : undefined;
      const trigger = saved.trigger.isConnected ? saved.trigger : replacement;
      if (trigger) trigger.focus({ preventScroll: true });
      else if (saved.viewport?.isConnected) { saved.viewport.tabIndex = -1; saved.viewport.focus({ preventScroll: true }); }
      restore.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [selection, visible, client]);
  const open = (summary: NativeSubagentSummary, trigger: HTMLButtonElement) => {
    if (summary.parentSessionId !== sessionId) return;
    restore.current = null;
    const viewport = trigger.closest<HTMLElement>(".viewport");
    setSelection({ client, summary, trigger, viewport });
  };
  const back = () => { restore.current = active; setSelection(null); };
  const snapshot = active ? state.details.get(id) : undefined;
  const summary = (active && state.summaries.get(id)) ?? active?.summary;
  const summaries = state.summaries;
  const summaryKnown = !!active && state.summaries.has(id);
  return { client, state, active, snapshot, summary, summaryKnown, summaries, open, back };
}

export function NativeSubagentCard({ summary, recorded = true, tool }: { summary: NativeSubagentSummary; recorded?: boolean; tool?: ToolPart }) {
  const feature = useNativeSubagents();
  const id = useId();
  const [reportOpen, setReportOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const name = summary.name ?? summary.toolName;
  const attention = [tool?.error && "reported tool error", !!summary.warnings?.length && "recorded evidence warnings", summary.status === "unknown" && "unconfirmed status"].filter(Boolean).join(", ");
  const detailsLabel = `Native subagent details (${name})${attention ? `, attention needed: ${attention}` : ""}`;
  const countLabel = recorded ? `Recorded child tool calls: ${summary.toolCallCount}` : "Recorded child tool calls unavailable";
  const statusClass = `${summary.status === "running" ? " is-active" : ""}${summary.status === "failed" ? " is-error" : ""}${summary.status === "unknown" ? " is-uncertain" : ""}`;
  const output = tool?.output !== undefined && !tool.error ? typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2) : undefined;
  return <section className="native-subagent-card" aria-label={`Native subagent · ${name}`}>
    <header><FiBriefcase className="native-subagent-glyph" size={20} aria-hidden="true" /><div className="native-subagent-card-heading"><h3>{name}</h3><span className="native-subagent-badge">Native</span></div><span className={`worker-status ${summary.status}${statusClass}`} data-status={summary.status} role="status">{summary.status === "unknown" ? "unconfirmed" : summary.status}</span></header>
    <div className="native-subagent-card-actions">
      <div className="worker-actions">
        <button type="button" className="worker-action" disabled={!feature} data-native-subagent-trigger={nativeSubagentId(summary)} aria-label={`Open read-only subagent activity (${name})`} title={`Open read-only subagent activity (${name})`} onClick={event => feature?.open(summary, event.currentTarget)}><FiArrowUpRight size={13} aria-hidden="true" />Open</button>
        {summary.returnedReport && <button type="button" className="worker-action" aria-label={`Returned report (${name})`} title={`Returned report (${name})`} aria-expanded={reportOpen} aria-controls={`${id}-report`} onClick={() => setReportOpen(open => !open)}>Report</button>}
      </div>
      <div className="worker-actions worker-secondary-actions">
        <span className="native-subagent-count" aria-label={countLabel} title={countLabel}>{recorded ? `${summary.toolCallCount} call${summary.toolCallCount === 1 ? "" : "s"}` : "Calls unavailable"}</span>
        <button type="button" className="worker-action native-subagent-info" aria-label={detailsLabel} title={detailsLabel} aria-expanded={detailsOpen} aria-controls={`${id}-details`} onClick={() => setDetailsOpen(open => !open)}><FiInfo size={13} aria-hidden="true" />Details{attention && <span className="native-subagent-attention" aria-hidden="true" />}</button>
      </div>
    </div>
    {summary.returnedReport && <div className="native-subagent-disclosure" id={`${id}-report`} hidden={!reportOpen}><h4>Returned report</h4><pre>{summary.returnedReport}</pre></div>}
    <div className="native-subagent-disclosure" id={`${id}-details`} hidden={!detailsOpen}>
      <h4>Assignment</h4><p className="native-subagent-full-assignment">{summary.assignment || "No assignment recorded."}</p>
      <p className="muted">Read-only · Recorded activity only, not a complete native session history. Counts reflect recorded child tool calls, not a native run total.{!recorded && " Recorded tool count unavailable."}</p>
      {summary.status === "unknown" && <p className="muted">Status is unconfirmed by recorded native evidence.</p>}
      {output !== undefined && output !== summary.returnedReport && <><h4>Delegation tool output</h4><pre>{output}</pre></>}
      {tool?.error && <div className="run-warning"><h4>Reported tool error</h4><pre>{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output ?? { error: true }, null, 2)}</pre></div>}
      {!!summary.warnings?.length && <div className="run-warning"><h4>Recorded evidence warnings</h4>{summary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    </div>
  </section>;
}

export function NativeSubagentDiscovery({ loaded }: { loaded: Set<string> }) {
  const feature = useNativeSubagents();
  if (!feature) return null;
  const summaries = [...feature.summaries].filter(([id]) => !loaded.has(id));
  return <>{!!summaries.length && <section className="native-subagent-discovery" aria-label="Native subagents outside loaded parent history"><p className="eyebrow">Native subagents · recorded outside loaded parent history</p>{summaries.map(([id, summary]) => <NativeSubagentCard key={id} summary={summary} />)}</section>}
    {feature.state.error && <p className="notice error" role="alert">Native subagent summaries unavailable: {feature.state.error}<button type="button" className="text-button" disabled={feature.state.loading} onClick={feature.client.retryList}>Retry</button></p>}
    {feature.state.nextCursor && <button type="button" className="text-button" disabled={feature.state.loading} onClick={feature.client.loadMoreSummaries}>Load more native subagents</button>}
  </>;
}

export const nativeSubagentVirtualKey = (key: NativeSubagentKey) => `native-subagent:${nativeSubagentId(key)}`;
