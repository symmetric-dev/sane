import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkerRecord } from "../src/worker-contract";
import { useWorkers, openWorker, workerReference } from "./worker-client";
import { WorkerCard, WorkerSection, WorkersButton } from "./worker-ui";
import type { Harness, ToolPart } from "./types";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { ChatInput } from "./chat-input";
import { ChatScroll } from "./chat-scroll";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FiArrowLeft, FiArrowUpRight, FiChevronDown, FiCommand, FiInfo, FiZap } from "react-icons/fi";
import { store, type State } from "./store";
import { Interactions } from "./interactions";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { Icon } from "./nav";
import { AgentAvatar } from "./agent-visuals";
import { AgentPicker } from "./agent-picker";
import { BranchAction, BranchLinks } from "./branch-ui";
import { active, harnessName, type Message, type Run, type UsageSnapshot } from "./types";

const json = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "Unavailable";
const number = (value: unknown, suffix = "") => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}${suffix}` : "Unavailable";

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [feedback, setFeedback] = useState("");
  return <button type="button" className="copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setFeedback("Copied"); } catch { setFeedback("Copy unavailable"); } }} aria-label={feedback || label}>{feedback || label}</button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState("");
  return <div className="code-block"><button className="copy" type="button" onClick={async () => { try { await navigator.clipboard.writeText(ref.current?.textContent || ""); setCopied("Copied"); } catch { setCopied("Copy unavailable"); } }}>{copied || "Copy code"}</button><pre ref={ref}>{children}</pre></div>;
}
function Markdown({ text }: { text: string }) {
  return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ pre: CodeBlock, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="muted">[Image: {alt || "image omitted"}]</span> }}>{text}</ReactMarkdown></div>;
}

export type TranscriptContextValue = { sessionId: string; harness: Harness; messages: Message[]; runs: Run[]; workers: WorkerRecord[]; openWorker: (worker: WorkerRecord) => void; branchEnabled?: boolean };
export const TranscriptContext = createContext<TranscriptContextValue | null>(null);
function TranscriptTool({ part, source }: { part: ToolPart; source: Message }) {
  const context = useContext(TranscriptContext)!;
  const workers = source.runId !== "native-import" && part.toolCallId ? context.workers.filter(w => w.parent.sessionId === context.sessionId && w.parent.runId === source.runId && w.parent.toolCallId === part.toolCallId) : [];
  return <>{workers.map(worker => <WorkerCard key={worker.id} worker={worker} workers={context.workers} runs={context.runs} open={context.openWorker} />)}<details className="tool"><summary><span>{part.name}{workers.length ? " · Raw tool input/output" : ""}</span><span className="tool-status">{part.toolStatus || (part.output !== undefined ? part.error ? "Failed" : "Result" : active(source.status) ? "Working" : "No result recorded")}</span></summary><div className="tool-body"><p className="eyebrow">Input</p><pre>{json(part.input)}</pre>{part.output !== undefined && <><p className="eyebrow">{part.error ? "Error" : "Output"}</p><pre>{json(part.output)}</pre></>}</div></details></>;
}
export function ChatMessage() {
  const message = useAuiState(s => s.message);
   const context = useContext(TranscriptContext)!;
   const harness = context.harness;
   const source = context.messages.find(m => m.id === message.id);
  const isUser = message.role === "user";
  const plain = message.content.filter(p => p.type === "text").map(p => p.text).join("\n\n");
  const lastInTurn = source && (source.runId === "native-import" ? context.messages.slice(context.messages.indexOf(source) + 1).find(m => m.role === "assistant" || m.role === "user")?.role !== "assistant" : !context.messages.slice(context.messages.indexOf(source) + 1).some(m => m.runId === source.runId && m.role === "assistant"));
  return <MessagePrimitive.Root className={`message ${isUser ? "user-message" : "assistant-message"}`}>
    {!isUser && <div className="assistant-label"><FiZap size={13} aria-hidden="true" /> {source?.role === "system" ? `${harnessName(harness)} · System` : harnessName(harness)}</div>}
    <div className={isUser ? "user-bubble" : "assistant-body"}>
      {source ? source.parts.map((part, index) => part.type === "reasoning" ? <details className="tool reasoning" key={index}><summary>Reasoning</summary><div className="tool-body"><Markdown text={part.text} /></div></details> : part.type === "text" ? isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} /> : <TranscriptTool key={part.id} part={part} source={source} />) : message.content.map((part, index) => {
        if (part.type === "text") return isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} />;
        if (part.type === "tool-call") return <details className="tool" key={part.toolCallId}><summary><FiCommand size={13} className="tool-glyph" aria-hidden="true" /><span>{part.toolName}</span><span className="tool-status">{part.result !== undefined ? part.isError ? "Failed" : "Result" : message.status?.type === "running" ? "Working" : "No result recorded"}</span></summary><div className="tool-body"><p className="eyebrow">Input</p><pre>{json(part.args)}</pre>{part.result !== undefined && <><p className="eyebrow">{part.isError ? "Error" : "Output"}</p><pre>{json(part.result)}</pre></>}</div></details>;
        return null;
      })}
      {source?.error !== undefined && <details className="run-warning"><summary>Reported error</summary><pre>{json(source.error)}</pre></details>}
      {!isUser && source?.runId !== "native-import" && message.status?.type === "incomplete" && <p className="run-warning" role="status">{message.status.reason === "error" ? "This run failed. The response may be incomplete." : "This run was interrupted or its completion is unknown."} See details for the recorded evidence.</p>}
    </div>
    {!isUser && plain && <div className="message-actions"><Copy text={plain} label="Copy response" /></div>}
    {context.branchEnabled && source?.role === "assistant" && lastInTurn && (source.runId === "native-import" ? harness === "opencode" && source.status === "completed" : context.runs.some(r => r.id === source.runId && r.status === "completed")) && <BranchAction sessionId={context.sessionId} harness={harness} {...(source.runId === "native-import" ? { messageId: source.id } : { runId: source.runId })} />}
  </MessagePrimitive.Root>;
}

export function convertMessage(message: Message): ThreadMessageLike {
  const content = message.parts.filter(part => part.type !== "reasoning").map(part => part.type !== "tool" ? { type: "text" as const, text: part.text } : ({ type: "tool-call" as const, toolCallId: part.id, toolName: part.name, args: (part.input && typeof part.input === "object" ? part.input : { value: part.input ?? null }) as Record<string, any>, argsText: json(part.input), ...(part.output !== undefined ? { result: part.output, isError: part.error } : {}) }));
  if (!content.length) content.push({ type: "text", text: "" });
  return { id: message.id, role: message.role === "system" ? "assistant" : message.role, content, ...(message.time ? { createdAt: new Date(message.time) } : {}), ...(message.role !== "user" ? { status: active(message.status) ? { type: "running" as const } : message.status === "completed" ? { type: "complete" as const, reason: "stop" as const } : { type: "incomplete" as const, reason: message.status === "failed" ? "error" as const : "other" as const } } : {}) };
}

export function Thread({ state }: { state: State }) {
  const workers = useWorkers(state.selected).workers;
  const parentId = workerReference(state.selected)?.parent.sessionId;
  const [ack, setAck] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const needsAck = !!state.conversations.find(c => c.id === state.selected && c.harness === "claude-code")?.attachment;
  const conversation = state.conversations.find(c => c.id === state.selected);
  useEffect(() => setAck(""), [state.selected]);
  const send = (text: string) => { const stopped = ack === state.selected && !!ack; setAck(""); return store.send(text, stopped); };
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const draft = store.draft();
  const harness = store.harness();
  const workspace = store.workspace();
  const modelUnavailable = store.modelUnavailable();
  const profile = store.effectiveProfile();
  // Chip modes: new conversation picks freely; a Base conversation may be upgraded once; an assistant is fixed.
  const fixed = !!state.selected && (store.conversationKind() === "assistant" || !!parentId);
  useEffect(() => { if (harness === "opencode" && (state.modelsCwd !== workspace || (!state.modelsLoaded && !state.modelsLoading && !state.modelsError))) { const timer = setTimeout(() => void store.loadModels(), 300); return () => clearTimeout(timer); } }, [harness, workspace, state.modelsCwd, state.modelsLoaded, state.modelsLoading, state.modelsError]);
  const running = state.runs.some(run => active(run.status));
  // Warn-not-fail: a saved default absent from the live per-cwd catalog does
  // not block sending; the bridge still carries the saved selection natively.
  const missingModel = store.missingModel();
  const nativeIssue = [...state.runs].reverse().find(run => active(run.status) && run.nativeConnection && run.nativeConnection !== "connected");
  const latestRun = state.runs.at(-1);
  const runtime = useExternalStoreRuntime({ messages: state.messages, convertMessage, isRunning: running,
    isSendDisabled: running || state.loading || state.sending || !state.connected || !state.availability.canSend || modelUnavailable || !!store.executionUnavailable(),
    onNew: async message => { const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n"); await send(text); },
  });
  const sendDisabled = running || state.loading || state.sending || !state.connected || !state.availability.canSend || modelUnavailable || !!store.executionUnavailable() || (needsAck && ack !== state.selected);
  const infoIssue = state.submissionError || (harness === "opencode" && state.modelsError) || store.executionUnavailable() || (!state.connected ? "Reconnecting to the bridge…" : "") || (!state.availability.canSend && state.availability.reason) || (modelUnavailable ? "Waiting for the OpenCode model catalog for this directory." : "");
  const footer = <>
        {state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}
        {harness === "opencode" && state.modelsError && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></p>}
        {needsAck && <label className="notice"><input type="checkbox" checked={ack === state.selected} onChange={e => setAck(e.target.checked ? state.selected : "")} />I confirm external Claude execution for this conversation is stopped before this send.</label>}
        {missingModel && <p className="notice" role="status">Model {missingModel} is not in the current OpenCode catalog for this directory. Sending will still use this selection.</p>}
        {state.conversations.find(c => c.id === state.selected)?.attachment?.state === "pending" && <p className="notice error">Attachment incomplete. Use Attach native conversation with the same ID and checkout to retry. {state.conversations.find(c => c.id === state.selected)?.attachment?.error}</p>}
         {!conversation?.replacedBy && <form className="composer" onSubmit={event => { event.preventDefault(); if (!sendDisabled) void send(store.draft().text); }}>
          <ChatInput key={store.draftKey()} text={draft.text} save={text => store.setDraft({ text })} submit={() => { if (!sendDisabled) void send(store.draft().text); }} className="composer-input" rows={2} placeholder={state.selected ? "Continue the conversation…" : `Ask ${harnessName(harness)} anything…`} aria-label="Message" />
          <div className="composer-toolbar"><div className="composer-options">
            {profile ? fixed
              ? <span className="agent-chip fixed" role="status" title={profile.label}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span></span>
              : <button type="button" className="agent-chip" aria-haspopup="dialog" disabled={state.sending} title={profile.label} aria-label={`${state.selected ? "Agent" : "Agent for new conversation"}: ${profile.label}${store.pendingUpgrade() ? " (pending)" : ""}`} onClick={() => setPickerOpen(true)}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span>{store.pendingUpgrade() && <span className="agent-chip-pending">pending</span>}<FiChevronDown size={12} aria-hidden="true" /></button>
              : <span className="agent-chip fixed" role="status" title={store.agent() || "Base"}><span className="agent-chip-label">{store.agent() || "Base"}</span></span>}
          </div><div className="composer-actions"><WorkersButton key={state.selected} sessionId={state.selected} /><button type="button" className={`composer-help${infoIssue ? " has-issue" : ""}`} aria-label={infoIssue ? `Sending messages help: ${infoIssue}` : "Sending messages help"} title="Sending messages" onClick={() => setHelpOpen(true)}><FiInfo size={14} aria-hidden="true" />{infoIssue ? <span className="composer-help-dot" aria-hidden="true" /> : null}</button><button type="submit" className="send" disabled={sendDisabled || !draft.text.trim()} aria-label="Send message" title="Send message"><Icon name="send" /></button></div></div>
         </form>}
        {pickerOpen && <AgentPicker close={() => setPickerOpen(false)} />}
        {helpOpen && <ShellDialog title="Sending messages" close={() => setHelpOpen(false)}><div className="composer-help-notes">{infoIssue ? <p className="notice error" role="alert">{infoIssue}{harness === "opencode" && state.modelsError ? <> <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></> : null}</p> : null}<p className="muted">Enter inserts a newline · Ctrl/Cmd+Enter sends. Other conversations can run concurrently.</p><p className="muted">Concurrent conversations in this checkout share files; their edits can overlap.</p><p className="muted">External Claude activity cannot be detected here. Finish it in Claude before sending to this same conversation.</p></div></ShellDialog>}
      </>;
  return <TranscriptContext.Provider value={{ sessionId: state.selected, harness, messages: state.messages, runs: state.runs, workers, openWorker, branchEnabled: !parentId && !conversation?.worker && !conversation?.replacedBy }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread">
    <BranchLinks key={state.selected} conversation={conversation} />
    {conversation?.attachment && harness === "claude-code" && <p className="notice">Branching is unavailable for imported Claude conversations: complete-turn and idle evidence cannot be established.</p>}
    {parentId && <nav className="worker-parent-nav" aria-label="Worker navigation"><button type="button" className="text-button" disabled={state.sending} onClick={() => store.openConversation(parentId)}><FiArrowLeft size={14} aria-hidden="true" />Back to parent</button><span className="muted">Worker conversation</span></nav>}
    <ChatScroll resetKey={state.selected || `new:${repository.navigation.worktreeId}`} footer={footer}>
      <div className="transcript">
        {!state.messages.length && <div className="welcome"><span className="welcome-mark" aria-hidden="true"><FiZap size={44} aria-hidden="true" /></span><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>{state.loading ? "Opening your conversation…" : state.selected ? "A little space to think." : "What shall we work on?"}</h1><p>{state.loading ? "Loading the bridge’s recorded history." : `Explore an idea, untangle a problem, or build something useful with ${harnessName(harness)}.`}</p>{!state.selected && <div className="suggestions">{["Help me understand this project", "Plan a thoughtful next step", "Review my recent changes"].map(text => <button key={text} type="button" onClick={() => store.setDraft({ text })}>{text}<FiArrowUpRight size={13} aria-hidden="true" /></button>)}</div>}</div>}
        {state.selected && <p className="notice"><button type="button" disabled={state.actionBusy || running || !state.connected} onClick={() => void store.reconcile()}>Reconcile native history</button> Query/import only; does not stop or resume native work.</p>}
        {state.nativeHistory && <p className="notice" role="status">Native snapshot imported {new Date(state.nativeHistory.importedAt).toLocaleString()} · activity {state.nativeHistory.activity}. {state.nativeHistory.reason}</p>}
        {harness === "claude-code" && state.nativeHistory && <details className="notice"><summary>Native Claude transcript snapshot · separate from App run history</summary><p>Run correspondence is unavailable. App submissions and failures below are preserved.</p>{state.nativeHistory.messages.map(message => <section key={message.messageId}><strong>{message.role}</strong>{message.parts.map(part => part.type === "tool" ? <details key={part.id}><summary>{part.name} · {part.status}</summary><pre>{json(part.input)}</pre><pre>{json(part.output ?? part.error)}</pre></details> : <Markdown key={part.id} text={part.text} />)}</section>)}</details>}
        <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
        {running && <p className="working" role="status"><span className="pulse" />{!state.connected ? "Connection unavailable. The run’s current state is not yet known." : nativeIssue ? nativeIssue.nativeReason || "OpenCode connection unavailable; execution state remains unconfirmed." : `${harnessName(harness)} is working. New output will appear here.`}{store.capabilities()?.cancelRun && <button type="button" className="text-button" disabled={state.actionBusy || !state.connected} onClick={() => void store.cancel()}>Stop run</button>}</p>}
        {state.sending && !running && <p className="working" role="status"><span className="pulse" />Submitting… New output will appear here.</p>}
        {latestRun?.status === "failed" && latestRun.nativeReason && <p className="notice error" role="alert">Run failed: {latestRun.nativeReason}</p>}
        {harness === "opencode" ? <Interactions state={state} /> : <>{state.actionNotice && <p role="status" className="notice">{state.actionNotice}</p>}{state.interactionError && <p role="alert" className="notice error">{state.interactionError}</p>}</>}
      </div>
    </ChatScroll>
  </ThreadPrimitive.Root></AssistantRuntimeProvider></TranscriptContext.Provider>;
}

export function Facts({ values }: { values: [string, ReactNode][] }) { return <dl className="facts">{values.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "Unavailable"}</dd></div>)}</dl>; }

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
