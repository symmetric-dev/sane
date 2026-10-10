import { useEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { ScienceBlock, ScienceOperation, ScienceChatRequest, ScienceChatResponse, ScienceChatState, ScienceShareSnapshot, ScienceTranscriptAnchor } from "../shared/science-chat-contract";
import type { ScienceResponse, ScienceStatus } from "../shared/science-contract";
import { workspaceEditorTheme } from "./workspace-theme";
import { store, type State } from "./store";
import { catalog } from "./catalog";
import { pendingInteractions } from "./interaction-presentation";
import { ShellDialog } from "./shell-dialog";
import { ScienceOutput, ScienceTextOutput } from "./science-output";
import "./science-chat.css";

export interface ScienceChatIntegration {
  /** Stage the backend-frozen object in the conversation's attachment draft. Return false if scope changed. */
  stageShare?: (snapshot: ScienceShareSnapshot, conversationId: string) => boolean | Promise<boolean>;
}
function lastCanonicalMessage(state: State) {
  // Store messages precede pending-turn, queued-followup and coverage-gap UI projections.
  return state.messages.filter(message => message.id !== state.pendingTurn?.id && !message.queuedFollowup).at(-1);
}
const defaultIntegration: ScienceChatIntegration = {
  stageShare: (snapshot, conversationId) => {
    if (store.snapshot().selected !== conversationId) return false;
    store.stageScienceSnapshot(snapshot, conversationId);
    return store.snapshot().selected === conversationId && !!store.draft(conversationId).scienceSnapshots?.some(item => item.snapshotId === snapshot.id);
  },
};
type View = { flow: boolean; management: boolean; busy: boolean; runningBlockId?: string; loaded: boolean; error: string; draftErrorBlockId?: string; note: string; chat?: ScienceChatState; status?: ScienceStatus; selected: string; drafts: Record<string, { source: string; revision: number }> };
function identity(state: State) {
  const c = state.conversations.find(item => item.id === state.selected);
  const navigation = catalog.snapshot().navigation;
  return JSON.stringify([state.selected, c?.workspaceId, c?.worktreeId, c?.cwd, c?.harness, c?.authorityId, c?.nativeSessionId, c?.replacedBy, state.config?.storeId, state.config?.authenticated, navigation.workspaceId, navigation.worktreeId, navigation.view]);
}

export function useScienceChat(state: State, active: boolean, blocked: boolean, integration: ScienceChatIntegration = defaultIntegration) {
  const scope = identity(state);
  const c = state.conversations.find(item => item.id === state.selected);
  const workspaceId = c?.workspaceId, worktreeId = c?.worktreeId, conversationId = state.selected;
  const available = !!conversationId && !!workspaceId && !!worktreeId && !c?.replacedBy && state.config?.authenticated === true;
  const views = useRef(new Map<string, View>());
  let view = views.current.get(scope);
  if (!view) { view = { flow: false, management: false, busy: false, loaded: false, error: "", note: "", selected: "", drafts: {} }; views.current.set(scope, view); }
  const v = view;
  const [, render] = useState(0);
  const live = useRef({ scope, active, blocked, epoch: 0, integration });
  if (live.current.scope !== scope || live.current.active !== active || live.current.blocked !== blocked) live.current.epoch++;
  live.current = { ...live.current, scope, active, blocked, integration };
  useEffect(() => { live.current.active = active; return () => { live.current.active = false; live.current.epoch++; }; }, [active]);
  const valid = () => live.current.active && live.current.scope === scope && identity(store.snapshot()) === scope && catalog.snapshot().navigation.view === "chat";
  const allowed = () => {
    const current = store.snapshot();
    return valid() && available && !live.current.blocked && current.config?.authenticated === true && !current.loading && !current.sending && !current.actionBusy && !store.pendingInputChainLocked() && !pendingInteractions(current, store.capabilities()).length;
  };
  const update = () => { if (valid()) render(n => n + 1); };
  const base = `/api/workspaces/${encodeURIComponent(workspaceId ?? "")}/worktrees/${encodeURIComponent(worktreeId ?? "")}/science`;
  const url = `${base}/chats/${encodeURIComponent(conversationId)}`;
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Science request failed (${response.status}).`);
    return data;
  }
  const apply = (chat: ScienceChatState) => {
    if (chat.conversationId !== conversationId || chat.workspaceId !== workspaceId || chat.worktreeId !== worktreeId) throw new Error("Science response belongs to another conversation.");
    v.chat = chat;
    if (!chat.blocks.some(block => block.id === v.selected)) v.selected = chat.blocks[0]?.id ?? "";
    for (const block of chat.blocks) if (v.drafts[block.id]?.source === block.source) delete v.drafts[block.id];
  };
  async function perform(action?: ScienceChatRequest, after?: (chat: ScienceChatState, current: () => boolean) => Promise<void>) {
    if (!available || !valid() || v.busy || action && !allowed()) return;
    const epoch = live.current.epoch;
    const current = () => valid() && live.current.epoch === epoch;
    v.busy = true; v.runningBlockId = action?.action === "run" ? action.blockId : undefined; v.error = ""; v.draftErrorBlockId = undefined; update();
    try {
      const result = await request<ScienceChatResponse>(url, action);
      if (!current()) return;
      apply(result.chat);
      if (after && allowed()) await after(result.chat, current);
      return result.chat;
    } catch (error) {
      if (current()) {
        v.error = `${error instanceof Error ? error.message : "Science request failed."}${action ? " Outcome may be unknown. Refresh local history before retrying." : ""}`;
        v.draftErrorBlockId = action?.action === "draft" ? action.blockId : undefined;
      }
    } finally {
      v.busy = false; v.runningBlockId = undefined; v.loaded = true;
      if (!current()) { v.loaded = false; v.note = "Observation interrupted. Refresh local history before another operation."; }
      update();
    }
  }
  async function environment() {
    if (!allowed() || v.busy) return;
    const epoch = live.current.epoch;
    v.busy = true; v.error = ""; v.draftErrorBlockId = undefined; update();
    try { const result = await request<ScienceResponse>(base); if (valid() && live.current.epoch === epoch) v.status = result.status; }
    catch (error) { if (valid() && live.current.epoch === epoch) v.error = error instanceof Error ? error.message : "Status unavailable."; }
    finally { v.busy = false; update(); }
  }
  const saveDraft = async (blockId = v.selected) => {
    const block = v.chat?.blocks.find(item => item.id === blockId);
    if (!block || v.drafts[block.id] === undefined) return;
    await perform({ action: "draft", blockId: block.id, expectedRevision: v.drafts[block.id].revision, source: v.drafts[block.id].source });
  };
  const code = v.drafts[v.selected]?.source ?? v.chat?.blocks.find(block => block.id === v.selected)?.source ?? "";
  const dirtyDrafts = JSON.stringify(v.drafts);
  // GET reads App history only: opening a conversation never starts a runtime.
  useEffect(() => { if (active && available && !v.loaded && !v.busy) void perform(); }, [scope, active, available, v.loaded, v.busy]);
  useEffect(() => {
    if (blocked || !active || v.busy || v.error) return;
    // Drain every dirty block, regardless of the editor selection. Each draft
    // retains its original CAS revision; navigation still fences the scope.
    const blockId = Object.keys(v.drafts).find(id => v.chat?.blocks.some(block => block.id === id));
    if (!blockId) return;
    const timer = setTimeout(() => { if (allowed()) void saveDraft(blockId); }, 700);
    return () => clearTimeout(timer);
  }, [scope, active, blocked, dirtyDrafts, v.busy, v.error]);
  const share = (blockId: string, operationId: string | null) => {
    const block = v.chat?.blocks.find(item => item.id === blockId);
    const operation = operationId ? v.chat?.operations.find(item => item.id === operationId && item.blockId === blockId) : undefined;
    if (!block || !live.current.integration.stageShare || operationId && !operation || !operationId && v.drafts[blockId] !== undefined) return;
    const requestId = crypto.randomUUID();
    void perform({ action: "share", requestId, blockId, expectedRevision: operation?.revision ?? block.revision, operationId, representation: operation?.observation?.text ? "source-and-observed-text" : "source" }, async (chat, current) => {
      const snapshot = chat.shares.find(item => item.requestId === requestId);
      if (!snapshot) throw new Error("The frozen share snapshot was not returned.");
      if (!current() || !allowed()) return;
      const staged = await live.current.integration.stageShare?.(snapshot, conversationId);
      if (!current()) return;
      v.note = staged ? "Snapshot added to your chat draft." : "Snapshot saved locally; it was not staged in the chat draft.";
      if (staged) v.flow = false;
    });
  };
  return {
    view: v, scope, available, code, disabled: blocked || !active || v.busy, canShare: !!integration.stageShare,
    hasAnchorMessage: !!lastCanonicalMessage(state),
    addBlock: (atStart = false) => {
      if (!allowed() || v.busy || !v.chat) return;
      const last = lastCanonicalMessage(store.snapshot());
      if (!atStart && !last) { v.error = "No canonical message is loaded. Choose a start anchor explicitly."; update(); return; }
      const anchor: ScienceTranscriptAnchor = atStart ? { kind: "start" } : { kind: "after-message", messageId: last!.id };
      const requestId = crypto.randomUUID();
      void perform({ action: "add-block", requestId, expectedRevision: v.chat.revision, source: "", anchor }, async (chat, current) => {
        if (!current()) return;
        const added = chat.blocks.find(block => block.creation?.requestId === requestId);
        if (!added) throw new Error("The new block was not returned. Refresh local history before trying again.");
        v.selected = added.id; v.flow = true;
        v.note = added.creation?.state === "created" ? "New local Python block created." : "Block creation is unconfirmed. Its durable record is retained; it has not been retried.";
      });
    },
    start: () => { if (!allowed()) return; v.flow = true; update(); void perform({ action: "open" }); },
    back: () => { if (!valid()) return; v.flow = false; v.management = false; update(); },
    manage: () => { if (!allowed()) return; v.management = true; update(); void environment(); },
    dismissManagement: () => { v.management = false; update(); },
    refresh: () => void perform(),
    close: () => void perform({ action: "close" }, async (_chat, current) => { if (current()) v.note = "Notebook runtime closed. Local blocks, drafts and operation history are retained."; }),
    provision: () => void perform({ action: "provision" }, async (_chat, current) => {
      if (!current() || !allowed()) return;
      const opened = await request<ScienceChatResponse>(url, { action: "open" } satisfies ScienceChatRequest);
      if (current()) apply(opened.chat);
    }),
    associate: (notebook: string) => { if (v.chat) void perform({ action: "associate-existing", expectedRevision: v.chat.revision, notebook }); },
    select: (id: string) => { if (!allowed() || v.busy) return; v.selected = id; v.flow = true; update(); },
    save: (source: string) => { if (!allowed() || v.busy) return; const block = v.chat?.blocks.find(item => item.id === v.selected); if (!block) return; v.drafts[v.selected] = { source, revision: v.drafts[v.selected]?.revision ?? block.revision }; update(); },
    discardDraft: () => {
      if (!allowed() || v.busy) return;
      delete v.drafts[v.selected];
      if (v.draftErrorBlockId === v.selected) { v.error = ""; v.draftErrorBlockId = undefined; }
      update();
    },
    saveDraft,
    run: (blockId = v.selected) => { const block = v.chat?.blocks.find(item => item.id === blockId); if (block && v.drafts[block.id] === undefined) void perform({ action: "run", requestId: crypto.randomUUID(), blockId: block.id, expectedRevision: block.revision }); },
    share,
    addEntry: async (text: string) => { if (v.chat && text.trim()) return !!await perform({ action: "entry", expectedRevision: v.chat.revision, afterBlockId: v.selected || null, text }); return false; },
  };
}
export type ScienceChatController = ReturnType<typeof useScienceChat>;

/** Local cards are never inserted into the assistant runtime's canonical messages. */
export function ScienceChatBlocks({ science, position = "unplaced", messageId, loadedMessageIds = [], historyStartAvailable = false }: { science: ScienceChatController; position?: "start" | "after-message" | "unplaced"; messageId?: string; loadedMessageIds?: readonly string[]; historyStartAvailable?: boolean }) {
  const { view: v } = science;
  const blocks = v.chat?.blocks.filter(block => {
    const placement = block.anchor;
    if (position === "unplaced") return !placement || placement.kind === "start" && !historyStartAvailable || placement.kind === "after-message" && !loadedMessageIds.includes(placement.messageId);
    if (!placement) return false;
    if (position === "start" && !historyStartAvailable) return false;
    return placement.kind === position && (placement.kind !== "after-message" || placement.messageId === messageId);
  }) ?? [];
  const leadingEntries = position === "unplaced" ? v.chat?.entries.filter(entry => entry.afterBlockId === null || !v.chat!.blocks.some(block => block.id === entry.afterBlockId)) ?? [] : [];
  if (!blocks.length && !leadingEntries.length) return position === "unplaced" && v.error && !v.chat ? <section className="science-chat-blocks" aria-label="Local Python history unavailable"><p role="status">Local Python history unavailable: {v.error}</p><button type="button" disabled={v.busy} onClick={science.refresh}>Refresh local history</button></section> : null;
  return <section className="science-chat-blocks" aria-label={position === "unplaced" ? "Unplaced local Python history" : "Local Python history"}>
    {position === "unplaced" && <header><strong>Earlier Python cells</strong><p className="muted">Their conversation position is outside loaded history or unavailable.</p></header>}
    {leadingEntries.map(entry => <aside key={entry.id} className="science-local-note"><strong>Local note · not sent</strong><pre>{entry.text}</pre></aside>)}
    {blocks.map(block => <PythonCell key={`${science.scope}:${block.id}`} block={block} science={science} />)}
  </section>;
}

function OperationOutput({ operation }: { operation: ScienceOperation }) {
  const cell = operation.observation?.cell;
  return <>{operation.state !== "succeeded" && <p role="status" className={operation.state === "failed" ? "science-block-error" : "muted"}>{operation.state === "failed" ? "Run failed." : "Run outcome unknown. Refresh history before retrying."}</p>}
    {cell ? <>{cell.consoleOutputs.map((output, index) => <ScienceOutput key={`${output.timestamp}-${index}`} output={output} />)}{cell.output && <ScienceOutput output={cell.output} />}{cell.errors.map((error, index) => <ScienceTextOutput key={index} text={error.message} channel={`${error.kind} error`} />)}{!cell.output && !cell.consoleOutputs.length && !cell.errors.length && <p className="muted">No output.</p>}</> : operation.observation?.text ? <ScienceTextOutput text={operation.observation.text} /> : <p className="muted">No output captured.</p>}
  </>;
}

function PythonCell({ block, science }: { block: ScienceBlock; science: ScienceChatController }) {
  const { view: v } = science;
  const [info, setInfo] = useState(false);
  const [historicalId, setHistoricalId] = useState("");
  const operations = v.chat!.operations.filter(operation => operation.blockId === block.id);
  const latest = operations.at(-1);
  const operation = operations.find(item => item.id === historicalId) ?? latest;
  const historical = !!operation && operation !== latest;
  const dirty = v.drafts[block.id] !== undefined;
  const source = historical ? operation.source : v.drafts[block.id]?.source ?? block.source;
  // Never attach an older source snapshot to newly edited code under a generic Share action.
  const shareOperation = historical || operation?.source === source && !dirty ? operation : undefined;
  return <article className="science-local-block" data-science-block={block.id} aria-busy={v.runningBlockId === block.id}>
    <header className="science-cell-toolbar"><strong>Python</strong>{v.runningBlockId === block.id ? <span className="science-local-label" role="status">Running…</span> : dirty && <span className="science-local-label" role="status">Unsaved</span>}<div className="science-controls">
      <button type="button" disabled={science.disabled} onClick={() => science.select(block.id)}>Edit</button>
      <button type="button" disabled={science.disabled || dirty || historical} onClick={() => science.run(block.id)}>Run</button>
      <button type="button" title="Add source and supported text to your draft; images are omitted" disabled={science.disabled || !science.canShare || dirty && !historical} onClick={() => science.share(block.id, shareOperation?.id ?? null)}>Share</button>
      <button type="button" aria-label="Python cell info" onClick={() => setInfo(true)}>Info</button>
    </div></header>
    {block.creation && block.creation.state !== "created" && <p className="science-cell-notice" role="status">Cell creation unconfirmed. <button type="button" disabled={v.busy} onClick={science.refresh}>Refresh history</button></p>}
    <pre className="science-cell-source" aria-label={historical ? "Historical Python source" : "Python source"}><code>{source || "# Empty cell"}</code></pre>
    <div className="science-cell-output" aria-label="Python output">{operation ? <>{(historical || operation.source !== source) && <p className="science-local-label">{historical ? "Historical result" : "Output from earlier source"}</p>}<OperationOutput operation={operation} /></> : <p className="muted">Not run yet.</p>}</div>
    {operations.length > 1 && <details className="science-cell-history"><summary>Run history · {operations.length}</summary><label>Show result <select value={operation?.id ?? ""} onChange={event => setHistoricalId(event.target.value === latest?.id ? "" : event.target.value)}>{operations.map((item, index) => <option key={item.id} value={item.id}>Run {index + 1}{item === latest ? " · latest" : ""}{item.state !== "succeeded" ? ` · ${item.state}` : ""}</option>)}</select></label>{historical && <button type="button" onClick={() => setHistoricalId("")}>Back to latest</button>}</details>}
    {v.error && <p className="notice error science-cell-notice" role="alert">{v.error}</p>}
    {v.note && !v.flow && <p className="science-cell-notice" role="status">{v.note}</p>}
    {v.chat!.entries.filter(entry => entry.afterBlockId === block.id).map(entry => <aside key={entry.id} className="science-local-note"><strong>Local note</strong><pre>{entry.text}</pre></aside>)}
    {info && <ShellDialog title="Python cell info" className="science-info-dialog" close={() => setInfo(false)}><div className="science-info-content">
      <p>Source and results stay local until you send a snapshot. Sharing includes source and supported observed text only; images and interactive output are omitted.</p>
      <p>Output is an immutable runtime observation, not proof that the displayed source produced it. Submission does not establish execution success.</p>
      <dl><dt>Cell</dt><dd>{block.id}</dd><dt>Saved revision</dt><dd>{block.revision}</dd><dt>Notebook</dt><dd>{v.chat!.notebook}</dd><dt>Anchor</dt><dd>{block.anchor?.kind === "after-message" ? block.anchor.messageId : block.anchor?.kind ?? "Unavailable"}</dd></dl>
      <details><summary>Cell record and known sources</summary><pre>{JSON.stringify(block, null, 2)}</pre></details>
      {operation && <><h3>Selected run</h3><dl><dt>Operation</dt><dd>{operation.id}</dd><dt>Revision</dt><dd>{operation.revision}</dd><dt>Recorded</dt><dd>{operation.createdAt}</dd><dt>Outcome</dt><dd>{operation.state}</dd><dt>Provenance</dt><dd>{operation.observation?.provenance ?? "No observation"}</dd></dl><details><summary>Source at run</summary><pre>{operation.source}</pre></details><details><summary>Runtime observation</summary><pre>{JSON.stringify(operation, null, 2)}</pre></details></>}
      <details><summary>Frozen share records</summary><pre>{JSON.stringify(v.chat!.shares.filter(item => item.blockId === block.id), null, 2)}</pre></details>
      <button type="button" disabled={v.busy} onClick={science.refresh}>Refresh local history</button>
    </div></ShellDialog>}
  </article>;
}

const savedSourceSync = Annotation.define<boolean>();

function PythonEditor({ science }: { science: ScienceChatController }) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const editing = useRef(new Compartment());
  const focusNewBlock = useRef(false);
  const latest = useRef(science); latest.current = science;
  useEffect(() => {
    const view = new EditorView({ parent: root.current!, state: EditorState.create({ doc: latest.current.code, extensions: [workspaceEditorTheme, lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-Enter", run: () => { if (!latest.current.disabled) latest.current.run(); return true; } }]), EditorView.contentAttributes.of({ "aria-label": "Python block source" }), editing.current.of([EditorState.readOnly.of(latest.current.disabled), EditorView.editable.of(!latest.current.disabled)]), EditorView.updateListener.of(update => { if (update.docChanged && update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(savedSourceSync))) latest.current.save(update.state.doc.toString()); })] }) });
    editor.current = view;
    focusNewBlock.current = true;
    return () => { editor.current = null; view.destroy(); };
  }, [science.scope, science.view.selected]);
  useEffect(() => {
    editor.current?.dispatch({ effects: editing.current.reconfigure([EditorState.readOnly.of(science.disabled), EditorView.editable.of(!science.disabled)]) });
    if (!science.disabled && focusNewBlock.current) { editor.current?.focus(); focusNewBlock.current = false; }
  }, [science.scope, science.view.selected, science.disabled]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== science.code) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: science.code }, annotations: [savedSourceSync.of(true), Transaction.addToHistory.of(false)] });
  }, [science.code]);
  return <div className="science-python-editor" ref={root} />;
}

export function ScienceComposer({ science }: { science: ScienceChatController }) {
  const { view: v } = science;
  const [note, setNote] = useState("");
  const dirty = v.drafts[v.selected] !== undefined;
  return <section className="science-composer" aria-label="Local Python notebook" aria-busy={v.busy}>
    <header><strong>Python</strong><div className="science-controls"><button type="button" disabled={science.disabled} onClick={science.manage}>Notebook settings</button><button type="button" className="text-button" onClick={science.back}>Back to chat</button></div></header>
    {v.chat && <div className="science-controls">{!!v.chat.blocks.length && <label className="science-cell-picker"><span className="sr-only">Python cell</span><select value={v.selected} disabled={science.disabled} onChange={event => science.select(event.target.value)}>{v.chat.blocks.map((block, index) => <option key={block.id} value={block.id}>Cell {index + 1}</option>)}</select></label>}<button type="button" disabled={science.disabled} onClick={() => science.addBlock(!science.hasAnchorMessage)}>New cell</button></div>}
    {v.chat?.blocks.length ? <><PythonEditor science={science} /><div className="science-controls"><button type="button" className="science-run-button" disabled={science.disabled || dirty} onClick={() => science.run()}>Run Python</button>{dirty && <><button type="button" disabled={science.disabled} onClick={() => void science.saveDraft()}>Save</button><span className="science-local-label" role="status">Unsaved changes</span></>}<span className="science-local-label">⌘ / Ctrl ↵ to run</span></div><details><summary>Add a local note</summary><textarea value={note} disabled={science.disabled} onChange={event => setNote(event.target.value)} aria-label="Local notebook note" /><button type="button" disabled={science.disabled || !note.trim()} onClick={async () => { if (await science.addEntry(note)) setNote(""); }}>Save note</button></details></> : <p className="muted">Create a cell to start. Notebook settings can help if your notebook is unavailable.</p>}
    <button type="button" className="text-button" disabled={v.busy} onClick={science.refresh}>Refresh local history</button>
    {dirty && <button type="button" className="text-button" disabled={science.disabled} onClick={science.discardDraft}>Discard unsaved changes and use saved source</button>}
    {!science.canShare && <p className="muted">Snapshot sending is not connected yet. Nothing has been added to your chat draft.</p>}
    {v.busy && <p role="status">Working…</p>}{v.error && <p role="alert" className="notice error">{v.error}</p>}{v.note && <p role="status">{v.note}</p>}
    {v.management && <ShellDialog title="Notebook settings" close={science.dismissManagement}><div className="science-notebook-management">
      <p>{v.chat?.notebook ?? "No notebook associated"}</p><p className="muted">Environment: {v.status?.environment.state ?? "unknown"}</p>
      <button type="button" disabled={science.disabled} onClick={science.provision}>Provision chat notebook</button>
      {v.status && <label>Associate existing notebook <select defaultValue="" disabled={science.disabled || !v.chat} onChange={event => { if (event.target.value) science.associate(event.target.value); }}><option value="">Choose notebook…</option>{v.status.notebooks.map(notebook => <option key={notebook} value={notebook}>{notebook}</option>)}</select></label>}
      <button type="button" disabled={science.disabled} onClick={science.start}>Open chat notebook</button>
      <button type="button" disabled={science.disabled || !v.chat} onClick={science.close}>Close notebook runtime</button>
      <p className="muted">Local operation records remain separate from canonical chat messages and assistant context.</p>
      {v.busy && <p role="status">Working…</p>}{v.error && <p role="alert" className="notice error">{v.error}</p>}
    </div></ShellDialog>}
  </section>;
}
