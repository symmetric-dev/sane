#!/usr/bin/env bun
/**
 * Read-only SANE session review. Resolves a workstream (or one session) through the
 * SANE core store, SANE App data, and native harness records (Claude transcripts,
 * OpenCode database), then reports context delivery, run outcomes, and anomalies.
 *
 * Never writes: SQLite stores open read-only; files are only read.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage:
  bun review.ts --repo <primaryCheckout> (--workstream <id> | --session <id>) [options]

Selectors:
  --workstream <id>     Workstream id in <repo>/.sane/sane.db
  --session <id>        App sessionId, native session id, or SANE conversation id

Options:
  --app-config <path>   SANE App config (default: <sane>/packages/sane-app/.config.json)
  --opencode-db <path>  OpenCode database (default: ~/.local/share/opencode/opencode.db)
  --json                Machine-readable output
  --full                Show full prompts and Session blocks (default: truncated)
  --prompt-chars <n>    Truncation length for prompts (default: 300)
  --issues-only         Text output: summary and issues only
  --help                Show this help`

type Args = { repo: string; workstream?: string; session?: string; appConfig: string; opencodeDb: string; json: boolean; full: boolean; promptChars: number; issuesOnly: boolean }

function fail(message: string): never {
  console.error(`review-sane-sessions: ${message}`)
  process.exit(2)
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>(), flags = new Set<string>()
  const valued = new Set(["--repo", "--workstream", "--session", "--app-config", "--opencode-db", "--prompt-chars"])
  const boolean = new Set(["--json", "--full", "--issues-only", "--help"])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (valued.has(arg)) { const v = argv[++i]; if (v === undefined || v.startsWith("--")) fail(`${arg} requires a value`); values.set(arg, v) }
    else if (boolean.has(arg)) flags.add(arg)
    else fail(`unknown argument: ${arg}\n${USAGE}`)
  }
  if (flags.has("--help")) { console.log(USAGE); process.exit(0) }
  const repo = values.get("--repo")
  if (!repo) fail(`--repo is required\n${USAGE}`)
  const workstream = values.get("--workstream"), session = values.get("--session")
  if (!workstream === !session) fail(`exactly one of --workstream or --session is required\n${USAGE}`)
  const promptChars = values.has("--prompt-chars") ? Number(values.get("--prompt-chars")) : 300
  if (!Number.isSafeInteger(promptChars) || promptChars < 1) fail("--prompt-chars must be a positive integer")
  const saneRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../../..")
  return {
    repo: resolve(repo), workstream, session,
    appConfig: resolve(values.get("--app-config") ?? join(saneRoot, "packages/sane-app/.config.json")),
    opencodeDb: resolve(values.get("--opencode-db") ?? join(homedir(), ".local/share/opencode/opencode.db")),
    json: flags.has("--json"), full: flags.has("--full"), promptChars, issuesOnly: flags.has("--issues-only"),
  }
}

// ---------------------------------------------------------------------------
// Helpers

// Untyped records from external stores are inspected defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const SECRET_KEY = String.raw`(?:[A-Za-z0-9]*[_-])?(?:secret|password|passwd|token|api[_-]?key|authorization|cookie)`
const REDACTIONS: [RegExp, string][] = [
  [new RegExp(String.raw`(\\?["']?\b${SECRET_KEY}\\?["']?\s*[:=]\s*\\?["']?)([^"'\\\s,}]{4,})`, "gi"), "$1[REDACTED]"],
  [/(\bx-cc-web-secret\\?["']?\s*[:=]\s*\\?["']?)[^"'\\\s,}]+/gi, "$1[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[REDACTED]@"],
]
function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

function readJson(path: string, what: string): J {
  if (!existsSync(path)) fail(`${what} not found: ${path}`)
  try { return JSON.parse(readFileSync(path, "utf8")) } catch (error) { fail(`${what} is not valid JSON (${path}): ${(error as Error).message}`) }
}
function readJsonOptional(path: string): J | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return undefined }
}
function sha256(text: string | Buffer): string { return createHash("sha256").update(text).digest("hex") }
function fileSha(path: string): string | null { return existsSync(path) ? sha256(readFileSync(path)) : null }
function truncate(text: string, n: number): { text: string; truncated: boolean; chars: number } {
  return text.length <= n ? { text, truncated: false, chars: text.length } : { text: text.slice(0, n), truncated: true, chars: text.length }
}
function dedupe(list: string[]): string[] {
  const counts = new Map<string, number>()
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts].map(([item, n]) => n > 1 ? `${item} (×${n})` : item)
}
function short(id: string | null | undefined): string { return id ? id.slice(0, 8) : "-" }
function firstLine(text: string): string { return text.split("\n").find(l => l.trim()) ?? "" }
function oneLine(text: string, n: number): string { const t = text.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t }
function parseJsonField(value: unknown): J { if (typeof value !== "string") return value; try { return JSON.parse(value) } catch { return value } }
function iso(ms: number | null | undefined): string | null { return typeof ms === "number" ? new Date(ms).toISOString() : null }
function readJsonl(path: string): { rows: J[]; bad: number } {
  const rows: J[] = []; let bad = 0
  for (const line of readFileSync(path, "utf8").split("\n")) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)) } catch { bad++ } }
  return { rows, bad }
}
const HARNESS: Record<string, "cc" | "oc"> = { "claude-code": "cc", opencode: "oc", cc: "cc", oc: "oc" }

// ---------------------------------------------------------------------------
// Report model

type Severity = "error" | "warning" | "info"
type Issue = { severity: Severity; code: string; message: string; session?: string; run?: string; evidence?: string }

type RunReport = {
  runId: string; status: string; createdAt: string; endedAt: string | null; operation: string; model: string | null; effort: string | null
  saneContextVersion: number | null; journal: { path: string; present: boolean; events: number; badLines: number; kinds: Record<string, number> }
  final: J | null; statusReasons: string[]; launch: J | null; contextEvents: J[]
  submission: { kind: string; ref: string | null; chars: number; text: string; truncated: boolean } | null
  init: { claudeVersion?: string; model?: string; agent?: string; tools?: number; skills?: number; mcpServers?: J[] } | null
  framework: { file: string | null; fileSha: string | null; hookOutcome: string | null; contextEvent: J | null } | null
  sessionBlock: { source: string; text: string; workstreamId: string | null; expected: string | null; membershipChangedDuringRun: boolean } | null
  skills: string[]; toolErrors: { tool: string; message: string }[]; apiErrors: string[]; hookErrors: string[]; permissionDenials: string[]
  compactions: number; result: J | null; stderr: string[]; messageErrors: string[]; hookEvents: Record<string, number>; transcriptPath: string | null
}
type SessionReport = {
  key: string; appSessionId: string | null; conversationId: string | null; harness: "cc" | "oc" | null; nativeId: string | null; authorityId: string | null
  relations: string[]; title: string | null; agent: string | null; agentKind: string | null; kind: string; profileId: string | null; model: string | null; effort: string | null
  cwd: string | null; createdAt: string | null; lastStatus: string | null; hidden: boolean
  parent: { conversationId: string | null; appSessionId: string | null; nativeId: string | null; via: string } | null
  memberships: { workstreamId: string; startedAt: string; endedAt: string | null; assignments: { phase: string; startedAt: string; endedAt: string | null }[] }[]
  saneContext: { version: number; frameworkChars: number; frameworkSha: string; hasAssignment: boolean } | null
  admission: { operation: string; state: string; repositoryId: string | null; primaryCheckout: string | null; error: J } | null
  worker: J | null; branches: J[]; native: J; runs: RunReport[]
}
type Report = {
  generatedAt: string; scope: J; store: J; app: J; workstream: J | null; handoffs: J[]; jobs: J[]
  sessions: SessionReport[]; issues: Issue[]; coverage: string[]
}

// ---------------------------------------------------------------------------
// Loading

const args = parseArgs(process.argv.slice(2))
const issues: Issue[] = []
const coverage: string[] = []
const issue = (severity: Severity, code: string, message: string, extra: Omit<Issue, "severity" | "code" | "message"> = {}) => issues.push({ severity, code, message, ...extra })

// Core store
const coreDbPath = join(args.repo, ".sane", "sane.db")
if (!existsSync(args.repo)) fail(`repository not found: ${args.repo}`)
if (!existsSync(coreDbPath)) fail(`SANE core store not found: ${coreDbPath} (pass the primary checkout as --repo)`)
const core = new Database(coreDbPath, { readonly: true })
const q = <T = J>(db: Database, sql: string, ...params: (string | number | null)[]): T[] => db.query(sql).all(...params) as T[]
const store = q(core, "SELECT version, repository_id AS repositoryId, primary_checkout AS primaryCheckout, created_at AS createdAt FROM store_metadata")[0]
if (!store) fail(`store_metadata is empty in ${coreDbPath}`)
const conversations = q(core, "SELECT * FROM conversations ORDER BY created_at")
const memberships = q(core, "SELECT * FROM memberships ORDER BY started_at")
const assignments = q(core, "SELECT * FROM phase_assignments ORDER BY started_at")
const convById = new Map<string, J>(conversations.map(c => [c.id, c]))
const nativeKey = (authorityId: string | null | undefined, nativeId: string | null | undefined) => `${authorityId}|${nativeId}`
const convByNative = new Map<string, J>(conversations.map(c => [nativeKey(c.authority_id, c.native_id), c]))
const convByNativeId = new Map<string, J>(conversations.map(c => [c.native_id, c]))

// App store
const appConfig = readJson(args.appConfig, "SANE App config")
if (typeof appConfig.dataDir !== "string") fail(`App config has no dataDir: ${args.appConfig}`)
const dataDir = resolve(dirname(args.appConfig), appConfig.dataDir)
if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) fail(`App dataDir not found: ${dataDir}`)
const claudeRoot: string | undefined = appConfig.native?.claude?.profileRoot
const metadata = readJson(join(dataDir, "metadata.json"), "App metadata.json")
const admissionsDoc = readJson(join(dataDir, "admissions.json"), "App admissions.json")
const workersDoc = readJson(join(dataDir, "workers.json"), "App workers.json")
const branchesDoc = readJsonOptional(join(dataDir, "branches.json"))
if (!branchesDoc) coverage.push(`branches.json absent in ${dataDir}; fork/branch links not inspected`)
const appSessions: J[] = metadata.sessions ?? []
const appRuns: J[] = metadata.runs ?? []
const admissions: J[] = admissionsDoc.admissions ?? []
const workers: J[] = workersDoc.workers ?? []
const branchOps: J[] = branchesDoc?.operations ?? []
const appById = new Map<string, J>(appSessions.map(s => [s.sessionId, s]))
const appByNative = new Map<string, J>(appSessions.map(s => [nativeKey(s.authorityId, s.nativeSessionId), s]))
const runsBySession = new Map<string, J[]>()
for (const r of appRuns) { const list = runsBySession.get(r.sessionId) ?? []; list.push(r); runsBySession.set(r.sessionId, list) }
for (const list of runsBySession.values()) list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
const admissionBySession = new Map<string, J>(admissions.map(a => [a.sessionId, a]))
const workerBySession = new Map<string, J>(workers.map(w => [w.sessionId, w]))

// OpenCode store (opened lazily, only when an OpenCode session is in scope)
let ocDb: Database | null = null
function opencode(): Database {
  if (ocDb) return ocDb
  if (!existsSync(args.opencodeDb)) fail(`OpenCode database not found: ${args.opencodeDb} (an OpenCode session is in scope; pass --opencode-db)`)
  ocDb = new Database(args.opencodeDb, { readonly: true })
  return ocDb
}

// ---------------------------------------------------------------------------
// Scope resolution

type Ref = { conv?: J; app?: J; relations: Set<string> }
const refs = new Map<string, Ref>()
function refKey(conv?: J, app?: J): string {
  if (app) return `app:${app.sessionId}`
  return `conv:${conv.id}`
}
function addRef(relation: string, conv?: J, app?: J): Ref | undefined {
  if (!conv && app) conv = convByNative.get(nativeKey(app.authorityId, app.nativeSessionId))
  if (conv && !app) app = appByNative.get(nativeKey(conv.authority_id, conv.native_id))
  if (!conv && !app) return undefined
  const key = refKey(conv, app)
  const existing = refs.get(key)
  if (existing) { existing.relations.add(relation); return existing }
  const ref: Ref = { conv, app, relations: new Set([relation]) }
  refs.set(key, ref)
  return ref
}
function addDescendants(rootIds: string[]) {
  const stack = [...rootIds]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of conversations) if (c.parent_id === id && !refs.has(refKey(c, appByNative.get(nativeKey(c.authority_id, c.native_id))))) { addRef("child", c); stack.push(c.id) }
  }
}
const reportedMissingWorkers = new Set<string>()
function addWorkersAndBranches() {
  for (let changed = true; changed;) {
    changed = false
    const inScope = new Set([...refs.values()].map(r => r.app?.sessionId).filter(Boolean))
    for (const w of workers) {
      if (!inScope.has(w.parent?.sessionId) || inScope.has(w.sessionId)) continue
      const app = appById.get(w.sessionId)
      const conv = w.child ? convByNative.get(nativeKey(w.child.authorityId, w.child.nativeId)) : undefined
      if (app || conv) { addRef("worker", conv, app); changed = true }
      else if (!reportedMissingWorkers.has(w.id)) reportedMissingWorkers.add(w.id), issue("warning", "worker-session-missing", `Worker ${w.id} (${w.input?.worker}) has no App session or SANE conversation`, { session: w.sessionId })
    }
    for (const op of branchOps) {
      const ends = [op.sourceId, op.destinationId]
      if (!ends.some(id => inScope.has(id))) continue
      for (const id of ends) if (!inScope.has(id) && appById.get(id)) { addRef("branch", undefined, appById.get(id)); changed = true }
    }
  }
}

let workstream: J | null = null
let wsHandoffs: J[] = []
let wsJobs: J[] = []
if (args.workstream) {
  workstream = q(core, "SELECT * FROM workstreams WHERE id=?", args.workstream)[0] ?? null
  if (!workstream) fail(`workstream ${args.workstream} not found in ${coreDbPath}; available: ${q(core, "SELECT id FROM workstreams").map(r => r.id).join(", ") || "(none)"}`)
  const memberConvs = memberships.filter(m => m.workstream_id === args.workstream).map(m => m.conversation_id)
  for (const id of memberConvs) addRef("member", convById.get(id))
  wsHandoffs = q(core, "SELECT * FROM handoffs WHERE workstream_id=? ORDER BY created_at", args.workstream)
  for (const h of wsHandoffs) {
    addRef("handoff-sender", convById.get(h.sender_id))
    const rec = parseJsonField(h.recipient)
    const conv = rec?.ref ? convByNative.get(nativeKey(rec.ref.authorityId, rec.ref.nativeId)) : undefined
    const app = rec?.sessionId ? appById.get(rec.sessionId) : undefined
    if (conv || app) addRef("handoff-recipient", conv, app)
  }
  for (const a of q(core, "SELECT DISTINCT actor_conversation_id AS id FROM audit_events WHERE workstream_id=? AND actor_conversation_id IS NOT NULL", args.workstream)) addRef("audit-actor", convById.get(a.id))
  addDescendants(memberConvs)
  addWorkersAndBranches()
  wsJobs = q(core, "SELECT job_id AS jobId, spec_path AS specPath, report_path AS reportPath, status, updated_at AS updatedAt FROM jobs WHERE workstream_id=? ORDER BY job_id", args.workstream)
} else {
  const id = args.session!
  const app = appById.get(id) ?? appSessions.find(s => s.nativeSessionId === id)
  const conv = convById.get(id) ?? convByNativeId.get(id)
  if (!app && !conv) fail(`session ${id} matches no App session (${join(dataDir, "metadata.json")}) and no SANE conversation (${coreDbPath})`)
  const root = addRef("selected", conv, app)!
  if (root.conv) addDescendants([root.conv.id])
  addWorkersAndBranches()
  const convIds = [...refs.values()].map(r => r.conv?.id).filter(Boolean) as string[]
  if (convIds.length) wsHandoffs = q(core, `SELECT * FROM handoffs WHERE sender_id IN (${convIds.map(() => "?").join(",")}) ORDER BY created_at`, ...convIds)
  const nativeIds = new Set([...refs.values()].map(r => r.conv?.native_id ?? r.app?.nativeSessionId))
  for (const h of q(core, "SELECT * FROM handoffs ORDER BY created_at")) {
    const rec = parseJsonField(h.recipient)
    if (nativeIds.has(rec?.ref?.nativeId) && !wsHandoffs.some(x => x.id === h.id)) wsHandoffs.push(h)
  }
}

// Orphaned App bindings for this repository
const repoAdmissions = admissions.filter(a => a.binding?.domain?.mode === "repository" && a.binding.domain.primaryCheckout === store.primaryCheckout)
const orphaned = repoAdmissions.filter(a => a.binding.domain.repositoryId !== store.repositoryId)
if (orphaned.length) {
  const ids = [...new Set(orphaned.map(a => a.binding.domain.repositoryId))]
  issue("warning", "orphaned-binding", `${orphaned.length} App admission(s) for ${store.primaryCheckout} point to repositoryId ${ids.join(", ")}, absent from sane.db (current ${store.repositoryId}); those sessions cannot resolve SANE context through this store`, { evidence: `admissions.json sessions: ${orphaned.map(a => short(a.sessionId)).join(", ")}` })
}

// ---------------------------------------------------------------------------
// Membership helpers

function membershipHistory(convId: string | undefined) {
  if (!convId) return []
  return memberships.filter(m => m.conversation_id === convId).map(m => ({
    workstreamId: m.workstream_id, startedAt: m.started_at, endedAt: m.ended_at ?? null,
    assignments: assignments.filter(a => a.membership_id === m.id).map(a => ({ phase: a.phase, startedAt: a.started_at, endedAt: a.ended_at ?? null })),
  }))
}
function workstreamAt(convId: string | undefined, at: string): { id: string | null } {
  if (!convId) return { id: null }
  const active = memberships.find(m => m.conversation_id === convId && m.started_at <= at && (m.ended_at === null || m.ended_at > at))
  return { id: active?.workstream_id ?? null }
}
function membershipChangedWithin(convId: string | undefined, from: string, to: string | null): boolean {
  if (!convId) return false
  const end = to ?? "9999"
  return memberships.some(m => m.conversation_id === convId && ((m.started_at > from && m.started_at <= end) || (m.ended_at && m.ended_at > from && m.ended_at <= end)))
}

// ---------------------------------------------------------------------------
// Run analysis (App journal)

function submissionKind(text: string, isWorker: boolean, firstRun: boolean): { kind: string; ref: string | null } {
  const handoff = /^SANE handoff (\S+)/.exec(text)
  if (handoff) return { kind: "handoff", ref: handoff[1]! }
  if (/^(Worker Outcome|SANE worker outcome)/i.test(text)) return { kind: "worker-outcome", ref: null }
  if (isWorker && firstRun) return { kind: "worker-assignment", ref: null }
  return { kind: "prompt", ref: null }
}

function analyzeRun(run: J, session: J | undefined, ref: Ref, harness: "cc" | "oc" | null, index: number, label: string): RunReport {
  const path = join(dataDir, `${run.runId}.jsonl`)
  const present = existsSync(path)
  const { rows, bad } = present ? readJsonl(path) : { rows: [] as J[], bad: 0 }
  const kinds: Record<string, number> = {}
  for (const e of rows) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  if (!present) issue("error", "journal-missing", `Run journal missing`, { session: label, run: run.runId, evidence: path })
  if (bad) issue("warning", "journal-unparseable", `${bad} unparseable journal line(s)`, { session: label, run: run.runId, evidence: path })

  const statuses = rows.filter(e => e.kind === "status").map(e => e.data)
  const terminal = [...statuses].reverse().find(s => s.status !== "running") ?? null
  const final = terminal ? { ...terminal, ...statuses.filter(s => s !== terminal && s.status === terminal.status).reduce((acc, s) => ({ ...s, ...acc }), {}) } : statuses.at(-1) ?? null
  const statusReasons = [...new Set(statuses.map(s => s.reason).filter(Boolean))] as string[]
  const launch = rows.find(e => e.kind === "launch")?.data ?? null
  const contextEvents = rows.filter(e => e.kind === "context").map(e => e.data)
  const sub = rows.find(e => e.kind === "submission")?.data
  const isWorker = session?.agentKind === "worker" || ref.relations.has("worker")
  const submission = sub && typeof sub.text === "string" ? (() => {
    const t = truncate(sub.text, args.full ? Infinity : args.promptChars)
    return { ...submissionKind(sub.text, isWorker, index === 0), chars: t.chars, text: t.text, truncated: t.truncated }
  })() : null

  const skills: string[] = [], toolErrors: { tool: string; message: string }[] = [], apiErrors: string[] = [], hookErrors: string[] = [], permissionDenials: string[] = [], stderr: string[] = [], messageErrors: string[] = []
  const hookEvents: Record<string, number> = {}
  let compactions = 0, result: J = null, init: RunReport["init"] = null, sessionStartOutcome: string | null = null, transcriptPath: string | null = null
  const toolNames = new Map<string, string>()
  const ocMessages = new Map<string, J>()
  for (const e of rows) {
    const d = e.data
    if (e.kind === "stderr" && typeof d === "string" && d.trim()) stderr.push(oneLine(d, 300))
    if (e.kind === "hook" && d?.event) hookEvents[d.event] = (hookEvents[d.event] ?? 0) + 1
    if (e.kind === "hook" && !transcriptPath && d?.payload?.transcript_path && d.payload.session_id === (session?.nativeSessionId ?? ref.conv?.native_id)) transcriptPath = d.payload.transcript_path
    if (e.kind === "message" && d?.messageId) ocMessages.set(d.messageId, d)
    if (e.kind !== "stdout" || typeof d !== "object" || d === null) continue
    if (d.type === "system" && d.subtype === "init") init = { claudeVersion: d.claude_code_version, model: d.model, agent: d.agent, tools: d.tools?.length, skills: d.skills?.length, mcpServers: d.mcp_servers }
    if (d.type === "system" && d.subtype === "hook_response") {
      if (String(d.hook_event) === "SessionStart" && /additionalContext/.test(String(d.output ?? d.stdout ?? ""))) sessionStartOutcome = d.outcome
      if (d.outcome !== "success") hookErrors.push(`${d.hook_name}: ${d.outcome} exit=${d.exit_code} ${oneLine(String(d.stderr ?? ""), 200)}`)
    }
    if (d.type === "system" && d.subtype === "permission_denied") permissionDenials.push(`${d.tool_name}${d.agent_id ? ` (subagent ${d.agent_id})` : ""}: ${oneLine(String(d.decision_reason ?? d.message ?? ""), 160)}`)
    if (d.type === "system" && d.subtype === "compact_boundary") compactions++
    if (d.type === "assistant") {
      if (d.error) apiErrors.push(`assistant error: ${d.error}`)
      for (const c of d.message?.content ?? []) if (c?.type === "tool_use") {
        toolNames.set(c.id, c.name)
        if (c.name === "Skill") skills.push(String(c.input?.skill ?? c.input?.name ?? c.input?.command ?? "?"))
      }
    }
    if (d.type === "user") for (const c of d.message?.content ?? []) if (c?.type === "tool_result" && c.is_error) {
      const content = typeof c.content === "string" ? c.content : JSON.stringify(c.content)
      toolErrors.push({ tool: toolNames.get(c.tool_use_id) ?? "?", message: oneLine(content, 200) })
    }
    if (d.type === "result") {
      result = { subtype: d.subtype, isError: d.is_error, apiErrorStatus: d.api_error_status ?? null, terminalReason: d.terminal_reason ?? null, numTurns: d.num_turns, costUsd: d.total_cost_usd, result: oneLine(String(d.result ?? ""), 240) }
      if (d.is_error || d.subtype !== "success") apiErrors.push(`result ${d.subtype}${d.api_error_status ? ` status=${d.api_error_status}` : ""}: ${oneLine(String(d.result ?? ""), 200)}`)
      for (const p of d.permission_denials ?? []) permissionDenials.push(`${p.tool_name ?? "?"} (result.permission_denials)`)
    }
  }
  for (const m of ocMessages.values()) {
    if (m.error) messageErrors.push(`${m.error.type ?? "error"}: ${oneLine(String(m.error.message ?? JSON.stringify(m.error)), 200)}`)
    if (m.compaction) compactions++
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      if (p.name === "skill") skills.push(String(p.input?.id ?? p.input?.name ?? "?"))
      if (p.status === "error") toolErrors.push({ tool: p.name, message: oneLine(String(p.error?.message ?? JSON.stringify(p.error ?? "")), 200) })
    }
  }
  if (final) {
    if (final.apiErrorStatus && !apiErrors.some(a => a.includes(`status=${final.apiErrorStatus}`))) apiErrors.push(`status apiErrorStatus=${final.apiErrorStatus}: ${oneLine(String(final.result ?? final.error ?? ""), 200)}`)
    for (const p of final.permissionDenials ?? []) permissionDenials.push(typeof p === "string" ? p : `${p.tool_name ?? p.tool ?? "?"} (status.permissionDenials)`)
  }
  const hookErrorFile = join(dataDir, `${run.runId}.hook-errors.jsonl`)
  if (existsSync(hookErrorFile)) for (const h of readJsonl(hookErrorFile).rows) hookErrors.push(`${h.event}: ${oneLine(String(h.error), 200)} (${h.time})`)

  // Framework delivery evidence for this run
  const frameworkFile = join(dataDir, `${run.runId}.session-start.md`)
  const frameworkEvent = contextEvents.find(c => c.type === "framework-delivered") ?? null
  const hasFrameworkFile = existsSync(frameworkFile)
  const framework = hasFrameworkFile || frameworkEvent || sessionStartOutcome || launch?.framework
    ? { file: hasFrameworkFile ? frameworkFile : launch?.framework?.path ?? null, fileSha: hasFrameworkFile ? fileSha(frameworkFile) : null, hookOutcome: sessionStartOutcome, contextEvent: frameworkEvent }
    : null

  // Session block for this run
  const blockFile = join(dataDir, `${run.runId}.sane-session.md`)
  const blockEvent = [...contextEvents].reverse().find(c => c.type === "session-block") ?? null
  let block: { source: string; text: string } | null = null
  if (blockEvent && typeof blockEvent.text === "string") block = { source: `context event (changed=${blockEvent.changed})`, text: blockEvent.text }
  else if (existsSync(blockFile)) block = { source: "run file", text: readFileSync(blockFile, "utf8") }
  else if (launch?.sessionBlock?.path && existsSync(launch.sessionBlock.path)) block = { source: "launch.sessionBlock", text: readFileSync(launch.sessionBlock.path, "utf8") }
  const expected = workstreamAt(ref.conv?.id, run.createdAt).id
  const sessionBlock = block ? {
    source: block.source, text: args.full ? block.text : truncate(block.text, 400).text,
    workstreamId: /^Workstream: (.+)$/m.exec(block.text)?.[1]?.trim() ?? null, expected,
    membershipChangedDuringRun: membershipChangedWithin(ref.conv?.id, run.createdAt, run.endedAt ?? null),
  } : null

  // Launch artifact integrity
  if (launch) for (const field of ["agentFile", "settings", "framework", "sessionBlock"] as const) {
    const art = launch[field]
    if (!art?.path || !art.sha256) continue
    const now = fileSha(art.path)
    if (now === null) issue(field === "agentFile" ? "info" : "warning", "launch-artifact-missing", `launch.${field} no longer exists`, { session: label, run: run.runId, evidence: art.path })
    else if (now !== art.sha256) issue("info", "launch-artifact-changed", `launch.${field} content changed since launch (current file differs from recorded sha256)`, { session: label, run: run.runId, evidence: art.path })
  }

  return {
    runId: run.runId, status: run.status, createdAt: run.createdAt, endedAt: run.endedAt ?? null, operation: run.operation ?? "prompt",
    model: run.model ?? null, effort: run.effort ?? null, saneContextVersion: run.saneContextVersion ?? null,
    journal: { path, present, events: rows.length, badLines: bad, kinds }, final, statusReasons, launch, contextEvents, submission, init,
    framework, sessionBlock, skills: [...new Set(skills)], toolErrors, apiErrors: dedupe(apiErrors), hookErrors: dedupe(hookErrors), permissionDenials: dedupe(permissionDenials), compactions, result,
    stderr: dedupe(stderr).slice(0, 5), messageErrors: dedupe(messageErrors), hookEvents, transcriptPath,
  }
}

// ---------------------------------------------------------------------------
// Native evidence

function claudeTranscriptPath(app: J | undefined, conv: J | undefined, runs: RunReport[]): string | null {
  if (!claudeRoot) fail(`App config has no native.claude.profileRoot (a Claude session is in scope): ${args.appConfig}`)
  const nativeId = conv?.native_id ?? app?.nativeSessionId
  if (!nativeId) return null
  const fromHook = runs.find(r => r.transcriptPath)?.transcriptPath
  if (fromHook) return fromHook
  const cwd = app?.cwd ?? null
  return cwd ? join(claudeRoot, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`) : null
}

function claudeNative(path: string | null, frameworkText: string | null): J {
  if (!path || !existsSync(path)) return { harness: "cc", transcript: path, present: false }
  const { rows, bad } = readJsonl(path)
  const out: J = {
    harness: "cc", transcript: path, present: true, entries: rows.length, badLines: bad, agentSettings: [] as string[], claudeVersions: [] as string[],
    promptSnapshots: [] as J[], instructions: [] as string[], skillListings: 0, frameworkContext: [] as J[], otherHookContext: 0,
    apiErrors: [] as J[], toolErrors: 0, compactions: [] as string[], stopHookErrors: [] as string[], sessionBlockInSystemPrompt: null as boolean | null, subagents: [] as J[],
  }
  const frameworkHead = frameworkText ? frameworkText.slice(0, 200) : "# SANE Context"
  for (const e of rows) {
    if (e.type === "agent-setting" && e.agentSetting && !out.agentSettings.includes(e.agentSetting)) out.agentSettings.push(e.agentSetting)
    if (e.version && !out.claudeVersions.includes(e.version)) out.claudeVersions.push(e.version)
    const a = e.type === "attachment" ? e.attachment : null
    if (a?.type === "prompt_snapshot") {
      const sp = Array.isArray(a.systemPrompt) ? a.systemPrompt.join("\n") : String(a.systemPrompt ?? "")
      out.promptSnapshots.push({ timestamp: e.timestamp, chars: sp.length, firstLine: oneLine(firstLine(sp), 120), tools: a.tools?.length ?? null, sessionBlock: /# SANE Session/.test(sp) ? (/^Workstream: (.+)$/m.exec(sp)?.[1] ?? "present") : null })
      out.sessionBlockInSystemPrompt = /# SANE Session/.test(sp)
    }
    if (a?.type === "instructions") for (const f of a.files ?? []) if (f.path && !out.instructions.includes(f.path)) out.instructions.push(f.path)
    if (a?.type === "skill_listing") out.skillListings++
    if (a?.type === "hook_additional_context") {
      const content = (Array.isArray(a.content) ? a.content : [a.content]).map(String).join("\n")
      if (content.includes(frameworkHead) || content.includes("# SANE Context")) out.frameworkContext.push({ timestamp: e.timestamp, chars: content.length, sha256: sha256(content), hookName: a.hookName ?? null, matchesRecorded: frameworkText ? content.includes(frameworkText) : null })
      else out.otherHookContext++
    }
    if (e.isApiErrorMessage) out.apiErrors.push({ timestamp: e.timestamp, error: e.error ?? null, status: e.apiErrorStatus ?? null, text: oneLine(JSON.stringify(e.message?.content ?? ""), 160) })
    if (e.type === "user") for (const c of e.message?.content ?? []) if (c?.type === "tool_result" && c.is_error) out.toolErrors++
    if (e.type === "system" && e.subtype === "compact_boundary") out.compactions.push(e.timestamp)
    if (e.type === "system" && e.subtype === "stop_hook_summary") for (const h of e.hookErrors ?? []) out.stopHookErrors.push(`${e.timestamp}: ${oneLine(typeof h === "string" ? h : JSON.stringify(h), 200)}`)
  }
  const subDir = join(dirname(path), path.split("/").pop()!.replace(/\.jsonl$/, ""), "subagents")
  if (existsSync(subDir)) for (const f of readdirSync(subDir).filter(f => f.endsWith(".meta.json")).sort()) {
    const meta = readJsonOptional(join(subDir, f)) ?? {}
    const transcript = join(subDir, f.replace(/\.meta\.json$/, ".jsonl"))
    let apiErrors = 0, toolErrors = 0
    if (existsSync(transcript)) for (const e of readJsonl(transcript).rows) {
      if (e.isApiErrorMessage) apiErrors++
      if (e.type === "user") for (const c of e.message?.content ?? []) if (c?.type === "tool_result" && c.is_error) toolErrors++
    }
    out.subagents.push({ id: f.replace(/\.meta\.json$/, ""), agentType: meta.agentType ?? null, description: meta.description ?? null, toolUseId: meta.toolUseId ?? null, apiErrors, toolErrors })
  }
  return out
}

function opencodeNative(nativeId: string | null, appSessionId: string | null): J {
  if (!nativeId) return { harness: "oc", present: false }
  const db = opencode()
  const row = q(db, "SELECT id, parent_id, fork_session_id, directory, title, agent, model, metadata, idle_outcome, time_created, time_updated, time_compacting, time_archived FROM session_v2 WHERE id=?", nativeId)[0]
  if (!row) return { harness: "oc", sessionId: nativeId, present: false }
  const md = parseJsonField(row.metadata) ?? {}
  const counts = Object.fromEntries(q(db, "SELECT type, count(*) AS n FROM session_message WHERE session_id=? GROUP BY type", nativeId).map(r => [r.type, r.n]))
  const framework = q(db, "SELECT id, seq, time_created, length(json_extract(data,'$.text')) AS chars, json_extract(data,'$.text') AS text FROM session_message WHERE session_id=? AND type='synthetic' AND json_extract(data,'$.metadata.sane')='framework' ORDER BY seq", nativeId)
  const expectedId = appSessionId ? `msg_${appSessionId.replaceAll("-", "")}` : null
  const compactions = q(db, "SELECT id, time_created, json_extract(data,'$.status') AS status, json_extract(data,'$.reason') AS reason FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq", nativeId)
  const errors = q(db, "SELECT id, time_created, json_extract(data,'$.error') AS error FROM session_message WHERE session_id=? AND type='assistant' AND json_extract(data,'$.error') IS NOT NULL ORDER BY seq", nativeId)
    .map(r => ({ id: r.id, time: iso(r.time_created), error: parseJsonField(r.error) }))
  const toolErrors = q(db, "SELECT count(*) AS n FROM session_message AS m, json_each(m.data, '$.content') AS c WHERE m.session_id=? AND m.type='assistant' AND json_extract(c.value,'$.type')='tool' AND json_extract(c.value,'$.state.status')='error'", nativeId)[0]?.n ?? 0
  const skills = q(db, "SELECT DISTINCT json_extract(c.value,'$.state.input.id') AS skill FROM session_message AS m, json_each(m.data, '$.content') AS c WHERE m.session_id=? AND m.type='assistant' AND json_extract(c.value,'$.type')='tool' AND json_extract(c.value,'$.name')='skill'", nativeId).map(r => r.skill).filter(Boolean)
  const state = q(db, "SELECT epoch_start, through_seq, initial_values, current_values FROM instruction_state WHERE session_id=?", nativeId)[0]
  let instructions: J = null
  if (state) {
    const current = parseJsonField(state.current_values) ?? {}, initial = parseJsonField(state.initial_values) ?? {}
    const blobLen = (hash: string) => q(db, "SELECT length(value) AS n FROM instruction_blob WHERE hash=?", hash)[0]?.n ?? null
    instructions = { epochStart: state.epoch_start, throughSeq: state.through_seq, keys: Object.entries(current).map(([key, hash]) => ({ key, chars: blobLen(String(hash)), changedSinceInitial: initial[key] !== hash })) }
  }
  const entries = q(db, "SELECT key, removed, length(value) AS chars FROM instruction_entry WHERE session_id=?", nativeId)
  const children = q(db, "SELECT id, agent, title, idle_outcome, time_created FROM session_v2 WHERE parent_id=? ORDER BY time_created", nativeId).map(c => ({ id: c.id, agent: c.agent, title: c.title, idleOutcome: c.idle_outcome, createdAt: iso(c.time_created) }))
  return {
    harness: "oc", sessionId: nativeId, present: true, parentId: row.parent_id, forkSessionId: row.fork_session_id, directory: row.directory, title: row.title, agent: row.agent,
    model: parseJsonField(row.model), idleOutcome: row.idle_outcome, createdAt: iso(row.time_created), updatedAt: iso(row.time_updated), archived: row.time_archived !== null,
    saneContextMetadata: md.saneContext ? { sessionID: md.saneContext.sessionID, text: args.full ? md.saneContext.text : truncate(String(md.saneContext.text ?? ""), 400).text, workstreamId: /^Workstream: (.+)$/m.exec(String(md.saneContext.text ?? ""))?.[1] ?? null } : null,
    messageCounts: counts, framework: framework.map(f => ({ id: f.id, seq: f.seq, time: iso(f.time_created), chars: f.chars, sha256: f.text ? sha256(String(f.text)) : null, expectedId: f.id === expectedId })),
    expectedFrameworkMessageId: expectedId, compactions: compactions.map(c => ({ id: c.id, time: iso(c.time_created), status: c.status, reason: c.reason })),
    assistantErrors: errors, toolErrors, skills, instructions, instructionEntries: entries, children,
  }
}

// ---------------------------------------------------------------------------
// Build sessions

function sessionKind(app: J | undefined, ref: Ref): string {
  if (app?.agentKind) return app.agentKind
  if (ref.relations.has("worker")) return "worker"
  if (app?.profileId?.startsWith("base:")) return "base"
  if (app) return app.agent ? "assistant" : "base"
  return "unknown"
}

const sessionReports: SessionReport[] = []
for (const ref of refs.values()) {
  const { conv, app } = ref
  const harness = HARNESS[app?.harness ?? conv?.harness] ?? null
  const appSessionId = app?.sessionId ?? null
  const label = appSessionId ?? conv.id
  const worker = appSessionId ? workerBySession.get(appSessionId) : undefined
  const parentConv = conv?.parent_id ? convById.get(conv.parent_id) : undefined
  const parent = parentConv
    ? { conversationId: parentConv.id, appSessionId: appByNative.get(nativeKey(parentConv.authority_id, parentConv.native_id))?.sessionId ?? null, nativeId: parentConv.native_id, via: worker ? "worker" : "conversation.parent_id" }
    : worker ? { conversationId: null, appSessionId: worker.parent?.sessionId ?? null, nativeId: worker.parent?.native?.nativeId ?? null, via: "worker" } : null
  const admission = appSessionId ? admissionBySession.get(appSessionId) : undefined
  const runs = (appSessionId ? runsBySession.get(appSessionId) ?? [] : []).map((r, i) => analyzeRun(r, app, ref, harness, i, label))
  const ctx = app?.saneContext
  const saneContext = ctx ? { version: ctx.version, frameworkChars: String(ctx.framework).length, frameworkSha: sha256(String(ctx.framework)), hasAssignment: ctx.assignment !== undefined } : null
  const frameworkText = ctx ? (ctx.assignment === undefined ? ctx.framework : `${ctx.framework}\n\n${ctx.assignment}`) : null
  let native: J = { harness, present: false }
  if (harness === "cc") native = claudeNative(claudeTranscriptPath(app, conv, runs), frameworkText)
  else if (harness === "oc") native = opencodeNative(conv?.native_id ?? app?.nativeSessionId ?? null, appSessionId)
  const createdAt = conv?.created_at ?? runs[0]?.createdAt ?? null
  sessionReports.push({
    key: appSessionId ?? conv.id, appSessionId, conversationId: conv?.id ?? null, harness, nativeId: conv?.native_id ?? app?.nativeSessionId ?? null, authorityId: conv?.authority_id ?? app?.authorityId ?? null,
    relations: [...ref.relations], title: app?.title ?? null, agent: app?.agent ?? null, agentKind: app?.agentKind ?? null, kind: sessionKind(app, ref), profileId: app?.profileId ?? null,
    model: app?.model ?? null, effort: app?.effort ?? null, cwd: app?.cwd ?? null, createdAt, lastStatus: app?.lastStatus ?? null, hidden: !!app?.hidden,
    parent, memberships: membershipHistory(conv?.id), saneContext,
    admission: admission ? { operation: admission.operation, state: admission.state, repositoryId: admission.binding?.domain?.repositoryId ?? null, primaryCheckout: admission.binding?.domain?.primaryCheckout ?? null, error: admission.error ?? null } : null,
    worker: worker ? { id: worker.id, role: worker.input?.worker, state: worker.state, jobs: worker.input?.jobs ?? [], prompt: truncate(String(worker.input?.prompt ?? ""), args.full ? Infinity : args.promptChars), parentRunId: worker.parent?.runId ?? null, toolCallId: worker.parent?.toolCallId ?? null, outcome: worker.outcome ? { status: worker.outcome.status, at: worker.outcome.at, summary: truncate(String(worker.outcome.summary ?? ""), args.full ? Infinity : 240).text } : null, notification: worker.notification?.state ?? null, results: worker.results?.length ?? 0 } : null,
    branches: branchOps.filter(o => o.sourceId === appSessionId || o.destinationId === appSessionId).map(o => ({ id: o.id, sourceId: o.sourceId, destinationId: o.destinationId, state: o.state, selector: o.selector, createdAt: o.createdAt })),
    native, runs,
  })
}
sessionReports.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
const labelOf = new Map<string, string>()
sessionReports.forEach((s, i) => labelOf.set(s.key, `S${i + 1}`))
const labelFor = (s: SessionReport) => `${labelOf.get(s.key)} ${s.agent ?? s.kind}`
for (const i of issues) { const s = i.session ? sessionReports.find(x => x.key === i.session) : undefined; if (s) i.session = labelFor(s) }
const byAppId = new Map(sessionReports.filter(s => s.appSessionId).map(s => [s.appSessionId!, s]))
const byConvId = new Map(sessionReports.filter(s => s.conversationId).map(s => [s.conversationId!, s]))

// ---------------------------------------------------------------------------
// Issue detection

for (const s of sessionReports) {
  const L = labelFor(s)
  const at = (run?: RunReport) => ({ session: L, ...(run ? { run: run.runId } : {}) })
  if (!s.appSessionId) issue("info", "no-app-session", `SANE conversation has no App session in ${dataDir} (created outside this App store or another dataDir)`, { session: L, evidence: `conversation ${s.conversationId} native ${s.nativeId}` })
  if (s.appSessionId && !s.conversationId && s.admission?.repositoryId === store.repositoryId) issue("warning", "no-sane-conversation", `App session admitted to this repository has no SANE conversation`, at())
  if (s.admission?.error) issue("warning", "admission-error", `Admission error: ${oneLine(JSON.stringify(s.admission.error), 200)}`, at())
  if (s.native.present === false && s.harness) issue("error", "native-missing", s.harness === "cc" ? `Claude transcript missing` : `OpenCode session missing from database`, { ...at(), evidence: s.native.transcript ?? s.native.sessionId ?? s.nativeId ?? undefined })
  if (s.native.badLines) issue("warning", "transcript-unparseable", `${s.native.badLines} unparseable transcript line(s)`, { ...at(), evidence: s.native.transcript })
  if (s.worker && !["completed"].includes(s.worker.state)) issue(s.worker.state === "running" ? "info" : "warning", "worker-state", `Worker ${s.worker.role} state=${s.worker.state}${s.worker.outcome ? ` outcome=${s.worker.outcome.status}` : ""}`, at())
  if (s.worker?.outcome && s.worker.outcome.status !== "completed") issue("warning", "worker-outcome", `Worker ${s.worker.role} outcome ${s.worker.outcome.status}: ${oneLine(s.worker.outcome.summary, 160)}`, at())
  if (s.worker && s.worker.notification && s.worker.notification !== "delivered") issue("warning", "worker-notification", `Worker outcome notification state=${s.worker.notification}`, at())

  // Framework delivery
  const sane = s.saneContext !== null
  if (sane) {
    const creation = s.admission?.operation === "enroll" ? null : s.runs.find(r => r.operation !== "compact")
    if (s.harness === "cc") {
      const delivered = s.runs.filter(r => r.framework)
      if (creation && !creation.framework) issue("error", "framework-missing", `SANE session creation run has no framework delivery evidence (no session-start file, SessionStart additionalContext, or context event)`, at(creation))
      if (creation?.framework && creation.framework.hookOutcome && creation.framework.hookOutcome !== "success") issue("error", "framework-hook-failed", `SessionStart framework hook outcome=${creation.framework.hookOutcome}`, at(creation))
      if (delivered.length > 1) issue("error", "framework-repeated", `Framework prepared on ${delivered.length} runs (expected once, on creation)`, { ...at(), evidence: delivered.map(r => short(r.runId)).join(", ") })
      if (s.native.present) {
        const n = s.native.frameworkContext.length
        if (n === 0) issue("error", "framework-not-in-transcript", `No SANE framework hook_additional_context in Claude transcript`, { ...at(), evidence: s.native.transcript })
        if (n > 1) issue("error", "framework-repeated", `SANE framework appears ${n} times in Claude transcript`, { ...at(), evidence: s.native.frameworkContext.map((f: J) => f.timestamp).join(", ") })
        if (n >= 1 && s.native.frameworkContext.some((f: J) => f.matchesRecorded === false)) issue("warning", "framework-mismatch", `Transcript framework text differs from App saneContext`, at())
      }
    } else if (s.harness === "oc" && s.native.present) {
      const n = s.native.framework.length
      if (n === 0) issue("error", "framework-missing", `No SANE framework synthetic message (metadata.sane=framework) in OpenCode session`, { ...at(), evidence: `expected ${s.native.expectedFrameworkMessageId}` })
      if (n > 1) issue("error", "framework-repeated", `SANE framework synthetic message appears ${n} times`, { ...at(), evidence: s.native.framework.map((f: J) => f.id).join(", ") })
      if (n === 1 && !s.native.framework[0].expectedId) issue("warning", "framework-id-mismatch", `Framework message id ${s.native.framework[0].id} differs from expected ${s.native.expectedFrameworkMessageId}`, at())
      const recorded = s.runs.flatMap(r => r.contextEvents.filter(c => c.type === "framework-delivered"))
      if (recorded.length > 1) issue("error", "framework-repeated", `framework-delivered context event recorded ${recorded.length} times`, at())
      if (n === 1 && recorded[0]?.sha256 && s.native.framework[0].sha256 && recorded[0].sha256 !== s.native.framework[0].sha256) issue("warning", "framework-mismatch", `framework-delivered sha256 differs from OpenCode synthetic message text`, at())
    }
  } else if (s.harness === "cc" && s.native.present && s.native.frameworkContext.length > 0 && s.native.frameworkContext.length > 1) {
    issue("warning", "framework-repeated", `SANE framework appears ${s.native.frameworkContext.length} times in a session without App saneContext`, at())
  }

  // Per-run checks
  const blockMissing: RunReport[] = []
  for (const r of s.runs) {
    const reason = r.statusReasons.join("; ") || r.final?.reason || ""
    if (r.status === "failed") issue("error", "run-failed", `Run failed${reason ? `: ${reason}` : ""}${r.result?.apiErrorStatus ? ` (API ${r.result.apiErrorStatus}: ${r.result.result})` : ""}`, at(r))
    else if (r.status === "interrupted") issue("warning", "run-interrupted", `Run interrupted${reason ? `: ${reason}` : ""}${r.final?.exitCode !== undefined ? ` exitCode=${r.final.exitCode}` : ""}`, at(r))
    else if (r.status === "running") issue("info", "run-running", `Run has no terminal status in metadata (still running, or the App stopped without reconciliation)`, at(r))
    if (r.journal.present && r.final && r.final.status !== r.status && r.status !== "running") issue("warning", "status-mismatch", `metadata status=${r.status} but journal final status=${r.final.status}`, at(r))
    for (const a of r.apiErrors) issue("error", "api-error", a, at(r))
    for (const h of r.hookErrors) issue("error", "hook-error", h, at(r))
    if (r.permissionDenials.length) issue("warning", "permission-denied", `${r.permissionDenials.length} permission denial(s): ${[...new Set(r.permissionDenials)].slice(0, 3).join(" | ")}`, at(r))
    for (const m of r.messageErrors) if (!/^aborted/.test(m)) issue("error", "message-error", m, at(r))
    if (r.toolErrors.length >= 5) issue("info", "tool-errors", `${r.toolErrors.length} tool errors in run`, at(r))
    if (r.stderr.length) issue("info", "stderr", `stderr: ${r.stderr[0]}`, at(r))
    if (s.harness === "cc" && sane && r.framework && r !== s.runs.find(x => x.operation !== "compact")) issue("error", "framework-repeated", `Framework prepared on a non-creation (resume) run`, at(r))
    // Session block
    const expected = workstreamAt(s.conversationId ?? undefined, r.createdAt).id
    if (r.sessionBlock) {
      if (r.sessionBlock.workstreamId !== expected && !r.sessionBlock.membershipChangedDuringRun) issue("error", "session-block-stale", `Session block names workstream ${r.sessionBlock.workstreamId ?? "(none)"} but membership at run start is ${expected ?? "(none)"}`, at(r))
    } else if (sane && expected && r.operation !== "compact" && s.harness === "cc") blockMissing.push(r)
  }
  if (blockMissing.length) issue("error", "session-block-missing", `${blockMissing.length} of ${s.runs.length} run(s) launched without a Session block while a member of a workstream`, { ...at(blockMissing[0]), evidence: `runs ${blockMissing.map(r => short(r.runId)).slice(0, 10).join(", ")}${blockMissing.length > 10 ? ", …" : ""}` })
  if (sane && s.harness === "oc" && s.native.present) {
    const expected = s.memberships.find(m => m.endedAt === null)?.workstreamId ?? null
    const current = s.native.saneContextMetadata?.workstreamId ?? null
    if (expected && !s.native.saneContextMetadata) issue("error", "session-block-missing", `OpenCode session metadata has no saneContext Session block (member of ${expected})`, at())
    else if (s.native.saneContextMetadata && current !== expected) issue("error", "session-block-stale", `OpenCode saneContext metadata names ${current ?? "(none)"}; current membership is ${expected ?? "(none)"}`, at())
  }

  // Native session-level checks
  if (s.harness === "cc" && s.native.present) {
    const runApi = s.runs.reduce((n, r) => n + r.apiErrors.length, 0)
    if (s.native.apiErrors.length > runApi) for (const e of s.native.apiErrors) issue("warning", "api-error-transcript", `Transcript API error ${e.status ?? ""} ${e.error ?? ""} at ${e.timestamp}`, at())
    for (const h of s.native.stopHookErrors) issue("error", "hook-error", `Stop hook error ${h}`, at())
    for (const sa of s.native.subagents) if (sa.apiErrors) issue("warning", "subagent-api-error", `Native subagent ${sa.agentType} (${sa.id}) has ${sa.apiErrors} API error message(s)`, at())
  }
  if (s.harness === "oc" && s.native.present) {
    if (s.native.idleOutcome && s.native.idleOutcome !== "succeeded") issue("warning", "native-idle-outcome", `OpenCode idle_outcome=${s.native.idleOutcome}`, at())
    for (const e of s.native.assistantErrors) if (e.error?.type !== "aborted") issue("error", "native-message-error", `${e.error?.type ?? "error"}: ${oneLine(String(e.error?.message ?? JSON.stringify(e.error)), 200)} (${e.id})`, at())
    for (const c of s.native.children) if (c.idleOutcome && c.idleOutcome !== "succeeded") issue("info", "native-child-outcome", `Native child ${c.agent} ${c.id} idle_outcome=${c.idleOutcome}`, at())
  }
}

// Handoffs
const sessionByNative = new Map(sessionReports.map(s => [s.nativeId, s]))
const handoffs = wsHandoffs.map(h => {
  const input = parseJsonField(h.input) ?? {}, rec = parseJsonField(h.recipient) ?? {}
  const sender = byConvId.get(h.sender_id), recipient = (rec.sessionId && byAppId.get(rec.sessionId)) || sessionByNative.get(rec.ref?.nativeId)
  const attempts = q(core, "SELECT id, run_id AS runId, created_at AS createdAt FROM handoff_attempts WHERE handoff_id=? ORDER BY created_at", h.id)
  const out = { id: h.id, requestId: h.request_id, to: input.to ?? null, createNew: input.createNew ?? null, status: h.status, sender: sender ? labelFor(sender) : `conv ${short(h.sender_id)}`, recipient: recipient ? labelFor(recipient) : rec.sessionId ? `app ${short(rec.sessionId)}` : "(unbound)", runId: h.run_id, evidence: h.evidence, attempts: attempts.length, createdAt: h.created_at, updatedAt: h.updated_at, message: truncate(String(input.message ?? ""), args.full ? Infinity : 160).text }
  if (h.status === "failed") issue("error", "handoff-failed", `Handoff ${h.request_id} (${out.sender} → ${out.to}) failed: ${h.evidence ?? ""}`, { run: h.run_id ?? undefined, session: out.recipient })
  else if (h.status !== "completed") issue("warning", "handoff-open", `Handoff ${h.request_id} status=${h.status} since ${h.updated_at}`, { session: out.recipient })
  if (h.run_id && !appRuns.some(r => r.runId === h.run_id)) issue("warning", "handoff-run-missing", `Handoff ${h.request_id} run ${h.run_id} not found in App metadata`, {})
  return out
})

// Legacy sessions: one aggregated note
const legacy = sessionReports.filter(s => s.appSessionId && !s.saneContext && s.agentKind)
if (legacy.length) {
  issue("info", "no-sane-context-record", `${legacy.length} SANE agent session(s) have no App saneContext record (created before framework/Session block delivery was recorded, or not SANE-created); framework/Session-block checks are skipped for them`, { evidence: legacy.map(s => labelOf.get(s.key)).join(", ") })
  coverage.push("Framework and Session-block checks apply only to sessions with an App saneContext record")
}
if (!sessionReports.some(s => s.runs.some(r => r.launch))) coverage.push("No launch records in scope; agent/settings/framework file hashes unavailable")
coverage.push("OpenCode per-run evidence comes from App journal message events; session-level evidence comes from opencode.db (read-only)")

// ---------------------------------------------------------------------------
// Output

const report: Report = {
  generatedAt: new Date().toISOString(),
  scope: { repo: args.repo, workstream: args.workstream ?? null, session: args.session ?? null, sessions: sessionReports.length, runs: sessionReports.reduce((n, s) => n + s.runs.length, 0) },
  store: { path: coreDbPath, ...store },
  app: { config: args.appConfig, dataDir, claudeProfileRoot: claudeRoot ?? null, opencodeDb: ocDb ? args.opencodeDb : null, admissionsForRepo: repoAdmissions.length, orphanedAdmissions: orphaned.length },
  workstream: workstream ? { id: workstream.id, title: workstream.title, type: workstream.type, status: workstream.status, createdAt: workstream.created_at, updatedAt: workstream.updated_at, phases: q(core, "SELECT phase, status FROM phase_states WHERE workstream_id=?", workstream.id) } : null,
  handoffs, jobs: wsJobs, sessions: sessionReports,
  issues: issues.sort((a, b) => ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity)), coverage,
}

if (args.json) { console.log(redact(JSON.stringify(report, null, 2))); process.exit(0) }

const out: string[] = []
const p = (line = "") => out.push(line)
const counts = { error: 0, warning: 0, info: 0 }
for (const i of report.issues) counts[i.severity]++
p(`# SANE session review`)
p(`Repository: ${args.repo}  (store ${store.repositoryId}, schema v${store.version})`)
p(`App data: ${dataDir}`)
if (workstream) p(`Workstream: ${workstream.id} [${workstream.type}, ${workstream.status}] ${workstream.title}`)
if (report.workstream?.phases?.length) p(`Phases: ${report.workstream.phases.map((x: J) => `${x.phase}=${x.status}`).join(" ")}`)
p(`Scope: ${report.scope.sessions} sessions, ${report.scope.runs} runs, ${handoffs.length} handoffs, ${wsJobs.length} jobs`)
p(`Issues: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`)
p()
p(`## Issues`)
const grouped = new Map<string, Issue[]>()
for (const i of report.issues) { const k = `${i.severity}|${i.code}`; grouped.set(k, [...(grouped.get(k) ?? []), i]) }
for (const [k, list] of grouped) {
  const [sev, code] = k.split("|")
  p(`- [${sev}] ${code} ×${list.length}`)
  for (const i of list.slice(0, args.full ? Infinity : 12)) p(`    ${i.session ? `${i.session} ` : ""}${i.run ? `run ${short(i.run)} ` : ""}${i.message}${i.evidence ? `  {${i.evidence}}` : ""}`)
  if (!args.full && list.length > 12) p(`    … ${list.length - 12} more (use --full or --json)`)
}
if (!report.issues.length) p(`(none)`)
p()
p(`## Coverage`)
for (const c of coverage) p(`- ${c}`)
if (!args.issuesOnly) {
  if (wsJobs.length) { p(); p(`## Jobs`); for (const j of wsJobs) p(`- ${j.jobId} ${j.status} ${j.specPath}${j.reportPath ? ` → ${j.reportPath}` : ""}`) }
  if (handoffs.length) {
    p(); p(`## Handoffs`)
    for (const h of handoffs) p(`- ${h.createdAt} ${h.requestId}: ${h.sender} → ${h.to} (${h.recipient}) ${h.status}${h.runId ? ` run ${short(h.runId)}` : ""}${h.attempts > 1 ? ` attempts=${h.attempts}` : ""}${h.status !== "completed" ? ` evidence="${h.evidence}"` : ""}`)
  }
  p(); p(`## Sessions`)
  for (const s of sessionReports) {
    p()
    p(`### ${labelOf.get(s.key)} ${s.harness ?? "?"} ${s.kind}${s.agent ? `/${s.agent}` : ""}${s.title ? ` "${s.title}"` : ""} [${s.relations.join(",")}]`)
    p(`  ids: app=${s.appSessionId ?? "-"} conv=${s.conversationId ?? "-"} native=${s.nativeId ?? "-"}`)
    p(`  profile=${s.profileId ?? "-"} model=${s.model ?? "-"} effort=${s.effort ?? "-"} created=${s.createdAt ?? "-"} last=${s.lastStatus ?? "-"}${s.hidden ? " hidden" : ""}${s.admission ? ` admission=${s.admission.operation}/${s.admission.state}${s.admission.repositoryId && s.admission.primaryCheckout === store.primaryCheckout && s.admission.repositoryId !== store.repositoryId ? ` ORPHANED-BINDING(${short(s.admission.repositoryId)})` : s.admission.repositoryId === null ? " app-only" : ""}` : ""}`)
    if (s.parent) { const ps = (s.parent.appSessionId && byAppId.get(s.parent.appSessionId)) || (s.parent.conversationId && byConvId.get(s.parent.conversationId)); p(`  parent: ${ps ? labelFor(ps) : `native ${s.parent.nativeId}`} via ${s.parent.via}`) }
    for (const m of s.memberships) p(`  membership: ${m.workstreamId} ${m.startedAt} → ${m.endedAt ?? "active"}; slots: ${m.assignments.map(a => `${a.phase}(${a.startedAt}${a.endedAt ? `→${a.endedAt}` : ""})`).join(", ") || "-"}`)
    p(`  saneContext: ${s.saneContext ? `v${s.saneContext.version} framework ${s.saneContext.frameworkChars} chars${s.saneContext.hasAssignment ? " + assignment" : ""}` : "none recorded"}`)
    if (s.worker) {
      p(`  worker: ${s.worker.role} state=${s.worker.state} jobs=[${s.worker.jobs.join(",")}] parentRun=${short(s.worker.parentRunId)} toolCall=${s.worker.toolCallId ?? "-"} outcome=${s.worker.outcome?.status ?? "-"} notification=${s.worker.notification ?? "-"}`)
      if (!s.runs[0]?.submission) p(`    prompt (${s.worker.prompt.chars} chars${s.worker.prompt.truncated ? ", truncated" : ""}): ${args.full ? s.worker.prompt.text : oneLine(s.worker.prompt.text, args.promptChars)}`)
      if (s.worker.outcome?.summary) p(`    outcome: ${oneLine(s.worker.outcome.summary, 240)}`)
    }
    for (const b of s.branches) p(`  branch: ${short(b.sourceId)} → ${short(b.destinationId)} ${b.state} ${b.selector}`)
    const n = s.native
    if (s.harness === "cc") {
      if (!n.present) p(`  claude transcript: MISSING ${n.transcript ?? ""}`)
      else {
        p(`  claude transcript: ${n.transcript} (${n.entries} entries, versions ${n.claudeVersions.join(",") || "-"})`)
        p(`    agent-setting: ${n.agentSettings.join(", ") || "-"}; instructions: ${n.instructions.join(", ") || "-"}; skill listings: ${n.skillListings}`)
        p(`    prompt snapshots: ${n.promptSnapshots.length ? n.promptSnapshots.map((x: J) => `${x.chars} chars "${x.firstLine}"${x.sessionBlock ? ` [Session block: ${x.sessionBlock}]` : ""}`).slice(0, 2).join(" | ") + (n.promptSnapshots.length > 2 ? ` (+${n.promptSnapshots.length - 2})` : "") : "none (snapshot disabled or absent)"}`)
        p(`    framework (hook_additional_context): ${n.frameworkContext.length ? n.frameworkContext.map((f: J) => `${f.timestamp} ${f.chars} chars${f.hookName ? ` ${f.hookName}` : ""}`).join("; ") : "none"}; other hook context: ${n.otherHookContext}`)
        p(`    api errors: ${n.apiErrors.length}; tool errors: ${n.toolErrors}; compactions: ${n.compactions.length}; stop-hook errors: ${n.stopHookErrors.length}`)
        for (const sa of n.subagents) p(`    native subagent ${sa.id}: ${sa.agentType} "${oneLine(String(sa.description ?? ""), 80)}"${sa.apiErrors ? ` apiErrors=${sa.apiErrors}` : ""}${sa.toolErrors ? ` toolErrors=${sa.toolErrors}` : ""}`)
      }
    } else if (s.harness === "oc") {
      if (!n.present) p(`  opencode session: MISSING ${n.sessionId ?? ""}`)
      else {
        p(`  opencode session: ${n.sessionId} agent=${n.agent ?? "-"} model=${n.model?.id ? `${n.model.providerID}/${n.model.id}${n.model.variant ? `:${n.model.variant}` : ""}` : "-"} idle=${n.idleOutcome ?? "-"}${n.parentId ? ` parent=${n.parentId}` : " (root)"}${n.forkSessionId ? ` fork-of=${n.forkSessionId}` : ""}`)
        p(`    messages: ${Object.entries(n.messageCounts).map(([k, v]) => `${k}=${v}`).join(" ")}`)
        p(`    framework synthetic: ${n.framework.length ? n.framework.map((f: J) => `${f.id} seq=${f.seq} ${f.chars} chars${f.expectedId ? "" : " (unexpected id)"}`).join("; ") : "none"}`)
        p(`    saneContext metadata: ${n.saneContextMetadata ? `Workstream ${n.saneContextMetadata.workstreamId ?? "(none)"}` : "none"}`)
        if (n.instructions) p(`    instructions: ${n.instructions.keys.map((k: J) => `${k.key}(${k.chars ?? "?"}${k.changedSinceInitial ? ",changed" : ""})`).join(" ")}`)
        if (n.instructionEntries.length) p(`    instruction entries: ${n.instructionEntries.map((e: J) => `${e.key}(${e.chars ?? 0}${e.removed ? ",removed" : ""})`).join(" ")}`)
        p(`    skills: ${n.skills.join(", ") || "-"}; tool errors: ${n.toolErrors}; assistant errors: ${n.assistantErrors.length}; compactions: ${n.compactions.length}`)
        for (const c of n.children) p(`    native child ${c.id}: ${c.agent} "${oneLine(String(c.title ?? ""), 60)}" idle=${c.idleOutcome ?? "-"}`)
      }
    }
    for (const r of s.runs) {
      const res = r.result ? ` result=${r.result.subtype}${r.result.isError ? "/error" : ""}${r.result.apiErrorStatus ? `/${r.result.apiErrorStatus}` : ""} turns=${r.result.numTurns ?? "-"}${typeof r.result.costUsd === "number" ? ` $${r.result.costUsd.toFixed(2)}` : ""}` : ""
      p(`  - run ${short(r.runId)} ${r.createdAt} ${r.operation} ${r.status}${r.final?.exitCode !== undefined ? ` exit=${r.final.exitCode}` : ""}${res}${r.statusReasons.length ? ` reason="${r.statusReasons.join("; ")}"` : ""}${r.journal.present ? "" : " JOURNAL MISSING"}`)
      if (r.submission) p(`      ${r.submission.kind}${r.submission.ref ? ` ${r.submission.ref}` : ""} (${r.submission.chars} chars${r.submission.truncated ? ", truncated" : ""}): ${args.full ? r.submission.text : oneLine(r.submission.text, args.promptChars)}`)
      if (r.launch) p(`      launch: resume=${r.launch.resume} agent=${r.launch.agent ?? r.launch.nativeAgent ?? "-"} ctx=v${r.launch.saneContextVersion ?? "-"}${r.launch.claudeVersion ? ` claude=${r.launch.claudeVersion}` : ""}${r.launch.agentFile ? ` agentFile=${r.launch.agentFile.path}` : ""}${r.launch.model ? ` model=${r.launch.model}` : ""}${r.launch.variant ? `:${r.launch.variant}` : ""}`)
      else if (r.init) p(`      init: claude=${r.init.claudeVersion ?? "-"} model=${r.init.model ?? "-"} agent=${r.init.agent ?? "-"} tools=${r.init.tools ?? "-"}`)
      if (r.framework) p(`      framework: ${r.framework.file ? "session-start file" : ""}${r.framework.hookOutcome ? ` hook=${r.framework.hookOutcome}` : ""}${r.framework.contextEvent ? ` delivered ${r.framework.contextEvent.messageId ?? ""} ${r.framework.contextEvent.chars ?? ""} chars` : ""}`)
      if (r.sessionBlock) p(`      session block (${r.sessionBlock.source}): Workstream ${r.sessionBlock.workstreamId ?? "(none)"}; membership ${r.sessionBlock.expected ?? "(none)"}${args.full ? `\n${r.sessionBlock.text.replace(/^/gm, "        ")}` : ""}`)
      const extras = [
        r.skills.length ? `skills: ${r.skills.join(", ")}` : "",
        r.toolErrors.length ? `tool errors ${r.toolErrors.length}: ${r.toolErrors.slice(0, 2).map(t => `${t.tool}: ${oneLine(t.message, 80)}`).join(" | ")}` : "",
        r.compactions ? `compactions ${r.compactions}` : "",
        r.permissionDenials.length ? `permission denials ${r.permissionDenials.length}` : "",
        r.hookErrors.length ? `hook errors ${r.hookErrors.length}` : "",
        r.apiErrors.length ? `api errors ${r.apiErrors.length}` : "",
        r.messageErrors.length ? `message errors: ${r.messageErrors.slice(0, 2).join(" | ")}` : "",
      ].filter(Boolean)
      if (extras.length) p(`      ${extras.join("; ")}`)
    }
  }
}
console.log(redact(out.join("\n")))
