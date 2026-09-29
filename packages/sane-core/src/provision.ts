import { LifecycleAccessError, ordinaryLifecycleFileSystem, type LifecycleFileSystem } from "./lifecycle-filesystem.ts"
import { dirname, join, resolve, relative, sep } from "node:path"
import { DEFAULT_TEMPLATE_ROOT, initialTemplateRegistry, ROOT_DOC_BY_TYPE } from "./bootstrap-registry.ts"
import { lifecyclePhase } from "./lifecycle.ts"
import type { WorkstreamType } from "./workstream-type.ts"

/** Resource-only replacement; authored documents are never refreshed. */
export async function refreshResourceTemplates(workstreamRoot: string, type: WorkstreamType, templateRoot = DEFAULT_TEMPLATE_ROOT, fs: LifecycleFileSystem = ordinaryLifecycleFileSystem): Promise<string[]> {
  async function check(root: string, path: string, source: boolean): Promise<void> {
    const within = relative(resolve(root), resolve(root, path))
    if (!within || within === ".." || within.startsWith(`..${sep}`)) throw new Error(`Unsafe template path: ${path}`)
    const parts = within.split(sep)
    for (let i = 0; i <= parts.length; i++) {
      const candidate = join(root, ...parts.slice(0, i))
      let stat
      try { stat = await fs.stat(candidate) } catch (error) {
        if (!source && (error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      const file = i === parts.length
      if (stat.isSymbolicLink() || (file ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Unsafe template ${source ? "source" : "destination"}: ${candidate}; expected a regular ${file ? "file" : "directory"}, not a symlink or other file type.`)
    }
  }
  const registry = initialTemplateRegistry(type).filter(entry => entry.destination.startsWith("resources/"))
  for (const entry of registry) { await check(templateRoot, entry.source, true); await check(workstreamRoot, entry.destination, false) }
  const templates = await Promise.all(registry.map(async entry => ({ ...entry, content: await fs.readBytes(join(templateRoot, entry.source)) })))
  await fs.mkdir(join(workstreamRoot, "resources"))
  for (const template of templates) await fs.writeBytes(join(workstreamRoot, template.destination), template.content, false)
  return templates.map(entry => entry.destination)
}
async function exists(fs: LifecycleFileSystem, path: string): Promise<boolean> { try { await fs.readBytes(path); return true } catch (error) { if (error instanceof LifecycleAccessError) throw error; return false } }
async function listMarkdownFiles(fs: LifecycleFileSystem, path: string): Promise<string[]> { try { return (await fs.listNames(path)).filter(name => name.endsWith(".md")).sort() } catch (error) { if (error instanceof LifecycleAccessError) throw error; return [] } }

/** Extracted ordinary provide policy. Caller resolves and validates state/root. */
export async function providePhase(workstreamRoot: string, type: WorkstreamType, requestedPhase: string, refreshTemplates = false, fs: LifecycleFileSystem = ordinaryLifecycleFileSystem): Promise<{ created: string[]; existed: string[]; refreshed: string[] }> {
  const phase = lifecyclePhase(requestedPhase)
  const created: string[] = [], existed: string[] = [], refreshed: string[] = []
  if (refreshTemplates) return { created, existed, refreshed: await refreshResourceTemplates(workstreamRoot, type, DEFAULT_TEMPLATE_ROOT, fs) }
  async function ensureStarter(path: string, template: string): Promise<void> {
    if (await exists(fs, join(workstreamRoot, path))) { existed.push(path); return }
    const templatePath = join(workstreamRoot, template)
    if (!(await exists(fs, templatePath))) throw new Error(`Template missing: ${template} (workstream resources are incomplete).`)
    await fs.mkdir(dirname(join(workstreamRoot, path)))
    // Exclusive creation protects authored files that appear after the check.
    await fs.writeBytes(join(workstreamRoot, path), await fs.readBytes(templatePath), true)
    created.push(path)
  }
  const resource = phase === "planning" ? { destination: "resources/VERIFICATION_SPEC_TEMPLATE.md", source: "shared/plan/VERIFICATION.md" }
    : phase === "execution" ? { destination: "resources/TEST_REPORT_TEMPLATE.md", source: "shared/execution/TEST_REPORT.md" } : null
  if (resource && !(await exists(fs, join(workstreamRoot, resource.destination)))) {
    await fs.writeBytes(join(workstreamRoot, resource.destination), await fs.readBytes(join(DEFAULT_TEMPLATE_ROOT, resource.source)), true)
    created.push(resource.destination)
  }
  switch (phase) {
    case "design": {
      const root = ROOT_DOC_BY_TYPE[type]
      if (!(await exists(fs, join(workstreamRoot, root)))) throw new Error(`Root doc missing: ${root} (re-create the workstream; provide never invents it).`)
      existed.push(root)
      await fs.mkdir(join(workstreamRoot, "design"))
      await ensureStarter("design/SDD.md", "resources/SDD_TEMPLATE.md")
      break
    }
    case "engineering":
      await fs.mkdir(join(workstreamRoot, "design/solutions"))
      if ((await listMarkdownFiles(fs, join(workstreamRoot, "design/solutions"))).length === 0) await ensureStarter("design/solutions/SOLUTION.md", "resources/SOLUTION_SPEC_TEMPLATE.md")
      else existed.push("design/solutions/")
      break
    case "planning":
      await fs.mkdir(join(workstreamRoot, "execution/jobs"))
      await fs.mkdir(join(workstreamRoot, "execution/verification"))
      await ensureStarter("execution/PLAN.md", "resources/PLAN_TEMPLATE.md")
      break
    case "execution":
      await fs.mkdir(join(workstreamRoot, "execution/reports"))
      await fs.mkdir(join(workstreamRoot, "execution/test-reports"))
      await ensureStarter("execution/FINAL_REPORT.md", "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md")
  }
  return { created, existed, refreshed }
}
