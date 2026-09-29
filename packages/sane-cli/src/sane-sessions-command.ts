import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const runSaneSessionsCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["sessions", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["sessions", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
