import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fail } from "./errors.ts"

/** Cooperative only. Never steal even a demonstrably stale owner's lock. */
export function acquireArtifactLock(stateRoot: string, id: string): () => void {
  const root = join(stateRoot, "locks"), path = join(root, `${id}.lock`)
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_ARTIFACT", `Unsafe lock directory ${root}`)
  const token = randomUUID()
  let start: string
  try { start = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim() }
  catch { return fail("BUSY", "Cannot obtain process-start evidence for artifact lock.") }
  if (!start) fail("BUSY", "Cannot verify process-start evidence.")
  try { mkdirSync(path, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("BUSY", `Artifact lock exists at ${path}; live, stale or unverifiable ownership requires inspection; no automatic theft.`)
    throw error
  }
  const owned = lstatSync(path)
  try { writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, processStart: start, token, workstreamId: id, stateRoot }), { flag: "wx", mode: 0o600 }) }
  catch (error) { throw error } // Preserve incomplete ownership evidence; no unsafe cleanup.
  return () => {
    const current = lstatSync(path)
    const owner = lstatSync(join(path, "owner.json"))
    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino || !owner.isFile() || owner.nlink !== 1 || JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token !== token) fail("BUSY", `Artifact lock ownership changed: ${path}`)
    if (readdirSync(path).some(name => name !== "owner.json")) fail("BUSY", `Unexpected contents preserved in artifact lock: ${path}`)
    unlinkSync(join(path, "owner.json"))
    // Never recursively remove content arriving after the check above.
    try { rmdirSync(path) } catch (error) { fail("BUSY", `Artifact lock directory retained; unexpected contents or changed ownership: ${path}: ${(error as Error).message}`) }
  }
}
