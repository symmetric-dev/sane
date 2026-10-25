import { useEffect, useId, useRef, useState } from "react";
import { capabilitiesFor } from "../shared/conversation/harness-capabilities";
import { catalog } from "./catalog";
import { browserPairIntentMatches, type BrowserPairIntent } from "./browser-pair";
import { browserPairMessageBlocked, browserPairPreparationBusy, checkBrowserPairPrompt, waitForBrowserPairHydration } from "./browser-pair-send";
import { compactCommand } from "./compaction";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";
import { ApiError } from "./cc-client";
import { browserTabLabel, browserTabs } from "./browser-tabs";
import { readBrowserPairs, writeBrowserPairs } from "./browser-pair-client";
import type { BrowserPairMode, BrowserPairSnapshot } from "../shared/browser-pair-contract";
import "./browser-pair-dialog.css";

type Props = {
  intent: BrowserPairIntent;
  name: string;
  initialMode?: BrowserPairMode;
  pair: (sessionId: string, expected: BrowserPairIntent) => boolean;
  close: () => void;
};

/** Mounted at shell level: activating the pair cannot destroy its message or receipt. */
export function BrowserPairDialog({ intent, name, initialMode = "replace", pair, close }: Props) {
  const [text, setText] = useState("");
  const [nativeStopped, setNativeStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [links, setLinks] = useState<BrowserPairSnapshot | null>(null);
  const [mode, setMode] = useState<BrowserPairMode>(initialMode);
  const savedLinks = useRef<BrowserPairSnapshot | null>(null);
  const activating = useRef(false);
  const messageId = useId(), acknowledgementId = useId();
  const alive = useRef(false);
  const inFlight = useRef(false);
  const invalidated = useRef(false);
  const operation = useRef<AbortController | null>(null);
  // Hydration can rerender the shell. Never dispatch through its old selection closure.
  const callbacks = useRef({ pair, close });
  callbacks.current = { pair, close };
  useEffect(() => {
    alive.current = true;
    const selected = store.snapshot().selected;
    const load = new AbortController();
    const check = () => {
      if (browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot()) && (activating.current || store.snapshot().selected === selected)) return;
      invalidated.current = true;
      load.abort();
      operation.current?.abort();
      setStale(true);
      setError("The conversation, browser tab, sign-in, or workspace changed. Close this dialog and connect again. Your optional message has not been redirected.");
    };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    check();
    void readBrowserPairs(intent.config!.storeId!, intent.target, AbortSignal.any([load.signal, AbortSignal.timeout(25000)])).then(snapshot => {
      if (!alive.current || load.signal.aborted) return;
      setLinks(snapshot); setLoadingLinks(false);
    }, failure => {
      if (!alive.current || load.signal.aborted) return;
      setLoadingLinks(false); setError(`${failure instanceof Error ? failure.message : "Could not load paired sessions"}. Close this dialog and connect again. No pairing change or message was sent.`);
    });
    return () => { alive.current = false; load.abort(); operation.current?.abort(); stopStore(); stopCatalog(); stopTabs(); };
  }, [intent]);
  const conversation = store.snapshot().conversations.find(item => item.id === intent.sessionId);
  const capabilities = capabilitiesFor(conversation?.harness, intent.config?.harnesses?.find(item => item.id === conversation?.harness)?.capabilities);
  const needsAck = !!conversation?.attachment && capabilities.attachedSendRequiresNativeStopped;
  const dismiss = () => { if (!inFlight.current) callbacks.current.close(); };
  const submit = async () => {
    if (inFlight.current || invalidated.current || unknown || loadingLinks || !links) return;
    inFlight.current = true; setBusy(true); setError("");
    const controller = new AbortController();
    operation.current = controller;
    let posted = false;
    let writingLinks = false;
    let stopStore = () => {}, stopCatalog = () => {}, stopTabs = () => {};
    try {
      if (!browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot())) {
        setError("This conversation cannot be paired now. Check its workspace and connection, then connect again.");
        return;
      }
      // Save once per modal. Retrying an optional message must never repeat a
      // replace operation and erase links added since its original confirmation.
      if (!savedLinks.current) {
        writingLinks = true;
        const saved = await writeBrowserPairs(links, intent.session, mode, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
        savedLinks.current = saved; setLinks(saved);
        writingLinks = false;
      }
      if (!alive.current || controller.signal.aborted || invalidated.current || !browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot())) throw new Error("Links were saved for the original tab, but the pairing view changed. Close this dialog and connect again.");
      activating.current = true;
      if (!callbacks.current.pair(intent.sessionId, intent)) {
        setError("Links were saved, but this conversation cannot be opened in the paired view now. No message was sent. Close this dialog and connect again.");
        return;
      }
      if (!text.trim()) { callbacks.current.close(); return; }
      if (compactCommand(text)) { setError("Paired, but /compact was not sent. Use the composer or Context controls to compact this conversation."); return; }
      const current = () => alive.current && !controller.signal.aborted && !invalidated.current
        && browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot(), true);
      // Scope changes while awaiting either hydration or a receipt invalidate this
      // attempt permanently, even if navigation returns to the same place later.
      const check = () => {
        if (!current()) controller.abort();
        else if (!posted && browserPairPreparationBusy(store.snapshot())) controller.abort(new Error("The conversation became busy. No message was sent. Try OK again yourself when ready."));
      };
      stopStore = store.subscribe(check); stopCatalog = catalog.subscribe(check); stopTabs = browserTabs.subscribe(check);
      await waitForBrowserPairHydration(intent, controller.signal);
      if (!current()) throw new Error("Pairing changed. No message was sent. Close this dialog and connect again.");
      const blocked = browserPairMessageBlocked(store.snapshot(), text, nativeStopped);
      if (blocked) { setError(blocked); return; }
      const promptBlocked = await checkBrowserPairPrompt(intent, text, nativeStopped, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
      if (!current()) throw new Error("Pairing changed. No message was sent. Close this dialog and connect again.");
      if (promptBlocked) { setError(promptBlocked); return; }
      const finalBlocked = browserPairMessageBlocked(store.snapshot(), text, nativeStopped);
      if (finalBlocked) { setError(finalBlocked); return; }
      if (!current()) throw new Error("Pairing changed. No message was sent. Close this dialog and connect again.");
      posted = true;
      setNativeStopped(false);
      const outcome = await store.send(text, nativeStopped, { preserveDraft: true });
      if (!alive.current) return;
      if (!current()) {
        setUnknown(true);
        setError("Pairing changed while submitting. Check the clicked conversation’s history before sending again. This message will not be retried or redirected.");
        return;
      }
      if ((outcome.status === "accepted" || outcome.status === "queued") && outcome.conversationId === intent.sessionId) {
        callbacks.current.close();
        return;
      }
      if (outcome.status === "unknown" || outcome.status === "accepted" || outcome.status === "queued") {
        setUnknown(true);
        setError("Acceptance is unknown. Check this conversation’s history before sending again. Dismiss this dialog after checking; no automatic retry will occur.");
      } else {
        setError(store.snapshot().submissionError || "The message was not sent. The conversation remains paired and your optional message is preserved. Resolve the issue, then try OK again.");
      }
    } catch (failure) {
      if (!alive.current) return;
      if (posted || writingLinks && (!(failure instanceof ApiError) || failure.status >= 500)) setUnknown(true);
      if (writingLinks && failure instanceof ApiError && failure.status === 409) setStale(true);
      setError(posted ? "Acceptance is unknown. Check this conversation’s history before sending again. No automatic retry will occur."
        : writingLinks ? `${failure instanceof Error ? failure.message : "Pairing update was not confirmed."} Close this dialog and connect again to check stored links. No optional message was sent and your text is preserved; no automatic retry will occur.`
        : `${failure instanceof Error ? failure.message : "Could not prepare the message."} ${savedLinks.current ? "Browser links remain saved." : "No browser link was saved."} No message was sent and your optional text is preserved.`);
    } finally {
      stopStore(); stopCatalog(); stopTabs();
      if (operation.current === controller) operation.current = null;
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const tabs = browserTabs.snapshot(intent.target.workspaceId);
  const tabIndex = tabs.tabs.findIndex(tab => tab.id === intent.target.tabId);
  const tabName = tabIndex < 0 ? "Original browser tab" : browserTabLabel(tabs.tabs[tabIndex]!, tabIndex);
  return <ShellDialog title="Pair conversation with browser view?" close={dismiss} closeDisabled={busy} className="browser-pair-dialog">
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="browser-pair-dialog-name">{name}</p>
      <p className="muted">Use this conversation alongside the browser view. Its execution worktree stays unchanged.</p>
      <p className="browser-pair-dialog-tab">Browser tab: <strong>{tabName}</strong></p>
      {loadingLinks ? <p className="muted" role="status">Loading paired sessions…</p> : links && <p className="muted">{links.sessions.length} paired {links.sessions.length === 1 ? "session" : "sessions"} saved for this tab.</p>}
      <fieldset className="browser-pair-dialog-mode" disabled={busy || unknown || stale || loadingLinks || !links || !!savedLinks.current}>
        <legend>Paired sessions</legend>
        <label><input type="radio" name={`${messageId}-mode`} value="replace" checked={mode === "replace"} onChange={() => setMode("replace")} /><span>Replace all paired sessions <small>Keep only this conversation linked to this tab (default).</small></span></label>
        <label><input type="radio" name={`${messageId}-mode`} value="add" checked={mode === "add"} onChange={() => setMode("add")} /><span>Add to paired sessions <small>Keep this tab’s existing links and add this conversation.</small></span></label>
      </fieldset>
      <p className="muted">Links to other tabs are unchanged. The sidebar shows one conversation at a time. Saved links do not trigger agent actions or grant browser access.</p>
      <label htmlFor={messageId}>Message <span className="muted">(optional)</span></label>
      <textarea id={messageId} rows={4} value={text} disabled={busy || unknown} onChange={event => setText(event.target.value)} placeholder="Pair without a message, or send a follow-up to this conversation" />
      {needsAck && <label className="browser-pair-dialog-ack" htmlFor={acknowledgementId}><input id={acknowledgementId} type="checkbox" checked={nativeStopped} disabled={busy || unknown} onChange={event => setNativeStopped(event.target.checked)} /><span>I confirm external assistant execution is stopped before sending.</span></label>}
      <p className="muted">Only your message is sent. Browser URLs, screenshots, and page content are not included. Existing chat drafts are preserved.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="browser-pair-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button type="submit" className="primary-button" disabled={busy || unknown || stale || loadingLinks || !links}>{busy ? "Pairing…" : "OK"}</button></div>
    </form>
  </ShellDialog>;
}
