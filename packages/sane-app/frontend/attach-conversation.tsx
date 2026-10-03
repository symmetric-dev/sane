import { useRef, useState } from "react";
import { ShellDialog } from "./shell-dialog";
import { request } from "./cc-client";
import { catalog } from "./catalog";
import { store } from "./store";
import type { Harness } from "./types";
import { getHarnessDescriptor } from "../shared/conversation/harness-capabilities";

export function AttachConversation({ onChoose }: { onChoose: (id: string) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [harness, setHarness] = useState<Harness>("opencode");
  const capabilities = store.capabilities(harness);
  const descriptor = getHarnessDescriptor(harness);
  const [attached, setAttached] = useState<{ sessionId: string; cwd: string } | null>(null);
  const intent = useRef(0);
  const openAttached = async (result: { sessionId: string; cwd: string }, epoch: number) => {
    setBusy(true); setError("");
    try {
      const opened = await catalog.open(result.cwd, () => epoch === intent.current);
      if (epoch !== intent.current) return;
      if (!opened) throw new Error(catalog.state.error || "Workspace refresh unavailable");
      store.reconnect(); onChoose(result.sessionId); setOpen(false);
    } catch (e) {
      if (epoch === intent.current) setError(`Attachment succeeded. Opening the conversation failed: ${e instanceof Error ? e.message : "Navigation unavailable"}. Retry opening below; do not attach again.`);
    } finally { setBusy(false); }
  };
  return <><button type="button" className="new-chat" disabled={busy || store.state.sending || !store.capabilities("opencode").attachHistory && !store.capabilities("claude-code").attachHistory} onClick={() => { intent.current++; setError(""); setOpen(true); }}>Attach native conversation…</button>{open && <ShellDialog title="Attach native conversation" close={() => { intent.current++; setOpen(false); }}>
    {attached ? <section>
      <p role="status">Attached successfully. App conversation ID: <code>{attached.sessionId}</code></p>
      <p>Execution checkout: {attached.cwd}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void openAttached(attached, intent.current)}>{busy ? "Opening…" : "Open attached conversation"}</button>
      <button type="button" disabled={busy} onClick={() => { intent.current++; setAttached(null); setError(""); }}>Attach another conversation</button>
    </section> : <form className="open-directory" onSubmit={async event => {
      event.preventDefault(); if (busy || !capabilities.attachHistory) return;
      const form = new FormData(event.currentTarget), nativeSessionId = String(form.get("nativeSessionId") ?? "").trim(), cwd = String(form.get("cwd") ?? "").trim();
      if (!nativeSessionId || !cwd) return;
      const epoch = intent.current; setBusy(true); setError("");
      let result: { sessionId: string; cwd: string };
      try {
        const response = await request("/api/sessions/attach", { method: "POST", body: JSON.stringify({ harness, nativeSessionId, cwd }) });
        result = { sessionId: response.sessionId, cwd };
        // Acknowledged registration survives navigation failure or dialog close.
        setAttached(result);
      } catch (e) { if (epoch === intent.current) setError(e instanceof Error ? e.message : "Attachment failed"); setBusy(false); return; }
      if (epoch !== intent.current) { setBusy(false); return; }
      await openAttached(result, epoch);
    }}>
      <label>Native harness<select disabled={busy} value={harness} onChange={e => setHarness(e.target.value as Harness)}><option value="opencode" disabled={!store.capabilities("opencode").attachHistory}>OpenCode</option><option value="claude-code" disabled={!store.capabilities("claude-code").attachHistory}>Claude Code</option></select></label>
      <label>Native session ID<input name="nativeSessionId" required disabled={busy} placeholder={descriptor?.nativeHarness === "oc" ? "ses_…" : descriptor?.nativeHarness === "cc" ? "Session UUID" : "Native session ID"} /></label>
      <label>Actual execution checkout<input name="cwd" required disabled={busy} defaultValue={store.workspace()} placeholder="/absolute/repository/root" /></label>
      <p>Reads existing native history through this server’s configured native authority. Does not send a prompt, create a replacement session or move its execution directory. Finish native work first; never use both clients concurrently for the same conversation.</p>
      {capabilities.attachedSendRequiresNativeStopped && <p>External assistant activity is unknown: this harness cannot report running execution. Before every SANE send you must confirm external execution is stopped.</p>}
      <p>If registration is incomplete, retry these same identity and checkout values after resolving the reported error. Existing evidence is retained.</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      <button type="submit" disabled={busy || !capabilities.attachHistory}>{busy ? "Verifying native history…" : "Verify and attach"}</button>
    </form>}
  </ShellDialog>}</>;
}
