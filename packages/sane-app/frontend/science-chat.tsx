import { useEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { ScienceChatRequest, ScienceChatResponse, ScienceChatState, ScienceShareSnapshot, ScienceTranscriptAnchor } from "../shared/science-chat-contract";
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
type View = { flow: boolean; management: boolean; busy: boolean; loaded: boolean; error: string; draftErrorBlockId?: string; note: string; chat?: ScienceChatState; status?: ScienceStatus; selected: string; drafts: Record<string, { source: string; revision: number }> };
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
    v.busy = true; v.error = ""; v.draftErrorBlockId = undefined; update();
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
      v.busy = false; v.loaded = true;
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
      v.note = staged ? "Frozen science snapshot staged for review before sending." : "Snapshot saved locally; it was not staged in the chat draft.";
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
    run: () => { const block = v.chat?.blocks.find(item => item.id === v.selected); if (block && v.drafts[block.id] === undefined) void perform({ action: "run", requestId: crypto.randomUUID(), blockId: block.id, expectedRevision: block.revision }); },
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
    {position === "unplaced" && <header><strong>Unplaced local Python history</strong><p className="muted">The exact transcript anchor is unavailable or outside loaded history. These cards have not been moved to the end of the conversation.</p></header>}
    {leadingEntries.map(entry => <aside key={entry.id} className="science-local-note"><strong>Local note · not sent</strong><pre>{entry.text}</pre></aside>)}
    {blocks.map(block => <article key={block.id} className="science-local-block" data-science-block={block.id}>
      <header><strong>Python block</strong><span className="science-local-label">Local history · shared only via snapshots</span><code>{block.id}</code></header>
      {position === "unplaced" && <p className="muted">{block.anchor?.kind === "after-message" ? `Anchor message ${block.anchor.messageId} is not in loaded history.` : block.anchor?.kind === "start" ? "The start of conversation history is not loaded." : "No durable message anchor is available."}</p>}
      {block.creation && block.creation.state !== "created" && <p role="status">Block creation {block.creation.state}. Refresh history to inspect the durable outcome; no automatic retry is made.</p>}
      <details><summary>Saved source · revision {block.revision}</summary><pre>{block.source}</pre></details>
      {v.chat!.operations.filter(operation => operation.blockId === block.id).map(operation => <section key={operation.id} className="science-local-operation">
        <header><strong>Recorded operation · {operation.state}</strong><time dateTime={operation.createdAt}>{new Date(operation.createdAt).toLocaleString()}</time></header>
        <p className="muted">Immutable record · revision {operation.revision}. Observed output is not proof that this source produced it.</p>
        <details><summary>User source at operation</summary><pre>{operation.source}</pre></details>
        {operation.observation ? <><p className="science-local-label">Immutable observed output · provenance unverified</p>{operation.observation.cell ? <>
          {operation.observation.cell.consoleOutputs.map((output, index) => <ScienceOutput key={`${output.timestamp}-${index}`} output={output} />)}
          {operation.observation.cell.output && <ScienceOutput output={operation.observation.cell.output} />}
          {operation.observation.cell.errors.map((error, index) => <ScienceTextOutput key={index} text={error.message} channel={`${error.kind} error`} />)}
          {!operation.observation.cell.output && !operation.observation.cell.consoleOutputs.length && !operation.observation.cell.errors.length && <p className="muted">No output captured in this observation.</p>}
        </> : <ScienceTextOutput text={operation.observation.text} />}</> : <p className="muted">No output observation was recorded.</p>}
        <button type="button" disabled={science.disabled || !science.canShare} onClick={() => science.share(block.id, operation.id)}>Stage frozen snapshot</button>
        <p className="muted">Sharing includes this operation's source{operation.observation?.text ? " and its supported observed text" : " only"}. Images and rich output are not sent.</p>
      </section>)}
      <footer className="science-controls"><button type="button" disabled={science.disabled} onClick={() => science.select(block.id)}>Edit block</button><button type="button" disabled={science.disabled || !science.canShare || v.drafts[block.id] !== undefined} onClick={() => science.share(block.id, null)}>Stage saved source</button></footer>
      {v.chat!.entries.filter(entry => entry.afterBlockId === block.id).map(entry => <aside key={entry.id} className="science-local-note"><strong>Local note · not sent</strong><pre>{entry.text}</pre></aside>)}
    </article>)}
  </section>;
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
    <header><strong>Python · local notebook</strong><div className="science-controls"><button type="button" disabled={science.disabled} onClick={science.manage}>Manage notebook</button><button type="button" className="text-button" onClick={science.back}>Back to chat</button></div></header>
    {v.chat && <p className="muted">{v.chat.notebook} · {v.chat.notebookKind === "owned" ? "This chat's notebook" : "Associated notebook"}. Source and history stay local until a snapshot is sent.</p>}
    {v.chat && <div className="science-controls"><button type="button" disabled={science.disabled} onClick={() => science.addBlock(!science.hasAnchorMessage)}>{science.hasAnchorMessage ? "New Python block" : "New Python block at conversation start"}</button>{science.hasAnchorMessage && <span className="muted">Anchored after the last loaded canonical message.</span>}</div>}
    {v.chat?.blocks.length ? <><label>Block <select value={v.selected} disabled={science.disabled} onChange={event => science.select(event.target.value)}>{v.chat.blocks.map((block, index) => <option key={block.id} value={block.id}>Block {index + 1} · {block.id}</option>)}</select></label><PythonEditor science={science} /><div className="science-controls"><button type="button" className="send" disabled={science.disabled || dirty} onClick={science.run}>Run Python</button><button type="button" disabled={science.disabled || !dirty} onClick={() => void science.saveDraft()}>Save draft</button><span role="status">{dirty ? "Unsaved local changes" : "Saved in App storage"}</span></div><details><summary>Add a local note</summary><textarea value={note} disabled={science.disabled} onChange={event => setNote(event.target.value)} aria-label="Local notebook note" /><button type="button" disabled={science.disabled || !note.trim()} onClick={() => science.addEntry(note)}>Save local note</button></details></> : <p>No local blocks available. Open notebook management to check provisioning.</p>}
    <button type="button" className="text-button" disabled={v.busy} onClick={science.refresh}>Refresh local history</button>
    {dirty && <button type="button" className="text-button" disabled={science.disabled} onClick={science.discardDraft}>Discard unsaved changes and use saved source</button>}
    {!science.canShare && <p className="muted">Snapshot sending is not connected yet. Nothing has been added to your chat draft.</p>}
    {v.busy && <p role="status">Working…</p>}{v.error && <p role="alert" className="notice error">{v.error}</p>}{v.note && <p role="status">{v.note}</p>}
    {v.management && <ShellDialog title="Manage Python notebook" close={science.dismissManagement} restoreFocus={() => document.body}><div className="science-notebook-management">
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
