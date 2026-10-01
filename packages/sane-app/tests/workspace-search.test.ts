import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, symlink, link, realpath, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService, type WorkspaceOperationOptions } from "../src/workspace";
import { CatalogService } from "../src/catalog";
import { WORKSPACE_MAX_BYTES, type WorkspaceSearchInput } from "../src/workspace-contract";
import { WORKSPACE_SEARCH_LIMITS as LIMITS } from "../src/workspace-search";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(git = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-workspace-search-"))); roots.push(root);
  const cwd = join(root, "checkout"), data = join(cwd, "app-data"), outside = join(root, "outside");
  await mkdir(data, { recursive: true }); await mkdir(outside);
  let revision = "binding-v1", calls = 0, hook: ((count: number) => void) | undefined;
  const service = new WorkspaceService(id => {
    hook?.(++calls);
    return id === "session" ? { cwd, bindingRevision: revision, protectedPaths: [join(cwd, "admin")] } : undefined;
  }, data);
  if (git) {
    const init = Bun.spawnSync(["git", "init", "-q", cwd]);
    if (init.exitCode) throw new Error(init.stderr.toString());
  }
  const { workspaceId } = await service.resolve("session");
  return {
    service, workspaceId, cwd, data, outside,
    search: (query: string, options: Partial<WorkspaceSearchInput> = {}, signal?: AbortSignal) => service.search("session", { workspaceId, query, ...options }, signal),
    changeBinding: () => { revision = "binding-v2"; },
    watch: (callback: (count: number) => void) => { calls = 0; hook = callback; },
  };
}
async function put(cwd: string, path: string, text: string | Buffer = "needle") {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent) await mkdir(join(cwd, parent), { recursive: true });
  await writeFile(join(cwd, path), text);
}

test("saved-content search normalizes BOM and EOL and returns every literal occurrence with UTF-16 columns", async () => {
  const f = await fixture();
  await put(f.cwd, "a.txt", "\uFEFF😀 Needle needle\r\nsecond needle\rlast\n");
  const result = await f.search("needle");
  expect(result).toMatchObject({ workspaceId: f.workspaceId, truncated: false, scannedFiles: 1, skippedFiles: 0 });
  expect(result.matches).toEqual([
    { path: "a.txt", line: 1, column: 4, endColumn: 10, preview: "😀 Needle needle" },
    { path: "a.txt", line: 1, column: 11, endColumn: 17, preview: "😀 Needle needle" },
    { path: "a.txt", line: 2, column: 8, endColumn: 14, preview: "second needle" },
  ]);
  expect((await f.search("needle", { caseSensitive: true })).matches).toHaveLength(2);
  await put(f.cwd, "literal.txt", "a.b aXb [a]+ $^.*");
  expect((await f.search("a.b")).matches).toHaveLength(1);
  expect((await f.search("[a]+")).matches[0]?.column).toBe(9);
});

test("whole word matching has Unicode-safe boundaries and case-insensitive positions", async () => {
  const f = await fixture();
  await put(f.cwd, "words.txt", "needle needles _needle needle_ éneedle needleé 𐐀needle needle𐐀 needle\nİ i ı I K k");
  const whole = await f.search("needle", { wholeWord: true });
  expect(whole.matches.map(match => match.column)).toEqual([1, 66]);
  expect((await f.search("k")).matches.filter(match => match.line === 2).map(match => match.column)).toEqual([9, 11]);
  expect((await f.search("i")).matches.filter(match => match.line === 2).map(match => match.column)).toEqual([3, 7]);
});

