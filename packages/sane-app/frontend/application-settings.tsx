import { store, type State } from "./store";
import { harnessName } from "./types";
import { Facts } from "./thread";
import { CodeSettings } from "./code-settings-view";
import { ThemeSettings } from "./theme-settings-view";
import { InstallApp } from "./pwa-install-view";

const CAPABILITIES = [["cancelRun", "Cancel run"], ["permissionReplies", "Permission replies"], ["modelSelection", "Model selection"]] as const;

export function ApplicationSettings({ state, signOut }: { state: State; signOut: () => void }) {
  const harnesses = state.config?.harnesses ?? [], concurrency = state.config?.capabilities?.concurrency;
  return <section className="history-view app-settings" aria-label="Application settings">
    <header className="history-view-header"><h2>Application</h2></header>
    <ThemeSettings />
    <InstallApp />
    <CodeSettings />
    <section className="interaction" aria-labelledby="app-connection">
      <h3 id="app-connection">Connection</h3>
      <div className="application-status"><span className={`connection-dot ${state.connected ? "online" : ""}`} /><span>{state.connected ? "Local bridge connected" : "Connecting to bridge"}</span></div>
      {state.connectionError && <p className="notice error" role="alert">{state.connectionError}</p>}
      <div className="dialog-actions"><button type="button" onClick={store.reconnect}>Reconnect</button></div>
    </section>
    <section className="interaction" aria-labelledby="app-harnesses">
      <h3 id="app-harnesses">Harnesses</h3>
      {!harnesses.length && <p className="muted">No harnesses reported by the bridge.</p>}
      <ul className="app-harnesses">{harnesses.map(h => <li key={h.id}>
        <span className="history-line"><strong>{harnessName(h.id)}</strong><span className="harness-badge">{h.id}</span><span className="muted">{!h.available ? "Unavailable" : h.connected ? "Connected" : h.state || "Available"}</span></span>
        {!h.available && h.reason && <p className="muted">{h.reason}</p>}
        <span className="history-line">{CAPABILITIES.map(([key, label]) => <span key={key} className="harness-badge" data-off={!h.capabilities?.[key] || undefined}>{label}{h.capabilities?.[key] ? "" : " · no"}</span>)}</span>
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
