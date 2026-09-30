import { useEffect, useState } from "react";
import { request } from "./cc-client";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";
import type { Conversation, Harness } from "./types";

export function BranchAction({ sessionId, harness, runId, messageId }: { sessionId: string; harness: Harness; runId?: string; messageId?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="text-button" onClick={() => setOpen(true)}>Branch from here</button>{open && <BranchDialog key={`${sessionId}:${runId ?? messageId}`} {...{ sessionId, harness, runId, messageId }} close={() => setOpen(false)} />}</>;
}
function BranchDialog({ sessionId, harness, runId, messageId, close }: { sessionId: string; harness: Harness; runId?: string; messageId?: string; close: () => void }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [eligibility, setEligibility] = useState<{ eligible: boolean; replaceRequired?: boolean; reason?: string }>();
  const [replace, setReplace] = useState(false), [prompt, setPrompt] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(runId ? { runId } : { messageId: messageId ?? "" });
    request(`/api/sessions/${encodeURIComponent(sessionId)}/branch?${params}`, { signal: controller.signal }).then(value => { setEligibility(value); setReplace(!!value.replaceRequired); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [sessionId, runId, messageId]);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, { method: "POST", body: JSON.stringify({ requestId, runId, messageId, replace, prompt }), signal: AbortSignal.timeout(120000) });
      close(); store.openConversation(result.sessionId);
    } catch (e) { setError(`${e instanceof Error ? e.message : "Branch request failed"} You can close this dialog and check your conversations. Retrying this same request will not create another branch.`); }
    finally { setBusy(false); }
  };
  return <ShellDialog title="Branch from here" close={() => { if (!busy) close(); }}>
    <p>Copy native conversation history through this complete turn. The original history is retained.</p>
    <p className="notice">Files stay exactly as they are: no rewind or restore. Your first message can request further edits.</p>
    {!eligibility && !error && <p role="status">Checking native boundary and idle state…</p>}
    {eligibility && !eligibility.eligible && <p className="notice error" role="alert">{eligibility.reason}</p>}
    <label><input type="checkbox" checked={replace} disabled={busy || !!eligibility?.replaceRequired} onChange={e => setReplace(e.target.checked)} /> Replace original</label>
    <p className="muted">{eligibility?.replaceRequired ? "Required because this conversation has active phase assignments. " : ""}{replace ? "Transfer active membership and phases. The original becomes read-only in History." : "Keep both conversations visible and inherit the workstream membership."}</p>
    <label>First message {harness === "claude-code" ? "(required for Claude Code)" : "(optional)"}<textarea rows={5} value={prompt} maxLength={100000} disabled={busy} onChange={e => setPrompt(e.target.value)} /></label>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button type="button" className="primary-button" disabled={busy || !eligibility?.eligible || harness === "claude-code" && !prompt.trim()} onClick={() => void submit()}>{busy ? "Creating branch…" : "Create branch"}</button>
  </ShellDialog>;
}

export function BranchLinks({ conversation }: { conversation?: Conversation }) {
  if (!conversation) return null;
  return <>
    {conversation.branchOrigin && <p className="notice">Branched from <button type="button" className="text-button" onClick={() => store.openConversation(conversation.branchOrigin!)}>original conversation</button>. Files were not rewound.</p>}
    {conversation.replacedBy && <p className="notice">Replaced · read-only history. <button type="button" className="text-button" onClick={() => store.openConversation(conversation.replacedBy!)}>Open replacement</button></p>}
  </>;
}
