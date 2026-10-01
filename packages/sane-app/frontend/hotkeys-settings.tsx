import { commandHint } from "./application-commands";
import { NAVIGATION_HOTKEYS, navigationBinding } from "./navigation-hotkeys";
import "./hotkeys-settings.css";

export function HotkeysSettings() {
  return <section className="history-view hotkeys-settings" aria-label="Hotkeys settings">
    <header className="history-view-header"><h2>Hotkeys</h2></header>
    <p className="muted">Hold Cmd + Ctrl on Mac, or Ctrl + Alt on Windows and Linux, then press the view’s letter.</p>
    <p className="muted">Use the left Alt key. Right Alt (AltGr) stays available for typing special characters.</p>
    <section className="interaction" aria-labelledby="hotkeys-navigation">
      <h3 id="hotkeys-navigation">Navigation</h3>
      <div className="hotkeys-table-scroll"><table className="hotkeys-table" aria-labelledby="hotkeys-navigation">
        <thead><tr><th scope="col">View</th><th scope="col">Mac</th><th scope="col">Windows / Linux</th></tr></thead>
        <tbody>{NAVIGATION_HOTKEYS.map(item => <tr key={item.id}>
          <th scope="row">{item.label}</th>
          <td><kbd>{commandHint(navigationBinding(item.key, true), true)}</kbd></td>
          <td><kbd>{commandHint(navigationBinding(item.key, false), false)}</kbd></td>
        </tr>)}</tbody>
      </table></div>
      <p className="muted">These shortcuts work in chat inputs, file editors, and the terminal. They pause while a dialog is open and never submit a message. Opening Terminal starts a shell if the selected worktree has none.</p>
    </section>
  </section>;
}
