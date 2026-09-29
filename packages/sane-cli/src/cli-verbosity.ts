/** C11 Phase 3 — CLI verbosity: compact default projections, capped full evidence.
 *
 * `executeCliCommand` keeps its programmatic contract (full domain results) but
 * projects them before returning: compact small summaries by default, full
 * evidence (with bounded arrays) behind `--verbose`/`--json`. `runCliCommand`
 * prints compact human/agent-friendly lines by default, pretty full JSON for
 * `--verbose`, single-line JSON for `--json`.
 *
 * Caps live here (the CLI formatting layer) rather than in sane-core because
 * several full shapes feed domain writes: `validatePhase.fileHashes` feeds
 * approval-file inserts, `validatePhase.files` feeds job registration, and
 * `getStatus` feeds the App bridge. Truncating at the source would change
 * behavior; truncating the CLI projection only shrinks reply bodies.
 */
import type { CliIntent } from "./cli-arguments.ts"

/** Max array entries kept in any verbose/JSON output. */
export const EVIDENCE_LIST_CAP = 50
/** Max sample entries kept in compact default projections. */
const COMPACT_SAMPLE = 10
const COMPACT_WARNING_SAMPLE = 5
const PHASE_ORDER = ["design", "engineering", "planning", "execution"]

type Rec = Record<string, any>
const rec = (value: unknown): Rec => (value && typeof value === "object" ? (value as Rec) : {})
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)
const arr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

function sample<T>(value: unknown, cap: number): { list: T[]; total: number; truncated: boolean } {
  const items = arr<T>(value)
  return items.length > cap
    ? { list: items.slice(0, cap), total: items.length, truncated: true }
    : { list: items, total: items.length, truncated: false }
}

/** Last-N sample for chronological evidence (audit/events): recent entries matter. */
function recent<T>(value: unknown, cap: number): { list: T[]; total: number; truncated: boolean } {
  const items = arr<T>(value)
  return items.length > cap
    ? { list: items.slice(-cap), total: items.length, truncated: true }
    : { list: items, total: items.length, truncated: false }
}

function cappedFields(name: string, s: { total: number; truncated: boolean }): Rec {
  return s.truncated ? { [`${name}Total`]: s.total, [`${name}Truncated`]: true } : {}
}

/**
 * Deep, non-mutating bound on every array in a verbose/JSON result. Arrays
 * longer than EVIDENCE_LIST_CAP are sliced (most-recent kept for
 * audit/event evidence, head kept otherwise) with `<key>Truncated: true` and
 * `<key>Total: n` siblings so callers can page or escalate to full reads.
 */
export function capEvidence<T>(value: T): T {
  return capValue(value, "") as T
}

function capValue(value: any, key: string): any {
  if (Array.isArray(value)) {
    const items = value.map((entry) => capValue(entry, key))
    if (value.length <= EVIDENCE_LIST_CAP) return items
    return /audit|event/i.test(key) ? items.slice(-EVIDENCE_LIST_CAP) : items.slice(0, EVIDENCE_LIST_CAP)
  }
  if (value && typeof value === "object") {
    const out: Rec = {}
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.length > EVIDENCE_LIST_CAP) {
        out[k] = capValue(v, k)
        out[`${k}Truncated`] = true
        out[`${k}Total`] = v.length
      } else {
        out[k] = capValue(v, k)
      }
    }
    return out
  }
  return value
}

function refSummary(ref: unknown): { harness: string; authorityId: string; nativeId: string } {
  const r = rec(ref)
  return { harness: str(r.harness), authorityId: str(r.authorityId), nativeId: str(r.nativeId) }
}

function conversationSummary(conversation: unknown): Rec {
  const c = rec(conversation)
  const ref = refSummary(c.ref)
  return { ...ref, workstreamId: c.workstreamId ?? null, executionCheckout: rec(c.executionCheckout).path ?? c.executionCheckout ?? null }
}

