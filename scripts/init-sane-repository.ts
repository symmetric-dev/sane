import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { BootstrapError } from "./create-sane-workstream.ts"

const execFileAsync = promisify(execFile)

const SANE_IGNORE_ENTRY = "/.sane/"

export class RepositoryInitializationError extends BootstrapError {
  constructor(message: string) {
    super(message)
    this.name = "RepositoryInitializationError"
  }
}

export interface RepositoryInitializationOptions {
  implementationRepository: string
  dryRun?: boolean
  write?: (line: string) => void
}

export interface RepositoryInitializationResult {
  implementationRepository: string
  workstreamsRoot: string
  dryRun: boolean
  createdWorkstreamsRoot: boolean
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

/**
 * Create or validate the local .sane/workstreams directory inside an
 * implementation repository. This deliberately does not bootstrap a workstream.
 */
export async function initializeSaneRepository(
  options: RepositoryInitializationOptions,
): Promise<RepositoryInitializationResult> {
  const write = options.write ?? console.log
  const implementationRepository = await resolveImplementationRepository(
    options.implementationRepository,
  )
  const saneDirectory = join(implementationRepository, ".sane")
  const workstreamsRoot = join(saneDirectory, "workstreams")
  const gitignorePath = join(implementationRepository, ".gitignore")
  const legacyPathsPath = join(saneDirectory, "paths")

  if (await lstatOrUndefined(legacyPathsPath)) {
    throw new RepositoryInitializationError(
      `Legacy .sane/paths file exists at ${legacyPathsPath}. Move workstreams into .sane/workstreams/ and delete this file.`,
    )
  }

  const saneStat = await lstatOrUndefined(saneDirectory)
  if (saneStat && !saneStat.isDirectory()) {
    throw new RepositoryInitializationError(
      `Local SANE path is not a directory: ${saneDirectory}`,
    )
  }

  const destinationStat = await lstatOrUndefined(workstreamsRoot)
  if (destinationStat && !destinationStat.isDirectory()) {
    throw new RepositoryInitializationError(
      `SANE workstreams path is not a directory: ${workstreamsRoot}`,
    )
  }

  const gitignoreState = await readGitignoreState(gitignorePath)
  const addedIgnoreEntry = !hasIgnoreEntry(gitignoreState.content)

  if (destinationStat?.isDirectory()) {
    if (options.dryRun) {
      write("Dry run: no files or directories were modified.")
      write(`Validated: ${workstreamsRoot}`)
      if (addedIgnoreEntry) write(`Planned: append ${SANE_IGNORE_ENTRY} to ${gitignorePath}`)
      return {
        implementationRepository,
        workstreamsRoot,
        dryRun: true,
        createdWorkstreamsRoot: false,
        addedIgnoreEntry,
      }
    }

    if (addedIgnoreEntry) await writeFile(gitignorePath, appendIgnoreEntry(gitignoreState.content))
    write(`Validated: ${workstreamsRoot}`)
    if (addedIgnoreEntry) write(`Updated: ${gitignorePath}`)
    return {
      implementationRepository,
      workstreamsRoot,
      dryRun: false,
      createdWorkstreamsRoot: false,
      addedIgnoreEntry,
    }
  }

  if (options.dryRun) {
    write("Dry run: no files or directories were modified.")
    write(`Planned: create ${workstreamsRoot}`)
    if (addedIgnoreEntry) write(`Planned: append ${SANE_IGNORE_ENTRY} to ${gitignorePath}`)
    return {
      implementationRepository,
      workstreamsRoot,
      dryRun: true,
      createdWorkstreamsRoot: true,
      addedIgnoreEntry,
    }
  }

  const gitignoreExisted = gitignoreState.exists
  const previousGitignore = gitignoreState.content
  let createdDirectory = false
  try {
    await mkdir(workstreamsRoot, { recursive: true })
    createdDirectory = true
    await writeFile(gitignorePath, appendIgnoreEntry(gitignoreState.content))
  } catch (error) {
    if (createdDirectory && !(await lstatOrUndefined(workstreamsRoot))) {
      // Directory creation failed before leaving state behind; nothing to clean.
    }
    if (error instanceof RepositoryInitializationError) throw error
    // Restore gitignore if we created it from scratch and then failed.
    if (!gitignoreExisted) await rm(gitignorePath, { force: true })
    else {
      try {
        if ((await readFile(gitignorePath, "utf8")) !== previousGitignore) {
          await writeFile(gitignorePath, previousGitignore)
        }
      } catch {
        // Best effort restore; surface the original failure below.
      }
    }
    if (error instanceof RepositoryInitializationError) throw error
    throw new RepositoryInitializationError(
      `Could not initialize SANE repository: ${(error as Error).message}`,
    )
  }

  write(`Created: ${workstreamsRoot}`)
  if (addedIgnoreEntry) write(`Updated: ${gitignorePath}`)
  return {
    implementationRepository,
    workstreamsRoot,
    dryRun: false,
    createdWorkstreamsRoot: true,
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
