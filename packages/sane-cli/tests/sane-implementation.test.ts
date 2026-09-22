import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { Database } from "bun:sqlite"
import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import { createJob, getSessionWorkstream, getWorkstreamImplementation, initSchema, listSelections, openSaneDb, setCurrentWorkstream } from "../src/sane-db.ts"
import { bindAndLinkSession } from "../src/sane-link-tool.ts"
import { resolveCommandAddress, resolveCwdTarget } from "../src/sane-cwd-target.ts"
import { resolveImplementationRoot, validateImplementationWorktree } from "../src/sane-implementation.ts"
import { resolveOrCreateSession } from "../src/sane-handoff-command.ts"
import { buildJobBundle } from "../src/sane-job-command.ts"
import { runSaneViewCommand } from "../src/sane-view-command.ts"
import { runSaneLinkCommand, parseCliArguments } from "../src/sane-link-command.ts"

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args])
const bare = { implementationRepository: "", workstreamPath: "" }
const mutation = { actorRole: "execution", sessionId: "ses_a" }

describe("persistent implementation and session targeting", () => {
  let temp: string, repo: string, wt: string, db: Database
  const identity = () => ({ repoRoot: repo, user: "alice", workstreamId: "one" })
  beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), "sane-implementation-")))
    repo = join(temp, "repo")
    wt = join(temp, "worktree")
    await mkdir(repo)
    await git(repo, "init")
    await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init")
    await git(repo, "worktree", "add", "-b", "implementation", wt)
    await initializeSaneRepository({ implementationRepository: repo, write: () => {} })
    for (const workstreamPath of ["one", "two"]) await createSaneRepositoryWorkstream({
      implementationRepository: repo, workstreamPath, userOverride: "alice", type: "feature",
      templateRoot: resolve(import.meta.dir, "../../..", "templates"), write: () => {},
    })
    db = await openSaneDb(repo)
    initSchema(db)
  })
  afterEach(async () => {
    db?.close()
    await rm(temp, { recursive: true, force: true })
  })

  test("main-directory sessions remain isolated across selection changes and slot replacement", async () => {
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: wt, worktreePath: repo })
    await bindAndLinkSession(db, { ...identity(), workstreamId: "two" }, { slot: "execution", sessionId: "ses_b" })
    setCurrentWorkstream(db, { ...identity(), workstreamId: "two" }, mutation)
    expect((await resolveCommandAddress(bare, { cwd: repo, sessionId: "ses_a", userOverride: "alice" })).workstreamPath).toBe("one")
    expect((await resolveCommandAddress(bare, { cwd: repo, sessionId: "ses_b", userOverride: "alice" })).workstreamPath).toBe("two")
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_c", force: true })
    expect((await resolveCwdTarget(repo, "alice", "ses_a")).workstreamId).toBe("one")
    expect(await resolveImplementationRoot(db, identity())).toBe(wt)
    expect(await resolveCommandAddress({ implementationRepository: repo, workstreamPath: "two" }, { sessionId: "ses_a" })).toMatchObject({ workstreamPath: "two" })
  })

  test("explicit first link from an unregistered worktree discovers the main repository", async () => {
    const address = await resolveCommandAddress({ ...bare, workstreamPath: "one" }, { cwd: wt, sessionId: "ses_new", userOverride: "alice" })
    expect(address.implementationRepository).toBe(repo)
    const result = await runSaneLinkCommand({ ...address, slot: "design", sessionId: "ses_new", implementationWorktree: wt, write: () => {} })
    expect(result.implementationRoot).toBe(wt)
    expect((await resolveCwdTarget(wt, "alice")).workstreamId).toBe("one")
    const parsed = parseCliArguments([repo, "one", "--slot", "design", "--session", "ses_new", "--implementation-worktree", wt, "--reassign"])
    expect(parsed).toMatchObject({ implementationWorktree: wt, reassign: true })
  })

  test("bare subprocess commands consume the injected session environment", async () => {
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_env" })
    const module = resolve(import.meta.dir, "../src/sane-cwd-target.ts")
    const script = `import { resolveCommandAddress } from ${JSON.stringify(module)}; console.log(JSON.stringify(await resolveCommandAddress({implementationRepository:'',workstreamPath:''},{userOverride:'alice'})))`
    const { stdout } = await exec(process.execPath, ["--eval", script], { cwd: repo, env: { ...process.env, SANE_SESSION_ID: "ses_env", OPENCODE_SESSION_ID: "ses_unbound" } })
    expect(JSON.parse(stdout).workstreamPath).toBe("one")
    const inherited: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SESSION_ID: "ses_env" }
    delete inherited.SANE_SESSION_ID
    const fallback = await exec(process.execPath, ["--eval", script], { cwd: repo, env: inherited })
    expect(JSON.parse(fallback.stdout).workstreamPath).toBe("one")
  })

  test("rejects foreign repos and non-root paths, canonicalizes symlinks, and refuses stale roots", async () => {
    const foreign = join(temp, "foreign")
    await mkdir(foreign)
    await git(foreign, "init")
    await expect(bindAndLinkSession(db, identity(), { ...mutation, slot: "execution", implementationWorktree: foreign })).rejects.toThrow("different Git repository")
    expect(getWorkstreamImplementation(db, identity())).toBeNull()
    expect(listSelections(db, identity())).toHaveLength(0)
    const sub = join(wt, "sub")
    await mkdir(sub)
    await expect(validateImplementationWorktree(repo, sub)).rejects.toThrow("worktree root")
    const alias = join(temp, "alias")
    await symlink(wt, alias)
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: alias })
    expect(getWorkstreamImplementation(db, identity())?.worktree_path).toBe(wt)
    await git(repo, "worktree", "remove", "--force", wt)
    await expect(resolveImplementationRoot(db, identity())).rejects.toThrow("Invalid implementation worktree")
  })

  test("reassignment is explicit and failed slot replacement rolls back both bindings", async () => {
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: wt })
    await expect(bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_b", implementationWorktree: repo, reassign: true })).rejects.toThrow("--force")
    expect(getWorkstreamImplementation(db, identity())?.worktree_path).toBe(wt)
    expect(getSessionWorkstream(db, { ...identity(), sessionId: "ses_b" })).toBeNull()
    await expect(bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: repo, force: true })).rejects.toThrow("--reassign")
    const other = { ...identity(), workstreamId: "two" }
    await expect(bindAndLinkSession(db, other, { slot: "execution", sessionId: "ses_a", force: true })).rejects.toThrow("--reassign")
    await bindAndLinkSession(db, other, { slot: "execution", sessionId: "ses_a", reassign: true })
    expect(listSelections(db, identity())).toHaveLength(0)
    expect(getSessionWorkstream(db, { ...identity(), sessionId: "ses_a" })).toBe("two")
  })

  test("handoff creation binds the new session while retaining its main-directory location", async () => {
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: wt })
    const bodies: unknown[] = []
    await resolveOrCreateSession(db, identity(), { slot: "planning", serverUrl: "http://localhost:4096", mutation,
      fetchImpl: async (url, init) => {
        if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(String(url).includes("/api/agent") ? { data: [{ id: "sane/assistant/planning" }] } : { id: "ses_child" }))
      },
    })
    expect(bodies[0]).toMatchObject({ location: { directory: repo } })
    expect((await resolveCwdTarget(repo, "alice", "ses_child")).workstreamId).toBe("one")
    expect(await resolveImplementationRoot(db, identity())).toBe(wt)
  })

  test("job and view distinguish implementation checkout from canonical document roots", async () => {
    await bindAndLinkSession(db, identity(), { slot: "execution", sessionId: "ses_a", implementationWorktree: wt })
    createJob(db, identity(), { jobId: "01", specPath: "execution/jobs/01.md" }, mutation)
    const root = join(repo, ".sane", "workstreams", "one")
    const bundle = await buildJobBundle(db, identity(), { path: root, type: "feature" }, "01")
    expect(bundle.implementationRoot).toBe(wt)
    expect(bundle.repoRoot).toBe(repo)
    expect(bundle.job.specPath).toBe(join(root, "execution/jobs/01.md"))
    const output: string[] = []
    await runSaneViewCommand({ implementationRepository: repo, workstreamPath: "one", userOverride: "alice", json: true, write: (line) => output.push(line) })
    expect(JSON.parse(output[0]!)).toMatchObject({ repo_root: repo, implementation_directory: wt })
  })
})
