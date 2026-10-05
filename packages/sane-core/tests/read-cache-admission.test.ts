import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import * as childProcess from "node:child_process"
import * as nodefs from "node:fs"
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DomainError } from "../src/server.ts"
import type { DomainErrorCode } from "../src/contracts.ts"
import * as repository from "../src/repository.ts"
import * as schema from "../src/schema-upgrade.ts"
import { ConfinedLifecycleFileSystem } from "../src/confined-lifecycle-filesystem.ts"
import { fixture, mutation } from "./fixtures.ts"

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup(linked = false) { const f = fixture(linked); cleanups.push(f.cleanup); return f }
function settle() { const spy = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000); cleanups.push(() => spy.mockRestore()) }
function warm(f: ReturnType<typeof setup>) { settle(); f.domain.validatePolling(); f.domain.validatePolling() }
function code(action: () => unknown, expected: DomainErrorCode) {
  try { action(); throw new Error("Expected failure") }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(expected) }
}
function environment(name: string, value: string) {
  const old = process.env[name]; process.env[name] = value
  cleanups.push(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old })
}
function fullPolling(f: ReturnType<typeof setup>) {
  const checkout = spyOn(repository, "checkDiscovery")
  cleanups.push(() => checkout.mockRestore())
  for (let i = 0; i < 2; i++) {
    try { f.domain.validatePolling() }
    catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe("INVALID_CHECKOUT") }
  }
  expect(checkout).toHaveBeenCalledTimes(2)
}

test("ordinary settled polling keeps checkout and complete store admission cheap", () => {
  const f = setup()
  warm(f)
  const checkout = spyOn(repository, "checkDiscovery"), integrity = spyOn(schema, "assertStoreIntegrity"), capabilities = spyOn(schema, "assertSchemaCapabilities")
  cleanups.push(() => { checkout.mockRestore(); integrity.mockRestore(); capabilities.mockRestore() })
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  for (let i = 0; i < 3; i++) { f.domain.validatePolling(); expect(f.domain.listWorkstreams()).toEqual([]) }
  expect(checkout).not.toHaveBeenCalled()
  expect(integrity).not.toHaveBeenCalled()
  expect(capabilities).not.toHaveBeenCalled()
})

test.each(["recent guard", "first settled guard"])("same-coarse-tick include edits are reclassified at the %s", stage => {
  const f = setup(), config = join(f.context.commonDir, "config"), included = join(f.temporary, "coarse-included.config")
  const pad = (text: string) => text + "#" + "x".repeat(511 - Buffer.byteLength(text))
  const simple = pad(readFileSync(config, "utf8") + "\n")
  writeFileSync(config, simple); writeFileSync(included, "[user]\n\tname = Before\n")
  const actualLstat = nodefs.lstatSync, actualFstat = nodefs.fstatSync
  const coarse = actualLstat(config), coarseBig = actualLstat(config, { bigint: true })
  const lstat = spyOn(nodefs, "lstatSync").mockImplementation(((path: any, options: any) => path === config ? options?.bigint ? coarseBig : coarse : actualLstat(path, options)) as typeof nodefs.lstatSync)
  const fstat = spyOn(nodefs, "fstatSync").mockImplementation(((fd: number, options: any) => {
    const info = actualFstat(fd, options)
    if (String(info.dev) === String(coarse.dev) && String(info.ino) === String(coarse.ino)) return options?.bigint ? coarseBig : coarse
    return info
  }) as typeof nodefs.fstatSync)
  const recent = Math.ceil(coarse.ctimeMs) + 1000, clock = spyOn(Date, "now").mockReturnValue(recent)
  cleanups.push(() => { clock.mockRestore(); fstat.mockRestore(); lstat.mockRestore() })
  f.domain.validateHandle()
  const changed = pad(readFileSync(config, "utf8").split("\n#")[0]! + `\n[include]\n\tpath = ${included}\n`)
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(simple))
  writeFileSync(config, changed)
  expect(nodefs.lstatSync(config, { bigint: true })).toBe(coarseBig)
  if (stage === "recent guard") f.domain.validateHandle()
  clock.mockReturnValue(recent + 60_000)
  f.domain.validatePolling(); f.domain.validatePolling()
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  writeFileSync(included, "[user]\n\tname = After\n")
  fullPolling(f)
  // Returning to a genuinely simple shape can become cacheable only after a
  // new settled classification, even though all mocked config stats still match.
  writeFileSync(config, simple)
  f.domain.validateHandle(); f.domain.validatePolling()
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
})

test.each(["objects", "refs"])("symlinked Git %s stays unsupported after settling and target deletion fails closed", name => {
  const f = setup(), path = join(f.context.commonDir, name), target = join(f.temporary, `external-${name}`)
  renameSync(path, target); symlinkSync(target, path)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  fullPolling(f)
  rmSync(target, { recursive: true })
  code(() => f.domain.validatePolling(), "INVALID_CHECKOUT")
  code(() => f.domain.validatePolling(), "INVALID_CHECKOUT")
})

