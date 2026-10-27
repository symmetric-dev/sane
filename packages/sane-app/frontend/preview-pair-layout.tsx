import { useId, type ReactNode } from "react";
import { LuFolderTree, LuSparkles } from "react-icons/lu";
import "./preview-pair-layout.css";

export type PreviewPairPane = "preview" | "conversation";

/** The resource list and agent history share a sidebar, never two competing sidebars. */
export function PreviewPairSidebar({ label, paired, pane, setPane, resources, history, actions }: {
  label: string;
  paired: boolean;
  pane: PreviewPairPane;
  setPane: (pane: PreviewPairPane) => void;
  resources: ReactNode;
  history?: ReactNode;
  actions: ReactNode;
}) {
  const id = useId();
  return <section className={`preview-pair-sidebar${paired && pane === "conversation" ? " is-agent-history" : ""}`} aria-label={`${label} and paired agent`}>
    <header className="preview-pair-sidebar-header">
      {paired ? <div className="preview-pair-sidebar-switch" role="group" aria-label="Sidebar panel">
        <button type="button" aria-label={label} title={label} aria-pressed={pane === "preview"} aria-controls={`${id}-resources`} onClick={() => setPane("preview")}><LuFolderTree size={18} aria-hidden="true" /></button>
        <button type="button" aria-label="Agent history" title="Agent history" aria-pressed={pane === "conversation"} aria-controls={history ? `${id}-history` : undefined} onClick={() => setPane("conversation")}><LuSparkles size={18} aria-hidden="true" /></button>
      </div> : <strong>{label}</strong>}
      {actions}
    </header>
    <div id={`${id}-resources`} className="preview-pair-resources" hidden={paired && pane !== "preview"} inert={paired && pane !== "preview"}>{resources}</div>
    {history && <div id={`${id}-history`} className="preview-pair-history" hidden={!paired || pane !== "conversation"} inert={!paired || pane !== "conversation"}>{history}</div>}
  </section>;
}
