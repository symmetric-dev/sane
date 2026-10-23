import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { FiCheck, FiChevronDown } from "react-icons/fi";
import "./composer-request.css";

/** Request content has no card of its own: ChatComposer owns the single surface. */
export function ComposerRequest({ id, icon, label, title, status, tools, expanded = true, toggle, children, className = "", sectionRef }: {
  id: string; icon: ReactNode; label: string; title: string; status?: ReactNode; tools?: ReactNode;
  expanded?: boolean; toggle?: () => void; children: ReactNode; className?: string; sectionRef?: Ref<HTMLElement>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // A completed form may collapse after async delivery. Only restore focus if
    // it would otherwise be stranded inside that now-hidden content.
    if (!expanded && content.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
  }, [expanded]);
  const heading = <><span className="composer-request-icon" aria-hidden="true">{icon}</span><span className="composer-request-heading-text"><span className="composer-request-label">{label}</span><strong id={`${id}-title`} role={toggle ? undefined : "heading"} aria-level={toggle ? undefined : 3}>{title}</strong></span>{status && <span className="composer-request-status" role="status">{status}</span>}{toggle && <FiChevronDown className="composer-request-chevron" aria-hidden="true" />}</>;
  return <section ref={sectionRef} id={id} className={`composer-request ${className}`} aria-labelledby={`${id}-title`}>
    <header className="composer-request-header">
      {toggle ? <button ref={trigger} type="button" className="composer-request-heading" aria-expanded={expanded} aria-controls={`${id}-content`} onClick={toggle}>{heading}</button> : <div className="composer-request-heading">{heading}</div>}
      {tools && <div className="composer-request-tools">{tools}</div>}
    </header>
    <div ref={content} className="composer-request-content" id={`${id}-content`} hidden={!expanded}>{children}</div>
  </section>;
}

export function RequestBody({ children, resetKey }: { children: ReactNode; resetKey?: string | number }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [resetKey]);
  return <div ref={body} className="composer-request-body">{children}</div>;
}

export function RequestActions({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return <footer className="composer-request-actions">{hint && <span className="composer-request-hint">{hint}</span>}<div className="composer-request-buttons">{children}</div></footer>;
}

export function RequestButton({ variant = "secondary", className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger" }) {
  return <button {...props} type={type} className={`request-button request-button-${variant} ${className}`} />;
}

export function RequestTextarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`request-input request-textarea ${className}`} />;
}

export function RequestInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`request-input ${className}`} />;
}

export function RequestToggle({ checked, children, onChange, disabled }: { checked: boolean; children: ReactNode; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <button type="button" className="request-choice request-toggle" aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="request-choice-mark is-multiple" aria-hidden="true">{checked && <FiCheck size={12} />}</span><span className="request-choice-copy">{children}</span>
  </button>;
}

/** Toggle buttons keep keyboard and screen-reader behavior without native radio/checkbox chrome. */
export function RequestChoices({ options, values, multiple = false, disabled, label, choose }: {
  options: { value: string; label: string; description?: string }[]; values: string[];
  multiple?: boolean; disabled: boolean; label: string; choose: (value: string) => void;
}) {
  const id = useId();
  return <div className="request-choices" role="group" aria-label={label}>
    {options.map((option, index) => <button type="button" key={option.value} className="request-choice" disabled={disabled} aria-pressed={values.includes(option.value)} aria-labelledby={`${id}-${index}-label`} aria-describedby={option.description ? `${id}-${index}-description` : undefined} onClick={() => choose(option.value)}>
      <span className={`request-choice-mark${multiple ? " is-multiple" : ""}`} aria-hidden="true">{values.includes(option.value) && <FiCheck size={12} />}</span>
      <span className="request-choice-copy"><span id={`${id}-${index}-label`}>{option.label}</span>{option.description && <small id={`${id}-${index}-description`}>{option.description}</small>}</span>
    </button>)}
  </div>;
}

export function RequestDisclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="request-disclosure">
    <button type="button" className="request-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><FiChevronDown aria-hidden="true" />{label}</button>
    <div id={id} className="request-disclosure-content" hidden={!open}>{children}</div>
  </div>;
}
