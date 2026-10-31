import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { FiMaximize2 } from "react-icons/fi";
import { codeSharePages, type CodeShareRecord, type CodeShareSnapshot } from "../shared/code-share-contract";
import type { CodeShareProjection } from "./code-share-client";
import { codeShareSnippetPresentation } from "./code-share-presentation";
import { SharedCodeNavigation } from "./shared-code-navigation";
import { editorLanguage } from "./editor-languages";
import { resolvedEditorTheme } from "./workspace-theme";
import { themeSettings } from "./theme-settings";
import { ChatButton, ChatCard, ChatCardBody, ChatCardFooter, ChatCardHeader, ChatDialog, ChatDialogBody, ChatIconButton, ChatNotice } from "./chat-ui";
import "./shared-code.css";

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
  const { startLine } = codeShareSnippetPresentation(share);
  const highlights = share.input.highlights ?? [];
  // Union line backgrounds even when annotation ranges overlap.
  const lines = new Set<number>();
  highlights.forEach(highlight => {
    for (let line = highlight.startLine; line <= highlight.endLine; line++) lines.add(line);
  });
  for (const original of [...lines].sort((a, b) => a - b)) {
    const local = original - startLine + 1;
    if (local >= 1 && local <= state.doc.lines) ranges.push(Decoration.line({ class: "shared-code-highlight" }).range(state.doc.line(local).from));
  }
  // Stable source order for comments starting at the same original line.
  highlights.map((highlight, index) => ({ ...highlight, index })).filter(highlight => highlight.comment !== undefined).sort((a, b) => a.startLine - b.startLine || a.index - b.index).forEach(highlight => {
    const local = highlight.startLine - startLine + 1;
    if (local >= 1 && local <= state.doc.lines) ranges.push(Decoration.widget({ widget: new CommentWidget(highlight.comment!, `Annotation for lines ${highlight.startLine}–${highlight.endLine}`), block: true, side: -1 }).range(state.doc.line(local).from));
  });
  // A direct facet supplies block decorations before layout (not a view plugin).
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

function CodeSnippetView({ snippet: share, wrap, description }: { snippet: CodeShareSnapshot; wrap: boolean; description: string }) {
  const { startLine, endLine, title, inline } = codeShareSnippetPresentation(share);
  const host = useRef<HTMLDivElement>(null), view = useRef<{ editor: EditorView; wrapping: Compartment } | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const wrapping = new Compartment(), theme = new Compartment();
    let editor: EditorView | undefined, unsubscribe: (() => void) | undefined;
    try {
      const state = EditorState.create({ doc: share.code });
      editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: share.code, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), editorLanguage(share.language),
        theme.of(resolvedEditorTheme(themeSettings.snapshot().resolved)), wrapping.of([]),
        lineNumbers({ formatNumber: number => String(number + startLine - 1) }), keymap.of(searchKeymap), annotations(share, state),
        EditorView.contentAttributes.of({ "aria-label": `${inline ? "Suggested code" : "Frozen code snapshot"}: ${title}`, "aria-describedby": description, "aria-readonly": "true", tabindex: "0" }),
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
    {fallback && <div className="shared-code-fallback"><pre tabIndex={0} aria-label="Plain-text frozen code snapshot" style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>{share.code.split("\n").map((line, index) => {
      const original = startLine + index;
      const highlighted = share.input.highlights?.some(range => range.startLine <= original && original <= range.endLine);
      return <Fragment key={index}>{share.input.highlights?.filter(range => range.startLine === original && range.comment !== undefined).map((range, ordinal) => <span key={ordinal} role="note" className="shared-code-comment" aria-label={`Annotation for lines ${range.startLine}–${range.endLine}`}>{range.comment}</span>)}<span className={highlighted ? "shared-code-highlight" : undefined}><span className="shared-code-line-number" aria-hidden="true">{original} </span>{line}{index < endLine - startLine ? "\n" : ""}</span></Fragment>;
    })}</pre></div>}
  </>;
}

