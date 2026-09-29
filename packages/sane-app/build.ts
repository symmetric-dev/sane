import { buildAssets } from "./src/asset-build";

export async function runBuild(args: string[], packageDir = import.meta.dir): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun build.ts [--outdir PATH] [--reconcile-interrupted]\nBuild complete guarded asset generations; no App config or store is required.");
    return;
  }
  let outdir: string | undefined, reconcileInterrupted = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(`Duplicate build option: ${flag}`); seen.add(flag);
    if (flag === "--outdir") { const value = args[++i]; if (!value || value.startsWith("--")) throw new Error("Missing --outdir value"); outdir = value; }
    else if (flag === "--reconcile-interrupted") reconcileInterrupted = true;
    else throw new Error("Unknown build option; use --help");
  }
  const result = await buildAssets({ packageDir, outdir, reconcileInterrupted });
  console.log(`SANE App assets: ${result.assetsDir}`);
}
if (import.meta.main) {
  try { await runBuild(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Build failed"); process.exitCode = 1; }
}
