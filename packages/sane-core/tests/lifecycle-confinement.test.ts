import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { RepositoryDomain, discoverRepository, initializeRepository, openRepositoryDomain } from "../src/server.ts"
import { ConfinedLifecycleFileSystem } from "../src/confined-lifecycle-filesystem.ts"
import { refreshResourceTemplates } from "../src/provision.ts"
import { DEFAULT_TEMPLATE_ROOT, initialTemplateRegistry } from "../src/bootstrap-registry.ts"

const mutation = { actor: { kind: "local" as const }, correlationId: "confinement-test" }
let temporary: string, root: string, outside: string, domain: RepositoryDomain
beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "opencode/c51-confinement-")))
  const repo = join(temporary, "repo")
  mkdirSync(repo); execFileSync("git", ["init", "--quiet", repo])
  const stateRoot = join(repo, ".sane")
  domain = openRepositoryDomain(initializeRepository(discoverRepository(repo)))
  domain.createWorkstream({ id: "test", title: "Test", type: "feature" }, mutation)
  root = join(stateRoot, "workstreams/test")
  outside = join(temporary, "outside"); mkdirSync(outside)
})
afterEach(() => { domain.close(); rmSync(temporary, { recursive: true, force: true }) })
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function snapshot(path: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) { result[name + "/"] = "directory"; visit(join(directory, entry.name), name + "/") }
      else result[name] = readFileSync(join(directory, entry.name)).toString("base64")
    }
  }
  visit(path)
  return result
}
function swap(path: string) { renameSync(path, path + "-saved"); symlinkSync(outside, path) }
async function rejectSwap(operation: () => Promise<unknown>, ancestor: string) {
  const bytes = snapshot(outside)
  const state = domain.getLifecycleStatus("test")
  const pending = operation() // Runs initial admission and first synchronous I/O.
  swap(join(root, ancestor)) // Before any awaited policy continuation runs.
  await expect(pending).rejects.toThrow(/symlink|directory identity/i)
  expect(snapshot(outside)).toEqual(bytes)
  expect(domain.getLifecycleStatus("test")).toEqual(state)
}

