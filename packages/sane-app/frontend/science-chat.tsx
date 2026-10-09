import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { ScienceCell, ScienceOutput, ScienceRequest, ScienceResponse, ScienceSession, ScienceSnapshot, ScienceStatus } from "../shared/science-contract";
import { ScienceBlockCard } from "./science-output";
import { workspaceEditorTheme } from "./workspace-theme";
import { store, type State } from "./store";
import { catalog } from "./catalog";
import { pendingInteractions } from "./interaction-presentation";
import "./science-chat.css";

type Draft = { code: string; hash: string; acceptedCode?: string };
type View = { flow: boolean; busy: boolean; error: string; note: string; status?: ScienceStatus; session?: ScienceSession; snapshot?: ScienceSnapshot; selected: string; drafts: Record<string, Draft>; execution: Record<string, NonNullable<ScienceResponse["operation"]>["execution"]> };
function identity(state: State) {
  const c = state.conversations.find(item => item.id === state.selected);
  const navigation = catalog.snapshot().navigation;
  return JSON.stringify([state.selected, c?.workspaceId, c?.worktreeId, c?.cwd, c?.nativeSessionId, c?.replacedBy, state.config?.storeId, state.config?.authenticated, navigation.workspaceId, navigation.worktreeId, navigation.view]);
}
function outputText(output: ScienceOutput): string {
  if (output.mimetype.startsWith("image/")) return "[Image omitted; no image attachment was staged.]";
  if (output.mimetype === "application/vnd.marimo+mimebundle") {
    try {
      const bundle = typeof output.data === "string" ? JSON.parse(output.data) : output.data;
      if (bundle && typeof bundle === "object" && !Array.isArray(bundle)) return Object.entries(bundle).map(([mimetype, data]) => outputText({ ...output, mimetype, data: data as ScienceOutput["data"] })).join("\n");
    } catch { /* Unsupported bundle. */ }
    return "[Rich output omitted.]";
  }
  if (output.mimetype === "text/html") {
    // Extract only a serialized static table payload. Never mount notebook HTML.
    const html = typeof output.data === "string" ? output.data : "";
    const table = /<marimo-table\s[^>]*\bdata-data=(?:'([^']*)'|"([^"]*)")/.exec(html);
    if (table) {
      try {
        const value = (table[1] ?? table[2]).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        const encoded = JSON.parse(value);
        const rows = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
        if (Array.isArray(rows)) return `Static table snapshot (up to 200 rows):\n${JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 30000)}`;
      } catch { /* Unsupported table serialization. */ }
    }
    return "[HTML or interactive output omitted.]";
  }
  if (output.mimetype === "text/plain" || output.mimetype === "application/json") return (typeof output.data === "string" ? output.data : JSON.stringify(output.data, null, 2)).slice(0, 30000);
  return `[Unsupported output omitted: ${output.mimetype}]`;
}