function CodeShareReader({ snippets, page, select, wrap, toggleWrap, openModal, expanded = false }: {
  snippets: readonly CodeShareSnapshot[]; page: number; select: (index: number) => void;
  wrap: boolean; toggleWrap: () => void; openModal?: () => void; expanded?: boolean;
}) {
  const description = useId(), viewId = useId(), snippet = snippets[page];
  const { title, path, startLine, endLine, inline } = codeShareSnippetPresentation(snippet);
  const [copied, setCopied] = useState<{ snippet: CodeShareSnapshot; message: string } | null>(null);
  return <ChatCard density="compact" className={`shared-code-card${expanded ? " shared-code-expanded" : ""}`} aria-label={`Shared code: ${title}`}>
    <ChatCardHeader title={<span title={title}>{title}</span>}
      metadata={<>{path && title !== path && <span className="shared-code-source-path" title={path}>{path}</span>}<span>L{startLine}–{endLine}</span><span>{snippet.language}</span></>}
      actions={<>
      <ChatButton variant="ghost" aria-pressed={wrap} onClick={toggleWrap}>Wrap</ChatButton>
      <ChatButton variant="ghost" onClick={async () => {
        try { await navigator.clipboard.writeText(snippet.code); setCopied({ snippet, message: "Copied" }); }
        catch { setCopied({ snippet, message: "Copy unavailable" }); }
      }}>Copy code</ChatButton>
      {openModal && <ChatIconButton aria-label="Open in modal" onClick={openModal}><FiMaximize2 /></ChatIconButton>}
    </>} />
    <p id={description} className="shared-code-caption">{inline ? "Suggested code · not saved to a file" : "Frozen snapshot · not the current file"}{snippet.input.highlights?.length ? inline ? " · Highlighted lines and annotations refer to snippet line numbers." : " · Highlighted lines and annotations refer to original line numbers." : ""}</p>
    <span className="shared-code-feedback" role="status">{copied?.snippet === snippet ? copied.message : ""}</span>
    <ChatCardBody flush className="shared-code-panel" role="tabpanel" id={`${viewId}-panel`} aria-labelledby={`${viewId}-tab-${page}`}>
      <CodeSnippetView key={page} snippet={snippet} wrap={wrap} description={description} />
    </ChatCardBody>
    <ChatCardFooter className="shared-code-controls">
      <SharedCodeNavigation snippets={snippets} page={page} select={select} viewId={viewId} />
    </ChatCardFooter>
  </ChatCard>;
}

export function SharedCodeCard({ share }: { share: CodeShareRecord }) {
  const snippets = useMemo(() => codeSharePages(share), [share]);
  const [page, setPage] = useState(0), [wrap, setWrap] = useState(false), [expanded, setExpanded] = useState(false);
  const selected = Math.min(page, snippets.length - 1);
  const reader = {
    snippets, page: selected, select: setPage,
    wrap, toggleWrap: () => setWrap(current => !current),
  };
  return <>
    <CodeShareReader {...reader} openModal={() => setExpanded(true)} />
    {expanded && <ChatDialog title="Shared code" subtitle={`Snippet ${selected + 1} of ${snippets.length}`} size="wide" className="shared-code-dialog" close={() => setExpanded(false)}>
      <ChatDialogBody><CodeShareReader {...reader} expanded /></ChatDialogBody>
    </ChatDialog>}
  </>;
}

export function CodeShareStatus({ projection }: { projection?: CodeShareProjection }) {
  return projection?.error ? <ChatNotice className="shared-code-notice" tone="warning" role="alert" actions={<ChatButton onClick={projection.retry}>Retry shared code</ChatButton>}>Shared code refresh unavailable: {projection.error}</ChatNotice> : null;
}
export function PendingCodeShare({ projection, running, failed }: { projection?: CodeShareProjection; running: boolean; failed?: boolean }) {
  const status = failed
    ? projection?.loading ? "Code sharing reported an error. Checking for a saved snapshot…" : "Code sharing failed; no saved snapshot is available."
    : projection?.error ? "Shared code snapshot unavailable." : projection?.loading || running ? "Waiting for the saved code snapshot…" : "No saved code snapshot is available for this call.";
  return <ChatNotice className="shared-code-pending" aria-label="Shared code snapshot" role="status" tone={failed || projection?.error ? "warning" : "neutral"} actions={<ChatButton onClick={projection?.retry} disabled={!projection || projection.loading}>Retry snapshot</ChatButton>}>{status}</ChatNotice>;
}
