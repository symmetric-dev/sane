import { useEffect, useId, useState } from "react";
import { FiGitBranch } from "react-icons/fi";
import { request } from "./cc-client";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";
import type { Conversation, Harness } from "./types";
import "./branch.css";

export function BranchAction({ sessionId, harness, runId, messageId }: { sessionId: string; harness: Harness; runId?: string; messageId?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="text-button branch-action" aria-haspopup="dialog" onClick={() => setOpen(true)}><FiGitBranch size={13} aria-hidden="true" />Branch from here</button>{open && <BranchDialog key={`${sessionId}:${runId ?? messageId}`} {...{ sessionId, harness, runId, messageId }} close={() => setOpen(false)} />}</>;
}
function BranchDialog({ sessionId, harness, runId, messageId, close }: { sessionId: string; harness: Harness; runId?: string; messageId?: string; close: () => void }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const promptId = useId(), replaceHintId = useId();
  const [attempted, setAttempted] = useState(false);
  const [check, setCheck] = useState(0);
  const [eligibility, setEligibility] = useState<{ eligible: boolean; replaceRequired?: boolean; reason?: string }>();
  const [replace, setReplace] = useState(false), [prompt, setPrompt] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const params = new URLSearchParams(runId ? { runId } : { messageId: messageId ?? "" });
    request(`/api/sessions/${encodeURIComponent(sessionId)}/branch?${params}`, { signal: controller.signal }).then(value => { setEligibility(value); setReplace(!!value.replaceRequired); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [sessionId, runId, messageId, check]);
  const submit = async () => {
    if (busy || !eligibility?.eligible || harness === "claude-code" && !prompt.trim()) return;
    setAttempted(true); setBusy(true); setError("");
    try {
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, { method: "POST", body: JSON.stringify({ requestId, runId, messageId, replace, prompt }), signal: AbortSignal.timeout(120000) });
      close(); store.openConversation(result.sessionId);
    } catch (e) { setError(`${e instanceof Error ? e.message : "Branch request failed"} You can close this dialog and check your conversations. Retrying this same request will not create another branch.`); }
    finally { setBusy(false); }
  };
  return <ShellDialog className="branch-dialog" title="Branch from here" close={close} closeDisabled={busy}>
    <form className="branch-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="muted">Start a new conversation with the history through this turn. Files stay as they are.</p>
    {!eligibility && !error && <p className="muted" role="status">Checking whether this turn can be branched…</p>}
    {eligibility && !eligibility.eligible && <p className="notice error" role="alert">{eligibility.reason}</p>}
    <div><label className="branch-replace"><input type="checkbox" checked={replace} aria-describedby={replaceHintId} disabled={attempted || !eligibility?.eligible || !!eligibility?.replaceRequired} onChange={e => setReplace(e.target.checked)} /> Replace original</label>
    <p id={replaceHintId} className="muted branch-hint">{eligibility?.replaceRequired ? "Required to continue this conversation’s assigned phases. " : ""}{replace ? "The original stays read-only in History." : "Keep both conversations available."}</p></div>
    <label className="branch-prompt" htmlFor={promptId}>First message <span className="muted">{harness === "claude-code" ? "(required)" : "(optional)"}</span><textarea id={promptId} rows={5} value={prompt} required={harness === "claude-code"} maxLength={100000} readOnly={attempted} placeholder="Where would you like to take this conversation?" onChange={e => setPrompt(e.target.value)} /></label>
    {error && <p className="notice error" role="alert">{error}{!eligibility && <><br /><button type="button" className="text-button" onClick={() => setCheck(value => value + 1)}>Retry check</button></>}</p>}
    <div className="branch-dialog-actions"><button type="button" className="text-button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !eligibility?.eligible || harness === "claude-code" && !prompt.trim()}>{busy ? "Creating branch…" : attempted ? "Retry request" : "Create branch"}</button></div>
    </form>
  </ShellDialog>;
}

export function BranchLinks({ conversation }: { conversation?: Conversation }) {
  if (!conversation) return null;
  return <>
    {conversation.branchOrigin && <p className="branch-links"><FiGitBranch size={13} aria-hidden="true" /><button type="button" className="text-button" onClick={() => store.openConversation(conversation.branchOrigin!)}>Branched from original conversation</button></p>}
    {conversation.replacedBy && <p className="branch-links"><span>Read-only history</span><button type="button" className="text-button" onClick={() => store.openConversation(conversation.replacedBy!)}>Open replacement</button></p>}
  </>;
}
