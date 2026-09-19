/**
 * SANE `sane validate <phase>` command.
 *
 * Validates the documents a phase owns, resolved by workstream
 * auto-detection (bare invocation from the session working directory).
 * Agents never pass paths to this command; paths are only for
 * reading/editing files.
 *
 * Phase expectations (path-based):
 * - design: exactly the typed root doc plus `design/SDD.md`.
 * - engineering: one or more `design/solutions/*.md`.
 * - planning: `execution/PLAN.md` plus one or more `execution/jobs/*.md`.
 * - execution: `execution/FINAL_REPORT.md` plus one or more
 *   `execution/reports/*.md`.
 *
 * Content rules per file: must exist, must be non-empty, and must contain
 * no `<!--` guidance comments (every template carries them with an
 * instruction to replace them, so an unedited template always fails).
 * Root docs have no template copy in `resources/`; the same three rules
 * apply uniformly.
 *
 * Research index divergences and approved-but-changed docs are warnings,
 * never failures. `sane approve <phase>` runs this validation first
 * and refuses to record when problems exist.
 */
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  getApproval,
  getWorkstream,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
} from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { sha256Hex } from "./sane-hash.ts"
import {
  ROOT_DOC_BY_TYPE,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import type { WorkstreamType } from "./workstream-type.ts"
import { recheckResearchIndex } from "./sane-workstream-state.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export const VALIDATE_PHASES = ["design", "engineering", "planning", "execution"] as const
export type ValidatePhase = (typeof VALIDATE_PHASES)[number]

const VALIDATE_PHASE_SET = new Set<string>(VALIDATE_PHASES)

const ROOT_DOCS: readonly string[] = ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"]

/** Workstream-relative doc required by a phase. */
interface PhaseDocSpec {
  path: string
}

function expectedDocs(phase: ValidatePhase, type: WorkstreamType): PhaseDocSpec[] {
  switch (phase) {
    case "design":
      return [{ path: ROOT_DOC_BY_TYPE[type] }, { path: "design/SDD.md" }]
    case "engineering":
      return [{ path: "design/solutions/" }]
    case "planning":
      return [{ path: "execution/PLAN.md" }, { path: "execution/jobs/" }]
    case "execution":
      return [{ path: "execution/FINAL_REPORT.md" }, { path: "execution/reports/" }]
  }
}

export interface ValidatePhaseResult {
  repoRoot: string
  user: string
  workstreamId: string
  phase: ValidatePhase
  /** Workstream-relative paths that passed validation. */
  files: string[]
  /** Composite hash over the validated files (sorted `path:hash`). */
  hash: string
  problems: string[]
  warnings: string[]
  ok: boolean
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const bytes = await readFile(path)
    return bytes.length >= 0
  } catch {
    return false
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".md")).sort()
  } catch {
    return []
  }
}

/**
 * Validate one phase's documents inside an already-resolved workstream
 * directory. Pure logic shared by `validate` and `approve`.
 */
