/**
 * CLI: Revision Command
 *
 * Add a revision stage to the workstream plan
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { appendRevisionStage } from "../lib/fix.ts"
import { getApprovalStatus, revokeApproval } from "../lib/approval.ts"

interface RevisionCliArgs {
  repoRoot?: string
  streamId?: string
  name: string
  description?: string
  afterStage?: number
}

function printHelp(): void {
  console.log(`
work revision - Add a revision stage to a workstream

Usage:
  work revision --name <name> [options]

Required:
  --name           Name of the revision (e.g., "documentation-updates")

Optional:
  --after-stage    Insert the revision after this stage number
                   (e.g. 3 inserts after Stage 03). Defaults to append.
  --stream, -s     Workstream ID or name (uses current if not specified)
  --description    Description of the revision changes
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  work revision --name "documentation-updates"
  work revision --name "post-stage-review" --after-stage 3
  work revision --name "code-review-feedback" --description "Address reviewer comments"
`)
}

function parseCliArgs(argv: string[]): RevisionCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<RevisionCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--name":
        if (!next) {
          console.error("Error: --name requires a value")
          return null
        }
        parsed.name = next
        i++
        break

      case "--description":
        if (!next) {
          console.error("Error: --description requires a value")
          return null
        }
        parsed.description = next
        i++
        break

      case "--after-stage":
        if (!next) {
          console.error("Error: --after-stage requires a value")
          return null
        }
        parsed.afterStage = parseInt(next, 10)
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  if (!parsed.name) {
    console.error("Error: --name is required")
    return null
  }
  if (parsed.afterStage !== undefined && isNaN(parsed.afterStage)) {
    console.error("Error: --after-stage must be a number")
    return null
  }

  return parsed as RevisionCliArgs
}

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let stream
  try {
    stream = getResolvedStream(index, cliArgs.streamId)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  try {
    const result = appendRevisionStage(repoRoot, stream.id, {
      name: cliArgs.name,
      description: cliArgs.description,
      afterStage: cliArgs.afterStage,
    })

    if (result.success) {
      // Revisions invalidate plan approval until the revised plan is approved again.
      let revokedPlan = false
      if (getApprovalStatus(stream) === "approved") {
        revokeApproval(repoRoot, stream.id, `revision: ${cliArgs.name}`)
        revokedPlan = true
      }

      console.log(result.message)
      if (revokedPlan) {
        console.log(`  Plan approval revoked for revision`)
      }
      console.log(`\nEdit the revised stage planning details, then run 'work approve revision'`)
    } else {
      console.error(`Error: ${result.message}`)
      process.exit(1)
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
