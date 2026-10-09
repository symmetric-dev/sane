import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { EnvironmentFileSystem } from "./environment-paths.ts"
import { getScienceEnvironmentStatus } from "./environments.ts"
import { admitMarimoConfiguration, marimoProcessEnvironment } from "./marimo-config.ts"
import { MarimoRuntimeError, type MarimoRuntimeConnection, type MarimoRuntimeRef, type MarimoRuntimeSnapshot, type MarimoRuntimeStartOptions, type MarimoRuntimeStopOptions } from "./marimo-runtime-contracts.ts"

interface Entry {
  snapshot: MarimoRuntimeSnapshot
  child?: ChildProcess
  token?: string
  tokenFile?: string
  privateDirectory?: string
  done: boolean
  stopRequested: boolean
  exited: Promise<void>
  resolveExit: () => void
  start: Promise<MarimoRuntimeSnapshot>
  stop?: Promise<MarimoRuntimeSnapshot>
}

// In-memory ownership shared by service instances in this module; not a cross-process lock.
const notebooks = new Map<string, Entry>()
const ports = new Map<number, Entry>()

function bounded(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1 || result > 60_000) throw new MarimoRuntimeError("INVALID_INPUT", "Timeouts must be integers between 1 and 60000 milliseconds.")
  return result
}

function snapshot(entry: Entry): MarimoRuntimeSnapshot {
  return { ...entry.snapshot, notebookIdentity: { ...entry.snapshot.notebookIdentity }, outputBytes: { ...entry.snapshot.outputBytes } }
}

function cleanup(entry: Entry): void {
  entry.token = undefined
  try {
    if (entry.tokenFile) {
      try { unlinkSync(entry.tokenFile) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      entry.tokenFile = undefined
    }
    if (entry.privateDirectory) {
      try { rmdirSync(entry.privateDirectory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      entry.privateDirectory = undefined
    }
    if (entry.snapshot.tokenFileCleanup !== "not-created") entry.snapshot.tokenFileCleanup = "complete"
  } catch {
    entry.snapshot.tokenFileCleanup = "failed"
  }
}

function finish(entry: Entry, code?: number | null, signal?: string | null): void {
  if (entry.done) return
  entry.done = true
  entry.snapshot.exitCode = code
  entry.snapshot.exitSignal = signal
  entry.snapshot.state = entry.snapshot.failure ? "failed" : entry.stopRequested ? "stopped" : "exited"
  // Descendants may hold inherited pipes open. Never wait for stream close to
  // observe server exit, and never retain any of the server's printed token URLs.
  entry.child?.stdout?.destroy()
  entry.child?.stderr?.destroy()
  cleanup(entry)
  if (notebooks.get(entry.snapshot.notebookPath) === entry) notebooks.delete(entry.snapshot.notebookPath)
  if (ports.get(entry.snapshot.port) === entry) ports.delete(entry.snapshot.port)
  entry.resolveExit()
}

function availablePort(port: number, timeout: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    let settled = false
    const complete = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ok) resolvePromise()
      else reject(new MarimoRuntimeError("PORT_UNAVAILABLE", "The requested loopback port is unavailable."))
    }
    const timer = setTimeout(() => { server.close(); complete(false) }, timeout)
    server.once("error", () => complete(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(error => complete(!error))
    })
  })
}

async function waitForExit(entry: Entry, timeout: number): Promise<boolean> {
  if (entry.done) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([entry.exited.then(() => true), new Promise<boolean>(resolvePromise => { timer = setTimeout(() => resolvePromise(false), timeout) })])
  } finally { if (timer) clearTimeout(timer) }
}

function signal(entry: Entry, name: NodeJS.Signals): void {
  if (entry.done || !entry.child?.pid) return
  try { process.kill(-entry.child.pid, name) } catch { /* Exit observation, not signal success, determines the outcome. */ }
}

/** Explicit, local process supervision, with no app wiring or execution commands.
 * start resolves at OS spawn, NOT server readiness. Headless Marimo creates no
 * notebook kernel session until a client opens it. connection() also proves no readiness.
 * Managed TOML policy disables automatic execution/reload, reactive tests and dotenv.
 * CLI server_startup_command is omitted (0.25.1 defaults to None); no shell is used.
 * Path admission is cooperative, not protection from concurrent hostile FS changes.
 * Call stop explicitly before disposing the service/process. No crash recovery exists.
 */
export class MarimoRuntimeService {
  private readonly entries = new Map<string, Entry>()

