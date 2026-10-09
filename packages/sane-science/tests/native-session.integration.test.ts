import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { ScienceWorkspaceService } from "../src/science-workspace.ts"
import { isolatedWorkspace, verificationRoot } from "./isolated-workspace.ts"

// Explicit opt-in: installs the locked environment and starts real local processes.
const integration = process.env.SCIENCE_RUN_NATIVE === "1" ? test : test.skip

function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)!
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! }
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert(address && typeof address !== "string")
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

async function eventually(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observable runtime state")
    await Bun.sleep(50)
  }
}

integration("native ownership provisions, executes, explicitly reconnects, and rejects stale generations", async () => {
  const fixture = isolatedWorkspace()
  const evidenceRoot = mkdtempSync(join(verificationRoot, "science-native-evidence-"))
  const evidence: unknown[] = []
  const record = (stage: string, value: unknown) => {
    evidence.push({ at: new Date().toISOString(), stage, value })
    writeFileSync(join(evidenceRoot, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  }
  async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now()
    try {
      const result = await work()
      record(name, { elapsedMs: Date.now() - start, result })
      return result
    } catch (error) {
      record(name, { elapsedMs: Date.now() - start, error: String(error) })
      throw error
    }
  }
  console.log("NATIVE_EVIDENCE", evidenceRoot)
  const service = new ScienceWorkspaceService(fixture.workspace)
  const owned = new Map<number, ReturnType<typeof processes>[number]>()
  const tokenFiles = new Set<string>()
  function capture() {
    const all = processes()
    const ids = new Set(all.filter(p => p.command.includes(fixture.root)).map(p => p.pid))
    let size = -1
    while (size !== ids.size) {
      size = ids.size
      for (const p of all) if (ids.has(p.ppid)) ids.add(p.pid)
    }
    for (const p of all.filter(p => ids.has(p.pid))) {
      owned.set(p.pid, p)
      const token = /--token-password-file\s+(\S+)/.exec(p.command)?.[1]
      if (token) tokenFiles.add(token)
    }
    return all.filter(p => owned.has(p.pid) && owned.get(p.pid)!.command === p.command)
  }
  let competitor: WebSocket | undefined
  try {
    expect(service.environmentStatus().state).toBe("missing")
    const environment = await stage("provision", () => service.provision())
    expect(environment.state).toBe("ready")
    const versions = execFileSync(environment.paths.python, ["-I", "-c", "import importlib.metadata,json,sys; print(json.dumps({'python':sys.version.split()[0], 'marimo':importlib.metadata.version('marimo'), 'pandas':importlib.metadata.version('pandas'), 'matplotlib':importlib.metadata.version('matplotlib')}))"], { encoding: "utf8", timeout: 15_000 })
    record("versions", JSON.parse(versions))
    expect(JSON.parse(versions).marimo).toBe("0.25.1")
    const notebookPath = await service.createNotebook("native-verification.py")
    const port = await freePort()
    const options = { notebookPath, port, readinessTimeoutMs: 15_000 }
    const opened = await stage("native-open", () => service.openNativeNotebook(options))
    record("live-processes", capture())
    expect(opened.state).toBe("session-ready")
    expect(opened.nativeSession?.state).toBe("ready")
    expect(opened.nativeSession?.attachment).toBe("new")
    assert(opened.selectedSession)
    const ref = opened.ref, session = opened.selectedSession
    expect(opened.sessionIds).toContain(session.sessionId)
    expect(tokenFiles.size).toBe(1)
    for (const path of tokenFiles) expect(existsSync(path)).toBe(true)
    const initial = await stage("initial-inspection", () => service.inspectCells(session))
    expect(initial.cells.length).toBeGreaterThan(0)
    const sourceBefore = 'print("NATIVE_TEXT_BEFORE")\nnative_value = 41'
    const sourceAfter = 'print("NATIVE_TEXT_AFTER")\nnative_value = 42'
    const created = await stage("create", () => service.createCell(session, sourceBefore, { run: false }))
    expect(created.mutation).toBe("accepted")
    expect(created.execution).toBe("not-requested")
    const before = (await service.inspectCells(session)).cells.find(c => c.id === created.cellId)!
    expect(before.code).toBe(sourceBefore)
    const edited = await stage("edit", () => service.editCell(session, before.id, sourceAfter, before.sourceHash, false))
    expect(edited.mutation).toBe("accepted")
    expect(edited.execution).toBe("not-requested")
    const run = await stage("text-run", () => service.runCell(session, before.id))
    expect(run.execution).toBe("succeeded")
    expect(JSON.stringify(run.snapshot?.cells.find(c => c.id === before.id)?.consoleOutputs)).toContain("NATIVE_TEXT_AFTER")
    const stale = await stage("stale-source", () => service.editCell(session, before.id, 'raise RuntimeError("MUST_NOT_RUN")', before.sourceHash, true))
    expect(stale.mutation).toBe("rejected")
    expect(stale.execution).toBe("not-requested")
    expect((await service.inspectCells(session)).cells.find(c => c.id === before.id)?.code).toBe(sourceAfter)
    const table = await stage("table-run", () => service.createCell(session, 'import pandas as pd\nnative_df = pd.DataFrame({"label": ["alpha", "beta"], "value": [1, 2]})\nnative_df', { run: true }))
    expect(table.execution).toBe("succeeded")
    const tableOutput = table.snapshot?.cells.find(c => c.id === table.cellId)?.output
    assert(tableOutput)
    expect(JSON.stringify(tableOutput.data)).toContain("alpha")
    expect(JSON.stringify(tableOutput.data)).toContain("beta")
    const plot = await stage("plot-run", () => service.createCell(session, 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nnative_fig, native_ax = plt.subplots()\nnative_ax.plot([1, 2, 3], [1, 4, 9])\nnative_fig', { run: true }))
    expect(plot.execution).toBe("succeeded")
    const plotOutput = plot.snapshot?.cells.find(c => c.id === plot.cellId)?.output
    assert(plotOutput)
    const png = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(plotOutput.data))?.[1]
    assert(png, "Plot must capture a PNG, not merely any output")
    expect(Buffer.from(png, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    writeFileSync(join(evidenceRoot, "plot.png"), Buffer.from(png, "base64"))
    writeFileSync(join(evidenceRoot, "table.json"), JSON.stringify(tableOutput, null, 2))
    const settled = await service.inspectCells(session)
    const pinnedSources = settled.cells.map(c => ({ id: c.id, code: c.code, sourceHash: c.sourceHash }))
    await expect(service.inspectCells({ ...session, sessionId: "not-owned" })).rejects.toMatchObject({ code: "SESSION_NOT_READY" })
    const healthy = await stage("ready-reconnect-preserves-revision", () => service.reconnectNativeNotebook(ref))
    expect(healthy.nativeSession?.revision).toBe(opened.nativeSession?.revision)

    // Marimo 0.25.1 SessionConnector._reconnect_session closes a lingering same-ID
    // consumer. Exercise actual transport loss using public connection credentials.
    const connection = new URL(service.browserConnection(ref).url)
    const token = connection.searchParams.get("access_token")!
    const socketUrl = new URL(`/ws?session_id=${session.sessionId}`, connection.origin)
    socketUrl.protocol = "ws:"
    competitor = new WebSocket(socketUrl, { headers: { Authorization: `Bearer ${token}` } })
    await stage("disconnect", async () => {
      await eventually(() => service.status(ref).nativeSession?.state === "disconnected")
      return service.status(ref)
    })
    expect(service.status(ref).state).toBe("session-lost")
    expect(service.status(ref).selectedSession).toBeUndefined()
    await expect(service.inspectCells(session)).rejects.toMatchObject({ code: "SESSION_NOT_READY" })
    await expect(service.openNativeNotebook(options)).rejects.toMatchObject({ code: "SESSION_NOT_READY" })
    const reconnected = await stage("explicit-reconnect", () => service.reconnectNativeNotebook(ref))
    expect(reconnected.state).toBe("session-ready")
    expect(reconnected.selectedSession).toEqual(session)
    expect(reconnected.nativeSession?.attachment).toBe("reconnected")
    expect(reconnected.nativeSession?.revision).toBe(opened.nativeSession!.revision + 1)
    competitor.close()
    competitor = undefined
    const afterReconnect = await stage("reconnect-inspection", () => service.inspectCells(session))
    expect(afterReconnect.cells.map(c => ({ id: c.id, code: c.code, sourceHash: c.sourceHash }))).toEqual(pinnedSources)
    record("before-stop-processes", capture())
    const stopped = await stage("stop", () => service.stopNotebook(ref))
    expect(stopped.state).toBe("stopped")
    expect(stopped.selectedSession).toBeUndefined()
    expect(stopped.runtime.tokenFileCleanup).toBe("complete")
    await eventually(() => capture().length === 0)
    for (const path of tokenFiles) expect(existsSync(path)).toBe(false)
    await expect(service.inspectCells(session)).rejects.toMatchObject({ code: "SESSION_NOT_READY" })
    const reopened = await stage("reopen", () => service.openNativeNotebook(options))
    record("reopened-processes", capture())
    expect(reopened.state).toBe("session-ready")
    expect(reopened.ref.generation).not.toBe(ref.generation)
    expect(reopened.selectedSession?.sessionId).not.toBe(session.sessionId)
    await expect(service.inspectCells(session)).rejects.toMatchObject({ code: "STALE_GENERATION" })
    await expect(service.reconnectNativeNotebook(ref)).rejects.toMatchObject({ code: "STALE_GENERATION" })
    await expect(service.stopNotebook(ref)).rejects.toMatchObject({ code: "STALE_GENERATION" })
    expect(service.status(reopened.ref).state).toBe("session-ready")
    record("saved-notebook", readFileSync(notebookPath, "utf8"))
  } finally {
    competitor?.close()
    capture()
    try {
      record("shutdown", await service.shutdown())
      await Bun.sleep(500)
    } finally {
      const remaining = capture()
      record("cleanup-before-fallback", { remaining, tokenFiles: [...tokenFiles].map(path => ({ path, exists: existsSync(path) })) })
      for (const p of remaining) { try { process.kill(p.pid, "SIGTERM") } catch {} }
      if (remaining.length) await Bun.sleep(500)
      const afterTerm = capture()
      for (const p of afterTerm) { try { process.kill(p.pid, "SIGKILL") } catch {} }
      if (afterTerm.length) await Bun.sleep(250)
      const final = capture()
      record("cleanup-final", final)
      fixture.dispose()
      expect(final).toEqual([])
      expect(remaining).toEqual([])
      for (const path of tokenFiles) expect(existsSync(path)).toBe(false)
    }
  }
}, 360_000)
