import { fileURLToPath } from "node:url"

import { type TemplateRegistry } from "./create-sane-workstream.ts"
import {
  SaneRepositoryError,
  provisionTemplates,
  readCurrentWorkstream,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
  validateProvisionTemplates,
} from "./sane-repository.ts"

export const DEFAULT_TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url))

const ROLE_TEMPLATES = {
  research: [
    { source: "research/INDEX.md", destination: "research/INDEX.md" },
    { source: "research/TECH_BRIEF.md", destination: "research/TECH_BRIEF.md" },
  ],
  design: [
    { source: "design/SPEC.md", destination: "design/SPEC.md" },
    { source: "design/STAGES.md", destination: "design/STAGES.md" },
  ],
  "stage-design": [{ source: "design/stage/SPEC.md", destination: "" }],
  engineering: [{ source: "design/stage/SECTIONS.md", destination: "" }],
  execution: [{ source: "execution/EXECUTION_PLAN.md", destination: "" }],
} as const satisfies Record<string, TemplateRegistry>

type SupportedRole = keyof typeof ROLE_TEMPLATES

export interface ProvisionRoleOptions {
  implementationRepository: string
  role: string
  workstreamPath?: string
  stage?: string
  templateRoot?: string
  dryRun?: boolean
  write?: (line: string) => void
}

function isStageRole(role: SupportedRole): boolean {
  return role === "stage-design" || role === "engineering" || role === "execution"
}

function validateStage(stage: string | undefined): string {
  if (!stage || !/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage)) {
    throw new SaneRepositoryError("Stage must be a single safe <two-digit-id>-<slug> segment.")
  }
  return stage
}

function roleRegistry(role: SupportedRole, stage?: string): TemplateRegistry {
  if (!isStageRole(role)) return ROLE_TEMPLATES[role]
  const validStage = validateStage(stage)
  const template = ROLE_TEMPLATES[role][0]!
  const destination = role === "execution"
    ? `execution/stages/${validStage}/EXECUTION_PLAN.md`
    : `design/stages/${validStage}/${role === "engineering" ? "SECTIONS.md" : "SPEC.md"}`
  return [{ source: template.source, destination }]
}

export async function provisionSaneRole(options: ProvisionRoleOptions): Promise<{ dryRun: boolean; role: SupportedRole; relativePath: string }> {
  const write = options.write ?? console.log
  if (!(options.role in ROLE_TEMPLATES)) {
    throw new SaneRepositoryError(`Unsupported role "${options.role}". Supported roles: ${Object.keys(ROLE_TEMPLATES).join(", ")}.`)
  }
  const role = options.role as SupportedRole
  if (!isStageRole(role) && options.stage) {
    throw new SaneRepositoryError(`Role "${role}" does not accept --stage.`)
  }
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = options.workstreamPath
    ? await resolveBootstrappedWorkstream(pointer.workstreamRepository, options.workstreamPath)
    : await readCurrentWorkstream(pointer.implementationRepository, pointer.workstreamRepository)
  const registry = roleRegistry(role, options.stage)
  const templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT
  // Validation of every source and every destination precedes all mkdir/copy work.
  if (options.dryRun) {
    await validateProvisionTemplates(templateRoot, workstream.path, registry)
    write("Dry run: no files or directories were modified.")
    for (const template of registry) write(`Planned: ${template.destination}`)
    return { dryRun: true, role, relativePath: workstream.relativePath }
  }
  await provisionTemplates(templateRoot, workstream.path, registry, isStageRole(role))
  for (const template of registry) write(`Created: ${template.destination}`)
  return { dryRun: false, role, relativePath: workstream.relativePath }
}

export const USAGE = "Usage: bun alpha/scripts/provision-sane-role.ts <implementation-repository> <role> [--workstream <relative-path>] [--stage <id>-<slug>] [--dry-run]"

export function parseCliArguments(args: string[]): ProvisionRoleOptions {
  let dryRun = false
  let workstreamPath: string | undefined
  let stage: string | undefined
  const positional: string[] = []
  let parseOptions = true
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") parseOptions = false
    else if (parseOptions && argument === "--dry-run") dryRun = true
    else if (parseOptions && (argument === "--workstream" || argument === "--stage")) {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw new SaneRepositoryError(`Option ${argument} requires a value.`)
      if (argument === "--workstream") {
        if (workstreamPath) throw new SaneRepositoryError("Option --workstream may be provided only once.")
        workstreamPath = value
      } else {
        if (stage) throw new SaneRepositoryError("Option --stage may be provided only once.")
        stage = value
      }
      index += 1
    } else if (parseOptions && argument.startsWith("-")) throw new SaneRepositoryError(`Unknown option: ${argument}`)
    else positional.push(argument)
  }
  if (positional.length !== 2 || !positional[0] || !positional[1]) {
    throw new SaneRepositoryError("Provide an implementation repository and supported role.")
  }
  return { implementationRepository: positional[0], role: positional[1], workstreamPath, stage, dryRun }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await provisionSaneRole(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