test("workspace-relative comma globs include nested basenames, globstars, root paths and directory exclusions", async () => {
  const f = await fixture();
  for (const path of ["root.ts", "root.txt", "src/a.ts", "src/deep/b.ts", "src/deep/no.txt", "other/a.ts", "other/note.md"]) await put(f.cwd, path);
  const paths = async (options: Partial<WorkspaceSearchInput>) => (await f.search("needle", options)).matches.map(match => match.path).sort();
  expect(await paths({ include: "*.ts" })).toEqual(["other/a.ts", "root.ts", "src/a.ts", "src/deep/b.ts"]);
  expect(await paths({ include: "src/**/*.ts, *.md", exclude: "src/deep/" })).toEqual(["other/note.md", "src/a.ts"]);
  expect(await paths({ include: "src/?.ts" })).toEqual(["src/a.ts"]);
  expect(await paths({ include: "src/" })).toEqual(["src/a.ts", "src/deep/b.ts", "src/deep/no.txt"]);
  expect(await paths({ exclude: "**/deep/**" })).not.toContain("src/deep/b.ts");
  expect(await paths({ include: "*.TS" })).toEqual([]);
  await put(f.cwd, "😀.txt");
  expect(await paths({ include: "😀.txt" })).toEqual(["😀.txt"]);
  await put(f.cwd, "docs");
  expect(await paths({ include: "docs/" })).toEqual([]);
  expect(await paths({ include: "docs", exclude: "docs/" })).toEqual(["docs"]);
});

test("guarded .gitignore snapshots honor nested rules and negation without any Git process", async () => {
  const f = await fixture(true);
  await put(f.cwd, ".gitignore", "*.log\nignored/\n!keep.log\n");
  await put(f.cwd, "src/.gitignore", "secret.txt\n");
  for (const path of ["drop.log", "keep.log", "ignored/file.txt", "src/secret.txt", "src/keep.txt", "-dash.txt", "new\nline.txt"]) await put(f.cwd, path);
  await put(f.cwd, "admin/private.txt");
  await symlink(f.outside, join(f.cwd, "escape"));
  await put(f.outside, "external-ignore", "keep.log\n");
  expect(Bun.spawnSync(["git", "-C", f.cwd, "config", "core.excludesFile", join(f.outside, "external-ignore")]).exitCode).toBe(0);
  f.service.git = async () => { throw new Error("Search must not invoke Git"); };
  const result = await f.search("needle");
  expect(result.matches.map(match => match.path).sort()).toEqual(["-dash.txt", "keep.log", "new\nline.txt", "src/keep.txt"]);
  expect(result.truncated).toBe(false);
});

test("non-Git workspaces search normally; generated and dependency folders stay excluded even when included", async () => {
  const f = await fixture();
  for (const directory of ["node_modules", "dist", "build", "coverage", "vendor", "src/node_modules"]) await put(f.cwd, `${directory}/file.txt`);
  await put(f.cwd, "visible.txt");
  await put(f.cwd, ".gitignore", "visible.txt\n");
  const result = await f.search("needle", { include: "**" });
  expect(result.matches.map(match => match.path)).toEqual([]);
  expect(result.truncated).toBe(false);
});

test("search never reads forbidden case-insensitive directories, protected data, symlinks, hardlinks or special files", async () => {
  const f = await fixture();
  for (const path of [".GiT/private.txt", ".SaNe/private.txt", "nested/.SANE/private.txt", "admin/private.txt", "app-data/private.txt", "visible.txt"]) await put(f.cwd, path);
  await put(f.outside, "outside.txt");
  await symlink(join(f.outside, "outside.txt"), join(f.cwd, "linked.txt"));
  await symlink(f.outside, join(f.cwd, "escape"));
  await link(join(f.outside, "outside.txt"), join(f.cwd, "hard.txt"));
  const fifo = Bun.spawnSync(["mkfifo", join(f.cwd, "fifo")]); expect(fifo.exitCode).toBe(0);
  const result = await f.search("needle");
  expect(result.matches.map(match => match.path)).toEqual(["visible.txt"]);
  expect(result.scannedFiles).toBe(1);
  expect(result.skippedFiles).toBeGreaterThanOrEqual(4);
  expect(result.truncated).toBe(false);
});

test("search skips oversized, binary and invalid UTF-8 but searches mixed-EOL and read-only saved files", async () => {
  const f = await fixture();
  await put(f.cwd, "large.txt", Buffer.alloc(WORKSPACE_MAX_BYTES + 1, 110));
  await put(f.cwd, "binary.txt", Buffer.from("needle\0needle"));
  await put(f.cwd, "invalid.txt", Buffer.from([255, 110, 101, 101, 100, 108, 101]));
  await put(f.cwd, "mixed.txt", "needle\r\nneedle\nneedle\rneedle");
  await put(f.cwd, "readonly.txt"); await chmod(join(f.cwd, "readonly.txt"), 0o444);
  const result = await f.search("needle");
  expect(result.matches).toHaveLength(5);
  expect(result.matches.filter(match => match.path === "mixed.txt").map(match => match.line)).toEqual([1, 2, 3, 4]);
  expect(result).toMatchObject({ scannedFiles: 2, skippedFiles: 3, truncated: false });
});

