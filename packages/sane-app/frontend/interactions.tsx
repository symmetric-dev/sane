import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowUpRight, FiCheck, FiHelpCircle, FiShield } from "react-icons/fi";
import { FilterDropdown } from "./filter-dropdown";
import { pendingInteractions } from "./interaction-presentation";
import { store, type State } from "./store";
import type { FormField, Interaction, InteractionReply } from "./types";
import type { FormOption } from "../shared/conversation/native-contract";
import "./interactions.css";

type Answer = Record<string, string | number | boolean | string[]>;
const applicable = (field: FormField, answer: Answer) => field.type === "external" || !field.when || field.when.every(c => c.op === "eq" ? answer[c.key] === c.value : answer[c.key] !== c.value);
const visible = (field: FormField, answer: Answer) => field.type === "external" || (!field.hidden && applicable(field, answer));
const safeURL = (url: string) => { try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
// DOM events from a suspended or replaced conversation must never answer a new one.
function reply(sessionId: string, interaction: Interaction, answer: InteractionReply) {
  const state = store.snapshot();
  if (state.selected !== sessionId || !state.connected || state.actionBusy || !pendingInteractions(state, store.capabilities()).some(item => item.id === interaction.id && item.type === interaction.type)) return;
  void store.reply(interaction.id, answer);
}

function Choices({ options, values, multiple = false, disabled, label, choose }: { options: FormOption[]; values: string[]; multiple?: boolean; disabled: boolean; label: string; choose: (value: string) => void }) {
  return <div className="interaction-choices" role="group" aria-label={label}>
    {options.map(option => <button type="button" key={option.value} className="interaction-choice" disabled={disabled} aria-pressed={values.includes(option.value)} onClick={() => choose(option.value)}>
      <span className={`interaction-choice-mark${multiple ? " is-multiple" : ""}`} aria-hidden="true">{values.includes(option.value) && <FiCheck size={12} />}</span>
      <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
    </button>)}
  </div>;
}

function QuestionField({ field, value, set, disabled, id }: { field: Exclude<FormField, { type: "external" }>; value: Answer[string] | undefined; set: (value: Answer[string]) => void; disabled: boolean; id: string }) {
  const title = `${field.title || field.key}${field.required ? " *" : ""}`;
  const hint = field.description ? `${id}-hint` : undefined;
  const values = Array.isArray(value) ? value : [];
  return <div className="interaction-field" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint}>
    <span id={`${id}-label`} className="interaction-field-label">{title}</span>
    {field.description && <small id={hint}>{field.description}</small>}
    {field.type === "boolean" ? <Choices label={title} options={[{ value: "false", label: "No" }, { value: "true", label: "Yes" }]} values={[String(value ?? false)]} disabled={disabled} choose={next => set(next === "true")} />
      : field.type === "multiselect" ? <>
        <Choices label={`${title} (choose multiple)`} options={field.options} values={values} multiple disabled={disabled} choose={next => set(values.includes(next) ? values.filter(item => item !== next) : [...values, next])} />
        {field.custom && <label htmlFor={id}>Add your own answers (one per line)<textarea id={id} rows={2} aria-describedby={hint} placeholder="Write additional answers…" value={values.filter(v => !field.options.some(o => o.value === v)).join("\n")} onChange={e => set([...values.filter(v => field.options.some(o => o.value === v)), ...e.target.value.split("\n")])} /></label>}
      </> : field.type === "string" ? <>
        {field.options && <Choices label={title} options={field.options} values={typeof value === "string" ? [value] : []} disabled={disabled} choose={next => set(value === next ? "" : next)} />}
        {(!field.options || field.custom) && <>
          {field.options && <label htmlFor={id}>Choose above or write your own answer</label>}
          {field.format ? <input id={id} aria-label={title} aria-describedby={hint} type={field.format === "uri" ? "url" : field.format === "email" ? "email" : "text"} required={field.required} minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern} placeholder={field.placeholder || (field.format === "date-time" ? "ISO date and time, including timezone" : field.format === "date" ? "YYYY-MM-DD" : undefined)} value={typeof value === "string" ? value : ""} onChange={e => set(e.target.value)} />
            : <textarea id={id} rows={2} aria-label={title} aria-describedby={hint} required={field.required} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder || "Write your answer…"} value={typeof value === "string" ? value : ""} onChange={e => set(e.target.value)} />}
        </>}
      </> : <input id={id} aria-label={title} aria-describedby={hint} type="number" required={field.required} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} value={typeof value === "number" || typeof value === "string" ? value : ""} onChange={e => set(e.target.value === "" ? "" : Number(e.target.value))} />}
  </div>;
}

