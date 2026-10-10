import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RepositoryReader } from "../src/repository-reader.ts"
import { discoverRepository, inspectRepositoryStore } from "../src/repository.ts"
import { openRepositoryDomain } from "../src/server.ts"
import { fixture } from "./fixtures.ts"

test("off-thread discovery and inspection preserve DTOs and error codes", async () => {
  const f = fixture(true), reader = new RepositoryReader()
  try {
    const discovery = await reader.discover(f.checkout)
    expect(discovery).toEqual(discoverRepository(f.checkout))
    expect(await reader.inspect(discovery)).toEqual(inspectRepositoryStore(discovery))
    await expect(reader.discover("relative")).rejects.toMatchObject({ code: "INVALID_CONTEXT" })
    writeFileSync(join(f.stateRoot, "complete.json"), "broken")
    expect(await reader.inspect(discovery)).toMatchObject({ state: "corrupt", code: "CORRUPT_STORE" })
  } finally { await reader.close(); f.cleanup() }
})

test("replacement binding during an asynchronous inspection is refused", async () => {
  const f = fixture(), reader = new RepositoryReader()
  try {
    f.domain.close()
    const pending = reader.inspect(f.context)
    renameSync(f.repo, f.repo + "-saved"); mkdirSync(f.repo)
    for (const name of [".git", ".sane"]) renameSync(join(f.repo + "-saved", name), join(f.repo, name))
    expect(await pending).toMatchObject({ state: "stale-binding", code: "STALE_BINDING" })
  } finally { await reader.close(); f.cleanup() }
})

test("read results cannot bypass the main-thread domain opening fence", async () => {
  const f = fixture(), reader = new RepositoryReader()
  try {
    const store = await reader.inspect(f.context)
    expect(store.state).toBe("ready")
    writeFileSync(join(f.stateRoot, "complete.json"), "broken")
    if (store.state === "ready") expect(() => openRepositoryDomain(store.context)).toThrow()
  } finally { await reader.close(); f.cleanup() }
})

test("reader yields to the event loop, bounds admission, cancels queued/active work and closes", async () => {
  const f = fixture(), reader = new RepositoryReader({ concurrency: 1, capacity: 2 })
  try {
    const active = new AbortController(), queued = new AbortController()
    let ticked = false
    const first = reader.discover(f.repo, { signal: active.signal })
    const second = reader.discover(f.repo, { signal: queued.signal })
    const firstRejected = first.catch(error => error)
    const secondRejected = second.catch(error => error)
    await expect(reader.discover(f.repo)).rejects.toMatchObject({ code: "BUSY" })
    await new Promise<void>(resolve => setTimeout(() => { ticked = true; active.abort(); queued.abort(); resolve() }, 0))
    for (const result of await Promise.all([firstRejected, secondRejected])) expect(result).toMatchObject({ code: "UNAVAILABLE" })
    expect(ticked).toBe(true)
    const pending = reader.discover(f.repo)
    const rejected = pending.catch(error => error)
    await reader.close()
    expect(await rejected).toMatchObject({ code: "UNAVAILABLE" })
    await expect(reader.discover(f.repo)).rejects.toMatchObject({ code: "UNAVAILABLE" })
  } finally { await reader.close(); f.cleanup() }
})

test("deadline includes queued time and does not poison subsequent reads", async () => {
  const f = fixture(), reader = new RepositoryReader({ concurrency: 1 })
  try {
    await expect(reader.discover(f.repo, { timeoutMs: 1 })).rejects.toMatchObject({ code: "UNAVAILABLE" })
    const active = reader.discover(f.repo)
    await expect(reader.discover(f.repo, { timeoutMs: 1 })).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect((await active).primaryCheckout).toBe(f.repo)
    expect((await reader.discover(f.repo)).primaryCheckout).toBe(f.repo)
  } finally { await reader.close(); f.cleanup() }
})

test("slow Git evidence subprocesses leave main-thread timers runnable", async () => {
  const f = fixture(), reader = new RepositoryReader(), path = process.env.PATH
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const bin = join(f.temporary, "bin"); mkdirSync(bin)
    writeFileSync(join(bin, "git"), `#!/bin/sh\n/bin/sleep 0.05\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${path}`
    const pending = reader.discover(f.repo)
    process.env.PATH = path
    let ticks = 0
    timer = setInterval(() => ticks++, 5)
    expect((await pending).primaryCheckout).toBe(f.repo)
    expect(ticks).toBeGreaterThan(5)
  } finally { clearInterval(timer); process.env.PATH = path; await reader.close(); f.cleanup() }
})

test("cancellation shutdown reaps an in-flight Git evidence child", async () => {
  const f = fixture(), reader = new RepositoryReader(), path = process.env.PATH, controller = new AbortController()
  let pid: number | undefined
  try {
    const bin = join(f.temporary, "bin"), pidFile = join(f.temporary, "child.pid"); mkdirSync(bin)
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 20\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${path}`
    const pending = reader.discover(f.repo, { signal: controller.signal }).catch(error => error)
    process.env.PATH = path
    const deadline = Date.now() + 2000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    pid = Number(readFileSync(pidFile, "utf8").trim())
    controller.abort()
    expect(await pending).toMatchObject({ code: "UNAVAILABLE" })
    await reader.close()
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    process.env.PATH = path
    if (pid) try { process.kill(pid, "SIGKILL") } catch {}
    await reader.close(); f.cleanup()
  }
}, 10_000)
