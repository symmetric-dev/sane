import { parseOptions } from "./src/bridge";
import { runServer } from "./server";

export const help = `Usage: bun run start:app [options]
Builds assets and starts one foreground App server per installation.
Run bun run setup:app first to save config and initialize fresh App state.
  --config PATH             Saved config (default: packages/sane-app/.config.json)
  --cwd PATH --data-dir PATH Default execution directory and App history/catalog
  --host HOST --port PORT    Listener (default: 127.0.0.1:8787)
  --public-origin ORIGIN     Exact browser origin
  --clear-public-origin     Clear the saved public origin
  --allow-remote --no-allow-remote
  --claude-bin PATH --claude-profile PATH
  --opencode-registration PATH  Managed-local OpenCode registration file
  --max-concurrent-runs N    1–256 (default: 16)
  --no-build                Validate and serve the existing asset generation
  --reconcile-interrupted   Explicitly reclaim proven-dead ownership
CLI overrides saved settings; CLI paths are invocation-relative, saved paths
are config-relative. No native services are installed or started.
See packages/sane-app/HUMAN-OPERATOR-GUIDE.md.`;

export async function runStart(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(help); return; }
  if (args.includes("--help")) throw new Error("Use --help on its own");
  await runServer(parseOptions(args));
}
if (import.meta.main) {
  try { await runStart(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; }
}
