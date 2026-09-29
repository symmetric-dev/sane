import { useEffect, useState, useSyncExternalStore } from "react";
import { store, type State } from "./store";
import { catalog } from "./catalog";
import { harnessName, harnessShort, type Harness } from "./types";
import { Facts } from "./thread";

// Client-side mirrors of src/history.ts validModel/validEffort/validVariant and
// src/bridge.ts submit validation (model always, effort per harness, variant
// only with a model). Empty means native default and is always valid. Kept as
// local copies so the browser bundle never imports node:path via src/history.
const ccEffortIds = ["low", "medium", "high", "xhigh", "max"];
const validModel = (v: string) => v.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(v);
const validEffort = (v: string) => ccEffortIds.includes(v);
const validVariant = (v: string) => v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);

type Pair = { model: string; effort: string };
const emptyPair = (): Pair => ({ model: "", effort: "" });
const ccError = (pair: Pair) => {
  if (pair.model && !validModel(pair.model)) return "Invalid model ID. Use letters, numbers, and . _ : / [ ] - (up to 200 characters).";
  if (pair.effort && !validEffort(pair.effort)) return "Effort must be low, medium, high, xhigh, or max.";
  return "";
};
const ocError = (pair: Pair) => {
  if (pair.model && !validModel(pair.model)) return "Invalid model ID. Use letters, numbers, and . _ : / [ ] - (up to 200 characters).";
  if (pair.effort && !pair.model) return "Select a model before selecting a variant.";
  if (pair.effort && !validVariant(pair.effort)) return "Invalid native variant ID.";
  return "";
};
const errorFor = (harness: Harness, pair: Pair) => harness === "opencode" ? ocError(pair) : ccError(pair);

