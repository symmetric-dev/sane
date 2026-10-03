import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { useChatPathAutocomplete } from "./chat-path-autocomplete";

// Change to 3 for a shorter composer before the input starts scrolling.
const CHAT_INPUT_MAX_ROWS = 4;

function resizeInput(element: HTMLTextAreaElement) {
  const style = window.getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.65;
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  const maxHeight = lineHeight * CHAT_INPUT_MAX_ROWS + padding + border;
  const scrollTop = element.scrollTop;
  element.style.overflowY = "hidden";
  element.style.height = "auto";
  const height = Math.max(lineHeight + padding + border, element.scrollHeight + border);
  element.style.height = `${Math.min(height, maxHeight)}px`;
  element.style.overflowY = height > maxHeight ? "auto" : "hidden";
  element.scrollTop = scrollTop;
}

/** DOM owns in-progress edits/IME. Polling must never rewrite the live buffer. */
export function ChatInput({ text, save, submit, pathsActive = true, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange" | "onInput"> & { text: string; save: (text: string) => void; submit: () => void; pathsActive?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const initialText = useRef(text);
  const paths = useChatPathAutocomplete(input, pathsActive, value => { if (input.current) resizeInput(input.current); save(value); });
  useLayoutEffect(() => {
    const element = input.current;
    // The equal-value guard is essential: even assigning the same value can
    // disturb native mobile composition, selection and internal textarea scroll.
    if (element && !composing.current && element.value !== text) {
      paths.dismiss();
      element.value = text;
      resizeInput(element);
    }
  }, [text]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    resizeInput(element);
    let width = element.clientWidth;
    // Reflow wrapped lines when the sidebar, viewport or hidden chat changes width.
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      resizeInput(element);
      width = element.clientWidth;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <><textarea rows={1} {...props} {...paths.aria} ref={input} defaultValue={initialText.current}
    onInput={event => { resizeInput(event.currentTarget); save(event.currentTarget.value); paths.onInput(!!(event.nativeEvent as InputEvent).isComposing); }}
    onSelect={() => paths.refresh()} onFocus={() => paths.onFocus()} onBlur={() => paths.dismiss()}
    onCompositionStart={() => { composing.current = true; paths.onCompositionStart(); }}
    onCompositionEnd={event => { composing.current = false; resizeInput(event.currentTarget); save(event.currentTarget.value); paths.onCompositionEnd(); }}
    onKeyDown={event => {
      if (paths.onKeyDown(event)) return;
      // Plain Enter is a native newline on every device. Only the explicit
      // Ctrl/Cmd+Enter shortcut submits; IME confirmation never does.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); submit();
      }
    }} />{paths.popup}</>;
}
