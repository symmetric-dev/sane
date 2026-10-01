import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FiCheck, FiChevronDown, FiChevronRight, FiArrowLeft } from "react-icons/fi";
import type { ModelChoice } from "./types";
import "./model-picker.css";

// Split only the provider prefix: model IDs can themselves contain slashes.
export function groupModels(models: ModelChoice[]) {
  const groups = new Map<string, ModelChoice[]>();
  for (const model of models) {
    const slash = model.id.indexOf("/");
    if (slash < 1 || slash === model.id.length - 1) continue;
    const provider = model.id.slice(0, slash);
    const list = groups.get(provider) ?? [];
    list.push(model); groups.set(provider, list);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, models]) => ({ id, models }));
}

function navigateList(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
  if (next < 0 || !buttons.length) return;
  event.preventDefault(); buttons[next]?.focus();
}

export function ModelPicker({ id, models, value, defaultLabel, disabled = false, loading = false, onChange }: {
  id: string; models: ModelChoice[]; value: string; defaultLabel: string; disabled?: boolean; loading?: boolean; onChange: (id: string) => void;
}) {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const providerSearch = useRef<HTMLInputElement>(null), modelSearch = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [provider, setProvider] = useState("");
  const [providerQuery, setProviderQuery] = useState(""), [modelQuery, setModelQuery] = useState("");
  const groups = useMemo(() => groupModels(models), [models]);
  const providers = groups.filter(group => group.id.toLowerCase().includes(providerQuery.trim().toLowerCase()));
  const selectedGroup = groups.find(group => group.id === provider);
  const visibleModels = (selectedGroup?.models ?? []).filter(model => `${model.name} ${model.id}`.toLowerCase().includes(modelQuery.trim().toLowerCase()));
  const selected = models.find(model => model.id === value);
  const dismiss = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = () => { setProvider(""); setProviderQuery(""); setModelQuery(""); setOpen(true); };
  const choose = (next: string) => { onChange(next); dismiss(); };
  const back = () => { setProvider(""); setModelQuery(""); providerSearch.current?.focus(); };
  const browse = (next: string) => { setProvider(next); setModelQuery(""); };

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { setOpen(false); return; }
    const element = panel.current!;
    // A native top-layer popover escapes the agent editor's scrolling/clipping.
    element.showPopover();
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const upwards = below < 320 && above > below;
      const height = Math.max(0, Math.min(360, upwards ? above : below));
      element.style.width = `${width}px`; element.style.height = `${height}px`;
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      element.style.top = `${upwards ? rect.top - height - 6 : rect.bottom + 6}px`;
    };
    position(); providerSearch.current?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      // Pointer activation doesn't focus buttons in every browser. Native modal
      // focus can fall back to an ancestor instead; that isn't an outside click.
      // Keep dismissing actual outside pointer presses and focus on other fields.
      if (event.type === "focusin" && target.contains(element)) return;
      if (!element.contains(target) && !trigger.current?.contains(target)) dismiss(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); dismiss();
    };
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) position(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      element.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, disabled]);
  useLayoutEffect(() => { if (open && provider) modelSearch.current?.focus(); }, [provider, open]);

  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".model-picker-list button")?.focus();
    }
  };
  return <>
    <button ref={trigger} id={id} type="button" className="model-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={() => {
      if (open) { dismiss(); return; }
      show();
    }} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); } }}>
      <span><span>{selected?.name || value || defaultLabel}</span>{value && <small>{selected ? value : `${value} · not in catalog`}</small>}</span><FiChevronDown aria-hidden="true" />
    </button>
    <div ref={panel} id={panelId} popover="manual" role="dialog" aria-label="Choose OpenCode model" className="model-picker-popover" data-step={provider ? "models" : "providers"}>
      {open && <>
        <div className="model-picker-defaults"><button type="button" aria-pressed={!value} onClick={() => choose("")}>{defaultLabel}{!value && <FiCheck aria-hidden="true" />}</button></div>
        <div className="model-picker-columns">
          <section className="model-picker-providers" aria-label="Providers">
            <label htmlFor={`${panelId}-providers`}>Provider</label>
            <input ref={providerSearch} id={`${panelId}-providers`} type="search" aria-label="Search providers" placeholder="Search providers…" value={providerQuery} onChange={event => setProviderQuery(event.target.value)} onKeyDown={searchKey} />
            <div className="model-picker-list" onKeyDown={event => {
              if (event.key === "ArrowRight") { const next = (document.activeElement as HTMLElement).dataset.provider; if (next) { event.preventDefault(); browse(next); modelSearch.current?.focus(); } }
              else navigateList(event);
            }}>{providers.map(group => <button key={group.id} type="button" data-provider={group.id} aria-pressed={provider === group.id} onClick={() => browse(group.id)}><span>{group.id}</span><small>{group.models.length}</small><FiChevronRight aria-hidden="true" /></button>)}</div>
            {!providers.length && <p role="status">{loading ? "Loading providers…" : groups.length ? "No matching providers." : "No available providers."}</p>}
          </section>
          <section className="model-picker-models" aria-label="Models" onKeyDown={event => { if (event.key === "ArrowLeft" && event.target instanceof HTMLButtonElement) { event.preventDefault(); back(); } }}>
            {provider ? <>
              <button type="button" className="model-picker-back" onClick={back}><FiArrowLeft aria-hidden="true" />Providers</button>
              <label htmlFor={`${panelId}-models`}>{provider}</label>
              <input ref={modelSearch} id={`${panelId}-models`} type="search" aria-label="Search models" placeholder="Search models…" value={modelQuery} onChange={event => setModelQuery(event.target.value)} onKeyDown={searchKey} />
              <div className="model-picker-list" onKeyDown={navigateList}>{visibleModels.map(model => <button type="button" key={model.id} aria-pressed={value === model.id} onClick={() => choose(model.id)}><span><span>{model.name}</span><small>{model.id.slice(model.id.indexOf("/") + 1)}</small></span>{value === model.id && <FiCheck aria-hidden="true" />}</button>)}</div>
              {!visibleModels.length && <p role="status">No matching models.</p>}
            </> : <p className="model-picker-hint">Choose a provider to browse its models.</p>}
          </section>
        </div>
      </>}
    </div>
  </>;
}
