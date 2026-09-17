/**
 * SANE `sane provide <phase>` command.
 *
 * Provisions the minimal base file/path changes a phase needs before its
 * agents start: ensures the phase directory exists and copies a single
 * starter file from the workstream's `resources/` templates when the phase
 * has no documents yet. Never overwrites. Agents duplicate or adjust the
 * starter from there. The workstream is auto-detected from the current
 * directory: agents never pass paths to this command.
 *
 * - design: ensures `design/SDD.md` (the typed root doc always exists from
 *   `create`; a missing root doc is an error, not something to invent).
 * - engineering: ensures `design/solutions/` plus a `design/solutions/SOLUTION.md`
 *   starter when empty.
 * - planning: ensures `execution/`, `execution/jobs/`, plus an `execution/PLAN.md`
 *   starter when missing. (Job specs are authored by agents.)
 * - execution: ensures `execution/`, `execution/reports/`, plus an
 *   `execution/FINAL_REPORT.md` starter when missing. (Reports are authored by
 *   workers.)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { getWorkstream, initSchema, openSaneDb, resolveSaneIdentity } from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  ROOT_DOC_BY_TYPE,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { VALIDATE_PHASES, type ValidatePhase } from "./sane-validate-command.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

const PROVIDE_PHASE_SET = new Set<string>(VALIDATE_PHASES)

export interface SaneProvideCommandOptions {
  implementationRepository: string
  workstreamPath: string
  phase: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneProvideCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  phase: ValidatePhase
  created: string[]
  existed: string[]
}

export const USAGE =
  "Usage: sane provide <design|engineering|planning|execution> [--json] (auto-detects the workstream from the current directory; never overwrites)"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  phase: string
  json: boolean
} {
  let json = false
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length !== 1 || !positional[0]) {
    throw new SaneWorkstreamStateError(
      `Provide exactly one phase. Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  const phase = positional[0]
  if (!PROVIDE_PHASE_SET.has(phase)) {
    throw new SaneWorkstreamStateError(
      `Invalid phase "${phase}". Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  // Bare invocation: the async run path auto-detects the target from CWD.
  return { implementationRepository: "", workstreamPath: "", phase, json }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".md")).sort()
  } catch {
    return []
  }
}

export async function runSaneProvideCommand(
  options: SaneProvideCommandOptions,
): Promise<SaneProvideCommandResult> {
  const write = options.write ?? console.log
  if (!PROVIDE_PHASE_SET.has(options.phase)) {
    throw new SaneWorkstreamStateError(
      `Invalid phase "${options.phase}". Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  const phase = options.phase as ValidatePhase
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  )
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  )
  const db = await openSaneDb(pointer.implementationRepository)
  try {
    initSchema(db)
    const dbRow = getWorkstream(db, identity)
    if (!dbRow) {
      throw new SaneWorkstreamStateError(
        `No workstream row for ${identity.workstreamId} (repo ${identity.repoRoot} user ${identity.user}). Re-create the workstream so its type is recorded in sqlite.`,
      )
    }
    if (dbRow.type !== workstream.type) {
      throw new SaneWorkstreamStateError(
        `Workstream type mismatch: sqlite has type "${dbRow.type}" but the filesystem root doc implies "${workstream.type}". Re-create the workstream or fix the root doc.`,
      )
    }
    const workstreamType = dbRow.type
    const created: string[] = []
    const existed: string[] = []

    async function ensureStarter(relativePath: string, template: string): Promise<void> {
      if (await exists(join(workstream.path, relativePath))) {
        existed.push(relativePath)
        return
      }
      const templatePath = join(workstream.path, template)
      if (!(await exists(templatePath))) {
        throw new SaneWorkstreamStateError(
          `Template missing: ${template} (workstream resources are incomplete).`,
        )
      }
      await mkdir(dirname(join(workstream.path, relativePath)), { recursive: true })
      await writeFile(join(workstream.path, relativePath), await readFile(templatePath))
      created.push(relativePath)
    }

    switch (phase) {
      case "design": {
        const root = ROOT_DOC_BY_TYPE[workstreamType]
        if (!(await exists(join(workstream.path, root)))) {
          throw new SaneWorkstreamStateError(
            `Root doc missing: ${root} (re-create the workstream; provide never invents it).`,
          )
        }
        existed.push(root)
        await mkdir(join(workstream.path, "design"), { recursive: true })
        await ensureStarter("design/SDD.md", "resources/SDD_TEMPLATE.md")
        break
      }
      case "engineering": {
        await mkdir(join(workstream.path, "design", "solutions"), { recursive: true })
        if ((await listMarkdownFiles(join(workstream.path, "design", "solutions"))).length === 0) {
          await ensureStarter("design/solutions/SOLUTION.md", "resources/SOLUTION_SPEC_TEMPLATE.md")
        } else {
          existed.push("design/solutions/")
        }
        break
      }
      case "planning": {
        await mkdir(join(workstream.path, "execution", "jobs"), { recursive: true })
        await ensureStarter("execution/PLAN.md", "resources/PLAN_TEMPLATE.md")
        break
      }
      case "execution": {
        await mkdir(join(workstream.path, "execution", "reports"), { recursive: true })
        await ensureStarter("execution/FINAL_REPORT.md", "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md")
        break
      }
    }

    const result: SaneProvideCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      phase,
      created,
      existed,
    }
    if (options.json === true) {
      write(JSON.stringify({ ...result }, null, 2))
    } else if (created.length === 0) {
      write(`${phase} already provided for ${result.workstreamId}`)
    } else {
      for (const path of created) write(`Created: ${path}`)
    }
    return result
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed)
    await runSaneProvideCommand({ ...parsed, ...address })
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
