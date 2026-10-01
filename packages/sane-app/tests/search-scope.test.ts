import { afterEach, expect, test } from "bun:test";
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CatalogService } from "../src/catalog";
import { WorkspaceError, WorkspaceService, type WorkspaceOperationOptions } from "../src/workspace";
import { createWorkspaceSearchLease } from "../src/workspace-search-scope";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const operation = (): WorkspaceOperationOptions => ({ deadline: Date.now() + 10_000 });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture(repository = true, linked = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-search-scope-"))); roots.push(root);
  const primary = join(root, "primary"), cwd = linked ? join(root, "linked") : primary, data = join(root, "data");
  await Promise.all([mkdir(primary), mkdir(data)]);
  if (repository) {
    git(primary, "init", "-q");
    if (linked) {
      git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial");
      git(primary, "worktree", "add", "-q", "-b", "linked", cwd);
    }
  }
  const catalog = new CatalogService(data, () => []);
  const registered = await catalog.register(cwd);
  const lease = () => catalog.searchLease(registered.workspaceId, registered.worktreeId, operation());
  return { root, primary, cwd, data, catalog, registered, lease };
}

test("a normal repository lease performs one discovery, snapshots protection and validates without Git", async () => {
  const f = await fixture();
  let discoveries = 0;
  const discover = f.catalog.discover.bind(f.catalog);
  f.catalog.discover = async (...args) => { discoveries++; return discover(...args); };
  const lease = await f.lease(); expect(lease).toBeDefined();
  expect(lease!.binding).toMatchObject({ cwd: f.cwd, protectedPaths: [join(f.cwd, ".git"), join(f.cwd, ".git")] });
  expect(discoveries).toBe(1);
  f.catalog.discover = async () => { throw new Error("Lease validation must not discover Git"); };
  await writeFile(join(f.cwd, "visible.txt"), "needle");
  // Ordinary Git/index/ref activity must not invalidate directory mtimes.
  git(f.cwd, "add", "visible.txt");
  for (let i = 0; i < 10; i++) await lease!.validate(operation());
  expect(Object.isFrozen(lease!.binding.protectedPaths)).toBe(true);
});

test("root replacement fails closed and cannot revive a previously invalidated lease", async () => {
  const f = await fixture(false), lease = await f.lease(); expect(lease).toBeDefined();
  const old = join(f.root, "old"); await rename(f.cwd, old); await mkdir(f.cwd);
  await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid", status: 409 });
  await rm(f.cwd, { recursive: true }); await rename(old, f.cwd);
  await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
});

