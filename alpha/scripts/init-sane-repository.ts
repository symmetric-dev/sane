import { execFile } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import {
  BootstrapError,
  DEFAULT_TEMPLATE_ROOT,
  type TemplateRegistry,
  validateTemplateRegistry,
} from "./create-sane-workstream.ts"

const execFileAsync = promisify(execFile)

export const REPOSITORY_TEMPLATE_REGISTRY = [
  { source: "shared/repository/paths", destination: ".sane/paths" },
] as const satisfies TemplateRegistry

const IMPLEMENTATION_PATH_PLACEHOLDER =
  "<absolute-path-to-implementation-repository>"
const WORKSTREAM_PATH_PLACEHOLDER =
  "<absolute-path-to-workstream-repository>"
const REPOSITORY_PATHS_TEMPLATE =
  `implementation-path: ${IMPLEMENTATION_PATH_PLACEHOLDER}\n` +
  `workstream-repository-path: ${WORKSTREAM_PATH_PLACEHOLDER}\n`
const SANE_IGNORE_ENTRY = "/.sane/"

export class RepositoryInitializationError extends BootstrapError {
  constructor(message: string) {
    super(message)
    this.name = "RepositoryInitializationError"
  }
}

export interface RepositoryInitializationOptions {
  implementationRepository: string
  /** Enables isolated tests and an explicitly configured local SANE home. */
  homeDirectory?: string
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
}

export interface RepositoryInitializationResult {
  implementationRepository: string
  workstreamRepository: string
  dryRun: boolean
  createdWorkstreamRepository: boolean
  addedIgnoreEntry: boolean
}

