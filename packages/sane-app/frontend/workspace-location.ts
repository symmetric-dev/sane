import type { EditorState } from "@codemirror/state";
import type { WorkspaceSearchMatch } from "../src/workspace-contract";

export type WorkspaceLocation = WorkspaceSearchMatch & { query: string; caseSensitive?: boolean; wholeWord?: boolean };
/** Saved coordinates are never trusted against a changed local document. */
export function searchSelection(state: EditorState, location: WorkspaceLocation) {
  if (!Number.isInteger(location.line) || location.line < 1 || location.line > state.doc.lines) return null;
  const line = state.doc.line(location.line), from = location.column - 1, to = location.endColumn - 1;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > line.length) return null;
  // Previews may be excerpts of long lines. Require their unchanged neighborhood
  // at this coordinate, as well as the literal itself, before trusting the range.
  const previewStart = line.text.indexOf(location.preview, Math.max(0, from - location.preview.length));
  if (!location.preview || previewStart < 0 || previewStart > from || previewStart + location.preview.length <= from) return null;
  const text = line.text.slice(from, to);
  const literal = new RegExp(`^(?:${location.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`, location.caseSensitive ? "u" : "iu");
  if (!literal.test(text)) return null;
  if (location.wholeWord && (/[\p{L}\p{N}\p{M}_]$/u.test(line.text.slice(Math.max(0, from - 2), from)) || /^[\p{L}\p{N}\p{M}_]/u.test(line.text.slice(to, to + 2)))) return null;
  return { anchor: line.from + from, head: line.from + to };
}
