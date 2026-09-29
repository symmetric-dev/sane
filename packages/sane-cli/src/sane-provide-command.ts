import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export { unavailable as refreshResourceTemplates } from "./unavailable.ts"
export const runSaneProvideCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["provide", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["provide", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
