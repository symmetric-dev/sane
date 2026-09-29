import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const runSaneResearchCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["research", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["research", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
