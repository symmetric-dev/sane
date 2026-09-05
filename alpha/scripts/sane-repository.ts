import { execFile } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { BootstrapError, type TemplateRegistry, validateTemplateRegistry } from "./create-sane-workstream.ts"

const execFileAsync = promisify(execFile)
export const SANE_PATHS_FILENAME = "paths"
const REQUIRED_WORKSTREAM_FILES = [
  "SANE_CONTEXT.md",
  "SANE_STATE.md",
  "PRD.md",
  "resources/IMPLEMENTATION_REPORT_TEMPLATE.md",
  "resources/SECTION_SPEC_TEMPLATE.md",
  "resources/JOB_TEMPLATE.md",
] as const

export class SaneRepositoryError extends BootstrapError {
  constructor(message: string) {
    super(message)
    this.name = "SaneRepositoryError"
  }
}

export interface SaneRepositoryPaths {
  implementationRepository: string
  workstreamRepository: string
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

function parseNormalizedAbsolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new SaneRepositoryError(`${field} in .sane/${SANE_PATHS_FILENAME} must be a normalized absolute path.`)
  }
  return value
}

/** Parse the exact, deliberately small ignored local repository paths schema. */
export async function readSaneRepositoryPaths(
  implementationRepository: string,
): Promise<SaneRepositoryPaths> {
  const saneDirectory = join(implementationRepository, ".sane")
  if (!(await lstatOrUndefined(saneDirectory))?.isDirectory()) {
    throw new SaneRepositoryError(`Local SANE path is missing or not a directory: ${saneDirectory}`)
  }
  const pathsPath = join(saneDirectory, SANE_PATHS_FILENAME)
  if (!(await lstatOrUndefined(pathsPath))?.isFile()) {
    throw new SaneRepositoryError(`SANE repository paths file is missing or not a regular file: ${pathsPath}`)
  }
  const content = await readFile(pathsPath, "utf8")
  const match = /^implementation-path: ([^\r\n]+)\nworkstream-repository-path: ([^\r\n]+)\n$/.exec(content)
  if (!match) {
    throw new SaneRepositoryError(
      `SANE repository paths file must use the exact .sane/${SANE_PATHS_FILENAME} schema.`,
    )
  }
  const recordedImplementation = parseNormalizedAbsolutePath(match[1]!, "implementation-path")
  const workstreamRepository = parseNormalizedAbsolutePath(match[2]!, "workstream-repository-path")

  let sameImplementationRoot = false
  try {
    sameImplementationRoot =
      (await realpath(recordedImplementation)) === (await realpath(implementationRepository))
  } catch {
    // The recorded path is malformed for this local repository even if it is absolute.
  }
  if (!sameImplementationRoot) {
    throw new SaneRepositoryError(
      `Recorded implementation repository does not match the resolved Git root: ${recordedImplementation}`,
    )
  }
  return { implementationRepository, workstreamRepository }
}

/** Require that the recorded workstream repository is itself a Git root. */
export async function validateWorkstreamRepository(path: string): Promise<string> {
  const repository = resolve(path)
  if (!(await lstatOrUndefined(repository))?.isDirectory()) {
    throw new SaneRepositoryError(`Recorded workstream repository is not an existing directory: ${repository}`)
  }
  try {
    const gitDirectory = await lstatOrUndefined(join(repository, ".git"))
    const gitRoot = resolve(await runGit(["-C", repository, "rev-parse", "--show-toplevel"]))
    if (!gitDirectory?.isDirectory() || (await realpath(gitRoot)) !== (await realpath(repository))) {
      throw new Error("not a standalone Git root")
    }
  } catch {
    throw new SaneRepositoryError(
      `Recorded workstream repository is not an expected Git repository root: ${repository}`,
    )
  }
  return repository
}

