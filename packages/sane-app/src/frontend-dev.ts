import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { buildAssets } from "./asset-build";
import { createAssetRoute } from "./asset-routes";
import type { OwnershipHandle } from "./installation-ownership";

type Generation = Awaited<ReturnType<typeof buildAssets>>;
type AssetRoute = ReturnType<typeof createAssetRoute>;

/** Frontend rebuilds share the server's installation ownership. Never restart
 * the bridge or publish incomplete builds, and drain before releasing its lock. */
export function createFrontendDev(packageDir: string, ownership: OwnershipHandle) {
  const watchers: FSWatcher[] = [];
  const generations = new Map<string, AssetRoute>();
  let current: AssetRoute | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<Generation> | undefined;
  let dirty = false;
  let closed = false;

  const report = (error: unknown) => console.error("[frontend] Rebuild failed; keeping the last successful UI:", error instanceof Error ? error.message : error);
  const schedule = () => {
    if (closed) return;
    dirty = true;
    if (inFlight) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void rebuild().catch(report);
    }, 150);
  };
  const rebuild = () => {
    dirty = false;
    const started = performance.now();
    console.log("[frontend] Building UI…");
    inFlight = buildAssets({ packageDir, outdir: "public/assets/dev", ownership, development: true }).then(generation => {
      if (!closed) {
        const route = createAssetRoute({ assetsDir: generation.assetsDir, assetManifest: generation.manifest, development: true });
        // A page loaded just before a rebuild must still receive its matching JS
        // and CSS, not a mix of generations (or a fingerprint mismatch/404).
        generations.set(generation.manifest.fingerprint, route);
        current = route;
        console.log(`[frontend] Ready in ${Math.round(performance.now() - started)}ms — refresh the browser.`);
      }
      return generation;
    }).finally(() => {
      inFlight = undefined;
      if (dirty) schedule();
    });
    return inFlight;
  };
  const addWatch = (directory: string, recursive: boolean, accept: (name: string) => boolean = () => true) => {
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      const name = filename?.toString();
      if (name && (name.split(/[\\/]/).some(part => part.startsWith(".") || ["node_modules", "tests"].includes(part)) || /\.(?:test|spec)\.[^.]+$/.test(name))) return;
      if (!name || accept(name)) schedule();
    });
    watcher.on("error", error => console.error("[frontend] File watcher failed; restart dev:app:", error.message));
    watchers.push(watcher);
  };

  return {
    async start(): Promise<Generation> {
      const packagesDir = dirname(packageDir);
      const root = dirname(packagesDir);
      // Browser code also imports workspace contracts and a few src/ modules.
      // Watch source trees, not runtime/history directories or generated assets.
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const workspace = join(packagesDir, entry.name);
        addWatch(workspace, false, name => ["package.json", "tsconfig.json"].includes(name));
        for (const name of ["frontend", "shared", "src"]) {
          const directory = join(workspace, name);
          if (existsSync(directory)) addWatch(directory, true);
        }
      }
      addWatch(join(packageDir, "public"), true, name => name.split(/[\\/]/)[0] !== "assets");
      addWatch(root, false, name => ["package.json", "tsconfig.json", "bun.lock", "bun.lockb"].includes(name));
      return rebuild();
    },
    route(req: Request, url: URL): Promise<Response | null> {
      const version = url.pathname.startsWith("/assets/") ? url.searchParams.get("v") : null;
      const route = (version && generations.get(version)) || current;
      return route ? route(req, url) : Promise.resolve(null);
    },
    async close(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await inFlight?.catch(() => {});
    },
  };
}
