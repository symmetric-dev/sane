import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const initializeSaneRepository = (args: string[], runtime?: CliRuntime) => executeCliCommand(["init", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["init", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
