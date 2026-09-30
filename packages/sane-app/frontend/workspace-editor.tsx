import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { unifiedMergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { workspaceEditorTheme } from "./workspace-theme";
import { codeSettings, shouldWrap } from "./code-settings";

export const wrapping = new Compartment();
const noWrapping: Extension = [];
export const wrappingExtension = (path: string) => shouldWrap(path, codeSettings.snapshot()) ? EditorView.lineWrapping : noWrapping;

function language(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx"].includes(ext || "")) return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "jsx" || ext === "tsx" });
  if (ext === "json") return json();
  if (ext === "css") return css();
  if (ext === "html" || ext === "htm") return html();
  if (ext === "md" || ext === "markdown") return markdown();
  return [];
}
export function createBufferState(path: string, text: string, update: (state: EditorState) => void, save: () => void) {
  return EditorState.create({ doc: text, extensions: [workspaceEditorTheme, language(path), wrapping.of(wrappingExtension(path)), lineNumbers(), history(), drawSelection(), highlightActiveLine(), highlightActiveLineGutter(), indentOnInput(), bracketMatching(),
    keymap.of([{ key: "Mod-s", run: () => { save(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of(transaction => { if (transaction.docChanged || transaction.selectionSet) update(transaction.state); }),
  ] });
}
export function WorkspaceEditor({ state, onView }: { state: EditorState; onView: (view: EditorView | null) => void }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  useEffect(() => {
    const instance = new EditorView({ state, parent: host.current! });
    view.current = instance; onView(instance);
    return () => { onView(null); instance.destroy(); view.current = null; };
  }, [onView]);
  useEffect(() => { if (view.current && view.current.state !== state) view.current.setState(state); }, [state]);
  return <div className="workspace-editor" ref={host} />;
}
export function ReadOnlyDocument({ path, text }: { path: string; text: string }) {
  const extensions = useSyncExternalStore(codeSettings.subscribe, codeSettings.snapshot);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: [workspaceEditorTheme, language(path), wrappingExtension(path), lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), keymap.of(searchKeymap)] }) });
    return () => editor.destroy();
  }, [path, text, extensions]);
  return <div className="workspace-editor" ref={host} aria-label="Read-only workstream artifact" />;
}
export function WorkspaceDiffEditor({ path, before, after, label = "Before → After", viewRef }: { path: string; before: string; after: string; label?: string; viewRef: RefObject<EditorView | null> }) {
  const extensions = useSyncExternalStore(codeSettings.subscribe, codeSettings.snapshot);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const instance = new EditorView({ parent: host.current!, state: EditorState.create({ doc: after, extensions: [workspaceEditorTheme, language(path), wrappingExtension(path), lineNumbers(), drawSelection(), EditorState.readOnly.of(true), EditorView.editable.of(false), keymap.of(searchKeymap), unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 8 } })] }) });
    viewRef.current = instance;
    return () => { instance.destroy(); if (viewRef.current === instance) viewRef.current = null; };
  }, [path, before, after, viewRef, extensions]);
  return <div className="workspace-diff" role="region" aria-label={label}><div ref={host} className="workspace-editor" /></div>;
}
