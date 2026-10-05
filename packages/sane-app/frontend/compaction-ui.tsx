import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiChevronRight, FiInfo, FiMinimize2 } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CompactionRecord } from "../src/oc-contract";
import { ShellDialog } from "./shell-dialog";
import { store, type State } from "./store";
import "./compaction.css";

const triggerLabel = { auto: "Automatic", manual: "Manual", unknown: "Unknown trigger" };
const lifecycleLabel = { requested: "requested", running: "running", completed: "completed", failed: "failed", skipped: "skipped", unconfirmed: "completion unconfirmed" };
const json = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const tokens = (value?: number) => value === undefined ? "Unavailable" : `${value.toLocaleString()} tokens`;
function duration(record: CompactionRecord) {
  const elapsed = record.durationMs ?? (record.startedAt && record.endedAt ? Date.parse(record.endedAt) - Date.parse(record.startedAt) : undefined);
  return elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0 ? "Unavailable" : elapsed < 1000 ? `${elapsed.toLocaleString()} ms` : `${(elapsed / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}
function CompactionFacts({ values }: { values: [string, string | undefined][] }) {
  return <dl className="facts">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "Unavailable"}</dd></div>)}</dl>;
}
function CompactionDetails({ record, close, trigger }: { record: CompactionRecord; close: () => void; trigger: HTMLButtonElement | null }) {
  const command = record.command ?? (record.harness === "claude-code" && record.trigger === "manual" ? { name: "/compact", args: record.instructions } : undefined);
  return createPortal(<ShellDialog title="Compaction details" className="compaction-details-dialog" close={close} restoreFocus={() => trigger}>
    <CompactionFacts values={[
      ["Trigger", triggerLabel[record.trigger]], ["Status", lifecycleLabel[record.lifecycle]],
      ["Tokens before", tokens(record.preTokens)], ["Tokens after", tokens(record.postTokens)], ["Duration", duration(record)],
      ["Command", command?.name], ["Command args", command?.args === "" ? "None" : command?.args], ["Command message", command?.message],
    ]} />
    <p className="muted">Metrics are reported by the native harness. Unavailable values were not recorded; summary token usage is not substituted for context size.</p>
    {record.instructions !== undefined && record.instructions !== command?.args && <><h3>Compaction instructions</h3><pre>{record.instructions}</pre></>}
    {command?.output !== undefined && <details><summary>Command output</summary><pre>{command.output}</pre></details>}
    {command?.notice !== undefined && <details><summary>Native command notice</summary><pre>{command.notice}</pre></details>}
    {record.error !== undefined && <><h3>Reported error</h3><pre>{json(record.error)}</pre></>}
    <details><summary>Technical details</summary><CompactionFacts values={[
      ["Harness", record.harness], ["Compaction ID", record.id], ["Native boundary ID", record.nativeId], ["Run ID", record.runId], ["Request ID", record.requestId],
      ["Started", record.startedAt], ["Ended", record.endedAt], ["Requested", record.requestedAt],
    ]} />{record.nativeMetadata && <pre>{json(record.nativeMetadata)}</pre>}</details>
  </ShellDialog>, document.body);
}
function CompactionCard({ record }: { record: CompactionRecord }) {
  const [info, setInfo] = useState(false), [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <section className={`compaction-marker compaction-card ${record.lifecycle}`} data-compaction-id={record.id} aria-label="Context compaction">
    <header><FiMinimize2 size={15} aria-hidden="true" /><span className="compaction-heading">Context compaction</span><span className="compaction-status" role="status">{triggerLabel[record.trigger]} · {lifecycleLabel[record.lifecycle]}</span><button ref={trigger} type="button" className="icon-button" aria-label="Compaction details" title="Compaction details" aria-haspopup="dialog" onClick={() => setInfo(true)}><FiInfo size={15} aria-hidden="true" /></button></header>
    <dl className="compaction-metrics"><div><dt>Before</dt><dd>{tokens(record.preTokens)}</dd></div><div><dt>After</dt><dd>{tokens(record.postTokens)}</dd></div><div><dt>Duration</dt><dd>{duration(record)}</dd></div></dl>
    <details className="compaction-summary" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}><summary><FiChevronRight size={13} aria-hidden="true" />Compaction summary</summary>{expanded && <div className="compaction-summary-body">{record.summary ? <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="muted">[Image: {alt || "image omitted"}]</span> }}>{record.summary}</ReactMarkdown></div> : <p className="muted">{record.lifecycle === "requested" || record.lifecycle === "running" ? "Waiting for the native compaction summary…" : "No compaction summary was recorded."}</p>}</div>}</details>
    {record.lifecycle === "failed" && <p className="compaction-warning" role="alert">Compaction failed. Open details for the recorded evidence.</p>}
    {info && <CompactionDetails record={record} trigger={trigger.current} close={() => setInfo(false)} />}
  </section>;
}

export function CompactionMarkers({ records = [] }: { records?: CompactionRecord[] }) {
  return <>{records.map(record => <CompactionCard key={record.id} record={record} />)}</>;
}

export function ContextControl({ state, open }: { state: State; open: () => void }) {
  const usage = state.contextUsage;
  const label = usage ? `${Math.round(usage.percentage)}%` : "—";
  return <button type="button" className="text-button context-usage" aria-haspopup="dialog" aria-label={`Context usage: ${usage ? `${label}${usage.stale ? " (stale)" : ""}` : "unavailable"}. Show context details.`} title="Context details" onClick={open}>{label}</button>;
}

export function ContextDialog({ state, close }: { state: State; close: () => void }) {
  const usage = state.contextUsage;
  const awaitingUsage = !usage && state.compactions?.some(record => record.contextReset);
  const reason = store.compactUnavailable();
  return <ShellDialog title="Context details" className="context-details-dialog" close={close}>
    {usage ? <>
      <CompactionFacts values={[
        ["Context used", `${Math.round(usage.percentage)}%`], ["Input context", tokens(usage.tokens)], ["Model window", tokens(usage.capacity)],
        ["Model", usage.model], ["Received", new Date(usage.time).toLocaleString()], ["Snapshot", usage.stale ? "Stale while compacting" : "Last reported"],
      ]} />
      {usage.stale && <p className="notice" role="status">Compaction is running; this reading is stale.</p>}
    </> : <p className="notice" role="status">{awaitingUsage ? "Awaiting updated context usage from a later assistant response. Compaction does not imply zero context usage." : "Context usage unavailable. Waiting for reported input tokens and a matching model-window capacity."}</p>}
    <p className="muted">This is the last reported input context, not a live token counter. It excludes output tokens; pending input and tool results may not be included. The percentage uses the model window, not the auto-compaction threshold.</p>
    {reason && <p className="muted">{reason}</p>}
    <div className="compact-actions"><button type="button" className="text-button" onClick={close}>Close</button><CompactControl state={state} beforeOpen={close} /></div>
  </ShellDialog>;
}

export function CompactControl({ state, beforeOpen }: { state: State; beforeOpen?: () => void }) {
  const reason = store.compactUnavailable();
  if (!store.capabilities().compaction) return null;
  return <button type="button" className="text-button compact-control" aria-haspopup="dialog" disabled={!state.selected} title={reason || "Summarize this conversation’s context without sending a message."} onClick={() => { beforeOpen?.(); store.openCompact(); }}>Compact now</button>;
}

export function CompactDialog({ state }: { state: State }) {
  return store.capabilities().compaction && state.compactDialog && state.compactDialog === state.selected ? <CompactDialogBody key={state.selected} state={state} /> : null;
}

function CompactDialogBody({ state }: { state: State }) {
  const instructionsId = useId();
  // This acknowledgment belongs only to compaction, never to the composer send.
  const [nativeStopped, setNativeStopped] = useState(false);
  const pending = state.pendingCompacts?.[state.selected];
  const busy = pending?.phase === "sending";
  const uncertain = pending?.phase === "unconfirmed";
  const locked = busy || uncertain;
  const eligibility = state.compactState?.eligibility;
  const reason = store.compactUnavailable();
  const capabilities = store.capabilities();
  const needsAck = eligibility?.requiresNativeStopped || capabilities.attachedSendRequiresNativeStopped && !!state.conversations.find(c => c.id === state.selected)?.attachment;
  const instructions = locked ? pending?.payload.instructions ?? "" : state.compactInstructions?.[state.selected] ?? "";
  const visibleOperations = state.compactions?.slice(-3);
  return <ShellDialog title="Compact context" className="compact-dialog" close={store.closeCompact}>
    <form className="compact-form" aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      const acknowledged = nativeStopped;
      setNativeStopped(false);
      void store.compact(acknowledged);
    }}>
      <p className="muted">Summarize the existing context in the native harness. This is not a conversation turn. Your message draft and pending agent upgrade are preserved.</p>
      {reason && <p className="notice" role="status">{reason}</p>}
      {capabilities.compactionInstructions && eligibility?.supportsInstructions && <label htmlFor={instructionsId}>Instructions <span className="muted">(optional)</span><textarea id={instructionsId} rows={4} maxLength={100000} value={instructions} readOnly={locked} placeholder="What should the summary preserve?" onChange={event => store.setCompactInstructions(event.target.value)} /></label>}
      {needsAck && <label className="notice compact-ack"><input type="checkbox" checked={nativeStopped} disabled={busy} onChange={event => setNativeStopped(event.target.checked)} />I confirm external assistant execution for this conversation is stopped before compacting.</label>}
      {busy && <p role="status" className="notice">Requesting compaction…</p>}
      {uncertain && <p role="status" className="notice">Acceptance is unconfirmed. This request will not be retried automatically. Check status or explicitly resume the same request.</p>}
      <CompactionMarkers records={visibleOperations} />
      {state.compactError && <p className="notice error" role="alert">{state.compactError}</p>}
      <div className="compact-actions"><button type="button" className="text-button" onClick={store.closeCompact}>Close</button><button type="button" className="text-button" disabled={busy} onClick={() => void store.refreshCompact()}>Check status</button><button type="submit" className="primary-button" disabled={busy || !!reason || !!needsAck && !nativeStopped}>{uncertain ? "Resume same request" : "Compact now"}</button></div>
      <p className="muted compact-hint">Native completion is shown only when confirmed. Stopping an App-owned run does not interrupt an external native session.</p>
    </form>
  </ShellDialog>;
}
