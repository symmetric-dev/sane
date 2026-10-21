import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { FiChevronLeft, FiChevronRight, FiMaximize2 } from "react-icons/fi";
import { codeSharePages, type CodeShareRecord, type CodeShareSnapshot } from "../shared/code-share-contract";
import type { CodeShareProjection } from "./code-share-client";
import { resolvedEditorTheme } from "./workspace-theme";
import { themeSettings } from "./theme-settings";
import { ShellDialog } from "./shell-dialog";
import "./shared-code.css";

function languageExtension(language: string): Extension {
  if (["javascript", "typescript", "jsx", "tsx"].includes(language)) return javascript({ typescript: language === "typescript" || language === "tsx", jsx: language === "jsx" || language === "tsx" });
  switch (language) { case "json": return json(); case "css": return css(); case "html": return html(); case "markdown": return markdown(); case "python": return python(); default: return []; }
}
class CommentWidget extends WidgetType {
  constructor(readonly text: string, readonly label: string) { super(); }
  eq(other: CommentWidget) { return this.text === other.text && this.label === other.label; }
  toDOM() {
    const element = document.createElement("div");
    element.className = "shared-code-comment";
    element.setAttribute("role", "note"); element.setAttribute("aria-label", this.label);
    element.textContent = this.text;
    return element;
  }
  ignoreEvent() { return false; }
}
function annotations(share: CodeShareSnapshot, state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  const highlights = share.input.highlights ?? [];
  // Union line backgrounds even when annotation ranges overlap.
  const lines = new Set<number>();
  highlights.forEach(highlight => {
    for (let line = highlight.startLine; line <= highlight.endLine; line++) lines.add(line);
  });
  for (const original of [...lines].sort((a, b) => a - b)) {
    const local = original - share.input.startLine + 1;
    if (local >= 1 && local <= state.doc.lines) ranges.push(Decoration.line({ class: "shared-code-highlight" }).range(state.doc.line(local).from));
  }
  // Stable source order for comments starting at the same original line.
  highlights.map((highlight, index) => ({ ...highlight, index })).filter(highlight => highlight.comment !== undefined).sort((a, b) => a.startLine - b.startLine || a.index - b.index).forEach(highlight => {
    const local = highlight.startLine - share.input.startLine + 1;
    if (local >= 1 && local <= state.doc.lines) ranges.push(Decoration.widget({ widget: new CommentWidget(highlight.comment!, `Annotation for lines ${highlight.startLine}–${highlight.endLine}`), block: true, side: -1 }).range(state.doc.line(local).from));
  });
  // A direct facet supplies block decorations before layout (not a view plugin).
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

function CodeSnippetView({ snippet: share, wrap, description }: { snippet: CodeShareSnapshot; wrap: boolean; description: string }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<{ editor: EditorView; wrapping: Compartment } | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const wrapping = new Compartment(), theme = new Compartment();
    let editor: EditorView | undefined, unsubscribe: (() => void) | undefined;
    try {
      const state = EditorState.create({ doc: share.code });
      editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: share.code, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), languageExtension(share.language),
        theme.of(resolvedEditorTheme(themeSettings.snapshot().resolved)), wrapping.of([]),
        lineNumbers({ formatNumber: number => String(number + share.input.startLine - 1) }), keymap.of(searchKeymap), annotations(share, state),
        EditorView.contentAttributes.of({ "aria-label": `Frozen code snapshot: ${share.input.path}`, "aria-describedby": description, "aria-readonly": "true", tabindex: "0" }),
      ] }) });
      view.current = { editor, wrapping };
      let resolved = themeSettings.snapshot().resolved;
      unsubscribe = themeSettings.subscribe(() => {
        const next = themeSettings.snapshot().resolved;
        if (next !== resolved) { resolved = next; editor!.dispatch({ effects: theme.reconfigure(resolvedEditorTheme(next)) }); }
      });
      setFallback(false);
    } catch { editor?.destroy(); editor = undefined; view.current = null; host.current?.replaceChildren(); setFallback(true); }
    return () => { unsubscribe?.(); editor?.destroy(); view.current = null; };
  }, [share, description]);
  useEffect(() => { view.current?.editor.dispatch({ effects: view.current.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, share]);
  return <>
    <div ref={host} hidden={fallback} className="shared-code-editor" />
    {fallback && <div className="shared-code-fallback"><pre aria-label="Plain-text frozen code snapshot" style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>{share.code.split("\n").map((line, index) => {
      const original = share.input.startLine + index;
      const highlighted = share.input.highlights?.some(range => range.startLine <= original && original <= range.endLine);
      return <Fragment key={index}>{share.input.highlights?.filter(range => range.startLine === original && range.comment !== undefined).map((range, ordinal) => <span key={ordinal} role="note" className="shared-code-comment" aria-label={`Annotation for lines ${range.startLine}–${range.endLine}`}>{range.comment}</span>)}<span className={highlighted ? "shared-code-highlight" : undefined}><span className="shared-code-line-number" aria-hidden="true">{original} </span>{line}{index < share.input.endLine - share.input.startLine ? "\n" : ""}</span></Fragment>;
    })}</pre></div>}
  </>;
}

function CodeShareReader({ snippet, page, count, previous, next, wrap, toggleWrap, openModal, expanded = false }: {
  snippet: CodeShareSnapshot; page: number; count: number; previous: () => void; next: () => void;
  wrap: boolean; toggleWrap: () => void; openModal?: () => void; expanded?: boolean;
}) {
  const description = useId();
  const [copied, setCopied] = useState<{ snippet: CodeShareSnapshot; message: string } | null>(null);
  return <section className={`shared-code-card${expanded ? " shared-code-expanded" : ""}`} aria-label={`Shared code: ${snippet.input.path}`}>
    <header>
      <strong title={snippet.input.path}>{snippet.input.path}</strong>
      <span>L{snippet.input.startLine}–{snippet.input.endLine}</span><span>{snippet.language}</span>
      <button type="button" aria-pressed={wrap} onClick={toggleWrap}>Wrap</button>
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(snippet.code); setCopied({ snippet, message: "Copied" }); }
        catch { setCopied({ snippet, message: "Copy unavailable" }); }
      }}>Copy code</button>
    </header>
    <p id={description} className="shared-code-caption">Frozen snapshot · not the current file{snippet.input.highlights?.length ? " · Highlighted lines and annotations refer to original line numbers." : ""}</p>
    <span className="shared-code-feedback" role="status">{copied?.snippet === snippet ? copied.message : ""}</span>
    <CodeSnippetView key={page} snippet={snippet} wrap={wrap} description={description} />
    {(count > 1 || openModal) && <footer className="shared-code-controls">
      {count > 1 && <nav className="shared-code-pagination" aria-label="Code snippet pages">
        <button type="button" className="shared-code-page-button" aria-label="Previous snippet" disabled={page === 0} onClick={previous}><FiChevronLeft aria-hidden="true" /></button>
        <span role="status" aria-live="polite" aria-atomic="true">Snippet {page + 1} of {count}</span>
        <button type="button" className="shared-code-page-button" aria-label="Next snippet" disabled={page === count - 1} onClick={next}><FiChevronRight aria-hidden="true" /></button>
      </nav>}
      {openModal && <button type="button" className="shared-code-open" aria-label="Open in modal" title="Open in modal" onClick={openModal}><FiMaximize2 aria-hidden="true" /></button>}
    </footer>}
  </section>;
}

