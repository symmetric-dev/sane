import { useState, useSyncExternalStore } from "react";
import { themeSettings, type ThemePreference } from "./theme-settings";

export function ThemeSettings() {
  const { preference } = useSyncExternalStore(themeSettings.subscribe, themeSettings.snapshot);
  const [error, setError] = useState("");
  return <section className="interaction" aria-labelledby="app-appearance">
    <h3 id="app-appearance">Appearance</h3>
    <div className="interaction-field"><label htmlFor="app-theme">Theme</label>
      <select id="app-theme" value={preference} aria-describedby="app-theme-help" onChange={event => {
        setError("");
        try { themeSettings.setPreference(event.target.value as ThemePreference); }
        catch (error) { setError(error instanceof Error ? error.message : "Could not save theme preference."); }
      }}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <small id="app-theme-help">Applies instantly to all workspaces in this browser. System follows your device’s appearance. Saved locally when browser storage is available, not synced to other browsers or devices.</small>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
