import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const selectSaneWorkstream = (args: string[], runtime?: CliRuntime) => executeCliCommand(["select", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["select", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