export function SharedCodeCard({ share }: { share: CodeShareRecord }) {
  const snippets = useMemo(() => codeSharePages(share), [share]);
  const [page, setPage] = useState(0), [wrap, setWrap] = useState(false), [expanded, setExpanded] = useState(false);
  const selected = Math.min(page, snippets.length - 1);
  const reader = {
    snippet: snippets[selected], page: selected, count: snippets.length,
    previous: () => setPage(current => Math.max(0, current - 1)),
    next: () => setPage(current => Math.min(snippets.length - 1, current + 1)),
    wrap, toggleWrap: () => setWrap(current => !current),
  };
  return <>
    <CodeShareReader {...reader} openModal={() => setExpanded(true)} />
    {expanded && <ShellDialog title="Shared code" subtitle={`Snippet ${selected + 1} of ${snippets.length}`} className="shared-code-dialog" close={() => setExpanded(false)}>
      <CodeShareReader {...reader} expanded />
    </ShellDialog>}
  </>;
}

export function CodeShareStatus({ projection }: { projection?: CodeShareProjection }) {
  return projection?.error ? <p className="shared-code-notice" role="alert">Shared code refresh unavailable: {projection.error} <button type="button" onClick={projection.retry}>Retry shared code</button></p> : null;
}
export function PendingCodeShare({ projection, running, failed }: { projection?: CodeShareProjection; running: boolean; failed?: boolean }) {
  const status = failed
    ? projection?.loading ? "Code sharing reported an error. Checking for a saved snapshot…" : "Code sharing failed; no saved snapshot is available."
    : projection?.error ? "Shared code snapshot unavailable." : projection?.loading || running ? "Waiting for the saved code snapshot…" : "No saved code snapshot is available for this call.";
  return <section className="shared-code-card shared-code-pending" aria-label="Shared code snapshot"><p role="status">{status}</p><button type="button" onClick={projection?.retry} disabled={!projection || projection.loading}>Retry snapshot</button></section>;
}