test.each(["earlier candidate", "selected candidate"])("unchanged PATH does not hide installation/replacement of a Git %s", kind => {
  const f = setup(), priority = join(f.temporary, "priority")
  mkdirSync(priority)
  const originalPath = process.env.PATH!, originalGit = childProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  const candidate = join(priority, "git")
  if (kind === "selected candidate") symlinkSync(originalGit, candidate)
  environment("PATH", `${priority}:${originalPath}`)
  warm(f)
  const before = repository.repositoryEvidence(f.domain.context, "checkout"), path = process.env.PATH
  expect(before).toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  const checkout = spyOn(repository, "checkDiscovery")
  cleanups.push(() => checkout.mockRestore())
  f.domain.validatePolling(); expect(checkout).not.toHaveBeenCalled()
  if (kind === "selected candidate") rmSync(candidate)
  writeFileSync(candidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
  expect(process.env.PATH).toBe(path)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(before)
  code(() => f.domain.validatePolling(), "INVALID_CHECKOUT")
  expect(checkout).toHaveBeenCalledTimes(1)
})

test("relative PATH selection remains unsupported after settling, regardless of spawning cwd semantics", () => {
  const f = setup(), priority = join(f.repo, "priority")
  mkdirSync(priority)
  environment("PATH", `priority:${process.env.PATH}`)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  writeFileSync(join(priority, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
  // Bun currently searches the parent cwd; Node may search the requested child
  // cwd. Either full Git result is authoritative, never a cached classification.
  fullPolling(f)
})

test("a selected script wrapper cannot reuse configuration-root discovery even when its outputs match Git", () => {
  const f = setup(), priority = join(f.temporary, "wrapper")
  mkdirSync(priority)
  const originalGit = childProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  writeFileSync(join(priority, "git"), `#!/bin/sh\nexec '${originalGit}' "$@"\n`, { mode: 0o700 })
  environment("PATH", `${priority}:${process.env.PATH}`)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  fullPolling(f)
})

test.skipIf(process.platform !== "darwin")("Apple developer-selector identity changes invalidate roots without environment/config changes", () => {
  // Exercise Apple's wrapper explicitly even when the user's PATH prefers Homebrew Git.
  environment("PATH", "/usr/bin:/bin")
  const selection = childProcess.execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim()
  environment("DEVELOPER_DIR", selection)
  const f = setup()
  warm(f)
  const before = repository.repositoryEvidence(f.domain.context, "checkout"), environmentSnapshot = JSON.stringify(process.env)
  expect(before).toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  const actualLstat = nodefs.lstatSync
  const lstat = spyOn(nodefs, "lstatSync").mockImplementation(((path: any, options: any) => {
    const info = actualLstat(path, options)
    if (path !== selection) return info
    return Object.assign(Object.create(info), { ino: options?.bigint ? BigInt(info.ino) + 1n : Number(info.ino) + 1 })
  }) as typeof nodefs.lstatSync)
  const spawn = spyOn(childProcess, "execFileSync"), checkout = spyOn(repository, "checkDiscovery")
  cleanups.push(() => { checkout.mockRestore(); spawn.mockRestore(); lstat.mockRestore() })
  expect(JSON.stringify(process.env)).toBe(environmentSnapshot)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(before)
  f.domain.validatePolling()
  expect(checkout).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls.some(([command]) => command === "/usr/bin/xcode-select")).toBe(true)
  expect(spawn.mock.calls.some(([command]) => command === "/usr/bin/xcrun")).toBe(true)
})

test.each(["include", "includeIf"])("%s configuration cannot reuse admission after its external dependency changes", section => {
  const f = setup(), config = join(f.context.commonDir, "config"), included = join(f.temporary, "included.config")
  const header = section === "include" ? "[include]" : `[includeIf "gitdir:${f.context.commonDir}/"]`
  writeFileSync(included, "[core]\n\tworktree = " + f.repo + "\n")
  writeFileSync(config, readFileSync(config, "utf8") + `\n${header}\n\tpath = ${included}\n`)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  const other = join(f.temporary, "other"); mkdirSync(other)
  writeFileSync(included, "[core]\n\tworktree = " + other + "\n")
  // Git setup does not use included core.worktree on every Git version. The
  // cache must still defer to full discovery rather than assume that behavior.
  fullPolling(f)
})

test.each(["config", "pointer"])("symlinked %s inputs never hide target mapping changes", kind => {
  const f = setup(kind === "pointer"), path = kind === "config" ? join(f.context.commonDir, "config") : join(f.checkout, ".git")
  const target = join(f.temporary, "mapping-target")
  renameSync(path, target); symlinkSync(target, path)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  if (kind === "config") {
    const other = join(f.temporary, "other"); mkdirSync(other)
    writeFileSync(target, readFileSync(target, "utf8") + `\n[core]\n\tworktree = ${other}\n`)
  } else writeFileSync(target, "gitdir: missing-administration\n")
  code(() => f.domain.validatePolling(), "INVALID_CHECKOUT")
})

test("global config absence is fenced, and a new mapping override forces full Git validation", () => {
  const f = setup(), home = join(f.temporary, "home"), xdg = join(f.temporary, "xdg")
  mkdirSync(home); mkdirSync(xdg)
  environment("HOME", home); environment("XDG_CONFIG_HOME", xdg)
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  const other = join(f.temporary, "other"); mkdirSync(other)
  writeFileSync(join(home, ".gitconfig"), `[core]\n\tworktree = ${other}\n`)
  fullPolling(f)
})

test.each(["include", "symlink"])("global %s dependencies use conservative admission rather than assuming local-only Git", kind => {
  const f = setup(), home = join(f.temporary, "home"), target = join(f.temporary, "global-target")
  mkdirSync(home); environment("HOME", home); environment("XDG_CONFIG_HOME", join(home, "xdg"))
  writeFileSync(target, "[user]\n\tname = Regression\n")
  if (kind === "include") writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${target}\n`)
  else symlinkSync(target, join(home, ".gitconfig"))
  warm(f)
  expect(repository.repositoryEvidence(f.domain.context, "checkout")).not.toBe(repository.repositoryEvidence(f.domain.context, "checkout"))
  const other = join(f.temporary, "other"); mkdirSync(other)
  writeFileSync(target, `[core]\n\tworktree = ${other}\n`)
  fullPolling(f)
})

test.each(["workstreams", "locks"])("polling rechecks original admission after required %s directory deletion", name => {
  const f = setup()
  warm(f)
  rmSync(join(f.stateRoot, name), { recursive: true })
  code(() => f.domain.validatePolling(), "CORRUPT_STORE")
  code(() => f.domain.validatePolling(), "CORRUPT_STORE")
  mkdirSync(join(f.stateRoot, name))
  const integrity = spyOn(schema, "assertStoreIntegrity")
  cleanups.push(() => integrity.mockRestore())
  f.domain.validatePolling()
  expect(integrity).toHaveBeenCalledTimes(1)
})

test("polling invalidation rejects an external FK violation with unchanged schema and metadata", () => {
  const f = setup()
  warm(f)
  const db = new Database(f.context.databasePath)
  try { db.exec("PRAGMA foreign_keys=OFF"); db.query("INSERT INTO memberships VALUES('orphan','missing-conversation','missing-workstream',?,NULL)").run(new Date().toISOString()) }
  finally { db.close() }
  code(() => f.domain.validatePolling(), "CORRUPT_STORE")
  code(() => f.domain.validatePolling(), "CORRUPT_STORE")
})

test("polling invalidation retains lifecycle row integrity admission", () => {
  const f = setup()
  f.domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  warm(f)
  const db = new Database(f.context.databasePath)
  try {
    const triggers = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='phase_states'").all()
    db.transaction(() => {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`)
      db.exec("DELETE FROM phase_states WHERE workstream_id='alpha' AND phase='design'")
      for (const trigger of triggers) db.exec(trigger.sql)
    }).immediate()
  } finally { db.close() }
  code(() => f.domain.validatePolling(), "CORRUPT_STORE")
})

