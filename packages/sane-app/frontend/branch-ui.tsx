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
    } catch (e) { setError(`${e instanceof Error ? e.message : "Branch request failed"} Inspect Branch status before trying again; an interrupted request may already have created the destination.`); }
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
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!conversation) return null;
  const op = conversation.branchOperation;
  return <>
    {conversation.branchOrigin && <p className="notice">Branched from <button type="button" className="text-button" onClick={() => store.openConversation(conversation.branchOrigin!)}>original conversation</button>. Files were not rewound.</p>}
    {conversation.replacedBy && <p className="notice">Replaced · read-only history. <button type="button" className="text-button" onClick={() => store.openConversation(conversation.replacedBy!)}>Open replacement</button></p>}
    {op && <section className="notice" aria-label="Branch status"><strong>Branch status · {op.state.replaceAll("_", " ")}</strong><p>{op.error || (op.state === "completed" ? "Native branch creation completed. First-message delivery needs attention." : "Branch confirmation is pending. Creation will not be replayed. Original membership transfers only after the destination is confirmed.")}</p>
      {op.state === "completed" ? <><p>The branch is retained, but its first-message run was not recorded. Inspect native history before resending; no message will be replayed automatically.</p><button type="button" onClick={() => { store.openConversation(conversation.id); store.setDraft({ text: op.firstMessage ?? "" }); }}>Recover first message to draft</button></> : op.state === "creation_unknown" && !op.nativeId ? <p>Destination identity is unknown. Recovery is blocked pending operator inspection; this version cannot safely attribute a native fork after a lost acknowledgement.</p> : <button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const result = await request(`/api/branches/${op.id}/recover`, { method: "POST" }); if (result.sessionId) store.openConversation(result.sessionId); } catch (e) { setError(e instanceof Error ? e.message : "Recovery failed"); } finally { setBusy(false); } }}>Recover branch operation</button>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </>;
}
