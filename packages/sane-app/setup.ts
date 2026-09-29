import { closeSync, fsyncSync, linkSync, lstatSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAppConfig } from "./src/app-config";
import { initializeAppStore } from "./src/app-store";
import { runtimeOptions } from "./src/bridge";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "./src/installation-ownership";

export function runSetup(args: string[], packageDir = import.meta.dir) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun run setup:app [App configuration options]\nInitializes fresh App state and saves config, separately from project .sane init.\nExisting matching setup is preserved; edit saved config explicitly to change it.\nSee bun run start:app --help for settings. --config may name a new file."); return;
  }
  if (args.some(arg => ["--no-build", "--help"].includes(arg))) throw new Error("Unsupported setup option");
  const context = { packageDir, invocationCwd: process.cwd(), allowMissingConfig: true };
  const resolved = resolveAppConfig(args, context);
  if (!statSync(resolved.config.defaultExecutionCwd).isDirectory()) throw new Error("Execution cwd must be an existing directory");
  if (!statSync(dirname(resolved.configPath)).isDirectory()) throw new Error("Config parent must be an existing directory");
  const paths = validateOwnershipPaths(packageDir, resolved.config.dataDir);
  resolved.config.dataDir = paths.dataDir!;
  if (resolved.configExists) {
    const stat = lstatSync(resolved.configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Config must be a regular unaliased file");
    const saved = resolveAppConfig(["--config", resolved.configPath], context).config;
    saved.dataDir = validateOwnershipPaths(packageDir, saved.dataDir).dataDir!;
    if (JSON.stringify(saved) !== JSON.stringify(resolved.config)) throw new Error("Setup will not overwrite saved settings; edit the config explicitly or select a new --config file");
  }
  const installation = acquireInstallation(paths, { phase: "setup", reconcileInterrupted: resolved.operational.reconcileInterrupted });
  let data: OwnershipHandle | undefined;
  try {
    data = acquireData(installation, { phase: "setup", createDataParent: true, reconcileInterrupted: resolved.operational.reconcileInterrupted });
    initializeAppStore(paths.dataDir!, runtimeOptions(resolved).nativeSources);
    if (!resolved.configExists) {
      const temporary = `${resolved.configPath}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        try { writeFileSync(fd, JSON.stringify(resolved.config, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
        installation.assertOwned(); data.assertOwned();
        linkSync(temporary, resolved.configPath);
      } finally { unlinkSync(temporary); }
      const directory = openSync(dirname(resolved.configPath), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    console.log(`SANE App setup ready: ${resolved.configPath}\nApp data: ${paths.dataDir}`);
  } finally { try { data?.release(); } finally { installation.release(); } }
}
if (import.meta.main) {
  try { runSetup(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Setup failed"); process.exitCode = 1; }
}