export function ConfigView({ state }: { state: State }) {
  // Subscribe so draft/workspace recompute on catalog navigation changes.
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const conversation = state.conversations.find(c => c.id === state.selected);
  const draft = store.draft();
  const key = store.draftKey();
  // The live harness is the conversation's when one is selected, else the
  // new-conversation draft harness. Only its card writes to the shared draft;
  // the other harness keeps a local value applied when it becomes live.
  const live = store.harness();
  const workspace = store.workspace();
  const [cache, setCache] = useState<Record<Harness, Pair>>({ "claude-code": emptyPair(), opencode: emptyPair() });
  const [touched, setTouched] = useState<Record<Harness, boolean>>({ "claude-code": false, opencode: false });
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setCache({ "claude-code": emptyPair(), opencode: emptyPair() });
    setTouched({ "claude-code": false, opencode: false });
  }
  // Seed the live harness from the shared draft (hydrated from stored session
  // defaults) until the user edits it here.
  useEffect(() => {
    if (!touched[live]) setCache(previous => previous[live].model === draft.model && previous[live].effort === draft.effort ? previous : { ...previous, [live]: { model: draft.model, effort: draft.effort } });
  }, [draft.model, draft.effort, live, touched]);
  // Keep the OpenCode catalog fresh per worktree root, like the chat composer.
  useEffect(() => {
    if (state.modelsCwd !== workspace || (!state.modelsLoaded && !state.modelsLoading && !state.modelsError)) {
      const timer = setTimeout(() => void store.loadModels(), 300);
      return () => clearTimeout(timer);
    }
  }, [workspace, state.modelsCwd, state.modelsLoaded, state.modelsLoading, state.modelsError]);

  const setPair = (harness: Harness, patch: Partial<Pair>) => {
    const next = { ...cache[harness], ...patch };
    setCache(previous => ({ ...previous, [harness]: next }));
    setTouched(previous => ({ ...previous, [harness]: true }));
    // Valid edits to the live harness write straight through to the draft the
    // composer sends, so the next submit persists via the session path.
    if (harness === live && !errorFor(harness, next)) store.setDraft({ model: next.model, effort: next.effort });
  };
  const useForNew = (harness: Harness) => {
    if (state.selected || state.sending) return;
    store.setHarness(harness);
    const cached = cache[harness];
    if ((cached.model || cached.effort) && !errorFor(harness, cached)) store.setDraft({ model: cached.model, effort: cached.effort });
  };

  const ccPair = cache["claude-code"], ocPair = cache.opencode;
  const ccProblem = ccError(ccPair), ocProblem = ocError(ocPair);
  const ccActive = live === "claude-code", ocActive = live === "opencode";
  const reported = (state.config?.harnesses?.find(h => h.id === "claude-code")?.capabilities?.effortValues ?? state.config?.capabilities?.effortValues ?? []);
  const ccOptions = (reported.length ? reported : ccEffortIds).map(id => ({ id, name: `${id[0]?.toUpperCase()}${id.slice(1)} effort` }));
  const ocEfforts = state.modelsCwd === workspace ? state.models.find(m => m.id === ocPair.model)?.efforts ?? [] : [];
  // Warn-not-fail, like the composer: a selection absent from the live per-cwd
  // catalog still sends with the saved value for native resolution.
  const ocMissing = !!ocPair.model && state.modelsLoaded && state.modelsCwd === workspace && !state.modelsError && !state.models.some(m => m.id === ocPair.model);
  const saved = state.selected ? store.storedDefaults(state.selected) : null;

  const inactiveNote = (harness: Harness) => conversation
    ? `This conversation runs on ${harnessName(conversation.harness ?? "claude-code")}; its harness cannot change.`
    : `New conversations use ${harnessName(draft.harness)}; switch harness to edit ${harnessName(harness)} defaults.`;

  return <section className="history-view" aria-label="Model configuration">
    <header className="history-view-header">
      <h2>Config</h2>
      {!conversation && <label className="option"><span className="sr-only">Harness for new conversation</span><select value={draft.harness} disabled={state.sending} onChange={event => useForNew(event.target.value as Harness)} aria-label="Harness for new conversation"><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option></select></label>}
      <span className="muted" role="status">2 harnesses · {conversation ? "selected conversation" : "new conversations"}</span>
    </header>
    {saved && <Facts values={[["Saved model", saved.model || "Native default"], ["Saved effort / variant", saved.effort || "Native default"]]} />}

    <section className="interaction" aria-labelledby="config-cc">
      <h3 id="config-cc">Claude Code defaults <span className="harness-badge" title={harnessName("claude-code")}>{harnessShort("claude-code")}</span></h3>
      <fieldset className="interaction-fields" disabled={!ccActive}>
        <div className="interaction-field"><label htmlFor="config-cc-model">Model</label><input id="config-cc-model" list="config-cc-models" value={ccPair.model} onChange={event => setPair("claude-code", { model: event.target.value })} placeholder="Default model" maxLength={200} aria-label="Claude Code default model" /><datalist id="config-cc-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist><small>Empty means the native default. Custom IDs supported.</small></div>
        <div className="interaction-field"><label htmlFor="config-cc-effort">Reasoning effort</label><select id="config-cc-effort" value={ccPair.effort} onChange={event => setPair("claude-code", { effort: event.target.value })} aria-label="Claude Code default reasoning effort"><option value="">Default effort</option>{ccOptions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
      </fieldset>
      {!ccActive && <p className="muted" role="status">{inactiveNote("claude-code")}</p>}
      {ccProblem && <p className="notice error" role="alert">{ccProblem}</p>}
      <div className="dialog-actions">
        {!ccActive && !conversation ? <button type="button" disabled={state.sending} onClick={() => useForNew("claude-code")}>Use Claude Code for new conversations</button>
          : <button type="button" disabled={!ccPair.model && !ccPair.effort} onClick={() => setPair("claude-code", emptyPair())}>Clear defaults</button>}
      </div>
    </section>

    <section className="interaction" aria-labelledby="config-oc">
      <h3 id="config-oc">OpenCode defaults <span className="harness-badge" title={harnessName("opencode")}>{harnessShort("opencode")}</span></h3>
      <fieldset className="interaction-fields" disabled={!ocActive}>
        <div className="interaction-field"><label htmlFor="config-oc-model">Model</label><select id="config-oc-model" value={ocPair.model} disabled={state.modelsLoading || !state.models.length} onChange={event => setPair("opencode", { model: event.target.value, effort: "" })} aria-label="OpenCode default model"><option value="">Native default</option>{state.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><small>Live catalog for the current directory. Empty means the native default.</small></div>
        <div className="interaction-field"><label htmlFor="config-oc-variant">Model variant</label><select id="config-oc-variant" value={ocPair.effort} disabled={!ocPair.model || !ocEfforts.length} onChange={event => setPair("opencode", { effort: event.target.value })} aria-label="OpenCode default model variant" title={!ocPair.model ? "Select a model before selecting a variant" : undefined}><option value="">Default variant</option>{ocEfforts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
      </fieldset>
      {!ocActive && <p className="muted" role="status">{inactiveNote("opencode")}</p>}
      {state.modelsError && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading} onClick={() => void store.loadModels()}>Retry connection</button></p>}
      {ocMissing && <p className="notice" role="status">Model {ocPair.model} is not in the current OpenCode catalog for this directory. Sending will still use the selection.</p>}
      {ocProblem && <p className="notice error" role="alert">{ocProblem}</p>}
      <div className="dialog-actions">
        {!ocActive && !conversation ? <button type="button" disabled={state.sending} onClick={() => useForNew("opencode")}>Use OpenCode for new conversations</button>
          : <button type="button" disabled={!ocPair.model && !ocPair.effort} onClick={() => setPair("opencode", emptyPair())}>Clear defaults</button>}
      </div>
    </section>

    <p className="muted">Defaults apply to new conversations; follow-ups keep the stored session model; empty = native default.</p>
  </section>;
}
