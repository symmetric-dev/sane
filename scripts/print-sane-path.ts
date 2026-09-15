import { SaneRepositoryError, resolveSaneRepository } from "./sane-repository.ts"

export interface PrintSanePathOptions {
  implementationRepository: string
  write?: (line: string) => void
}

/** Print the paired SANE workstream repository's validated absolute path. */
export async function printSanePath(options: PrintSanePathOptions): Promise<string> {
  const repository = await resolveSaneRepository(options.implementationRepository)
  const write = options.write ?? console.log
  write(repository.workstreamRepository)
  return repository.workstreamRepository
}

export const USAGE = "Usage: sane-alpha sane-path <implementation-repository>"

export function parseCliArguments(args: string[]): { implementationRepository: string } {
  if (args.length !== 1 || !args[0]) {
    throw new SaneRepositoryError("Provide exactly one implementation repository path.")
  }
  return { implementationRepository: args[0] }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await printSanePath(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