test("malformed UTF8 research keeps registration and bulk-status decoded-text hash parity with one confined read", () => {
  const f = setup()
  f.domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  const report = join(f.stateRoot, "workstreams/alpha/research/topic.md"), bytes = Buffer.from([0x23, 0x20, 0xff, 0x0a])
  writeFileSync(report, bytes)
  const contentHash = createHash("sha256").update(bytes.toString("utf8")).digest("hex")
  expect(f.domain.registerResearch("alpha", "topic", "research/topic.md", mutation).registered[0]).toEqual(expect.objectContaining({ contentHash, missing: false, modified: false }))
  warm(f)
  const read = spyOn(ConfinedLifecycleFileSystem.prototype, "readBytes")
  cleanups.push(() => read.mockRestore())
  for (const action of [() => f.domain.getResearchIndex("alpha"), () => f.domain.getStatus("alpha").research, () => f.domain.listStatuses()[0]!.research]) {
    read.mockClear()
    expect(action().registered[0]).toEqual(expect.objectContaining({ contentHash, modified: false }))
    expect(read).toHaveBeenCalledTimes(1)
  }
  writeFileSync(report, Buffer.from([0x23, 0x20, 0xfe, 0x0a]))
  expect(f.domain.getResearchIndex("alpha").registered[0]!.modified).toBe(false)
})
