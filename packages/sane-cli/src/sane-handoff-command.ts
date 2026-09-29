import { unavailableCli } from "./unavailable.ts"
export { unavailable as sendHandoff, unavailable as resolveOrCreateSession, unavailable as renameReady,
  unavailable as runSaneHandoffCommand, unavailable as parseCliArguments,
  unavailable as assistantAgentForSlot, unavailable as serverAuthHeaders,
  unavailable as composeHandoff, unavailable as readyTitle } from "./unavailable.ts"
export const runCli = unavailableCli
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
