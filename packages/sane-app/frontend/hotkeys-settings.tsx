import { GLOBAL_SHORTCUTS, SHORTCUT_DEFINITIONS, shortcutHint, type ShortcutDefinition } from "./shortcut-definitions";
import "./hotkeys-settings.css";

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
  return <section className="history-view hotkeys-settings" aria-label="Shortcuts settings">
    <header className="history-view-header"><h2>Shortcuts</h2></header>
    <section className="interaction" aria-labelledby="hotkeys-global">
      <h3 id="hotkeys-global">Global</h3>
      <h4 id="hotkeys-navigation">Navigation</h4>
      <p className="muted">Hold Cmd + Ctrl on Mac, or Ctrl + Alt on Windows and Linux, then press the view’s letter.</p>
      <p className="muted">Use the left Alt key. Right Alt (AltGr) stays available for typing special characters.</p>
      <ShortcutTable definitions={GLOBAL_SHORTCUTS} labelledBy="hotkeys-navigation" />
      <p className="muted">These shortcuts work in chat inputs, file editors, and the terminal. They pause while a dialog is open and never submit a message. Opening Terminal starts a shell if the selected worktree has none.</p>
    </section>
    <section className="interaction" aria-labelledby="hotkeys-local">
      <h3 id="hotkeys-local">Local to a View</h3>
      <section aria-labelledby="hotkeys-files">
        <h4 id="hotkeys-files">Files</h4>
        {FILE_REGIONS.map(region => <section className="hotkeys-region" key={region.id} aria-labelledby={`hotkeys-files-${region.id}`}>
          <h5 id={`hotkeys-files-${region.id}`}>{region.label}</h5>
          <ShortcutTable definitions={SHORTCUT_DEFINITIONS.filter(item => item.scope.kind === "view" && item.scope.view === "files" && item.scope.region === region.id)} labelledBy={`hotkeys-files-${region.id}`} />
          {region.id === "sidebar" && <>
            <p className="muted">Sidebar shortcuts require focus in the Files tree and pause while a dialog is open. Normal text copy/paste is unchanged.</p>
            <p className="muted">Initially, the file clipboard holds one saved file and stays within the same worktree. Paste opens the existing Copy destination dialog with the destination prefilled.</p>
          </>}
          {region.id === "main-panel" && <p className="muted">These shortcuts use the focused editor or supported preview. Text paste requires an editable editor or input.</p>}
        </section>)}
      </section>
    </section>
  </section>;
}
