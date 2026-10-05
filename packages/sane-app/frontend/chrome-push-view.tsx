import { useEffect, useId, useSyncExternalStore } from "react";
import { chromePush } from "./chrome-push";

export function DeviceNotifications() {
  const state = useSyncExternalStore(chromePush.subscribe, chromePush.snapshot);
  const headingId = useId();
  useEffect(() => { void chromePush.refresh(); }, []);
  return <section className="interaction" aria-labelledby={headingId}>
    <h3 id={headingId}>Device notifications</h3>
    <p className="muted">Get new conversation activity from all workspaces on this device, even when SANE is closed. Session and workspace names may appear on the lock screen; reply text is not included. The bridge must remain running and reachable.</p>
    {!state.supported ? <p className="notice" role="status">{state.reason}</p> : <>
      {state.permission === "denied" ? <p className="notice" role="status">{state.permissionHelp}</p>
        : <p className="muted" role="status">{state.busy ? "Updating device notifications…" : state.enabled ? "Enabled on this device." : "Not enabled on this device."}</p>}
      {state.config && !state.config.available && <p className="notice" role="status">Device notifications are unavailable on this bridge. Reconnect and retry when it is available.</p>}
      {state.stale && <p className="notice" role="status">This browser subscription belongs to an earlier bridge or notification key. Enable again to replace it.</p>}
      <div className="dialog-actions">
        {!state.enabled && <button type="button" disabled={state.busy || !state.config?.available || state.permission === "denied"} onClick={() => void chromePush.enable()}>{state.stale ? "Enable again" : "Enable notifications"}</button>}
        {state.subscribed && <button type="button" disabled={state.busy} onClick={() => void chromePush.disable()}>Disable notifications</button>}
        {state.enabled && <button type="button" disabled={state.busy || state.permission !== "granted"} onClick={() => void chromePush.test()}>Send test</button>}
        <button type="button" disabled={state.busy} onClick={() => void chromePush.refresh()}>Refresh status</button>
      </div>
    </>}
    {state.notice && <p className="notice" role="status">{state.notice}</p>}
    {state.error && <p className="notice error" role="alert">{state.error}</p>}
  </section>;
}
