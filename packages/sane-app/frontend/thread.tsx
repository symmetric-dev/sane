import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkerDelivery, WorkerRecord } from "../src/worker-contract";
import { useWorkers, openWorker, workerReference } from "./worker-client";
import { WorkerCard, WorkerOutcomeReport, WorkerSection } from "./worker-ui";
import { dispatchedWorkers, workerReportDelivery } from "./worker-presentation";
import type { Harness, PendingTurn, ToolPart } from "./types";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { ChatComposer } from "./chat-composer";
import { ChatScroll } from "./chat-scroll";
import { ConversationLoading, PendingUserText } from "./chat-loading";
import { messagesWithPendingTurn } from "./transcript";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FiArrowLeft, FiArrowUpRight, FiCopy, FiZap } from "react-icons/fi";
import { store, type State } from "./store";
import { Interactions } from "./interactions";
import { catalog } from "./catalog";
import { BranchAction, BranchLinks } from "./branch-ui";
import { active, type Message, type Run, type UsageSnapshot } from "./types";
import { activityPosition, useActivityPresentation, type ActivityEntry, type ActivityPresentation } from "./transcript-activity";
import { TranscriptActivity } from "./activity-ui";

const json = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "Unavailable";
const number = (value: unknown, suffix = "") => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}${suffix}` : "Unavailable";

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [feedback, setFeedback] = useState("");
  return <button type="button" className="copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setFeedback("Copied"); } catch { setFeedback("Copy unavailable"); } }} aria-label={feedback || label}><FiCopy size={13} aria-hidden="true" />{feedback || label}</button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState("");
  return <div className="code-block"><button className="copy" type="button" onClick={async () => { try { await navigator.clipboard.writeText(ref.current?.textContent || ""); setCopied("Copied"); } catch { setCopied("Copy unavailable"); } }}>{copied || "Copy code"}</button><pre ref={ref}>{children}</pre></div>;
}
function Markdown({ text }: { text: string }) {
  return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ pre: CodeBlock, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="muted">[Image: {alt || "image omitted"}]</span> }}>{text}</ReactMarkdown></div>;
}

export type TranscriptContextValue = { sessionId: string; harness: Harness; messages: Message[]; runs: Run[]; workers: WorkerRecord[]; deliveries?: WorkerDelivery[]; openWorker: (worker: WorkerRecord) => void; branchEnabled?: boolean; pendingTurn?: PendingTurn | null; activities?: ActivityPresentation };
export const TranscriptContext = createContext<TranscriptContextValue | null>(null);
const isActivityMessage = (message: Message) => message.role === "assistant" && message.parts.some(part => part.type !== "text") && !message.parts.some(part => part.type === "text" && part.text.trim()) && message.error === undefined && message.status !== "failed" && message.status !== "interrupted";
function ActivityBody({ part }: ActivityEntry) {
  return part.type === "reasoning" ? <Markdown text={part.text} /> : <><p className="eyebrow">Input</p><pre>{json(part.input)}</pre>{part.output !== undefined && <><p className="eyebrow">{part.error ? "Error" : "Output"}</p><pre>{json(part.output)}</pre></>}</>;
}
const renderActivityBody = (entry: ActivityEntry) => <ActivityBody {...entry} />;
function TranscriptTool({ part, source }: { part: ToolPart; source: Message }) {
  const context = useContext(TranscriptContext)!;
  const workers = dispatchedWorkers(context.sessionId, source, part, context.workers);
  // Open worker already contains the assignment. Keep raw tool evidence in run
  // diagnostics rather than duplicating the instructions in the parent thread.
  if (workers.length) return <>{workers.map(worker => <WorkerCard key={worker.id} worker={worker} workers={context.workers} runs={context.runs} open={context.openWorker} />)}{part.error && <p className="notice error" role="alert">Worker tool reported an error. Open run details for the recorded evidence.</p>}</>;
  const entry: ActivityEntry = { id: JSON.stringify([source.id, "tool", part.id]), source, index: source.parts.indexOf(part), part };
  return <TranscriptActivity group={{ id: entry.id, entries: [entry] }} renderBody={renderActivityBody} />;
}
export function ChatMessage() {
  const message = useAuiState(s => s.message);
  const context = useContext(TranscriptContext)!;
  const harness = context.harness;
  const sourceIndex = context.messages.findIndex(m => m.id === message.id);
  const source = context.messages[sourceIndex];
  const isUser = message.role === "user";
  const pending = isUser && context.pendingTurn?.id === message.id ? context.pendingTurn : null;
  // Native records are separate messages, but identity belongs to the user turn.
  // System notices retain their own label without resetting assistant identity.
  const previousSpeaker = context.messages.slice(0, Math.max(0, sourceIndex)).findLast(m => m.role !== "system");
  const showLabel = !isUser && (source?.role === "system" || !source || previousSpeaker?.role !== "assistant");
  const next = context.messages[sourceIndex + 1];
  const continued = source?.role === "assistant" && next?.role === "assistant";
  const activity = !!source && isActivityMessage(source);
  const activityContinued = continued && activity && isActivityMessage(next) && !next.parts.every((_, index) => context.activities?.plan.positions.get(activityPosition(next.id, index)) === null);
  const plain = message.content.filter(p => p.type === "text").map(p => p.text).join("\n\n");
  const lastInTurn = source && (source.runId === "native-import" ? context.messages.slice(context.messages.indexOf(source) + 1).find(m => m.role === "assistant" || m.role === "user")?.role !== "assistant" : !context.messages.slice(context.messages.indexOf(source) + 1).some(m => m.runId === source.runId && m.role === "assistant"));
  const canBranch = context.branchEnabled && source?.role === "assistant" && lastInTurn && (source.runId === "native-import" ? harness === "opencode" && source.status === "completed" : context.runs.some(r => r.id === source.runId && r.status === "completed"));
  const delivery = source && workerReportDelivery(source, context.deliveries ?? []);
  if (delivery) return <MessagePrimitive.Root className="message worker-report-message"><WorkerOutcomeReport delivery={delivery} workers={context.workers} /></MessagePrimitive.Root>;
  const warning = source?.error !== undefined || !isUser && source?.runId !== "native-import" && message.status?.type === "incomplete";
  const consumed = source?.parts.length && source.parts.every((_, index) => context.activities?.plan.positions.get(activityPosition(source.id, index)) === null);
  if (consumed && !showLabel && !warning && !plain && !canBranch) return null;
  return <MessagePrimitive.Root className={`message ${isUser ? "user-message" : "assistant-message"}${continued ? " assistant-continued" : ""}${activity ? " activity-message" : ""}${activityContinued ? " assistant-activity-continued" : ""}`}>
    {showLabel && <div className="assistant-label"><FiZap size={13} aria-hidden="true" /> {source?.role === "system" ? "System" : "Assistant"}</div>}
    <div className={isUser ? "user-bubble" : "assistant-body"}>
      {pending ? <PendingUserText text={pending.text} sending={!pending.runId} /> : source ? source.parts.map((part, index) => {
        if (part.type === "text") return isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} />;
        const position = activityPosition(source.id, index);
        if (context.activities?.plan.positions.has(position)) {
          const group = context.activities.plan.positions.get(position);
          return group ? <TranscriptActivity key={group.id} group={group} entrances={context.activities.entrances} renderBody={renderActivityBody} /> : null;
        }
        if (part.type === "tool") return <TranscriptTool key={part.id} part={part} source={source} />;
        const entry: ActivityEntry = { id: JSON.stringify([source.id, "reasoning", part.id ?? index]), source, index, part };
        return <TranscriptActivity key={entry.id} group={{ id: entry.id, entries: [entry] }} renderBody={renderActivityBody} />;
      }) : message.content.map((part, index) => {
        if (part.type === "text") return isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} />;
        if (part.type === "tool-call") {
          const fallback: Message = { id: message.id, runId: "native-import", role: "assistant", parts: [], time: "", status: message.status?.type === "running" ? "running" : "completed" };
          return <TranscriptTool key={part.toolCallId} source={fallback} part={{ type: "tool", id: part.toolCallId, name: part.toolName, input: part.args, output: part.result, error: part.isError }} />;
        }
        return null;
      })}
      {source?.error !== undefined && <details className="run-warning"><summary>Reported error</summary><pre>{json(source.error)}</pre></details>}
      {!isUser && source?.runId !== "native-import" && message.status?.type === "incomplete" && <p className="run-warning" role="status">{message.status.reason === "error" ? "This run failed. The response may be incomplete." : "This run was interrupted or its completion is unknown."} See details for the recorded evidence.</p>}
    </div>
    {!isUser && (plain || canBranch) && <div className="message-actions">{plain && <Copy text={plain} label="Copy" />}
    {canBranch && source && <BranchAction sessionId={context.sessionId} harness={harness} {...(source.runId === "native-import" ? { messageId: source.id } : { runId: source.runId })} />}</div>}
  </MessagePrimitive.Root>;
}

export function convertMessage(message: Message): ThreadMessageLike {
  const content = message.parts.filter(part => part.type !== "reasoning").map(part => part.type !== "tool" ? { type: "text" as const, text: part.text } : ({ type: "tool-call" as const, toolCallId: part.id, toolName: part.name, args: (part.input && typeof part.input === "object" ? part.input : { value: part.input ?? null }) as Record<string, any>, argsText: json(part.input), ...(part.output !== undefined ? { result: part.output, isError: part.error } : {}) }));
  if (!content.length) content.push({ type: "text", text: "" });
  return { id: message.id, role: message.role === "system" ? "assistant" : message.role, content, ...(message.time ? { createdAt: new Date(message.time) } : {}), ...(message.role !== "user" ? { status: active(message.status) ? { type: "running" as const } : message.status === "completed" ? { type: "complete" as const, reason: "stop" as const } : { type: "incomplete" as const, reason: message.status === "failed" ? "error" as const : "other" as const } } : {}) };
}

export function Thread({ state, active: isActive = true, navigation }: { state: State; active?: boolean; navigation?: ReactNode }) {
  const projection = useWorkers(state.selected);
  const workers = projection.workers;
  const parentId = workerReference(state.selected)?.parent.sessionId;
  const [ack, setAck] = useState("");
  const needsAck = !!state.conversations.find(c => c.id === state.selected && c.harness === "claude-code")?.attachment;
  const conversation = state.conversations.find(c => c.id === state.selected);
  useEffect(() => setAck(""), [state.selected, isActive]);
  const send = (text: string) => { const stopped = ack === state.selected && !!ack; setAck(""); return store.send(text, stopped); };
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const harness = store.harness();
  const workspace = store.workspace();
  const modelUnavailable = store.modelUnavailable();
  useEffect(() => { if (harness === "opencode" && (state.modelsCwd !== workspace || (!state.modelsLoaded && !state.modelsLoading && !state.modelsError))) { const timer = setTimeout(() => void store.loadModels(), 300); return () => clearTimeout(timer); } }, [harness, workspace, state.modelsCwd, state.modelsLoaded, state.modelsLoading, state.modelsError]);
  const running = state.runs.some(run => active(run.status));
  const nativeIssue = [...state.runs].reverse().find(run => active(run.status) && run.nativeConnection && run.nativeConnection !== "connected");
  const latestRun = state.runs.at(-1);
  const pendingTurn = state.pendingTurn?.conversationId === state.selected ? state.pendingTurn : null;
  const messages = useMemo(() => messagesWithPendingTurn(state.messages, pendingTurn), [state.messages, pendingTurn]);
  const activities = useActivityPresentation({ sessionId: state.selected, messages, workers, deliveries: projection.deliveries, loading: state.loading, animate: isActive && state.connected && !state.actionBusy });
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isRunning: running,
    isSendDisabled: !isActive || running || state.loading || state.sending || !state.connected || !state.availability.canSend || modelUnavailable || !!store.executionUnavailable() || (needsAck && ack !== state.selected),
    onNew: async message => { const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n"); await send(text); },
  });
  const sendDisabled = !isActive || running || state.loading || state.sending || !state.connected || !state.availability.canSend || modelUnavailable || !!store.executionUnavailable() || (needsAck && ack !== state.selected);
  const footer = <ChatComposer state={state} active={isActive} navigation={navigation} ack={ack} onAckChange={setAck} send={send} sendDisabled={sendDisabled} parentId={parentId} />;
  return <TranscriptContext.Provider value={{ sessionId: state.selected, harness, messages, runs: state.runs, workers, deliveries: projection.deliveries, openWorker, pendingTurn, activities, branchEnabled: !state.loading && !state.sending && !running && !parentId && !conversation?.worker && !conversation?.replacedBy && !(conversation?.attachment && harness === "claude-code") }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread">
    <BranchLinks key={state.selected} conversation={conversation} />
    {parentId && <nav className="worker-parent-nav" aria-label="Worker navigation"><button type="button" className="text-button" disabled={state.sending} onClick={() => store.openConversation(parentId)}><FiArrowLeft size={14} aria-hidden="true" />Back to parent</button><span className="muted">Worker conversation</span></nav>}
    <ChatScroll resetKey={state.selected || `new:${repository.navigation.worktreeId}`} footer={footer}>
      <div className="transcript">
        {!messages.length && (state.loading || !repository.ready || (state.selected && state.connectionError) ? <ConversationLoading label={state.selected ? state.connectionError ? "Reconnecting to your conversation…" : "Opening conversation…" : "Preparing your workspace…"} /> : !state.selected ? <div className="welcome"><span className="welcome-mark" aria-hidden="true"><FiZap size={44} aria-hidden="true" /></span><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>What shall we work on?</h1><p>Explore an idea, untangle a problem, or build something useful with SANE.</p><div className="suggestions">{["Help me understand this project", "Plan a thoughtful next step", "Review my recent changes"].map(text => <button key={text} type="button" onClick={() => store.setDraft({ text })}>{text}<FiArrowUpRight size={13} aria-hidden="true" /></button>)}</div></div> : <div className="chat-empty"><FiZap size={24} aria-hidden="true" /><p>No messages yet.</p><span>Send a message to begin.</span></div>)}
        <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
        {running && <p className="working" role="status"><span className="pulse" />{!state.connected ? "Connection unavailable. The run’s current state is not yet known." : nativeIssue ? nativeIssue.nativeReason || "Assistant connection unavailable; execution state remains unconfirmed." : "Assistant is working. New output will appear here."}{store.capabilities()?.cancelRun && <button type="button" className="text-button" disabled={state.actionBusy || !state.connected} onClick={() => void store.cancel()}>Stop run</button>}</p>}
        {latestRun?.status === "failed" && latestRun.nativeReason && <p className="notice error" role="alert">Run failed: {latestRun.nativeReason}</p>}
        {harness === "opencode" && !conversation?.replacedBy ? <Interactions state={state} /> : <>{state.actionNotice && <p role="status" className="notice">{state.actionNotice}</p>}{state.interactionError && <p role="alert" className="notice error">{state.interactionError}</p>}</>}
      </div>
    </ChatScroll>
  </ThreadPrimitive.Root></AssistantRuntimeProvider></TranscriptContext.Provider>;
}

export function Facts({ values }: { values: [string, ReactNode][] }) { return <dl className="facts">{values.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "Unavailable"}</dd></div>)}</dl>; }

export function NativeHistoryDetails({ state }: { state: State }) {
  if (!state.selected) return null;
  const conversation = state.conversations.find(c => c.id === state.selected);
  return <section className="detail-section"><h3>Conversation history</h3><p className="muted">Refresh messages recorded outside the App. This does not send a message or stop a run.</p><button type="button" className="text-button" disabled={state.actionBusy || state.sending || state.loading || state.runs.some(run => active(run.status)) || !state.connected} onClick={() => void store.reconcile()}>{state.actionBusy ? "Refreshing…" : "Refresh native history"}</button>{state.nativeHistory && <p className="muted">Last refreshed {new Date(state.nativeHistory.importedAt).toLocaleString()}</p>}{conversation?.attachment && conversation.harness === "claude-code" && <p className="muted">This imported conversation cannot be branched because a completed turn cannot be verified.</p>}{state.interactionError && <p className="notice error" role="alert">{state.interactionError}</p>}</section>;
}

export function Usage({ snapshot }: { snapshot?: UsageSnapshot }) {
  if (!snapshot) return <p className="muted">Unavailable — no associated terminal result has been recorded.</p>;
  const r = snapshot.record;
  return <><p className="muted">Latest reported snapshot, not a sum or a live counter. Received {new Date(snapshot.time).toLocaleString()}.</p>{(r.is_error || r.subtype !== "success") && <p className="run-warning">Error result: metrics may be partial or zeroed. They do not prove no usage occurred.</p>}<Facts values={[["Estimated cost", number(r.total_cost_usd, " USD")], ["Input tokens", number(r.usage?.input_tokens)], ["Output tokens", number(r.usage?.output_tokens)], ["Cache read", number(r.usage?.cache_read_input_tokens)], ["Cache write", number(r.usage?.cache_creation_input_tokens)], ["Duration", number(r.duration_ms, " ms")], ["API duration", number(r.duration_api_ms, " ms")], ["CLI turns", number(r.num_turns)]]} /><p className="muted">Main-loop tokens exclude subagents. Model totals include query-pipeline subagents/internal calls and may include earlier resumed runs; auxiliary calls outside that pipeline are excluded. USD is an estimate, not a subscription bill.</p>{r.modelUsage && typeof r.modelUsage === "object" && !Array.isArray(r.modelUsage) ? Object.entries(r.modelUsage).map(([name, value]) => { const m = value as any; return <details key={name}><summary>{name}</summary><Facts values={[["Input", number(m?.inputTokens)], ["Output", number(m?.outputTokens)], ["Cache read", number(m?.cacheReadInputTokens)], ["Cache write", number(m?.cacheCreationInputTokens)], ["Estimated cost", number(m?.costUSD, " USD")]]} /></details>; }) : <p className="muted">Per-model breakdown unavailable.</p>}</>;
}

export function NativeUsage({ run }: { run?: Run }) {
  if (!run?.nativeUsage) return <p className="muted">Unavailable — no native usage snapshot has been recorded.</p>;
  return <><p className="muted">Latest native message snapshot, not a total across messages or runs. Received {run.nativeUsageTime ? new Date(run.nativeUsageTime).toLocaleString() : "at an unknown time"}.</p><Facts values={[["Reported cost", number(run.nativeUsage.cost)]]} /><details><summary>Reported tokens</summary><pre>{json(run.nativeUsage.tokens)}</pre></details></>;
}

export function RunDetails({ run }: { run: Run }) {
  return <><WorkerSection sessionId={run.conversationId} runId={run.id} /><RunDiagnostics run={run} /></>;
}
function RunDiagnostics({ run }: { run: Run }) {
  const hooks = run.events.filter(e => e.kind === "hook");
  return <details className="run-detail"><summary><span>{new Date(run.createdAt).toLocaleString()}</span><span className={`status ${run.status}`}>{run.status}</span></summary><Facts values={[["Run ID", run.id], ["Conversation ID", run.conversationId], ["Native session ID", run.nativeSessionId], ["Launch directory", run.cwd], ["Agent", run.profileId ? store.profile(run.profileId)?.label ?? run.profileId : run.agent || undefined], ["Requested model", run.model || "Native default / unchanged"], ["Observed model", run.observedModel], ["Requested effort / variant", run.effort || "Native default / unchanged"], ["Observed effort / variant", run.observedEfforts.join(", ") || "Unavailable"], ["Native connection", run.nativeConnection], ["Status detail", run.nativeReason]]} />{!run.messages.some(m => m.role === "user") && <p className="muted">Original prompt unavailable in this older log.</p>}<details><summary>Reported usage</summary>{run.harness === "opencode" ? <NativeUsage run={run} /> : <>{run.resultCount > 1 && <p className="run-warning">Multiple terminal results: only the first associated snapshot is displayed.</p>}<Usage snapshot={run.usage} /></>}</details>{run.harness !== "opencode" && <details><summary>Hooks · {hooks.length}</summary>{hooks.map(e => <pre key={e.seq}>{json(e)}</pre>)}</details>}<details><summary>Raw events · {run.events.length}</summary>{run.events.map(e => <pre key={e.seq}>{json(e)}</pre>)}</details></details>;
}
