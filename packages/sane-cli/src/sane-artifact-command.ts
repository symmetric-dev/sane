/**
 * SANE 0.2.0 M2 P0: `sane-alpha artifact` stub command.
 *
 * P0 scope is wiring only: validate the bootstrapped workstream and report the
 * stub outcome (no template copy yet; P0 `state`/`status`/`pickup` carry the
 * render + check behavior). Supports `--json` and `--repo-root` detection
 * idioms matching existing CLIs so the dispatcher shape is stable for P1
 * (approvals/baseline/registry/handoff) and P2 (worktree/merge).
 *
 * New file only (M2 wiring P0).
 */
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export interface SaneArtifactCommandOptions {
  implementationRepository: string
  workstreamPath: string
  json?: boolean
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane-alpha artifact <implementation-repository> <workstream-relative-path> [--json] [--repo-root <path>]"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  json: boolean
} {
  let json = false
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneWorkstreamStateError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneWorkstreamStateError(
        "Provide exactly one workstream relative path when --repo-root is used.",
      )
    }
    return {
      implementationRepository: repoRootOpt,
      workstreamPath: positional[0],
      json,
    }
  }

  if (positional.length === 2 && positional[0] && positional[1]) {
    return {
      implementationRepository: positional[0],
      workstreamPath: positional[1],
      json,
    }
  }
  if (positional.length === 1 && positional[0]) {
    return { implementationRepository: process.cwd(), workstreamPath: positional[0], json }
  }
  throw new SaneWorkstreamStateError(
    "Provide an implementation repository and workstream relative path.",
  )
}

/** Validate the workstream and report the P0 stub outcome. */
export async function runSaneArtifactCommand(
  options: SaneArtifactCommandOptions,
): Promise<{ repoRoot: string; workstreamId: string; stub: true }> {
  const write = options.write ?? console.log
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  )
  const result = {
    repoRoot: pointer.implementationRepository,
    workstreamId: workstream.relativePath,
    stub: true as const,
  }
  if (options.json === true) {
    write(
      JSON.stringify(
        {
          repo_root: result.repoRoot,
          workstream_id: result.workstreamId,
          stub: true,
          note: "artifact copy is a P0 stub; no files were copied",
        },
        null,
        2,
      ),
    )
  } else {
    write(`Artifact stub: no copy performed for ${result.workstreamId}`)
  }
  return result
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    await runSaneArtifactCommand(parsed)
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
