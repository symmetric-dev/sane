import { unavailableCli } from "./unavailable.ts"
export { unavailable as mergeProtocol, unavailable as runSaneMergeCommand, unavailable as parseCliArguments,
  unavailable as assertMergeStepOrder, unavailable as checkConflictScope } from "./unavailable.ts"
export const runCli = unavailableCli
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
