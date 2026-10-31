import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import "./tokens.css";
import "./chat-controls.css";

export type ChatTone = "neutral" | "info" | "success" | "warning" | "danger";
export type ChatButtonVariant = "primary" | "secondary" | "ghost" | "danger";

function classes(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(" ");
}

function BusyMark() {
  return <span className="chat-button__spinner" aria-hidden="true" />;
}

export type ChatButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: ChatButtonVariant;
  busy?: boolean;
  icon?: ReactNode;
};

/** Busy buttons remain labeled and are natively disabled to prevent duplicate actions. */
export function ChatButton({
  variant = "secondary", busy = false, icon, children, className,
  type = "button", disabled, "aria-busy": ariaBusy, ...props
}: ChatButtonProps) {
  return <button
    {...props}
    type={type}
    disabled={disabled || busy}
    aria-busy={ariaBusy ?? (busy || undefined)}
    data-busy={busy || undefined}
    data-variant={variant}
    className={classes("chat-button", className)}
  >
    {busy ? <BusyMark /> : icon != null && <span className="chat-button__icon" aria-hidden="true">{icon}</span>}
    <span className="chat-button__label">{children}</span>
  </button>;
}

export type ChatIconButtonProps = Omit<ChatButtonProps, "icon" | "children" | "aria-label"> & {
  "aria-label": string;
  children: ReactNode;
};

/** Supply a non-empty action label; decorative icons never become part of its name. */
export function ChatIconButton({
  "aria-label": label, title = label, children, className,
  variant = "ghost", busy = false, type = "button", disabled,
  "aria-busy": ariaBusy, ...props
}: ChatIconButtonProps) {
  return <button
    {...props}
    type={type}
    disabled={disabled || busy}
    aria-label={label}
    title={title}
    aria-busy={ariaBusy ?? (busy || undefined)}
    data-busy={busy || undefined}
    data-variant={variant}
    className={classes("chat-button", "chat-icon-button", className)}
  >
    {busy ? <BusyMark /> : <span className="chat-button__icon" aria-hidden="true">{children}</span>}
  </button>;
}

export type ChatStatusProps = ComponentPropsWithRef<"span"> & {
  tone?: ChatTone;
  busy?: boolean;
  icon?: ReactNode;
};

/** Presentation only. Consumers opt into live announcements with native role/aria props. */
export function ChatStatus({ tone = "neutral", busy = false, icon, children, className, ...props }: ChatStatusProps) {
  return <span {...props} className={classes("chat-status", className)} data-tone={tone} data-busy={busy || undefined}>
    {busy ? <BusyMark /> : icon != null && <span className="chat-status__icon" aria-hidden="true">{icon}</span>}
    <span className="chat-status__label">{children}</span>
  </span>;
}

export type ChatNoticeProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  tone?: ChatTone;
  /** Title content, not the native tooltip attribute. */
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
};

/** No implicit alert/status role and no built-in domain actions. */
export function ChatNotice({ tone = "neutral", title, icon, actions, children, className, ...props }: ChatNoticeProps) {
  return <div {...props} className={classes("chat-notice", className)} data-tone={tone}>
    {icon != null && <span className="chat-notice__icon" aria-hidden="true">{icon}</span>}
    <div className="chat-notice__content">
      {title != null && <div className="chat-notice__title">{title}</div>}
      {children != null && <div className="chat-notice__body">{children}</div>}
    </div>
    {actions != null && <div className="chat-notice__actions">{actions}</div>}
  </div>;
}

export type ChatDisclosureProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  /** Non-interactive trigger content. Put independent controls in actions instead. */
  title: ReactNode;
  actions?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  headingLevel?: 2 | 3 | 4 | 5 | 6;
};

/** Content stays mounted but hidden (and unfocusable) while collapsed. */
export function ChatDisclosure({
  title, actions, open, defaultOpen = false, onOpenChange, headingLevel = 3,
  id, children, className, ...props
}: ChatDisclosureProps) {
  const generatedId = useId();
  const baseId = id ?? `chat-disclosure-${generatedId}`;
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyOpen = useRef(expanded);
  const focusWithin = useRef(false);
  const Heading: "h2" | "h3" | "h4" | "h5" | "h6" = `h${headingLevel}`;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (previouslyOpen.current && !expanded && content &&
      (focusWithin.current || content.contains(content.ownerDocument.activeElement))) {
      triggerRef.current?.focus({ preventScroll: true });
      focusWithin.current = false;
    }
    previouslyOpen.current = expanded;
  }, [expanded]);

  function toggle() {
    if (open === undefined) setInternalOpen(!expanded);
    onOpenChange?.(!expanded);
  }

  return <div {...props} id={id} className={classes("chat-disclosure", className)} data-open={expanded}>
    <div className="chat-disclosure__header">
      <Heading className="chat-disclosure__heading">
        <button
          ref={triggerRef}
          id={triggerId}
          className="chat-disclosure__trigger"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
        >
          <svg className="chat-disclosure__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="chat-disclosure__title">{title}</span>
        </button>
      </Heading>
      {actions != null && <div className="chat-disclosure__actions">{actions}</div>}
    </div>
    <div
      ref={contentRef}
      id={contentId}
      className="chat-disclosure__content"
      hidden={!expanded}
      onFocusCapture={() => { focusWithin.current = true; }}
      onBlurCapture={(event) => {
        focusWithin.current = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
      }}
    >{children}</div>
  </div>;
}
