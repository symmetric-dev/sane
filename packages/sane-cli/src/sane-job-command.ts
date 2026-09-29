import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export { unavailable as buildJobBundle } from "./unavailable.ts"
export const runSaneJobCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["job", ...args], runtime)
export const runSaneJobViewCommand = runSaneJobCommand
export const runSaneJobRegisterCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["job", "--register", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["job", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
