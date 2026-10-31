import type { ComponentProps } from "react";
import { ShellDialog } from "../shell-dialog";
import "./tokens.css";
import "./chat-dialog.css";

export type ChatDialogSize = "compact" | "default" | "wide";

export type ChatDialogProps = Omit<ComponentProps<typeof ShellDialog>, "bare" | "className"> & {
  size?: ChatDialogSize;
  className?: string;
};

/** Titled, centered modal presentation; ShellDialog retains all modal behavior.
 * Place ChatDialogBody and an optional ChatDialogFooter directly inside it.
 * Mount while open and unmount from `close`, just like ShellDialog.
 */
export function ChatDialog({ size = "default", className = "", ...props }: ChatDialogProps) {
  return (
    <ShellDialog
      {...props}
      bare={false}
      className={`chat-dialog chat-dialog--${size} ${className}`.trim()}
    />
  );
}

export type ChatDialogBodyProps = ComponentProps<"div">;

/** The modal's scroll region. Native attributes and React 19 refs pass through. */
export function ChatDialogBody({ className = "", ...props }: ChatDialogBodyProps) {
  return <div {...props} className={`chat-dialog-body ${className}`.trim()} />;
}

export type ChatDialogFooterProps = ComponentProps<"footer">;

/** Non-scrolling, wrapping action row; button behavior belongs to the caller. */
export function ChatDialogFooter({ className = "", ...props }: ChatDialogFooterProps) {
  return <footer {...props} className={`chat-dialog-footer ${className}`.trim()} />;
}