test.each(["design", "engineering", "planning", "execution"])("%s provision rejects an ancestor swapped after admission; no external files created", async phase => {
  write(join(outside, "sentinel.md"), "outside bytes")
  await rejectSwap(() => domain.provideWorkstream("test", phase, false, mutation), phase === "design" || phase === "engineering" ? "design" : "execution")
})
test("provision never reads a swapped external resource template", async () => {
  write(join(outside, "PLAN_TEMPLATE.md"), "# External plan must not be copied\n")
  write(join(outside, "VERIFICATION_SPEC_TEMPLATE.md"), "# External verification\n")
  await rejectSwap(() => domain.provideWorkstream("test", "planning", false, mutation), "resources")
  expect(readdirSync(join(root, "execution"))).not.toContain("PLAN.md")
})
test("resource refresh rejects swapped destination directory without overwriting external resources", async () => {
  for (const entry of initialTemplateRegistry("feature").filter(entry => entry.destination.startsWith("resources/"))) write(join(outside, entry.destination.slice("resources/".length)), "external authored bytes")
  await rejectSwap(() => domain.provideWorkstream("test", "planning", true, mutation), "resources")
})
test.each(["validate", "approve"])("design %s rejects external valid SDD after ancestor swap; no external evidence recorded", async operation => {
  domain.writeArtifact("test", "PRD.md", "# Authored product\n", mutation)
  // Local SDD remains an invalid starter. External valid text cannot make it valid.
  write(join(outside, "SDD.md"), "# External valid design\n")
  await rejectSwap(() => operation === "validate" ? domain.validateWorkstream("test", "design") : domain.approveWorkstream("test", "design", "owner", mutation), "design")
})
test("engineering validation rejects swapped solutions enumeration", async () => {
  write(join(root, "design/solutions/local.md"), "<!-- invalid local -->")
  write(join(outside, "solutions/external.md"), "# Valid external solution\n")
  await rejectSwap(() => domain.validateWorkstream("test", "engineering"), "design")
})
async function planning() {
  domain.writeArtifact("test", "execution/PLAN.md", "# Plan\n## Execution Checkpoints\n| Checkpoint | Jobs |\n| --- | --- |\n| C1 | 01 |\n", mutation)
  domain.writeArtifact("test", "execution/jobs/01-first.md", "# Job Spec 01: first\nWork.\n", mutation)
  domain.writeArtifact("test", "execution/verification/c1.md", "# Verify\n", mutation)
  await domain.approveWorkstream("test", "planning", "owner-plan", mutation)
}
test("job registration rejects swapped Planning documents and preserves existing authority/jobs", async () => {
  await planning()
  write(join(outside, "PLAN.md"), domain.readArtifact("test", "execution/PLAN.md"))
  write(join(outside, "jobs/02-added.md"), "# Job Spec 02: external\nExternal work\n")
  write(join(outside, "verification/c1.md"), "# External verification\n")
  await rejectSwap(() => domain.registerWorkstreamJobs("test", mutation), "execution")
})
test.each(["validate", "approve", "report"])("execution %s rejects swapped report/spec ancestors", async operation => {
  await planning()
  domain.writeArtifact("test", "execution/FINAL_REPORT.md", "# Local final\n", mutation)
  write(join(outside, "FINAL_REPORT.md"), "# External final\n")
  write(join(outside, "jobs/01-first.md"), "# Job Spec 01: first\nWork\n")
  write(join(outside, "reports/01-first.md"), "# Job 01: first Report\n## Outcome\nExternal\n## Unresolved Issues\nNone\n## Recommendations\nNone\n")
  write(join(outside, "verification/c1.md"), "# Verify\n")
  write(join(outside, "test-reports/c1.md"), "# External test evidence\n")
  await rejectSwap(() => operation === "approve" ? domain.approveWorkstream("test", "execution", "owner", mutation) : domain.validateWorkstream("test", "execution", operation === "report" ? { reportId: "01" } : {}), "execution")
})
test("refresh guards isolated template-source ancestors across awaits", async () => {
  const templates = join(temporary, "templates"); mkdirSync(templates)
  for (const entry of initialTemplateRegistry("feature").filter(entry => entry.destination.startsWith("resources/"))) {
    mkdirSync(dirname(join(templates, entry.source)), { recursive: true })
    copyFileSync(join(DEFAULT_TEMPLATE_ROOT, entry.source), join(templates, entry.source))
    write(join(outside, entry.source.slice("shared/".length)), "external template must not be copied")
  }
  const fs = new ConfinedLifecycleFileSystem(root, [templates])
  const before = snapshot(root), external = snapshot(outside)
  const pending = refreshResourceTemplates(root, "feature", templates, fs)
  swap(join(templates, "shared"))
  await expect(pending).rejects.toThrow(/symlink/i)
  expect(snapshot(root)).toEqual(before)
  expect(snapshot(outside)).toEqual(external)
})
test("guarded refresh refuses leaf symlinks and replaced regular directory identities", () => {
  write(join(outside, "target.md"), "external content")
  const fs = new ConfinedLifecycleFileSystem(root)
  const leaf = join(root, "resources/SDD_TEMPLATE.md")
  rmSync(leaf); symlinkSync(join(outside, "target.md"), leaf)
  expect(() => fs.writeBytes(leaf, Buffer.from("overwrite"), false)).toThrow(/symlink/i)
  expect(() => fs.readText(leaf)).toThrow(/symlink/i)
  expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("external content")
  renameSync(join(root, "execution"), join(root, "execution-saved")); mkdirSync(join(root, "execution"))
  expect(() => fs.mkdir(join(root, "execution/jobs"))).toThrow("directory identity changed")
})
