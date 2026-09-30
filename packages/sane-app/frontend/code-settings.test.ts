import { expect, test } from "bun:test";
import { codeSettings, parseWrapExtensions, shouldWrap } from "./code-settings";
import { createBufferState, wrapping, wrappingExtension } from "./workspace-editor";
import { EditorView } from "@codemirror/view";

test("Markdown wraps by default; other extensions do not", () => {
  expect(codeSettings.snapshot()).toEqual([".md"]);
  expect(shouldWrap("docs/README.MD", codeSettings.snapshot())).toBe(true);
  expect(shouldWrap("src/main.ts", codeSettings.snapshot())).toBe(false);
  expect(shouldWrap("docs.md/README", codeSettings.snapshot())).toBe(false);
  expect(wrapping.get(createBufferState("notes.md", "long line", () => {}, () => {}))).toBe(EditorView.lineWrapping);
});

test("extension list normalizes, deduplicates, accepts empty, and rejects paths", () => {
  expect(parseWrapExtensions("md, .TXT\n.MD json")).toEqual([".md", ".txt", ".json"]);
  expect(parseWrapExtensions(" , \n")).toEqual([]);
  for (const input of ["*.md", "docs/.md", ".", "md;txt", "..md"]) expect(() => parseWrapExtensions(input)).toThrow();
  expect(shouldWrap("notes.md", [])).toBe(false);
});

test("preference changes preserve open buffers, text, selection, and undo history", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: (key: string, value: string) => values.set(key, value) } });
  const { rootState, resetWorkspaceState } = await import("./workspace-store");
  const { undo } = await import("@codemirror/commands");
  try {
    const root = rootState({ sessionId: "fixture", root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    let state = createBufferState("notes.md", "before", () => {}, () => {});
    state = state.update({ changes: { from: 0, to: 6, insert: "after" }, selection: { anchor: 3 } }).state;
    const buffer = { path: "notes.md", state, view: null } as import("./workspace-store").Buffer;
    root.buffers.set(buffer.path, buffer);
    codeSettings.setWrapExtensions(".txt");
    expect(buffer.state.doc.toString()).toBe("after");
    expect(buffer.state.selection.main.anchor).toBe(3);
    expect(wrapping.get(buffer.state)).not.toBe(EditorView.lineWrapping);
    expect(wrappingExtension("new.txt")).toBe(EditorView.lineWrapping);
    expect(values.get("sane.code.wrapExtensions")).toBe('[".txt"]');
    undo({ state: buffer.state, dispatch: transaction => { buffer.state = transaction.state; } });
    expect(buffer.state.doc.toString()).toBe("before");
    codeSettings.setWrapExtensions(""); expect(codeSettings.snapshot()).toEqual([]);
  } finally {
    codeSettings.setWrapExtensions(".md"); resetWorkspaceState();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
