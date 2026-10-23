import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowUpRight, FiCheck, FiHelpCircle, FiShield, FiX } from "react-icons/fi";
import { FilterDropdown } from "./filter-dropdown";
import { ComposerRequest, RequestActions, RequestBody, RequestButton, RequestChoices as Choices, RequestDisclosure, RequestInput, RequestTextarea } from "./composer-request";
import { pendingInteractions } from "./interaction-presentation";
import { store, type State } from "./store";
import type { FormField, HandoffApprovalReply, Interaction, InteractionReply } from "./types";
import "./interactions.css";

type Answer = Record<string, string | number | boolean | string[]>;
type RequestProps = { interaction: Interaction; sessionId: string; disabled: boolean; navigation?: ReactNode; error: string; busy: boolean };
type PermissionDecision = Extract<InteractionReply, { type: "permission" }>["decision"];
const permissionOrder: Record<PermissionDecision, number> = { reject: 0, always: 1, once: 2 };
const isPermissionOption = (option: { id: string; name: string }): option is { id: PermissionDecision; name: string } => option.id === "once" || option.id === "always" || option.id === "reject";
const applicable = (field: FormField, answer: Answer) => field.type === "external" || !field.when || field.when.every(c => c.op === "eq" ? answer[c.key] === c.value : answer[c.key] !== c.value);
const visible = (field: FormField, answer: Answer) => field.type === "external" || (!field.hidden && applicable(field, answer));
const safeURL = (url: string) => { try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
// DOM events from a suspended or replaced conversation must never answer a new one.
function reply(sessionId: string, interaction: Interaction, answer: InteractionReply) {
  const state = store.snapshot();
  if (state.selected !== sessionId || !state.connected || state.actionBusy || !pendingInteractions(state, store.capabilities()).some(item => item.id === interaction.id && item.type === interaction.type)) return;
  if (answer.type === "handoff-approval") {
    const { type: _ignored, ...handoff } = answer;
    void store.replyHandoff(interaction.id, handoff);
    return;
  }
  void store.reply(interaction.id, answer);
}
// Sender-session handoff decision. Attached to the sender sessionId that
// called sane_handoff, never the recipient.
function replyHandoff(sessionId: string, interaction: Interaction, answer: HandoffApprovalReply) {
  const state = store.snapshot();
  if (state.selected !== sessionId || !state.connected || state.actionBusy || !pendingInteractions(state, store.capabilities()).some(item => item.id === interaction.id && item.type === "handoff-approval")) return;
  void store.replyHandoff(interaction.id, answer);
}

function QuestionField({ field, value, set, disabled, id }: { field: Exclude<FormField, { type: "external" }>; value: Answer[string] | undefined; set: (value: Answer[string]) => void; disabled: boolean; id: string }) {
  const title = `${field.title || field.key}${field.required ? " *" : ""}`;
  const hint = field.description ? `${id}-hint` : undefined;
  const values = Array.isArray(value) ? value : [];
  return <div className="request-field" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint}>
    {field.type === "number" || field.type === "integer" || (field.type === "string" && !field.options)
      ? <label id={`${id}-label`} htmlFor={id} className="request-field-label">{title}</label>
      : <span id={`${id}-label`} className="request-field-label">{title}</span>}
    {field.description && <small className="request-field-hint" id={hint}>{field.description}</small>}
    {field.type === "boolean" ? <Choices label={title} options={[{ value: "false", label: "No" }, { value: "true", label: "Yes" }]} values={[String(value ?? false)]} disabled={disabled} choose={next => set(next === "true")} />
      : field.type === "multiselect" ? <>
        <Choices label={`${title} (choose multiple)`} options={field.options} values={values} multiple disabled={disabled} choose={next => set(values.includes(next) ? values.filter(item => item !== next) : [...values, next])} />
        {field.custom && <label className="request-field" htmlFor={id}><span className="request-field-hint">Additional answers · one per line</span><RequestTextarea id={id} rows={2} disabled={disabled} aria-describedby={hint} placeholder="Write additional answers…" value={values.filter(v => !field.options.some(o => o.value === v)).join("\n")} onChange={e => set([...values.filter(v => field.options.some(o => o.value === v)), ...e.target.value.split("\n")])} /></label>}
      </> : field.type === "string" ? <>
        {field.options && <Choices label={title} options={field.options} values={typeof value === "string" ? [value] : []} disabled={disabled} choose={next => set(value === next ? "" : next)} />}
        {(!field.options || field.custom) && <>
          {field.options && <label className="request-field-hint" htmlFor={id}>Or write your own answer</label>}
          {field.format ? <RequestInput id={id} disabled={disabled} aria-label={title} aria-describedby={hint} type={field.format === "uri" ? "url" : field.format === "email" ? "email" : "text"} required={field.required} minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern} placeholder={field.placeholder || (field.format === "date-time" ? "ISO date and time, including timezone" : field.format === "date" ? "YYYY-MM-DD" : undefined)} value={typeof value === "string" ? value : ""} onChange={e => set(e.target.value)} />
            : <RequestTextarea id={id} disabled={disabled} rows={2} aria-label={title} aria-describedby={hint} required={field.required} minLength={field.minLength} maxLength={field.maxLength} placeholder={field.placeholder || "Write your answer…"} value={typeof value === "string" ? value : ""} onChange={e => set(e.target.value)} />}
        </>}
      </> : <RequestInput id={id} disabled={disabled} aria-label={title} aria-describedby={hint} type="number" required={field.required} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} value={typeof value === "number" || typeof value === "string" ? value : ""} onChange={e => set(e.target.value === "" ? "" : Number(e.target.value))} />}
  </div>;
}

