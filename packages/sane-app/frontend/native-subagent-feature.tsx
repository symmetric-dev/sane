import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiArrowUpRight, FiBriefcase, FiInfo } from "react-icons/fi";
import type { NativeSubagentKey, NativeSubagentSummary } from "../src/native-subagent-contract";
import { nativeSubagentId } from "./native-subagent-presentation";
import { NativeSubagentClient, useNativeSubagentClient } from "./native-subagent-client";
import type { ToolPart } from "./types";
import { ChatButton, ChatCard, ChatCardHeader, ChatDisclosure, ChatNotice, ChatStatus } from "./chat-ui";
import "./native-subagent.css";

type Selection = { client: NativeSubagentClient; summary: NativeSubagentSummary; trigger: HTMLButtonElement; viewport: HTMLElement | null };
export type NativeSubagentFeature = ReturnType<typeof useNativeSubagentFeature>;
export const NativeSubagentContext = createContext<NativeSubagentFeature | null>(null);
export const useNativeSubagents = () => useContext(NativeSubagentContext);

export function useNativeSubagentFeature(sessionId: string, enabled: boolean, visible: boolean, identity = sessionId) {
  const { client, state } = useNativeSubagentClient(sessionId, enabled && visible, identity);
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
  const [reportOpen, setReportOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const name = summary.name ?? summary.toolName;
  const attention = [tool?.error && "reported tool error", !!summary.warnings?.length && "recorded evidence warnings", summary.status === "unknown" && "unconfirmed status"].filter(Boolean).join(", ");
  const detailsLabel = `Native subagent details (${name})${attention ? `, attention needed: ${attention}` : ""}`;
  const countLabel = recorded ? `Recorded child tool calls: ${summary.toolCallCount}` : "Recorded child tool calls unavailable";
  const output = tool?.output !== undefined && !tool.error ? typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2) : undefined;
  return <ChatCard density="compact" className="native-subagent-card" aria-label={`Native subagent · ${name}`}>
    <ChatCardHeader title={name} headingLevel={3} icon={<FiBriefcase size={20} />}
      metadata={<><ChatStatus>Native</ChatStatus><ChatStatus tone={summary.status === "failed" ? "danger" : summary.status === "unknown" ? "warning" : summary.status === "completed" ? "success" : "neutral"} busy={summary.status === "running"} data-status={summary.status} role="status">{summary.status === "unknown" ? "unconfirmed" : summary.status}</ChatStatus><span className="native-subagent-count" aria-label={countLabel} title={countLabel}>{recorded ? `${summary.toolCallCount} call${summary.toolCallCount === 1 ? "" : "s"}` : "Calls unavailable"}</span></>}
      actions={<ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />} disabled={!feature} data-native-subagent-trigger={nativeSubagentId(summary)} aria-label={`Open read-only subagent activity (${name})`} title={`Open read-only subagent activity (${name})`} onClick={event => feature?.open(summary, event.currentTarget)}>Open</ChatButton>} />
    {summary.returnedReport && <ChatDisclosure className="native-subagent-card-disclosure" title={`Returned report (${name})`} open={reportOpen} onOpenChange={setReportOpen}><pre>{summary.returnedReport}</pre></ChatDisclosure>}
    <ChatDisclosure className="native-subagent-card-disclosure" title={<><FiInfo size={13} aria-hidden="true" /> Details{attention && <><span className="native-subagent-attention" aria-hidden="true" /><span className="sr-only">{detailsLabel}</span></>}</>} open={detailsOpen} onOpenChange={setDetailsOpen}>
      <h4>Assignment</h4><p className="native-subagent-full-assignment">{summary.assignment || "No assignment recorded."}</p>
      <p className="muted">Read-only · Recorded activity only, not a complete native session history. Counts reflect recorded child tool calls, not a native run total.{!recorded && " Recorded tool count unavailable."}</p>
      {summary.status === "unknown" && <p className="muted">Status is unconfirmed by recorded native evidence.</p>}
      {output !== undefined && output !== summary.returnedReport && <><h4>Delegation tool output</h4><pre>{output}</pre></>}
      {tool?.error && <ChatNotice tone="danger" title="Reported tool error"><pre>{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output ?? { error: true }, null, 2)}</pre></ChatNotice>}
      {!!summary.warnings?.length && <ChatNotice tone="warning" title="Recorded evidence warnings">{summary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</ChatNotice>}
    </ChatDisclosure>
  </ChatCard>;
}

export function NativeSubagentDiscovery({ loaded }: { loaded: Set<string> }) {
  const feature = useNativeSubagents();
  if (!feature) return null;
  const summaries = [...feature.summaries].filter(([id]) => !loaded.has(id));
  return <>{!!summaries.length && <section className="native-subagent-discovery" aria-label="Native subagents outside loaded parent history"><p className="eyebrow">Native subagents · recorded outside loaded parent history</p>{summaries.map(([id, summary]) => <NativeSubagentCard key={id} summary={summary} />)}</section>}
    {feature.state.error && <ChatNotice tone="warning" role="alert" actions={<ChatButton disabled={feature.state.loading} onClick={feature.client.retryList}>Retry</ChatButton>}>Native subagent summaries unavailable: {feature.state.error}</ChatNotice>}
    {feature.state.nextCursor && <ChatButton variant="ghost" disabled={feature.state.loading} onClick={feature.client.loadMoreSummaries}>Load more native subagents</ChatButton>}
  </>;
}

export const nativeSubagentVirtualKey = (key: NativeSubagentKey) => `native-subagent:${nativeSubagentId(key)}`;
