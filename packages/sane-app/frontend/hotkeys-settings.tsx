import { useState } from "react";
import { GLOBAL_SHORTCUTS, SHORTCUT_DEFINITIONS, shortcutHint, type ShortcutDefinition } from "./shortcut-definitions";
import "./hotkeys-settings.css";

const SHORTCUT_TABS = [
  { id: "global", label: "Global" },
  { id: "files", label: "Files View" },
] as const;

const FILE_REGIONS = [
  { id: "view", label: "View-wide" },
  { id: "sidebar", label: "Sidebar" },
  { id: "main-panel", label: "Main Panel" },
] as const;

function ShortcutTable({ definitions, labelledBy }: { definitions: readonly ShortcutDefinition[]; labelledBy: string }) {
  return <div className="hotkeys-table-scroll"><table className="hotkeys-table" aria-labelledby={labelledBy}>
    <thead><tr><th scope="col">Action</th><th scope="col">Mac</th><th scope="col">Windows / Linux</th></tr></thead>
    <tbody>{definitions.map(item => <tr key={item.id}>
      <th scope="row">{item.label}</th>
      <td><kbd>{shortcutHint(item, true)}</kbd></td>
      <td><kbd>{shortcutHint(item, false)}</kbd></td>
    </tr>)}</tbody>
  </table></div>;
}

export function HotkeysSettings() {
  const [tab, setTab] = useState<typeof SHORTCUT_TABS[number]["id"]>("global");
  return <section className="history-view hotkeys-settings" aria-label="Shortcuts settings">
    <div className="agent-tabs hotkeys-tabs" role="tablist" aria-label="Shortcut scopes">{SHORTCUT_TABS.map(item => <button key={item.id} type="button" role="tab" id={`hotkeys-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`hotkeys-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = SHORTCUT_TABS.indexOf(item);
      const next = SHORTCUT_TABS[event.key === "Home" ? 0 : event.key === "End" ? SHORTCUT_TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + SHORTCUT_TABS.length) % SHORTCUT_TABS.length]!;
      setTab(next.id); document.getElementById(`hotkeys-tab-${next.id}`)?.focus();
    }}>{item.label}</button>)}</div>
    <div role="tabpanel" id="hotkeys-panel-global" aria-labelledby="hotkeys-tab-global" hidden={tab !== "global"} tabIndex={0}>
      <section className="interaction" aria-labelledby="hotkeys-navigation">
        <h3 id="hotkeys-navigation">Navigation</h3>
        <p className="muted">Hold Cmd + Ctrl on Mac, or Ctrl + Alt on Windows and Linux, then press the view’s letter.</p>
        <p className="muted">Use the left Alt key. Right Alt (AltGr) stays available for typing special characters.</p>
        <ShortcutTable definitions={GLOBAL_SHORTCUTS} labelledBy="hotkeys-navigation" />
        <p className="muted">These shortcuts work in chat inputs, file editors, and the terminal. They pause while a dialog is open and never submit a message. Opening Terminal starts a shell if the selected worktree has none.</p>
      </section>
    </div>
    <div role="tabpanel" id="hotkeys-panel-files" aria-labelledby="hotkeys-tab-files" hidden={tab !== "files"} tabIndex={0}>
      <div className="interaction">
        {FILE_REGIONS.map(region => <section className="hotkeys-region" key={region.id} aria-labelledby={`hotkeys-files-${region.id}`}>
          <h3 id={`hotkeys-files-${region.id}`}>{region.label}</h3>
          <ShortcutTable definitions={SHORTCUT_DEFINITIONS.filter(item => item.scope.kind === "view" && item.scope.view === "files" && item.scope.region === region.id)} labelledBy={`hotkeys-files-${region.id}`} />
          {region.id === "sidebar" && <>
            <p className="muted">Sidebar shortcuts require focus in the Files tree and pause while a dialog is open. Normal text copy/paste is unchanged.</p>
            <p className="muted">Initially, the file clipboard holds one saved file and stays within the same worktree. Paste opens the existing Copy destination dialog with the destination prefilled.</p>
          </>}
          {region.id === "main-panel" && <p className="muted">These shortcuts use the focused editor or supported preview. Text paste requires an editable editor or input.</p>}
        </section>)}
      </div>
    </div>
  </section>;
}
