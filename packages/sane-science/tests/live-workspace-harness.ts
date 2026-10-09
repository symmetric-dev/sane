// Explicit manual harness: bun tests/live-workspace-harness.ts <verification-context.json>
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ScienceWorkspaceService } from "../src/science-workspace.ts"
import type { ScienceSessionRef } from "../src/science-workspace-contracts.ts"

const contextPath = process.argv[2]
if (!contextPath) throw new Error("Supply retained verification-context.json")
const context = JSON.parse(readFileSync(contextPath, "utf8"))
const root = dirname(contextPath)
const service = new ScienceWorkspaceService(context.workspace)
const evidence: unknown[] = []
function record(step: string, result: unknown) {
  const item = { at: new Date().toISOString(), step, result }
  evidence.push(item)
  writeFileSync(join(root, "live-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  return item
}
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)!
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! }
  })
}
const owned = new Map<number, ReturnType<typeof processes>[number]>()
function descendants(pid: number) {
  const all = processes(), ids = new Set([pid])
  let size = 0
  while (size !== ids.size) { size = ids.size; for (const p of all) if (ids.has(p.ppid)) ids.add(p.pid) }
  const found = all.filter(p => ids.has(p.pid))
  for (const p of found) owned.set(p.pid, p)
  return found
}
let session: ScienceSessionRef | undefined
let finished = false
let bridge: ReturnType<typeof Bun.serve> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
async function shutdown(reason: string) {
  if (finished) return
  finished = true
  if (timer) clearTimeout(timer)
  const before = descendants(opened.runtime.pid!)
  const result = await service.shutdown()
  await Bun.sleep(500)
  const remaining = processes().filter(p => owned.has(p.pid) && owned.get(p.pid)!.command === p.command)
  record("shutdown", { reason, before, result, remaining })
  for (const p of remaining) { try { process.kill(p.pid, "SIGTERM") } catch {} }
  if (remaining.length) await Bun.sleep(500)
  const afterTerm = processes().filter(p => owned.has(p.pid) && owned.get(p.pid)!.command === p.command)
  for (const p of afterTerm) { try { process.kill(p.pid, "SIGKILL") } catch {} }
  if (afterTerm.length) await Bun.sleep(250)
  record("final-process-check", processes().filter(p => owned.has(p.pid) && owned.get(p.pid)!.command === p.command))
  setTimeout(() => bridge?.stop(true), 200)
  return evidence
}

const environment = service.environmentStatus()
assert.equal(environment.state, "ready")
record("explicitly-provisioned-status", environment)
const notebookPath = await service.createNotebook("live-verification.py")
const opened = await service.openNotebook({ notebookPath, port: 28731 })
record("opened", opened)
console.log(JSON.stringify({ root, opened, bridge: "http://127.0.0.1:28730" }))
try {
  assert.equal(opened.serverReadiness, "ready")
  assert.equal(opened.state, "awaiting-browser-session")
} catch (error) { await service.shutdown(); throw error }
const ref = opened.ref

async function exercise() {
  assert(session)
  const initial = await service.inspectCells(session)
  record("initial-inspection", initial)
  const created = await service.createCell(session, 'print("SANE_TEXT_BEFORE")\nvalue = 41', { run: false })
  record("create", created)
  assert.equal(created.mutation, "accepted")
  const before = (await service.inspectCells(session)).cells.find(c => c.id === created.cellId)!
  const edited = await service.editCell(session, before.id, 'print("SANE_TEXT_AFTER")\nvalue = 42', before.sourceHash, false)
  record("edit", edited)
  assert.equal(edited.mutation, "accepted")
  const run = await service.runCell(session, before.id)
  record("text-run", run)
  assert.equal(run.execution, "succeeded")
  assert(JSON.stringify(run.snapshot?.cells.find(c => c.id === before.id)?.consoleOutputs).includes("SANE_TEXT_AFTER"))
  const stale = await service.editCell(session, before.id, 'raise RuntimeError("MUST_NOT_RUN")', before.sourceHash, true)
  record("stale-source", stale)
  assert.equal(stale.mutation, "rejected")
  assert.equal(stale.execution, "not-requested")
  const table = await service.createCell(session, 'import pandas as pd\ndf = pd.DataFrame({"label": ["alpha", "beta"], "value": [1, 2]})\ndf', { run: true })
  record("dataframe-run", table)
  assert.equal(table.execution, "succeeded")
  const tableCell = table.snapshot?.cells.find(c => c.id === table.cellId)
  assert(tableCell?.output)
  const plot = await service.createCell(session, 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2, 3], [1, 4, 9])\nfig', { run: true })
  record("plot-run", plot)
  assert.equal(plot.execution, "succeeded")
  const plotCell = plot.snapshot?.cells.find(c => c.id === plot.cellId)
  assert(plotCell?.output)
  const wrong = { ...session, sessionId: "not-the-selected-session" }
  let wrongError: unknown
  try { await service.inspectCells(wrong) } catch (error) { wrongError = { code: (error as any).code, message: (error as Error).message } }
  assert.equal((wrongError as any)?.code, "SESSION_NOT_READY")
  record("no-silent-retarget", { wrongError, status: service.status(ref) })
  const tree = descendants(opened.runtime.pid!)
  record("live-descendants", tree)
  return { text: run.snapshot?.cells.find(c => c.id === before.id)?.consoleOutputs, table: { mimetype: tableCell.output.mimetype, data: tableCell.output.data }, plot: { mimetype: plotCell.output.mimetype, dataPrefix: JSON.stringify(plotCell.output.data).slice(0, 200), dataBytes: JSON.stringify(plotCell.output.data).length }, stale: { mutation: stale.mutation, execution: stale.execution }, tree }
}

bridge = Bun.serve({ hostname: "127.0.0.1", port: 28730, idleTimeout: 120, async fetch(request) {
  try {
    const path = new URL(request.url).pathname
    if (path === "/browser") return Response.json(service.browserConnection(ref))
    if (request.method !== "POST") return new Response("POST required", { status: 405 })
    const command = await request.json() as { action: string; sessionId?: string }
    let result: unknown
    if (command.action === "refresh") result = record("refresh", await service.refreshNotebook(ref))
    else if (command.action === "select") {
      assert(command.sessionId)
      session = { ...ref, sessionId: command.sessionId }
      result = record("selected", await service.selectSession(session))
    } else if (command.action === "exercise") result = await exercise()
    else if (command.action === "reconnect") {
      assert(session)
      const refreshed = await service.refreshNotebook(ref)
      const inspected = await service.inspectCells(session)
      assert.equal(refreshed.selectedSession?.sessionId, session.sessionId)
      result = record("reconnected", { status: refreshed, cells: inspected.cells.map(c => ({ id: c.id, sourceHash: c.sourceHash, mimetype: c.output?.mimetype })) })
    } else if (command.action === "stop") { await shutdown("command"); result = { stopped: true, evidence: join(root, "live-evidence.json") } }
    else throw new Error("Unknown command")
    return Response.json(result)
  } catch (error) {
    const result = record("command-error", { name: (error as Error).name, message: (error as Error).message, code: (error as any).code })
    return Response.json(result, { status: 500 })
  }
} })
timer = setTimeout(() => { void shutdown("deadline") }, 600_000)
process.on("SIGINT", () => { void shutdown("SIGINT") })
process.on("SIGTERM", () => { void shutdown("SIGTERM") })
