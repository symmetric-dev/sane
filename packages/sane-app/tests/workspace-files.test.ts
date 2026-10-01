import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, realpath, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService, workspaceError } from "../src/workspace";
import { WORKSPACE_MAX_BYTES } from "../src/workspace-contract";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-workspace-files-"))); roots.push(root);
  const cwd = join(root, "checkout"), data = join(root, "data"), outside = join(root, "outside");
  await Promise.all([mkdir(cwd), mkdir(data), mkdir(outside)]);
  let revision = "binding-v1";
  const service = new WorkspaceService(id => id === "session" ? { cwd, bindingRevision: revision, protectedPaths: [join(cwd, "admin")] } : undefined, data);
  const { workspaceId } = await service.resolve("session");
  return { service, workspaceId, cwd, data, outside, changeBinding: () => { revision = "binding-v2"; } };
}

test("create opens an empty editable file; write/copy/delete preserve expected contents", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, "docs"));
  const created = await f.service.create("session", { workspaceId: f.workspaceId, path: "docs/new.md" });
  expect(created).toMatchObject({ text: "", bytes: 0, editable: true, path: "docs/new.md" });
  const saved = await f.service.write("session", { workspaceId: f.workspaceId, path: created.path, expectedRevision: created.revision!, text: "# Hello\n" });
  const copy = await f.service.copy("session", { workspaceId: f.workspaceId, path: saved.path, expectedRevision: saved.revision!, destination: "copy.md" });
  expect(copy.text).toBe("# Hello\n"); expect(copy.revision).toBe(saved.revision);
  expect((await f.service.list("session", f.workspaceId, "")).entries.map(entry => entry.name)).toEqual(["docs", "copy.md"]);
  await f.service.delete("session", { workspaceId: f.workspaceId, path: "copy.md", expectedRevision: copy.revision! });
  await expect(readFile(join(f.cwd, "copy.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.cwd, saved.path), "utf8")).toBe("# Hello\n");
});

test("copy preserves raw BOM, CRLF, executable mode, and binary bytes", async () => {
  const f = await fixture();
  for (const [name, bytes] of [["script.md", Buffer.from("\uFEFFone\r\ntwo\r\n")], ["image.bin", Buffer.from([0, 1, 2, 255])]] as const) {
    await writeFile(join(f.cwd, name), bytes); await chmod(join(f.cwd, name), 0o755);
    const file = await f.service.file("session", f.workspaceId, name);
    await f.service.copy("session", { workspaceId: f.workspaceId, path: name, expectedRevision: file.revision!, destination: `copy-${name}` });
    expect(await readFile(join(f.cwd, `copy-${name}`))).toEqual(bytes);
    expect((await stat(join(f.cwd, `copy-${name}`))).mode & 0o111).toBe(0o111);
  }
});

test("same-folder rename preserves saved bytes, revision, inode and executable permissions", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, "docs"));
  const bytes = Buffer.from("\uFEFFone\r\ntwo\r\n");
  await writeFile(join(f.cwd, "docs/before.md"), bytes); await chmod(join(f.cwd, "docs/before.md"), 0o755);
  const original = await stat(join(f.cwd, "docs/before.md"));
  const file = await f.service.file("session", f.workspaceId, "docs/before.md");
  const renamed = await f.service.rename("session", { workspaceId: f.workspaceId, path: file.path, expectedRevision: file.revision!, destination: "docs/after.md" });
  expect(renamed).toMatchObject({ path: "docs/after.md", revision: file.revision, text: file.text, bom: true, eol: "crlf" });
  expect(await readFile(join(f.cwd, renamed.path))).toEqual(bytes);
  const moved = await stat(join(f.cwd, renamed.path));
  expect(moved.ino).toBe(original.ino); expect(moved.mode & 0o777).toBe(0o755);
  await expect(readFile(join(f.cwd, file.path))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rename refuses existing destinations and cross-folder moves without changing either file", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, "docs"));
  await writeFile(join(f.cwd, "source.md"), "source"); await writeFile(join(f.cwd, "existing.md"), "keep");
  const file = await f.service.file("session", f.workspaceId, "source.md");
  const input = { workspaceId: f.workspaceId, path: file.path, expectedRevision: file.revision! };
  await expect(f.service.rename("session", { ...input, destination: "existing.md" })).rejects.toMatchObject({ code: "path-exists" });
  await expect(f.service.rename("session", { ...input, destination: file.path })).rejects.toMatchObject({ code: "path-exists" });
  await expect(f.service.rename("session", { ...input, destination: "docs/source.md" })).rejects.toMatchObject({ code: "invalid-rename" });
  expect(await readFile(join(f.cwd, file.path), "utf8")).toBe("source");
  expect(await readFile(join(f.cwd, "existing.md"), "utf8")).toBe("keep");
  await expect(readFile(join(f.cwd, "docs/source.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("create/copy refuse existing destinations and missing folders without overwriting", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "existing.md"), "keep");
  const file = await f.service.file("session", f.workspaceId, "existing.md");
  await expect(f.service.create("session", { workspaceId: f.workspaceId, path: "existing.md" })).rejects.toMatchObject({ code: "EEXIST" });
  await expect(f.service.copy("session", { workspaceId: f.workspaceId, path: file.path, expectedRevision: file.revision!, destination: file.path })).rejects.toMatchObject({ code: "EEXIST" });
  await expect(f.service.create("session", { workspaceId: f.workspaceId, path: "missing/new.md" })).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.cwd, file.path), "utf8")).toBe("keep");
  expect(workspaceError({ code: "EEXIST" })).toMatchObject({ status: 409, code: "path-exists" });
});