export async function resolveSaneRepository(path: string): Promise<SaneRepositoryPaths> {
  const implementationRepository = await resolveImplementationRepository(path)
  const repositoryPaths = await readSaneRepositoryPaths(implementationRepository)
  await validateWorkstreamRepository(repositoryPaths.workstreamRepository)
  return repositoryPaths
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
    throw new SaneRepositoryError("Workstream path resolves outside the recorded workstream repository.")
  }
}

/**
 * Resolve a user path without accepting a traversal component. Existing
 * ancestors are also realpath-checked so a symlink cannot redirect a new file
 * outside the workstream repository.
 */
export async function resolveSafeWorkstreamPath(
  workstreamRepository: string,
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
  const path = resolve(workstreamRepository, relativePath)
  assertLexicallyContained(workstreamRepository, path, "Workstream path")

  await assertExistingAncestorContained(workstreamRepository, path)
  return { relativePath, path }
}

/** Ensure a candidate is an existing initial-workstream bootstrap. */
export async function validateBootstrappedWorkstream(path: string): Promise<void> {
  if (!(await lstatOrUndefined(path))?.isDirectory()) {
    throw new SaneRepositoryError(`Workstream is not an existing directory: ${path}`)
  }
  for (const filename of REQUIRED_WORKSTREAM_FILES) {
    if (!(await lstatOrUndefined(join(path, filename)))?.isFile()) {
      throw new SaneRepositoryError(`Workstream is not bootstrapped; missing regular file: ${join(path, filename)}`)
    }
  }
}

export async function resolveBootstrappedWorkstream(
  workstreamRepository: string,
  requestedPath: string,
): Promise<{ relativePath: string; path: string }> {
  const workstream = await resolveSafeWorkstreamPath(workstreamRepository, requestedPath)
  await validateBootstrappedWorkstream(workstream.path)
  return workstream
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
  workstreamRepository: string,
): Promise<{ relativePath: string; path: string }> {
  const selectionPath = currentWorkstreamPath(implementationRepository)
  if (!(await lstatOrUndefined(selectionPath))?.isFile()) {
    throw new SaneRepositoryError(`Current workstream selection is missing or not a regular file: ${selectionPath}`)
  }
  const content = await readFile(selectionPath, "utf8")
  if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) {
    throw new SaneRepositoryError(`Current workstream selection is malformed: ${selectionPath}`)
  }
  const selected = content.slice(0, -1)
  const workstream = await resolveBootstrappedWorkstream(workstreamRepository, selected)
  if (workstream.relativePath !== selected) {
    throw new SaneRepositoryError(`Current workstream selection is not normalized: ${selectionPath}`)
  }
  return workstream
}

/** Copy an already-validated registry, refusing any existing destination. */
export async function validateProvisionTemplates(
  templateRoot: string,
  workstreamPath: string,
  registry: TemplateRegistry,
): Promise<void> {
  await validateTemplateRegistry(templateRoot, registry)
  const destinations = registry.map((template) => resolve(workstreamPath, template.destination))
  for (const destination of destinations) {
    assertLexicallyContained(workstreamPath, destination, "Template destination")
    await assertExistingAncestorContained(workstreamPath, destination)
    if (await lstatOrUndefined(destination)) {
      throw new SaneRepositoryError(`Refusing to overwrite existing role artifact: ${destination}`)
    }
  }
}

export async function provisionTemplates(
  templateRoot: string,
  workstreamPath: string,
  registry: TemplateRegistry,
  createStageDirectories: boolean,
): Promise<void> {
  await validateProvisionTemplates(templateRoot, workstreamPath, registry)
  const destinations = registry.map((template) => resolve(workstreamPath, template.destination))
  if (createStageDirectories) {
    for (const destination of destinations) await mkdir(dirname(destination), { recursive: true })
  }
  for (let index = 0; index < registry.length; index += 1) {
    const template = registry[index]!
    const destination = destinations[index]!
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(templateRoot, template.source), destination, fsConstants.COPYFILE_EXCL)
  }
}
