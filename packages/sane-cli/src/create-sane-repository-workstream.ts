import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const createSaneRepositoryWorkstream = (args: string[], runtime?: CliRuntime) => executeCliCommand(["create", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["create", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
