import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type WorkstreamType,
  WorkstreamTypeError,
  validateWorkstreamType,
} from "./workstream-type.ts"

/**
 * Bootstrap copies root documents plus local fallback templates. Owning roles
 * copy a fallback into a new artifact path before editing that artifact.
 */
export interface TemplateMapping {
  source: string
  destination: string
}

export type TemplateRegistry = readonly TemplateMapping[]

const SHARED_INITIAL_TEMPLATE_REGISTRY = [
  { source: "shared/SANE_CONTEXT.md", destination: "SANE_CONTEXT.md" },
  { source: "shared/SANE_STATE.md", destination: "SANE_STATE.md" },
  {
    source: "shared/sdd/SDD.md",
    destination: "SDD.md",
  },
  {
    source: "shared/sdd/SDD.md",
    destination: "resources/SDD_TEMPLATE.md",
  },
  {
    source: "shared/solutions/SOLUTION.md",
    destination: "resources/SOLUTION_SPEC_TEMPLATE.md",
  },
  {
    source: "shared/research/REPORT.md",
    destination: "resources/RESEARCH_REPORT_TEMPLATE.md",
  },
  {
    source: "shared/plan/PLAN.md",
    destination: "resources/PLAN_TEMPLATE.md",
  },
  {
    source: "shared/plan/JOB.md",
    destination: "resources/JOB_TEMPLATE.md",
  },
  {
    source: "shared/execution/REPORT.md",
    destination: "resources/EXECUTION_REPORT_TEMPLATE.md",
  },
  {
    source: "shared/execution/BRIEF.md",
    destination: "resources/EXECUTION_BRIEF_TEMPLATE.md",
  },
] as const satisfies TemplateRegistry

const TYPE_INITIAL_TEMPLATE_REGISTRY: Record<WorkstreamType, TemplateRegistry> = {
  feature: [{ source: "feature/PRD.md", destination: "PRD.md" }],
  foundation: [{ source: "foundation/FOUNDATION.md", destination: "FOUNDATION.md" }],
  issue: [{ source: "issue/ISSUE.md", destination: "ISSUE.md" }],
  maintenance: [{ source: "maintenance/MAINTENANCE.md", destination: "MAINTENANCE.md" }],
}

export function initialTemplateRegistry(workstreamType: WorkstreamType): TemplateRegistry {
  return [...SHARED_INITIAL_TEMPLATE_REGISTRY, ...TYPE_INITIAL_TEMPLATE_REGISTRY[workstreamType]]
}

export const INITIAL_DIRECTORIES = [
  "resources",
  "solutions",
  "research",
  "plan",
  "execution",
] as const

export const DEFAULT_TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../templates/", import.meta.url),
)

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BootstrapError"
  }
}

export interface BootstrapOptions {
  destination: string
  type: string
  /** Primarily enables isolated tests; the CLI always uses the Alpha checkout. */
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
}

export interface BootstrapResult {
  destination: string
  paths: string[]
  dryRun: boolean
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function pathWithinRoot(root: string, path: string, description: string): string {
  const resolvedPath = resolve(root, path)
  const rootRelativePath = relative(root, resolvedPath)

  if (
    rootRelativePath === "" ||
    rootRelativePath === ".." ||
    rootRelativePath.startsWith(`..${sep}`)
  ) {
    throw new BootstrapError(
      `${description} must resolve to a path within "${root}".`,
    )
  }

  return resolvedPath
}

/** Validate that every registry source is a regular file under templateRoot. */
export async function validateTemplateRegistry(
  templateRoot: string,
  registry: TemplateRegistry,
): Promise<void> {
  const missing: string[] = []

  for (const template of registry) {
    const sourcePath = pathWithinRoot(
      templateRoot,
      template.source,
      "Template source",
    )
    try {
      if (!(await lstat(sourcePath)).isFile()) missing.push(sourcePath)
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        missing.push(sourcePath)
        continue
      }
      throw new BootstrapError(
        `Unable to validate required template "${sourcePath}": ${(error as Error).message}`,
      )
    }
  }

  if (missing.length > 0) {
    throw new BootstrapError(
      `Required source template${missing.length === 1 ? "" : "s"} missing or not a file: ${missing.join(", ")}`,
    )
  }
}

/**
 * Copy a validated template registry into a staging root. Destination parents
 * are created within that root and individual files are never overwritten.
 */
