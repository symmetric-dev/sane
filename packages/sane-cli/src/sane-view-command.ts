import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const runSaneViewCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["view", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["view", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
