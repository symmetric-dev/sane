import { afterEach, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CatalogService } from "../src/catalog";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture(repository = true, linked = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-terminal-binding-"))); roots.push(root);
  const primary = join(root, "primary"), cwd = linked ? join(root, "linked") : primary, data = join(root, "data");
  await Promise.all([mkdir(primary), mkdir(data)]);
  if (repository) {
    git(primary, "init", "-q");
    if (linked) {
      git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial");
      git(primary, "worktree", "add", "-q", "-b", "linked", cwd);
    }
  }
  const catalog = new CatalogService(data, () => []), registered = await catalog.register(cwd);
  let discoveries = 0, subprocesses = 0;
  const discover = catalog.discover.bind(catalog);
  catalog.discover = async (...args) => { discoveries++; return discover(...args); };
  const service = (catalog as any).git, executeGit = service.git.bind(service);
  service.git = async (...args: any[]) => { subprocesses++; return executeGit(...args); };
  return {
    root, primary, cwd, data, catalog, registered,
    lease: () => catalog.terminalLease(registered.workspaceId, registered.worktreeId),
    counts: () => ({ discoveries, subprocesses }),
  };
}

test("terminal binding acquires once and repeated input validations never discover or spawn Git", async () => {
  for (const linked of [false, true]) {
    const f = await fixture(true, linked), lease = await f.lease();
    expect(lease.mode).toBe("metadata");
    expect(f.counts()).toEqual({ discoveries: 1, subprocesses: 3 });
    expect(lease.binding.cwd).toBe(f.cwd);
    expect(lease.binding.bindingRevision).toBe(f.registered.workspace.worktrees.find(t => t.worktreeId === f.registered.worktreeId)!.bindingRevision);
    expect(Object.isFrozen(lease.binding)).toBe(true);
    expect(Object.isFrozen(lease.binding.protectedPaths)).toBe(true);
    for (let i = 0; i < 12; i++) await lease.validate();
    await Promise.all(Array.from({ length: 12 }, () => lease.validate()));
    expect(f.counts()).toEqual({ discoveries: 1, subprocesses: 3 });
  }
});

test("acquisition fences mapping-relevant config edits after authoritative discovery", async () => {
  const f = await fixture(), discover = f.catalog.discover.bind(f.catalog);
  f.catalog.discover = async (...args) => {
    const result = await discover(...args);
    // This syntax passes simpleConfig, but Git will reject the new format.
    // Capture must precede the authority check, not silently bless this edit.
    await appendFile(join(f.cwd, ".git/config"), "\n[core]\n\trepositoryformatversion = 999\n");
    return result;
  };
  await expect(f.lease()).rejects.toMatchObject({ code: "binding-invalid" });
  expect(f.counts()).toEqual({ discoveries: 1, subprocesses: 3 });
});

test("fallback acquisition retains local config and .git fingerprints through discovery", async () => {
  for (const target of ["marker", "config"] as const) {
    const f = await fixture(true, true), config = join(f.primary, ".git/config"), included = join(f.root, "included-config");
    await writeFile(included, "[user]\n\tname = Included\n");
    await appendFile(config, `\n[include]\n\tpath = ${included}\n`);
    const discover = f.catalog.discover.bind(f.catalog);
    f.catalog.discover = async (...args) => {
      const result = await discover(...args);
      if (target === "marker") await writeFile(join(f.cwd, ".git"), `gitdir: ${join(f.primary, ".git")}\n`);
      else await appendFile(config, `\n[core]\n\tworktree = ${f.primary}\n`);
      return result;
    };
    await expect(f.lease()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts()).toEqual({ discoveries: 1, subprocesses: 3 });
  }
});

test("normal worktree, index, branch, HEAD and Git objects/ref writes preserve a metadata lease", async () => {
  for (const linked of [false, true]) {
    const f = await fixture(true, linked), lease = await f.lease(), before = f.counts();
    await mkdir(join(f.cwd, "new-directory"));
    await writeFile(join(f.cwd, "new-directory/file.txt"), "ordinary write");
    git(f.cwd, "add", ".");
    await lease.validate();
    git(f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "normal Git writes");
    await lease.validate();
    git(f.cwd, "checkout", "-qb", "another-branch");
    await lease.validate();
    await appendFile(join(f.cwd, "new-directory/file.txt"), "\nmore writes");
    await lease.validate();
    expect(f.counts()).toEqual(before);
  }
});

