import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, symlink, link, realpath, chmod, rename, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceError, WorkspaceService, type WorkspaceOperationOptions } from "../src/workspace";
import { WorkspaceIgnoreEvaluator, WorkspaceIgnoreError } from "../src/workspace-ignore";
import type { WorkspaceSearchLeaseProvider } from "../src/workspace-search-scope";
import { CatalogService } from "../src/catalog";
import { WORKSPACE_MAX_BYTES, type WorkspaceSearchInput } from "../src/workspace-contract";
import { WORKSPACE_SEARCH_LIMITS as LIMITS } from "../src/workspace-search";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(git = false, optimized = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-workspace-search-"))); roots.push(root);
  const cwd = join(root, "checkout"), data = join(cwd, "app-data"), outside = join(root, "outside");
  await mkdir(data, { recursive: true }); await mkdir(outside);
  let revision = "binding-v1", lookups = 0, acquisitions = 0, validations = 0, disposals = 0;
  const protectedPaths = [join(cwd, "admin")];
  const binding = () => ({ cwd, bindingRevision: revision, protectedPaths });
  const provider: WorkspaceSearchLeaseProvider = async id => {
    acquisitions++;
    if (id !== "session") return undefined;
    const pinnedRevision = revision;
    return {
      binding: binding(),
      validate: async () => {
        validations++;
        if (revision !== pinnedRevision) throw new WorkspaceError(409, "workspace-changed", "Binding changed");
      },
      dispose: async () => { disposals++; },
    };
  };
  const service = new WorkspaceService(id => {
    lookups++;
    return id === "session" ? binding() : undefined;
  }, data, optimized ? provider : undefined);
  if (git) {
    const init = Bun.spawnSync(["git", "init", "-q", cwd]);
    if (init.exitCode) throw new Error(init.stderr.toString());
  }
  const { workspaceId } = await service.resolve("session");
  return {
    service, workspaceId, cwd, data, outside, protectedPaths,
    search: (query: string, options: Partial<WorkspaceSearchInput> = {}, signal?: AbortSignal) => service.search("session", { workspaceId, query, ...options }, signal),
    changeBinding: () => { revision = "binding-v2"; },
    measurement: () => ({ lookups, acquisitions, validations, disposals }),
  };
}
/** Private, deterministic phase hooks: assertions target semantic boundaries,
 * not the number/order of catalog calls made by a particular implementation. */
function observeSearch(service: WorkspaceService, hooks: {
  check?: (path: string) => void | Promise<void>;
  beforeRead?: (path: string) => void | Promise<void>;
  afterRead?: (path: string) => void | Promise<void>;
  final?: (operation: WorkspaceOperationOptions) => void | Promise<void>;
}, callerSignal?: AbortSignal) {
  const internal = service as any;
  const check = internal.searchChecked.bind(service), disk = internal.searchDisk.bind(service), bind = internal.bind.bind(service);
  internal.searchChecked = async (...args: any[]) => { await hooks.check?.(args[2]); return check(...args); };
  internal.searchDisk = async (...args: any[]) => {
    await hooks.beforeRead?.(args[1]);
    const result = await disk(...args);
    await hooks.afterRead?.(args[1]);
    return result;
  };
  internal.bind = async (...args: any[]) => {
    const operation = args[2] as WorkspaceOperationOptions | undefined;
    // Worker guards get the search-owned signal; only the full final bind gets
    // the caller's signal, including undefined for an uncancelled request.
    if (operation && operation.signal === callerSignal) await hooks.final?.(operation);
    return bind(...args);
  };
}
async function put(cwd: string, path: string, text: string | Buffer = "needle") {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent) await mkdir(join(cwd, parent), { recursive: true });
  await writeFile(join(cwd, path), text);
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
/** Test-owned startup watchdogs reject into the test's finally, rather than
 * relying on Bun's timeout to unwind a suspended test (which it does not do). */
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
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
  observeSearch(mid.service, { beforeRead: path => { if (path === "visible.txt") mid.changeBinding(); } });
  await expect(mid.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  const end = await fixture();
  observeSearch(end.service, { final: () => end.changeBinding() });
  await expect(end.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
});