test("query, option and glob validation is bounded and rejects unsafe paths rather than treating input as regex", async () => {
  const f = await fixture();
  for (const query of ["", "x".repeat(LIMITS.query + 1), "a\nb", "a\rb", "a\0b", "\uD800"]) await expect(f.search(query)).rejects.toMatchObject({ status: 400, code: "invalid-search" });
  await expect(f.search("needle", { caseSensitive: "yes" as any })).rejects.toMatchObject({ code: "invalid-search" });
  for (const include of ["../outside/*", "/outside/*", "docs/../*", "docs\\*", "**x", "[a]", "{a,b}", "!a", "a,,b", "x".repeat(4097), Array(33).fill("a").join(",")]) await expect(f.search("needle", { include })).rejects.toMatchObject({ status: 400, code: "invalid-search-filter" });
});

test("stale binding fails at start, mid-scan and at the final fence, including an empty search", async () => {
  const start = await fixture(); start.changeBinding();
  await expect(start.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  const mid = await fixture(); await put(mid.cwd, "visible.txt");
  mid.watch(count => { if (count === 5) mid.changeBinding(); });
  await expect(mid.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  const end = await fixture(); let total = 0;
  end.watch(count => { total = count; }); await end.search("needle");
  const final = total;
  end.watch(count => { if (count === final) end.changeBinding(); });
  await expect(end.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
});

test("cancellation rejects before and during filesystem discovery without returning partial results", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  const before = new AbortController(); before.abort();
  await expect(f.search("needle", {}, before.signal)).rejects.toMatchObject({ status: 499, code: "search-aborted" });
  const during = new AbortController();
  f.watch(count => { if (count === 5) during.abort(); });
  await expect(f.search("needle", {}, during.signal)).rejects.toMatchObject({ code: "search-aborted" });
});

test("Git subprocesses are killed promptly on cancellation and honor the search deadline", async () => {
  const f = await fixture(true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  const start = Date.now();
  try { await expect(f.service.git(f.cwd, ["-c", "alias.pause=!sleep 10", "pause"], 1024, { signal: controller.signal })).rejects.toMatchObject({ code: "search-aborted" }); }
  finally { clearTimeout(timer); }
  expect(Date.now() - start).toBeLessThan(1500);
  await expect(f.service.git(f.cwd, ["-c", "alias.pause=!sleep 10", "pause"], 1024, { timeoutMs: 30 })).rejects.toMatchObject({ code: "git-timeout" });
});

test("hardlinked/symlinked .gitignore and symlinked info/exclude never become a protected-content membership oracle", async () => {
  for (const source of ["data", "protected", "symlink"] as const) {
    const f = await fixture(true); await put(f.cwd, "visible.txt");
    const secret = source === "protected" ? join(f.cwd, "admin/secret") : join(f.data, "secret");
    if (source === "protected") await mkdir(join(f.cwd, "admin"));
    await writeFile(secret, "visible.txt\n");
    if (source === "symlink") await symlink(secret, join(f.cwd, ".gitignore"));
    else await link(secret, join(f.cwd, ".gitignore"));
    await rm(join(f.cwd, ".git/info/exclude"));
    await symlink(secret, join(f.cwd, ".git/info/exclude"));
    f.service.git = async () => { throw new Error("No implicit Git reads allowed"); };
    const first = await f.search("needle");
    expect(first.matches.map(match => match.path)).toEqual(["visible.txt"]);
    await writeFile(secret, "other.txt\n");
    expect(await f.search("needle")).toEqual(first);
  }
});

test("oversized and invalid ignore files are not parsed, and aggregate ignore-rule parsing is bounded", async () => {
  const f = await fixture(true); await put(f.cwd, "visible.txt");
  await put(f.cwd, ".gitignore", "visible.txt\n" + "# x\n".repeat(WORKSPACE_MAX_BYTES / 4));
  expect((await f.search("needle")).matches.map(match => match.path)).toEqual(["visible.txt"]);
  await put(f.cwd, ".gitignore", Buffer.from("visible.txt\n\0"));
  expect((await f.search("needle")).matches.map(match => match.path)).toEqual(["visible.txt"]);
  await put(f.cwd, ".gitignore", Array.from({ length: LIMITS.ignoreRules + 1 }, (_, i) => `ignored-${i}`).join("\n"));
  expect(await f.search("needle")).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
});

test("Gitignore parser supports directory re-inclusion, escaped literals, anchored patterns and nested overrides", async () => {
  const f = await fixture(true);
  await put(f.cwd, ".gitignore", "/root.txt\n*.log\n!keep.log\nfolder/*\n!folder/open/\n\\#hash\n\\!bang\nspace\\ \nrange[0-9].txt\n**/generated/**\n");
  await put(f.cwd, "folder/open/.gitignore", "*.log\n!nested.log\n");
  for (const path of ["root.txt", "src/root.txt", "drop.log", "keep.log", "folder/closed.txt", "folder/open/nested.log", "folder/open/drop.log", "#hash", "!bang", "space ", "range7.txt", "src/generated/a.txt", "good.txt"]) await put(f.cwd, path);
  expect((await f.search("needle")).matches.map(match => match.path).sort()).toEqual(["folder/open/nested.log", "good.txt", "keep.log", "src/root.txt"]);
});

test("uncooperative initial and final binding lookups are cancellable and receive the same deadline", async () => {
  const f = await fixture();
  let calls = 0, stallAt = 0, abortOnStall: AbortController | undefined;
  const controls: WorkspaceOperationOptions[] = [];
  const service = new WorkspaceService(async (_id, operation) => {
    calls++;
    if (operation) controls.push(operation);
    if (calls === stallAt) { abortOnStall?.abort(); await new Promise(() => {}); }
    return { cwd: f.cwd, bindingRevision: f.workspaceId };
  }, f.data);
  const input = { workspaceId: f.workspaceId, query: "needle" };
  const initial = new AbortController(); stallAt = 1;
  const timer = setTimeout(() => initial.abort(), 50), start = Date.now();
  try { await expect(service.search("session", input, initial.signal)).rejects.toMatchObject({ code: "search-aborted", status: 499 }); }
  finally { clearTimeout(timer); }
  expect(Date.now() - start).toBeLessThan(1000);
  calls = 0; stallAt = 0; controls.length = 0;
  await service.search("session", input);
  const final = calls;
  expect(new Set(controls.map(control => control.deadline)).size).toBe(1);
  expect(controls).toHaveLength(calls);
  calls = 0; stallAt = final; abortOnStall = new AbortController();
  await expect(service.search("session", input, abortOnStall.signal)).rejects.toMatchObject({ code: "search-aborted", status: 499 });
});

test("a blocked final fence fails closed within the total deadline instead of returning partial matches", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  let calls = 0, stallAt = 0;
  const service = new WorkspaceService(async () => {
    if (++calls === stallAt) await new Promise(() => {});
    return { cwd: f.cwd, bindingRevision: f.workspaceId };
  }, f.data);
  const input = { workspaceId: f.workspaceId, query: "needle" };
  expect((await service.search("session", input)).matches).toHaveLength(1);
  stallAt = calls; calls = 0;
  const start = Date.now();
  await expect(service.search("session", input)).rejects.toMatchObject({ status: 504, code: "search-time-limit" });
  expect(Date.now() - start).toBeLessThan(LIMITS.milliseconds + 750);
}, 10000);

test("production CatalogService lookup cancels blocked Git config includes at both initial and final search fences", async () => {
  const f = await fixture(true); await put(f.cwd, "visible.txt");
  const catalog = new CatalogService(f.data, () => []);
  const registered = await catalog.register(f.cwd);
  const config = join(f.cwd, ".git/config"), original = await readFile(config);
  const fifo = join(f.outside, "blocked-config");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  let calls = 0, blockAt = 0, controller = new AbortController();
  const service = new WorkspaceService(async (_id, operation) => {
    if (++calls === blockAt) {
      await appendFile(config, `\n[include]\n\tpath = ${fifo}\n`);
      setTimeout(() => controller.abort(), 50);
    }
    return catalog.binding(registered.workspaceId, registered.worktreeId, operation);
  }, f.data);
  const { workspaceId } = await service.resolve("session");
  const input = { workspaceId, query: "needle" };
  calls = 0; await service.search("session", input);
  const final = calls;
  for (const fence of [1, final]) {
    await writeFile(config, original); calls = 0; blockAt = fence; controller = new AbortController();
    const start = Date.now();
    await expect(service.search("session", input, controller.signal)).rejects.toMatchObject({ code: "search-aborted", status: 499 });
    expect(Date.now() - start).toBeLessThan(1000);
    await writeFile(config, original);
    expect(await catalog.binding(registered.workspaceId, registered.worktreeId)).toMatchObject({ cwd: f.cwd, bindingRevision: workspaceId });
  }
  // A shorter explicit catalog deadline also kills its blocked subprocess, not
  // only the WorkspaceService waiter, and must not invalidate the pinned tree.
  await appendFile(config, `\n[include]\n\tpath = ${fifo}\n`);
  const start = Date.now();
  await expect(catalog.binding(registered.workspaceId, registered.worktreeId, { deadline: start + 50 })).rejects.toMatchObject({ status: 504 });
  expect(Date.now() - start).toBeLessThan(1000);
  await writeFile(config, original);
  expect((await catalog.get(registered.workspaceId)).worktrees[0]?.state).toBe("available");
}, 15000);

test("result and preview limits report truncation and do not expose huge lines", async () => {
  const f = await fixture();
  await put(f.cwd, "many.txt", "needle ".repeat(LIMITS.matches + 1));
  const result = await f.search("needle");
  expect(result.matches).toHaveLength(LIMITS.matches);
  expect(result.truncated).toBe(true);
  expect(result.matches.every(match => match.preview.length <= LIMITS.preview)).toBe(true);
  await put(f.cwd, "many.txt", "😀".repeat(100) + "needle" + "😀".repeat(100));
  const unicode = await f.search("needle");
  expect(unicode.matches[0]).toMatchObject({ column: 201, endColumn: 207 });
  expect(unicode.matches[0]!.preview).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
});

test("the serialized output budget accounts for escaped previews", async () => {
  const f = await fixture();
  await put(f.cwd, "controls.txt", ("\u0001".repeat(70) + "needle" + "\u0001".repeat(170) + "\n").repeat(1000));
  const result = await f.search("needle");
  expect(result.truncated).toBe(true);
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches.length).toBeLessThan(LIMITS.matches);
  expect(Buffer.byteLength(JSON.stringify(result.matches))).toBeLessThanOrEqual(LIMITS.outputBytes + 2);
});

test("total file bytes and discovery depth are bounded even without matches", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 65 }, (_, i) => put(f.cwd, `${i}.txt`, Buffer.alloc(WORKSPACE_MAX_BYTES, 120))));
  const result = await f.search("needle");
  expect(result.matches).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.scannedFiles).toBe(64);
  const deep = await fixture();
  await put(deep.cwd, `${Array(LIMITS.depth + 2).fill("nested").join("/")}/hidden.txt`);
  expect(await deep.search("needle")).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
});

test("file and discovery-entry budgets cap metadata truthfully", async () => {
  const f = await fixture();
  for (let i = 0; i < LIMITS.files + 1; i += 32) await Promise.all(Array.from({ length: Math.min(32, LIMITS.files + 1 - i) }, (_, j) => put(f.cwd, `${i + j}.txt`, "")));
  const files = await f.search("needle");
  expect(files).toMatchObject({ matches: [], truncated: true, scannedFiles: LIMITS.files, skippedFiles: 0 });
  // Reuse the discovered files, adding excluded entries so no guarded reads
  // can hit the file/byte budgets before the discovery budget.
  for (let i = LIMITS.files + 1; i < LIMITS.entries + 1; i += 64) await Promise.all(Array.from({ length: Math.min(64, LIMITS.entries + 1 - i) }, (_, j) => put(f.cwd, `${i + j}.txt`, "")));
  const entries = await f.search("needle", { exclude: "*.txt" });
  expect(entries).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
  expect(entries.skippedFiles).toBeLessThanOrEqual(LIMITS.entries);
  expect(entries.skippedFiles).toBeGreaterThanOrEqual(LIMITS.entries - 1);
}, 20000);