export async function copyTemplateRegistry(
  templateRoot: string,
  destinationRoot: string,
  registry: TemplateRegistry,
): Promise<void> {
  for (const template of registry) {
    const sourcePath = pathWithinRoot(
      templateRoot,
      template.source,
      "Template source",
    )
    const destinationPath = pathWithinRoot(
      destinationRoot,
      template.destination,
      "Template destination",
    )
    await mkdir(dirname(destinationPath), { recursive: true })
    await copyFile(
      sourcePath,
      destinationPath,
      // A staging directory is new, so exclusive creation protects this helper
      // if it is reused in a context with pre-existing destination files.
      fsConstants.COPYFILE_EXCL,
    )
  }
}

async function createInitialDirectories(destinationRoot: string): Promise<void> {
  for (const directory of INITIAL_DIRECTORIES) {
    await mkdir(join(destinationRoot, directory))
  }
}

function outputPaths(destination: string, registry: TemplateRegistry): string[] {
  return [
    destination,
    join(destination, "type"),
    ...registry.map((template) =>
      join(destination, template.destination),
    ),
    ...INITIAL_DIRECTORIES.map((directory) => join(destination, directory)),
  ]
}

/**
 * Validate and bootstrap a new Alpha workstream. The completed staging tree is
 * renamed into place so a copy failure never leaves a partial target root.
 */
export async function createSaneWorkstream(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const destination = resolve(options.destination)
  const templateRoot = resolve(options.templateRoot ?? DEFAULT_TEMPLATE_ROOT)
  const write = options.write ?? console.log
  let workstreamType: WorkstreamType
  try {
    workstreamType = validateWorkstreamType(options.type)
  } catch (error) {
    if (error instanceof WorkstreamTypeError) throw new BootstrapError(error.message)
    throw error
  }
  const registry = initialTemplateRegistry(workstreamType)

  if (destination === dirname(destination)) {
    throw new BootstrapError("The destination must not be the filesystem root.")
  }

  // Complete all validation before creating the target parent, staging tree, or
  // any workstream output.
  await validateTemplateRegistry(templateRoot, registry)
  if (await pathExists(destination)) {
    throw new BootstrapError(`Destination already exists: ${destination}`)
  }

  const paths = outputPaths(destination, registry)
  if (options.dryRun) {
    write("Dry run: no files or directories were created.")
    write(`Planned workstream type: ${workstreamType}`)
    for (const path of paths) write(`Planned: ${path}`)
    write(`Next action: start a Product Assistant session for ${destination}.`)
    return { destination, paths, dryRun: true }
  }

  const parent = dirname(destination)
  const destinationName = destination.slice(parent.length + 1)
  let stagingDirectory: string | undefined

  try {
    await mkdir(parent, { recursive: true })
    stagingDirectory = await mkdtemp(join(parent, `.${destinationName}.sane-bootstrap-`))
    await createInitialDirectories(stagingDirectory)
    await writeFile(join(stagingDirectory, "type"), `${workstreamType}\n`, { flag: "wx" })
    await copyTemplateRegistry(
      templateRoot,
      stagingDirectory,
      registry,
    )

    // Recheck immediately before rename. This prevents ordinary concurrent use
    // from replacing a just-created destination; staging is removed on refusal.
    if (await pathExists(destination)) {
      throw new BootstrapError(`Destination already exists: ${destination}`)
    }
    await rename(stagingDirectory, destination)
    stagingDirectory = undefined
  } catch (error) {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
    if (error instanceof BootstrapError) throw error
    throw new BootstrapError(
      `Could not create workstream at "${destination}": ${(error as Error).message}`,
    )
  }

  for (const path of paths) write(`Created: ${path}`)
  write(`Next action: start a Product Assistant session for ${destination}.`)
  return { destination, paths, dryRun: false }
}

export const USAGE =
  "Usage: bun alpha/packages/sane-cli/src/create-sane-workstream.ts <workstream-path> --type <feature|foundation|issue|maintenance> [--dry-run]"

export function parseCliArguments(args: string[]): {
  destination: string
  type: WorkstreamType
  dryRun: boolean
} {
  let dryRun = false
  let type: WorkstreamType | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true
    } else if (parseOptions && argument === "--type") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new BootstrapError("Option --type requires a value.")
      }
      if (type) throw new BootstrapError("Option --type may be provided only once.")
      try {
        type = validateWorkstreamType(value)
      } catch (error) {
        if (error instanceof WorkstreamTypeError) throw new BootstrapError(error.message)
        throw error
      }
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new BootstrapError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length !== 1) {
    throw new BootstrapError("Provide exactly one workstream destination path.")
  }
  if (!type) throw new BootstrapError("Option --type is required.")

  return { destination: positional[0]!, type, dryRun }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const { destination, type, dryRun } = parseCliArguments(args)
    await createSaneWorkstream({ destination, type, dryRun })
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