export function useScienceChat(state: State, active: boolean, blocked: boolean) {
  const scope = identity(state);
  const c = state.conversations.find(item => item.id === state.selected);
  const workspaceId = c?.workspaceId, worktreeId = c?.worktreeId;
  const views = useRef(new Map<string, View>());
  let view = views.current.get(scope);
  if (!view) { view = { flow: false, busy: false, error: "", note: "", selected: "", drafts: {}, execution: {} }; views.current.set(scope, view); }
  const v = view;
  const [, render] = useState(0);
  const live = useRef({ scope, active, blocked, epoch: 0 });
  if (live.current.scope !== scope || live.current.active !== active) live.current.epoch++;
  live.current = { ...live.current, scope, active, blocked };
  useEffect(() => { live.current.active = active; return () => { live.current.active = false; live.current.epoch++; }; }, [active]);
  const valid = () => live.current.active && live.current.scope === scope && identity(store.snapshot()) === scope && catalog.snapshot().navigation.view === "chat";
  const allowed = () => {
    const current = store.snapshot();
    return valid() && !live.current.blocked && current.config?.authenticated === true && !current.loading && !current.sending && !current.actionBusy && !store.pendingInputChainLocked() && !pendingInteractions(current, store.capabilities()).length;
  };
  const update = () => { if (valid()) render(n => n + 1); };
  const draftKey = (id: string) => JSON.stringify([v.session?.notebook, id]);
  const select = (id: string) => {
    if (!allowed()) return;
    v.selected = id; v.flow = true;
    const cell = v.snapshot?.cells.find(item => item.id === id);
    if (cell && !v.drafts[draftKey(id)]) v.drafts[draftKey(id)] = { code: cell.code, hash: cell.sourceHash };
    update();
  };
  async function perform(action?: ScienceRequest, thenRun?: { cellId: string; code: string }) {
    if (!allowed() || v.busy || !workspaceId || !worktreeId) return;
    const epoch = live.current.epoch;
    const current = () => valid() && live.current.epoch === epoch;
    const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}/science`;
    v.busy = true; v.error = ""; v.note = ""; update();
    const request = async (body?: ScienceRequest): Promise<ScienceResponse> => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Science request failed (${response.status}).`);
      return data;
    };
    const apply = (result: ScienceResponse) => {
      const bindingChanged = v.status && v.status.bindingRevision !== result.status.bindingRevision;
      v.status = result.status;
      if (v.session && !result.session) {
        const session = result.status.sessions.find(item => item.notebook === v.session?.notebook && item.generation === v.session?.generation);
        if (!session || bindingChanged) { v.session = undefined; v.snapshot = undefined; v.selected = ""; }
        else v.session = session;
      }
      if (result.session) {
        if (v.session?.generation !== result.session.generation) { v.snapshot = undefined; v.selected = ""; v.execution = {}; }
        v.session = result.session;
        if (result.session.state === "stopped") { v.session = undefined; v.snapshot = undefined; v.selected = ""; }
      }
      if (result.snapshot) {
        v.snapshot = result.snapshot;
        for (const cell of result.snapshot.cells) {
          const draft = v.drafts[draftKey(cell.id)];
          // Reconcile confirmed edits even if execution is blocked or inspection
          // arrives later. Never discard newer draft text or adopt external edits.
          if (draft?.acceptedCode !== undefined && draft.acceptedCode === cell.code) {
            draft.hash = cell.sourceHash;
            delete draft.acceptedCode;
          }
        }
      }
      if (result.operation) {
        v.execution[result.operation.cellId] = result.operation.execution;
        v.note = `Edit: ${result.operation.mutation}; execution: ${result.operation.execution}. Notebook durability is unconfirmed.`;
        if (result.operation.issue) v.error = result.operation.issue === "snapshot-unavailable" ? "Current output is unavailable. Refresh blocks to inspect before another operation." : "The operation reported an error. Inspect the current source before trying again.";
      }
    };
    try {
      const result = await request(action);
      if (!current()) return;
      if (action?.action === "edit" && result.operation?.mutation === "accepted") {
        const draft = v.drafts[JSON.stringify([action.notebook, action.cellId])];
        if (draft) draft.acceptedCode = action.code;
      }
      apply(result);
      const saved = thenRun ? result.snapshot?.cells.find(cell => cell.id === thenRun.cellId) : undefined;
      if (thenRun && result.operation?.mutation === "accepted" && !result.operation.issue && saved?.code === thenRun.code
        && result.session && result.session.state === "session-ready" && allowed()) {
        const executed = await request({ action: "run", bindingRevision: result.status.bindingRevision, notebook: result.session.notebook, generation: result.session.generation, cellId: thenRun.cellId });
        if (!current()) return;
        apply(executed);
      }
      if (!v.selected && v.snapshot?.cells.length) {
        const cell = v.snapshot.cells[0]; v.selected = cell.id;
        v.drafts[draftKey(cell.id)] ??= { code: cell.code, hash: cell.sourceHash };
      }
    } catch (error) {
      if (current()) v.error = `${error instanceof Error ? error.message : "Science request failed."}${action ? " Operation outcome may be unknown; refresh status and inspect before retrying. No automatic retry was made." : ""}`;
    } finally {
      v.busy = false;
      if (!current()) v.note = "Navigation interrupted this operation's observation. Refresh status and blocks before another operation; its outcome is unconfirmed.";
      // Only release the original scope's busy indicator. Results and chained
      // mutations remain fenced even when the user has navigated away and back.
      if (valid()) update();
    }
  }
  const bound = () => v.status ? { bindingRevision: v.status.bindingRevision } : null;
  const selected = () => v.session && bound() ? { ...bound()!, notebook: v.session.notebook, generation: v.session.generation } : null;
  const run = () => {
    const target = selected(), draft = v.drafts[draftKey(v.selected)];
    if (!target || !draft || v.session?.state !== "session-ready") return;
    if (draft.acceptedCode !== undefined) { v.error = "An accepted edit needs inspection. Refresh blocks before running again."; update(); return; }
    void perform({ ...target, action: "edit", cellId: v.selected, code: draft.code, expectedSourceHash: draft.hash }, { cellId: v.selected, code: draft.code });
  };
  const share = (cell: ScienceCell) => {
    if (!allowed() || v.busy) return;
    const snapshot = [`Science snapshot · ${v.session?.notebook} · ${cell.name || cell.id}`, `Python source:\n${cell.code}`, "Captured output (may be from an earlier run):", ...cell.consoleOutputs.map(outputText), ...(cell.output ? [outputText(cell.output)] : []), ...cell.errors.map(error => error.message)].join("\n\n");
    store.setDraft({ text: [store.draft().text, snapshot].filter(Boolean).join("\n\n") });
    v.flow = false; v.note = "Snapshot staged in chat draft. Review it before sending."; update();
  };
  return {
    view: v, scope, available: !!state.selected && !!workspaceId && !!worktreeId && !c?.replacedBy && state.config?.authenticated === true,
    disabled: blocked || !active || v.busy,
    start: () => { if (!allowed()) return; v.flow = true; update(); if (!v.status) void perform(); },
    back: () => { if (!valid()) return; v.flow = false; update(); },
    refresh: () => void perform(),
    provision: () => { const b = bound(); if (b) void perform({ ...b, action: "provision" }); },
    notebook: (action: "create" | "open", notebook: string) => {
      if (!allowed() || v.busy) return;
      const b = bound();
      const existing = action === "open" ? v.status?.sessions.find(item => item.notebook === notebook) : undefined;
      if (existing && b) {
        v.session = existing; v.snapshot = undefined; v.selected = ""; v.execution = {};
        void perform({ ...b, action: "inspect", notebook, generation: existing.generation });
      } else if (b) void perform({ ...b, action, notebook });
    },
    inspect: () => { const s = selected(); if (s) void perform({ ...s, action: "inspect" }); },
    close: () => { const s = selected(); if (s) void perform({ ...s, action: "close" }); },
    reloadSource: () => { if (!allowed() || v.busy) return; const cell = v.snapshot?.cells.find(item => item.id === v.selected); if (cell) { v.drafts[draftKey(cell.id)] = { code: cell.code, hash: cell.sourceHash }; update(); } },
    select, run, share,
    code: v.drafts[draftKey(v.selected)]?.code ?? "",
    save: (code: string) => { if (!allowed() || v.busy) return; const draft = v.drafts[draftKey(v.selected)]; if (draft) { draft.code = code; update(); } },
  };
}
export type ScienceChatController = ReturnType<typeof useScienceChat>;

