import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** DOM owns in-progress edits/IME. Polling must never rewrite the live buffer. */
export function ChatInput({ text, save, submit, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange" | "onInput"> & { text: string; save: (text: string) => void; submit: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const initialText = useRef(text);
  useLayoutEffect(() => {
    const element = input.current;
    // The equal-value guard is essential: even assigning the same value can
    // disturb native mobile composition, selection and internal textarea scroll.
    if (element && !composing.current && element.value !== text) element.value = text;
  }, [text]);
  return <textarea {...props} ref={input} defaultValue={initialText.current}
    onInput={event => save(event.currentTarget.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => { composing.current = false; save(event.currentTarget.value); }}
    onKeyDown={event => {
      // Plain Enter is a native newline on every device. Only the explicit
      // Ctrl/Cmd+Enter shortcut submits; IME confirmation never does.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); submit();
      }
    }} />;
}