test("cancellation rejects before and during filesystem discovery without returning partial results", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  const before = new AbortController(); before.abort();
  await expect(f.search("needle", {}, before.signal)).rejects.toMatchObject({ status: 499, code: "search-aborted" });
  const during = new AbortController();
  observeSearch(f.service, { beforeRead: path => { if (path === "visible.txt") during.abort(); } }, during.signal);
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
  let stall = true, abortOnStall: AbortController | undefined;
  const controls: WorkspaceOperationOptions[] = [];
  const service = new WorkspaceService(async (_id, operation) => {
    if (operation) controls.push(operation);
    if (stall) { abortOnStall?.abort(); await new Promise(() => {}); }
    return { cwd: f.cwd, bindingRevision: f.workspaceId };
  }, f.data);
  const input = { workspaceId: f.workspaceId, query: "needle" };
  const initial = new AbortController();
  const timer = setTimeout(() => initial.abort(), 50), start = Date.now();
  try { await expect(service.search("session", input, initial.signal)).rejects.toMatchObject({ code: "search-aborted", status: 499 }); }
  finally { clearTimeout(timer); }
  expect(Date.now() - start).toBeLessThan(1000);
  stall = false; controls.length = 0;
  await service.search("session", input);
  expect(new Set(controls.map(control => control.deadline)).size).toBe(1);
  expect(controls.length).toBeGreaterThan(1);
  abortOnStall = new AbortController();
  observeSearch(service, { final: () => { stall = true; } }, abortOnStall.signal);
  await expect(service.search("session", input, abortOnStall.signal)).rejects.toMatchObject({ code: "search-aborted", status: 499 });
});

test("a blocked final fence fails closed within the total deadline instead of returning partial matches", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  let stall = false;
  const service = new WorkspaceService(async () => {
    if (stall) await new Promise(() => {});
    return { cwd: f.cwd, bindingRevision: f.workspaceId };
  }, f.data);
  const input = { workspaceId: f.workspaceId, query: "needle" };
  expect((await service.search("session", input)).matches).toHaveLength(1);
  observeSearch(service, { final: () => { stall = true; } });
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
  let block = false, controller = new AbortController();
  const service = new WorkspaceService(async (_id, operation) => {
    if (block) {
      block = false;
      await appendFile(config, `\n[include]\n\tpath = ${fifo}\n`);
      setTimeout(() => controller.abort(), 50);
    }
    return catalog.binding(registered.workspaceId, registered.worktreeId, operation);
  }, f.data);
  const { workspaceId } = await service.resolve("session");
  const input = { workspaceId, query: "needle" };
  await service.search("session", input);
  for (const fence of ["initial", "final"]) {
    await writeFile(config, original); block = fence === "initial"; controller = new AbortController();
    if (fence === "final") observeSearch(service, { final: () => { block = true; } }, controller.signal);
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

test("optimized searches acquire one lease, use cheap guards, and do only the full final lookup", async () => {
  const f = await fixture(false, true);
  for (let i = 0; i < 12; i++) await put(f.cwd, `src/${i}.txt`);
  const before = f.measurement();
  const result = await f.search("needle");
  const after = f.measurement();
  expect(result.matches).toHaveLength(12);
  expect(after.acquisitions - before.acquisitions).toBe(1);
  expect(after.lookups - before.lookups).toBe(1);
  expect(after.validations - before.validations).toBeGreaterThan(12);
  expect(after.disposals - before.disposals).toBe(1);
});

test("undefined lease retains legacy per-path revalidation", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  let lookups = 0, acquisitions = 0, revision = f.workspaceId;
  const service = new WorkspaceService(() => {
    lookups++;
    return { cwd: f.cwd, bindingRevision: revision };
  }, f.data, async () => { acquisitions++; return undefined; });
  expect((await service.search("session", { workspaceId: f.workspaceId, query: "needle" })).matches).toHaveLength(1);
  expect(acquisitions).toBe(1);
  expect(lookups).toBeGreaterThan(2);
  observeSearch(service, { beforeRead: () => { revision = "changed"; } });
  await expect(service.search("session", { workspaceId: f.workspaceId, query: "needle" })).rejects.toMatchObject({ code: "workspace-changed" });
});

test("lease capabilities are search-only; ordinary file reads and writes retain full binding checks", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  const file = await f.service.file("session", f.workspaceId, "visible.txt");
  await f.service.write("session", { workspaceId: f.workspaceId, path: "visible.txt", expectedRevision: file.revision!, text: "saved needle" });
  expect(f.measurement().acquisitions).toBe(0);
  expect(await readFile(join(f.cwd, "visible.txt"), "utf8")).toBe("saved needle");
  f.changeBinding();
  await expect(f.service.file("session", f.workspaceId, "visible.txt")).rejects.toMatchObject({ code: "workspace-changed" });
});