function nextForStatus(id: string, phases: Rec[], jobs: Rec[]): string {
  const pending = phases.find((p) => p.status !== "approved")
  if (pending) return `sane approve ${pending.phase} --ref OWNER --workstream ${id}`
  const open = jobs.find((j) => j.status !== "completed")
  if (open) return `sane job ${open.job_id} ${open.status === "planned" ? "running" : "completed"} --workstream ${id}`
  return `none — ${id} complete`
}

function statusSummary(status: unknown): Rec {
  const s = rec(status)
  const workstream = rec(s.workstream)
  const lifecycle = rec(workstream.lifecycle)
  const id = str(workstream.id)
  const phases = arr<Rec>(lifecycle.phases).map((p) => ({ phase: str(p.phase), status: str(p.status) }))
  const approvals = arr<Rec>(lifecycle.approvals).map((a) => ({ phase: str(a.phase), ref: str(a.approval_ref) }))
  const jobs = sample<Rec>(lifecycle.jobs, EVIDENCE_LIST_CAP)
  const audit = arr(s.audit)
  const warnings = arr<string>(rec(s.research).warnings)
  return {
    workstream: id,
    type: str(workstream.type),
    status: str(lifecycle.status),
    revision: workstream.revision ?? null,
    phases,
    approvals: approvals.length,
    jobs: jobs.list.map((j) => ({ job_id: str(j.job_id), status: str(j.status) })),
    ...cappedFields("jobs", jobs),
    auditTotal: audit.length,
    conversations: arr(s.conversations).length,
    researchWarnings: warnings.length,
    unresolvedArtifactOperations: arr(s.unresolvedArtifactOperations).length,
    next: nextForStatus(id, phases, arr<Rec>(lifecycle.jobs)),
  }
}

function validateSummary(validation: unknown, intent: CliIntent): Rec {
  const v = rec(validation)
  const phase = str(intent.positionals[0])
  const ws = str(intent.workstream)
  const problems = sample<string>(v.problems, COMPACT_SAMPLE)
  const warnings = sample<string>(v.warnings, COMPACT_WARNING_SAMPLE)
  return {
    workstream: ws,
    phase,
    ok: v.ok === true,
    hash: v.hash ?? null,
    files: arr(v.files).length,
    problems: problems.list,
    problemTotal: problems.total,
    ...cappedFields("problems", problems),
    warnings: warnings.list,
    warningTotal: warnings.total,
    ...cappedFields("warnings", warnings),
    next: v.ok === true
      ? `sane approve ${phase} --ref OWNER --workstream ${ws}`
      : `fix ${problems.total} problems, then re-run sane validate ${phase} --workstream ${ws}`,
  }
}

