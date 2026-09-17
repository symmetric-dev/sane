import { execFile } from "node:child_process"
import { lstat, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { BootstrapError } from "./create-sane-workstream.ts"
import type { WorkstreamType } from "./workstream-type.ts"

const execFileAsync = promisify(execFile)
export const SANE_DIRECTORY_NAME = ".sane"
export const WORKSTREAMS_DIRECTORY_NAME = "workstreams"
/**
 * Workstream bootstrap shape (docs/SANE_0_2_0.md Section 1).
 *
 * Fixed roots plus the resources set. The per-type root document is
 * validated separately via ROOT_DOC_BY_TYPE (exactly one present; type is
 * inferred from which root doc exists and stored in sqlite, not in a `type`
 * file). This list coordinates with create-sane-workstream.ts
 * initialTemplateRegistry without editing that registry here.
 */
export const REQUIRED_WORKSTREAM_FILES = [
  "README.md",
  "design/SDD.md",
  "resources/SDD_TEMPLATE.md",
  "resources/SOLUTION_SPEC_TEMPLATE.md",
  "resources/RESEARCH_REPORT_TEMPLATE.md",
  "resources/PLAN_TEMPLATE.md",
  "resources/JOB_TEMPLATE.md",
  "resources/EXECUTION_REPORT_TEMPLATE.md",
  "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md",
] as const

export const ROOT_DOC_BY_TYPE: Record<WorkstreamType, string> = {
  feature: "PRD.md",
  foundation: "FOUNDATION.md",
  issue: "ISSUE.md",
  maintenance: "MAINTENANCE.md",
}

export const ROOT_DOC_CANDIDATES = ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"] as const

/**
 * Previous-layout artifacts (pre-migration paths). Presence of any of these
 * fails validation with an old-layout error so a stale workstream never
 * passes as the current layout. Top-level dirs are exactly design/,
 * execution/, research/, resources/.
 */
export const OLD_WORKSTREAM_FILES = [
  "SANE_CONTEXT.md",
  "SDD.md",
  "execution/BRIEF.md",
] as const

export const OLD_WORKSTREAM_DIRS = ["solutions", "plan", "planning"] as const

/**
 * Retired Stage-model artifacts (SANE 0.2.0 Section 1, Explicit Non-Goals).
 * Presence of any of these fails validation so an old Stage layout never
 * passes as a current workstream.
 */
export const RETIRED_WORKSTREAM_FILES = [
  "resources/IMPLEMENTATION_REPORT_TEMPLATE.md",
  "resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md",
  "resources/SECTION_SPEC_TEMPLATE.md",
  "resources/ROOT_DESIGN_SPEC_TEMPLATE.md",
  "resources/STAGES_TEMPLATE.md",
  "resources/STAGE_DESIGN_SPEC_TEMPLATE.md",
  "resources/STAGE_SECTIONS_TEMPLATE.md",
  "resources/EXECUTION_PLAN_TEMPLATE.md",
] as const

export class SaneRepositoryError extends BootstrapError {
  constructor(message: string) {
    super(message)
    this.name = "SaneRepositoryError"
  }
}

export interface SaneRepository {
  implementationRepository: string
  workstreamsRoot: string
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" })
  return stdout.trim()
}

/** Resolve an existing directory to the root of its Git working tree. */
export async function resolveImplementationRepository(path: string): Promise<string> {
  const requestedPath = resolve(path)
  if (!(await lstatOrUndefined(requestedPath))?.isDirectory()) {
    throw new SaneRepositoryError(
      `Implementation repository path must be an existing directory: ${requestedPath}`,
    )
  }
  try {
    return resolve(await runGit(["-C", requestedPath, "rev-parse", "--show-toplevel"]))
  } catch {
    throw new SaneRepositoryError(
      `Implementation repository is not a Git working tree: ${requestedPath}`,
    )
  }
}

/** Derive the canonical workstreams root for an implementation repository. */
export function saneWorkstreamsRoot(implementationRepository: string): string {
  return join(implementationRepository, SANE_DIRECTORY_NAME, WORKSTREAMS_DIRECTORY_NAME)
}

export async function resolveSaneRepository(path: string): Promise<SaneRepository> {
  const implementationRepository = await resolveImplementationRepository(path)
  const legacyPathsPath = join(implementationRepository, SANE_DIRECTORY_NAME, "paths")
  if (await lstatOrUndefined(legacyPathsPath)) {
    throw new SaneRepositoryError(
      `Legacy .sane/paths file exists at ${legacyPathsPath}. Move workstreams into .sane/workstreams/ and delete this file.`,
    )
  }
  const workstreamsRoot = saneWorkstreamsRoot(implementationRepository)
  if (!(await lstatOrUndefined(workstreamsRoot))?.isDirectory()) {
    throw new SaneRepositoryError(
      `SANE workstreams directory is missing or not a directory: ${workstreamsRoot}. Run init-sane first.`,
    )
  }
  return { implementationRepository, workstreamsRoot }
}

function assertLexicallyContained(root: string, target: string, description: string): void {
  const rootRelative = relative(root, target)
  if (rootRelative === "" || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
    throw new SaneRepositoryError(`${description} must resolve to a path within "${root}".`)
  }
}

async function assertExistingAncestorContained(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root)
  let existingAncestor = target
  while (!(await lstatOrUndefined(existingAncestor))) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const ancestorRelative = relative(realRoot, await realpath(existingAncestor))
  if (ancestorRelative === ".." || ancestorRelative.startsWith(`..${sep}`)) {
    throw new SaneRepositoryError("Workstream path resolves outside .sane/workstreams.")
  }
}

