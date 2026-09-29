import { unavailableCli } from "./unavailable.ts"
export { unavailable as runSaneLinkCommand, unavailable as parseCliArguments } from "./unavailable.ts"
export const runCli = unavailableCli
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