/** Compact default projection per operation. Tiny results pass through unchanged. */
export function compactSummary(operation: string, result: unknown, intent: CliIntent): unknown {
  const r = rec(result)
  const ws = str(intent.workstream)
  switch (operation) {
    case "create":
      if (r.dryRun) return { dryRun: true, operation: "create", id: str(intent.options.name) }
      return { id: str(r.id), type: str(r.type), status: str(rec(r.lifecycle).status) }
    case "select":
      return { dryRun: Boolean(r.dryRun), selected: str(rec(r.selected).id) }
    case "list": {
      const listed = sample<Rec>(r.workstreams, EVIDENCE_LIST_CAP)
      return {
        repositoryId: str(r.repositoryId),
        total: listed.total,
        ...cappedFields("workstreams", listed),
        workstreams: listed.list.map((w) => ({ id: str(w.id), type: str(w.type), status: str(rec(w.lifecycle).status) })),
      }
    }
    case "view":
    case "detail":
    case "status":
      return statusSummary(result)
    case "audit": {
      const events = recent<Rec>(r.events, COMPACT_SAMPLE)
      return {
        repositoryId: str(r.repositoryId),
        workstream: ws || null,
        total: events.total,
        ...cappedFields("events", events),
        events: events.list.map((e) => ({ id: e.id ?? null, operation: str(e.operation), timestamp: str(e.timestamp) })),
      }
    }
    case "sessions": {
      const conversations = sample<Rec>(r.conversations, EVIDENCE_LIST_CAP)
      const assignments = sample<Rec>(r.assignments, EVIDENCE_LIST_CAP)
      return {
        repositoryId: str(r.repositoryId),
        conversationTotal: conversations.total,
        ...cappedFields("conversations", conversations),
        assignmentTotal: assignments.total,
        ...cappedFields("assignments", assignments),
        conversations: conversations.list.map(conversationSummary),
        assignments: assignments.list.map((a) => ({ id: str(a.id), phase: str(a.phase), workstreamId: str(a.workstreamId), ...refSummary(a.ref) })),
      }
    }
    case "provide":
      return { workstream: ws, phase: str(intent.positionals[0]), created: arr(r.created).length, existed: arr(r.existed).length, refreshed: arr(r.refreshed).length }
    case "validate":
      return validateSummary(result, intent)
    case "approve": {
      const files = sample<string>(r.files, EVIDENCE_LIST_CAP)
      const jobs = sample<Rec>(r.jobs, EVIDENCE_LIST_CAP)
      const order = PHASE_ORDER.indexOf(str(r.phase))
      const nextPhase = order >= 0 && order < PHASE_ORDER.length - 1 ? PHASE_ORDER[order + 1] : null
      return {
        workstream: str(r.workstreamId),
        phase: str(r.phase),
        approval_ref: str(r.approval_ref),
        sane_hash: str(r.sane_hash),
        approved_at: str(r.approved_at),
        files: files.list,
        fileTotal: files.total,
        ...cappedFields("files", files),
        jobs: jobs.list,
        ...cappedFields("jobs", jobs),
        warnings: arr(r.warnings).length,
        next: str(r.phase) === "planning"
          ? `sane job --register --workstream ${str(r.workstreamId)}`
          : nextPhase ? `sane provide ${nextPhase} --workstream ${str(r.workstreamId)}` : `none — ${str(r.workstreamId)} complete`,
      }
    }
    case "job.register": {
      const jobs = sample<Rec>(r.jobs, EVIDENCE_LIST_CAP)
      const warnings = sample<string>(r.warnings, COMPACT_WARNING_SAMPLE)
      const planned = jobs.list.find((j) => str(j.status) === "planned")
      return {
        workstream: ws,
        jobs: jobs.list,
        ...cappedFields("jobs", jobs),
        warnings: warnings.list,
        warningTotal: warnings.total,
        ...cappedFields("warnings", warnings),
        next: planned ? `sane job ${str(planned.job_id)} running --workstream ${ws}` : `none — no planned jobs for ${ws}`,
      }
    }
    case "job.context": {
      const job = rec(r.job)
      const missing: string[] = []
      if (!job.specExists) missing.push(str(job.specPath, "spec"))
      if (!job.reportExists) missing.push(str(job.reportPath, "report"))
      if (r.reportTemplateExists === false) missing.push(str(r.reportTemplate, "report template"))
      const status = str(job.status)
      return {
        workstream: str(r.workstreamId),
        job: { jobId: str(job.jobId), status, specExists: job.specExists === true, reportExists: job.reportExists === true },
        missing,
        next: status === "planned"
          ? `sane job ${str(job.jobId)} running --workstream ${str(r.workstreamId)}`
          : status === "running"
            ? `write ${str(job.reportPath)}, then sane job ${str(job.jobId)} completed --workstream ${str(r.workstreamId)}`
            : `none — job ${str(job.jobId)} complete`,
      }
    }
    case "job.update":
    case "research.unregister":
    case "phase.end":
      return result
    case "research.index": {
      const unregistered = sample<string>(r.unregistered, COMPACT_SAMPLE)
      const warnings = sample<string>(r.warnings, COMPACT_SAMPLE)
      const first = unregistered.list[0]
      return {
        workstream: ws,
        registered: arr(r.registered).length,
        unregistered: unregistered.list,
        unregisteredTotal: unregistered.total,
        ...cappedFields("unregistered", unregistered),
        warnings: warnings.list,
        warningTotal: warnings.total,
        ...cappedFields("warnings", warnings),
        next: typeof first === "string"
          ? `sane research register --topic ${first.replace(/^research\//, "").replace(/\.md$/, "")} --path ${first} --workstream ${ws}`
          : `none — no unregistered research for ${ws}`,
      }
    }
    case "research.register": {
      const index = rec(compactSummary("research.index", result, intent))
      return { topic: str(intent.options.topic), path: str(intent.options.path), ...index }
    }
    case "default-checkout": {
      const pin = rec(r.defaultCheckout)
      return { workstream: str(r.id), defaultCheckout: typeof r.defaultCheckout === "object" && r.defaultCheckout !== null ? str(pin.path) : null }
    }
    case "authority.declare": {
      const d = rec(r.descriptor)
      return { harness: str(d.harness), authorityId: str(r.authorityId), kind: str(d.kind) }
    }
    case "conversation.register":
    case "conversation.get":
      return conversationSummary(result)
    case "conversation.context": {
      const c = rec(r.conversation)
      return {
        workstream: rec(r.workstream)?.id ?? null,
        ...refSummary(c.ref),
        executionCheckout: str(r.executionCheckout),
        primaryCheckout: str(r.primaryCheckout),
        artifactsRoot: r.artifactsRoot ?? null,
      }
    }
    case "conversation.associate":
      return { associated: true, workstream: ws, ...conversationSummary(result) }
    case "conversation.unassign":
      return { associated: false, ...conversationSummary(result) }
    case "phase.assign":
      return { id: str(r.id), phase: str(r.phase), workstreamId: str(r.workstreamId), ...refSummary(r.ref) }
    case "phase.target":
      return { phase: str(intent.positionals[1]), workstream: ws, ...conversationSummary(result) }
    case "init":
      if (r.dryRun) return { dryRun: true, operation: "init", state: str(rec(r.availability).state) }
      return { repositoryId: str(r.repositoryId), primaryCheckout: str(r.primaryCheckout) }
    case "inspect": {
      const ctx = rec(r.context)
      return r.state === "ready"
        ? { state: "ready", repositoryId: str(ctx.repositoryId), primaryCheckout: str(ctx.primaryCheckout) }
        : { state: str(r.state), code: str(r.code), message: str(r.message) }
    }
    case "native-config": {
      const format = str(intent.options.format, "all")
      return { format, keys: Object.keys(r), full: "use --json for full configuration" }
    }
    default:
      return result
  }
}

