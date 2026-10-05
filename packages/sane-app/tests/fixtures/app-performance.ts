import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverRepository, initializeRepository } from "sane-core/server";
import type { MutationContext } from "sane-core/contracts";
import { CatalogService } from "../../src/catalog";
import { resolveSources } from "../../src/app-store";
import { RepositoryRouter } from "../../src/workstreams";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
export const mutation = (): MutationContext => ({ actor: { kind: "human" }, correlationId: crypto.randomUUID() });
export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.exitCode !== 0) throw new Error(`Fixture Git failed (${result.exitCode}): ${result.stderr}`);
}
export async function performanceFixture(linked = false, initialized = true) {
  const root = realpathSync(mkdtempSync(join(TEMP, "sane-app-performance-")));
  const primary = join(root, "primary"), checkout = linked ? join(root, "linked") : primary, data = join(root, "data"), profile = join(root, "profile");
  for (const dir of [primary, data, profile]) mkdirSync(dir);
  let router: RepositoryRouter | undefined;
  try {
    git(primary, "init", "-q");
    if (linked) {
      git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial");
      git(primary, "worktree", "add", "-q", "-b", "linked", checkout);
    }
    if (initialized) initializeRepository(discoverRepository(primary));
    const sources = resolveSources({ cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: profile }, oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "service.json") } });
    const catalog = new CatalogService(data, () => []);
    // Register the selected invocation first, just as an App launched from a linked worktree does.
    const registration = await catalog.register(checkout);
    router = new RepositoryRouter(catalog, sources);
    return { root, primary, checkout, data, sources, catalog, router, ...registration,
      close() { try { router!.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
  } catch (error) { router?.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}
