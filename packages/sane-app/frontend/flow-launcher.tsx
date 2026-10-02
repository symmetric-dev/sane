import { FiBookOpen } from "react-icons/fi";
import { ShellDialog } from "./shell-dialog";
import "./flow-launcher.css";

// UI catalog only: each selection launches its existing, independently scoped flow.
const flows = [{ id: "review-documents", title: "Review Documents", icon: FiBookOpen }] as const;
type FlowId = typeof flows[number]["id"];

export function FlowLauncher({ subtitle, close, restoreFocus, onSelect }: {
  subtitle?: string;
  close: () => void;
  restoreFocus: () => HTMLElement | null;
  onSelect: (flow: FlowId) => void;
}) {
  return <ShellDialog title="Flows" subtitle={subtitle} close={close} restoreFocus={restoreFocus} className="flow-launcher-dialog">
    <div className="flow-launcher-grid">
      {flows.map(({ id, title, icon: Icon }) => <button key={id} type="button" className="flow-launcher-card" onClick={() => onSelect(id)}>
        <Icon size={28} aria-hidden="true" />
        <span>{title}</span>
      </button>)}
    </div>
  </ShellDialog>;
}
