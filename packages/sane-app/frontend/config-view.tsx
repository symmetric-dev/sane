import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FiPlus, FiSliders, FiUsers } from "react-icons/fi";
import { ASSISTANT_AGENT_LABELS, WORKER_AGENT_CATALOG, isAssistantAgentId, isWorkerAgentId } from "sane-core/agent-catalog";
import { AGENT_COLOR_IDS, AGENT_ICON_IDS, type AgentColor, type AgentIconId } from "../src/agent-profiles-contract";
import { store, type State } from "./store";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { AGENT_ICONS, AgentCard, agentColor, moveCardFocus } from "./agent-visuals";
import { harnessName, type AgentProfile, type Harness } from "./types";
import { ApplicationSettings } from "./application-settings";

// Client-side mirrors of src/history.ts validModel/validEffort/validVariant and
// src/bridge.ts submit validation (model always, effort per harness, variant
// only with a resolvable model). Empty preserves agent/native defaults. Kept as
// local copies so the browser bundle never imports node:path via src/history.
const ccEffortIds = ["low", "medium", "high", "xhigh", "max"];
const validModel = (v: string) => v.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(v);
const validEffort = (v: string) => ccEffortIds.includes(v);
const validVariant = (v: string) => v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);

type Pair = { model: string; effort: string };
const ccError = (pair: Pair) => {
  if (pair.model && !validModel(pair.model)) return "Invalid model ID. Use letters, numbers, and . _ : / [ ] - (up to 200 characters).";
  if (pair.effort && !validEffort(pair.effort)) return "Effort must be low, medium, high, xhigh, or max.";
  return "";
};
const ocError = (pair: Pair, kind: AgentProfile["kind"]) => {
  if (pair.model && !validModel(pair.model)) return "Invalid model ID. Use letters, numbers, and . _ : / [ ] - (up to 200 characters).";
  if (kind === "base" && pair.effort && !pair.model) return "Select a model before selecting a variant.";
  if (pair.effort && !validVariant(pair.effort)) return "Invalid native variant ID.";
  return "";
};
const errorFor = (harness: Harness, pair: Pair, kind: AgentProfile["kind"]) => harness === "opencode" ? ocError(pair, kind) : ccError(pair);

type Form = { label: string; description: string; harness: Harness; model: string; effort: string; icon: AgentIconId; color: AgentColor; hidden: boolean };
const toForm = (p: AgentProfile): Form => ({ label: p.label, description: p.description, harness: p.harness, model: p.model, effort: p.effort, icon: p.icon, color: p.color, hidden: !!p.hidden });
const formError = (form: Form, kind: AgentProfile["kind"]) => !form.label.trim() ? "Name is required." : form.label.trim().length > 80 ? "Name must be 80 characters or fewer." : form.description.length > 400 ? "Description must be 400 characters or fewer." : errorFor(form.harness, form, kind);
const copyLabel = (p: AgentProfile) => `${p.label} copy`.slice(0, 80);

export type ConfigSection = "agents" | "application";
const SECTION_KEY = "sane.configSection";
let section: ConfigSection = (() => { try { return localStorage.getItem(SECTION_KEY) === "application" ? "application" : "agents"; } catch { return "agents"; } })();
const sectionListeners = new Set<() => void>();
export const configSection = {
  snapshot: () => section,
  subscribe: (listener: () => void) => { sectionListeners.add(listener); return () => { sectionListeners.delete(listener); }; },
  set: (next: ConfigSection) => { section = next; try { localStorage.setItem(SECTION_KEY, next); } catch {} sectionListeners.forEach(l => l()); },
};
const SECTIONS = [
  { id: "agents", label: "Agents", hint: "Conversation and worker profiles", Icon: FiUsers },
  { id: "application", label: "Application", hint: "Connection, harnesses, account", Icon: FiSliders },
] as const;

