import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { publishGrokSettings, resolveAppConfig } from "./src/app-config";
import { atomicAppRecord, initializeAppStore, publishGrokSourcePin } from "./src/app-store";
import { parseGrokSetupOptions, prepareGrokProfile, resolveGrokSetup } from "./src/grok-setup";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "./src/installation-ownership";

export function runSetup(args: string[], packageDir = import.meta.dir) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: bun run setup:app [App configuration options] [Grok options]
Initializes App state and saves config, separately from project .sane init.
Existing matching setup is preserved. Only explicit Grok options may update saved settings:
  --grok-home PATH       Your existing authenticated Grok home (invocation-relative)
  --grok-bin ABSOLUTE    Grok executable; no PATH discovery
  --grok-model STRING    Explicit model, no guessed default
  --grok-effort STRING   Explicit effort, no guessed default
First Grok setup requires all four; later updates may reuse saved values.
Publishes the source pin and visible base:gk profile; preserves other profiles/default.
Stop the App first. No login, native probing, or startup migration is performed.
Example (replace with your actual home, binary, model and effort):
  bun run setup:app --grok-home "$HOME/.grok" --grok-bin /absolute/path/to/grok --grok-model YOUR_MODEL --grok-effort YOUR_EFFORT
See bun run start:app --help for other settings. --config may name a new file.`); return;
  }
  if (args.some(arg => ["--no-build", "--help"].includes(arg))) throw new Error("Unsupported setup option");
  const context = { packageDir, invocationCwd: process.cwd(), allowMissingConfig: true };
  const { appArgs, grok } = parseGrokSetupOptions(args);
  const resolved = resolveAppConfig(appArgs, context);
  const grokSettings = grok ? resolveGrokSetup(grok, resolved.config.native.grok, context.invocationCwd) : undefined;
  if (!statSync(resolved.config.defaultExecutionCwd).isDirectory()) throw new Error("Execution cwd must be an existing directory");
  if (!statSync(dirname(resolved.configPath)).isDirectory()) throw new Error("Config parent must be an existing directory");
  const paths = validateOwnershipPaths(packageDir, resolved.config.dataDir);
  resolved.config.dataDir = paths.dataDir!;
  let savedBytes: string | undefined;
  if (resolved.configExists) {
    const stat = lstatSync(resolved.configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Config must be a regular unaliased file");
    const saved = resolveAppConfig(["--config", resolved.configPath], context).config;
    saved.dataDir = validateOwnershipPaths(packageDir, saved.dataDir).dataDir!;
    if (JSON.stringify(saved) !== JSON.stringify(resolved.config)) throw new Error("Setup will not overwrite saved settings; edit the config explicitly or select a new --config file");
    savedBytes = readFileSync(resolved.configPath, "utf8");
  }
  const installation = acquireInstallation(paths, { phase: "setup", reconcileInterrupted: resolved.operational.reconcileInterrupted });
  let data: OwnershipHandle | undefined;
  try {
    data = acquireData(installation, { phase: "setup", createDataParent: true, reconcileInterrupted: resolved.operational.reconcileInterrupted });
    if (savedBytes !== undefined && readFileSync(resolved.configPath, "utf8") !== savedBytes) throw new Error("Saved configuration changed during setup; retry explicitly");
    const profiles = grokSettings ? prepareGrokProfile(paths.dataDir!, grokSettings) : undefined;
    initializeAppStore(paths.dataDir!, {
      cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: resolved.config.native.claude.profileRoot },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: resolved.config.native.opencode.registrationFile },
    });
    if (grokSettings) {
      installation.assertOwned(); data.assertOwned();
      publishGrokSourcePin(paths.dataDir!, grokSettings.homeRoot);
      resolved.config.version = 2;
      resolved.config.native.grok = grokSettings;
      if (resolved.configExists) publishGrokSettings(resolved.configPath, grokSettings);
    }
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
    if (profiles) {
      installation.assertOwned(); data.assertOwned();
      atomicAppRecord(paths.dataDir!, "agents.json", profiles);
    }
    console.log(`SANE App setup ready: ${resolved.configPath}\nApp data: ${paths.dataDir}`);
  } finally { try { data?.release(); } finally { installation.release(); } }
}
if (import.meta.main) {
  try { runSetup(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Setup failed"); process.exitCode = 1; }
}
