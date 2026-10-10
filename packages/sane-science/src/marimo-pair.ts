import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { MarimoPairError, type MarimoBinding, type MarimoCell, type MarimoListing, type MarimoOperationResult, type MarimoOutput, type MarimoPairOptions, type MarimoSnapshot } from "./marimo-contracts.ts"
import { inspectSnippet, operationSnippet, type CellOperation } from "./marimo-snippets.ts"
import { marimoProcessEnvironment } from "./marimo-config.ts"
import { scienceSpan, scienceTimed } from "./timing.ts"

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
function envelope(raw: string, target: MarimoBinding, exitCode: number): Envelope {
  const e = object(JSON.parse(raw)), s = object(e.session)
  if (typeof e.success !== "boolean" || nullableText(s.id) !== target.sessionId) throw new Error("Invalid execution session")
  nullableText(e.stdout); nullableText(e.stderr)
  if (e.error !== undefined) text(e.error)
  if (e.next !== undefined) text(e.next)
  if (e.output !== null) { const o = object(e.output); text(o.mimetype); text(o.data) }
  if (e.success ? exitCode !== 0 || e.stdout === null || e.stderr === null || e.error !== undefined : ![1, 2].includes(exitCode)) throw new Error("Inconsistent execution envelope")
  return e as unknown as Envelope
}
function record(stdout: string | null, marker: string): unknown {
  const matches = (stdout ?? "").split(/\r?\n/).filter(line => line.startsWith(marker))
  if (matches.length !== 1) throw new Error("Missing or ambiguous result record")
  return JSON.parse(matches[0]!.slice(marker.length))
}

/** Version-pinned CLI adapter. Serializes its own calls; does not lock browser edits.
 * Source hashes are conflict checks, not atomic CAS. The caller must validate its
 * serverGeneration against its supervisor before admission; pair only pins sessionId.
 * No request is retried. Construct a new adapter after replacing its interpreter.
 */
export class MarimoPair {
  private readonly options: Required<MarimoPairOptions>
  private verified?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: MarimoPairOptions) {
    for (const [name, path] of Object.entries({ python: options.python, tokenFile: options.tokenFile, cwd: options.cwd })) {
      input(path, name)
      if (!isAbsolute(path)) throw new MarimoPairError("INVALID_INPUT", `${name} must be absolute`)
    }
    this.options = { ...options, timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024 }
    for (const n of [this.options.timeoutMs, this.options.maxOutputBytes]) if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) throw new MarimoPairError("INVALID_INPUT", "Invalid process limit")
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }

  private process(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env = marimoProcessEnvironment()
    const end = scienceSpan(args[0] === "-c" ? "pair-version-process-wall" : stdin === undefined ? "pair-list-process-wall" : "pair-execute-process-wall")
    return new Promise((resolve, reject) => {
      const child = execFile(this.options.python, ["-I", ...args], {
        cwd: this.options.cwd, env, encoding: "utf8", timeout: this.options.timeoutMs,
        maxBuffer: this.options.maxOutputBytes, killSignal: "SIGKILL",
      }, (error, stdout, stderr) => {
        end(error ? "process-error" : "completed")
        // execFile drains both pipes concurrently and bounds each independently.
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(new MarimoPairError("PROCESS_FAILED", "Pair process failed, exceeded its output limit, or timed out", stdin === undefined ? "not-started" : "unknown"))
        } else resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 })
      })
      child.stdin?.on("error", () => { /* Completion callback owns process failure. */ })
      child.stdin?.end(stdin)
    })
  }

  private version(): Promise<void> {
    return this.verified ??= this.process(["-c", "from importlib.metadata import version; print(version('marimo'))"]).then(result => {
      if (result.exitCode !== 0 || result.stdout.trim() !== "0.25.1") throw new MarimoPairError("VERSION_MISMATCH", "Pair requires provisioned marimo 0.25.1")
    }).catch(error => { this.verified = undefined; throw error })
  }

  listSessions(url: string): Promise<MarimoListing> {
    const target = loopback(url)
    return this.serial(async () => {
      await this.version()
      const result = await this.process(["-m", "marimo", "pair", "notebook", "list", "--url", target, "--token-file", this.options.tokenFile])
      try {
        if (result.exitCode !== 0) throw new Error("Listing failed")
        const root = object(JSON.parse(result.stdout))
        const notebooks = array(root.notebooks).map(value => {
          const n = object(value), server = object(n.server)
          if (loopback(text(server.url)) !== target) throw new Error("Unexpected server")
          return { server: { url: target }, name: nullableText(n.name), path: nullableText(n.path), sessions: array(n.sessions).map(value => ({ id: text(object(value).id) })) }
        })
        return { notebooks, warnings: strings(root.warnings), ...(root.next === undefined ? {} : { next: text(root.next) }) }
      } catch { throw new MarimoPairError("INVALID_RESPONSE", "Invalid pair session listing") }
    })
  }

  private async execute(target: MarimoBinding, code: string): Promise<Envelope> {
    await this.version()
    const result = await this.process(["-m", "marimo", "pair", "execute", "--url", target.url, "--token-file", this.options.tokenFile, "--session", target.sessionId, "--code-file", "-"], code)
    try { return envelope(result.stdout, target, result.exitCode) }
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
      await this.version()
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
