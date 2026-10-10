import { createHash, randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { MarimoPairError, type MarimoBinding, type MarimoCell, type MarimoListing, type MarimoOperationResult, type MarimoOutput, type MarimoPairOptions, type MarimoSnapshot } from "./marimo-contracts.ts"
import { inspectSnippet, operationSnippet, type CellOperation } from "./marimo-snippets.ts"
import { scienceTimed } from "./timing.ts"
import { MarimoHttp, marimoExecutionEvents } from "./marimo-http.ts"

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object")
  return value as ObjectValue
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string"); return value }
function strings(value: unknown): string[] { if (!Array.isArray(value)) throw new Error("Expected array"); return value.map(text) }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Expected array"); return value }
function nullableText(value: unknown): string | null { return value === null ? null : text(value) }
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 100) throw new Error("Output nesting exceeds limit")
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach(item => jsonValue(item, depth + 1)); return }
  for (const item of Object.values(object(value))) jsonValue(item, depth + 1)
}
function input(value: string, name: string): void {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new MarimoPairError("INVALID_INPUT", `Invalid ${name}`)
}
function loopback(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid URL")
    return url.toString().replace(/\/$/, "")
  } catch { throw new MarimoPairError("INVALID_INPUT", "Pair requires an HTTP numeric-loopback URL without credentials, query, or fragment") }
}
function binding(value: MarimoBinding): MarimoBinding {
  input(value.sessionId, "session ID"); input(value.serverGeneration, "server generation")
  return { url: loopback(value.url), sessionId: value.sessionId, serverGeneration: value.serverGeneration }
}

/** SHA-256 of exact UTF-8 cell source, without whitespace normalization. */
export function marimoSourceHash(code: string): string {
  if (typeof code !== "string" || Buffer.from(code, "utf8").toString("utf8") !== code)
    throw new MarimoPairError("INVALID_INPUT", "Cell source must contain valid Unicode")
  return createHash("sha256").update(code, "utf8").digest("hex")
}

function output(value: unknown): MarimoOutput {
  const o = object(value)
  text(o.channel); text(o.mimetype)
  if (!("data" in o) || typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) throw new Error("Invalid MIME output")
  jsonValue(o.data)
  return o as unknown as MarimoOutput
}
function snapshot(value: unknown, target: MarimoBinding): MarimoSnapshot {
  const root = object(value), graph = object(root.graph)
  const statuses = [null, "idle", "exception", "stale", "cancelled", "interrupted", "marimo-error", "disabled", "queued", "running"]
  const cells = array(root.cells).map(value => {
    const c = object(value)
    text(c.id); text(c.name)
    if (text(c.sourceHash) !== marimoSourceHash(text(c.code)) || !statuses.includes(c.status as string | null)) throw new Error("Invalid cell source/status")
    array(c.errors).forEach(value => { const e = object(value); text(e.message); if (e.kind !== "graph" && e.kind !== "runtime") throw new Error("Invalid cell error") })
    if (c.output !== null) output(c.output)
    array(c.consoleOutputs).forEach(output)
    return c as unknown as MarimoCell
  })
  if (new Set(cells.map(c => c.id)).size !== cells.length) throw new Error("Duplicate cell IDs")
  const edges = (value: unknown) => Object.fromEntries(Object.entries(object(value)).map(([id, ids]) => [id, strings(ids)]))
  return { binding: target, cells, graph: { parents: edges(graph.parents), children: edges(graph.children) } }
}

interface Envelope {
  success: boolean
  stdout: string | null
  stderr: string | null
  error?: string
  session: { id: string | null }
}
function record(stdout: string | null, marker: string): unknown {
  const matches = (stdout ?? "").split(/\r?\n/).filter(line => line.startsWith(marker))
  if (matches.length !== 1) throw new Error("Missing or ambiguous result record")
  return JSON.parse(matches[0]!.slice(marker.length))
}

/** Version-pinned persistent HTTP adapter. Serializes its own calls; does not lock browser edits.
 * Source hashes are conflict checks, not atomic CAS. The caller must validate its
 * serverGeneration against its supervisor before admission; pair only pins sessionId.
 * No request is retried. Dispose on runtime stop; construct a new adapter for a new runtime.
 * Construction is offline; the first explicitly requested operation opens HTTP.
 */