test("copy/delete/rename reject changed disk revisions and stale workspace bindings", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "file.md"), "before");
  const file = await f.service.file("session", f.workspaceId, "file.md");
  const input = { workspaceId: f.workspaceId, path: file.path, expectedRevision: file.revision! };
  await writeFile(join(f.cwd, file.path), "after");
  await expect(f.service.copy("session", { ...input, destination: "copy.md" })).rejects.toMatchObject({ code: "revision-conflict" });
  await expect(f.service.delete("session", input)).rejects.toMatchObject({ code: "revision-conflict" });
  await expect(f.service.rename("session", { ...input, destination: "renamed.md" })).rejects.toMatchObject({ code: "revision-conflict" });
  await expect(readFile(join(f.cwd, "renamed.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.cwd, file.path), "utf8")).toBe("after");
  f.changeBinding();
  await expect(f.service.create("session", { workspaceId: f.workspaceId, path: "new.md" })).rejects.toMatchObject({ code: "workspace-changed" });
  await expect(f.service.delete("session", input)).rejects.toMatchObject({ code: "workspace-changed" });
  await expect(f.service.rename("session", { ...input, destination: "renamed.md" })).rejects.toMatchObject({ code: "workspace-changed" });
});

test("all mutations reject traversal, protected paths, symlinks, hardlinks, and directories", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "file.md"), "safe");
  const file = await f.service.file("session", f.workspaceId, "file.md");
  await symlink(f.outside, join(f.cwd, "escape"));
  for (const path of ["../outside/new.md", "/new.md", ".git/config", ".sane/config", "admin/new.md", "escape/new.md", "", "docs/../new.md"]) {
    await expect(f.service.create("session", { workspaceId: f.workspaceId, path })).rejects.toBeDefined();
    await expect(f.service.copy("session", { workspaceId: f.workspaceId, path: file.path, expectedRevision: file.revision!, destination: path })).rejects.toBeDefined();
    await expect(f.service.delete("session", { workspaceId: f.workspaceId, path, expectedRevision: file.revision! })).rejects.toBeDefined();
  }
  await link(join(f.cwd, file.path), join(f.cwd, "hard.md"));
  await expect(f.service.copy("session", { workspaceId: f.workspaceId, path: "hard.md", expectedRevision: file.revision!, destination: "copy.md" })).rejects.toMatchObject({ code: "hardlink" });
  await expect(f.service.delete("session", { workspaceId: f.workspaceId, path: "hard.md", expectedRevision: file.revision! })).rejects.toMatchObject({ code: "hardlink" });
  await expect(f.service.rename("session", { workspaceId: f.workspaceId, path: "hard.md", destination: "renamed.md", expectedRevision: file.revision! })).rejects.toMatchObject({ code: "hardlink" });
  await mkdir(join(f.cwd, "folder"));
  await expect(f.service.delete("session", { workspaceId: f.workspaceId, path: "folder", expectedRevision: file.revision! })).rejects.toMatchObject({ code: "not-file" });
  await expect(f.service.rename("session", { workspaceId: f.workspaceId, path: "folder", destination: "renamed-folder", expectedRevision: file.revision! })).rejects.toMatchObject({ code: "not-file" });
});

test("bounded file operations require revisions; concurrent creates never overwrite", async () => {
  const f = await fixture();
  await expect(f.service.delete("session", { workspaceId: f.workspaceId, path: "file.md", expectedRevision: "" })).rejects.toMatchObject({ code: "revision-required" });
  await writeFile(join(f.cwd, "huge.bin"), Buffer.alloc(WORKSPACE_MAX_BYTES + 1));
  const input = { workspaceId: f.workspaceId, path: "huge.bin", expectedRevision: "0".repeat(64) };
  await expect(f.service.copy("session", { ...input, destination: "copy.bin" })).rejects.toMatchObject({ code: "oversize" });
  await expect(f.service.delete("session", input)).rejects.toMatchObject({ code: "oversize" });
  const results = await Promise.allSettled([f.service.create("session", { workspaceId: f.workspaceId, path: "new.md" }), f.service.create("session", { workspaceId: f.workspaceId, path: "new.md" })]);
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
});