export function ScienceChatBlocks({ science }: { science: ScienceChatController }) {
  const { view } = science;
  if (!view.snapshot) return null;
  return <section className="science-chat-blocks" aria-label={`Python notebook ${view.session?.notebook}`}>
    <p className="muted">Python · {view.session?.notebook} · live notebook snapshot</p>
    {view.snapshot.cells.map(cell => <ScienceBlockCard key={cell.id} block={{ id: cell.id, title: cell.name || `Block ${cell.id}`, cell, execution: view.execution[cell.id], outputStale: true }} busy={view.busy} onEdit={!science.disabled ? () => science.select(cell.id) : undefined} onShare={!science.disabled ? () => science.share(cell) : undefined} />)}
  </section>;
}

function PythonEditor({ science }: { science: ScienceChatController }) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(science); latest.current = science;
  useEffect(() => {
    const view = new EditorView({ parent: root.current!, state: EditorState.create({ doc: latest.current.code, extensions: [workspaceEditorTheme, lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-Enter", run: () => { if (!latest.current.disabled) latest.current.run(); return true; } }]), EditorView.contentAttributes.of({ "aria-label": "Python block source" }), EditorState.readOnly.of(science.disabled), EditorView.editable.of(!science.disabled), EditorView.updateListener.of(update => { if (update.docChanged) latest.current.save(update.state.doc.toString()); })] }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [science.scope, science.view.session?.notebook, science.view.selected, science.disabled, science.view.drafts[JSON.stringify([science.view.session?.notebook, science.view.selected])]?.hash]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== science.code) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: science.code } });
  }, [science.code]);
  return <div className="science-python-editor" ref={root} />;
}

export function ScienceComposer({ science }: { science: ScienceChatController }) {
  const [name, setName] = useState("analysis.py");
  const { view: v } = science;
  const ready = v.status?.environment.state === "ready" && v.status.nativeAvailable;
  return <section className="science-composer" aria-label="Python workspace" aria-busy={v.busy}>
    <header><strong>Python workspace</strong><button type="button" className="text-button" onClick={science.back}>Back to chat</button></header>
    <p className="muted">{v.status ? `Environment: ${v.status.environment.state}` : "Load this checkout's Python environment."}{v.session ? ` · ${v.session.notebook}: ${v.session.state}` : ""}</p>
    <div className="science-controls">
      <button type="button" disabled={science.disabled} onClick={science.refresh}>Refresh status</button>
      {v.status && ["missing", "scaffolded"].includes(v.status.environment.state) && <button type="button" disabled={science.disabled} onClick={science.provision}>Provision Python environment</button>}
      {ready && <><label>Notebook <select value={v.session?.notebook ?? ""} disabled={science.disabled} onChange={event => { if (event.target.value) science.notebook("open", event.target.value); }}><option value="">Open notebook…</option>{v.status!.notebooks.map(item => <option key={item} value={item}>{item}</option>)}</select></label><label>New notebook <input value={name} disabled={science.disabled} onChange={event => setName(event.target.value)} /></label><button type="button" disabled={science.disabled || !name.trim()} onClick={() => science.notebook("create", name.trim())}>Create notebook</button></>}
      {v.session && <><button type="button" disabled={science.disabled || v.session.state === "stopped"} onClick={science.inspect}>Refresh blocks</button><button type="button" disabled={science.disabled || v.session.state === "stopped"} onClick={science.close}>Close notebook</button></>}
    </div>
    {v.status && !v.status.nativeAvailable && <p className="muted">Native science service is unavailable.</p>}
    {v.snapshot && <><label>Block <select value={v.selected} disabled={science.disabled} onChange={event => science.select(event.target.value)}>{v.snapshot.cells.map(cell => <option key={cell.id} value={cell.id}>{cell.name || cell.id}</option>)}</select></label>{v.selected && <><PythonEditor science={science} /><div className="science-controls"><button type="button" className="send" disabled={science.disabled || v.session?.state !== "session-ready"} onClick={science.run}>Run Python</button><button type="button" disabled={science.disabled} onClick={science.reloadSource}>Discard draft and use inspected source</button></div></>}{!v.snapshot.cells.length && <p>No blocks in this notebook.</p>}</>}
    {v.busy && <p role="status">Working…</p>}{v.error && <p role="alert" className="notice error">{v.error}</p>}{v.note && <p role="status">{v.note}</p>}
  </section>;
}