test("root identity changes fail even when an injected lease validator does not detect them", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  observeSearch(f.service, { beforeRead: async () => {
    await rename(f.cwd, join(f.cwd, "..", "checkout-old"));
    await mkdir(f.cwd);
  } });
  await expect(f.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  expect(f.measurement().disposals).toBe(1);
});

test("an optimized stale initial binding fails before discovery and still disposes its lease", async () => {
  const f = await fixture(false, true); f.changeBinding();
  await expect(f.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  expect(f.measurement()).toMatchObject({ acquisitions: 1, validations: 0, disposals: 1 });
});

test("policy changes invalidate empty and truncated searches, even outside all result paths", async () => {
  for (const optimized of [false, true]) {
    for (const truncated of [false, true]) {
      const f = await fixture(false, optimized);
      await put(f.cwd, "visible.txt", truncated ? "needle ".repeat(LIMITS.matches + 1) : "nothing here");
      let finalCalls = 0;
      observeSearch(f.service, { final: () => {
        finalCalls++;
        f.protectedPaths.push(join(f.cwd, "newly-protected-subtree"));
      } });
      await expect(f.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
      expect(finalCalls).toBe(1);
      if (optimized) expect(f.measurement().disposals).toBe(1);
    }
  }
});

test("initial protection is pinned despite in-place mutation of a binding's path array", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  observeSearch(f.service, { beforeRead: () => { f.protectedPaths.push(join(f.cwd, "unsearched")); } });
  await expect(f.search("needle")).rejects.toMatchObject({ status: 409, code: "workspace-changed" });
  expect(f.measurement().disposals).toBe(1);
});

test("optimized read guards still refuse symlinks, shared inodes and protected data", async () => {
  const f = await fixture(false, true);
  await put(f.cwd, "visible.txt"); await put(f.data, "secret.txt"); await put(f.cwd, "admin/secret.txt");
  await symlink(join(f.data, "secret.txt"), join(f.cwd, "linked.txt"));
  await link(join(f.data, "secret.txt"), join(f.cwd, "shared.txt"));
  await link(join(f.cwd, "admin/secret.txt"), join(f.cwd, ".gitignore"));
  expect((await f.search("needle")).matches.map(match => match.path)).toEqual(["visible.txt"]);
});

test("four-slot reads preserve discovery order, use independent matchers and settle before the final fence", async () => {
  const f = await fixture(false, true);
  for (let i = 0; i < 9; i++) await put(f.cwd, `${i}.txt`, `needle ${i} needle`);
  let active = 0, maximum = 0;
  const gate = latch(), started = latch(), controller = new AbortController();
  const discovered: string[] = [];
  observeSearch(f.service, {
    beforeRead: async path => {
      discovered.push(path); active++; maximum = Math.max(maximum, active);
      if (active === 4) { started.release(); gate.release(); }
      await gate.promise;
    },
    afterRead: () => { active--; },
    final: () => { expect(active).toBe(0); },
  }, controller.signal);
  const search = f.search("needle", {}, controller.signal);
  const settled = Promise.allSettled([search]);
  try {
    await bounded(started.promise, "four read workers");
    const result = await bounded(search, "four-slot search completion", 2000);
    expect(maximum).toBe(4);
    expect(result.scannedFiles).toBe(9);
    expect(result.matches.map(match => match.path)).toEqual(discovered.flatMap(path => [path, path]));
    expect(result.matches.map(match => match.column)).toEqual(Array.from({ length: 9 }, () => [1, 10]).flat());
  } finally { controller.abort(); gate.release(); await settled; }
});

test("a file growing after reservation truncates rather than scanning partial text", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt", "needle");
  observeSearch(f.service, { beforeRead: async () => { await appendFile(join(f.cwd, "visible.txt"), " more needle"); } });
  expect(await f.search("needle")).toMatchObject({ matches: [], scannedFiles: 0, truncated: true });
});