export function ConfigMenu({ onSelect }: { onSelect?: () => void }) {
  const current = useSyncExternalStore(configSection.subscribe, configSection.snapshot);
  return <nav className="history-list config-menu" aria-label="Settings sections">{SECTIONS.map(item => <button type="button" key={item.id} className={current === item.id ? "selected" : ""} aria-current={current === item.id ? "page" : undefined} onClick={() => { configSection.set(item.id); onSelect?.(); }}><span className="history-line"><item.Icon size={15} aria-hidden="true" /><span className="history-title">{item.label}</span></span><small className="muted config-menu-hint">{item.hint}</small></button>)}</nav>;
}

export function ConfigView({ state, signOut }: { state: State; signOut: () => void }) {
  const current = useSyncExternalStore(configSection.subscribe, configSection.snapshot);
  return current === "application" ? <ApplicationSettings state={state} signOut={signOut} /> : <AgentSettings state={state} />;
}

function AgentSettings({ state }: { state: State }) {
  const set = store.profileSet();
  const list = store.profileList();
  const [tab, setTab] = useState<"assistants" | "workers">("assistants");
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [chooser, setChooser] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = () => opener.current?.isConnected ? opener.current : document.getElementById(`agents-tab-${tab}`);
  const rememberFocus = () => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const open = (profile: AgentProfile) => { rememberFocus(); store.clearProfileError(); setEditing(profile); };
  const create = async (from: AgentProfile) => {
    if (from.kind === "worker") return;
    const created = await store.createProfile(from.id, { label: copyLabel(from), hidden: false });
    if (created) { setChooser(false); setEditing(created); }
  };
  const cards = (items: AgentProfile[]) => items.map(p => <AgentCard key={p.id} profile={p} edit tag={p.hidden ? "Hidden" : p.id === set.defaultId ? "Default" : undefined} onSelect={() => open(p)} />);
  return <section className="history-view agent-config-view" aria-label="Agent configuration">
    <header className="history-view-header"><h2>Agents</h2></header>
    <p className="muted agent-config-intro">Configure new conversations and worker launches. Existing sessions keep their saved configuration.</p>
    <div className="agent-tabs" role="tablist" aria-label="Agent types">{(["assistants", "workers"] as const).map(value => <button key={value} type="button" role="tab" id={`agents-tab-${value}`} aria-selected={tab === value} aria-controls={`agents-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "assistants" : event.key === "End" ? "workers" : value === "assistants" ? "workers" : "assistants";
      setTab(next); document.getElementById(`agents-tab-${next}`)?.focus();
    }}>{value === "assistants" ? "Assistants" : "Workers"}</button>)}</div>
    {!editing && !chooser && state.profileError && <p className="notice error" role="alert">{state.profileError}</p>}
    <div ref={grid} className="agent-config-grid" onKeyDown={event => moveCardFocus(event, grid.current)}>
      <div role="tabpanel" id="agents-panel-assistants" aria-labelledby="agents-tab-assistants" hidden={tab !== "assistants"}>
        <section className="agent-section" aria-label="Assistants"><div className="agent-grid">
          {cards(list.filter(p => p.kind === "assistant"))}
          <button type="button" className="agent-card agent-new" disabled={state.profileBusy} onClick={() => { rememberFocus(); store.clearProfileError(); setChooser(true); }}><span className="agent-new-mark" aria-hidden="true"><FiPlus size={16} /></span><span className="agent-card-label">New assistant</span><span className="agent-card-description">Start from an existing conversation profile.</span></button>
        </div></section>
        <section className="agent-section agent-base-section" aria-labelledby="agent-base-title"><h3 id="agent-base-title">Base defaults</h3><p className="muted">Harness defaults without SANE instructions.</p><div className="agent-grid">{cards(list.filter(p => p.kind === "base"))}</div></section>
      </div>
      <div role="tabpanel" id="agents-panel-workers" aria-labelledby="agents-tab-workers" hidden={tab !== "workers"}>
        <p className="muted">Fixed worker roles launched through orchestration. Edit their profiles for future launches.</p>
        <div className="agent-grid">{cards(list.filter(p => p.kind === "worker"))}</div>
      </div>
    </div>
    {editing ? <AgentEditor key={editing.id} profile={editing} state={state} close={() => setEditing(null)} created={setEditing} restoreFocus={restoreFocus} /> : chooser && <ShellDialog title="New assistant" restoreFocus={restoreFocus} close={() => { if (!state.profileBusy) setChooser(false); }}><p className="muted">Choose a profile to duplicate, then edit its name and settings.</p>{state.profileError && <p className="notice error" role="alert">{state.profileError}</p>}<div className="agent-picker"><div className="agent-grid">{list.filter(p => p.kind !== "worker").map(p => <AgentCard key={p.id} profile={p} disabled={state.profileBusy} onSelect={() => void create(p)} />)}</div></div></ShellDialog>}
  </section>;
}

function AgentEditor({ profile, state, close, created, restoreFocus }: { profile: AgentProfile; state: State; close: () => void; created: (profile: AgentProfile) => void; restoreFocus: () => HTMLElement | null }) {
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const set = store.profileSet();
  const [form, setForm] = useState<Form>(() => toForm(profile));
  const [confirmation, setConfirmation] = useState<"discard" | "delete" | "reset" | "duplicate" | null>(null);
  const confirmFocus = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { if (state.profileError && !confirmation) errorNotice.current?.scrollIntoView({ block: "nearest" }); }, [state.profileError, confirmation]);
  useEffect(() => {
    if (confirmation) confirmFocus.current?.focus();
    else if (returnFocus.current) (returnFocus.current.isConnected ? returnFocus.current : document.getElementById("agent-label"))?.focus();
  }, [confirmation]);
  const workspace = store.workspace();
  // Keep the OpenCode catalog fresh per worktree root, like the chat composer.
  useEffect(() => {
    if (form.harness === "opencode" && (state.modelsCwd !== workspace || (!state.modelsLoaded && !state.modelsLoading && !state.modelsError))) {
      const timer = setTimeout(() => void store.loadModels(), 300);
      return () => clearTimeout(timer);
    }
  }, [form.harness, workspace, state.modelsCwd, state.modelsLoaded, state.modelsLoading, state.modelsError]);

  const fixedHarness = profile.builtin && profile.kind === "base", busy = state.profileBusy;
  const patch = (next: Partial<Form>) => setForm(previous => ({ ...previous, ...next }));
  const problem = formError(form, profile.kind);
  const dirty = (Object.keys(form) as (keyof Form)[]).some(key => form[key] !== toForm(profile)[key]);
  const isDefault = set.defaultId === profile.id;
  const reported = state.config?.harnesses?.find(h => h.id === "claude-code")?.capabilities?.effortValues ?? state.config?.capabilities?.effortValues ?? [];
  const ccOptions = (reported.length ? reported : ccEffortIds).map(id => ({ id, name: `${id[0]?.toUpperCase()}${id.slice(1)} effort` }));
  const ocModels = state.modelsCwd === workspace ? state.models : [];
  const ocEfforts = ocModels.find(m => m.id === form.model)?.efforts ?? [];
  // Warn-not-fail, like the composer: a selection absent from the live per-cwd
  // catalog still sends with the saved value for native resolution.
  const ocMissing = form.harness === "opencode" && !!form.model && state.modelsLoaded && state.modelsCwd === workspace && !state.modelsError && !state.models.some(m => m.id === form.model);
  const customHex = /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : "#635877";
  const ask = (action: NonNullable<typeof confirmation>) => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmation(action); };
  const dismiss = () => { if (busy) return; if (confirmation) { setConfirmation(null); return; } if (dirty) ask("discard"); else close(); };
  const save = async () => {
    if (!dirty || problem || busy) return;
    const saved = await store.saveProfile(profile.id, { ...form, label: form.label.trim(), description: form.description.trim() });
    if (saved && !store.snapshot().profileError) close();
  };
  const confirm = async () => {
    if (confirmation === "discard") { close(); return; }
    if (confirmation === "delete") { if (await store.deleteProfile(profile.id)) close(); }
    if (confirmation === "reset") { const reset = await store.resetProfile(profile.id); if (reset) { setForm(toForm(reset)); created(reset); } }
    if (confirmation === "duplicate") { const copy = await store.createProfile(profile.id, { label: copyLabel(profile), hidden: false }); if (copy) created(copy); }
    setConfirmation(null);
  };
  return <ShellDialog title={`Edit ${profile.label}`} close={dismiss} className="agent-edit-dialog" restoreFocus={restoreFocus}>
    {confirmation ? <><div className="agent-edit-body"><h3>{confirmation === "discard" ? "Discard unsaved changes?" : confirmation === "delete" ? "Delete this profile?" : confirmation === "reset" ? "Reset this profile to its template?" : "Duplicate saved profile?"}</h3><p>{confirmation === "delete" ? "Existing conversations keep their settings." : confirmation === "duplicate" ? "The copy starts from saved settings. Unsaved changes here will be discarded." : "Unsaved changes will be discarded."}</p></div><footer className="dialog-actions agent-actions"><button ref={confirmFocus} type="button" disabled={busy} onClick={() => setConfirmation(null)}>Keep editing</button><button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Working…" : confirmation === "discard" ? "Discard changes" : confirmation === "delete" ? "Delete profile" : confirmation === "reset" ? "Reset profile" : "Duplicate"}</button></footer></> : <>
      <div className="agent-edit-body">
        <p className="muted">Changes apply to {profile.kind === "worker" ? "future worker launches" : "new conversations"}. Existing sessions keep their saved configuration.</p>
        {state.profileError && <p ref={errorNotice} className="notice error" role="alert">{state.profileError}</p>}
        <fieldset className="interaction-fields" disabled={busy}>
          <div className="interaction-field"><label htmlFor="agent-label">Name</label><input id="agent-label" value={form.label} maxLength={80} onChange={event => patch({ label: event.target.value })} /></div>
          <div className="interaction-field"><label htmlFor="agent-description">Description</label><textarea id="agent-description" rows={2} value={form.description} maxLength={400} onChange={event => patch({ description: event.target.value })} /></div>
          <div className="interaction-field"><span className="agent-field-label">Fixed role</span><span className="agent-readonly">{profile.kind === "base" ? "None (harness defaults, no instructions)" : isWorkerAgentId(profile.role) ? `Worker · ${WORKER_AGENT_CATALOG[profile.role].label}` : isAssistantAgentId(profile.role) ? `Assistant · ${ASSISTANT_AGENT_LABELS[profile.role]}` : profile.role}</span></div>
          <div className="interaction-field"><span className="agent-field-label" id="agent-harness">Harness</span><div className="agent-segmented" role="group" aria-labelledby="agent-harness">{(["claude-code", "opencode"] as const).map(h => <button type="button" key={h} aria-pressed={form.harness === h} disabled={fixedHarness} onClick={() => { if (form.harness !== h) patch({ harness: h, model: "", effort: "" }); }}>{harnessName(h)}</button>)}</div><small>{fixedHarness ? "Fixed for built-in Base." : "Changing harness clears the model and effort selection."}</small></div>
          {form.harness === "opencode" ? <>
             <div className="interaction-field"><label htmlFor="agent-oc-model">Model</label><select id="agent-oc-model" value={form.model} disabled={state.modelsLoading && !ocModels.length} onChange={event => patch({ model: event.target.value, effort: "" })}><option value="">{profile.kind === "base" ? "Native default" : "Agent default model"}</option>{form.model && !ocModels.some(m => m.id === form.model) && <option value={form.model}>{form.model} · not in catalog</option>}{ocModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><small>{state.modelsLoading ? "Loading the live catalog…" : profile.kind === "base" ? "Live catalog for the current directory. Empty means the native default." : "Empty uses the agent's configured model, then the native default."}</small></div>
            <div className="interaction-field"><label htmlFor="agent-oc-variant">Model variant</label>{!form.model && profile.kind !== "base" ? <><input id="agent-oc-variant" value={form.effort} maxLength={200} placeholder="Agent default variant" onChange={event => patch({ effort: event.target.value })} /><small>Variant ID for the agent's configured model. Its variants are not listed here. Launch requires a resolvable agent model; empty preserves its default variant.</small></> : <select id="agent-oc-variant" value={form.effort} disabled={!form.model || (!ocEfforts.length && !form.effort)} onChange={event => patch({ effort: event.target.value })} title={!form.model ? "Select a model before selecting a variant" : undefined}><option value="">Default variant</option>{form.effort && !ocEfforts.some(e => e.id === form.effort) && <option value={form.effort}>{form.effort}</option>}{ocEfforts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}</div>
          </> : <>
            <div className="interaction-field"><label htmlFor="agent-cc-model">Model</label><input id="agent-cc-model" list="agent-cc-models" value={form.model} onChange={event => patch({ model: event.target.value.trim() })} placeholder="Default model" maxLength={200} /><datalist id="agent-cc-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist><small>Empty means the native default. Custom IDs supported.</small></div>
             <div className="interaction-field"><label htmlFor="agent-cc-effort">Reasoning effort</label><select id="agent-cc-effort" value={form.effort} onChange={event => patch({ effort: event.target.value })}><option value="">Native default effort</option>{form.effort && !ccOptions.some(value => value.id === form.effort) && <option value={form.effort}>{form.effort}</option>}{ccOptions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
          </>}
          <details className="agent-appearance"><summary>Appearance</summary><div className="interaction-field"><span className="agent-field-label" id="agent-icon">Icon</span><div className="agent-icon-grid" role="group" aria-labelledby="agent-icon">{AGENT_ICON_IDS.map(id => { const Glyph = AGENT_ICONS[id]; return <button type="button" key={id} aria-pressed={form.icon === id} aria-label={id} title={id} onClick={() => patch({ icon: id })}><Glyph size={15} aria-hidden="true" /></button>; })}</div></div>
          <div className="interaction-field"><span className="agent-field-label" id="agent-color">Color</span><div className="agent-swatches" role="group" aria-labelledby="agent-color">{AGENT_COLOR_IDS.map(id => <button type="button" key={id} className="agent-swatch" aria-pressed={form.color === id} aria-label={id} title={id} style={{ background: agentColor(id) }} onClick={() => patch({ color: id })} />)}<label className="agent-swatch agent-swatch-custom" data-selected={form.color.startsWith("#") || undefined} title="Custom color" style={{ background: form.color.startsWith("#") ? form.color : undefined }}><span className="sr-only">Custom color</span><input type="color" value={customHex} onChange={event => patch({ color: event.target.value as AgentColor })} /></label></div></div>
          </details>
        </fieldset>
        {state.modelsError && form.harness === "opencode" && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></p>}
        {ocMissing && <p className="notice" role="status">Model {form.model} is not in the current OpenCode catalog for this directory. Sending will still use the selection.</p>}
        {problem && <p className="notice error" role="alert">{problem}</p>}
        {profile.kind !== "worker" && <div className="agent-toggles">
          <label className="agent-toggle" title={isDefault ? "The default agent cannot be hidden" : undefined}><input type="checkbox" checked={form.hidden} disabled={isDefault || busy} onChange={event => patch({ hidden: event.target.checked })} /><span>Hidden from conversation picker</span></label>
          <button type="button" className="text-button" disabled={isDefault || busy || dirty || !!profile.hidden} onClick={() => void store.setDefaultProfile(profile.id)}>{isDefault ? "Default for new conversations" : "Use saved profile as conversation default"}</button>
          {dirty && !isDefault && <small className="muted">Save changes before making this the default.</small>}
        </div>}
        <div className="dialog-actions agent-actions agent-secondary-actions">
          {!profile.builtin && profile.kind !== "worker" && <button type="button" className="agent-danger" disabled={busy || isDefault} title={isDefault ? "Choose another default before deleting" : undefined} onClick={() => ask("delete")}>Delete</button>}
          {profile.builtin && <button type="button" disabled={busy} onClick={() => ask("reset")}>{fixedHarness ? "Reset to defaults" : "Reset to template"}</button>}
          {profile.kind !== "worker" && <button type="button" disabled={busy} onClick={() => ask("duplicate")}>Duplicate</button>}
        </div>
      </div>
      <footer className="dialog-actions agent-actions"><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button type="button" className="agent-save" disabled={busy || !dirty || !!problem} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button></footer>
    </>}
  </ShellDialog>;
}
