import { useEffect, useId, useRef, useState } from "react";
import { capabilitiesFor } from "../shared/conversation/harness-capabilities";
import { catalog } from "./catalog";
import { browserPairIntentMatches, type BrowserPairIntent } from "./browser-pair";
import { browserPairMessageBlocked, browserPairPreparationBusy, checkBrowserPairPrompt, waitForBrowserPairHydration } from "./browser-pair-send";
import { compactCommand } from "./compaction";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";
import "./browser-pair-dialog.css";

type Props = {
  intent: BrowserPairIntent;
  name: string;
  pair: (sessionId: string, expected: BrowserPairIntent) => boolean;
  close: () => void;
};

/** Mounted at shell level: activating the pair cannot destroy its message or receipt. */
export function BrowserPairDialog({ intent, name, pair, close }: Props) {
  const [text, setText] = useState("");
  const [nativeStopped, setNativeStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [stale, setStale] = useState(false);
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
    const check = () => {
      if (browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot())) return;
      invalidated.current = true;
      operation.current?.abort();
      setStale(true);
      setError("The conversation, sign-in, or workspace changed. Close this dialog and connect again. Your optional message has not been redirected.");
    };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check);
    check();
    return () => { alive.current = false; operation.current?.abort(); stopStore(); stopCatalog(); };
  }, [intent]);
  const conversation = store.snapshot().conversations.find(item => item.id === intent.sessionId);
  const capabilities = capabilitiesFor(conversation?.harness, intent.config?.harnesses?.find(item => item.id === conversation?.harness)?.capabilities);
  const needsAck = !!conversation?.attachment && capabilities.attachedSendRequiresNativeStopped;
  const dismiss = () => { if (!inFlight.current) callbacks.current.close(); };
  const submit = async () => {
    if (inFlight.current || invalidated.current || unknown) return;
    inFlight.current = true; setBusy(true); setError("");
    const controller = new AbortController();
    operation.current = controller;
    let posted = false;
    let stopStore = () => {}, stopCatalog = () => {};
    try {
      if (!browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot()) || !callbacks.current.pair(intent.sessionId, intent)) {
        setError("This conversation cannot be paired now. Check its workspace and connection, then connect again.");
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
      stopStore = store.subscribe(check); stopCatalog = catalog.subscribe(check);
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
      if (posted) setUnknown(true);
      setError(posted ? "Acceptance is unknown. Check this conversation’s history before sending again. No automatic retry will occur." : `${failure instanceof Error ? failure.message : "Could not prepare the message."} The conversation remains paired; no message was sent and your optional text is preserved.`);
    } finally {
      stopStore(); stopCatalog();
      if (operation.current === controller) operation.current = null;
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <ShellDialog title="Pair conversation with browser view?" close={dismiss} closeDisabled={busy} className="browser-pair-dialog">
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="browser-pair-dialog-name">{name}</p>
      <p className="muted">Use this conversation alongside the browser view. Its execution worktree stays unchanged.</p>
      <label htmlFor={messageId}>Message <span className="muted">(optional)</span></label>
      <textarea id={messageId} rows={4} value={text} disabled={busy || unknown} onChange={event => setText(event.target.value)} placeholder="Pair without a message, or send a follow-up to this conversation" />
      {needsAck && <label className="browser-pair-dialog-ack" htmlFor={acknowledgementId}><input id={acknowledgementId} type="checkbox" checked={nativeStopped} disabled={busy || unknown} onChange={event => setNativeStopped(event.target.checked)} /><span>I confirm external assistant execution is stopped before sending.</span></label>}
      <p className="muted">Only your message is sent. Browser URLs, screenshots, and page content are not included. Existing chat drafts are preserved.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="browser-pair-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button type="submit" className="primary-button" disabled={busy || unknown || stale}>{busy ? "Pairing…" : "OK"}</button></div>
    </form>
  </ShellDialog>;
}
