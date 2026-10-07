import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { nodeText, visitDocumentHeadings, type MarkdownNode } from "./document-outline";
import "./document-markdown.css";

type DocumentMarkdownProps = { text: string; path: string; fragment?: string; navigation?: number; onOpenDocument?: (path: string, fragment?: string) => void };
const normalizeFragment = (fragment: string) => /[\u0000-\u001f\u007f]/.test(fragment) ? null : fragment.normalize("NFC");
function scrollToHeading(root: HTMLDivElement | null, fragment: string) {
  const normalized = normalizeFragment(fragment);
  const heading = Array.from(root?.querySelectorAll<HTMLElement>("[data-document-heading]") ?? []).find(element => element.dataset.documentHeading === normalized);
  if (heading) { heading.scrollIntoView({ block: "start" }); heading.focus({ preventScroll: true }); }
}

/** Relative destinations are workstream-rooted, never filesystem or app URLs. */
function documentDestination(href: string, path: string): { path: string; fragment: string } | null {
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href) || href.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const hash = href.indexOf("#");
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  let decoded: string, fragment: string;
  try {
    decoded = decodeURIComponent(rawPath);
    fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
  } catch { return null; }
  const normalized = normalizeFragment(fragment);
  if (normalized === null || /[\u0000-\u001f\u007f\\%?#:]/.test(decoded) || decoded.startsWith("/")) return null;
  fragment = normalized;
  if (!rawPath) return { path, fragment };
  if (!/\.md$/i.test(decoded)) return null;
  const segments = path.split("/").slice(0, -1);
  if (segments.some(segment => segment === ".." || !segment)) return null;
  for (const segment of decoded.split("/")) {
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.length ? { path: segments.join("/"), fragment } : null;
}

function DocumentCodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [feedback, setFeedback] = useState("");
  return <div className="document-markdown-code">
    <div className="document-markdown-code-toolbar"><button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(code.current?.textContent ?? ""); setFeedback("Copied"); }
      catch { setFeedback("Copy unavailable"); }
    }}>{feedback || "Copy code"}</button><span className="document-markdown-sr-only" role="status">{feedback}</span></div>
    <pre ref={code}>{children}</pre>
  </div>;
}

/** Shared read-only document prose. Raw HTML and image requests are deliberately omitted. */
export function DocumentMarkdown({ text, path, fragment, navigation, onOpenDocument }: DocumentMarkdownProps) {
  const instance = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const root = useRef<HTMLDivElement>(null);
  const headingAnchors = useMemo(() => () => (tree: MarkdownNode) => {
    visitDocumentHeadings(tree, (node, slug) => {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `document-${instance}-${slug}`, "data-document-heading": slug } };
    });
  }, [instance]);
  useEffect(() => { if (fragment) scrollToHeading(root.current, fragment); }, [path, text, fragment, navigation]);
  const components: Components = {
    pre: DocumentCodeBlock,
    table: ({ children }) => <div className="document-markdown-table" role="region" aria-label="Document table" tabIndex={0}><table>{children}</table></div>,
    img: ({ alt }) => <span className="document-markdown-image">[Image: {alt || "image omitted"}]</span>,
    a: ({ children, href, title }) => {
      if (href && /^https?:\/\//i.test(href) && !/[\u0000-\u0020\u007f\\]/.test(href)) {
        try {
          const url = new URL(href);
          if (url.hostname && !url.username && !url.password) return <a href={url.href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
        } catch { /* Invalid URLs stay readable, but are not actionable. */ }
      }
      const destination = href ? documentDestination(href, path) : null;
      if (destination && (destination.path === path || onOpenDocument)) return <a href={destination.path === path ? `#document-${instance}-${encodeURIComponent(destination.fragment)}` : `${destination.path}${destination.fragment ? `#${encodeURIComponent(destination.fragment)}` : ""}`} title={title} onClick={event => {
        event.preventDefault();
        if (destination.path === path) { if (destination.fragment) scrollToHeading(root.current, destination.fragment); else root.current?.scrollIntoView({ block: "start" }); }
        else onOpenDocument?.(destination.path, destination.fragment || undefined);
      }}>{children}</a>;
      return <span className="document-markdown-inactive-link" title={title || "Link unavailable in this read-only document"}>{children}</span>;
    },
  };
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"] as const) {
    const Heading = tag;
    components[tag] = ({ children, node, ...props }) => <Heading {...props} tabIndex={-1}>{children}<a className="document-markdown-heading-anchor" href={`#${props.id}`} aria-label={`Link to ${node ? nodeText(node as MarkdownNode) : "heading"}`} onClick={event => { event.preventDefault(); event.currentTarget.parentElement?.scrollIntoView({ block: "start" }); event.currentTarget.parentElement?.focus({ preventScroll: true }); }}>#</a></Heading>;
  }
  return <div className="document-markdown" ref={root}><ReactMarkdown remarkPlugins={[remarkGfm, headingAnchors]} skipHtml urlTransform={defaultUrlTransform} components={components}>{text}</ReactMarkdown></div>;
}
