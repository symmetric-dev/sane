import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { searchKeymap } from "@codemirror/search";
import { resolvedEditorTheme } from "./workspace-theme";
import { themeSettings } from "./theme-settings";
import "./activity-code.css";

export function activityCodePresentation(value: unknown): { text: string; isJson: boolean } {
  if (value === undefined) return { text: "Unavailable", isJson: false };
  if (typeof value === "string") {
    try { JSON.parse(value); return { text: value, isJson: true }; }
    catch { return { text: value, isJson: false }; }
  }
  try {
    const text = JSON.stringify(value, null, 2);
    if (text !== undefined) return { text, isJson: true };
  } catch {}
  return { text: "Value cannot be displayed as JSON.", isJson: false };
}

const contentAttributes = (label: string) => EditorView.contentAttributes.of({ "aria-label": label, "aria-readonly": "true", tabindex: "0" });

export function ActivityCodeView({ value, label }: { value: unknown; label: string }) {
  const presentation = useMemo(() => activityCodePresentation(value), [value]);
  const current = useRef({ presentation, label });
  current.current = { presentation, label };
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ editor: EditorView; language: Compartment; attributes: Compartment; presentation: typeof presentation; label: string } | null>(null);
  useEffect(() => {
    const { presentation, label } = current.current;
    const language = new Compartment(), attributes = new Compartment(), theme = new Compartment();
    let resolved = themeSettings.snapshot().resolved;
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: presentation.text, extensions: [
      theme.of(resolvedEditorTheme(resolved)), language.of(presentation.isJson ? json() : []), attributes.of(contentAttributes(label)),
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), EditorView.lineWrapping, keymap.of(searchKeymap),
    ] }) });
    view.current = { editor, language, attributes, presentation, label };
    const unsubscribe = themeSettings.subscribe(() => {
      const next = themeSettings.snapshot().resolved;
      if (next === resolved) return;
      resolved = next;
      editor.dispatch({ effects: theme.reconfigure(resolvedEditorTheme(next)) });
    });
    return () => { unsubscribe(); editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const { editor, language, attributes } = instance;
    const effects = [];
    if (presentation.isJson !== instance.presentation.isJson) effects.push(language.reconfigure(presentation.isJson ? json() : []));
    if (label !== instance.label) effects.push(attributes.reconfigure(contentAttributes(label)));
    const changed = presentation.text !== instance.presentation.text;
    if (changed || effects.length) editor.dispatch({ changes: changed ? { from: 0, to: editor.state.doc.length, insert: presentation.text } : undefined, effects });
    instance.presentation = presentation; instance.label = label;
  }, [presentation, label]);
  return <div className="activity-code-view" ref={host} />;
}
