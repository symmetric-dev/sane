import { useId, useSyncExternalStore } from "react";
import { pwaInstall } from "./pwa-install";

export function InstallApp() {
  const { installed, available, busy, error } = useSyncExternalStore(pwaInstall.subscribe, pwaInstall.snapshot);
  const headingId = useId();
  if (installed) return null;
  return <section className="interaction" aria-labelledby={headingId}>
    <h3 id={headingId}>Install SANE</h3>
    <p className="muted">Open this workspace in its own app window. The bridge must still be running and reachable.</p>
    {!window.isSecureContext ? <p className="notice" role="status">Installation requires HTTPS or a localhost/loopback address.</p> : <>
      {(available || busy) && <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => void pwaInstall.install()}>{busy ? "Installing…" : "Install SANE"}</button></div>}
      {!available && !busy && <p className="muted">Use your browser’s Install app menu if available. In Safari on Mac, choose File → Add to Dock. On iPhone or iPad, use Share → Add to Home Screen.</p>}
    </>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