test("root, Git directory, common directory and data directory replacement reject filesystem pins", async () => {
  for (const target of ["root", "git", "common", "data"] as const) {
    const f = await fixture(true, target === "common"), lease = await f.lease(), before = f.counts();
    const path = target === "root" ? f.cwd : target === "data" ? f.data : target === "git" ? join(f.cwd, ".git") : join(f.primary, ".git");
    const old = join(f.root, "old-bound-directory");
    await rename(path, old); await mkdir(path);
    await expect(lease.validate()).rejects.toMatchObject({ status: 409, code: "binding-invalid" });
    expect(f.counts()).toEqual(before);
    await rm(path, { recursive: true }); await rename(old, path);
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("canonical root and data selector redirects reject a lease without Git", async () => {
  for (const target of ["root", "data"] as const) {
    const f = await fixture(), lease = await f.lease(), before = f.counts();
    const path = target === "root" ? f.cwd : f.data, old = join(f.root, "redirect-target");
    await rename(path, old); await symlink(old, path);
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts()).toEqual(before);
  }
});

test(".git and commondir remaps reject before discovery and cannot revive an invalid lease", async () => {
  for (const target of ["marker", "common"] as const) {
    const f = await fixture(true, true), lease = await f.lease(), before = f.counts();
    const path = target === "marker" ? join(f.cwd, ".git") : join(git(f.cwd, "rev-parse", "--absolute-git-dir"), "commondir");
    const original = await readFile(path, "utf8");
    await writeFile(path, target === "marker" ? `gitdir: ${join(f.primary, ".git")}\n` : `${f.root}\n`);
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts()).toEqual(before);
    await writeFile(path, original);
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("authoritative binding revision, state, roots and protection changes reject; aliases do not", async () => {
  const f = await fixture();
  const workspace = (f.catalog as any).catalog.workspaces[0], tree = workspace.worktrees[0];
  for (const [record, key, next] of [
    [tree, "bindingRevision", crypto.randomUUID()], [tree, "state", "invalid"],
    [tree, "root", join(f.root, "other-root")], [tree, "gitDir", join(f.root, "other-git")],
    [workspace, "commonDir", join(f.root, "other-common")],
  ] as const) {
    const lease = await f.lease(), before = f.counts(), old = record[key]; record[key] = next;
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts()).toEqual(before); record[key] = old;
  }
  const lease = await f.lease(), before = f.counts();
  await f.catalog.setAlias(f.registered.workspaceId, f.registered.worktreeId, "Friendly name");
  await lease.validate(); expect(f.counts()).toEqual(before);
});

test("non-mapping config changes revalidate once then refresh without killing a healthy lease", async () => {
  for (const linked of [false, true]) {
    const f = await fixture(true, linked), lease = await f.lease();
    git(f.cwd, "config", "user.name", "Updated user");
    await lease.validate();
    expect(f.counts()).toEqual({ discoveries: 2, subprocesses: 6 });
    expect(lease.mode).toBe("metadata");
    for (let i = 0; i < 10; i++) await lease.validate();
    expect(f.counts()).toEqual({ discoveries: 2, subprocesses: 6 });
    git(f.cwd, "config", "remote.origin.url", "https://example.test/new-url");
    await lease.validate();
    expect(f.counts()).toEqual({ discoveries: 3, subprocesses: 9 });
  }
});

test("a config worktree remap is rejected by authoritative rediscovery", async () => {
  const f = await fixture(), lease = await f.lease(), other = join(f.root, "other-worktree");
  await mkdir(other); git(f.cwd, "config", "core.worktree", other);
  await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  expect(f.counts().discoveries).toBe(2);
});

test("config refresh fences mapping and config changes racing the full rediscovery", async () => {
  for (const target of ["marker", "config"] as const) {
    const f = await fixture(true, true), lease = await f.lease();
    git(f.cwd, "config", "user.name", "Trigger safe config refresh");
    const discover = f.catalog.discover.bind(f.catalog);
    f.catalog.discover = async (...args) => {
      const result = await discover(...args);
      if (target === "marker") await writeFile(join(f.cwd, ".git"), `gitdir: ${join(f.primary, ".git")}\n`);
      else await appendFile(join(f.primary, ".git/config"), "\n[include]\n\tpath = /not-followed-after-discovery\n");
      return result;
    };
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("unsupported includes use explicit discovery fallback and mapping overrides are fenced", async () => {
  const f = await fixture(), included = join(f.root, "included-config");
  await writeFile(included, "[user]\n\tname = Included\n");
  await appendFile(join(f.cwd, ".git/config"), `\n[include]\n\tpath = ${included}\n`);
  const lease = await f.lease(); expect(lease.mode).toBe("discovery");
  const before = f.counts(); await lease.validate(); await lease.validate();
  expect(f.counts().discoveries).toBe(before.discoveries + 2);
  const other = join(f.root, "other-worktree"); await mkdir(other);
  await writeFile(included, `[core]\n\tworktree = ${other}\n`);
  // Git versions may ignore included core.worktree during repository setup.
  // The fallback follows authoritative discovery, not our own config parser.
  const includedEdit = f.counts(); await lease.validate();
  expect(f.counts().discoveries).toBe(includedEdit.discoveries + 1);
  await appendFile(join(f.cwd, ".git/config"), `\n[core]\n\tworktree = ${other}\n`);
  await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
});

test("a healthy config can enter unsupported fallback and later return to metadata validation", async () => {
  const f = await fixture(), lease = await f.lease(), config = join(f.cwd, ".git/config"), original = await readFile(config, "utf8");
  const included = join(f.root, "included-config"); await writeFile(included, "[user]\n\tname = Included\n");
  await appendFile(config, `\n[include]\n\tpath = ${included}\n`);
  await lease.validate(); expect(lease.mode).toBe("discovery");
  await writeFile(config, original); await lease.validate(); expect(lease.mode).toBe("metadata");
  const before = f.counts(); await lease.validate(); expect(f.counts()).toEqual(before);
});

test("transition to fallback fences core.worktree and config.worktree edits after discovery", async () => {
  for (const target of ["config", "worktree-config"] as const) {
    const f = await fixture(true, true), lease = await f.lease(), config = join(f.primary, ".git/config"), included = join(f.root, "included-config");
    await writeFile(included, "[user]\n\tname = Included\n");
    await appendFile(config, `\n[include]\n\tpath = ${included}\n`);
    const discover = f.catalog.discover.bind(f.catalog);
    f.catalog.discover = async (...args) => {
      const result = await discover(...args);
      if (target === "config") await appendFile(config, `\n[core]\n\tworktree = ${f.primary}\n`);
      else await writeFile(join(result.gitDir!, "config.worktree"), `[core]\n\tworktree = ${f.primary}\n`);
      return result;
    };
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("already-fallback validations fence .git, commondir and config edits after discovery", async () => {
  for (const target of ["marker", "common", "config", "worktree-config"] as const) {
    const f = await fixture(true, true), config = join(f.primary, ".git/config"), included = join(f.root, "included-config");
    await writeFile(included, "[user]\n\tname = Included\n");
    await appendFile(config, `\n[include]\n\tpath = ${included}\n`);
    const lease = await f.lease(); expect(lease.mode).toBe("discovery");
    const discover = f.catalog.discover.bind(f.catalog);
    f.catalog.discover = async (...args) => {
      const result = await discover(...args);
      if (target === "marker") await writeFile(join(f.cwd, ".git"), `gitdir: ${join(f.primary, ".git")}\n`);
      else if (target === "common") await writeFile(join(result.gitDir!, "commondir"), `${f.root}\n`);
      else if (target === "config") await appendFile(config, `\n[core]\n\tworktree = ${f.primary}\n`);
      else await writeFile(join(result.gitDir!, "config.worktree"), `[core]\n\tworktree = ${f.primary}\n`);
      return result;
    };
    const before = f.counts();
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts().discoveries).toBe(before.discoveries + 1);
  }
});

test("unsupported symlink metadata retains a no-follow fingerprint during fallback discovery", async () => {
  const f = await fixture(), config = join(f.cwd, ".git/config"), target = join(f.root, "config-target");
  await rename(config, target); await symlink(target, config);
  const lease = await f.lease(); expect(lease.mode).toBe("discovery");
  const discover = f.catalog.discover.bind(f.catalog);
  f.catalog.discover = async (...args) => {
    const result = await discover(...args);
    await rename(config, join(f.root, "old-config-link"));
    await writeFile(config, "[core]\n\trepositoryformatversion = 999\n");
    return result;
  };
  await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
});

test("oversized or unreadable local metadata retains fingerprints without requiring content reads", async () => {
  for (const shape of ["oversized", "unreadable"] as const) {
    const f = await fixture(), path = join(f.cwd, ".git", shape === "oversized" ? "config" : "config.worktree");
    if (shape === "oversized") await appendFile(path, `\n#${"x".repeat(65 * 1024)}\n`);
    else {
      // This worktree config is ignored by Git without worktreeConfig support.
      // Its content need not be readable by the lease to fence local edits.
      await writeFile(path, "[user]\n\tname = Test\n"); await chmod(path, 0);
    }
    const lease = await f.lease(); expect(lease.mode).toBe("discovery");
    await lease.validate();
    const discover = f.catalog.discover.bind(f.catalog);
    f.catalog.discover = async (...args) => {
      const result = await discover(...args);
      if (shape === "unreadable") await chmod(path, 0o600);
      await appendFile(path, "\n[core]\n\trepositoryformatversion = 999\n");
      return result;
    };
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("worktree config and symlink config use discovery fallback rather than trusting unsupported metadata", async () => {
  for (const shape of ["worktree-config", "symlink"] as const) {
    const f = await fixture(), config = join(f.cwd, ".git/config");
    if (shape === "worktree-config") await writeFile(join(f.cwd, ".git/config.worktree"), "[user]\n\tname = Test\n");
    else { const target = join(f.root, "config"); await rename(config, target); await symlink(target, config); }
    const lease = await f.lease(); expect(lease.mode).toBe("discovery");
    const before = f.counts(); await lease.validate(); expect(f.counts().discoveries).toBe(before.discoveries + 1);
  }
});

test("directory leases accept ordinary writes but reject newly created root or ancestor repositories", async () => {
  for (const ancestor of [false, true]) {
    const f = await fixture(false), lease = await f.lease(), before = f.counts();
    expect(lease.mode).toBe("metadata");
    await writeFile(join(f.cwd, "ordinary.txt"), "normal directory write");
    for (let i = 0; i < 5; i++) await lease.validate();
    expect(f.counts()).toEqual(before);
    git(ancestor ? f.root : f.cwd, "init", "-q");
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
    expect(f.counts()).toEqual(before);
  }
});

test("deleting Git recognizer metadata fails closed instead of continuing with stale mapping", async () => {
  for (const target of ["HEAD", "objects", "refs"] as const) {
    const f = await fixture(), lease = await f.lease();
    await rename(join(f.cwd, ".git", target), join(f.root, `old-${target}`));
    await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
  }
});

test("HEAD recognizer checks do not accept case-insensitive symbolic reference prefixes", async () => {
  const f = await fixture(), lease = await f.lease();
  await writeFile(join(f.cwd, ".git/HEAD"), "REF: refs/heads/main\n");
  await expect(lease.validate()).rejects.toMatchObject({ code: "binding-invalid" });
});

test("catalog storage failure revokes a lease without subprocesses", async () => {
  const f = await fixture(), lease = await f.lease(), before = f.counts();
  (f.catalog as any).failed = true;
  await expect(lease.validate()).rejects.toMatchObject({ code: "catalog-storage", status: 503 });
  expect(f.counts()).toEqual(before);
});
