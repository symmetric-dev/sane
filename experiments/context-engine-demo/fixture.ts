import { execFileSync } from "node:child_process";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import { validateCanonicalActivation, type CanonicalActivation } from "../../packages/sane-app/src/canonical-activation-validation";
import { CanonicalExecutionStore } from "../../packages/sane-app/src/canonical-execution-store";
import { ContextPackageStore } from "../../packages/sane-app/src/context-package-store";
import { externalFixtureRoot } from "./paths";

export type DemoFixture = Readonly<{
  root: string;
  checkout: string;
  sourceRoot: string;
  data: string;
  activation: CanonicalActivation;
  agent: StoredSaneAgentIdentity;
  context: ContextPackageStore;
  execution: CanonicalExecutionStore;
}>;

/** Read the current authored sources, including uncommitted engine work, without
 * creating a source worktree or changing its Git/index/config/context files. */
export async function createDemoFixture(root: string): Promise<DemoFixture> {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  root = externalFixtureRoot(root, sourceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  if (root === sourceRoot || (await readdir(root)).length) throw new Error("Demo root must be a fresh empty directory, not the source repository");
  const checkout = join(root, "checkout"), data = join(root, "data");
  const home = join(root, "git-home"), hooks = join(root, "empty-hooks");
  for (const directory of [checkout, data, home, hooks, join(root, "journals"), join(checkout, "roots", "A"), join(checkout, "roots", "B")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  // Whitelist instead of copying process.env: caller GIT_DIR/WORK_TREE, config
  // injection, SSH helpers, templates and global hooks cannot target the source.
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  execFileSync("/usr/bin/git", ["-c", `core.hooksPath=${hooks}`, "-c", "init.templateDir=", "init", "--template=", "--initial-branch=context-demo", checkout], { cwd: root, env, stdio: "pipe" });
  execFileSync("/usr/bin/git", ["-C", checkout, "config", "core.hooksPath", hooks], { cwd: root, env, stdio: "pipe" });
  await writeFile(join(checkout, "README.md"), "# Disposable context-engine fixture\n\nNo App registration, native sessions, models, or real workstream records.\n", { flag: "wx", mode: 0o600 });

  const agent: StoredSaneAgentIdentity = { kind: "assistant", role: "engineering" };
  const context = new ContextPackageStore(sourceRoot, join(data, "context-packages"));
  const execution = new CanonicalExecutionStore(sourceRoot, join(data, "execution"));
  const [packageRef, saneExecution] = await Promise.all([context.create(agent), execution.create(agent)]);
  const activation: CanonicalActivation = {
    saneExecution,
    saneContext: { version: 1, framework: "authored-pinned-demo", package: packageRef },
  };
  // Both loaders retain their real pinned-file integrity checks. This verifies
  // role bytes and every authored native-child policy without installing them.
  await validateCanonicalActivation(activation, agent, { context, execution });
  await writeFile(join(root, "fixture.json"), JSON.stringify({ schema: 1, simulation: true, sourceRoot, checkout, data, agent, activation,
    isolation: "fresh Git repository; sanitized Git environment; authored source read-only; pins confined to fixture data" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { root, checkout, sourceRoot, data, activation, agent, context, execution };
}