test("process-wide admission spans services and holds slots through cancelled workers and lease disposal", async () => {
  const first = await fixture(false, true), second = await fixture(false, true), third = await fixture(false, true);
  for (const f of [first, second, third]) await put(f.cwd, "visible.txt");
  const readGate = latch(), readStarted = latch(), disposeGate = latch(), disposeStarted = latch();
  const firstController = new AbortController(), secondController = new AbortController();
  let disposed = 0;
  const binding = { cwd: second.cwd, bindingRevision: second.workspaceId, protectedPaths: second.protectedPaths };
  const secondService = new WorkspaceService(() => binding, second.data, async () => ({
    binding, validate: async () => {}, dispose: async () => {
      disposeStarted.release(); await disposeGate.promise; disposed++;
    },
  }));
  observeSearch(first.service, { beforeRead: async path => {
    if (path === "visible.txt") { readStarted.release(); await readGate.promise; }
  } }, firstController.signal);
  // Bun's .rejects matcher can eagerly wait/pump the runner. Never construct
  // one for a deliberately gated request: register plain settlement handlers
  // immediately, then assert on the settled records AFTER releasing resources.
  const settled = Promise.allSettled([
    first.search("needle", {}, firstController.signal),
    secondService.search("session", { workspaceId: second.workspaceId, query: "needle" }, secondController.signal),
  ]);
  let outcomes: Awaited<typeof settled> | undefined;
  try {
    await bounded(Promise.all([readStarted.promise, disposeStarted.promise]), "read and lease-disposal gates");
    expect((await Promise.allSettled([third.search("needle")]))[0]).toMatchObject({ status: "rejected", reason: { status: 503, code: "search-busy" } });
    firstController.abort(); secondController.abort();
    expect((await Promise.allSettled([third.search("needle")]))[0]).toMatchObject({ status: "rejected", reason: { status: 503, code: "search-busy" } });
    expect(disposed).toBe(0);
  } finally {
    // Every startup timeout/assertion failure follows the same real cleanup;
    // no admission reset and no gated request survives into the next test.
    firstController.abort(); secondController.abort();
    readGate.release(); disposeGate.release();
    outcomes = await settled;
  }
  for (const outcome of outcomes!) expect(outcome).toMatchObject({ status: "rejected", reason: { status: 499, code: "search-aborted" } });
  expect(disposed).toBe(1);
  expect((await third.search("needle")).matches).toHaveLength(1);
  expect(first.measurement().disposals).toBe(1);
});

test("cancellation during lease disposal still rejects rather than returning completed matches", async () => {
  const f = await fixture(); await put(f.cwd, "visible.txt");
  const controller = new AbortController(), binding = { cwd: f.cwd, bindingRevision: f.workspaceId };
  const service = new WorkspaceService(() => binding, f.data, async () => ({
    binding, validate: async () => {}, dispose: async () => { controller.abort(); },
  }));
  await expect(service.search("session", { workspaceId: f.workspaceId, query: "needle" }, controller.signal)).rejects.toMatchObject({ status: 499, code: "search-aborted" });
  expect((await f.search("needle")).matches).toHaveLength(1);
});

test("late search-only open/read operations retain and close their owned handles before cancellation settles", async () => {
  for (const phase of ["open", "read"] as const) {
    const f = await fixture(false, true); await put(f.cwd, "visible.txt");
    const entered = latch(), gate = latch(), controller = new AbortController();
    const internal = f.service as any, acquire = internal.searchOpen.bind(f.service);
    let owned: FileHandle | undefined, closed = 0, finished = false;
    const events: string[] = [];
    // Only this service's readonly acquisition and this one actual descriptor
    // are wrapped. Global fs I/O and writable disk() are never monkey-patched.
    internal.searchOpen = async (target: string) => {
      const handle = await acquire(target);
      owned = handle;
      const descriptor = {
        stat: () => handle.stat(),
        read: (...args: any[]) => handle.read(...args),
        close: async () => { await handle.close(); closed++; events.push("closed"); },
      };
      if (phase === "open") {
        entered.release(); await gate.promise; events.push("open-returned");
      } else {
        descriptor.read = async (...args: any[]) => {
          entered.release(); await gate.promise;
          const result = await handle.read(...args); events.push("read-finished"); return result;
        };
      }
      return descriptor;
    };
    const settled = Promise.allSettled([f.search("needle", {}, controller.signal)]).then(outcomes => {
      finished = true; return outcomes;
    });
    let outcomes: Awaited<typeof settled> | undefined;
    try {
      await bounded(entered.promise, `owned ${phase} operation`);
      controller.abort();
      // Give cancellation waiters a turn: a whole-operation Promise.race would
      // incorrectly settle here while the real acquisition/read is still held.
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      expect(closed).toBe(0);
      expect(f.measurement().disposals).toBe(0);
    } finally {
      controller.abort(); gate.release();
      outcomes = await settled;
    }
    expect(outcomes![0]).toMatchObject({ status: "rejected", reason: { status: 499, code: "search-aborted" } });
    expect(events).toEqual([phase === "open" ? "open-returned" : "read-finished", "closed"]);
    expect(closed).toBe(1);
    expect(f.measurement().disposals).toBe(1);
    expect((await Promise.allSettled([owned!.stat()]))[0]?.status).toBe("rejected");
  }
});

