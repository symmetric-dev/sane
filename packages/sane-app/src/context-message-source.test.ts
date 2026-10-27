import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureContextMessageSources } from "./context-message-source";
import { contextAsset, contextHash, type ContextPackage } from "./context-package";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-source-")); roots.push(root);
  const asset = contextAsset("framework.core", "synthetic/core", "\uFEFF exact 😀\r\n", "framework"), path = join(root, "core.md");
  writeFileSync(path, asset.text);
  const body = { schema: 1 as const, identity: { kind: "assistant" as const, role: "engineering" as const }, assets: [asset], initial: [] };
  const bundle: ContextPackage = { ...body, revision: contextHash(JSON.stringify(body)) };
  return { root, path, asset, context: { bundle, paths: { [asset.id]: path } } };
}
test("a final source fence reads exact original private bytes without changing them", () => {
  const f = fixture(), check = captureContextMessageSources(f.context);
  check(); check();
});
for (const damage of ["missing", "bytes", "replacement", "symlink"] as const) test(`final pinned source check refuses ${damage}`, () => {
  const f = fixture(), check = captureContextMessageSources(f.context);
  if (damage === "missing") unlinkSync(f.path);
  if (damage === "bytes") writeFileSync(f.path, "X".repeat(Buffer.byteLength(f.asset.text)));
  if (damage === "replacement") { const next = join(f.root, "replacement"); copyFileSync(f.path, next); renameSync(next, f.path); }
  if (damage === "symlink") { const next = join(f.root, "target"); renameSync(f.path, next); symlinkSync(next, f.path); }
  expect(check).toThrow();
});
test("a mutable loader result cannot change the expected source bytes after capture", () => {
  const f = fixture(), check = captureContextMessageSources(f.context);
  f.asset.text = "different content"; writeFileSync(f.path, f.asset.text);
  expect(check).toThrow();
});
test("missing private paths and initially mismatched bytes cannot create a source fence", () => {
  const f = fixture();
  expect(() => captureContextMessageSources({ ...f.context, paths: {} })).toThrow("private path");
  writeFileSync(f.path, "wrong");
  expect(() => captureContextMessageSources(f.context)).toThrow();
});
