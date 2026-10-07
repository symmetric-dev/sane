import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export type MarkdownNode = { type: string; value?: string; depth?: number; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } };
export type DocumentHeading = { text: string; level: number; fragment: string; children: DocumentHeading[] };
export const nodeText = (node: MarkdownNode): string => node.value ?? node.children?.map(nodeText).join("") ?? "";
const headingSlug = (text: string) => text.normalize("NFC").toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";

/** Both rendering and navigation reserve slugs for every heading, including H5/H6. */
export function visitDocumentHeadings(tree: MarkdownNode, heading: (node: MarkdownNode, fragment: string) => void) {
  const used = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "heading") {
      const base = headingSlug(nodeText(node));
      let fragment = base, suffix = 0;
      while (used.has(fragment)) fragment = `${base}-${++suffix}`;
      used.add(fragment);
      heading(node, fragment);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
}

const parser = unified().use(remarkParse).use(remarkGfm);
export function documentOutline(text: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [], parents: DocumentHeading[] = [];
  visitDocumentHeadings(parser.parse(text), (node, fragment) => {
    const level = node.depth ?? 1;
    if (level > 4) return;
    const heading: DocumentHeading = { text: nodeText(node), level, fragment, children: [] };
    while (parents.length && parents[parents.length - 1].level >= level) parents.pop();
    (parents.length ? parents[parents.length - 1].children : headings).push(heading);
    parents.push(heading);
  });
  return headings;
}
