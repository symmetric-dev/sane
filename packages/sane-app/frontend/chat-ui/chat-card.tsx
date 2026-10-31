import type { ComponentPropsWithRef, ReactNode } from "react";
import "./tokens.css";
import "./chat-card.css";

export type ChatCardProps = ComponentPropsWithRef<"section"> & {
  density?: "default" | "compact";
};

export type ChatCardHeaderProps = Omit<ComponentPropsWithRef<"header">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  metadata?: ReactNode;
  /** Decorative content only; place interactive controls in actions. */
  icon?: ReactNode;
  actions?: ReactNode;
  /** Opt into a heading at the appropriate level for the surrounding page. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Use with the card's aria-labelledby when the card needs a name. */
  titleId?: string;
};

export type ChatCardBodyProps = ComponentPropsWithRef<"div"> & {
  /** Remove padding for media, editors, or other edge-to-edge content. */
  flush?: boolean;
};

export type ChatCardFooterProps = ComponentPropsWithRef<"footer">;
export type ChatReceiptProps = ComponentPropsWithRef<"div">;
export type ChatMetadataProps = ComponentPropsWithRef<"div">;

/** Opt-in frame. Callers own accessible naming and interaction semantics. */
export function ChatCard({ density = "default", className, ...props }: ChatCardProps) {
  return <section {...props} className={`chat-card${density === "compact" ? " chat-card-compact" : ""}${className ? ` ${className}` : ""}`} />;
}

/** Titles are plain text containers unless headingLevel is explicitly supplied. */
export function ChatCardHeader({ title, description, metadata, icon, actions, headingLevel, titleId, children, className, ...props }: ChatCardHeaderProps) {
  const Title = headingLevel ? `h${headingLevel}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6" : "div";
  return <header {...props} className={`chat-card-header${className ? ` ${className}` : ""}`}>
    {icon != null && <div className="chat-card-header-icon" aria-hidden="true">{icon}</div>}
    <div className="chat-card-header-content">
      <Title id={titleId} className="chat-card-header-title">{title}</Title>
      {description != null && <div className="chat-card-header-description">{description}</div>}
      {metadata != null && <ChatMetadata className="chat-card-header-metadata">{metadata}</ChatMetadata>}
      {children}
    </div>
    {actions != null && <div className="chat-card-header-actions">{actions}</div>}
  </header>;
}

export function ChatCardBody({ flush = false, className, ...props }: ChatCardBodyProps) {
  return <div {...props} className={`chat-card-body${flush ? " chat-card-body-flush" : ""}${className ? ` ${className}` : ""}`} />;
}

export function ChatCardFooter({ className, ...props }: ChatCardFooterProps) {
  return <footer {...props} className={`chat-card-footer${className ? ` ${className}` : ""}`} />;
}

/** Lightweight, unframed layout for report and handoff content. */
export function ChatReceipt({ className, ...props }: ChatReceiptProps) {
  return <div {...props} className={`chat-receipt${className ? ` ${className}` : ""}`} />;
}

/** Wrapping secondary information; no automatic status or live-region role. */
export function ChatMetadata({ className, ...props }: ChatMetadataProps) {
  return <div {...props} className={`chat-metadata${className ? ` ${className}` : ""}`} />;
}
