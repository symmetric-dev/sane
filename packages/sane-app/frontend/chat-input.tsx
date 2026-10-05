import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { useChatPathAutocomplete } from "./chat-path-autocomplete";

// Change to 3 for a shorter composer before the input starts scrolling.
const CHAT_INPUT_MAX_ROWS = 4;

const INPUT_MEASUREMENT_PROPERTIES = [
  "box-sizing", "width", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
  "font-feature-settings", "font-variation-settings", "font-optical-sizing", "font-kerning",
  "line-height", "letter-spacing", "word-spacing", "text-indent", "text-transform", "text-rendering",
  "white-space", "overflow-wrap", "word-break", "tab-size", "direction", "text-align", "hyphens",
  "-webkit-text-size-adjust", "text-size-adjust",
];

function createInputSizer(element: HTMLTextAreaElement) {
  const mirror = document.createElement("textarea");
  mirror.rows = 1;
  mirror.tabIndex = -1;
  mirror.readOnly = true;
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText = "all:initial;position:fixed;top:0;left:-10000px;display:block;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;min-width:0;max-width:none;overflow:hidden;resize:none;margin:0;";
  document.body.appendChild(mirror);
  let signature = "", measuredValue: string | undefined;
  let invalidated = false;
  let minHeight = 0, maxHeight = 0, padding = 0, border = 0, borderBox = true;
  const resize = (force = false) => {
    if (force) invalidated = true;
    const style = window.getComputedStyle(element);
    if (!style.width.endsWith("px") || parseFloat(style.width) <= 0) return;
    const values = INPUT_MEASUREMENT_PROPERTIES.map(property => style.getPropertyValue(property));
    const lang = element.closest("[lang]")?.getAttribute("lang") || "";
    const nextSignature = JSON.stringify([values, element.wrap, lang]);
    if (invalidated || nextSignature !== signature) {
      INPUT_MEASUREMENT_PROPERTIES.forEach((property, index) => mirror.style.setProperty(property, values[index]!));
      mirror.wrap = element.wrap;
      mirror.lang = lang;
      padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      borderBox = style.boxSizing === "border-box";
      const lineHeight = parseFloat(style.lineHeight) || 0;
      mirror.value = "x";
      minHeight = Math.max(Math.ceil(lineHeight + padding), mirror.scrollHeight);
      mirror.value = Array(CHAT_INPUT_MAX_ROWS).fill("x").join("\n");
      maxHeight = Math.max(Math.ceil(lineHeight * CHAT_INPUT_MAX_ROWS + padding), mirror.scrollHeight);
      signature = nextSignature;
      measuredValue = undefined;
      invalidated = false;
    }
    if (measuredValue === element.value) return;
    if (mirror.value !== element.value) mirror.value = element.value;
    const measuredHeight = Math.max(minHeight, mirror.scrollHeight);
    const height = `${Math.min(measuredHeight, maxHeight) + (borderBox ? border : -padding)}px`;
    const overflow = measuredHeight > maxHeight ? "auto" : "hidden";
    if (element.style.height !== height) element.style.height = height;
    if (element.style.overflowY !== overflow) element.style.overflowY = overflow;
    measuredValue = element.value;
  };
  return { resize, dispose: () => mirror.remove() };
}

/** DOM owns in-progress edits/IME. Polling must never rewrite the live buffer. */
export function ChatInput({ text, save, submit, pathsActive = true, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange" | "onInput"> & { text: string; save: (text: string) => void; submit: () => void; pathsActive?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const sizing = useRef<ReturnType<typeof createInputSizer> | null>(null);
  const composing = useRef(false);
  const initialText = useRef(text);
  const paths = useChatPathAutocomplete(input, pathsActive, value => { sizing.current?.resize(); save(value); });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const sizer = createInputSizer(element);
    sizing.current = sizer;
    sizer.resize();
    let width = 0;
    // Reflow wrapped lines when the sidebar, viewport or hidden chat changes width.
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.borderBoxSize[0]?.inlineSize ?? element.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      sizer.resize();
    });
    observer.observe(element);
    const resize = () => sizer.resize();
    const fontsLoaded = () => sizer.resize(true);
    const fonts = document.fonts;
    const observeFonts = typeof fonts?.addEventListener === "function" && typeof fonts?.removeEventListener === "function";
    window.addEventListener("resize", resize);
    if (observeFonts) fonts.addEventListener("loadingdone", fontsLoaded);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      if (observeFonts) fonts.removeEventListener("loadingdone", fontsLoaded);
      sizer.dispose();
      sizing.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const element = input.current;
    // The equal-value guard is essential: even assigning the same value can
    // disturb native mobile composition, selection and internal textarea scroll.
    if (element && !composing.current && element.value !== text) {
      paths.dismiss();
      element.value = text;
      sizing.current?.resize();
    }
  }, [text]);
  useLayoutEffect(() => { sizing.current?.resize(); }, [props.className, props.style, props.wrap, props.dir, props.lang]);
  return <><textarea rows={1} {...props} {...paths.aria} ref={input} defaultValue={initialText.current}
    onInput={event => { sizing.current?.resize(); save(event.currentTarget.value); paths.onInput(!!(event.nativeEvent as InputEvent).isComposing); }}
    onSelect={() => paths.refresh()} onFocus={() => paths.onFocus()} onBlur={() => paths.dismiss()}
    onCompositionStart={() => { composing.current = true; paths.onCompositionStart(); }}
    onCompositionEnd={event => { composing.current = false; sizing.current?.resize(); save(event.currentTarget.value); paths.onCompositionEnd(); }}
    onKeyDown={event => {
      if (paths.onKeyDown(event)) return;
      // Plain Enter is a native newline on every device. Only the explicit
      // Ctrl/Cmd+Enter shortcut submits; IME confirmation never does.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); submit();
      }
    }} />{paths.popup}</>;
}
