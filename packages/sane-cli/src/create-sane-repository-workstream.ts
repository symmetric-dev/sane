import { createSaneWorkstream } from "./create-sane-workstream.ts"
import {
  PHASES,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  setCurrentWorkstream,
  upsertStateEntry,
  upsertWorkstream,
} from "./sane-db.ts"
import {
  SaneRepositoryError,
  deleteLegacySelectionFile,
  resolveSafeWorkstreamPath,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { type WorkstreamType, WorkstreamTypeError, validateWorkstreamType } from "./workstream-type.ts"

export interface CreateRepositoryWorkstreamOptions {
  implementationRepository: string
  workstreamPath: string
  type: string
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
  /** Override the operating user for the DB identity (tests only; CLI uses the OS user). */
  userOverride?: string
}

export async function createSaneRepositoryWorkstream(options: CreateRepositoryWorkstreamOptions): Promise<{ dryRun: boolean; relativePath: string }> {
  const write = options.write ?? console.log
  let workstreamType: WorkstreamType
  try {
    workstreamType = validateWorkstreamType(options.type)
  } catch (error) {
    if (error instanceof WorkstreamTypeError) throw new SaneRepositoryError(error.message)
    throw error
  }
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveSafeWorkstreamPath(pointer.workstreamsRoot, options.workstreamPath)
  const result = await createSaneWorkstream({
    destination: workstream.path,
    type: workstreamType,
    templateRoot: options.templateRoot,
    dryRun: options.dryRun,
    write,
  })
  if (!result.dryRun) {
    // M2 P0 DB integration: record the workstream + initial pending phases.
    // Runs only after the staging rename succeeded, so a re-create of the same
    // workstream still fails with "Destination already exists" inside
    // createSaneWorkstream before any DB write (idempotent-safe ordering).
    const identity = await resolveSaneIdentity(
      pointer.implementationRepository,
      workstream.relativePath,
      options.userOverride,
    )
    const db = await openSaneDb(pointer.implementationRepository)
    try {
      initSchema(db)
      const mutation = {
        actorRole: "system",
        sessionId: `create:${identity.workstreamId}`,
      }
      upsertWorkstream(
        db,
        identity,
        { type: workstreamType, status: "open" },
        mutation,
      )
      for (const phase of PHASES) {
        upsertStateEntry(
          db,
          identity,
          { phase, status: "pending", ownerRole: phase },
          mutation,
        )
      }
      setCurrentWorkstream(
        db,
        {
          repoRoot: identity.repoRoot,
          user: identity.user,
          workstreamId: identity.workstreamId,
        },
        mutation,
      )
    } finally {
      try {
        db.close()
      } catch {
        // Best effort; close is idempotent for create flows.
      }
    }
    // Remove the retired file pointer when present; ignore when absent.
    try {
      await deleteLegacySelectionFile(pointer.implementationRepository)
    } catch {
      // Best effort cleanup; creation already succeeded.
    }
    write(`Selected: ${workstream.relativePath}`)
  }
  return { dryRun: result.dryRun, relativePath: workstream.relativePath }
}

export const USAGE = "Usage: sane create --name <workstream-name> --type <feature|foundation|issue|maintenance> [--dry-run] (run from the repository root)"

export function parseCliArguments(args: string[]): { implementationRepository: string; workstreamPath: string; type: string; dryRun: boolean } {
  let dryRun = false
  let type: string | undefined
  let name: string | undefined
  let parseOptions = true
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") parseOptions = false
    else if (parseOptions && argument === "--dry-run") dryRun = true
    else if (parseOptions && argument === "--type") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw new SaneRepositoryError("Option --type requires a value.")
      if (type) throw new SaneRepositoryError("Option --type may be provided only once.")
      try {
        type = validateWorkstreamType(value)
      } catch (error) {
        if (error instanceof WorkstreamTypeError) throw new SaneRepositoryError(error.message)
        throw error
      }
      index += 1
    }
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
  if (!type) throw new SaneRepositoryError("Option --type is required.")
  return { implementationRepository: process.cwd(), workstreamPath: name, type, dryRun }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await createSaneRepositoryWorkstream(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
