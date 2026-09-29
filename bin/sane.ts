#!/usr/bin/env bun
import { runCliCommand, USAGE } from "../packages/sane-cli/src/cli-command.ts"
export { USAGE }
/** Kept for the managed ordinary wrapper installed by install-sane.ts. */
export async function runSaneAlpha(args: string[]): Promise<number> {
  if (args[0] === "install") {
    if (args[1] !== "context-packages") { console.error("Unknown install target; use sane install context-packages."); return 1 }
    const { runCli } = await import("../packages/sane-cli/src/install-sane-agent-context-packages.ts")
    return runCli(args.slice(2))
  }
  return runCliCommand(args)
}
if (import.meta.main) process.exitCode = await runSaneAlpha(Bun.argv.slice(2))
