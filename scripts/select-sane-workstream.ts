import {
  SaneRepositoryError,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
  writeCurrentWorkstream,
} from "./sane-repository.ts"

export interface SelectWorkstreamOptions {
  implementationRepository: string
  workstreamPath: string
  dryRun?: boolean
  write?: (line: string) => void
}

export async function selectSaneWorkstream(options: SelectWorkstreamOptions): Promise<{ dryRun: boolean; relativePath: string }> {
  const write = options.write ?? console.log
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(pointer.workstreamsRoot, options.workstreamPath)
  if (options.dryRun) {
    write("Dry run: no files were modified.")
    write(`Planned: select ${workstream.relativePath}`)
    return { dryRun: true, relativePath: workstream.relativePath }
  }
  const changed = await writeCurrentWorkstream(pointer.implementationRepository, workstream.relativePath)
  write(`${changed ? "Selected" : "Already selected"}: ${workstream.relativePath}`)
  return { dryRun: false, relativePath: workstream.relativePath }
}

export const USAGE = "Usage: sane-alpha select-workstream <implementation-repository> <workstream-relative-path> [--dry-run]"

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
    await selectSaneWorkstream(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
