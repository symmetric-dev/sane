import { useEffect, useState, useSyncExternalStore } from "react";
import { codeSettings } from "./code-settings";

export function CodeSettings() {
  const extensions = useSyncExternalStore(codeSettings.subscribe, codeSettings.snapshot);
  const [input, setInput] = useState(extensions.join(", ")), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { setInput(extensions.join(", ")); }, [extensions]);
  return <section className="interaction" aria-labelledby="app-code-settings">
    <h3 id="app-code-settings">Code editor</h3>
    <form onSubmit={event => {
      event.preventDefault(); setError(""); setSaved(false);
      try { codeSettings.setWrapExtensions(input); setSaved(true); }
      catch (error) { setError(error instanceof Error ? error.message : "Could not save editor settings."); }
    }}>
      <div className="interaction-field"><label htmlFor="code-wrap-extensions">Line-wrapping extensions</label>
        <input id="code-wrap-extensions" value={input} placeholder=".md, .txt" aria-describedby="code-wrap-help" onChange={event => { setInput(event.target.value); setSaved(false); setError(""); }} />
        <small id="code-wrap-help">Wrap long lines visually without changing file contents. Applies to all workspaces in this browser, including diffs and read-only artifacts. Markdown (.md) is enabled by default. Leave empty to disable wrapping.</small>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {saved && <p className="muted" role="status">Editor settings saved.</p>}
      <div className="dialog-actions"><button type="submit">Save editor settings</button></div>
    </form>
  </section>;
}
