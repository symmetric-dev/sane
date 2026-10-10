import { join } from "node:path"
import type { ProvisionScienceEnvironmentOptions, ScienceWorkspace } from "./contracts.ts"
import { EnvironmentFileSystem } from "./environment-paths.ts"
import { getScienceEnvironmentStatus, provisionScienceEnvironment } from "./environments.ts"
import { admitMarimoConfiguration } from "./marimo-config.ts"
import type { MarimoBinding } from "./marimo-contracts.ts"
import { MarimoPair } from "./marimo-pair.ts"
import { MarimoRuntimeService } from "./marimo-runtime.ts"
import { MarimoNativeSession } from "./marimo-session.ts"
import type { MarimoRuntimeStopOptions } from "./marimo-runtime-contracts.ts"
import { ScienceWorkspaceError, type OpenScienceNotebookOptions, type ScienceBrowserConnection, type ScienceNotebookRef, type ScienceNotebookStatus, type ScienceSessionRef } from "./science-workspace-contracts.ts"

interface Notebook {
  status: ScienceNotebookStatus
  pair: MarimoPair
  probe: MarimoPair
  native?: MarimoNativeSession
}

const blankNotebook = `import marimo

__generated_with = "0.25.1"
app = marimo.App()


@app.cell
def _():
    return


if __name__ == "__main__":
    app.run()
`

/** Backend-only coordinator. Every asynchronous admission is serialized, including
 * shutdown, so queued operations cannot accidentally adopt a replacement session.
 * Explicitly shut down before disposing. This is not a notebook execution sandbox.
 */
export class ScienceWorkspaceService {
  private readonly workspace: ScienceWorkspace
  private readonly runtime = new MarimoRuntimeService()
  private readonly notebooks = new Map<string, Notebook>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(workspace: ScienceWorkspace) {
    this.workspace = structuredClone(workspace)
    new EnvironmentFileSystem(this.workspace)
  }

  environmentStatus() { return getScienceEnvironmentStatus(this.workspace) }

  provision(options: ProvisionScienceEnvironmentOptions = {}) {
    const captured = { ...options }
    return this.serial(() => {
      for (const notebook of this.notebooks.values()) {
        if (["starting", "process-started", "stopping", "stop-timeout"].includes(this.runtime.get(notebook.status.ref).state)) {
          throw new ScienceWorkspaceError("BUSY", "Stop all owned notebooks before provisioning.")
        }
      }
      return provisionScienceEnvironment(this.workspace, captured)
    })
  }

