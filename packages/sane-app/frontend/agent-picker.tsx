import { useEffect, useRef, useState } from "react";
import { FiSettings } from "react-icons/fi";
import { store, useStore } from "./store";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { AgentCard, moveCardFocus } from "./agent-visuals";
import type { AgentProfile } from "./types";

const matches = (profile: AgentProfile, query: string) => !query || `${profile.label} ${profile.description} ${profile.role ?? "base"}`.toLowerCase().includes(query);

export function AgentPicker({ close, restoreFocus }: { close: () => void; restoreFocus?: () => HTMLElement | null }) {
  // Re-render on profile/draft/selection changes.
  useStore(s => s.profiles); useStore(s => s.drafts); useStore(s => s.selected);
  useStore(s => s.pendingInputs);
  const [query, setQuery] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const assign = !!store.state.selected;
  const chainLocked = assign && store.pendingInputChainLocked();
  useEffect(() => { if (chainLocked) close(); }, [chainLocked, close]);
  const currentId = assign ? store.pendingUpgrade()?.id ?? store.conversationProfileId(store.state.selected) : store.draftProfile().id;
  const q = query.trim().toLowerCase();
  const visible = store.profileList().filter(p => !p.hidden && matches(p, q));
  const choose = (profile: AgentProfile) => { if (store.state.selected && store.pendingInputChainLocked()) return; store.pickProfile(profile.id); close(); };
  const section = (title: string, list: AgentProfile[]) => !!list.length && <section className="agent-section" aria-label={title}>
    <h3>{title}</h3>
    <div className="agent-grid">{list.map(profile => { const check = store.assignable(profile); return <AgentCard key={profile.id} profile={profile} selected={profile.id === currentId} disabled={chainLocked || !check.ok} reason={chainLocked ? "Agent settings are fixed while the pending-input chain is active." : check.ok ? undefined : check.reason} onSelect={() => choose(profile)} />; })}</div>
  </section>;
  return <ShellDialog title={assign ? "Assign an assistant" : "Choose an agent"} close={close} restoreFocus={restoreFocus}>
    <div className="agent-picker">
      <label className="workspace-search"><span className="sr-only">Search agents</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search agents…" /></label>
      {assign && <p className="muted agent-picker-note">A Base conversation can be assigned one assistant on the same harness. The choice applies on your next message.</p>}
      <div ref={grid} className="agent-picker-sections" onKeyDown={event => moveCardFocus(event, grid.current)}>
        {section("Base", visible.filter(p => p.kind === "base"))}
        {section("Assistants", visible.filter(p => p.kind === "assistant"))}
        {!visible.length && <p className="muted">No matching agents.</p>}
      </div>
      <footer className="agent-picker-footer">
        {assign && store.pendingUpgrade() && <button type="button" className="text-button" disabled={chainLocked} onClick={() => { if (!store.pendingInputChainLocked()) { store.clearUpgrade(); close(); } }}>Keep Base</button>}
        <button type="button" className="text-button agent-manage" onClick={() => { close(); catalog.navigate({ view: "config" }); }}><FiSettings size={12} aria-hidden="true" />Manage agents</button>
      </footer>
    </div>
  </ShellDialog>;
}