test("data directory inode and canonical selector changes invalidate a lease", async () => {
  for (const redirected of [false, true]) {
    const f = await fixture(), lease = await f.lease(); expect(lease).toBeDefined();
    await rename(f.data, join(f.root, "old-data"));
    if (redirected) await symlink(join(f.root, "old-data"), f.data);
    else await mkdir(f.data);
    await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("catalog revision, state and pinned Git protection changes invalidate leases; aliases do not", async () => {
  const f = await fixture(), lease = await f.lease(); expect(lease).toBeDefined();
  await f.catalog.setAlias(f.registered.workspaceId, f.registered.worktreeId, "Friendly name");
  await lease!.validate(operation());
  // Simulate authoritative catalog changes independently of filesystem changes.
  const tree = (f.catalog as any).catalog.workspaces[0].worktrees[0];
  for (const [key, next] of [["bindingRevision", crypto.randomUUID()], ["state", "invalid"], ["gitDir", join(f.root, "other-admin")]] as const) {
    const fresh = await f.lease(); expect(fresh).toBeDefined();
    const previous = tree[key]; tree[key] = next;
    await expect(fresh!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
    tree[key] = previous;
  }
});

test("repository administration directory replacement and config edits invalidate leases", async () => {
  const f = await fixture(), lease = await f.lease(); expect(lease).toBeDefined();
  await appendFile(join(f.cwd, ".git/config"), "\n[include]\n\tpath = /not-followed\n");
  await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
  const other = await fixture(), directoryLease = await other.lease(); expect(directoryLease).toBeDefined();
  await rename(join(other.cwd, ".git"), join(other.root, "old-admin")); await mkdir(join(other.cwd, ".git"));
  await expect(directoryLease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
});

test("linked worktrees are supported; .git pointer and commondir edits fail without following new targets", async () => {
  for (const target of ["marker", "common"] as const) {
    const f = await fixture(true, true), lease = await f.lease(); expect(lease).toBeDefined();
    const gitDir = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const path = target === "marker" ? join(f.cwd, ".git") : join(gitDir, "commondir");
    const original = await readFile(path, "utf8");
    await writeFile(path, target === "marker" ? "gitdir: /must-not-follow\n" : "/must-not-follow\n");
    await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
    await writeFile(path, original);
    await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("directory leases fence newly created root and ancestor repositories", async () => {
  for (const ancestor of [false, true]) {
    const f = await fixture(false), lease = await f.lease(); expect(lease).toBeDefined();
    git(ancestor ? f.root : f.cwd, "init", "-q");
    await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("includes, mapping overrides, worktree config and symlinked config use the original lookup fallback", async () => {
  for (const shape of ["include", "worktree", "worktree-config", "symlink"] as const) {
    const f = await fixture();
    const config = join(f.cwd, ".git/config");
    if (shape === "include") {
      const included = join(f.root, "included"); await writeFile(included, "[user]\n\tname = Test\n");
      await appendFile(config, `\n[include]\n\tpath = ${included}\n`);
    } else if (shape === "worktree") git(f.cwd, "config", "core.worktree", f.cwd);
    else if (shape === "worktree-config") await writeFile(join(f.cwd, ".git/config.worktree"), "[core]\n\tbare = false\n");
    else { const target = join(f.root, "config"); await rename(config, target); await symlink(target, config); }
    expect(await f.lease()).toBeUndefined();
    // Fallback still executes the established full binding contract.
    expect(await f.catalog.binding(f.registered.workspaceId, f.registered.worktreeId)).toMatchObject({ cwd: f.cwd });
  }
});

test("authoritative protection snapshots are copied and changes invalidate without filesystem/Git discovery", async () => {
  const f = await fixture(false), rootIdentity = await lstat(f.cwd), protection: string[] = [];
  let revision = "v1";
  const lease = await createWorkspaceSearchLease({
    binding: { cwd: f.cwd, bindingRevision: revision, protectedPaths: protection }, dataDir: f.data,
    rootIdentity, gitDir: null, gitIdentity: null, commonDir: null, commonIdentity: rootIdentity,
    validateBinding: () => { if (revision !== "v1" || protection.length) throw new WorkspaceError(409, "binding-invalid", "Protection changed"); },
  }, operation());
  expect(lease).toBeDefined(); protection.push(join(f.cwd, "new-private"));
  expect(lease!.binding.protectedPaths).toEqual([]);
  await expect(lease!.validate(operation())).rejects.toMatchObject({ code: "binding-invalid" });
  revision = "v2";
});

test("lease validation honors caller cancellation and the same absolute deadline", async () => {
  const f = await fixture(), lease = await f.lease(); expect(lease).toBeDefined();
  const controller = new AbortController(); controller.abort();
  await expect(lease!.validate({ signal: controller.signal, deadline: Date.now() + 1000 })).rejects.toMatchObject({ code: "search-aborted" });
  await expect(lease!.validate({ deadline: Date.now() - 1 })).rejects.toMatchObject({ code: "search-time-limit" });
  // Cancellation is not evidence of a broken pinned binding.
  await lease!.validate(operation());
});

test("production search discovery count is independent of the number of files and fallback remains available", async () => {
  const f = await fixture();
  let discoveries = 0;
  const discover = f.catalog.discover.bind(f.catalog);
  f.catalog.discover = async (...args) => { discoveries++; return discover(...args); };
  const service = new WorkspaceService(
    (_id, next) => f.catalog.binding(f.registered.workspaceId, f.registered.worktreeId, next), f.data,
    (_id, next) => f.catalog.searchLease(f.registered.workspaceId, f.registered.worktreeId, next),
  );
  const { workspaceId } = await service.resolve("tree");
  await writeFile(join(f.cwd, "first.txt"), "needle"); discoveries = 0;
  expect((await service.search("tree", { workspaceId, query: "needle" })).matches).toHaveLength(1);
  const firstCount = discoveries;
  await Promise.all(Array.from({ length: 19 }, (_, i) => writeFile(join(f.cwd, `file-${i}.txt`), "needle")));
  discoveries = 0;
  expect((await service.search("tree", { workspaceId, query: "needle" })).matches).toHaveLength(20);
  expect(discoveries).toBe(firstCount); expect(discoveries).toBeLessThanOrEqual(4);
  const other = await fixture();
  const fallbackDiscover = other.catalog.discover.bind(other.catalog);
  other.catalog.discover = async (...args) => { discoveries++; return fallbackDiscover(...args); };
  await writeFile(join(other.cwd, "only.txt"), "needle");
  const fallback = new WorkspaceService(
    (_id, next) => other.catalog.binding(other.registered.workspaceId, other.registered.worktreeId, next), other.data,
    async () => undefined,
  );
  const fallbackId = (await fallback.resolve("tree")).workspaceId;
  discoveries = 0;
  expect((await fallback.search("tree", { workspaceId: fallbackId, query: "needle" })).matches).toHaveLength(1);
  expect(discoveries).toBeGreaterThan(firstCount);
});