/**
 * Resolve a user path without accepting a traversal component. Existing
 * ancestors are also realpath-checked so a symlink cannot redirect a new file
 * outside the workstreams root.
 */
export async function resolveSafeWorkstreamPath(
  workstreamsRoot: string,
  requestedPath: string,
): Promise<{ relativePath: string; path: string }> {
  if (!requestedPath || requestedPath.trim() === "" || isAbsolute(requestedPath)) {
    throw new SaneRepositoryError("Workstream path must be a non-empty relative path.")
  }
  if (requestedPath.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    throw new SaneRepositoryError("Workstream path must not contain traversal segments.")
  }
  const relativePath = normalize(requestedPath)
  if (relativePath === "." || relativePath === "" || isAbsolute(relativePath)) {
    throw new SaneRepositoryError("Workstream path must be a non-empty relative path.")
  }
  const path = resolve(workstreamsRoot, relativePath)
  assertLexicallyContained(workstreamsRoot, path, "Workstream path")

  await assertExistingAncestorContained(workstreamsRoot, path)
  return { relativePath, path }
}

const ROOT_DOC_TO_TYPE: Record<string, WorkstreamType> = {
  "PRD.md": "feature",
  "FOUNDATION.md": "foundation",
  "ISSUE.md": "issue",
  "MAINTENANCE.md": "maintenance",
}

