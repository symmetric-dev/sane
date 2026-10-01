import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { store, type State } from "./store";
import { Interactions } from "./interactions";
import { WorkspaceHeader, WorkspaceProvider, WorkspaceSidebar, WorkspaceView, workspaceHasDirtyBuffers, resetWorkspaceState } from "./workspace";
import type { ActiveView } from "./workspace-controller";
import { TerminalHeader, TerminalProvider, TerminalSidebar, TerminalView } from "./terminal";
import { catalog } from "./catalog";
import { CatalogSelector, worktreeLabel } from "./catalog-selector";
import { ShellDialog } from "./shell-dialog";
import { active, harnessName, type Harness, type Message, type Run, type UsageSnapshot } from "./types";
import "./style.css";
import "./catalog.css";

const json = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "Unavailable";
const number = (value: unknown, suffix = "") => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}${suffix}` : "Unavailable";
function Icon({ name }: { name: "menu" | "plus" | "close" | "send" | "details" | "down" }) {
  const paths = { menu: "M4 6h16M4 12h16M4 18h16", plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", send: "M12 19V5m-6 6 6-6 6 6", details: "M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", down: "M12 5v14m-6-6 6 6 6-6" };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
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
function ChatMessage({ harness }: { harness: Harness }) {
  const message = useAuiState(s => s.message);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const source = state.messages.find(m => m.id === message.id);
  const isUser = message.role === "user";
  const plain = message.content.filter(p => p.type === "text").map(p => p.text).join("\n\n");
  return <MessagePrimitive.Root className={`message ${isUser ? "user-message" : "assistant-message"}`}>
    {!isUser && <div className="assistant-label"><span className="small-mark">✳</span> {source?.role === "system" ? `${harnessName(harness)} · System` : harnessName(harness)}</div>}
    <div className={isUser ? "user-bubble" : "assistant-body"}>
      {source?.normalized ? source.parts.map((part, index) => part.type === "reasoning" ? <details className="tool reasoning" key={index}><summary>Reasoning</summary><div className="tool-body"><Markdown text={part.text} /></div></details> : part.type === "text" ? isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} /> : <details className="tool" key={part.id}><summary><span>{part.name}</span><span className="tool-status">{part.toolStatus || (part.error ? "Failed" : "Tool")}</span></summary><div className="tool-body"><p className="eyebrow">Input</p><pre>{json(part.input)}</pre>{part.output !== undefined && <><p className="eyebrow">{part.error ? "Error" : "Output"}</p><pre>{json(part.output)}</pre></>}</div></details>) : message.content.map((part, index) => {
        if (part.type === "text") return isUser ? <p key={index} className="user-text">{part.text}</p> : <Markdown key={index} text={part.text} />;
        if (part.type === "tool-call") return <details className="tool" key={part.toolCallId}><summary><span className="tool-glyph" aria-hidden="true">⌘</span><span>{part.toolName}</span><span className="tool-status">{part.result !== undefined ? part.isError ? "Failed" : "Result" : message.status?.type === "running" ? "Working" : "No result recorded"}</span></summary><div className="tool-body"><p className="eyebrow">Input</p><pre>{json(part.args)}</pre>{part.result !== undefined && <><p className="eyebrow">{part.isError ? "Error" : "Output"}</p><pre>{json(part.result)}</pre></>}</div></details>;
        return null;
      })}
      {source?.error !== undefined && <details className="run-warning"><summary>Reported error</summary><pre>{json(source.error)}</pre></details>}
      {!isUser && message.status?.type === "incomplete" && <p className="run-warning" role="status">{message.status.reason === "error" ? "This run failed. The response may be incomplete." : "This run was interrupted or its completion is unknown."} See details for the recorded evidence.</p>}
    </div>
    {!isUser && plain && <div className="message-actions"><Copy text={plain} label="Copy" /></div>}
  </MessagePrimitive.Root>;
}
function convertMessage(message: Message): ThreadMessageLike {
  const content = message.parts.filter(part => part.type !== "reasoning").map(part => part.type !== "tool" ? { type: "text" as const, text: part.text } : ({ type: "tool-call" as const, toolCallId: part.id, toolName: part.name, args: (part.input && typeof part.input === "object" ? part.input : { value: part.input ?? null }) as Record<string, any>, argsText: json(part.input), ...(part.output !== undefined ? { result: part.output, isError: part.error } : {}) }));
  if (!content.length) content.push({ type: "text", text: "" });
  return { id: message.id, role: message.role === "system" ? "assistant" : message.role, content, createdAt: new Date(message.time), ...(message.role !== "user" ? { status: active(message.status) ? { type: "running" as const } : message.status === "completed" ? { type: "complete" as const, reason: "stop" as const } : { type: "incomplete" as const, reason: message.status === "failed" ? "error" as const : "other" as const } } : {}) };
}
function Thread({ state }: { state: State }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const draft = store.draft();
  const harness = store.harness();
  const workspace = store.workspace();
  const modelUnavailable = store.modelUnavailable();
  const efforts = harness === "opencode" ? state.modelsCwd === workspace ? state.models.find(m => m.id === draft.model)?.efforts ?? [] : [] : (store.capabilities()?.effortValues ?? state.config?.capabilities?.effortValues ?? []).map(id => ({ id, name: `${id[0]?.toUpperCase()}${id.slice(1)} effort` }));
  useEffect(() => { if (harness === "opencode" && (state.modelsCwd !== workspace || (!state.modelsLoaded && !state.modelsLoading && !state.modelsError))) { const timer = setTimeout(() => void store.loadModels(), 300); return () => clearTimeout(timer); } }, [harness, workspace, state.modelsCwd, state.modelsLoaded, state.modelsLoading, state.modelsError]);
  const running = state.runs.some(run => active(run.status));
  const nativeIssue = [...state.runs].reverse().find(run => active(run.status) && run.nativeConnection && run.nativeConnection !== "connected");
  const latestRun = state.runs.at(-1);
  const runtime = useExternalStoreRuntime({ messages: state.messages, convertMessage, isRunning: running,
    isSendDisabled: state.sending || !state.connected || !state.availability.canSend || modelUnavailable || !!store.executionUnavailable(),
    onNew: async message => { const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n"); await store.send(text); },
  });
  useEffect(() => { runtime.thread.composer.setText(store.draft().text); }, [runtime, state.selected, state.sending, state.submissionError, state.selected ? "" : repository.navigation.worktreeId]);
  const availability = state.sending ? "Submitting your message…" : !state.connected ? "Reconnecting to the bridge…" : modelUnavailable ? state.modelsLoading ? "Loading OpenCode models…" : state.modelsError || "Choose an OpenCode model to continue." : !state.availability.canSend ? state.availability.reason || "A run is active in this bridge. You can keep drafting." : "One message, one run. Follow up when it finishes.";
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread">
    <ThreadPrimitive.Viewport className="viewport">
      <div className="transcript">
        {!state.messages.length && <div className="welcome"><span className="welcome-mark" aria-hidden="true">✳</span><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>{state.loading ? "Opening your conversation…" : state.selected ? "A little space to think." : "What shall we work on?"}</h1><p>{state.loading ? "Loading the bridge’s recorded history." : `Explore an idea, untangle a problem, or build something useful with ${harnessName(harness)}.`}</p>{!state.selected && <div className="suggestions">{["Help me understand this project", "Plan a thoughtful next step", "Review my recent changes"].map(text => <button key={text} type="button" onClick={() => { store.setDraft({ text }); runtime.thread.composer.setText(text); }}>{text}<span aria-hidden="true">↗</span></button>)}</div>}</div>}
        <ThreadPrimitive.Messages>{() => <ChatMessage harness={harness} />}</ThreadPrimitive.Messages>
        {running && <p className="working" role="status"><span className="pulse" />{!state.connected ? "Connection unavailable. The run’s current state is not yet known." : nativeIssue ? nativeIssue.nativeReason || "OpenCode connection unavailable; execution state remains unconfirmed." : `${harnessName(harness)} is working. New output will appear here.`}{store.capabilities()?.cancelRun && <button type="button" className="text-button" disabled={state.actionBusy || !state.connected} onClick={() => void store.cancel()}>Stop run</button>}</p>}
        {harness === "opencode" && latestRun?.status === "failed" && latestRun.nativeReason && <p className="notice error" role="alert">Run failed: {latestRun.nativeReason}</p>}
        {harness === "opencode" && <Interactions state={state} />}
      </div>
      <ThreadPrimitive.ViewportFooter className="composer-dock">
        <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to latest message"><Icon name="down" /></ThreadPrimitive.ScrollToBottom>
        {state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}
        {harness === "opencode" && state.modelsError && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></p>}
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input className="composer-input" rows={2} placeholder={state.selected ? "Continue the conversation…" : `Ask ${harnessName(harness)} anything…`} aria-label="Message" onChange={event => store.setDraft({ text: event.target.value })} />
          <div className="composer-toolbar"><div className="composer-options">
            {!state.selected && <label className="option"><span className="sr-only">Harness</span><select value={harness} disabled={state.sending} onChange={event => store.setHarness(event.target.value as Harness)} aria-label="Harness for new conversation"><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option></select></label>}
            {harness === "opencode" ? <label className="option model-option"><span className="sr-only">Model</span><select value={draft.model} disabled={state.modelsLoading || !state.models.length} onChange={event => store.setDraft({ model: event.target.value, effort: "" })} aria-label="OpenCode model"><option value="">Choose model</option>{state.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select></label> : state.config?.capabilities?.modelSelection && <label className="option model-option"><span className="sr-only">Model</span><input list="models" value={draft.model} onChange={event => store.setDraft({ model: event.target.value })} placeholder="Default model" maxLength={200} aria-label="Model (custom IDs supported)" /><datalist id="models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist></label>}
            {!!efforts.length && <label className="option"><span className="sr-only">Reasoning effort</span><select value={draft.effort} onChange={event => store.setDraft({ effort: event.target.value })} aria-label={harness === "opencode" ? "Model variant" : "Reasoning effort"}><option value="">{harness === "opencode" ? "Default variant" : "Default effort"}</option>{efforts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
          </div><ComposerPrimitive.Send className="send" aria-label="Send message" title="Send message"><Icon name="send" /></ComposerPrimitive.Send></div>
        </ComposerPrimitive.Root>
        <p className="composer-note" role="status">{store.executionUnavailable() || availability}</p>
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
function Facts({ values }: { values: [string, ReactNode][] }) { return <dl className="facts">{values.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "Unavailable"}</dd></div>)}</dl>; }
function Usage({ snapshot }: { snapshot?: UsageSnapshot }) {
  if (!snapshot) return <p className="muted">Unavailable — no associated terminal result has been recorded.</p>;
  const r = snapshot.record;
  return <><p className="muted">Latest reported snapshot, not a sum or a live counter. Received {new Date(snapshot.time).toLocaleString()}.</p>{(r.is_error || r.subtype !== "success") && <p className="run-warning">Error result: metrics may be partial or zeroed. They do not prove no usage occurred.</p>}<Facts values={[["Estimated cost", number(r.total_cost_usd, " USD")], ["Input tokens", number(r.usage?.input_tokens)], ["Output tokens", number(r.usage?.output_tokens)], ["Cache read", number(r.usage?.cache_read_input_tokens)], ["Cache write", number(r.usage?.cache_creation_input_tokens)], ["Duration", number(r.duration_ms, " ms")], ["API duration", number(r.duration_api_ms, " ms")], ["CLI turns", number(r.num_turns)]]} /><p className="muted">Main-loop tokens exclude subagents. Model totals include query-pipeline subagents/internal calls and may include earlier resumed runs; auxiliary calls outside that pipeline are excluded. USD is an estimate, not a subscription bill.</p>{r.modelUsage && typeof r.modelUsage === "object" && !Array.isArray(r.modelUsage) ? Object.entries(r.modelUsage).map(([name, value]) => { const m = value as any; return <details key={name}><summary>{name}</summary><Facts values={[["Input", number(m?.inputTokens)], ["Output", number(m?.outputTokens)], ["Cache read", number(m?.cacheReadInputTokens)], ["Cache write", number(m?.cacheCreationInputTokens)], ["Estimated cost", number(m?.costUSD, " USD")]]} /></details>; }) : <p className="muted">Per-model breakdown unavailable.</p>}</>;
}
function NativeUsage({ run }: { run?: Run }) {
  if (!run?.nativeUsage) return <p className="muted">Unavailable — no native usage snapshot has been recorded.</p>;
  return <><p className="muted">Latest native message snapshot, not a total across messages or runs. Received {run.nativeUsageTime ? new Date(run.nativeUsageTime).toLocaleString() : "at an unknown time"}.</p><Facts values={[["Reported cost", number(run.nativeUsage.cost)]]} /><details><summary>Reported tokens</summary><pre>{json(run.nativeUsage.tokens)}</pre></details></>;
}
function RunDetails({ run }: { run: Run }) {
  const hooks = run.events.filter(e => e.kind === "hook");
  return <details className="run-detail"><summary><span>{new Date(run.createdAt).toLocaleString()}</span><span className={`status ${run.status}`}>{run.status}</span></summary><Facts values={[["Run ID", run.id], ["Conversation ID", run.conversationId], ["Native session ID", run.nativeSessionId], ["Launch directory", run.cwd], ["Requested model", run.model || "Native default / unchanged"], ["Observed model", run.observedModel], ["Requested effort / variant", run.effort || "Native default / unchanged"], ["Observed effort / variant", run.observedEfforts.join(", ") || "Unavailable"], ["Native connection", run.nativeConnection], ["Status detail", run.nativeReason]]} />{!run.messages.some(m => m.role === "user") && <p className="muted">Original prompt unavailable in this older log.</p>}<details><summary>Reported usage</summary>{run.harness === "opencode" ? <NativeUsage run={run} /> : <>{run.resultCount > 1 && <p className="run-warning">Multiple terminal results: only the first associated snapshot is displayed.</p>}<Usage snapshot={run.usage} /></>}</details>{run.harness !== "opencode" && <details><summary>Hooks · {hooks.length}</summary>{hooks.map(e => <pre key={e.seq}>{json(e)}</pre>)}</details>}<details><summary>Raw events · {run.events.length}</summary>{run.events.map(e => <pre key={e.seq}>{json(e)}</pre>)}</details></details>;
}
function Drawer({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="drawer" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="drawer-content"><header><h2>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={close}><Icon name="close" /></button></header>{children}</div></dialog>;
}
function WorkspaceNavigation({ state, activeView, onNavigate }: { state: State; activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  const pending = state.interactions.length;
  const running = state.sending || state.runs.some(run => active(run.status)) || state.conversations.some(conversation => active(conversation.status));
  return <nav className="workspace-navigation" aria-label="Workspace navigation">{([{ id: "chat", label: "Chat" }, { id: "code", label: "Code" }, { id: "git", label: "Git" }, { id: "terminal", label: "Terminal" }] as const).map(view => <button type="button" key={view.id} aria-current={activeView === view.id ? "page" : undefined} onClick={() => onNavigate(view.id)}><span>{view.label}</span>{view.id === "chat" && (pending > 0 || running) && <span className={`chat-activity${pending ? " pending" : ""}`} role="status"><span className="pulse" />{pending ? `${pending} pending` : "Running"}</span>}</button>)}</nav>;
}
function SidebarFooter({ state, activeView, onNavigate }: { state: State; activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  return <footer className="shell-sidebar-footer"><WorkspaceNavigation state={state} activeView={activeView} onNavigate={onNavigate} /></footer>;
}
function History({ state, onChoose }: { state: State; onChoose: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [selection, setSelection] = useState({ workspaceId: repository.navigation.workspaceId, filter: "current" });
  const filter = selection.workspaceId === repository.navigation.workspaceId ? selection.filter : "current";
  const selectedWorkspace = repository.workspaces.find(w => w.workspaceId === repository.navigation.workspaceId);
  const unavailable = (c: State["conversations"][number]) => !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId);
  const visible = [...state.conversations].reverse().filter(c => `${c.title || ""} ${c.cwd} ${c.id} ${harnessName(c.harness)}`.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || (filter === "unavailable" ? unavailable(c) : filter === "current" ? selectedWorkspace ? c.workspaceId === selectedWorkspace.workspaceId : unavailable(c) : c.worktreeId === filter)));
  const groups = [...repository.workspaces.map(w => ({ id: w.workspaceId, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
  return <><button type="button" className="new-chat" disabled={state.sending || !repository.navigation.worktreeId} onClick={() => onChoose("")}><Icon name="plus" />New conversation</button><label className="history-search"><span className="sr-only">Search history</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search conversations" /></label><label className="history-filter"><span className="sr-only">History scope</span><select aria-label="History scope" value={filter} onChange={event => setSelection({ workspaceId: repository.navigation.workspaceId, filter: event.target.value })}><option value="current">{selectedWorkspace ? "This workspace · all worktrees" : "Unavailable workspace history"}</option>{selectedWorkspace?.worktrees.map(t => <option key={t.worktreeId} value={t.worktreeId}>{worktreeLabel(t)}</option>)}<option value="all">All recorded history</option><option value="unavailable">Unavailable workspace history</option></select></label><nav className="history-list" aria-label="Conversation history">{groups.sort((a, b) => Number(b.id === selectedWorkspace?.workspaceId) - Number(a.id === selectedWorkspace?.workspaceId)).map(group => {
    const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
    return conversations.length ? <section className="history-group" key={group.id ?? "unavailable"}>{filter === "all" && <h3>{group.name}</h3>}{conversations.map(c => <button type="button" key={c.id} className={state.selected === c.id ? "selected" : ""} aria-current={state.selected === c.id ? "page" : undefined} disabled={state.sending} onClick={() => onChoose(c.id)}><span className="history-title">{c.title || c.cwd.split("/").filter(Boolean).at(-1) || "Conversation"}</span><span className="history-meta"><span className="harness-badge">{harnessName(c.harness)}</span>{active(c.status) && <span className="pulse" />}{c.status} · {c.id.slice(0, 8)}</span><small className="history-worktree">{c.association === "resolved" ? c.cwd : "Execution workspace unavailable"}</small></button>)}</section> : null;
  })}{!visible.length && <p className="muted history-empty">No conversations in this selection.</p>}</nav></>;
}
function App() {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [drawer, setDrawer] = useState<"history" | "details" | "application" | null>(null);
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const activeView = repository.navigation.view;
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  useEffect(() => { store.start(); window.addEventListener("online", store.reconnect); document.addEventListener("visibilitychange", store.reconnect); return () => { window.removeEventListener("online", store.reconnect); document.removeEventListener("visibilitychange", store.reconnect); }; }, []);
  // Restore chat directly: the history-selection action also changes browsing and view.
  const hydrate = () => void catalog.hydrate(bookmark => store.choose(bookmark.conversationId ?? ""));
  useEffect(() => { if (state.phase === "ready") hydrate(); }, [state.phase]);
  const navigate = (view: ActiveView) => { catalog.navigate({ view }); setDrawer(null); };
  const choose = (id: string) => {
    if (state.sending) return;
    const conversation = state.conversations.find(c => c.id === id);
    catalog.navigate({ conversationId: id || null, view: "chat", ...(conversation ? { workspaceId: conversation.workspaceId ?? null, worktreeId: conversation.worktreeId ?? null, filePath: null, comparison: null } : {}) });
    store.choose(id); setDrawer(null);
  };
  const signOut = () => {
    if (workspaceHasDirtyBuffers() && !window.confirm("Discard unsaved workspace changes and sign out?")) return;
    resetWorkspaceState();
    setDrawer(null);
    void store.logout();
  };
  if (state.phase !== "ready") return <main className="auth-screen"><div className="auth-card"><span className="welcome-mark" aria-hidden="true">✳</span><p className="eyebrow">YOUR LOCAL BRIDGE</p><h1>{state.phase === "login" ? "Welcome back." : "Connecting your workspace."}</h1><p className="muted">{state.phase === "login" ? "Enter your bridge password to pick up where you left off." : "A quiet place to work with your local coding assistants."}</p>{state.phase === "login" && <form onSubmit={async event => { event.preventDefault(); setLoggingIn(true); await store.login(password); setPassword(""); setLoggingIn(false); }}><label htmlFor="password">Bridge password</label><input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} /><button className="primary-button" disabled={loggingIn}>{loggingIn ? "Signing in…" : "Open workspace"}</button></form>}{(state.authError || state.connectionError) && <p className="notice error" role="alert">{state.authError || state.connectionError}</p>}</div></main>;
  const conversation = state.conversations.find(c => c.id === state.selected);
  const executionWorkspace = repository.workspaces.find(w => w.workspaceId === conversation?.workspaceId);
  const executionWorktree = executionWorkspace?.worktrees.find(w => w.worktreeId === conversation?.worktreeId);
  const browsingMismatch = conversation && (conversation.workspaceId !== repository.navigation.workspaceId || conversation.worktreeId !== repository.navigation.worktreeId);
  const latestUsage = [...state.runs].reverse().find(r => r.usage)?.usage;
  const nativeUsageRun = [...state.runs].reverse().find(r => r.nativeUsage);
  return <WorkspaceProvider view={activeView} navigate={navigate}><TerminalProvider view={activeView}><div className={`app-shell view-${activeView}`}>
    <aside className="sidebar">{activeView === "chat" ? <History state={state} onChoose={choose} /> : activeView === "terminal" ? <TerminalSidebar /> : <WorkspaceSidebar />}<SidebarFooter state={state} activeView={activeView} onNavigate={navigate} /></aside>
    <main className="main"><header className="topbar"><button className="icon-button mobile-menu" aria-label={activeView === "chat" ? "Open conversation navigation" : activeView === "code" ? "Open file navigation" : activeView === "terminal" ? "Open terminal navigation" : "Open changes navigation"} onClick={() => setDrawer("history")}><Icon name="menu" /></button><CatalogSelector retry={hydrate} />{activeView === "chat" ? <><div className="conversation-heading"><span>{conversation?.title || (state.selected ? "Conversation" : "New conversation")}</span></div><span className="harness-badge">{harnessName(store.harness())}</span><button className="details-button" aria-label="Conversation details" onClick={() => setDrawer("details")}><Icon name="details" /><span>Details</span></button></> : activeView === "terminal" ? <TerminalHeader /> : <WorkspaceHeader />}<button type="button" className="icon-button application-opener" aria-label="Application menu" aria-haspopup="dialog" onClick={() => setDrawer("application")}><span aria-hidden="true">⋯</span><span className={`connection-dot ${state.connected ? "online" : ""}`} /></button></header>{state.connectionError && <div className="connection-notice" role="status">{state.connectionError}<button type="button" onClick={store.reconnect}>Reconnect</button></div>}{browsingMismatch && activeView !== "terminal" && <div className="execution-context" role="status"><span title={conversation.cwd}>Runs in: {executionWorktree ? worktreeLabel(executionWorktree) : conversation.cwd || "Unavailable worktree"}</span>{conversation.workspaceId && conversation.worktreeId ? <button type="button" disabled={state.sending} onClick={() => catalog.navigate({ workspaceId: conversation.workspaceId, worktreeId: conversation.worktreeId, filePath: null, comparison: null })}>Browse execution worktree</button> : <button type="button" onClick={() => setDrawer("details")}>Execution details</button>}</div>}<div className="chat-surface" style={{ display: activeView === "chat" ? undefined : "none" }}><Thread key={state.selected} state={state} /></div>{(activeView === "code" || activeView === "git") && <WorkspaceView />}{activeView === "terminal" && <TerminalView />}</main>
    {drawer === "history" && <Drawer title={activeView === "chat" ? "Conversations" : activeView === "code" ? "Files" : activeView === "terminal" ? "Terminal" : "Changes"} close={() => setDrawer(null)}>{activeView === "chat" ? <History state={state} onChoose={choose} /> : activeView === "terminal" ? <TerminalSidebar /> : <WorkspaceSidebar />}<SidebarFooter state={state} activeView={activeView} onNavigate={navigate} /></Drawer>}
    {drawer === "application" && <ShellDialog title="Application" close={() => setDrawer(null)}><div className="application-status"><span className={`connection-dot ${state.connected ? "online" : ""}`} /><span>{state.connected ? "Local bridge connected" : "Connecting to bridge"}</span></div><details className="application-connection"><summary>Connection details</summary><p className="muted">{state.connectionError || (state.connected ? "Connected to the local bridge." : "Waiting for the local bridge.")}</p><button type="button" className="text-button" onClick={store.reconnect}>Reconnect</button></details>{state.config?.authRequired && <button type="button" className="application-signout" disabled={state.sending} onClick={signOut}>Sign out</button>}</ShellDialog>}
    {drawer === "details" && <Drawer title="Conversation details" close={() => setDrawer(null)}>
      <section className="detail-section"><p className="eyebrow">EXECUTION WORKTREE</p>{!state.selected ? <label className="directory-label">Launch directory<input value={store.draft().cwd} placeholder="Selected worktree root or a subdirectory" onChange={e => store.setDraft({ cwd: e.target.value })} /><small>Defaults to the selected worktree root. Optionally choose a directory inside that worktree.</small></label> : <Facts values={[["Conversation ID", state.selected], ["Harness", harnessName(store.harness())], ["Native session ID", conversation?.nativeSessionId], ["Launch directory", conversation?.cwd], ["Workspace", conversation?.workspaceId || "Unavailable"], ["Worktree", conversation?.worktreeId || "Unavailable"]]} />}<p className="muted">Each follow-up uses this conversation’s fixed execution directory and harness. Browsing another worktree does not retarget it.</p>{conversation?.association !== "resolved" && state.selected && <p className="notice" role="status">Execution workspace unavailable. Recorded history remains accessible.</p>}</section>
      <section className="detail-section"><h3>Latest reported usage</h3>{store.harness() === "opencode" ? <>{nativeUsageRun && nativeUsageRun.id !== state.runs.at(-1)?.id && <p className="muted">Showing an earlier run’s snapshot; the latest run has no reported usage yet.</p>}<NativeUsage run={nativeUsageRun} /></> : <>{latestUsage && latestUsage.runId !== state.runs.at(-1)?.id && <p className="muted">A newer run has no result snapshot yet. Showing an earlier run.</p>}<Usage snapshot={latestUsage} /></>}</section>
      <section className="detail-section"><h3>Runs & diagnostics <span className="muted">{state.runs.length}</span></h3>{state.runs.length ? [...state.runs].reverse().map(run => <RunDetails key={run.id} run={run} />) : <p className="muted">Run IDs and raw events will appear here.</p>}</section>
    </Drawer>}
  </div></TerminalProvider></WorkspaceProvider>;
}

createRoot(document.getElementById("root")!).render(<App />);
