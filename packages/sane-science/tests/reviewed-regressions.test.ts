import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { SCIENCE_RUNTIME_POLICY } from "../src/contracts.ts"
import { getScienceEnvironmentStatus, scaffoldScienceEnvironment } from "../src/environments.ts"
import { MarimoRuntimeService } from "../src/marimo-runtime.ts"
import { isolatedWorkspace, verificationRoot } from "./isolated-workspace.ts"

// Synthetic provision receipt is ONLY for filesystem/process contract tests.
// It does not constitute explicit uv provisioning or real Marimo integration evidence.
function controlledEnvironment(workspace: ReturnType<typeof isolatedWorkspace>["workspace"]) {
  const scaffold = scaffoldScienceEnvironment(workspace)
  const { paths, fingerprint } = scaffold
  mkdirSync(join(paths.venv, "bin"), { recursive: true })
  writeFileSync(join(paths.root, ".environment-policy"), `default:1:${fingerprint}\n`)
  writeFileSync(join(paths.root, ".environment.json"), JSON.stringify({
    policy: "default:1", fingerprint, provisionedAt: new Date().toISOString(),
    python: SCIENCE_RUNTIME_POLICY.python, marimo: SCIENCE_RUNTIME_POLICY.marimo,
  }))
  writeFileSync(paths.marimo, "fixture only\n")
  // No HTTP server, Python, package resolution, or notebook kernel is started.
  writeFileSync(paths.python, `#!/bin/sh\nexec /bin/sleep 60\n`, { mode: 0o700 })
  const notebookPath = join(paths.notebooks, "regression.py")
  writeFileSync(notebookPath, "# isolated process fixture\n")
  return { environment: getScienceEnvironmentStatus(workspace), notebookPath }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Missing port"))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

test("scaffolding preserves a conflicting manifest and does not partially populate templates", () => {
  const fixture = isolatedWorkspace()
  try {
    const initial = getScienceEnvironmentStatus(fixture.workspace)
    expect(initial.state).toBe("missing")
    expect(existsSync(initial.paths.root)).toBe(false)
    mkdirSync(initial.paths.root)
    const original = Buffer.from("[project]\nname = 'owned-by-user'\n")
    writeFileSync(initial.paths.manifest, original)
    expect(() => scaffoldScienceEnvironment(fixture.workspace)).toThrow("differs from")
    expect(readFileSync(initial.paths.manifest).equals(original)).toBe(true)
    for (const path of [initial.paths.lockfile, initial.paths.pythonVersion, initial.paths.notebooks, join(initial.paths.root, ".provision.lock")]) {
      expect(existsSync(path)).toBe(false)
    }
  } finally { fixture.dispose() }
})

test("missing interpreter and dangling interpreter link report incompatible instead of throwing", () => {
  const fixture = isolatedWorkspace()
  try {
    const { environment } = controlledEnvironment(fixture.workspace)
    expect(environment.state).toBe("ready")
    unlinkSync(environment.paths.python)
    expect(getScienceEnvironmentStatus(fixture.workspace).state).toBe("incompatible")
    symlinkSync(join(fixture.root, "missing-python"), environment.paths.python)
    expect(getScienceEnvironmentStatus(fixture.workspace).state).toBe("incompatible")
  } finally { fixture.dispose() }
})

test("launch captures mutable options and stop tolerates an already-removed private token directory", async () => {
  const fixture = isolatedWorkspace()
  const service = new MarimoRuntimeService()
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = verificationRoot
  let ref: { notebookPath: string; generation: string } | undefined
  let pid: number | undefined
  try {
    const { environment, notebookPath } = controlledEnvironment(fixture.workspace)
    const port = await unusedPort()
    const options = { workspace: structuredClone(fixture.workspace), environment: structuredClone(environment), notebookPath, port }
    const pending = service.start(options)
    const starting = service.current(notebookPath)!
    ref = { notebookPath, generation: starting.generation }
    // Mutate across the asynchronous bind probe, including nested admission evidence.
    options.port = 1
    options.notebookPath = join(fixture.root, "outside.py")
    options.workspace.primaryPin.inode++
    options.environment.paths.python = "/nonexistent/python"
    const started = await pending
    pid = started.pid
    expect(started.state).toBe("process-started")
    expect(started.port).toBe(port)
    expect(started.notebookPath).toBe(notebookPath)
    const connection = service.connection(ref)
    expect(connection.baseUrl).toBe(`http://127.0.0.1:${port}`)
    expect(dirname(connection.tokenFile).startsWith(`${verificationRoot}/`)).toBe(true)
    rmSync(dirname(connection.tokenFile), { recursive: true })
    const stopped = await service.stop(ref, { interruptTimeoutMs: 500, terminateTimeoutMs: 500, killTimeoutMs: 1000 })
    expect(stopped.state).toBe("stopped")
    expect(stopped.tokenFileCleanup).toBe("complete")
    expect(existsSync(dirname(connection.tokenFile))).toBe(false)
    expect(() => service.connection(ref!)).toThrow("not started")
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    if (ref) await service.stop(ref, { interruptTimeoutMs: 500, terminateTimeoutMs: 500, killTimeoutMs: 1000 })
    if (pid) { try { process.kill(-pid, "SIGKILL") } catch {} }
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
    fixture.dispose()
  }
}, 15_000)
