import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const runSaneStatusCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["status", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["status", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
