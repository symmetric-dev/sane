import { resolveAppConfig } from "./src/app-config";
import { claudeSourceRoot } from "./src/claude-source";

export const help = `Usage: bun run start:app [options]
Validates or builds assets and starts one foreground App server per installation.
Run bun run setup:app first to save config and initialize fresh App state.
  --config PATH             Saved config (default: packages/sane-app/.config.json)
  --cwd PATH --data-dir PATH Default execution directory and App history/catalog
  --host HOST --port PORT    Listener (default: 127.0.0.1:8787)
  --public-origin ORIGIN     Exact browser origin
  --clear-public-origin     Clear the saved public origin
  --allow-remote --no-allow-remote
  --claude-bin PATH --claude-profile PATH
  --opencode-registration PATH  Managed-local OpenCode registration file
  --max-concurrent-runs N    1–256 (default: 24)
  --no-build                Validate and serve the existing asset generation
  --context-delivery MODE   Legacy alias: canonical (default) or startup; both use shared user messages
  --reconcile-interrupted   Explicitly reclaim proven-dead ownership
  --initialize-app-admissions Explicit one-time receipt setup in the selected App data directory; then start
CLI overrides saved settings; CLI paths are invocation-relative, saved paths
are config-relative. No native services are installed or started.
Grok is configured only via setup:app --grok-home PATH --grok-bin ABSOLUTE
  --grok-model STRING --grok-effort STRING (stop the App first; see setup:app --help).
Startup never publishes Grok source pins or exposes its Base profile.
SANE_APP_PROFILE=1 captures 60 seconds of App CPU/event-loop diagnostics.
See packages/sane-app/PROFILING.md and HUMAN-OPERATOR-GUIDE.md.`;

export async function runStart(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(help); return; }
  if (args.includes("--help")) throw new Error("Use --help on its own");
  const resolved = resolveAppConfig(args, { packageDir: import.meta.dir, invocationCwd: process.cwd() });
  const claudeRoot = resolved.config.native.claude.profileRoot;
  if (process.env.CLAUDE_CONFIG_DIR !== undefined && claudeSourceRoot() !== claudeRoot) throw new Error("Contradictory native selector: CLAUDE_CONFIG_DIR");
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) throw new Error("Unsupported native selector: CLAUDE_CODE_PROJECT_DIR_NAME");
  // SDK transcript helpers have no profile-root option and memoize their native
  // root. Bind this App process BEFORE importing bridge/SDK, just as owned CLI
  // children already bind their environment. Never rewrite native configuration
  // or bypass the source checks around history reads and forks.
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;
  const { runtimeOptions } = await import("./src/bridge");
  const { runServer } = await import("./server");
  await runServer(runtimeOptions(resolved));
}
if (import.meta.main) {
  try { await runStart(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; }
}