interface GitignoreState {
  exists: boolean
  content: string
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

async function resolveImplementationRepository(path: string): Promise<string> {
  const requestedPath = resolve(path)
  const requestedStat = await lstatOrUndefined(requestedPath)
  if (!requestedStat?.isDirectory()) {
    throw new RepositoryInitializationError(
      `Implementation repository path must be an existing directory: ${requestedPath}`,
    )
  }

  try {
    const root = await runGit(["-C", requestedPath, "rev-parse", "--show-toplevel"])
    return resolve(root)
  } catch {
    throw new RepositoryInitializationError(
      `Implementation repository is not a Git working tree: ${requestedPath}`,
    )
  }
}

function resolveHomeDirectory(configuredHome?: string): string {
  const home = configuredHome ?? process.env.SANE_HOME ?? homedir()
  if (!home.trim()) {
    throw new RepositoryInitializationError("Could not resolve a home directory.")
  }
  return resolve(home)
}

export function renderRepositoryPaths(
  template: string,
  implementationRepository: string,
  workstreamRepository: string,
): string {
  if (template !== REPOSITORY_PATHS_TEMPLATE) {
    throw new RepositoryInitializationError(
      "Repository paths template must use the exact .sane/paths schema with its required placeholders.",
    )
  }

  return template
    .replace(IMPLEMENTATION_PATH_PLACEHOLDER, implementationRepository)
    .replace(WORKSTREAM_PATH_PLACEHOLDER, workstreamRepository)
}

async function readGitignoreState(path: string): Promise<GitignoreState> {
  const stat = await lstatOrUndefined(path)
  if (!stat) return { exists: false, content: "" }
  if (!stat.isFile()) {
    throw new RepositoryInitializationError(
      `.gitignore must be a regular file: ${path}`,
    )
  }
  return { exists: true, content: await readFile(path, "utf8") }
}

function hasIgnoreEntry(content: string): boolean {
  return content.split(/\r?\n/).includes(SANE_IGNORE_ENTRY)
}

function appendIgnoreEntry(content: string): string {
  if (hasIgnoreEntry(content)) return content
  if (!content) return `${SANE_IGNORE_ENTRY}\n`
  return `${content}${content.endsWith("\n") ? "" : "\n"}${SANE_IGNORE_ENTRY}\n`
}

async function inspectLocalPaths(
  saneDirectory: string,
  expectedPaths: string,
): Promise<"absent" | "expected"> {
  const saneStat = await lstatOrUndefined(saneDirectory)
  if (!saneStat) return "absent"
  if (!saneStat.isDirectory()) {
    throw new RepositoryInitializationError(
      `Local SANE path is not a directory: ${saneDirectory}`,
    )
  }

  const pathsPath = join(saneDirectory, "paths")
  const pathsStat = await lstatOrUndefined(pathsPath)
  if (!pathsStat?.isFile()) {
    throw new RepositoryInitializationError(
      `Existing local SANE directory is incomplete or unrelated: ${saneDirectory}`,
    )
  }
  if ((await readFile(pathsPath, "utf8")) !== expectedPaths) {
    throw new RepositoryInitializationError(
      `Existing local SANE paths file differs from the expected repository paths: ${pathsPath}`,
    )
  }
  return "expected"
}

async function isGitRepositoryRoot(path: string): Promise<boolean> {
  try {
    const gitDirectory = await lstatOrUndefined(join(path, ".git"))
    return (
      gitDirectory?.isDirectory() === true &&
      (await runGit(["-C", path, "rev-parse", "--show-prefix"])) === ""
    )
  } catch {
    return false
  }
}

async function restoreGitignore(path: string, state: GitignoreState): Promise<void> {
  if (state.exists) {
    await writeFile(path, state.content)
  } else {
    await rm(path, { force: true })
  }
}

/**
 * Create or validate the local workstream repository paired with an
 * implementation repository. This deliberately does not bootstrap a workstream.
 */
export async function initializeSaneRepository(
  options: RepositoryInitializationOptions,
): Promise<RepositoryInitializationResult> {
  const write = options.write ?? console.log
  const implementationRepository = await resolveImplementationRepository(
    options.implementationRepository,
  )
  const templateRoot = resolve(options.templateRoot ?? DEFAULT_TEMPLATE_ROOT)
  const homeDirectory = resolveHomeDirectory(options.homeDirectory)
  const workstreamRepository = join(
    homeDirectory,
    "workstreams",
    `${basename(implementationRepository)}-work`,
  )
  const workstreamsDirectory = dirname(workstreamRepository)
  const saneDirectory = join(implementationRepository, ".sane")
  const pathsPath = join(saneDirectory, "paths")
  const gitignorePath = join(implementationRepository, ".gitignore")

  // Validate all source content before creating either repository or local files.
  await validateTemplateRegistry(templateRoot, REPOSITORY_TEMPLATE_REGISTRY)
  const template = await readFile(join(templateRoot, "shared", "repository", "paths"), "utf8")
  const expectedPaths = renderRepositoryPaths(
    template,
    implementationRepository,
    workstreamRepository,
  )

  const localPathsState = await inspectLocalPaths(saneDirectory, expectedPaths)
  const destinationStat = await lstatOrUndefined(workstreamRepository)
  const gitignoreState = await readGitignoreState(gitignorePath)
  const addedIgnoreEntry = !hasIgnoreEntry(gitignoreState.content)

  if (destinationStat) {
    if (!destinationStat.isDirectory() || !(await isGitRepositoryRoot(workstreamRepository))) {
      throw new RepositoryInitializationError(
        `Existing workstream destination is not the expected Git repository: ${workstreamRepository}`,
      )
    }
    if (localPathsState !== "expected") {
      throw new RepositoryInitializationError(
        `Existing workstream repository has no matching local SANE paths file: ${pathsPath}`,
      )
    }

    if (options.dryRun) {
      write("Dry run: no files or directories were modified.")
      write(`Validated: ${workstreamRepository}`)
      if (addedIgnoreEntry) write(`Planned: append ${SANE_IGNORE_ENTRY} to ${gitignorePath}`)
      return {
        implementationRepository,
        workstreamRepository,
        dryRun: true,
        createdWorkstreamRepository: false,
        addedIgnoreEntry,
      }
    }

    if (addedIgnoreEntry) await writeFile(gitignorePath, appendIgnoreEntry(gitignoreState.content))
    write(`Validated: ${workstreamRepository}`)
    if (addedIgnoreEntry) write(`Updated: ${gitignorePath}`)
    return {
      implementationRepository,
      workstreamRepository,
      dryRun: false,
      createdWorkstreamRepository: false,
      addedIgnoreEntry,
    }
  }

  if (localPathsState === "expected") {
    throw new RepositoryInitializationError(
      `Local SANE paths file exists but its workstream repository is missing: ${workstreamRepository}`,
    )
  }

  if (options.dryRun) {
    write("Dry run: no files or directories were modified.")
    write(`Planned: initialize Git repository ${workstreamRepository}`)
    write(`Planned: create ${pathsPath}`)
    if (addedIgnoreEntry) write(`Planned: append ${SANE_IGNORE_ENTRY} to ${gitignorePath}`)
    return {
      implementationRepository,
      workstreamRepository,
      dryRun: true,
      createdWorkstreamRepository: true,
      addedIgnoreEntry,
    }
  }

  let stagingDirectory: string | undefined
  let wroteLocalState = false
  try {
    await mkdir(workstreamsDirectory, { recursive: true })
    stagingDirectory = await mkdtemp(join(workstreamsDirectory, `.${basename(workstreamRepository)}-`))
    await runGit(["init", "--quiet", stagingDirectory])

    await mkdir(saneDirectory)
    wroteLocalState = true
    await writeFile(pathsPath, expectedPaths, { flag: "wx" })
    await writeFile(gitignorePath, appendIgnoreEntry(gitignoreState.content))

    if (await lstatOrUndefined(workstreamRepository)) {
      throw new RepositoryInitializationError(
        `Workstream destination was created concurrently: ${workstreamRepository}`,
      )
    }
    await rename(stagingDirectory, workstreamRepository)
    stagingDirectory = undefined
  } catch (error) {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
    if (wroteLocalState) {
      await rm(saneDirectory, { recursive: true, force: true })
      await restoreGitignore(gitignorePath, gitignoreState)
    }
    if (error instanceof RepositoryInitializationError) throw error
    throw new RepositoryInitializationError(
      `Could not initialize SANE repository: ${(error as Error).message}`,
    )
  }

  write(`Created: ${workstreamRepository}`)
  write(`Created: ${pathsPath}`)
  if (addedIgnoreEntry) write(`Updated: ${gitignorePath}`)
  return {
    implementationRepository,
    workstreamRepository,
    dryRun: false,
    createdWorkstreamRepository: true,
    addedIgnoreEntry,
  }
}

export const USAGE =
  "Usage: sane-alpha init-sane <implementation-repository> [--dry-run]"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  dryRun: boolean
} {
  let dryRun = false
  const positional: string[] = []
  let parseOptions = true

  for (const argument of args) {
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true
    } else if (parseOptions && argument.startsWith("-")) {
      throw new RepositoryInitializationError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length !== 1 || !positional[0]) {
    throw new RepositoryInitializationError(
      "Provide exactly one implementation repository path.",
    )
  }
  return { implementationRepository: positional[0], dryRun }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const { implementationRepository, dryRun } = parseCliArguments(args)
    await initializeSaneRepository({ implementationRepository, dryRun })
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
