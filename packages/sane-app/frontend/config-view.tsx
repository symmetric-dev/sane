import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FiPlus, FiSliders, FiUsers } from "react-icons/fi";
import { ASSISTANT_AGENT_LABELS, isAssistantAgentId } from "sane-core/agent-catalog";
import { AGENT_COLOR_IDS, AGENT_ICON_IDS, type AgentColor, type AgentIconId } from "../src/agent-profiles-contract";
import { store, type State } from "./store";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { AGENT_ICONS, AgentCard, agentColor, moveCardFocus } from "./agent-visuals";
import { harnessName, type AgentProfile, type Harness } from "./types";
import { Facts } from "./thread";
import { ApplicationSettings } from "./application-settings";

// Client-side mirrors of src/history.ts validModel/validEffort/validVariant and
// src/bridge.ts submit validation (model always, effort per harness, variant
// only with a model). Empty means native default and is always valid. Kept as
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

type Form = { label: string; description: string; harness: Harness; model: string; effort: string; icon: AgentIconId; color: AgentColor };
const toForm = (p: AgentProfile): Form => ({ label: p.label, description: p.description, harness: p.harness, model: p.model, effort: p.effort, icon: p.icon, color: p.color });
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
  { id: "agents", label: "Agents", hint: "Profiles for new conversations", Icon: FiUsers },
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
  // Subscribe so workspace recompute on catalog navigation changes.
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const conversation = state.conversations.find(c => c.id === state.selected);
  const set = store.profileSet();
  const list = store.profileList().filter(p => p.kind !== "worker");
  const [selectedId, setSelectedId] = useState(() => store.effectiveProfile()?.id ?? store.defaultProfile().id);
  const profile = store.profile(selectedId) ?? list[0]!;
  const [form, setForm] = useState<Form>(() => toForm(profile));
  const [formKey, setFormKey] = useState(`${profile.id}:${profile.updatedAt}`);
  if (formKey !== `${profile.id}:${profile.updatedAt}`) { setFormKey(`${profile.id}:${profile.updatedAt}`); setForm(toForm(profile)); }
  const [chooser, setChooser] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
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
  const ocEfforts = state.modelsCwd === workspace ? state.models.find(m => m.id === form.model)?.efforts ?? [] : [];
  // Warn-not-fail, like the composer: a selection absent from the live per-cwd
  // catalog still sends with the saved value for native resolution.
  const ocMissing = form.harness === "opencode" && !!form.model && state.modelsLoaded && state.modelsCwd === workspace && !state.modelsError && !state.models.some(m => m.id === form.model);
  const saved = state.selected ? store.storedDefaults(state.selected) : null;
  const savedProfile = state.selected ? store.conversationProfile(state.selected) : undefined;
  const customHex = /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : "#635877";

  const create = async (from: AgentProfile) => { setChooser(false); const created = await store.createProfile(from.id, { label: copyLabel(from) }); if (created) setSelectedId(created.id); };
  const save = async () => { if (!dirty || problem) return; await store.saveProfile(profile.id, { ...form, label: form.label.trim(), description: form.description.trim() }); };
  const remove = async () => { if (!window.confirm(`Delete “${profile.label}”? Conversations already using it keep their settings.`)) return; if (await store.deleteProfile(profile.id)) setSelectedId(set.defaultId === profile.id ? store.defaultProfile().id : list.find(p => p.id !== profile.id)?.id ?? set.defaultId); };
  const section = (title: string, items: AgentProfile[]) => !!items.length && <section className="agent-section" aria-label={title}>
    <h3>{title}</h3>
    <div className="agent-grid">{items.map(p => <AgentCard key={p.id} profile={p} selected={p.id === profile.id} tag={p.hidden ? "Hidden" : p.id === set.defaultId ? "Default" : undefined} onSelect={() => setSelectedId(p.id)} />)}
      {title === "Assistants" && <button type="button" className="agent-card agent-new" onClick={() => setChooser(true)}><span className="agent-new-mark" aria-hidden="true"><FiPlus size={16} /></span><span className="agent-card-label">New agent</span><span className="agent-card-description">Start from any existing agent.</span></button>}
    </div>
  </section>;

  return <section className="history-view agent-config-view" aria-label="Agent configuration">
    <header className="history-view-header">
      <h2>Agents</h2>
      <span className="muted" role="status">{list.length} agents · {harnessName(set.profiles.find(p => p.id === set.defaultId)?.harness ?? "claude-code")} default</span>
    </header>
    {saved && <Facts values={[["Conversation agent", savedProfile?.label ?? (saved.agent || "Base")], ["Saved model", saved.model || "Native default"], ["Saved effort / variant", saved.effort || "Native default"]]} />}
    {state.profileError && <p className="notice error" role="alert">{state.profileError} <button type="button" className="text-button" onClick={store.clearProfileError}>Dismiss</button></p>}
    <div className="agent-config">
      <div ref={grid} className="agent-config-grid" onKeyDown={event => moveCardFocus(event, grid.current)}>
        {section("Base", list.filter(p => p.kind === "base"))}
        {section("Assistants", list.filter(p => p.kind === "assistant"))}
      </div>
      <section className="interaction agent-editor" aria-labelledby="agent-editor-title">
        <div className="agent-editor-preview" inert><AgentCard profile={{ ...profile, ...form, label: form.label || profile.label }} /></div>
        <h3 id="agent-editor-title">Edit {profile.label}</h3>
        <fieldset className="interaction-fields" disabled={busy}>
          <div className="interaction-field"><label htmlFor="agent-label">Name</label><input id="agent-label" value={form.label} maxLength={80} onChange={event => patch({ label: event.target.value })} /></div>
          <div className="interaction-field"><label htmlFor="agent-description">Description</label><textarea id="agent-description" rows={2} value={form.description} maxLength={400} onChange={event => patch({ description: event.target.value })} /></div>
          <div className="interaction-field"><span className="agent-field-label">Role</span><span className="agent-readonly">{profile.kind === "base" ? "None (harness defaults, no instructions)" : `Assistant · ${isAssistantAgentId(profile.role) ? ASSISTANT_AGENT_LABELS[profile.role] : "Unknown"} role`}</span></div>
          <div className="interaction-field"><span className="agent-field-label" id="agent-harness">Harness</span><div className="agent-segmented" role="group" aria-labelledby="agent-harness">{(["claude-code", "opencode"] as const).map(h => <button type="button" key={h} aria-pressed={form.harness === h} disabled={fixedHarness} onClick={() => { if (form.harness !== h) patch({ harness: h, model: "", effort: "" }); }}>{harnessName(h)}</button>)}</div><small>{fixedHarness ? "Fixed for built-in Base." : "Conversations keep their harness; changes apply to new conversations."}</small></div>
          {form.harness === "opencode" ? <>
            <div className="interaction-field"><label htmlFor="agent-oc-model">Model</label><select id="agent-oc-model" value={form.model} disabled={state.modelsLoading && !state.models.length} onChange={event => patch({ model: event.target.value, effort: "" })}><option value="">{profile.kind === "base" ? "Native default" : "Agent default model"}</option>{form.model && !state.models.some(m => m.id === form.model) && <option value={form.model}>{form.model} · not in catalog</option>}{state.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><small>{state.modelsLoading ? "Loading the live catalog…" : profile.kind === "base" ? "Live catalog for the current directory. Empty means the native default." : "Empty uses the agent's configured model, then the native default."}</small></div>
            <div className="interaction-field"><label htmlFor="agent-oc-variant">Model variant</label>{!form.model && profile.kind !== "base" ? <><input id="agent-oc-variant" value={form.effort} maxLength={200} placeholder="Agent default variant" onChange={event => patch({ effort: event.target.value })} /><small>Variant ID for the agent's configured model. Its variants are not listed here. Launch requires a resolvable agent model; empty preserves its default variant.</small></> : <select id="agent-oc-variant" value={form.effort} disabled={!form.model || (!ocEfforts.length && !form.effort)} onChange={event => patch({ effort: event.target.value })} title={!form.model ? "Select a model before selecting a variant" : undefined}><option value="">Default variant</option>{form.effort && !ocEfforts.some(e => e.id === form.effort) && <option value={form.effort}>{form.effort}</option>}{ocEfforts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}</div>
          </> : <>
            <div className="interaction-field"><label htmlFor="agent-cc-model">Model</label><input id="agent-cc-model" list="agent-cc-models" value={form.model} onChange={event => patch({ model: event.target.value.trim() })} placeholder="Default model" maxLength={200} /><datalist id="agent-cc-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist><small>Empty means the native default. Custom IDs supported.</small></div>
            <div className="interaction-field"><label htmlFor="agent-cc-effort">Reasoning effort</label><select id="agent-cc-effort" value={form.effort} onChange={event => patch({ effort: event.target.value })}><option value="">Default effort</option>{ccOptions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
          </>}
          <div className="interaction-field"><span className="agent-field-label" id="agent-icon">Icon</span><div className="agent-icon-grid" role="group" aria-labelledby="agent-icon">{AGENT_ICON_IDS.map(id => { const Glyph = AGENT_ICONS[id]; return <button type="button" key={id} aria-pressed={form.icon === id} aria-label={id} title={id} onClick={() => patch({ icon: id })}><Glyph size={15} aria-hidden="true" /></button>; })}</div></div>
          <div className="interaction-field"><span className="agent-field-label" id="agent-color">Color</span><div className="agent-swatches" role="group" aria-labelledby="agent-color">{AGENT_COLOR_IDS.map(id => <button type="button" key={id} className="agent-swatch" aria-pressed={form.color === id} aria-label={id} title={id} style={{ background: agentColor(id) }} onClick={() => patch({ color: id })} />)}<label className="agent-swatch agent-swatch-custom" data-selected={form.color.startsWith("#") || undefined} title="Custom color" style={{ background: form.color.startsWith("#") ? form.color : undefined }}><span className="sr-only">Custom color</span><input type="color" value={customHex} onChange={event => patch({ color: event.target.value as AgentColor })} /></label></div></div>
        </fieldset>
        {state.modelsError && form.harness === "opencode" && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></p>}
        {ocMissing && <p className="notice" role="status">Model {form.model} is not in the current OpenCode catalog for this directory. Sending will still use the selection.</p>}
        {problem && <p className="notice error" role="alert">{problem}</p>}
        <div className="agent-toggles">
          <label className="agent-toggle"><input type="checkbox" checked={isDefault} disabled={isDefault || busy || !!profile.hidden} onChange={event => { if (event.target.checked) void store.setDefaultProfile(profile.id); }} /><span>Default for new conversations</span></label>
          <label className="agent-toggle" title={isDefault ? "The default agent cannot be hidden" : undefined}><input type="checkbox" checked={!!profile.hidden} disabled={isDefault || busy} onChange={event => void store.saveProfile(profile.id, { hidden: event.target.checked })} /><span>Hidden from picker</span></label>
        </div>
        <div className="dialog-actions agent-actions">
          {!profile.builtin && <button type="button" className="agent-danger" disabled={busy || isDefault} title={isDefault ? "Choose another default before deleting" : undefined} onClick={() => void remove()}>Delete</button>}
          {profile.builtin && <button type="button" disabled={busy} onClick={() => void store.resetProfile(profile.id)}>{fixedHarness ? "Reset to defaults" : "Reset to template"}</button>}
          <button type="button" disabled={busy} onClick={() => void create(profile)}>Duplicate</button>
          <button type="button" className="agent-save" disabled={busy || !dirty || !!problem} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </section>
    </div>
    <p className="muted">Profiles apply to new conversations. Existing conversations keep the model and effort they started with; a Base conversation can be assigned one assistant on the same harness.</p>
    {chooser && <ShellDialog title="Start from" close={() => setChooser(false)}><div className="agent-picker"><div className="agent-grid">{list.map(p => <AgentCard key={p.id} profile={p} onSelect={() => void create(p)} />)}</div></div></ShellDialog>}
  </section>;
}