export async function validatePhaseDocs(
  db: import("bun:sqlite").Database,
  identity: { repoRoot: string; user: string; workstreamId: string },
  workstreamDir: string,
  phase: ValidatePhase,
  type: WorkstreamType,
): Promise<ValidatePhaseResult> {
  const problems: string[] = []
  const warnings: string[] = []
  const files: string[] = []
  const hashes: string[] = []

  async function checkFile(relativePath: string): Promise<void> {
    const full = join(workstreamDir, relativePath)
    const content = await readIfExists(full)
    if (content === null) {
      problems.push(`missing: ${relativePath}`)
      return
    }
    if (content.trim() === "") {
      problems.push(`empty: ${relativePath}`)
      return
    }
    if (content.includes("<!--")) {
      problems.push(`unresolved guidance comments (<!-- -->) in: ${relativePath}`)
      return
    }
    files.push(relativePath)
    hashes.push(`${relativePath}:${sha256Hex(content)}`)
  }

  if (phase === "design") {
    const expectedRoot = ROOT_DOC_BY_TYPE[type]
    for (const root of ROOT_DOCS) {
      if (root === expectedRoot) continue
      if (await fileExists(join(workstreamDir, root))) {
        problems.push(`unexpected root doc for type ${type}: ${root} (exactly one root doc allowed)`)
      }
    }
    for (const spec of expectedDocs(phase, type)) {
      await checkFile(spec.path)
    }
  } else {
    for (const spec of expectedDocs(phase, type)) {
      if (!spec.path.endsWith("/")) {
        await checkFile(spec.path)
        continue
      }
      const names = await listMarkdownFiles(join(workstreamDir, spec.path))
      if (names.length === 0) {
        problems.push(`no documents in: ${spec.path}`)
        continue
      }
      for (const name of names) {
        await checkFile(`${spec.path}${name}`)
      }
    }
  }

  // Research index divergences are warnings (pickup absorption).
  try {
    const researchIndex = await recheckResearchIndex(
      db,
      { repoRoot: identity.repoRoot, user: identity.user, workstreamId: identity.workstreamId },
      workstreamDir,
    )
    for (const mismatch of researchIndex.mismatches) warnings.push(mismatch)
  } catch {
    // Research check is best-effort; document problems decide validity.
  }

  // Approved-but-changed docs warn (approvals stay authority).
  const approval = getApproval(
    db,
    { repoRoot: identity.repoRoot, user: identity.user, workstreamId: identity.workstreamId },
    phase,
  )
  const hash = sha256Hex([...hashes].sort().join("\n"))
  if (approval && approval.sane_hash !== hash) {
    warnings.push(
      `${phase} is approved (${approval.approval_ref}) but its documents changed since approval; re-approve to refresh authority.`,
    )
  }

  files.sort()
  return {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    phase,
    files,
    hash,
    problems,
    warnings,
    ok: problems.length === 0,
  }
}

export interface SaneValidateCommandOptions {
  implementationRepository: string
  workstreamPath: string
  phase: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane validate <design|engineering|planning|execution> [--json] (auto-detects the workstream from the current directory)"

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
  if (!VALIDATE_PHASE_SET.has(phase)) {
    throw new SaneWorkstreamStateError(
      `Invalid phase "${phase}". Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  // Bare invocation: the async run path auto-detects the target from CWD.
  return { implementationRepository: "", workstreamPath: "", phase, json }
}

export async function runSaneValidateCommand(
  options: SaneValidateCommandOptions,
): Promise<ValidatePhaseResult> {
  const write = options.write ?? console.log
  if (!VALIDATE_PHASE_SET.has(options.phase)) {
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
        `No workstream row for ${identity.workstreamId} (repo ${identity.repoRoot} user ${identity.user}). Re-create the workstream so its type is recorded in SANE state.`,
      )
    }
    if (dbRow.type !== workstream.type) {
      throw new SaneWorkstreamStateError(
        `Workstream type mismatch: SANE state has type "${dbRow.type}" but the filesystem root doc implies "${workstream.type}". Re-create the workstream or fix the root doc.`,
      )
    }
    const result = await validatePhaseDocs(db, identity, workstream.path, phase, dbRow.type)
    if (options.json === true) {
      write(JSON.stringify({ ...result }, null, 2))
    } else if (result.ok) {
      write(`Valid ${phase} for ${result.workstreamId}: ${result.files.length} document(s)`)
      for (const file of result.files) write(`  ok: ${file}`)
      for (const warning of result.warnings) write(`  warning: ${warning}`)
    } else {
      write(`Invalid ${phase} for ${result.workstreamId}:`)
      for (const problem of result.problems) write(`  problem: ${problem}`)
      for (const warning of result.warnings) write(`  warning: ${warning}`)
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
    const result = await runSaneValidateCommand({ ...parsed, ...address })
    return result.ok ? 0 : 1
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