  start(options: MarimoRuntimeStartOptions): Promise<MarimoRuntimeSnapshot> {
    // Capture nested workspace/environment evidence before any asynchronous work.
    options = structuredClone(options)
    if (process.platform !== "darwin" && process.platform !== "linux") throw new MarimoRuntimeError("UNSUPPORTED_PLATFORM", "Marimo runtime supervision supports macOS and Linux.")
    const timeout = bounded(options.spawnTimeoutMs, 10_000)
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new MarimoRuntimeError("INVALID_INPUT", "An explicit port between 1 and 65535 is required.")
    const admission = this.admit(options)
    admitMarimoConfiguration(options.workspace, options.notebookPath, true)
    const existing = notebooks.get(options.notebookPath)
    if (existing) {
      if (this.entries.get(options.notebookPath) === existing && existing.snapshot.port === options.port && !existing.stopRequested
        && existing.snapshot.notebookIdentity.device === admission.identity.device && existing.snapshot.notebookIdentity.inode === admission.identity.inode) {
        return existing.start.then(() => snapshot(existing))
      }
      throw new MarimoRuntimeError("BUSY", "This notebook already has an owned launch.")
    }
    if (ports.has(options.port)) throw new MarimoRuntimeError("BUSY", "This port already has an owned launch.")
    if (this.entries.get(options.notebookPath)?.snapshot.tokenFileCleanup === "failed") throw new MarimoRuntimeError("BUSY", "Retry stop to clean the previous launch's private files before starting again.")
    let resolveExit!: () => void
    const entry: Entry = {
      snapshot: {
        notebookPath: options.notebookPath, generation: randomUUID(), repositoryId: options.workspace.repositoryId,
        notebookIdentity: admission.identity, state: "starting", host: "127.0.0.1", port: options.port,
        serverReadiness: "unverified", kernelReadiness: "unverified", descendantCleanup: "not-started",
        tokenFileCleanup: "not-created", outputBytes: { stdout: 0, stderr: 0 },
      },
      done: false, stopRequested: false, exited: new Promise<void>(resolvePromise => { resolveExit = resolvePromise }), resolveExit,
      start: undefined as unknown as Promise<MarimoRuntimeSnapshot>,
    }
    notebooks.set(options.notebookPath, entry)
    ports.set(options.port, entry)
    this.entries.set(options.notebookPath, entry)
    entry.start = this.launch(entry, options, timeout)
    return entry.start
  }

  get(ref: MarimoRuntimeRef): MarimoRuntimeSnapshot { return snapshot(this.entry(ref)) }

  /** Also supplies the generation needed to stop an in-flight start. */
  current(notebookPath: string): MarimoRuntimeSnapshot | undefined {
    const entry = this.entries.get(notebookPath)
    return entry ? snapshot(entry) : undefined
  }

  connection(ref: MarimoRuntimeRef): MarimoRuntimeConnection {
    const entry = this.entry(ref)
    if (entry.snapshot.state !== "process-started" || !entry.token || !entry.tokenFile) throw new MarimoRuntimeError("NOT_RUNNING", "The owned process is not started.")
    return { baseUrl: `http://127.0.0.1:${entry.snapshot.port}`, token: entry.token, tokenFile: entry.tokenFile }
  }

  stop(ref: MarimoRuntimeRef, options: MarimoRuntimeStopOptions = {}): Promise<MarimoRuntimeSnapshot> {
    const bounds = [bounded(options.interruptTimeoutMs, 5_000), bounded(options.terminateTimeoutMs, 2_000), bounded(options.killTimeoutMs, 2_000)]
    const entry = this.entry(ref)
    if (entry.stop) return entry.stop
    entry.stopRequested = true
    entry.stop = (async () => {
      await entry.start
      if (!entry.done) {
        entry.snapshot.state = "stopping"
        const signals = ["SIGINT", "SIGTERM", "SIGKILL"] as const
        for (let i = 0; i < signals.length; i++) {
          signal(entry, signals[i]!)
          if (await waitForExit(entry, bounds[i]!)) break
        }
        if (!entry.done) {
          entry.snapshot.state = "stop-timeout"
          entry.snapshot.failure = "stop-timeout"
          // Retain ownership: a timeout is not evidence that the server died.
          cleanup(entry)
        }
      } else if (entry.snapshot.tokenFileCleanup === "failed") cleanup(entry)
      return snapshot(entry)
    })().finally(() => { entry.stop = undefined })
    return entry.stop
  }

  private entry(ref: MarimoRuntimeRef): Entry {
    const entry = this.entries.get(ref.notebookPath)
    if (!entry || entry.snapshot.generation !== ref.generation) throw new MarimoRuntimeError("STALE_GENERATION", "No matching owned notebook launch generation.")
    return entry
  }

