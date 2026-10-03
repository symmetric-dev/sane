import { useState } from "react";
import { FiArrowUpRight } from "react-icons/fi";
import { store, type State } from "./store";
import type { FormField, Interaction } from "./types";

type Answer = Record<string, string | number | boolean | string[]>;
const applicable = (field: FormField, answer: Answer) => field.type === "external" || !field.when || field.when.every(c => c.op === "eq" ? answer[c.key] === c.value : answer[c.key] !== c.value);
const visible = (field: FormField, answer: Answer) => field.type === "external" || (!field.hidden && applicable(field, answer));
const safeURL = (url: string) => { try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
function Question({ interaction, disabled }: { interaction: Interaction; disabled: boolean }) {
  const fields = interaction.fields ?? [];
  const [answer, setAnswer] = useState<Answer>(() => Object.fromEntries(fields.flatMap(f => f.type !== "external" && f.default !== undefined ? [[f.key, f.default]] : f.type === "boolean" ? [[f.key, false]] : [])));
  const [error, setError] = useState("");
  const set = (key: string, value: Answer[string]) => setAnswer(previous => ({ ...previous, [key]: value }));
  return <form onSubmit={event => {
    event.preventDefault(); setError("");
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
        if (field.type === "string" && field.format === "date-time" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) { setError(`Enter an ISO date and time with timezone for ${field.title || field.key}.`); return; }
        result[field.key] = value;
      }
    }
    void store.reply(interaction.id, { type: "question", answer: result });
  }}>
    <fieldset disabled={disabled} className="interaction-fields">
      {fields.filter(field => visible(field, answer)).map(field => {
        const id = `interaction-${interaction.id}-${field.key}`;
        if (field.type === "external") { const href = safeURL(field.url); return <p key={field.key}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{field.title || "Open external step"} <FiArrowUpRight size={12} aria-hidden="true" /></a> : "External URL unavailable"}{field.description && <small>{field.description}</small>}</p>; }
        const label = <label htmlFor={id}>{field.title || field.key}{field.required ? " *" : ""}</label>;
        const hint = field.description ? `${id}-hint` : undefined;
        const value = answer[field.key];
        return <div className="interaction-field" key={field.key}>{label}{field.description && <small id={hint}>{field.description}</small>}
          {field.type === "boolean" ? <select id={id} aria-describedby={hint} value={String(value ?? false)} onChange={e => set(field.key, e.target.value === "true")}><option value="false">No</option><option value="true">Yes</option></select>
            : field.type === "multiselect" ? <><select id={id} multiple aria-describedby={hint} value={Array.isArray(value) ? value : []} onChange={e => set(field.key, Array.from(e.target.selectedOptions, o => o.value))}>{[...field.options, ...(Array.isArray(value) ? value.filter(v => !field.options.some(o => o.value === v)).map(v => ({ value: v, label: v })) : [])].map(option => <option key={option.value} value={option.value}>{option.label}{"description" in option && option.description ? ` — ${option.description}` : ""}</option>)}</select>{field.custom && <label>Additional choices (one per line)<textarea value={(Array.isArray(value) ? value.filter(v => !field.options.some(o => o.value === v)) : []).join("\n")} onChange={e => set(field.key, [...(Array.isArray(value) ? value.filter(v => field.options.some(o => o.value === v)) : []), ...e.target.value.split("\n")])} /></label>}</>
            : field.type === "string" ? field.options && !field.custom ? <select id={id} aria-describedby={hint} required={field.required} value={typeof value === "string" ? value : ""} onChange={e => set(field.key, e.target.value)}><option value="">Choose an option</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}</select> : <><input id={id} aria-describedby={hint} type={field.format === "uri" ? "url" : field.format === "date-time" ? "text" : field.format || "text"} required={field.required} minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern} placeholder={field.placeholder || (field.format === "date-time" ? "ISO date and time, including timezone" : undefined)} value={typeof value === "string" ? value : ""} onChange={e => set(field.key, e.target.value)} list={field.options ? `${id}-choices` : undefined} />{field.options && <datalist id={`${id}-choices`}>{field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>}</>
            : <input id={id} aria-describedby={hint} type="number" required={field.required} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} value={typeof value === "number" || typeof value === "string" ? value : ""} onChange={e => set(field.key, e.target.value === "" ? "" : Number(e.target.value))} />}
        </div>;
      })}
      {error && <p className="run-warning" role="alert">{error}</p>}
      <button type="submit" className="primary-button">Send answers</button>
    </fieldset>
  </form>;
}
function Permission({ interaction, disabled }: { interaction: Interaction; disabled: boolean }) {
  const [message, setMessage] = useState("");
  return <><label className="interaction-field">Optional reply message<input value={message} disabled={disabled} onChange={e => setMessage(e.target.value)} /></label><div className="permission-actions">{(interaction.options ?? []).filter(o => ["once", "always", "reject"].includes(o.id)).map(option => <button type="button" key={option.id} disabled={disabled} onClick={() => void store.reply(interaction.id, { type: "permission", decision: option.id as "once" | "always" | "reject", ...(message ? { message } : {}) })}>{option.name}</button>)}</div></>;
}
export function Interactions({ state }: { state: State }) {
  const capabilities = store.capabilities();
  return <>{state.interactions.filter(i => capabilities.listInteractions && (i.type === "permission" ? capabilities.permissionReplies : i.type === "question" ? capabilities.questionReplies : false)).map(interaction => <section className="interaction" key={interaction.id} aria-labelledby={`request-${interaction.id}`}><p className="eyebrow">{interaction.type === "permission" ? "PERMISSION REQUEST" : "INPUT REQUEST"}</p><h3 id={`request-${interaction.id}`}>{interaction.title}</h3>{interaction.description && <p className="interaction-description">{interaction.description}</p>}{interaction.type === "permission" ? <Permission interaction={interaction} disabled={state.actionBusy || !state.connected} /> : <Question interaction={interaction} disabled={state.actionBusy || !state.connected} />}</section>)}{state.interactionError && <p className="notice error" role="alert">{state.interactionError}</p>}{state.actionNotice && <p className="notice" role="status">{state.actionNotice}</p>}</>;
}