function Question({ interaction, sessionId, disabled, navigation, error: replyError, busy }: { interaction: Interaction; sessionId: string; disabled: boolean; navigation?: ReactNode; error: string; busy: boolean }) {
  const fields = interaction.fields ?? [];
  const [answer, setAnswer] = useState<Answer>(() => Object.fromEntries(fields.flatMap(f => f.type !== "external" && f.default !== undefined ? [[f.key, f.default]] : f.type === "boolean" ? [[f.key, false]] : [])));
  const [error, setError] = useState("");
  const set = (key: string, value: Answer[string]) => setAnswer(previous => ({ ...previous, [key]: value }));
  const submit = () => {
    if (disabled) return;
    setError("");
    const result: Answer = {};
    for (const field of fields) {
      if (field.type === "external" || !applicable(field, answer)) continue;
      const value = answer[field.key];
      if (field.required && (value === undefined || value === "" || (Array.isArray(value) && !value.length))) { setError(`Complete ${field.title || field.key}.`); return; }
      if (value === undefined || value === "") {
        if (field.type === "multiselect" && field.minItems && field.minItems > 0) { setError(`Choose at least ${field.minItems} options for ${field.title || field.key}.`); return; }
        continue;
      }
      if (field.type === "number" || field.type === "integer") {
        const n = Number(value);
        if (!Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n)) || (field.minimum !== undefined && n < Number(field.minimum)) || (field.maximum !== undefined && n > Number(field.maximum))) { setError(`Enter a valid ${field.type} for ${field.title || field.key}.`); return; }
        result[field.key] = n;
      } else if (field.type === "multiselect") {
        const values = [...new Set(Array.isArray(value) ? value.filter(v => v.trim()) : [])];
        if ((field.required && !values.length) || (field.minItems !== undefined && values.length < field.minItems) || (field.maxItems !== undefined && values.length > field.maxItems)) { setError(`Choose ${field.minItems ?? (field.required ? 1 : 0)}–${field.maxItems ?? "any number of"} options for ${field.title || field.key}.`); return; }
        result[field.key] = values;
      } else {
        if (field.type === "string") {
          if (typeof value !== "string" || (field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength)) { setError(`Enter a valid answer for ${field.title || field.key}.`); return; }
          if (field.pattern) {
            try { if (!new RegExp(`^(?:${field.pattern})$`, "u").test(value)) { setError(`Enter a valid answer for ${field.title || field.key}.`); return; } }
            catch { setError(`The validation rule for ${field.title || field.key} is unavailable.`); return; }
          }
        }
        if (field.type === "string" && field.format === "date-time" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) { setError(`Enter an ISO date and time with timezone for ${field.title || field.key}.`); return; }
        if (field.type === "string" && field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value as string) || !Number.isFinite(Date.parse(value as string)) || new Date(value as string).toISOString().slice(0, 10) !== value)) { setError(`Enter a valid date (YYYY-MM-DD) for ${field.title || field.key}.`); return; }
        result[field.key] = value;
      }
    }
    reply(sessionId, interaction, { type: "question", answer: result });
  };
  return <form className="interaction-answer-form" onSubmit={event => { event.preventDefault(); submit(); }} onKeyDown={event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.requestSubmit(); }
  }}>
    <div className="interaction-composer-body"><fieldset disabled={disabled} className="interaction-fields">
      {fields.filter(field => visible(field, answer)).map(field => {
        const id = `interaction-${interaction.id}-${field.key}`;
        if (field.type === "external") { const href = safeURL(field.url); return <p key={field.key}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{field.title || "Open external step"} <FiArrowUpRight size={12} aria-hidden="true" /></a> : "External URL unavailable"}{field.description && <small>{field.description}</small>}</p>; }
        return <QuestionField key={field.key} field={field} id={id} value={answer[field.key]} set={value => set(field.key, value)} disabled={disabled} />;
      })}
      {error && <p className="run-warning" role="alert">{error}</p>}
      {replyError && <p className="run-warning" role="alert">{replyError}</p>}
    </fieldset></div>
    <footer className="interaction-composer-toolbar"><span>{fields.some(field => field.type !== "external" && field.required) ? "* Required" : "Answer the assistant’s request"}</span><div><button type="submit" className="interaction-primary" disabled={disabled}>{busy ? "Sending answers…" : "Send answers"}</button>{navigation}</div></footer>
  </form>;
}
function Permission({ interaction, sessionId, disabled, navigation, error, busy }: { interaction: Interaction; sessionId: string; disabled: boolean; navigation?: ReactNode; error: string; busy: boolean }) {
  const [message, setMessage] = useState("");
  return <><div className="interaction-composer-body"><label className="interaction-field">Optional reply message<textarea rows={2} placeholder="Add context for the assistant…" value={message} disabled={disabled} onChange={e => setMessage(e.target.value)} /></label>{error && <p className="run-warning" role="alert">{error}</p>}</div><footer className="interaction-composer-toolbar"><span>{busy ? "Sending decision…" : "Choose whether to allow this action"}</span><div>{(interaction.options ?? []).filter(o => ["once", "always", "reject"].includes(o.id)).map(option => <button type="button" className={option.id === "once" ? "interaction-primary" : option.id === "reject" ? "interaction-reject" : undefined} key={option.id} disabled={disabled} onClick={() => { if (!disabled) reply(sessionId, interaction, { type: "permission", decision: option.id as "once" | "always" | "reject", ...(message ? { message } : {}) }); }}>{option.name}</button>)}{navigation}</div></footer></>;
}
export function Interactions({ state, active = true, navigation, showNotice = true }: { state: State; active?: boolean; navigation?: ReactNode; showNotice?: boolean }) {
  const requests = pendingInteractions(state, store.capabilities());
  const [selection, setSelection] = useState<string>();
  const interaction = requests.find(item => item.id === selection) ?? requests[0];
  const root = useRef<HTMLElement>(null);
  const disabled = !active || state.actionBusy || !state.connected;
  useEffect(() => {
    if (!active) return;
    root.current?.querySelector<HTMLElement>('.interaction-request:not([hidden]) textarea:not(:disabled), .interaction-request:not([hidden]) input:not(:disabled), .interaction-request:not([hidden]) button:not(:disabled)')?.focus({ preventScroll: true });
  }, [active, interaction?.id]);
  if (!interaction) return null;
  const RequestIcon = interaction.type === "permission" ? FiShield : FiHelpCircle;
  return <section ref={root} className="interaction interaction-composer" aria-labelledby={`request-${interaction.id}`}>
    <header className="interaction-composer-heading"><div><RequestIcon size={16} aria-hidden="true" /><strong>{interaction.type === "permission" ? "Permission request" : "Answer the assistant"}</strong></div><h3 id={`request-${interaction.id}`}>{interaction.title}</h3>
      {requests.length > 1 && <FilterDropdown label={`${requests.length} pending requests`} value={interaction.id} options={requests.map(item => ({ value: item.id, label: `${item.type === "permission" ? "Permission" : "Question"} · ${item.title}` }))} disabled={disabled} onChange={setSelection} />}
    </header>
    {requests.map(item => <div key={item.id} className="interaction-request" hidden={item.id !== interaction.id} style={item.id !== interaction.id ? { display: "none" } : undefined}>
      {item.description && <p className="interaction-description">{item.description}</p>}
      {item.type === "permission" ? <Permission interaction={item} sessionId={state.selected} disabled={disabled || item.id !== interaction.id} navigation={navigation} error={state.interactionError} busy={state.actionBusy} /> : <Question interaction={item} sessionId={state.selected} disabled={disabled || item.id !== interaction.id} navigation={navigation} error={state.interactionError} busy={state.actionBusy} />}
    </div>)}
    {showNotice && state.actionNotice && <p className="notice" role="status">{state.actionNotice}</p>}
  </section>;
}