  /** Creates a blank notebook exclusively; never overwrites or executes source. */
  createNotebook(name: string): Promise<string> {
    return this.serial(async () => {
      this.readyEnvironment()
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.py$/.test(name)) throw new ScienceWorkspaceError("INVALID_INPUT", "Use a simple filename ending in .py.")
      const fs = new EnvironmentFileSystem(this.workspace), path = join(fs.paths.notebooks, name)
      fs.writeExclusive(path, blankNotebook)
      return path
    })
  }

  openNotebook(options: OpenScienceNotebookOptions): Promise<ScienceNotebookStatus> {
    const captured = { ...options }
    return this.serial(() => this.open(captured))
  }

  /** Creates and inspects an owned session without loading a browser frontend.
   * Reopening a disconnected owner requires reconnectNativeNotebook explicitly.
   */
  openNativeNotebook(options: OpenScienceNotebookOptions): Promise<ScienceNotebookStatus> {
    const captured = { ...options }
    return this.serial(async () => {
      const status = await this.open(captured)
      const notebook = this.entry(status.ref)
      if (notebook.native) {
        if (notebook.native.status().state !== "ready" || status.state !== "session-ready") throw new ScienceWorkspaceError("SESSION_NOT_READY", "Refresh or explicitly reconnect the existing native owner.")
        return this.copy(notebook)
      }
      this.runtime.connection(status.ref)
      admitMarimoConfiguration(this.workspace, status.ref.notebookPath)
      // Do not silently convert an existing browser session into a native owner.
      if (status.sessionIds.length || status.selectedSession) throw new ScienceWorkspaceError("BUSY", "Stop the existing notebook sessions before opening a native owner.")
      notebook.native = new MarimoNativeSession(this.runtime, status.ref)
      try { return await this.attachNative(notebook, captured.readinessTimeoutMs) }
      catch (error) {
        notebook.native.close()
        notebook.pair.dispose()
        notebook.probe.dispose()
        try { await this.runtime.stop(status.ref) } finally { this.copy(notebook) }
        throw error
      }
    })
  }

  /** Disconnected owners reattach with fresh inspection; ready owners refresh listing.
   * Never replays mutations or assumes output replay. */
  reconnectNativeNotebook(ref: ScienceNotebookRef, readinessTimeoutMs = 15_000): Promise<ScienceNotebookStatus> {
    const captured = { ...ref }
    return this.serial(async () => {
      const notebook = this.entry(captured)
      if (!notebook.native) throw new ScienceWorkspaceError("SESSION_NOT_READY", "This notebook has no native session owner.")
      if (notebook.native.status().state === "ready") {
        const status = await this.refresh(notebook)
        if (status.state !== "session-ready") throw new ScienceWorkspaceError("SESSION_NOT_READY", "The native session listing is not currently confirmed.")
        return status
      }
      admitMarimoConfiguration(this.workspace, captured.notebookPath)
      return this.attachNative(notebook, readinessTimeoutMs)
    })
  }

  private async attachNative(notebook: Notebook, timeout?: number): Promise<ScienceNotebookStatus> {
    const native = notebook.native!
    delete notebook.status.selectedSession
    const attachment = await native.connect(timeout)
    const ref = { ...notebook.status.ref, sessionId: attachment.sessionId }
    try {
      // The pair execute route registers cells with auto_run=False before inspection.
      const environment = this.readyEnvironment(), connection = this.runtime.connection(ref)
      const inspector = new MarimoPair({ python: environment.paths.python, cwd: environment.paths.root, tokenFile: connection.tokenFile, timeoutMs: timeout ?? 15_000 })
      try { await inspector.inspectCells(this.binding(ref)) }
      finally { inspector.dispose() }
      await this.refresh(notebook)
      this.assertListed(notebook, ref)
      native.confirmReady(attachment.revision)
      notebook.status.selectedSession = ref
      notebook.status.state = "session-ready"
      delete notebook.status.issue
      return this.copy(notebook)
    } catch (error) {
      native.inspectionFailed()
      this.copy(notebook)
      throw error
    }
  }

  private async open(captured: OpenScienceNotebookOptions): Promise<ScienceNotebookStatus> {
    const timeout = captured.readinessTimeoutMs ?? 15_000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new ScienceWorkspaceError("INVALID_INPUT", "Readiness timeout must be between 1 and 60000 milliseconds.")
    const environment = this.readyEnvironment()
    const runtime = await this.runtime.start({ workspace: this.workspace, environment, notebookPath: captured.notebookPath, port: captured.port })
    const ref = { notebookPath: runtime.notebookPath, generation: runtime.generation }
    const previous = this.notebooks.get(ref.notebookPath)
    if (previous?.status.ref.generation === ref.generation) return this.refresh(previous)
    previous?.native?.close()
    previous?.pair.dispose()
    previous?.probe.dispose()
    const status: ScienceNotebookStatus = { ref, runtime, state: "server-unverified", serverReadiness: "unverified", sessionIds: [] }
    // A failed launch is still retained for cleanup and status inspection.
    const tokenFile = runtime.state === "process-started" ? this.runtime.connection(ref).tokenFile : join(environment.paths.root, "unused-token")
    const pairOptions = { python: environment.paths.python, cwd: environment.paths.root, tokenFile }
    const notebook: Notebook = { status, pair: new MarimoPair(pairOptions), probe: new MarimoPair({ ...pairOptions, timeoutMs: 2_000 }) }
    this.notebooks.set(ref.notebookPath, notebook)
    const deadline = Date.now() + timeout
    do {
      await this.refresh(notebook)
      if (notebook.status.serverReadiness === "ready" || notebook.status.state === "failed" || notebook.status.state === "stopped") break
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(150, remaining)))
    } while (Date.now() < deadline)
    return this.copy(notebook)
  }

  /** Cached observation plus current process state; does not claim a fresh HTTP check. */
  currentNotebook(notebookPath: string): ScienceNotebookStatus | undefined {
    const notebook = this.notebooks.get(notebookPath)
    return notebook ? this.copy(notebook) : undefined
  }

  status(ref: ScienceNotebookRef): ScienceNotebookStatus { return this.copy(this.entry(ref)) }

  refreshNotebook(ref: ScienceNotebookRef): Promise<ScienceNotebookStatus> {
    const captured = { ...ref }
    return this.serial(() => this.refresh(this.entry(captured)))
  }

  browserConnection(ref: ScienceNotebookRef): ScienceBrowserConnection {
    const notebook = this.entry(ref), connection = this.runtime.connection(notebook.status.ref)
    const url = new URL(connection.baseUrl)
    url.searchParams.set("access_token", connection.token)
    return { ref: { ...notebook.status.ref }, url: url.toString() }
  }

  /** Never auto-select the first session. Inspection proves the chosen session responds. */
  selectSession(ref: ScienceSessionRef): Promise<ScienceNotebookStatus> {
    const captured = { ...ref }
    return this.serial(async () => {
      const notebook = this.entry(captured)
      if (notebook.native) throw new ScienceWorkspaceError("SESSION_NOT_READY", "Native session selection is owned by openNativeNotebook and reconnectNativeNotebook.")
      await this.refresh(notebook)
      this.assertListed(notebook, captured)
      admitMarimoConfiguration(this.workspace, captured.notebookPath)
      delete notebook.status.selectedSession
      try { await notebook.pair.inspectCells(this.binding(captured)) }
      catch (error) {
        notebook.status.state = "awaiting-session-selection"
        notebook.status.issue = "session-inspection-failed"
        throw error
      }
      this.runtime.connection(captured)
      notebook.status.selectedSession = captured
      notebook.status.state = "session-ready"
      delete notebook.status.issue
      return this.copy(notebook)
    })
  }

  inspectCells(ref: ScienceSessionRef) { return this.operate(ref, (pair, target) => pair.inspectCells(target)) }
  createCell(ref: ScienceSessionRef, code: string, options: { after?: string; run?: boolean } = {}) {
    const captured = { ...options }
    return this.operate(ref, (pair, target) => pair.createCell(target, code, captured))
  }
  editCell(ref: ScienceSessionRef, cellId: string, code: string, expectedSourceHash: string, run = false) {
    return this.operate(ref, (pair, target) => pair.editCell(target, cellId, code, expectedSourceHash, run))
  }
  runCell(ref: ScienceSessionRef, cellId: string) { return this.operate(ref, (pair, target) => pair.runCell(target, cellId)) }

  stopNotebook(ref: ScienceNotebookRef, options: MarimoRuntimeStopOptions = {}): Promise<ScienceNotebookStatus> {
    const captured = { ...ref }, bounds = { ...options }
    return this.serial(async () => {
      const notebook = this.entry(captured)
      // stop validates bounds synchronously before transport ownership changes.
      const stopping = this.runtime.stop(captured, bounds)
      notebook.native?.close()
      notebook.pair.dispose()
      notebook.probe.dispose()
      try { await stopping } finally { this.copy(notebook) }
      return this.copy(notebook)
    })
  }

  shutdown(options: MarimoRuntimeStopOptions = {}): Promise<ScienceNotebookStatus[]> {
    const bounds = { ...options }
    return this.serial(async () => {
      return Promise.all([...this.notebooks.values()].map(async notebook => {
        const stopping = this.runtime.stop(notebook.status.ref, bounds)
        notebook.native?.close()
        notebook.pair.dispose()
        notebook.probe.dispose()
        try { await stopping } finally { this.copy(notebook) }
        return this.copy(notebook)
      }))
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }

  private readyEnvironment() {
    const environment = this.environmentStatus()
    if (environment.state !== "ready") throw new ScienceWorkspaceError("ENVIRONMENT_NOT_READY", "Explicitly provision a compatible environment before opening or creating notebooks.")
    return environment
  }

  private entry(ref: ScienceNotebookRef): Notebook {
    const notebook = this.notebooks.get(ref.notebookPath)
    if (!notebook || notebook.status.ref.generation !== ref.generation) throw new ScienceWorkspaceError("STALE_GENERATION", "No matching owned notebook generation.")
    return notebook
  }

  private copy(notebook: Notebook): ScienceNotebookStatus {
    const status = notebook.status
    status.runtime = this.runtime.get(status.ref)
    if (status.runtime.state !== "process-started") {
      notebook.native?.close()
      notebook.pair.dispose()
      notebook.probe.dispose()
      status.state = status.runtime.state === "stopped" ? "stopped" : "failed"
      status.serverReadiness = "unverified"
      status.sessionIds = []
      delete status.selectedSession
    }
    if (notebook.native) {
      status.nativeSession = notebook.native.status()
      if (status.runtime.state === "process-started" && status.nativeSession.state !== "ready") {
        status.state = "session-lost"
        status.issue = "native-session-disconnected"
        delete status.selectedSession
      }
    }
    return structuredClone(status)
  }

  private async refresh(notebook: Notebook): Promise<ScienceNotebookStatus> {
    if (this.copy(notebook).runtime.state !== "process-started") return this.copy(notebook)
    const status = notebook.status
    try {
      const connection = this.runtime.connection(status.ref)
      const listing = await notebook.probe.listSessions(connection.baseUrl)
      this.runtime.connection(status.ref)
      if (listing.warnings.length) throw new Error("Listing warnings")
      status.sessionIds = [...new Set(listing.notebooks.filter(item => item.path === status.ref.notebookPath).flatMap(item => item.sessions.map(session => session.id)))]
      status.serverReadiness = "ready"
      status.observedAt = new Date().toISOString()
      delete status.issue
      if (status.selectedSession) {
        status.state = status.sessionIds.includes(status.selectedSession.sessionId) ? "session-ready" : "session-lost"
        if (status.state === "session-lost") status.issue = "session-missing"
      } else status.state = status.sessionIds.length ? "awaiting-session-selection" : "awaiting-browser-session"
    } catch {
      status.serverReadiness = "unverified"
      status.state = "server-unverified"
      status.sessionIds = []
      status.issue = "listing-unconfirmed"
    }
    return this.copy(notebook)
  }

  private assertListed(notebook: Notebook, ref: ScienceSessionRef): void {
    if (notebook.status.serverReadiness !== "ready" || !notebook.status.sessionIds.includes(ref.sessionId)) {
      throw new ScienceWorkspaceError("SESSION_NOT_READY", "The exact notebook session is not present in a warning-free authenticated listing.")
    }
  }

  private binding(ref: ScienceSessionRef): MarimoBinding {
    return { url: this.runtime.connection(ref).baseUrl, sessionId: ref.sessionId, serverGeneration: ref.generation }
  }

  private operate<T>(ref: ScienceSessionRef, work: (pair: MarimoPair, target: MarimoBinding) => Promise<T>): Promise<T> {
    const captured = { ...ref }
    return this.serial(async () => {
      const notebook = this.entry(captured)
      await this.refresh(notebook)
      this.assertListed(notebook, captured)
      if (notebook.status.state !== "session-ready" || notebook.status.selectedSession?.sessionId !== captured.sessionId) throw new ScienceWorkspaceError("SESSION_NOT_READY", "Explicitly select and inspect this session first.")
      admitMarimoConfiguration(this.workspace, captured.notebookPath)
      return work(notebook.pair, this.binding(captured))
    })
  }
}
