import { createSaneWorkstream } from "./create-sane-workstream.ts"
import {
  SaneRepositoryError,
  resolveSafeWorkstreamPath,
  resolveSaneRepository,
  validateCurrentSelectionDestination,
  writeCurrentWorkstream,
} from "./sane-repository.ts"

export interface CreateRepositoryWorkstreamOptions {
  implementationRepository: string
  workstreamPath: string
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
}

export async function createSaneRepositoryWorkstream(options: CreateRepositoryWorkstreamOptions): Promise<{ dryRun: boolean; relativePath: string }> {
  const write = options.write ?? console.log
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveSafeWorkstreamPath(pointer.workstreamRepository, options.workstreamPath)
  // Reject unrelated selection data before bootstrap, but do not write it until
  // the bootstrap's staging rename has completed successfully.
  await validateCurrentSelectionDestination(pointer.implementationRepository)
  const result = await createSaneWorkstream({
    destination: workstream.path,
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

export const USAGE = "Usage: bun alpha/scripts/create-sane-repository-workstream.ts <implementation-repository> <workstream-relative-path> [--dry-run]"

export function parseCliArguments(args: string[]): { implementationRepository: string; workstreamPath: string; dryRun: boolean } {
  let dryRun = false
  const positional: string[] = []
  let parseOptions = true
  for (const argument of args) {
    if (parseOptions && argument === "--") parseOptions = false
    else if (parseOptions && argument === "--dry-run") dryRun = true
    else if (parseOptions && argument.startsWith("-")) throw new SaneRepositoryError(`Unknown option: ${argument}`)
    else positional.push(argument)
  }
  if (positional.length !== 2 || !positional[0] || !positional[1]) {
    throw new SaneRepositoryError("Provide an implementation repository and workstream relative path.")
  }
  return { implementationRepository: positional[0], workstreamPath: positional[1], dryRun }
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
