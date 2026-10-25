import { useEffect, useState, useSyncExternalStore } from "react";
import { conversationClient } from "./cc-client";
import { store, type State } from "./store";
import { harnessName, type HarnessInfo } from "./types";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";
import { Facts } from "./thread";
import { CodeSettings } from "./code-settings-view";
import { ThemeSettings } from "./theme-settings-view";
import { InstallApp } from "./pwa-install-view";
import { DeviceNotifications } from "./chrome-push-view";

const CAPABILITIES = [["cancelRun", "Cancel run"], ["permissionReplies", "Permission replies"], ["modelSelection", "Model selection"]] as const;
type HarnessDisplay = Pick<HarnessInfo, "id" | "available" | "connected" | "state" | "reason">;

export function ApplicationSettings({ state, signOut }: { state: State; signOut: () => void }) {
  const config = state.config, phase = state.phase;
  const auth = useSyncExternalStore(subscribeWorkspace, workspaceEpoch, workspaceEpoch);
  const [display, setDisplay] = useState<{ config: State["config"]; phase: State["phase"]; auth: number; harnesses?: HarnessDisplay[]; error?: string }>();
  useEffect(() => {
    setDisplay(undefined);
    if (!config || phase !== "ready" || !config.authenticated) return;
    let active = true, present = true;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const current = () => active && workspaceEpoch() === auth && store.snapshot().config === config && store.snapshot().phase === phase;
    const available = () => present && !document.hidden && navigator.onLine !== false;
    const pause = () => { clearTimeout(timer); timer = undefined; controller?.abort(); };
    const refresh = async () => {
      if (!current() || !available() || controller) return;
      clearTimeout(timer); timer = undefined;
      const pending = controller = new AbortController();
      const publishable = () => current() && available() && controller === pending && !pending.signal.aborted;
      try {
        const next = await conversationClient.config(pending.signal);
        if (!publishable()) return;
        if (!next || next.authenticated !== config.authenticated || next.authRequired !== config.authRequired
          || next.storeId !== config.storeId || next.cwd !== config.cwd) throw new Error("Bridge identity or sign-in changed. Reconnect to refresh harness status.");
        if (!Array.isArray(next.harnesses) || next.harnesses.some(h => !h || (h.id !== "opencode" && h.id !== "claude-code")
          || typeof h.available !== "boolean" || typeof h.connected !== "boolean" || typeof h.state !== "string"
          || (h.reason !== undefined && typeof h.reason !== "string"))) throw new Error("Invalid harness status response.");
        // Display only: never hydrate config or adopt refreshed permission/capability data.
        const harnesses = next.harnesses.map(({ id, available, connected, state, reason }) => ({ id, available, connected, state, reason }));
        setDisplay({ config, phase, auth, harnesses });
      } catch (error) {
        if (publishable()) setDisplay(previous => ({ config, phase, auth,
          harnesses: previous && previous.config === config && previous.phase === phase && previous.auth === auth ? previous.harnesses : undefined,
          error: error instanceof Error ? error.message : "Harness status request failed." }));
      } finally {
        if (controller === pending) {
          const cancelled = pending.signal.aborted;
          controller = undefined; pending.abort();
          if (current() && available()) timer = setTimeout(() => void refresh(), cancelled ? 0 : 7500);
        }
      }
    };
    const resume = () => { if (available()) void refresh(); else pause(); };
    const show = () => { present = true; resume(); };
    const hide = () => { present = false; pause(); };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", show);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      active = false; pause();
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [config, phase, auth]);
  const local = display && display.config === config && display.phase === phase && display.auth === auth ? display : undefined;
  const harnesses = local?.harnesses ?? config?.harnesses ?? [], concurrency = config?.capabilities?.concurrency;
  return <section className="history-view app-settings" aria-label="Application settings">
    <header className="history-view-header"><h2>Application</h2></header>
    <ThemeSettings />
    <InstallApp />
    <DeviceNotifications />
    <CodeSettings />
    <section className="interaction" aria-labelledby="app-connection">
      <h3 id="app-connection">Connection</h3>
      <div className="application-status"><span className={`connection-dot ${state.connected ? "online" : ""}`} /><span>{state.connected ? "Local bridge connected" : "Connecting to bridge"}</span></div>
      {state.connectionError && <p className="notice error" role="alert">{state.connectionError}</p>}
      <div className="dialog-actions"><button type="button" onClick={store.reconnect}>Reconnect</button></div>
    </section>
    <section className="interaction" aria-labelledby="app-harnesses">
      <h3 id="app-harnesses">Harnesses</h3>
      {local?.error && <p className="notice error" role="alert">Harness status is unknown: {local.error}</p>}
      {!harnesses.length && <p className="muted">No harnesses reported by the bridge.</p>}
      <ul className="app-harnesses">{harnesses.map(h => <li key={h.id}>
        <span className="history-line"><strong>{harnessName(h.id)}</strong><span className="harness-badge">{h.id}</span><span className="muted">{local?.error ? "Unknown" : !h.available ? "Unavailable" : h.connected ? "Connected" : h.state || "Available"}</span></span>
        {!local?.error && !h.available && h.reason && <p className="muted">{h.reason}</p>}
        <span className="history-line">{CAPABILITIES.map(([key, label]) => {
          const supported = config?.harnesses?.find(item => item.id === h.id)?.capabilities?.[key];
          return <span key={key} className="harness-badge" data-off={!supported || undefined}>{label}{supported ? "" : " · no"}</span>;
        })}</span>
      </li>)}</ul>
    </section>
    <section className="interaction" aria-labelledby="app-bridge">
      <h3 id="app-bridge">Bridge</h3>
      <Facts values={[["Working directory", state.config?.cwd], ["Auth required", state.config ? state.config.authRequired ? "Yes" : "No" : undefined], ...(concurrency ? [["Max concurrent runs", `${concurrency.limit} · ${concurrency.scope}`] as [string, string]] : [])]} />
    </section>
    {state.config?.authRequired && <section className="interaction" aria-labelledby="app-account">
      <h3 id="app-account">Account</h3>
      <div className="dialog-actions"><button type="button" disabled={state.sending} onClick={signOut}>Sign out</button></div>
    </section>}
  </section>;
}