export class MarimoPair {
  private readonly options: Required<MarimoPairOptions>
  private readonly verified = new Map<string, Promise<void>>()
  private readonly transport: MarimoHttp
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: MarimoPairOptions) {
    for (const [name, path] of Object.entries({ python: options.python, tokenFile: options.tokenFile, cwd: options.cwd })) {
      input(path, name)
      if (!isAbsolute(path)) throw new MarimoPairError("INVALID_INPUT", `${name} must be absolute`)
    }
    this.options = { ...options, timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024 }
    for (const n of [this.options.timeoutMs, this.options.maxOutputBytes]) if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) throw new MarimoPairError("INVALID_INPUT", "Invalid process limit")
    this.transport = new MarimoHttp(this.options)
  }

  /** Abort in-flight requests, reject queued/future work, and release pooled sockets. */
  dispose(): void { this.transport.dispose(); this.verified.clear() }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }

  private version(url: string): Promise<void> {
    let verified = this.verified.get(url)
    if (!verified) {
      verified = this.transport.request(url, "/api/version").then(result => {
        if (result.trim() !== "0.25.1") throw new MarimoPairError("VERSION_MISMATCH", "Pair requires authenticated marimo 0.25.1")
      }).catch(error => { this.verified.delete(url); throw error })
      this.verified.set(url, verified)
    }
    return verified
  }

  listSessions(url: string): Promise<MarimoListing> {
    const target = loopback(url)
    return this.serial(async () => {
      await this.version(target)
      const result = await this.transport.request(target, "/api/sessions")
      try {
        const grouped = new Map<string | null, MarimoListing["notebooks"][number]>()
        for (const [id, value] of Object.entries(object(JSON.parse(result)))) {
          input(id, "session ID")
          const session = object(value), name = nullableText(session.filename), path = nullableText(session.path)
          const key = path || name
          const notebook = grouped.get(key) ?? { server: { url: target }, name, path, sessions: [] }
          notebook.sessions.push({ id })
          grouped.set(key, notebook)
        }
        const notebooks = [...grouped.values()]
        for (const notebook of notebooks) notebook.sessions.sort((a, b) => a.id.localeCompare(b.id))
        notebooks.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || (a.path ?? "").localeCompare(b.path ?? ""))
        return { notebooks, warnings: [] }
      } catch { throw new MarimoPairError("INVALID_RESPONSE", "Invalid pair session listing") }
    })
  }

  private async execute(target: MarimoBinding, code: string): Promise<Envelope> {
    await this.version(target.url)
    // SessionManager.get_session also accepts consumer aliases. Require a literal
    // /api/sessions key before admission so standalone callers cannot use aliases.
    try {
      const sessions = object(JSON.parse(await this.transport.request(target.url, "/api/sessions")))
      if (!Object.hasOwn(sessions, target.sessionId)) throw new MarimoPairError("PAIR_FAILED", "Exact pair session is stale or missing; refresh session listing", "not-started")
    } catch (error) {
      if (error instanceof MarimoPairError) throw error
      throw new MarimoPairError("INVALID_RESPONSE", "Exact pair session could not be confirmed: invalid session listing", "not-started")
    }
    const result = await this.transport.request(target.url, "/api/kernel/execute", target.sessionId, code)
    try { return { ...marimoExecutionEvents(result), session: { id: target.sessionId } } }
    catch { throw new MarimoPairError("INVALID_RESPONSE", "Unconfirmed pair execution response; inspect before retrying", "unknown") }
  }

  private async inspect(target: MarimoBinding): Promise<MarimoSnapshot> {
    const marker = `SANE_${randomUUID().replaceAll("-", "")}:`
    const result = await this.execute(target, inspectSnippet(marker))
    if (!result.success) throw new MarimoPairError("PAIR_FAILED", result.error ?? result.stderr ?? "Inspection failed", "unknown")
    try { return snapshot(record(result.stdout, marker), target) }
    catch { throw new MarimoPairError("INVALID_RESPONSE", "Invalid cell snapshot", "unknown") }
  }

  inspectCells(target: MarimoBinding): Promise<MarimoSnapshot> {
    const pinned = binding(target)
    return this.serial(() => this.inspect(pinned))
  }

  createCell(target: MarimoBinding, code: string, options: { after?: string; run?: boolean } = {}): Promise<MarimoOperationResult> {
    marimoSourceHash(code)
    if (options.after !== undefined) input(options.after, "after cell ID")
    return this.operation(binding(target), { kind: "create", code, after: options.after, run: options.run ?? false })
  }

  editCell(target: MarimoBinding, cellId: string, code: string, expectedSourceHash: string, run = false): Promise<MarimoOperationResult> {
    input(cellId, "cell ID"); marimoSourceHash(code)
    if (!/^[a-f0-9]{64}$/.test(expectedSourceHash)) throw new MarimoPairError("INVALID_INPUT", "Expected a SHA-256 source hash")
    return this.operation(binding(target), { kind: "edit", cellId, code, expectedSourceHash, run })
  }

  runCell(target: MarimoBinding, cellId: string): Promise<MarimoOperationResult> {
    input(cellId, "cell ID")
    return this.operation(binding(target), { kind: "run", cellId, run: true })
  }

  private operation(target: MarimoBinding, operation: CellOperation): Promise<MarimoOperationResult> {
    return this.serial(async () => {
      await this.version(target.url)
      const marker = `SANE_${randomUUID().replaceAll("-", "")}:`
      const result: MarimoOperationResult = {
        binding: target, cellId: operation.kind === "create" ? "" : operation.cellId,
        mutation: operation.kind === "run" ? "not-requested" : "unknown",
        execution: operation.run ? "unknown" : "not-requested", durability: "unconfirmed", stdout: "", stderr: "",
      }
      let response: Envelope
      try { response = await this.execute(target, operationSnippet(operation, marker)) }
      catch (error) { result.error = error instanceof Error ? error.message : "Unconfirmed execution"; return result }
      result.stdout = response.stdout ?? ""; result.stderr = response.stderr ?? ""
      if (response.error) result.error = response.error
      try {
        const acceptance = object(record(response.stdout, marker))
        const id = text(acceptance.cellId)
        if (!id || (operation.kind !== "create" && id !== operation.cellId)) throw new Error("Invalid cell ID")
        if (operation.kind === "run" ? acceptance.mutation !== "not-requested" : !["accepted", "rejected"].includes(text(acceptance.mutation))) throw new Error("Invalid acceptance")
        result.cellId = id
        result.mutation = acceptance.mutation as MarimoOperationResult["mutation"]
        if (result.mutation === "rejected") { result.execution = "not-requested"; result.error = "Source hash conflict" }
        else if (operation.run) result.execution = response.success ? "succeeded" : "failed"
      } catch { result.error ??= "Mutation acceptance unconfirmed; inspect before retrying" }
      // A separate request is necessary: outputs are frozen at scratchpad start.
      if (result.mutation === "accepted" || result.execution === "succeeded" || result.execution === "failed") {
        try { result.snapshot = await scienceTimed("pair-post-operation-capture", () => this.inspect(target)) }
        catch (error) { result.snapshotError = error instanceof Error ? error.message : "Snapshot failed" }
      }
      return result
    })
  }
}
