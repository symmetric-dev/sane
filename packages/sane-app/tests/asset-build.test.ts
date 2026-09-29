import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildAssets, validateAssets } from "../src/asset-build";
import { acquireInstallation, OwnershipHandle, validateOwnershipPaths } from "../src/installation-ownership";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sane-builder-"))); roots.push(root);
  const pkg = join(root, "packages", "sane-app");
  for (const dir of ["frontend", "src", "public"]) mkdirSync(join(pkg, dir), { recursive: true });
  writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":1}');
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
  writeFileSync(join(pkg, "frontend/main.tsx"), 'import { value } from "./dependency"; console.log(value);');
  writeFileSync(join(pkg, "frontend/dependency.ts"), 'export { value } from "../../../shared";');
  writeFileSync(join(root, "shared.ts"), 'export const value = "one";');
  for (const name of ["asset-build.ts", "installation-ownership.ts"]) copyFileSync(resolve(import.meta.dir, "../src", name), join(pkg, "src", name));
  copyFileSync(resolve(import.meta.dir, "../build.ts"), join(pkg, "build.ts"));
  return { root, pkg, outdir: join(pkg, "public/assets") };
}
test("complete generations and dirty transitive/root/build/lock inputs invalidate without Git", async () => {
  const f = fixture();
  const first = await buildAssets({ packageDir: f.pkg });
  expect(validateAssets({ packageDir: f.pkg }).assetsDir).toBe(first.assetsDir);
  for (const file of [join(f.root, "shared.ts"), join(f.root, "bun.lock"), join(f.pkg, "build.ts")]) {
    const original = readFileSync(file, "utf8"); writeFileSync(file, original + "\n");
    expect(() => validateAssets({ packageDir: f.pkg })).toThrow("stale"); writeFileSync(file, original);
  }
  const second = await buildAssets({ packageDir: f.pkg });
  expect(second.assetsDir).not.toBe(first.assetsDir); expect(existsSync(join(first.assetsDir, "app.js"))).toBe(true);
  rmSync(join(second.assetsDir, "app.js")); expect(() => validateAssets({ packageDir: f.pkg })).toThrow("rebuild");
});
test("failed staging preserves published generation", async () => {
  const f = fixture(); const original = await buildAssets({ packageDir: f.pkg });
  const pointer = readFileSync(join(f.outdir, "current.json"), "utf8");
  writeFileSync(join(f.pkg, "frontend/main.tsx"), "export const = invalid");
  await expect(buildAssets({ packageDir: f.pkg })).rejects.toThrow();
  expect(readFileSync(join(f.outdir, "current.json"), "utf8")).toBe(pointer);
  expect(existsSync(join(original.assetsDir, "app.js"))).toBe(true);
});
test("publication permission failure preserves previous pointer and generation", async () => {
  const f = fixture(); const first = await buildAssets({ packageDir: f.pkg });
  const pointer = readFileSync(join(f.outdir, "current.json"), "utf8"), originalBuild = Bun.build;
  const mock = spyOn(Bun, "build").mockImplementation(async (options: any) => {
    const result = await originalBuild(options); chmodSync(f.outdir, 0o500); return result;
  });
  try { await expect(buildAssets({ packageDir: f.pkg })).rejects.toThrow(); }
  finally { chmodSync(f.outdir, 0o700); mock.mockRestore(); }
  expect(readFileSync(join(f.outdir, "current.json"), "utf8")).toBe(pointer);
  expect(validateAssets({ packageDir: f.pkg }).assetsDir).toBe(first.assetsDir);
});
test("installation owner blocks every output; genuine passed handle works; stale and forged handles reject", async () => {
  const f = fixture(), owner = acquireInstallation(validateOwnershipPaths(f.pkg, join(f.root, "unused-data")), { phase: "starting" });
  await expect(buildAssets({ packageDir: f.pkg, outdir: join(f.root, "alternate") })).rejects.toThrow("Live installation");
  const forged = new OwnershipHandle(owner.paths, owner.lock, { ...owner.owner });
  await expect(buildAssets({ packageDir: f.pkg, ownership: forged })).rejects.toThrow("not issued");
  await expect(buildAssets({ packageDir: f.pkg, ownership: { ...owner, assertOwned() {} } as unknown as OwnershipHandle })).rejects.toThrow("not issued");
  const built = await buildAssets({ packageDir: f.pkg, ownership: owner }); expect(existsSync(join(built.assetsDir, "manifest.json"))).toBe(true);
  owner.assertOwned(); owner.release();
  await expect(buildAssets({ packageDir: f.pkg, ownership: owner })).rejects.toThrow();
});
test("copied direct builder help is effect-free and copied standalone builds require no App config/data", async () => {
  const f = fixture();
  const invoke = (...args: string[]) => Bun.spawn([process.execPath, join(f.pkg, "build.ts"), ...args], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
  let proc = invoke("--help"); expect(await proc.exited).toBe(0); expect(existsSync(join(f.pkg, ".runtime"))).toBe(false);
  proc = invoke("--bad"); expect(await proc.exited).toBe(1); expect(existsSync(join(f.pkg, ".runtime"))).toBe(false);
  proc = invoke(); expect(await proc.exited).toBe(0); expect(validateAssets({ packageDir: f.pkg }).manifest.outputs["app.js"]).toBeTruthy();
  expect(existsSync(join(f.pkg, ".config.json"))).toBe(false); expect(existsSync(join(f.pkg, ".data"))).toBe(false);
});
