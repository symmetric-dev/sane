import { createSaneWorkstream } from "./create-sane-workstream.ts"
import {
  SaneRepositoryError,
  resolveSafeWorkstreamPath,
  resolveSaneRepository,
  validateCurrentSelectionDestination,
  writeCurrentWorkstream,
} from "./sane-repository.ts"
import { type WorkstreamType, WorkstreamTypeError, validateWorkstreamType } from "./workstream-type.ts"

export interface CreateRepositoryWorkstreamOptions {
  implementationRepository: string
  workstreamPath: string
  type: string
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
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
  // Reject unrelated selection data before bootstrap, but do not write it until
  // the bootstrap's staging rename has completed successfully.
  await validateCurrentSelectionDestination(pointer.implementationRepository)
  const result = await createSaneWorkstream({
    destination: workstream.path,
    type: workstreamType,
    templateRoot: options.templateRoot,
    dryRun: options.dryRun,
    write,
  })
  if (!result.dryRun) {
    await writeCurrentWorkstream(pointer.implementationRepository, workstream.relativePath)
    write(`Selected: ${workstream.relativePath}`)
  }
  return { dryRun: result.dryRun, relativePath: workstream.relativePath }
}

export const USAGE = "Usage: sane-alpha create-workstream <implementation-repository> <workstream-relative-path> --type <feature|foundation> [--dry-run]"

export function parseCliArguments(args: string[]): { implementationRepository: string; workstreamPath: string; type: string; dryRun: boolean } {
  let dryRun = false
  let type: string | undefined
  const positional: string[] = []
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
    else if (parseOptions && argument.startsWith("-")) throw new SaneRepositoryError(`Unknown option: ${argument}`)
    else positional.push(argument)
  }
  if (positional.length !== 2 || !positional[0] || !positional[1]) {
    throw new SaneRepositoryError("Provide an implementation repository and workstream relative path.")
  }
  if (!type) throw new SaneRepositoryError("Option --type is required.")
  return { implementationRepository: positional[0], workstreamPath: positional[1], type, dryRun }
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
