import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export { unavailable as validatePhaseDocs } from "./unavailable.ts"
export const runSaneValidateCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["validate", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["validate", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