function jobCounts(jobs: Rec[]): string {
  const byStatus = new Map<string, number>()
  for (const j of jobs) byStatus.set(str(j.status), (byStatus.get(str(j.status)) ?? 0) + 1)
  return [...byStatus].map(([status, n]) => `${n} ${status}`).join(", ")
}

/** One-to-a-few-lines rendering of a compact projection. Lists stay bounded. */
export function formatCompactLines(operation: string, compact: unknown): string[] {
  const c = rec(compact)
  switch (operation) {
    case "create":
      return c.dryRun
        ? [`Would create workstream ${str(c.id)} (dry run)`]
        : [`Created workstream ${str(c.id)} [${str(c.type)}] status=${str(c.status)}`]
    case "select":
      return c.dryRun ? [`Would select workstream ${str(c.selected)} (dry run)`] : [`Selected workstream ${str(c.selected)}`]
    case "list": {
      const lines = arr<Rec>(c.workstreams).map((w) => `${str(w.id)} [${str(w.type)}] ${str(w.status)}`)
      if (c.workstreamsTruncated) lines.push(`… +${Number(c.total) - lines.length} more (use --verbose)`)
      return lines.length ? lines : ["No workstreams."]
    }
    case "view":
    case "detail":
    case "status": {
      const phases = arr<Rec>(c.phases).map((p) => `${str(p.phase)}=${str(p.status)}`).join(" ")
      const jobs = arr<Rec>(c.jobs)
      const jobText = jobs.length <= 10 && jobs.length
        ? jobs.map((j) => `${str(j.job_id)}=${str(j.status)}`).join(" ")
        : jobs.length ? jobCounts(jobs) : "none"
      return [
        `${str(c.workstream)} [${str(c.type)}] status=${str(c.status)} revision=${String(c.revision)}`,
        `phases: ${phases}`,
        `jobs: ${jobText} · approvals: ${Number(c.approvals)} · audit: ${Number(c.auditTotal)} events · research warnings: ${Number(c.researchWarnings)}`,
        `next: ${str(c.next)}`,
      ]
    }
    case "audit": {
      const lines = [`audit${c.workstream ? ` ${str(c.workstream)}` : ""}: ${Number(c.total)} events`]
      for (const e of arr<Rec>(c.events)) lines.push(`  #${String(e.id)} ${str(e.operation)} ${str(e.timestamp)}`)
      if (c.eventsTruncated) lines.push(`  … showing most recent ${arr(c.events).length} of ${Number(c.total)} (use --verbose)`)
      return lines
    }
    case "sessions": {
      const lines = [`sessions: ${Number(c.conversationTotal)} conversations, ${Number(c.assignmentTotal)} assignments`]
      for (const conv of arr<Rec>(c.conversations)) lines.push(`  ${str(conv.harness)}:${str(conv.nativeId)} workstream=${str(conv.workstreamId ?? "none")}`)
      for (const a of arr<Rec>(c.assignments)) lines.push(`  ${str(a.phase)} → ${str(a.harness)}:${str(a.nativeId)} (${str(a.workstreamId)})`)
      if (c.conversationsTruncated || c.assignmentsTruncated) lines.push("  … truncated (use --verbose)")
      return lines
    }
    case "provide":
      return [`Provided ${str(c.phase)} for ${str(c.workstream)}: ${Number(c.created)} created, ${Number(c.existed)} existed, ${Number(c.refreshed)} refreshed`]
    case "validate": {
      const lines = [c.ok
        ? `validate ${str(c.phase)} ${str(c.workstream)}: ok (${Number(c.files)} files)`
        : `validate ${str(c.phase)} ${str(c.workstream)}: FAILED (${Number(c.problemTotal)} problems)`]
      for (const p of arr<string>(c.problems)) lines.push(`  ${p}`)
      if (c.problemsTruncated) lines.push(`  … +${Number(c.problemTotal) - arr(c.problems).length} more problems (use --verbose)`)
      if (Number(c.warningTotal) > 0) {
        lines.push(`warnings: ${Number(c.warningTotal)}`)
        for (const w of arr<string>(c.warnings)) lines.push(`  warning: ${w}`)
        if (c.warningsTruncated) lines.push(`  … +${Number(c.warningTotal) - arr(c.warnings).length} more warnings (use --verbose)`)
      }
      lines.push(`next: ${str(c.next)}`)
      return lines
    }
    case "approve": {
      const lines = [
        `Approved ${str(c.phase)} for ${str(c.workstream)} (ref ${str(c.approval_ref)})`,
        `hash ${str(c.sane_hash)}`,
      ]
      const jobs = arr<Rec>(c.jobs)
      if (jobs.length) lines.push(`jobs: ${jobs.map((j) => `${str(j.job_id)}=${str(j.status)}`).join(" ")}`)
      if (c.jobsTruncated) lines.push(`… jobs truncated (use --verbose)`)
      if (Number(c.warnings) > 0) lines.push(`warnings: ${Number(c.warnings)} (use --verbose)`)
      lines.push(`next: ${str(c.next)}`)
      return lines
    }
    case "job.register": {
      const lines = [`Registered ${arr(c.jobs).length} jobs for ${str(c.workstream)}: ${arr<Rec>(c.jobs).map((j) => str(j.job_id)).join(", ") || "none"}`]
      for (const w of arr<string>(c.warnings)) lines.push(`  warning: ${w}`)
      if (c.warningsTruncated) lines.push(`  … +${Number(c.warningTotal) - arr(c.warnings).length} more warnings (use --verbose)`)
      lines.push(`next: ${str(c.next)}`)
      return lines
    }
    case "job.context": {
      const job = rec(c.job)
      const lines = [`job ${str(job.jobId)} [${str(job.status)}] spec=${job.specExists ? "ok" : "missing"} report=${job.reportExists ? "ok" : "missing"}`]
      if (arr(c.missing).length) lines.push(`missing: ${arr<string>(c.missing).join(", ")}`)
      lines.push(`next: ${str(c.next)}`)
      return lines
    }
    case "job.update":
      return [`job ${str(c.jobId)} → ${str(c.status)} (${c.changed ? "changed" : "already set"})`]
    case "research.index":
    case "research.register": {
      const prefix = operation === "research.register" ? `Registered research ${str(c.topic)} → ${str(c.path)}: ` : `research ${str(c.workstream)}: `
      const lines = [`${prefix}${Number(c.registered)} registered, ${Number(c.unregisteredTotal)} unregistered, ${Number(c.warningTotal)} warnings`]
      for (const u of arr<string>(c.unregistered)) lines.push(`  unregistered: ${u}`)
      if (c.unregisteredTruncated) lines.push(`  … +${Number(c.unregisteredTotal) - arr(c.unregistered).length} more (use --verbose)`)
      for (const w of arr<string>(c.warnings)) lines.push(`  warning: ${w}`)
      if (c.warningsTruncated) lines.push(`  … +${Number(c.warningTotal) - arr(c.warnings).length} more (use --verbose)`)
      lines.push(`next: ${str(c.next)}`)
      return lines
    }
    case "research.unregister":
      return [`Unregistered research ${str(c.unregistered)}`]
    case "default-checkout":
      return c.defaultCheckout ? [`Default checkout for ${str(c.workstream)}: ${str(c.defaultCheckout)}`] : [`Default checkout cleared for ${str(c.workstream)}`]
    case "authority.declare":
      return [`Declared authority ${str(c.harness)}:${str(c.authorityId)} (${str(c.kind)})`]
    case "conversation.register":
    case "conversation.get":
      return [`conversation ${str(c.harness)}:${str(c.authorityId)}:${str(c.nativeId)} workstream=${str(c.workstreamId ?? "none")} checkout=${str(c.executionCheckout)}`]
    case "conversation.context":
      return [
        `context ${str(c.harness)}:${str(c.nativeId)} workstream=${str(c.workstream ?? "none")}`,
        `checkout: ${str(c.executionCheckout)}`,
        `artifacts: ${str(c.artifactsRoot ?? "none")}`,
      ]
    case "conversation.associate":
      return [`Associated ${str(c.harness)}:${str(c.nativeId)} → ${str(c.workstream)}`]
    case "conversation.unassign":
      return [`Unassigned ${str(c.harness)}:${str(c.nativeId)}`]
    case "phase.assign":
      return [`Assigned ${str(c.phase)} → ${str(c.harness)}:${str(c.nativeId)} (assignment ${str(c.id)}, workstream ${str(c.workstreamId)})`]
    case "phase.target":
      return [`Target ${str(c.phase)} for ${str(c.workstream)}: ${str(c.harness)}:${str(c.nativeId)}`]
    case "phase.end":
      return [`Ended assignment ${str(c.ended)}`]
    case "init":
      return c.dryRun ? [`init dry run: ${str(c.state)}`] : [`Initialized repository ${str(c.repositoryId)} at ${str(c.primaryCheckout)}`]
    case "inspect":
      return c.state === "ready"
        ? [`Repository ${str(c.repositoryId)} ready (${str(c.primaryCheckout)})`]
        : [`Repository ${str(c.state)}: ${str(c.message)}`]
    case "native-config":
      return [`native-config ${str(c.format)}: ${arr<string>(c.keys).join(", ")} (use --json for full configuration)`]
    default:
      return [JSON.stringify(compact)]
  }
}