test("2001 tab-only ignore rules truncate before evaluator startup and still run the full final fence", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  await put(f.cwd, ".gitignore", "\t\n".repeat(LIMITS.ignoreRules + 1));
  const register = WorkspaceIgnoreEvaluator.prototype.register;
  let registrations = 0, finals = 0;
  observeSearch(f.service, { final: () => { finals++; } });
  WorkspaceIgnoreEvaluator.prototype.register = async () => {
    registrations++;
    // Child startup is lazy inside register; make any attempt a hard failure,
    // rather than actually launching a child or silently supplying no rules.
    throw new Error("Over-budget ignore snapshots must not start an evaluator");
  };
  const before = f.measurement();
  try {
    expect(await f.search("needle")).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
    expect(registrations).toBe(0);
    expect(finals).toBe(1);
    expect(f.measurement().lookups - before.lookups).toBe(1);
    expect(f.measurement().disposals - before.disposals).toBe(1);
  } finally { WorkspaceIgnoreEvaluator.prototype.register = register; }
});

test("ignore evaluator is lazy, and unexpected evaluation failure never becomes an empty rule set", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  const original = WorkspaceIgnoreEvaluator.prototype.register;
  let registers = 0;
  WorkspaceIgnoreEvaluator.prototype.register = async () => {
    registers++;
    throw new WorkspaceIgnoreError(503, "ignore-unavailable", "Evaluator unavailable");
  };
  try {
    expect((await f.search("needle")).matches).toHaveLength(1);
    await put(f.cwd, ".gitignore", "# comment only\n \n");
    expect((await f.search("needle")).matches).toHaveLength(1);
    expect(registers).toBe(0);
    await put(f.cwd, ".gitignore", "visible.txt\n");
    await expect(f.search("needle")).rejects.toMatchObject({ status: 503, code: "ignore-unavailable" });
    expect(registers).toBe(1);
    expect(f.measurement().disposals).toBe(3);
  } finally { WorkspaceIgnoreEvaluator.prototype.register = original; }
});

test("ignore rule-length and evaluator budget exhaustion truncate with cleanup and a final fence", async () => {
  const f = await fixture(false, true); await put(f.cwd, "visible.txt");
  await put(f.cwd, ".gitignore", "x".repeat(4097));
  let finals = 0;
  observeSearch(f.service, { final: () => { finals++; } });
  expect(await f.search("needle")).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
  expect(finals).toBe(1);
  await put(f.cwd, ".gitignore", "visible.txt\n");
  const original = WorkspaceIgnoreEvaluator.prototype.register, close = WorkspaceIgnoreEvaluator.prototype.close;
  let closed = 0;
  WorkspaceIgnoreEvaluator.prototype.register = async () => { throw new WorkspaceIgnoreError(413, "ignore-limit", "Budget reached"); };
  WorkspaceIgnoreEvaluator.prototype.close = async function (this: WorkspaceIgnoreEvaluator) { closed++; await close.call(this); };
  try {
    expect(await f.search("needle")).toMatchObject({ matches: [], truncated: true, scannedFiles: 0 });
    expect(closed).toBe(1);
    expect(finals).toBe(2);
  } finally {
    WorkspaceIgnoreEvaluator.prototype.register = original;
    WorkspaceIgnoreEvaluator.prototype.close = close;
  }
});
