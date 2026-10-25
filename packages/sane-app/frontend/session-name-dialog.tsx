import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle } from "../shared/conversation/session-title";
import { ApiError } from "./cc-client";
import { ShellDialog } from "./shell-dialog";
import { store, useStore, type SessionNameIntent } from "./store";
import "./session-name-dialog.css";

/** Shell-owned: a title-filtered row may disappear as soon as Save is clicked. */
export function SessionNameDialog() {
  const intent = useStore(state => state.sessionNameDialog);
  // ShellDialog.showModal() puts this new dialog above an already-open drawer;
  // unlike the action menu, it must own its own modal/focus containment.
  return intent ? createPortal(<SessionNameForm key={JSON.stringify([intent.scope, intent.conversationId, intent.mode])} intent={intent} />, document.body) : null;
}

function SessionNameForm({ intent }: { intent: SessionNameIntent }) {
  const [title, setTitle] = useState(intent.title);
  const [expectedRevision, setExpectedRevision] = useState(intent.expectedRevision);
  const [latest, setLatest] = useState(intent.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const nameId = useId(), helpId = useId();
  const conversation = useStore(state => state.conversations.find(c => c.id === intent.conversationId));
  const scope = useStore(() => store.sessionNameScope(intent.conversationId));
  const stale = !conversation || !!conversation.replacedBy || scope !== intent.scope;
  const regenerate = intent.mode === "regenerate";
  const dismiss = () => { if (!inFlight.current) store.closeSessionNameDialog(); };
  const refresh = async () => {
    const row = await store.refreshSessionName(intent);
    setExpectedRevision(row.titleRevision ?? 0); setLatest(row.title ?? ""); setNeedsRefresh(false);
    return row;
  };
  const submit = async () => {
    if (inFlight.current || stale || needsRefresh) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await store.changeSessionName({ ...intent, expectedRevision }, title);
      inFlight.current = false;
      store.closeSessionNameDialog();
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409 && (!failure.code || failure.code === "title-conflict");
      try {
        await refresh();
        setError(conflict
          ? "The name changed elsewhere. Review the current name below before trying again. Your draft is preserved."
          : `${failure instanceof Error ? failure.message : "Could not change the name."} The current saved name is shown below; no automatic retry was made.`);
      } catch {
        setNeedsRefresh(true);
        setError(`${failure instanceof Error ? failure.message : "Could not change the name."} The saved name could not be refreshed. Refresh it before retrying.`);
      }
    } finally { inFlight.current = false; setBusy(false); }
  };
  const retryRefresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await refresh(); setError("Current name refreshed. Review it before trying again; your draft is preserved."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not refresh the saved name."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const restore = () => {
    const target = intent.restoreFocus?.();
    if (target?.isConnected && !target.closest("[inert], [hidden]")) return target;
    // The row may no longer match the active title search after saving.
    return [...document.querySelectorAll<HTMLElement>(".history-search input, .sidebar-toggle")].find(element => element.getClientRects().length > 0) ?? null;
  };
  const normalized = normalizeSessionTitle(title);
  return <ShellDialog title={regenerate ? "Regenerate name?" : "Rename conversation"} close={dismiss} closeDisabled={busy}
    className="session-name-dialog" restoreFocus={restore} initialFocus={() => regenerate ? cancel.current : input.current}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {regenerate ? <>
        <p>Generate a new name from this conversation’s content using the configured naming utility. This replaces its current name, including a manually chosen name.</p>
        <p className="session-name-current"><span className="muted">Current name</span><strong>{latest || "Untitled conversation"}</strong></p>
        <p className="muted">Only the name changes. Messages, chat execution, and saved session settings stay unchanged. If generation fails, the saved name is kept.</p>
      </> : <>
        <label htmlFor={nameId}>Name</label>
        <input ref={input} id={nameId} type="text" value={title} maxLength={MAX_SESSION_TITLE_LENGTH} disabled={busy} autoComplete="off"
          aria-describedby={helpId} onFocus={event => event.currentTarget.select()} onChange={event => setTitle(event.target.value)} />
        <p id={helpId} className="muted">Up to {MAX_SESSION_TITLE_LENGTH} characters. Only this conversation’s name changes.</p>
      </>}
      {busy && <p className="muted" role="status">{regenerate ? "Generating a new name…" : "Saving name…"}</p>}
      {error && <div className="notice error" role="alert"><p>{error}</p>{!regenerate && <p className="session-name-current"><span>Current saved name</span><strong>{latest || "Untitled conversation"}</strong></p>}</div>}
      {stale && <p className="notice error" role="alert">This conversation or sign-in changed. Close the dialog and open it again.</p>}
      <div className="session-name-actions">
        <button ref={cancel} type="button" disabled={busy} onClick={dismiss}>Cancel</button>
        {needsRefresh && <button type="button" disabled={busy || stale} onClick={() => void retryRefresh()}>Refresh current name</button>}
        <button type="submit" className="primary-button" disabled={busy || stale || needsRefresh || !regenerate && !normalized}>
          {regenerate ? busy ? "Generating…" : "Regenerate name" : busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  </ShellDialog>;
}
