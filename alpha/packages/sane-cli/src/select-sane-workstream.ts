import {
  SaneRepositoryError,
  deleteLegacySelectionFile,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import {
  getCurrentWorkstream,
  getWorkstream,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  setCurrentWorkstream,
} from "./sane-db.ts"

export interface SelectWorkstreamOptions {
  implementationRepository: string
  workstreamPath: string
  dryRun?: boolean
  write?: (line: string) => void
  /** Override the operating user for the DB identity (tests only; CLI uses the OS user). */
  userOverride?: string
}

export async function selectSaneWorkstream(options: SelectWorkstreamOptions): Promise<{ dryRun: boolean; relativePath: string }> {
  const write = options.write ?? console.log
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(pointer.workstreamsRoot, options.workstreamPath)
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  )
  const db = await openSaneDb(pointer.implementationRepository)
  let changed = true
  try {
    initSchema(db)
    const dbRow = getWorkstream(db, identity)
    if (!dbRow) {
      throw new SaneRepositoryError(
        `No workstream row for ${identity.workstreamId} (repo ${identity.repoRoot} user ${identity.user}). Re-create the workstream so its type is recorded in SANE state.`,
      )
    }
    if (dbRow.type !== workstream.type) {
      throw new SaneRepositoryError(
        `Workstream type mismatch: SANE state has type "${dbRow.type}" but the filesystem root doc implies "${workstream.type}". Re-create the workstream or fix the root doc.`,
      )
    }
    if (!options.dryRun) {
      const previous = getCurrentWorkstream(db, {
        repoRoot: identity.repoRoot,
        user: identity.user,
      })
      changed = !previous || previous.workstream_id !== workstream.relativePath
      setCurrentWorkstream(
        db,
        {
          repoRoot: identity.repoRoot,
          user: identity.user,
          workstreamId: workstream.relativePath,
        },
        {
          actorRole: "system",
          sessionId: `select:${identity.workstreamId}`,
        },
      )
    }
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
  if (options.dryRun) {
    write("Dry run: no files were modified.")
    write(`Planned: select ${workstream.relativePath}`)
    return { dryRun: true, relativePath: workstream.relativePath }
  }
  try {
    await deleteLegacySelectionFile(pointer.implementationRepository)
  } catch {
    // Best effort cleanup; selection already succeeded.
  }
  write(`${changed ? "Selected" : "Already selected"}: ${workstream.relativePath}`)
  return { dryRun: false, relativePath: workstream.relativePath }
}

export const USAGE = "Usage: sane select --name <workstream-name> [--dry-run] (run from the repository root)"

export function parseCliArguments(args: string[]): { implementationRepository: string; workstreamPath: string; dryRun: boolean } {
  let dryRun = false
  let name: string | undefined
  let parseOptions = true
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") parseOptions = false
    else if (parseOptions && argument === "--dry-run") dryRun = true
    else if (parseOptions && argument === "--name") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw new SaneRepositoryError("Option --name requires a value.")
      if (name) throw new SaneRepositoryError("Option --name may be provided only once.")
      name = value
      index += 1
    }
    else if (parseOptions && argument.startsWith("-")) throw new SaneRepositoryError(`Unknown option: ${argument}`)
    else throw new SaneRepositoryError("This command takes no positional arguments. Pass --name <workstream-name>.")
  }
  if (!name) throw new SaneRepositoryError("Option --name is required.")
  return { implementationRepository: process.cwd(), workstreamPath: name, dryRun }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await selectSaneWorkstream(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
