import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { acquireInstallation, assertInstallationOwnership, validateOwnershipPaths, type OwnershipHandle } from "./installation-ownership";

const recipe = { version: 1, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } } as const;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class AssetBuildError extends Error {}
type Manifest = { format: "sane-app-assets"; version: 1; generation: string; fingerprint: string; inputs: Record<string, string>; outputs: Record<string, string> };
export type AssetBuildOptions = { packageDir: string; outdir?: string; ownership?: OwnershipHandle; reconcileInterrupted?: boolean };

function regular(path: string): void {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new AssetBuildError(`Expected regular unaliased asset/input: ${path}`);
}
function safeDirectory(path: string): void {
  if (existsSync(path)) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new AssetBuildError(`Unsafe output directory: ${path}`); }
  if (dirname(path) !== path) safeDirectory(dirname(path));
}
function workspaceRoot(pkg: string): string {
  let dir = pkg;
  while (!existsSync(join(dir, "bun.lock")) && !existsSync(join(dir, "bun.lockb"))) {
    if (dirname(dir) === dir) throw new AssetBuildError("Build requires an installation lockfile");
    dir = dirname(dir);
  }
  return dir;
}
/** Conservative local closure: hash ALL workspace source/build files, not only today's import graph.
 * This includes dirty transitive local imports, CSS/url assets and future import edges.
 * Runtime/config/store/output trees and external dependencies are never traversed.
 */
function inputs(pkg: string, outdir: string): Record<string, string> {
  const root = workspaceRoot(pkg), result: Record<string, string> = {};
  const excluded = new Set(["node_modules", ".git", ".runtime", ".data", "dist", "coverage", ".sane"]);
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (excluded.has(item.name) || item.name.startsWith(".") || path === outdir || path === join(pkg, "public", "assets")) continue;
      if (item.isSymbolicLink()) throw new AssetBuildError(`Symlink in local build inputs: ${path}`);
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) { regular(path); result[relative(root, path)] = hash(readFileSync(path)); }
    }
  };
  // Include local imports outside packages too. Conservative invalidation is safe;
  // an unchanged Git commit is never evidence of unchanged build inputs.
  walk(root);
  for (const name of ["bun.lock", "bun.lockb", "package.json", "tsconfig.json"]) {
    const path = join(root, name); if (existsSync(path)) { regular(path); result[name] = hash(readFileSync(path)); }
  }
  result["$recipe"] = hash(JSON.stringify(recipe));
  result["$bun"] = hash(Bun.version);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const fingerprint = (input: Record<string, string>) => hash(JSON.stringify(input));
function paths(options: AssetBuildOptions) {
  const pkg = validateOwnershipPaths(options.packageDir).packageDir;
  const outdir = resolve(pkg, options.outdir ?? "public/assets");
  if ([pkg, join(pkg, "frontend"), join(pkg, "src")].some(input => input === outdir || input.startsWith(outdir + sep)) || outdir.startsWith(join(pkg, "frontend") + sep) || outdir.startsWith(join(pkg, "src") + sep)) throw new AssetBuildError("Output must not replace installation inputs");
  safeDirectory(outdir);
  return { pkg, outdir };
}
function outputHashes(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) walk(path);
      else { regular(path); result[relative(dir, path)] = hash(readFileSync(path)); }
    }
  };
  walk(dir); return result;
}

/** Only public build path: acquires ownership, or verifies a genuinely issued retained handle. */
export async function buildAssets(options: AssetBuildOptions): Promise<{ assetsDir: string; manifest: Manifest }> {
  const { pkg, outdir } = paths(options);
  const own = options.ownership ?? acquireInstallation(validateOwnershipPaths(pkg), { phase: "build", reconcileInterrupted: options.reconcileInterrupted });
  let stage: string | undefined;
  try {
    assertInstallationOwnership(own, pkg);
    const before = inputs(pkg, outdir), generation = randomUUID();
    mkdirSync(outdir, { recursive: true, mode: 0o700 });
    stage = join(outdir, `.stage-${generation}`); mkdirSync(stage, { mode: 0o700 });
    const result = await Bun.build({ entrypoints: [join(pkg, "frontend/main.tsx")], outdir: stage, target: recipe.target, format: recipe.format, naming: recipe.naming, minify: recipe.minify, define: recipe.define });
    if (!result.success) throw new AssetBuildError(`Asset compilation failed: ${result.logs.map(String).join("\n")}`);
    // Publish install metadata/icons with the same immutable, validated generation.
    const pwaDir = join(pkg, "public", "pwa");
    if (existsSync(pwaDir)) {
      safeDirectory(pwaDir);
      mkdirSync(join(stage, "pwa"), { mode: 0o700 });
      for (const name of ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
        const source = join(pwaDir, name); regular(source);
        copyFileSync(source, join(stage, "pwa", name));
      }
    }
    const outputs = outputHashes(stage);
    if (!outputs["app.js"]) throw new AssetBuildError("Build did not produce app.js");
    if (fingerprint(inputs(pkg, outdir)) !== fingerprint(before)) throw new AssetBuildError("Build inputs changed during compilation");
    const manifest: Manifest = { format: "sane-app-assets", version: 1, generation, fingerprint: fingerprint(before), inputs: before, outputs };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    assertInstallationOwnership(own, pkg); safeDirectory(outdir);
    const assetsDir = join(outdir, generation);
    renameSync(stage, assetsDir); stage = undefined;
    // A single same-directory rename publishes the complete immutable generation.
    // Old generations are deliberately retained; failure leaves the old pointer intact.
    const pointer = join(outdir, `.current-${generation}.tmp`);
    writeFileSync(pointer, JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }), { flag: "wx", mode: 0o600 });
    try { assertInstallationOwnership(own, pkg); renameSync(pointer, join(outdir, "current.json")); }
    finally { if (existsSync(pointer)) rmSync(pointer); }
    return { assetsDir, manifest };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (!options.ownership) own.release();
  }
}

/** Read-only start-only check. Server must serve assetsDir, not the mutable output root. */
export function validateAssets(options: Pick<AssetBuildOptions, "packageDir" | "outdir">): { assetsDir: string; manifest: Manifest } {
  const { pkg, outdir } = paths(options);
  try {
    const pointerPath = join(outdir, "current.json"); regular(pointerPath);
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (pointer.format !== "sane-app-assets-current" || pointer.version !== 1 || typeof pointer.generation !== "string" || !/^[a-f0-9-]{36}$/.test(pointer.generation)) throw new Error("Invalid current-generation pointer");
    const assetsDir = join(outdir, pointer.generation); safeDirectory(assetsDir);
    const manifestPath = join(assetsDir, "manifest.json"); regular(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.format !== "sane-app-assets" || manifest.version !== 1 || manifest.generation !== pointer.generation || !manifest.outputs?.["app.js"] || manifest.fingerprint !== fingerprint(inputs(pkg, outdir))) throw new Error("Missing, invalid or stale build manifest");
    for (const [file, digest] of Object.entries(manifest.outputs)) {
      if (!file || file === "manifest.json" || file.startsWith(".") || file.split(/[\\/]/).some(s => s === "..") || resolve(assetsDir, file) !== join(assetsDir, file) || !resolve(assetsDir, file).startsWith(assetsDir + sep)) throw new Error("Invalid asset name");
      const path = join(assetsDir, file); safeDirectory(dirname(path)); regular(path);
      if (hash(readFileSync(path)) !== digest) throw new Error(`Asset content mismatch: ${file}`);
    }
    return { assetsDir, manifest };
  } catch (e) { throw new AssetBuildError(`Assets unavailable; rebuild required: ${(e as Error).message}`); }
}
