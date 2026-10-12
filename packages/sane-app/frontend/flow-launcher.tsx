import { useEffect, useRef } from "react";
import { FiBookOpen, FiCode, FiCompass, FiGrid, FiTerminal } from "react-icons/fi";
import { FlowNavigation } from "./flow-navigation";
import "./flow-launcher.css";

// UI catalog only: each selection launches its existing, independently scoped flow.
const flows = [
  { id: "view-status", title: "View Status", icon: FiCompass, key: "s" },
  { id: "sane-review", title: "Review Documents", icon: FiBookOpen, key: "r" },
  { id: "terminal", title: "Terminal", icon: FiTerminal, key: "t" },
  { id: "python", title: "Python", icon: FiCode, key: "p" },
] as const;
export type FlowId = typeof flows[number]["id"];

export function FlowLauncher({ subtitle, close, onSelect, unavailable = {} }: {
  subtitle?: string;
  close: () => void;
  unavailable?: Partial<Record<FlowId, string>>;
  onSelect: (flow: FlowId) => void;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }, []);
  return <section ref={root} className="workstream-status-composer flow-launcher" aria-label="Flows" onKeyDown={event => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as Element;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [hidden], [inert]') || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    const flow = flows.find(flow => flow.key === event.key.toLowerCase());
    if (!flow || unavailable[flow.id]) return;
    event.preventDefault(); event.stopPropagation(); onSelect(flow.id);
  }}>
    <header className="workstream-status-heading"><div><FiGrid size={16} aria-hidden="true" /><strong>Flows</strong>{subtitle && <span>{subtitle}</span>}</div><FlowNavigation exit={close} /></header>
    <div className="flow-launcher-grid">
      {flows.map(({ id, title, icon: Icon, key }) => <button key={id} type="button" className="flow-launcher-card" disabled={!!unavailable[id]} aria-keyshortcuts={key} title={unavailable[id] ?? `${title} (${key.toUpperCase()})`} onClick={() => onSelect(id)}>
        <Icon size={28} aria-hidden="true" />
        <span>{title}</span>
        <kbd aria-hidden="true">{key.toUpperCase()}</kbd>
        {unavailable[id] && <small>{unavailable[id]}</small>}
      </button>)}
    </div>
  </section>;
}
