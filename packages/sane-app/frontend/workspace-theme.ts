import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Semantic variables live in workspace.css so additional palettes need no editor changes.
export const workspaceEditorTheme = [EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "var(--background)", height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "auto", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0", caretColor: "var(--primary)" },
  ".cm-line": { padding: "0 20px" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--ws-selection) !important" },
  ".cm-cursor": { borderLeftColor: "var(--primary)" },
  ".cm-panels, .cm-tooltip": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-insertedLine": { backgroundColor: "var(--ws-added)" },
  ".cm-deletedChunk": { backgroundColor: "var(--ws-removed)" },
  ".cm-insertedText": { backgroundColor: "var(--ws-added-text)" },
  ".cm-deletedText": { backgroundColor: "var(--ws-removed-text)" },
  ".cm-collapsedLines": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", padding: "6px 20px" },
}), syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--ws-keyword)" },
  { tag: [tags.string, tags.regexp], color: "var(--ws-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ws-number)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.tagName], color: "var(--ws-function)" },
  { tag: [tags.heading, tags.strong], fontWeight: "bold" },
  { tag: tags.link, color: "var(--primary)", textDecoration: "underline" },
]))];
