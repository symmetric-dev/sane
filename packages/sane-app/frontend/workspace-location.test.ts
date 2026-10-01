import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { searchSelection } from "./workspace-location";

test("saved UTF16 coordinates validate against local content without replacing edits", () => {
  const location = { path: "notes.md", line: 2, column: 4, endColumn: 9, preview: "😀 hello world", query: "hello" };
  const state = EditorState.create({ doc: "unsaved first line\n😀 hello world" });
  const range = searchSelection(state, location)!;
  expect(state.sliceDoc(range.anchor, range.head)).toBe("hello");
  expect(searchSelection(EditorState.create({ doc: "unsaved first line\nlocal 😀 hello world" }), location)).toBeNull();
  expect(searchSelection(state, { ...location, line: 3 })).toBeNull();
  expect(searchSelection(state, { ...location, endColumn: 100 })).toBeNull();
  expect(searchSelection(state, { ...location, query: "HELLO" })).not.toBeNull();
  expect(searchSelection(state, { ...location, query: "HELLO", caseSensitive: true })).toBeNull();
  const long = "x".repeat(200) + "hello" + "y".repeat(300);
  expect(searchSelection(EditorState.create({ doc: long }), { ...location, line: 1, column: 201, endColumn: 206, preview: long.slice(140, 380) })).not.toBeNull();
});