function Question({ interaction, sessionId, disabled, navigation, error: replyError, busy }: RequestProps) {
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
    <RequestBody><fieldset disabled={disabled} className="interaction-fields" aria-label={interaction.title}>
      {interaction.description && <p className="interaction-description">{interaction.description}</p>}
      {fields.filter(field => visible(field, answer)).map(field => {
        const id = `interaction-${interaction.id}-${field.key}`;
        if (field.type === "external") {
          const href = safeURL(field.url);
          return <div key={field.key} className="request-field interaction-external-step">
            {href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-describedby={field.description ? `${id}-hint` : undefined}>{field.title || "Open external step"} <FiArrowUpRight size={12} aria-hidden="true" /></a> : <span>External URL unavailable</span>}
            {field.description && <small id={`${id}-hint`} className="request-field-hint">{field.description}</small>}
          </div>;
        }
        return <QuestionField key={field.key} field={field} id={id} value={answer[field.key]} set={value => set(field.key, value)} disabled={disabled} />;
      })}
       {error && <p className="request-message request-error" role="alert">{error}</p>}
       {replyError && <p className="request-message request-error" role="alert">{replyError}</p>}
    </fieldset></RequestBody>
     <RequestActions hint={fields.some(field => field.type !== "external" && field.required) ? "* Required" : "Review your answers before sending"}>{navigation}<RequestButton type="submit" variant="primary" disabled={disabled}><FiCheck aria-hidden="true" />{busy ? "Sending answers…" : "Send answers"}</RequestButton></RequestActions>
  </form>;
}
function Permission({ interaction, sessionId, disabled, navigation, error, busy }: RequestProps) {
  const [message, setMessage] = useState("");
  // Reorder presentation only: native decision IDs and names remain untouched.
  const options = (interaction.options ?? []).filter(isPermissionOption).sort((a, b) => permissionOrder[a.id] - permissionOrder[b.id]);
  const send = (decision: PermissionDecision) => {
    if (disabled) return;
    reply(sessionId, interaction, { type: "permission", decision, ...(message ? { message } : {}) });
  };
  return <>
    <RequestBody>
      {interaction.description && <p className="interaction-description">{interaction.description}</p>}
      <label className="request-field">
        <span className="request-field-label">Reply message <span className="request-field-hint">· optional</span></span>
        <RequestTextarea rows={2} placeholder="Add context for the assistant…" value={message} disabled={disabled} onChange={e => setMessage(e.target.value)} />
      </label>
      {error && <p className="request-message request-error" role="alert">{error}</p>}
    </RequestBody>
    <RequestActions hint={busy ? "Sending decision…" : "Your approval is needed to continue"}>
      {navigation}
      {options.map(option => <RequestButton key={option.id} variant={option.id === "once" ? "primary" : option.id === "reject" ? "danger" : "secondary"} disabled={disabled} onClick={() => send(option.id)}>
        {option.id === "once" ? <FiCheck aria-hidden="true" /> : option.id === "reject" ? <FiX aria-hidden="true" /> : null}
        {option.name}
      </RequestButton>)}
    </RequestActions>
  </>;
}
/** Sender-session approval; preserve the existing reply payload for either decision. */
function HandoffApproval({ interaction, sessionId, disabled, navigation, error, busy }: RequestProps) {
  const [message, setMessage] = useState("");
  const revision = interaction.type === "handoff-approval" ? interaction.revision : 0;
  const send = (decision: "allow" | "deny") => {
    if (disabled) return;
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    replyHandoff(sessionId, interaction, { decision, ...(message.trim() ? { message: message.trim().slice(0, 8000) } : {}), expectedRevision: revision });
  };
  return <><RequestBody>
    {interaction.description && <p className="interaction-description">{interaction.description}</p>}
    {interaction.type === "handoff-approval" && <RequestDisclosure label="Handoff details">
      <dl className="interaction-details">
        <div><dt>Handoff</dt><dd>{interaction.handoffId || "unavailable"}</dd></div>
        <div><dt>Request</dt><dd>{interaction.requestId || "unavailable"}</dd></div>
      </dl>
    </RequestDisclosure>}
    <label className="request-field"><span className="request-field-label">Reason or instructions <span className="request-field-hint">· optional</span></span><RequestTextarea rows={2} maxLength={8000} placeholder="Add context, or explain what should change…" value={message} disabled={disabled} onChange={e => setMessage(e.target.value)} /></label>
    {error && <p className="request-message request-error" role="alert">{error}</p>}
   </RequestBody><RequestActions hint={busy ? "Sending decision…" : "Approve the handoff or send it back with instructions"}>
     {navigation}
     <RequestButton variant="danger" disabled={disabled} onClick={() => send("deny")}><FiX aria-hidden="true" />Deny</RequestButton>
     <RequestButton variant="primary" disabled={disabled} onClick={() => send("allow")}><FiCheck aria-hidden="true" />Allow handoff</RequestButton>
   </RequestActions></>;
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
  const RequestIcon = interaction.type === "permission" ? FiShield : interaction.type === "handoff-approval" ? FiArrowUpRight : FiHelpCircle;
  return <ComposerRequest sectionRef={root} id={`request-${interaction.id}`} className="interaction-composer" icon={<RequestIcon size={16} />} label={interaction.type === "permission" ? "Permission request" : interaction.type === "handoff-approval" ? "Handoff approval" : "Assistant question"} title={interaction.title} status={state.actionBusy ? "Sending…" : "Needs your response"}
    tools={requests.length > 1 ? <FilterDropdown label="Pending requests" value={interaction.id} options={requests.map(item => ({ value: item.id, label: `${item.type === "permission" ? "Permission" : item.type === "handoff-approval" ? "Handoff" : "Question"} · ${item.title}` }))} disabled={disabled} onChange={setSelection} /> : undefined}>
    {requests.map(item => <div key={item.id} className="interaction-request" hidden={item.id !== interaction.id} style={item.id !== interaction.id ? { display: "none" } : undefined}>
      {item.type === "permission" ? <Permission interaction={item} sessionId={state.selected} disabled={disabled || item.id !== interaction.id} navigation={navigation} error={state.interactionError} busy={state.actionBusy} /> : item.type === "handoff-approval" ? <HandoffApproval interaction={item} sessionId={state.selected} disabled={disabled || item.id !== interaction.id} navigation={navigation} error={state.interactionError} busy={state.actionBusy} /> : <Question interaction={item} sessionId={state.selected} disabled={disabled || item.id !== interaction.id} navigation={navigation} error={state.interactionError} busy={state.actionBusy} />}
    </div>)}
    {showNotice && state.actionNotice && <p className="request-message" role="status">{state.actionNotice}</p>}
  </ComposerRequest>;
}