/** Ensure a candidate is an existing workstream bootstrap (type inferred from root doc). */
export async function validateBootstrappedWorkstream(path: string): Promise<WorkstreamType> {
  if (!(await lstatOrUndefined(path))?.isDirectory()) {
    throw new SaneRepositoryError(`Workstream is not an existing directory: ${path}`)
  }
  for (const filename of RETIRED_WORKSTREAM_FILES) {
    if ((await lstatOrUndefined(join(path, filename)))?.isFile()) {
      throw new SaneRepositoryError(
        `Workstream contains retired Stage artifact and is not a current workstream: ${join(path, filename)}`,
      )
    }
  }
  for (const filename of OLD_WORKSTREAM_FILES) {
    if ((await lstatOrUndefined(join(path, filename)))?.isFile()) {
      throw new SaneRepositoryError(
        `Workstream contains old-layout file ${filename} at ${join(path, filename)}; expected new layout with README.md, design/SDD.md, design/solutions/, execution/PLAN.md, execution/jobs/, execution/FINAL_REPORT.md, execution/reports/. Re-create the workstream with the current bootstrap.`,
      )
    }
  }
  for (const dirname of OLD_WORKSTREAM_DIRS) {
    if (await lstatOrUndefined(join(path, dirname))) {
      throw new SaneRepositoryError(
        `Workstream contains old-layout directory ${dirname}/ at ${join(path, dirname)}; expected new layout with top-level dirs exactly design/, execution/, research/, resources/. Re-create the workstream with the current bootstrap.`,
      )
    }
  }
  for (const filename of REQUIRED_WORKSTREAM_FILES) {
    if (!(await lstatOrUndefined(join(path, filename)))?.isFile()) {
      throw new SaneRepositoryError(`Workstream is not bootstrapped; missing regular file: ${join(path, filename)}`)
    }
  }
  const present = (
    await Promise.all(
      ROOT_DOC_CANDIDATES.map(async (candidate) =>
        (await lstatOrUndefined(join(path, candidate)))?.isFile() ? candidate : null,
      ),
    )
  ).filter((candidate): candidate is (typeof ROOT_DOC_CANDIDATES)[number] => candidate !== null)
  if (present.length === 0) {
    throw new SaneRepositoryError(
      `Workstream is not bootstrapped; missing root document (exactly one of ${ROOT_DOC_CANDIDATES.join(", ")} required): ${path}`,
    )
  }
  if (present.length > 1) {
    throw new SaneRepositoryError(
      `Workstream must contain exactly one root document; found ${present.join(", ")} in ${path}`,
    )
  }
  return ROOT_DOC_TO_TYPE[present[0]!]!
}

export async function resolveBootstrappedWorkstream(
  workstreamsRoot: string,
  requestedPath: string,
): Promise<{ relativePath: string; path: string; type: WorkstreamType }> {
  const workstream = await resolveSafeWorkstreamPath(workstreamsRoot, requestedPath)
  const type = await validateBootstrappedWorkstream(workstream.path)
  return { ...workstream, type }
}

function currentWorkstreamPath(implementationRepository: string): string {
  return join(implementationRepository, ".sane", "current-workstream")
}

/** Reject a symlink, directory, or other unrelated object before a later write. */
export async function validateCurrentSelectionDestination(
  implementationRepository: string,
): Promise<void> {
  const selectionPath = currentWorkstreamPath(implementationRepository)
  const stat = await lstatOrUndefined(selectionPath)
  if (stat && !stat.isFile()) {
    throw new SaneRepositoryError(`Current workstream selection is not a regular file: ${selectionPath}`)
  }
}

/** Write the canonical selection only after the caller has validated its target. */
export async function writeCurrentWorkstream(
  implementationRepository: string,
  relativePath: string,
): Promise<boolean> {
  await validateCurrentSelectionDestination(implementationRepository)
  const selectionPath = currentWorkstreamPath(implementationRepository)
  const content = `${relativePath}\n`
  const stat = await lstatOrUndefined(selectionPath)
  if (!stat) {
    await writeFile(selectionPath, content, { flag: "wx" })
    return true
  }
  if ((await readFile(selectionPath, "utf8")) === content) return false
  await writeFile(selectionPath, content)
  return true
}

/** Read and validate the local selection without trusting its contents. */
export async function readCurrentWorkstream(
  implementationRepository: string,
  workstreamsRoot: string,
): Promise<{ relativePath: string; path: string; type: WorkstreamType }> {
  const selectionPath = currentWorkstreamPath(implementationRepository)
  if (!(await lstatOrUndefined(selectionPath))?.isFile()) {
    throw new SaneRepositoryError(`Current workstream selection is missing or not a regular file: ${selectionPath}`)
  }
  const content = await readFile(selectionPath, "utf8")
  if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) {
    throw new SaneRepositoryError(`Current workstream selection is malformed: ${selectionPath}`)
  }
  const selected = content.slice(0, -1)
  const workstream = await resolveBootstrappedWorkstream(workstreamsRoot, selected)
  if (workstream.relativePath !== selected) {
    throw new SaneRepositoryError(`Current workstream selection is not normalized: ${selectionPath}`)
  }
  return workstream
}