  private admit(options: MarimoRuntimeStartOptions): { identity: { device: number; inode: number }; python: string; root: string } {
    try {
      const current = getScienceEnvironmentStatus(options.workspace)
      if (options.environment.state !== "ready" || current.state !== "ready" || current.fingerprint !== options.environment.fingerprint
        || current.paths.root !== options.environment.paths.root || current.paths.python !== options.environment.paths.python
        || current.paths.notebooks !== options.environment.paths.notebooks) throw new MarimoRuntimeError("ENVIRONMENT_NOT_READY", "Matching ready environment evidence is required.")
      const path = options.notebookPath
      if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(`${current.paths.notebooks}/`) || !path.endsWith(".py")) throw new MarimoRuntimeError("UNSAFE_NOTEBOOK", "An exact existing Python notebook path inside science/notebooks is required.")
      const stat = new EnvironmentFileSystem(options.workspace).check(path)
      if (!stat?.isFile()) throw new MarimoRuntimeError("UNSAFE_NOTEBOOK", "The notebook must be an existing regular file without symlink traversal.")
      return { identity: { device: Number(stat.dev), inode: Number(stat.ino) }, python: current.paths.python, root: current.paths.root }
    } catch (error) {
      if (error instanceof MarimoRuntimeError) throw error
      throw new MarimoRuntimeError("UNSAFE_NOTEBOOK", "Environment or notebook path admission failed.")
    }
  }

  private async launch(entry: Entry, options: MarimoRuntimeStartOptions, timeout: number): Promise<MarimoRuntimeSnapshot> {
    try {
      await availablePort(options.port, timeout)
      if (entry.stopRequested) { finish(entry); return snapshot(entry) }
      const admitted = this.admit(options)
      admitMarimoConfiguration(options.workspace, options.notebookPath)
      if (admitted.identity.device !== entry.snapshot.notebookIdentity.device || admitted.identity.inode !== entry.snapshot.notebookIdentity.inode) throw new Error("Notebook replaced")
      entry.privateDirectory = mkdtempSync(join(tmpdir(), "sane-marimo-"))
      chmodSync(entry.privateDirectory, 0o700)
      entry.tokenFile = join(entry.privateDirectory, "token")
      entry.snapshot.tokenFileCleanup = "pending"
      entry.token = randomBytes(32).toString("hex")
      writeFileSync(entry.tokenFile, `${entry.token}\n`, { flag: "wx", mode: 0o600 })
      // Explicit nonzero port prevents Marimo's automatic free-port fallback;
      // a race after our bind probe fails in Marimo, never adopts an external server.
      const child = spawn(admitted.python, ["-m", "marimo", "edit", options.notebookPath, "--headless", "--host", "127.0.0.1",
        "--port", String(options.port), "--token", "--token-password-file", entry.tokenFile, "--no-sandbox", "--skip-update-check"],
      { cwd: admitted.root, env: marimoProcessEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] })
      entry.child = child
      entry.snapshot.pid = child.pid
      entry.snapshot.descendantCleanup = "unverified"
      for (const name of ["stdout", "stderr"] as const) {
        child[name]?.on("data", (bytes: Buffer) => { entry.snapshot.outputBytes[name] = Math.min(Number.MAX_SAFE_INTEGER, entry.snapshot.outputBytes[name] + bytes.length) })
        child[name]?.on("error", () => { /* Raw errors/output never cross the public boundary. */ })
      }
      child.once("exit", (code, signalName) => finish(entry, code, signalName))
      await new Promise<void>(resolvePromise => {
        const timer = setTimeout(() => {
          entry.snapshot.failure = "spawn-timeout"
          signal(entry, "SIGKILL")
          resolvePromise()
        }, timeout)
        child.once("spawn", () => { clearTimeout(timer); if (!entry.done && !entry.snapshot.failure) entry.snapshot.state = "process-started"; resolvePromise() })
        child.on("error", () => {
          clearTimeout(timer)
          entry.snapshot.failure = "launch-failed"
          if (!child.pid) finish(entry)
          resolvePromise()
        })
      })
      if (entry.snapshot.failure && !entry.done) {
        signal(entry, "SIGKILL")
        if (!await waitForExit(entry, 2_000)) { entry.snapshot.state = "stop-timeout"; cleanup(entry) }
      }
    } catch (error) {
      // Spawn/IO errors may contain command arguments or private paths. No cause/raw error escapes.
      entry.snapshot.failure = error instanceof MarimoRuntimeError && error.code === "PORT_UNAVAILABLE" ? "port-unavailable" : "launch-failed"
      if (entry.child?.pid && !entry.done) {
        signal(entry, "SIGKILL")
        if (!await waitForExit(entry, 2_000)) { entry.snapshot.state = "stop-timeout"; cleanup(entry) }
      } else finish(entry)
    }
    return snapshot(entry)
  }
}
