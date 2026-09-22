import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { injectShellSession, resolveToolWorkstream, SanePlugin } from "../opencode/plugins/sane/index.ts"
import { initializeSaneRepository } from "../packages/sane-cli/src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../packages/sane-cli/src/create-sane-repository-workstream.ts"
import { selectSaneWorkstream } from "../packages/sane-cli/src/select-sane-workstream.ts"
import { getSessionWorkstream, getWorkstreamImplementation, initSchema, listSelectionsBySlot, openSaneDb, resolveSaneIdentity } from "../packages/sane-cli/src/sane-db.ts"

const exec = promisify(execFile)

test("shell hook isolates concurrent session identities and covers compound commands", async () => {
  const original = process.env.OPENCODE_SESSION_ID
  const ids = ["ses_one", "ses_two'quoted"]
  const output = await Promise.all(ids.map(async (sessionID) => {
    const event = { tool: "shell", sessionID, input: { command: 'printf "%s\\n" "$OPENCODE_SESSION_ID"; sh -c \'printf "%s" "$OPENCODE_SESSION_ID"\'', workdir: "/" } }
    injectShellSession(event)
    expect(event.input.workdir).toBe("/")
    return (await exec("/bin/sh", ["-c", event.input.command])).stdout
  }))
  expect(output).toEqual(ids.map(id => `${id}\n${id}`))
  expect(process.env.OPENCODE_SESSION_ID).toBe(original)
  const read = { tool: "read", sessionID: "ses_read", input: { command: "unchanged" } }
  injectShellSession(read)
  expect(read.input.command).toBe("unchanged")
})

test("session lookup failure and absent directory never use process.cwd", async () => {
  await expect(resolveToolWorkstream("ses_missing", { session: { get: async () => { throw new Error("offline") } } })).rejects.toThrow("offline")
  await expect(resolveToolWorkstream("ses_missing", { session: { get: async () => ({}) } })).rejects.toThrow("has no working directory")
})

let repo = ""
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "sane-plugin-binding-")))
  await exec("git", ["init", "--quiet", repo])
  await initializeSaneRepository({ implementationRepository: repo, write() {} })
  for (const workstreamPath of ["01-one", "02-two"]) {
    await createSaneRepositoryWorkstream({ implementationRepository: repo, workstreamPath, type: "feature", write() {} })
  }
})
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }) })

type Tool = { name: string; execute(input: unknown, ctx: { sessionID: string }): Promise<unknown> }
async function load(sessions: Record<string, { location: { directory: string }; parentID?: string }>) {
  const tools = new Map<string, Tool>()
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  await SanePlugin.setup({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions[sessionID]) throw new Error("unknown session")
        return sessions[sessionID]
      },
      hook: async (name: string, callback: any) => { hooks.set(name, callback) },
    },
    tool: {
      transform: async (callback: any) => callback({ add: (tool: Tool) => tools.set(tool.name, tool) }),
      hook: async (name: string, callback: any) => { hooks.set(name, callback) },
    },
  } as never)
  return { tools, hooks }
}

test("explicit workstream binding survives pointer changes and plugin reload", async () => {
  await selectSaneWorkstream({ implementationRepository: repo, workstreamPath: "02-two", write() {} })
  const sessions = { ses_bound: { location: { directory: repo } } }
  const first = await load(sessions)
  await first.tools.get("sane_link")!.execute({ slot: "design", workstream: "01-one" }, { sessionID: "ses_bound" })
  const second = await load(sessions)
  await second.tools.get("sane_link")!.execute({ slot: "planning" }, { sessionID: "ses_bound" })
  const identity = await resolveSaneIdentity(repo, "01-one")
  const db = await openSaneDb(repo)
  try {
    initSchema(db)
    expect(listSelectionsBySlot(db, identity, "planning").map(row => row.session_id)).toEqual(["ses_bound"])
    expect(listSelectionsBySlot(db, { ...identity, workstreamId: "02-two" }, "planning")).toEqual([])
  } finally { db.close() }
})

