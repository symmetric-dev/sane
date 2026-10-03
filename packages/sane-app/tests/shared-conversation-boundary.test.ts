import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = join(packageRoot, "shared", "conversation");
const transpiler = new Bun.Transpiler({ loader: "ts" });

async function sources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sources(path) : Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
  }));
  return nested.flat();
}

test("shared conversation runtime imports stay inside the shared boundary", async () => {
  const files = await sources(sharedRoot);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    // scan erases type-only imports: stored/native contract references do not
    // bring their backend implementations into the shared runtime graph.
    const imports = transpiler.scan(await readFile(file, "utf8")).imports;
    for (const item of imports) {
      expect(item.path.startsWith("."), `${relative(packageRoot, file)} imports ${item.path}`).toBe(true);
      const target = relative(sharedRoot, resolve(dirname(file), item.path));
      expect(target === ".." || target.startsWith(`..${sep}`), `${file} escapes through ${item.path}`).toBe(false);
    }
  }
});

test("backend transcript implementation and contract do not import frontend modules", async () => {
  for (const name of ["transcript-service.ts", "transcript-contract.ts"]) {
    const source = await readFile(join(packageRoot, "src", name), "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*frontend\//);
  }
});

test("shared conversation modules bundle for browsers without publishing App assets", async () => {
  // This builds only the shared leaf modules in memory. It neither starts a
  // browser nor invokes the installation-owned App asset publication path.
  const result = await Bun.build({ entrypoints: await sources(sharedRoot), target: "browser" });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  expect(result.outputs.length).toBeGreaterThan(0);
});
