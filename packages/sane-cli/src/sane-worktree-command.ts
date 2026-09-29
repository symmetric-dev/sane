import { unavailableCli } from "./unavailable.ts"
export { unavailable as createWorktree, unavailable as removeWorktree, unavailable as runSaneWorktreeCommand,
  unavailable as parseCliArguments, unavailable as defaultWorktreesDir, unavailable as normalizeWorkstreamSlug,
  unavailable as branchName, unavailable as worktreePath, unavailable as assertIsolatedCheckAllowed,
  unavailable as isIsolatedCheckAllowed } from "./unavailable.ts"
export const runCli = unavailableCli
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