test("child ancestry inherits durable context and shell CLI routing without registering a phase", async () => {
  await selectSaneWorkstream({ implementationRepository: repo, workstreamPath: "02-two", write() {} })
  const sessions = {
    ses_parent: { location: { directory: repo } },
    ses_middle: { location: { directory: repo }, parentID: "ses_parent" },
    ses_child: { location: { directory: repo }, parentID: "ses_middle" },
  }
  const plugin = await load(sessions)
  await plugin.tools.get("sane_link")!.execute({ slot: "design", workstream: "01-one" }, { sessionID: "ses_parent" })
  const context = { sessionID: "ses_child", system: [] as Array<{ text: string }> }
  await plugin.hooks.get("context")!(context)
  expect(context.system[0]?.text).toContain("Workstream: 01-one")
  expect(context.system[0]?.text).toContain(`Implementation root: ${repo}`)
  expect(context.system[0]?.text).toContain("bare SANE commands use its durable binding")
  const identity = await resolveSaneIdentity(repo, "01-one")
  const db = await openSaneDb(repo)
  try {
    expect(getSessionWorkstream(db, { ...identity, sessionId: "ses_child" })).toBe("01-one")
    expect(listSelectionsBySlot(db, identity, "design").map(row => row.session_id)).toEqual(["ses_parent"])
  } finally { db.close() }
  const shell = { tool: "shell", sessionID: "ses_child", input: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "../bin/sane.ts"))} status --json` } }
  await plugin.hooks.get("execute.before")!(shell)
  const result = await exec("/bin/sh", ["-c", shell.input.command], { cwd: repo, env: { ...process.env, SANE_SESSION_ID: "stale-parent-env" } })
  expect(JSON.parse(result.stdout).workstream_id).toBe("01-one")
})

test("explicit child binding wins over ancestry and conflicting links fail", async () => {
  const plugin = await load({
    ses_parent: { location: { directory: repo } },
    ses_child: { location: { directory: repo }, parentID: "ses_parent" },
  })
  await plugin.tools.get("sane_link")!.execute({ slot: "design", workstream: "01-one" }, { sessionID: "ses_parent" })
  await plugin.tools.get("sane_link")!.execute({ slot: "design", workstream: "02-two" }, { sessionID: "ses_child" })
  const context = { sessionID: "ses_child", system: [] as Array<{ text: string }> }
  await plugin.hooks.get("context")!(context)
  expect(context.system[0]?.text).toContain("Workstream: 02-two")
  await expect(plugin.tools.get("sane_link")!.execute({ slot: "research", workstream: "01-one" }, { sessionID: "ses_child" })).rejects.toThrow("already linked to workstream")
  await plugin.tools.get("sane_link")!.execute({ slot: "research", workstream: "01-one", reassign: true }, { sessionID: "ses_child" })
  const reassigned = { sessionID: "ses_child", system: [] as Array<{ text: string }> }
  await plugin.hooks.get("context")!(reassigned)
  expect(reassigned.system[0]?.text).toContain("Workstream: 01-one")
})

test("worker in a linked worktree receives separate canonical artifact and implementation roots", async () => {
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"])
  const worktree = join(repo, "implementation")
  await exec("git", ["-C", repo, "worktree", "add", "--detach", worktree])
  const plugin = await load({
    ses_parent: { location: { directory: repo } },
    ses_worker: { location: { directory: worktree }, parentID: "ses_parent" },
  })
  await plugin.tools.get("sane_link")!.execute({ slot: "execution", workstream: "01-one", implementation_worktree: worktree }, { sessionID: "ses_parent" })
  const event = { sessionID: "ses_worker", system: [] as Array<{ text: string }> }
  await plugin.hooks.get("context")!(event)
  expect(event.system[0]?.text).toContain(`Artifacts root: ${join(repo, ".sane/workstreams/01-one")}`)
  expect(event.system[0]?.text).toContain(`Implementation root: ${worktree}`)
})

test("validated plugin binding rejects foreign checkouts and rolls back failed slot links", async () => {
  const plugin = await load({
    ses_owner: { location: { directory: repo } },
    ses_other: { location: { directory: repo } },
  })
  await plugin.tools.get("sane_link")!.execute({ slot: "execution", workstream: "01-one" }, { sessionID: "ses_owner" })
  const foreign = join(repo, "foreign")
  await exec("git", ["init", "--quiet", foreign])
  await expect(plugin.tools.get("sane_link")!.execute({ slot: "research", workstream: "01-one", implementation_worktree: foreign }, { sessionID: "ses_other" })).rejects.toThrow("different Git repository")
  await expect(plugin.tools.get("sane_link")!.execute({ slot: "execution", workstream: "01-one", implementation_worktree: repo }, { sessionID: "ses_other" })).rejects.toThrow('Slot "execution" is already linked')
  const identity = await resolveSaneIdentity(repo, "01-one")
  const db = await openSaneDb(repo)
  try {
    expect(getSessionWorkstream(db, { ...identity, sessionId: "ses_other" })).toBeNull()
    expect(getWorkstreamImplementation(db, identity)).toBeNull()
  } finally { db.close() }
})
