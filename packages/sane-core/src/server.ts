import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import type { AuditEvent, CheckoutPin, Conversation, ConversationRef, CreateWorkstreamInput, InvocationContext, MutationContext, NativeSourceDescriptor, Phase, PhaseAssignment, RegisterConversationInput, RepositoryContext, Workstream, WorkstreamStatus, WorkstreamDocumentCatalog } from "./contracts.ts"
import { DomainError, fail, storageError, text } from "./errors.ts"
import { checkDiscovery, inspectRepositoryStore, pinCheckout, revalidateCheckout, safeStoreFiles, samePin } from "./repository.ts"
import { normalizeNativeSource } from "./native-source.ts"
import { acquireArtifactLock } from "./artifact-lock.ts"
import { DEFAULT_TEMPLATE_ROOT, INITIAL_DIRECTORIES, initialTemplateRegistry } from "./bootstrap-registry.ts"
import { validateWorkstreamType } from "./workstream-type.ts"
import { inspectBootstrappedWorkstream } from "./bootstrap-validation.ts"
import { ConfinedLifecycleFileSystem } from "./confined-lifecycle-filesystem.ts"
import { LifecycleAccessError } from "./lifecycle-filesystem.ts"
import { LIFECYCLE_PHASES, lifecyclePhase as policyPhase, type Lifecycle, type LifecycleJob } from "./lifecycle.ts"
import { providePhase as provision } from "./provision.ts"
import { validatePhaseDocs } from "./validation.ts"
import { assertJobProgress, registerPlannedJobs } from "./job-policy.ts"
import type { Handoff, HandoffRecipient, HandoffStatus } from "./contracts.ts"
import { handoffInput, equivalentHandoffInputs } from "./handoff.ts"
import { documentDescriptors } from "./document-catalog.ts"
import { isStoredSlot, canonicalSlot, equivalentSlots } from "./slots.ts"
import { SCHEMA_VERSION } from "./schema.ts"
import { assertSchemaCapabilities } from "./schema-upgrade.ts"

export type * from "./contracts.ts"
export { DomainError } from "./errors.ts"
export { discoverRepository, inspectRepositoryStore, initializeRepository, upgradeRepository, revalidateCheckout } from "./repository.ts"
export { SLOT_REGISTRY, SLOT_PATTERN, STORED_SLOT_PATTERN, SUPPORT_TRACKS, isSlot, isStoredSlot, canonicalSlot, equivalentSlots, validateSlot, parseSlot } from "./slots.ts"
export { normalizeNativeSource } from "./native-source.ts"
export { handoffInput, handoffSchema, equivalentHandoffInputs } from "./handoff.ts"

const now = () => new Date().toISOString()
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
function lifecyclePhase(value: string) { try { return policyPhase(value) } catch (error) { return fail("INVALID_INPUT", (error as Error).message) } }
function id(value: string): void { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value)) fail("INVALID_INPUT", "Expected a lowercase safe ID of 1–96 characters.") }
function phaseName(value: Phase): void { if (!isStoredSlot(value)) fail("INVALID_INPUT", "Invalid phase/support slot.") }
function qualified(ref: ConversationRef): void {
  if (!ref || (ref.harness !== "cc" && ref.harness !== "oc")) fail("INVALID_INPUT", "Expected qualified native reference.")
  text(ref.authorityId, "authorityId"); text(ref.nativeId, "nativeId")
}
function artifactRelative(path: string): void {
  if (typeof path !== "string" || !path.endsWith(".md") || path.includes("\\") || path.includes("\0") || isAbsolute(path) || path.split("/").some(p => !p || p === "." || p === "..")) fail("INVALID_ARTIFACT", "Expected a relative Markdown path without traversal.")
}
function artifactError(error: unknown): never {
  if (error instanceof LifecycleAccessError) fail("INVALID_ARTIFACT", error.message)
  if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("NOT_FOUND", (error as Error).message)
  return storageError(error)
}
/** Explicit lifetime, one validated primary-checkout authority, no ambient targeting. */
export class RepositoryDomain {
  private closed = false
  private readonly databaseIdentity: { dev: number; ino: number }
  private constructor(private readonly db: Database, public readonly context: RepositoryContext) {
    this.context = Object.freeze({ ...context, primaryPin: Object.freeze({ ...context.primaryPin }), invocationCheckout: Object.freeze({ ...context.invocationCheckout }) })
    const stat = lstatSync(context.databasePath); this.databaseIdentity = { dev: stat.dev, ino: stat.ino }
  }
  static open(context: RepositoryContext): RepositoryDomain {
    const state = inspectRepositoryStore(context)
    if (state.state !== "ready") fail(state.code, state.message)
    if (state.context.repositoryId !== context.repositoryId || context.schemaVersion !== SCHEMA_VERSION) fail("STALE_BINDING", "Repository domain UUID/schema version changed; reopen after an explicit upgrade.")
    const db = new Database(context.databasePath, { create: false, strict: true })
    try { db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000"); const domain = new RepositoryDomain(db, state.context); domain.guard(); return domain }
    catch (error) { db.close(); return storageError(error) }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
  get repositoryId(): string { return this.context.repositoryId }
  get primaryCheckout(): string { return this.context.primaryCheckout }
  get stateRoot(): string { return this.context.stateRoot }
  /** Validate live-handle validity only, not execution eligibility or writability. */
  validateHandle(): void { this.guard() }
  private guard(): void {
    if (this.closed) fail("INVALID_CONTEXT", "Repository handle is closed.")
    checkDiscovery(this.context); safeStoreFiles(this.context)
    if (existsSync(join(this.stateRoot, "upgrading.json")) || existsSync(join(this.stateRoot, ".complete-upgrade.json"))) fail("UNSUPPORTED_SCHEMA", "Explicit store upgrade is pending; close and reopen this handle after local recovery.")
    const stat = lstatSync(this.context.databasePath)
    if (stat.dev !== this.databaseIdentity.dev || stat.ino !== this.databaseIdentity.ino) fail("STALE_BINDING", "Domain database file was replaced.")
    let verifier: Database | undefined
    try {
      // A cached SQLite page can retain old metadata after an out-of-band
      // inode-preserving overwrite. Check a fresh reader as well as this handle.
      verifier = new Database(this.context.databasePath, { readonly: true, create: false, strict: true })
      verifier.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000")
      assertSchemaCapabilities(verifier, SCHEMA_VERSION)
      assertSchemaCapabilities(this.db, SCHEMA_VERSION)
      const metadataRows = [verifier.query("SELECT * FROM store_metadata WHERE id=1").get() as any, this.row("SELECT * FROM store_metadata WHERE id=1")]
      const marker = JSON.parse(readFileSync(join(this.stateRoot, "complete.json"), "utf8"))
      for (const metadata of metadataRows) {
      if (!metadata || metadata.format !== "sane-domain" || metadata.version !== this.context.schemaVersion || metadata.repository_id !== this.repositoryId
        || metadata.primary_checkout !== this.primaryCheckout || metadata.common_dir !== this.context.commonDir || !samePin(JSON.parse(metadata.primary_pin), this.context.primaryPin)
        || marker.format !== "sane-domain" || marker.version !== this.context.schemaVersion || marker.repositoryId !== this.repositoryId) fail("STALE_BINDING", "Opened domain metadata/completion binding changed.")
      }
    } catch (error) {
      if (error instanceof DomainError) throw error
      fail("STALE_BINDING", `Cannot revalidate opened domain metadata/completion evidence: ${(error as Error).message}`)
    } finally { verifier?.close() }
  }
  private rows(sql: string, ...args: SQLQueryBindings[]): any[] { return this.db.query(sql).all(...args) }
  private row(sql: string, ...args: SQLQueryBindings[]): any { return this.db.query(sql).get(...args) }
  private run(sql: string, ...args: SQLQueryBindings[]) { return this.db.query(sql).run(...args) }
  private mutationContext(context: MutationContext): void {
    this.guard()
    if (!context || typeof context !== "object" || !context.actor || !["local", "human", "system", "native"].includes(context.actor.kind)) fail("INVALID_CONTEXT", "Every mutation requires explicit actor/correlation context.")
    text(context.correlationId, "correlationId")
    if (context.expectedRevision !== undefined && (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0)) fail("INVALID_INPUT", "Invalid expected revision.")
    if (context.actor.kind === "native") {
      if (context.actor.repositoryId !== this.repositoryId) fail("INVALID_CONTEXT", "Native actor cannot mutate another repository.")
      this.resolveContext(context.actor.ref)
      this.assertConversationWritable(context.actor.ref)
    }
  }
  private transaction<T>(context: MutationContext, fn: () => T): T {
    this.mutationContext(context)
    try { return this.db.transaction(() => { this.guard(); if (context.actor.kind === "native") this.assertConversationWritable(context.actor.ref); return fn() }).immediate() } catch (error) { return storageError(error) }
  }
  private event(context: MutationContext, operation: string, workstreamId: string | null = null, entityId: string | null = null, details: Record<string, unknown> = {}): number {
    const actor = context.actor.kind === "native" ? this.conversationRow(context.actor.ref).id : null
    const serialized = JSON.stringify(details)
    if (serialized.length > 65536) fail("INVALID_INPUT", "Audit details exceed bounded size.")
    return Number(this.run("INSERT INTO audit_events(correlation_id,actor_kind,actor_conversation_id,operation,workstream_id,entity_id,details,timestamp) VALUES(?,?,?,?,?,?,?,?)", context.correlationId, context.actor.kind, actor, operation, workstreamId, entityId, serialized, now()).lastInsertRowid)
  }
  private workstreamRow(workstreamId: string): any { id(workstreamId); return this.row("SELECT * FROM workstreams WHERE id=?", workstreamId) ?? fail("NOT_FOUND", `Unknown workstream ${workstreamId}.`) }
  private revision(workstreamId: string, context: MutationContext, expected?: number): void {
    const row = this.workstreamRow(workstreamId)
    for (const value of [context.expectedRevision, expected]) if (value !== undefined && value !== row.revision) fail("CONFLICT", "Workstream changed during operation; validate current state explicitly.")
  }
  private touch(workstreamId: string): void { this.run("UPDATE workstreams SET revision=revision+1,updated_at=? WHERE id=?", now(), workstreamId) }
  private pin(pin: CheckoutPin): string {
    const values = [pin.path, pin.commonDir, pin.gitDir, pin.device, pin.inode, pin.commonDevice, pin.commonInode, pin.gitDevice, pin.gitInode]
    const existing = this.row("SELECT id FROM checkout_pins WHERE path=? AND common_dir=? AND git_dir=? AND device=? AND inode=? AND common_device=? AND common_inode=? AND git_device=? AND git_inode=?", ...values)
    if (existing) return existing.id
    const key = randomUUID(); this.run("INSERT INTO checkout_pins VALUES(?,?,?,?,?,?,?,?,?,?)", key, ...values); return key
  }
  private readPin(pinId: string | null): CheckoutPin | null {
    if (!pinId) return null
    const p = this.row("SELECT * FROM checkout_pins WHERE id=?", pinId) ?? fail("CORRUPT_STORE", "Missing checkout pin.")
    return { path: p.path, commonDir: p.common_dir, gitDir: p.git_dir, device: p.device, inode: p.inode, commonDevice: p.common_device, commonInode: p.common_inode, gitDevice: p.git_device, gitInode: p.git_inode }
  }
  validateExecutionCheckout(path: string): CheckoutPin { this.guard(); return pinCheckout(path, this.context.commonDir) }
  private lifecycle(workstreamId: string): Lifecycle {
    const ws = this.workstreamRow(workstreamId)
    const states = this.rows("SELECT p.*,a.user_reference FROM phase_states p LEFT JOIN approvals a ON a.id=p.current_approval_id WHERE p.workstream_id=?", workstreamId)
    const approvals = this.rows("SELECT a.* FROM approvals a JOIN phase_states p ON p.current_approval_id=a.id WHERE p.workstream_id=? ORDER BY a.created_at,a.id", workstreamId).map(a => {
      const files = this.rows("SELECT relative_path FROM approval_files WHERE approval_id=? ORDER BY relative_path", a.id).map(f => f.relative_path as string)
      return { id: a.id, phase: a.phase, artifact_path: files.join(", "), files, sane_hash: a.snapshot_hash, approval_ref: a.user_reference, approved_at: a.created_at }
    })
    const mutations = this.auditRows(workstreamId).filter(e => ["phase_approved", "phase_status_changed", "jobs_registered", "job_progressed", "job_report_assigned", "workstream_status_changed"].includes(e.operation)).map(e => ({ actor: e.actor, correlationId: e.correlationId, timestamp: e.timestamp, operation: e.operation }))
    return { status: ws.status, phases: LIFECYCLE_PHASES.map(phase => { const p = states.find(s => s.phase === phase) ?? fail("CORRUPT_STORE", "Missing lifecycle phase."); return { phase, status: p.status, owner_role: phase, approval_ref: p.user_reference ?? null } }), approvals, jobs: this.jobs(workstreamId), mutations }
  }
  private jobs(workstreamId: string): LifecycleJob[] { return this.rows("SELECT job_id,spec_path,report_path,status,updated_at FROM jobs WHERE workstream_id=? ORDER BY job_id", workstreamId) }
  private workstreamDTO(row: any): Workstream { return { repositoryId: this.repositoryId, id: row.id, title: row.title, type: row.type, defaultCheckout: this.readPin(row.default_pin_id), createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, lifecycle: this.lifecycle(row.id) } }
  listWorkstreams(): Workstream[] { this.guard(); return this.rows("SELECT * FROM workstreams ORDER BY created_at,id").map(w => this.workstreamDTO(w)) }
  getWorkstream(workstreamId: string): Workstream { this.guard(); return this.workstreamDTO(this.workstreamRow(workstreamId)) }
  createWorkstream(input: CreateWorkstreamInput, context: MutationContext): Workstream {
    this.mutationContext(context); id(input.id); text(input.title, "title")
    let type: CreateWorkstreamInput["type"]
    try { type = validateWorkstreamType(input.type) } catch (error) { return fail("INVALID_INPUT", (error as Error).message) }
    const checkout = input.defaultCheckout == null ? null : this.validateExecutionCheckout(input.defaultCheckout)
    const release = acquireArtifactLock(this.stateRoot, input.id), operationId = randomUUID()
    const destination = join(this.stateRoot, "workstreams", input.id)
    let started = false
    try {
      if (this.row("SELECT id FROM workstreams WHERE id=?", input.id)) fail("CONFLICT", "Workstream already exists.")
      if (existsSync(destination)) fail("CONFLICT", `Orphan or existing artifact directory: ${destination}; operation ${operationId}. Never adopted or removed.`)
      // Read/stage all source bytes before publication or domain row creation.
      const templates = new ConfinedLifecycleFileSystem(DEFAULT_TEMPLATE_ROOT)
      const staged = initialTemplateRegistry(type).map(t => ({ path: t.destination, bytes: templates.readBytes(join(DEFAULT_TEMPLATE_ROOT, t.source)) }))
      this.transaction(context, () => this.event(context, "artifact_operation_started", input.id, operationId, { kind: "create", path: destination }))
      started = true
      mkdirSync(destination, { mode: 0o700 })
      const fs = new ConfinedLifecycleFileSystem(destination)
      for (const directory of INITIAL_DIRECTORIES) fs.mkdir(join(destination, directory))
      for (const entry of staged) { fs.mkdir(join(destination, entry.path, "..")); fs.writeBytes(join(destination, entry.path), entry.bytes, true) }
      fs.assertTree()
      this.transaction(context, () => {
        const time = now()
        this.run("INSERT INTO workstreams(id,title,type,default_pin_id,created_at,updated_at) VALUES(?,?,?,?,?,?)", input.id, input.title, type, checkout ? this.pin(checkout) : null, time, time)
        for (const phase of LIFECYCLE_PHASES) this.run("INSERT INTO phase_states(workstream_id,phase) VALUES(?,?)", input.id, phase)
        this.event(context, "workstream_created", input.id, input.id, { type })
        this.event(context, "artifact_operation_completed", input.id, operationId, { manifest: staged.map(s => ({ path: s.path, hash: hash(s.bytes) })) })
      })
      return this.getWorkstream(input.id)
    } catch (error) {
      if (started) { try { this.transaction(context, () => this.event(context, "artifact_operation_failed", input.id, operationId, { path: destination, partial: existsSync(destination), error: String(error).slice(0, 2000) })) } catch {} }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("CONFLICT", `Artifact destination conflict at ${destination}; operation ${operationId}.`)
      return artifactError(error)
    } finally { release() }
  }
  setDefaultCheckout(workstreamId: string, path: string | null, context: MutationContext): Workstream {
    const pin = path === null ? null : this.validateExecutionCheckout(path)
    this.transaction(context, () => { this.revision(workstreamId, context); this.run("UPDATE workstreams SET default_pin_id=? WHERE id=?", pin ? this.pin(pin) : null, workstreamId); this.touch(workstreamId); this.event(context, "default_checkout_changed", workstreamId, workstreamId, { checkout: pin }) })
    return this.getWorkstream(workstreamId)
  }
  setWorkstreamStatus(workstreamId: string, status: Lifecycle["status"], context: MutationContext): Workstream {
    if (!["open", "blocked", "done", "abandoned"].includes(status)) fail("INVALID_INPUT", "Invalid workstream status.")
    this.transaction(context, () => { this.revision(workstreamId, context); this.run("UPDATE workstreams SET status=? WHERE id=?", status, workstreamId); this.touch(workstreamId); this.event(context, "workstream_status_changed", workstreamId, workstreamId, { status }) })
    return this.getWorkstream(workstreamId)
  }
  setWorkstreamTitle(workstreamId: string, title: string, context: MutationContext): Workstream {
    text(title, "title")
    this.transaction(context, () => { this.revision(workstreamId, context); this.run("UPDATE workstreams SET title=? WHERE id=?", title, workstreamId); this.touch(workstreamId); this.event(context, "workstream_title_changed", workstreamId, workstreamId, { title }) })
    return this.getWorkstream(workstreamId)
  }
  setPhaseStatus(workstreamId: string, requestedPhase: string, status: "pending" | "in_progress" | "delivered" | "blocked", context: MutationContext): void {
    const phase = lifecyclePhase(requestedPhase)
    if (!["pending", "in_progress", "delivered", "blocked"].includes(status)) fail("INVALID_INPUT", "Use approvePhase for explicit document approval.")
    this.transaction(context, () => { this.revision(workstreamId, context); this.run("UPDATE phase_states SET status=?,revision=revision+1 WHERE workstream_id=? AND phase=?", status, workstreamId, phase); this.touch(workstreamId); this.event(context, "phase_status_changed", workstreamId, phase, { status }) })
  }
  declareNativeAuthority(source: NativeSourceDescriptor, context: MutationContext) {
    const normalized = normalizeNativeSource(source), d = normalized.descriptor
    const locator = d.harness === "cc" ? d.profileRoot : d.registrationFile
    this.transaction(context, () => {
      const old = this.row("SELECT * FROM native_authorities WHERE harness=? AND authority_id=?", d.harness, normalized.authorityId)
      if (old) { if (old.kind !== d.kind || old.locator !== locator) fail("CONFLICT", "Native authority is immutable."); return }
      this.run("INSERT INTO native_authorities VALUES(?,?,?,?)", d.harness, normalized.authorityId, d.kind, locator)
      this.event(context, "native_authority_declared", null, normalized.authorityId, { descriptor: d })
    })
    return normalized
  }
  private conversationRow(ref: ConversationRef): any { qualified(ref); return this.row("SELECT * FROM conversations WHERE harness=? AND authority_id=? AND native_id=?", ref.harness, ref.authorityId, ref.nativeId) ?? fail("NOT_FOUND", "Conversation is not registered.") }
  private reference(row: any): ConversationRef { return { harness: row.harness, authorityId: row.authority_id, nativeId: row.native_id } }
  private conversationDTO(row: any): Conversation {
    const membership = this.row("SELECT workstream_id FROM memberships WHERE conversation_id=? AND ended_at IS NULL", row.id)
    const parent = row.parent_id ? this.row("SELECT * FROM conversations WHERE id=?", row.parent_id) : null
    return { id: row.id, repositoryId: this.repositoryId, ref: this.reference(row), executionCheckout: this.readPin(row.execution_pin_id)!, parent: parent ? this.reference(parent) : null, workstreamId: membership?.workstream_id ?? null, createdAt: row.created_at }
  }
  listConversations(): Conversation[] { this.guard(); return this.rows("SELECT * FROM conversations ORDER BY created_at,id").map(c => this.conversationDTO(c)) }
  private handoffDTO(row: any): Handoff {
    const h: Handoff = { id: row.id, repositoryId: this.repositoryId, sender: this.reference(this.row("SELECT * FROM conversations WHERE id=?", row.sender_id)), workstreamId: row.workstream_id, input: JSON.parse(row.input), recipient: JSON.parse(row.recipient), status: row.status, revision: row.revision, attemptId: row.attempt_id, nativeCommandId: row.native_command_id, runId: row.run_id, evidence: row.evidence, createdAt: row.created_at, updatedAt: row.updated_at }
    const input = JSON.parse(row.input)
    return input.kickoff ? { ...h, origin: { kind: "kickoff", sender: h.sender, requestId: input.requestId } } : h
  }
  getHandoff(id: string): Handoff { this.guard(); text(id, "handoff ID"); return this.handoffDTO(this.row("SELECT * FROM handoffs WHERE id=?", id) ?? fail("NOT_FOUND", "Unknown handoff.")) }
  findHandoff(sender: ConversationRef, requestId: string): Handoff | null {
    this.guard(); const c = this.conversationRow(sender), row = this.row("SELECT * FROM handoffs WHERE sender_id=? AND request_id=?", c.id, requestId)
    return row ? this.handoffDTO(row) : null
  }
  /** True when `workstreamId` was created by the kickoff handoff (sender, requestId). */
  private kickoffCreated(workstreamId: string, sender: ConversationRef, requestId: string): boolean {
    const c = this.conversationRow(sender)
    return !!this.row("SELECT 1 FROM audit_events WHERE operation='workstream_created' AND workstream_id=? AND actor_kind='native' AND actor_conversation_id=? AND correlation_id=?", workstreamId, c.id, `kickoff:${requestId}`)
  }
  /** Idempotently create the kickoff workstream for a sender without one; the sender never joins it. */
  kickoffWorkstream(sender: ConversationRef, input: unknown): Workstream {
    const args = handoffInput(input), kickoff = args.kickoff ?? fail("INVALID_INPUT", "Kickoff arguments required.")
    const invocation = this.resolveContext(sender)
    if (invocation.workstream) fail("INVALID_CONTEXT", "Kickoff is only for senders without a workstream.")
    const context: MutationContext = { actor: { kind: "native", repositoryId: this.repositoryId, ref: sender }, correlationId: `kickoff:${args.requestId}` }
    if (this.row("SELECT id FROM workstreams WHERE id=?", kickoff.workstream)) {
      const ws = this.getWorkstream(kickoff.workstream)
      if (!this.kickoffCreated(ws.id, sender, args.requestId) || ws.title !== kickoff.title || ws.type !== kickoff.type) fail("CONFLICT", "Workstream already exists.")
      return ws
    }
    return this.createWorkstream({ id: kickoff.workstream, title: kickoff.title, type: kickoff.type, defaultCheckout: args.checkout ?? invocation.executionCheckout }, context)
  }
  listHandoffs(): Handoff[] { this.guard(); return this.rows("SELECT * FROM handoffs ORDER BY created_at,id").map(row => this.handoffDTO(row)) }
  /** Polling/recovery only: retain every queued or active delivery, including uncertain attempts. */
  listHandoffsForPolling(): Handoff[] {
    this.guard()
    return this.rows("SELECT * FROM handoffs WHERE status IN ('queued','acceptance_unknown','accepted','running') ORDER BY created_at,id").map(row => this.handoffDTO(row))
  }
  admitHandoff(sender: ConversationRef, input: unknown, recipient: HandoffRecipient, context: MutationContext): Handoff {
    const args = handoffInput(input)
    return this.transaction(context, () => {
      if (context.actor.kind === "native" && JSON.stringify(context.actor.ref) !== JSON.stringify(sender)) fail("INVALID_CONTEXT", "Handoff sender differs from actor.")
      const old = this.findHandoff(sender, args.requestId)
      if (old) { if (!equivalentHandoffInputs(old.input, args)) fail("CONFLICT", "Request ID is already bound to another handoff payload."); return old }
      const invocation = this.resolveContext(sender)
      let workstreamId: string
      if (args.kickoff) {
        if (invocation.workstream) fail("INVALID_CONTEXT", "Kickoff is only for senders without a workstream.")
        if (!this.kickoffCreated(args.kickoff.workstream, sender, args.requestId)) fail("CONFLICT", "Workstream already exists.")
        workstreamId = args.kickoff.workstream
      } else workstreamId = invocation.workstream?.id ?? fail("INVALID_CONTEXT", "Sender has no workstream.")
      text(recipient.ownerId, "App store ID"); text(recipient.sessionId, "App session ID"); text(recipient.authorityId, "recipient authority")
      if (!["cc", "oc"].includes(recipient.harness)) fail("INVALID_INPUT", "Invalid recipient harness.")
      revalidateCheckout(this.context, recipient.checkout)
      if (recipient.ref) {
        const target = this.resolvePhaseTarget(workstreamId, args.to, recipient.ref)
        if (target.ref.harness !== recipient.harness || target.ref.authorityId !== recipient.authorityId || !samePin(target.executionCheckout, recipient.checkout)) fail("CONFLICT", "Recipient identity or checkout differs.")
        if (args.createNew || args.target && JSON.stringify(args.target) !== JSON.stringify(target.ref)) fail("CONFLICT", "Recipient differs from requested target.")
      } else if (!args.createNew) fail("INVALID_INPUT", "New recipient requires explicit creation.")
      const key = randomUUID(), time = now()
      this.run("INSERT INTO handoffs(id,sender_id,request_id,workstream_id,input,recipient,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)", key, this.conversationRow(sender).id, args.requestId, workstreamId, JSON.stringify(args), JSON.stringify(recipient), time, time)
      this.event(context, "handoff_queued", workstreamId, key, { recipient, requestId: args.requestId, ...(args.kickoff ? { origin: { kind: "kickoff", sender, requestId: args.requestId } } : {}) })
      return this.getHandoff(key)
    })
  }
  bindHandoffRecipient(id: string, ref: ConversationRef, expectedRevision: number, context: MutationContext): Handoff {
    return this.transaction(context, () => {
      if (context.actor.kind !== "system") fail("INVALID_CONTEXT", "App execution owner required.")
      const h = this.getHandoff(id)
      if (h.revision !== expectedRevision || h.status !== "queued" || h.recipient.ref) fail("CONFLICT", "Handoff recipient is already bound or changed.")
      const c = this.resolvePhaseTarget(h.workstreamId, h.input.to, ref)
      if (ref.harness !== h.recipient.harness || ref.authorityId !== h.recipient.authorityId || !samePin(c.executionCheckout, h.recipient.checkout)) fail("CONFLICT", "Created recipient differs from reserved identity or checkout.")
      this.run("UPDATE handoffs SET recipient=?,revision=revision+1,updated_at=? WHERE id=?", JSON.stringify({ ...h.recipient, ref }), now(), id)
      this.event(context, "handoff_recipient_bound", h.workstreamId, id, { ref })
      return this.getHandoff(id)
    })
  }
  /** Revalidate a bound delivery without reapplying membership or assignments. */
  assertHandoffRecipientEligible(h: Handoff): void {
    this.guard()
    const ref = h.recipient.ref ?? fail("CONFLICT", "Queued recipient must be bound before dispatch.")
    const c = this.getConversation(ref)
    if (h.repositoryId !== this.repositoryId || !c || c.workstreamId !== h.workstreamId) fail("CONFLICT", "Queued recipient no longer belongs to the selected workstream; restore its eligibility before delivery.")
    if (ref.harness !== h.recipient.harness || ref.authorityId !== h.recipient.authorityId || !samePin(c.executionCheckout, h.recipient.checkout)) fail("CONFLICT", "Queued recipient identity or checkout changed.")
    if (h.input.target && (ref.harness !== h.input.target.harness || ref.authorityId !== h.input.target.authorityId || ref.nativeId !== h.input.target.nativeId)) fail("CONFLICT", "Queued recipient differs from the explicit qualified target.")
    if (!this.assignments(h.workstreamId).some(a => a.endedAt === null && equivalentSlots(a.phase, h.input.to) && a.ref.harness === ref.harness && a.ref.authorityId === ref.authorityId && a.ref.nativeId === ref.nativeId)) fail("CONFLICT", "Queued recipient no longer has the destination assignment; restore its eligibility before delivery.")
    revalidateCheckout(this.context, h.recipient.checkout)
    this.assertConversationWritable(ref)
  }
  /** The App guard is synchronous: admission revalidation and domain eligibility
   * share the definitive reservation, before any attempt identities persist. */
  advanceHandoff(id: string, expectedRevision: number, change: { status: HandoffStatus; attemptId?: string; nativeCommandId?: string; runId?: string; evidence?: string; retry?: boolean }, context: MutationContext, assertAppRecipientReady?: (handoff: Handoff) => void): Handoff {
    return this.transaction(context, () => {
      if (context.actor.kind !== "system") fail("INVALID_CONTEXT", "App execution owner required.")
      const h = this.getHandoff(id)
      if (h.revision !== expectedRevision) fail("CONFLICT", "Handoff changed; reconcile current state.")
      const transitions: Record<HandoffStatus, HandoffStatus[]> = { queued: ["acceptance_unknown"], acceptance_unknown: ["accepted", "failed", "queued"], accepted: ["running", "completed", "failed"], running: ["completed", "failed"], completed: [], failed: [] }
      if (!transitions[h.status].includes(change.status)) fail("CONFLICT", "Invalid handoff transition.")
      if (change.status === "queued" && (change.retry !== true || !change.evidence?.trim())) fail("CONFLICT", "Explicit retry requires reconciled nonacceptance evidence.")
      if (change.status === "acceptance_unknown") {
        if (!h.recipient.ref || !change.attemptId || !change.nativeCommandId || !change.runId) fail("INVALID_INPUT", "Persist recipient, attempt, native command and run identities before dispatch.")
        text(change.attemptId, "attempt ID"); text(change.nativeCommandId, "native command ID"); text(change.runId, "run ID")
        this.assertHandoffRecipientEligible(h)
        if (assertAppRecipientReady?.(h) !== undefined) fail("INVALID_INPUT", "Dispatch admission guard must be synchronous.")
        const active = this.rows("SELECT id,recipient FROM handoffs WHERE status IN ('acceptance_unknown','accepted','running')").some(row => { const ref = JSON.parse(row.recipient).ref; return ref && ref.harness === h.recipient.ref!.harness && ref.authorityId === h.recipient.ref!.authorityId && ref.nativeId === h.recipient.ref!.nativeId })
        if (active) fail("BUSY", "Recipient already has an active or uncertain delivery.")
        this.run("INSERT INTO handoff_attempts VALUES(?,?,?,?,?)", change.attemptId, id, change.nativeCommandId, change.runId, now())
      } else if (change.attemptId !== undefined || change.nativeCommandId !== undefined || change.runId !== undefined) fail("INVALID_INPUT", "Attempt identities cannot change after dispatch.")
      if (change.status !== "acceptance_unknown") text(change.evidence, "native acceptance or outcome evidence")
      this.run("UPDATE handoffs SET status=?,revision=revision+1,attempt_id=?,native_command_id=?,run_id=?,evidence=?,updated_at=? WHERE id=?", change.status, change.attemptId ?? h.attemptId, change.nativeCommandId ?? h.nativeCommandId, change.runId ?? h.runId, change.evidence ?? null, now(), id)
      this.event(context, "handoff_state_changed", h.workstreamId, id, { ...change, previousStatus: h.status, previousAttemptId: h.attemptId })
      return this.getHandoff(id)
    })
  }
  /** Durable App delivery diagnostic; audit evidence only, never a state transition. */
  recordHandoffProblem(id: string, problem: string, context: MutationContext): void {
    this.transaction(context, () => {
      if (context.actor.kind !== "system") fail("INVALID_CONTEXT", "App execution owner required.")
      const h = this.getHandoff(id)
      text(problem, "handoff problem")
      this.event(context, "handoff_problem", h.workstreamId, id, { problem, status: h.status, revision: h.revision, runId: h.runId })
    })
  }
  getConversation(ref: ConversationRef): Conversation | null { this.guard(); qualified(ref); const row = this.row("SELECT * FROM conversations WHERE harness=? AND authority_id=? AND native_id=?", ref.harness, ref.authorityId, ref.nativeId); return row ? this.conversationDTO(row) : null }
  /** The append-only audit journal is also the durable branch reservation. No
   * existing identities or historical intervals are rewritten. */
  assertConversationWritable(ref: ConversationRef): void {
    this.guard()
    const c = this.conversationRow(ref)
    const event = this.row("SELECT operation,details FROM audit_events WHERE entity_id=? AND operation IN ('branch_reserved','branch_released','branch_completed') ORDER BY id DESC LIMIT 1", c.id)
    if (event && (event.operation === "branch_reserved" || event.operation === "branch_completed" && JSON.parse(event.details).replace)) fail("CONFLICT", event.operation === "branch_reserved" ? "Conversation is reserved by a pending branch operation." : "Conversation was replaced and is read-only.")
    if (c.parent_id) {
      const parent = this.row("SELECT operation FROM audit_events WHERE entity_id=? AND operation IN ('branch_reserved','branch_released','branch_completed') ORDER BY id DESC LIMIT 1", c.parent_id)
      if (parent?.operation === "branch_reserved") fail("CONFLICT", "Parent conversation has a pending branch reservation.")
    }
  }
  branchState(ref: ConversationRef) {
    this.guard(); const c = this.conversationRow(ref)
    const membership = this.row("SELECT * FROM memberships WHERE conversation_id=? AND ended_at IS NULL", c.id)
    const phases = membership ? this.rows("SELECT phase FROM phase_assignments WHERE membership_id=? AND ended_at IS NULL ORDER BY phase", membership.id).map(a => a.phase as Phase) : []
    return { workstreamId: membership?.workstream_id as string | undefined, phases }
  }
  branchCompleted(ref: ConversationRef, operationId: string): boolean {
    this.guard(); const c = this.conversationRow(ref)
    return !!this.row("SELECT 1 FROM audit_events WHERE entity_id=? AND operation='branch_completed' AND correlation_id=?", c.id, operationId)
  }
  reserveBranch(ref: ConversationRef, operationId: string, replace: boolean, context: MutationContext): void {
    text(operationId, "branch operation ID")
    if (typeof replace !== "boolean") fail("INVALID_INPUT", "Replace must be boolean.")
    this.transaction(context, () => {
      if (context.actor.kind !== "system") fail("INVALID_CONTEXT", "Branch operations require the App execution owner.")
      const c = this.conversationRow(ref)
      const previous = this.row("SELECT details FROM audit_events WHERE operation='branch_reserved' AND entity_id=? AND correlation_id=?", c.id, operationId)
      if (previous) { if (JSON.parse(previous.details).replace !== replace) fail("CONFLICT", "Branch intent changed."); return }
      this.assertConversationWritable(ref)
      const state = this.branchState(ref)
      if (state.phases.length && !replace) fail("CONFLICT", "Phase-assigned conversations require Replace original.")
      if (this.listHandoffs().some(h => !["completed", "failed"].includes(h.status) && (h.sender.nativeId === ref.nativeId && h.sender.authorityId === ref.authorityId || h.recipient.ref?.nativeId === ref.nativeId && h.recipient.ref.authorityId === ref.authorityId))) fail("CONFLICT", "Conversation has an outstanding handoff.")
      this.event({ ...context, correlationId: operationId }, "branch_reserved", state.workstreamId ?? null, c.id, { replace, ...state })
    })
  }
  finishBranch(source: ConversationRef, destination: ConversationRef | null, operationId: string, context: MutationContext): void {
    text(operationId, "branch operation ID")
    this.transaction(context, () => {
      if (context.actor.kind !== "system") fail("INVALID_CONTEXT", "Branch operations require the App execution owner.")
      const c = this.conversationRow(source)
      // The App journal is published before acquiring the domain reservation.
      // A crash/rejection in that gap needs no domain rollback.
      if (!destination && !this.row("SELECT 1 FROM audit_events WHERE entity_id=? AND operation='branch_reserved' AND correlation_id=?", c.id, operationId)) return
      const last = this.row("SELECT operation,correlation_id,details FROM audit_events WHERE entity_id=? AND operation IN ('branch_reserved','branch_released','branch_completed') ORDER BY id DESC LIMIT 1", c.id)
      if (!last || last.correlation_id !== operationId) fail("CONFLICT", "Branch reservation changed.")
      if (last.operation !== "branch_reserved") {
        if (last.operation === (destination ? "branch_completed" : "branch_released")) return
        fail("CONFLICT", "Branch already settled differently.")
      }
      const intent = JSON.parse(last.details), time = now()
      if (destination) {
        const target = this.conversationRow(destination)
        if (target.id === c.id || target.execution_pin_id !== c.execution_pin_id || target.harness !== c.harness || target.authority_id !== c.authority_id) fail("CONFLICT", "Branch destination must have a distinct native identity in the same checkout and authority.")
        const old = this.row("SELECT * FROM memberships WHERE conversation_id=? AND ended_at IS NULL", c.id)
        let membership = this.row("SELECT * FROM memberships WHERE conversation_id=? AND ended_at IS NULL", target.id)
        if (membership && membership.workstream_id !== old?.workstream_id) fail("CONFLICT", "Destination membership differs.")
        if (old && !membership) { const key = randomUUID(); this.run("INSERT INTO memberships VALUES(?,?,?,?,NULL)", key, target.id, old.workstream_id, time); membership = { id: key } }
        if (old && intent.replace) {
          const phases = this.rows("SELECT phase FROM phase_assignments WHERE membership_id=? AND ended_at IS NULL", old.id).map(a => canonicalSlot(a.phase))
          const existing = this.rows("SELECT phase FROM phase_assignments WHERE membership_id=? AND ended_at IS NULL", membership.id).map(a => canonicalSlot(a.phase))
          if (new Set(phases).size !== phases.length || phases.some(phase => existing.includes(phase))) fail("CONFLICT", "Branch destination has a conflicting equivalent active assignment; no history was replaced.")
          this.run("UPDATE phase_assignments SET ended_at=? WHERE membership_id=? AND ended_at IS NULL", time, old.id)
          this.run("UPDATE memberships SET ended_at=? WHERE id=?", time, old.id)
          for (const phase of phases) this.run("INSERT INTO phase_assignments VALUES(?,?,?,?,NULL)", randomUUID(), membership.id, phase, time)
        }
        if (old) this.touch(old.workstream_id)
      }
      this.event({ ...context, correlationId: operationId }, destination ? "branch_completed" : "branch_released", intent.workstreamId ?? null, c.id, { ...intent, destination })
    })
  }
  registerConversation(input: RegisterConversationInput, context: MutationContext): Conversation {
    qualified(input.ref); if (input.parent) qualified(input.parent)
    const checkout = this.validateExecutionCheckout(input.executionCheckout)
    this.transaction(context, () => {
      if (!this.row("SELECT 1 FROM native_authorities WHERE harness=? AND authority_id=?", input.ref.harness, input.ref.authorityId)) fail("INVALID_CONTEXT", "Declare the canonical native source before registration.")
      const parent = input.parent ? this.conversationRow(input.parent) : null
      const old = this.row("SELECT * FROM conversations WHERE harness=? AND authority_id=? AND native_id=?", input.ref.harness, input.ref.authorityId, input.ref.nativeId)
      if (old) { if (!samePin(this.readPin(old.execution_pin_id)!, checkout) || old.parent_id !== (parent?.id ?? null)) fail("CONFLICT", "Conversation checkout and parent are immutable."); return }
      const key = randomUUID(), time = now()
      this.run("INSERT INTO conversations VALUES(?,?,?,?,?,?,?)", key, input.ref.harness, input.ref.authorityId, input.ref.nativeId, this.pin(checkout), parent?.id ?? null, time)
      const inherited = parent ? this.row("SELECT workstream_id FROM memberships WHERE conversation_id=? AND ended_at IS NULL", parent.id) : null
      if (inherited) { this.run("INSERT INTO memberships VALUES(?,?,?,?,NULL)", randomUUID(), key, inherited.workstream_id, time); this.touch(inherited.workstream_id) }
      this.event(context, "conversation_registered", inherited?.workstream_id ?? null, key, { ref: input.ref, parent: input.parent ?? null, inheritedMembership: inherited?.workstream_id ?? null })
    })
    return this.getConversation(input.ref)!
  }
  associateConversation(ref: ConversationRef, workstreamId: string | null, context: MutationContext): Conversation {
    this.transaction(context, () => {
      this.assertConversationWritable(ref)
      const c = this.conversationRow(ref)
      if (workstreamId !== null) this.revision(workstreamId, context)
      const old = this.row("SELECT * FROM memberships WHERE conversation_id=? AND ended_at IS NULL", c.id)
      // A non-null target's revision governs reassociation; unassignment is
      // governed by the currently associated workstream being ended.
      if (workstreamId === null && old) this.revision(old.workstream_id, context)
      if (workstreamId === null && !old && context.expectedRevision !== undefined) fail("CONFLICT", "No current membership exists for the supplied revision.")
      if ((old?.workstream_id ?? null) === workstreamId) return
      const time = now()
      if (old) {
        this.run("UPDATE phase_assignments SET ended_at=? WHERE membership_id=? AND ended_at IS NULL", time, old.id)
        this.run("UPDATE memberships SET ended_at=? WHERE id=?", time, old.id); this.touch(old.workstream_id)
      }
      const membershipId = workstreamId === null ? null : randomUUID()
      if (membershipId) { this.run("INSERT INTO memberships VALUES(?,?,?,?,NULL)", membershipId, c.id, workstreamId!, time); this.touch(workstreamId!) }
      this.event(context, "conversation_associated", workstreamId ?? old?.workstream_id ?? null, c.id, { from: old?.workstream_id ?? null, to: workstreamId, membershipId })
    })
    return this.getConversation(ref)!
  }
  resolveContext(ref: ConversationRef): InvocationContext {
    this.guard(); const c = this.conversationDTO(this.conversationRow(ref))
    const checkout = revalidateCheckout(this.context, c.executionCheckout)
    const workstream = c.workstreamId ? this.getWorkstream(c.workstreamId) : null
    return { repositoryId: this.repositoryId, conversation: c, workstream, executionCheckout: checkout.path, primaryCheckout: this.primaryCheckout, artifactsRoot: workstream ? join(this.stateRoot, "workstreams", workstream.id) : null }
  }
  resolveInvocation(ref: ConversationRef): InvocationContext { return this.resolveContext(ref) }
  private assignments(workstreamId: string): PhaseAssignment[] {
    return this.rows("SELECT a.*,m.workstream_id,c.harness,c.authority_id,c.native_id FROM phase_assignments a JOIN memberships m ON m.id=a.membership_id JOIN conversations c ON c.id=m.conversation_id WHERE m.workstream_id=? ORDER BY a.started_at,a.id", workstreamId).map(a => ({ id: a.id, membershipId: a.membership_id, ref: this.reference(a), workstreamId: a.workstream_id, phase: a.phase, startedAt: a.started_at, endedAt: a.ended_at }))
  }
  assignPhase(ref: ConversationRef, phase: Phase, context: MutationContext): PhaseAssignment {
    phaseName(phase)
    phase = canonicalSlot(phase)
    return this.transaction(context, () => {
      this.assertConversationWritable(ref)
      const c = this.conversationRow(ref), membership = this.row("SELECT * FROM memberships WHERE conversation_id=? AND ended_at IS NULL", c.id)
      if (!membership) fail("CONFLICT", "Associate the conversation before assigning a phase.")
      this.revision(membership.workstream_id, context)
      const old = this.assignments(membership.workstream_id).filter(a => a.membershipId === membership.id && equivalentSlots(a.phase, phase) && a.endedAt === null)
      if (old.length > 1) fail("CONFLICT", "Membership has conflicting equivalent active assignments; no history was selected.")
      if (old.length) return old[0]!
      const assignment: PhaseAssignment = { id: randomUUID(), membershipId: membership.id, ref, workstreamId: membership.workstream_id, phase, startedAt: now(), endedAt: null }
      this.run("INSERT INTO phase_assignments VALUES(?,?,?,?,NULL)", assignment.id, membership.id, phase, assignment.startedAt)
      this.touch(membership.workstream_id); this.event(context, "phase_assigned", membership.workstream_id, assignment.id, { ref, phase })
      return assignment
    })
  }
  endAssignment(assignmentId: string, context: MutationContext): void {
    text(assignmentId, "assignmentId")
    this.transaction(context, () => {
      const row = this.row("SELECT a.*,m.workstream_id FROM phase_assignments a JOIN memberships m ON m.id=a.membership_id WHERE a.id=?", assignmentId) ?? fail("NOT_FOUND", "Unknown phase assignment.")
      const member = this.row("SELECT c.* FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE m.id=?", row.membership_id)
      this.assertConversationWritable(this.reference(member))
      this.revision(row.workstream_id, context)
      if (row.ended_at !== null) return
      this.run("UPDATE phase_assignments SET ended_at=? WHERE id=?", now(), assignmentId); this.touch(row.workstream_id)
      this.event(context, "phase_assignment_ended", row.workstream_id, assignmentId, { phase: row.phase })
    })
  }
  resolvePhaseTarget(workstreamId: string, phase: Phase, explicit?: ConversationRef): Conversation {
    this.guard(); phaseName(phase); this.workstreamRow(workstreamId); if (explicit !== undefined) qualified(explicit)
    const eligible = this.assignments(workstreamId).filter(a => a.endedAt === null && equivalentSlots(a.phase, phase) && (!explicit || (a.ref.harness === explicit.harness && a.ref.authorityId === explicit.authorityId && a.ref.nativeId === explicit.nativeId)) && this.getConversation(a.ref)?.workstreamId === workstreamId)
    const targets = [...new Map(eligible.map(a => [JSON.stringify([a.ref.harness, a.ref.authorityId, a.ref.nativeId]), a])).values()]
    if (targets.length > 1) fail("AMBIGUOUS_TARGET", "Several eligible conversations; supply an explicit qualified reference.")
    if (!targets.length) fail("NOT_FOUND", "No eligible conversation in this phase.")
    this.assertConversationWritable(targets[0]!.ref)
    return this.getConversation(targets[0]!.ref)!
  }
  getWorkstreamStatus(workstreamId: string): WorkstreamStatus {
    const workstream = this.getWorkstream(workstreamId), phases = this.assignments(workstreamId)
    return { workstream, conversations: this.listConversations().filter(c => c.workstreamId === workstreamId), activePhases: phases.filter(p => p.endedAt === null), phaseHistory: phases.filter(p => p.endedAt !== null) }
  }
  getLifecycleStatus(workstreamId: string) { const w = this.getWorkstream(workstreamId); return { workstreamId, type: w.type, incomplete: false, lifecycle: w.lifecycle } }
  getApprovalHistory(workstreamId: string) {
    this.guard(); this.workstreamRow(workstreamId)
    return this.rows("SELECT * FROM approvals WHERE workstream_id=? ORDER BY created_at,id", workstreamId).map(a => ({ id: a.id as string, workstreamId, phase: a.phase as (typeof LIFECYCLE_PHASES)[number], userReference: a.user_reference as string, hashVersion: a.hash_version as number, snapshotHash: a.snapshot_hash as string, createdAt: a.created_at as string, actorEventId: a.actor_event_id as number, gitCommit: a.git_commit as string | null, files: this.rows("SELECT relative_path,content_hash FROM approval_files WHERE approval_id=? ORDER BY relative_path", a.id).map(f => ({ path: f.relative_path as string, hash: f.content_hash as string })) }))
  }
  getStatus(workstreamId: string) { return { ...this.getWorkstreamStatus(workstreamId), research: this.getResearchIndex(workstreamId), audit: this.readAudit(workstreamId), unresolvedArtifactOperations: this.unresolvedArtifactOperations(workstreamId) } }
  getOverview() { return { repositoryId: this.repositoryId, workstreams: this.listWorkstreams(), conversations: this.listConversations(), unresolvedArtifactOperations: this.unresolvedArtifactOperations(), capabilities: { lifecycle: true, research: true, nativeHandoff: false, archive: false, merge: false } } }
  selectWorkstream(workstreamId: string | null, context: MutationContext): void {
    if (context?.actor?.kind === "native") fail("INVALID_CONTEXT", "Native callers never mutate human selection.")
    this.transaction(context, () => { if (workstreamId !== null) this.workstreamRow(workstreamId); this.run("UPDATE cli_preferences SET selected_workstream_id=? WHERE id=1", workstreamId); this.event(context, "human_selection_changed", workstreamId) })
  }
  getSelectedWorkstream(): Workstream | null { this.guard(); const row = this.row("SELECT selected_workstream_id FROM cli_preferences WHERE id=1"); return row.selected_workstream_id ? this.getWorkstream(row.selected_workstream_id) : null }
  readAudit(workstreamId?: string): AuditEvent[] {
    this.guard(); if (workstreamId !== undefined) id(workstreamId)
    return this.auditRows(workstreamId)
  }
  private auditRows(workstreamId?: string): AuditEvent[] {
    return this.rows(`SELECT a.*,c.harness,c.authority_id,c.native_id FROM audit_events a LEFT JOIN conversations c ON c.id=a.actor_conversation_id ${workstreamId === undefined ? "" : "WHERE a.workstream_id=? OR (a.operation='conversation_associated' AND json_extract(a.details,'$.from')=?)"} ORDER BY a.id`, ...(workstreamId === undefined ? [] : [workstreamId, workstreamId])).map(a => ({ id: a.id, correlationId: a.correlation_id, actor: a.actor_kind === "native" ? { kind: "native", repositoryId: this.repositoryId, ref: this.reference(a) } : { kind: a.actor_kind }, operation: a.operation, workstreamId: a.workstream_id, entityId: a.entity_id, details: JSON.parse(a.details), timestamp: a.timestamp }))
  }
  unresolvedArtifactOperations(workstreamId?: string): AuditEvent[] {
    const events = this.readAudit(workstreamId)
    return events.filter(e => e.operation === "artifact_operation_started" && !events.some(end => end.entityId === e.entityId && end.operation === "artifact_operation_completed"))
  }
  private filesystem(workstreamId: string): { root: string; fs: ConfinedLifecycleFileSystem } {
    this.guard(); this.workstreamRow(workstreamId)
    const root = join(this.stateRoot, "workstreams", workstreamId)
    try { return { root, fs: new ConfinedLifecycleFileSystem(root, [DEFAULT_TEMPLATE_ROOT]) } } catch (error) { return artifactError(error) }
  }
  listArtifacts(workstreamId: string): string[] {
    const { root, fs } = this.filesystem(workstreamId), result: string[] = []
    const visit = (path: string) => { for (const name of fs.listNames(join(root, path))) { const relative = path ? `${path}/${name}` : name; if (fs.stat(join(root, relative)).isDirectory()) visit(relative); else if (name.endsWith(".md")) result.push(relative) } }
    try { visit(""); return result.sort() } catch (error) { return artifactError(error) }
  }
  readArtifact(workstreamId: string, path: string): string {
    artifactRelative(path); const { root, fs } = this.filesystem(workstreamId)
    try { return fs.readText(join(root, path)) } catch (error) { return artifactError(error) }
  }
  /** Hash and decode the very same confined read, never a second file read. */
  readArtifactSnapshot(workstreamId: string, path: string): { content: string; revision: string } {
    artifactRelative(path); const { root, fs } = this.filesystem(workstreamId)
    try { const bytes = fs.readBytes(join(root, path)); return { content: bytes.toString("utf8"), revision: hash(bytes) } } catch (error) { return artifactError(error) }
  }
  getDocumentCatalog(workstreamId: string): WorkstreamDocumentCatalog {
    const { root, fs } = this.filesystem(workstreamId), workstream = this.workstreamRow(workstreamId)
    const paths: string[] = [], revisions = new Map<string, string>()
    let plan: string | null = null
    const visit = (directory: string) => {
      for (const name of fs.listNames(join(root, directory)).sort()) {
        const path = directory ? `${directory}/${name}` : name
        if (fs.stat(join(root, path)).isDirectory()) visit(path)
        else if (name.endsWith(".md")) {
          artifactRelative(path)
          // Exactly one byte read per present document, including the Plan.
          // Titles are path-derived so large resources need no extra text reads.
          const bytes = fs.readBytes(join(root, path))
          paths.push(path); revisions.set(path, hash(bytes))
          if (path === "execution/PLAN.md") plan = bytes.toString("utf8")
        }
      }
    }
    try {
      visit("")
      const descriptors = documentDescriptors({ type: workstream.type, paths, jobs: this.jobs(workstreamId), researchPaths: this.rows("SELECT report_path FROM research_reports WHERE workstream_id=? ORDER BY topic", workstreamId).map(row => row.report_path as string), plan })
      const documents = descriptors.map(descriptor => {
        artifactRelative(descriptor.path)
        const revision = revisions.get(descriptor.path)
        if (revision !== undefined) return { ...descriptor, exists: true, revision }
        // Only a genuinely absent known file is missing; directories, unsafe
        // access and storage failures must not masquerade as missing documents.
        try {
          if (!fs.stat(join(root, descriptor.path)).isFile()) throw new LifecycleAccessError(`Expected a document file: ${descriptor.path}`)
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...descriptor, exists: false, revision: null }
          throw error
        }
        return fail("CONFLICT", `Document appeared while cataloging: ${descriptor.path}; refresh the catalog.`)
      })
      fs.assertTree(); this.guard()
      return { repositoryId: this.repositoryId, workstreamId, documents }
    } catch (error) { return artifactError(error) }
  }
  private manifest(workstreamId: string): { path: string; hash: string }[] {
    const { root, fs } = this.filesystem(workstreamId), files: { path: string; hash: string }[] = []
    const visit = (path: string) => { for (const name of fs.listNames(join(root, path))) { const relative = path ? `${path}/${name}` : name; if (fs.stat(join(root, relative)).isDirectory()) visit(relative); else files.push({ path: relative, hash: hash(fs.readBytes(join(root, relative))) }) } }
    visit(""); return files.sort((a,b) => a.path.localeCompare(b.path))
  }
  writeArtifact(workstreamId: string, path: string, content: string, context: MutationContext): void {
    this.mutationContext(context); id(workstreamId); artifactRelative(path); if (typeof content !== "string") fail("INVALID_ARTIFACT", "Artifact content must be text.")
    const release = acquireArtifactLock(this.stateRoot, workstreamId), operationId = randomUUID()
    let started = false
    try {
      const { root, fs } = this.filesystem(workstreamId)
      this.transaction(context, () => { this.revision(workstreamId, context); this.event(context, "artifact_operation_started", workstreamId, operationId, { kind: "write", path }) }); started = true
      fs.mkdir(join(root, path, "..")); fs.writeBytes(join(root, path), Buffer.from(content), false)
      this.transaction(context, () => { this.touch(workstreamId); this.event(context, "artifact_operation_completed", workstreamId, operationId, { manifest: [{ path, hash: hash(content) }] }) })
    } catch (error) {
      if (started) { try { this.transaction(context, () => this.event(context, "artifact_operation_failed", workstreamId, operationId, { partial: true, error: String(error).slice(0,2000) })) } catch {} }
      artifactError(error)
    } finally { release() }
  }
  private lifecycleContext(workstreamId: string) {
    const workstream = this.getWorkstream(workstreamId), { root, fs } = this.filesystem(workstreamId)
    try { if (inspectBootstrappedWorkstream(root, ((path: string) => fs.stat(path)) as typeof lstatSync) !== workstream.type) fail("INVALID_ARTIFACT", "Typed root does not match workstream type.") } catch (error) { return artifactError(error) }
    return { workstream, root, fs }
  }
  async providePhase(workstreamId: string, requestedPhase: string, options: { refreshTemplates?: boolean }, context: MutationContext) {
    this.mutationContext(context); id(workstreamId); const phase = lifecyclePhase(requestedPhase)
    if (options.refreshTemplates !== undefined && typeof options.refreshTemplates !== "boolean") fail("INVALID_INPUT", "refreshTemplates must be boolean.")
    const release = acquireArtifactLock(this.stateRoot, workstreamId), operationId = randomUUID(); let started = false
    try {
      const { workstream, root, fs } = this.lifecycleContext(workstreamId)
      this.transaction(context, () => { this.revision(workstreamId, context); this.event(context, "artifact_operation_started", workstreamId, operationId, { kind: "provide", phase }) }); started = true
      const result = await provision(root, workstream.type, phase, options.refreshTemplates ?? false, fs)
      fs.assertTree(); const manifest = this.manifest(workstreamId)
      this.transaction(context, () => { this.touch(workstreamId); this.event(context, "artifact_operation_completed", workstreamId, operationId, { manifest }) })
      return { workstreamId, phase, ...result }
    } catch (error) {
      if (started) { try { this.transaction(context, () => this.event(context, "artifact_operation_failed", workstreamId, operationId, { partial: true, error: String(error).slice(0,2000) })) } catch {} }
      return artifactError(error)
    } finally { release() }
  }
  provideWorkstream(workstreamId: string, phase: string, refreshTemplates: boolean, context: MutationContext) { return this.providePhase(workstreamId, phase, { refreshTemplates }, context) }
  async validatePhase(workstreamId: string, requestedPhase: string, options: { reportId?: string; completingJobs?: boolean } = {}) {
    const phase = lifecyclePhase(requestedPhase)
    if (options.reportId !== undefined && (phase !== "execution" || typeof options.reportId !== "string" || !options.reportId.trim())) fail("INVALID_INPUT", "Scoped report validation requires Execution and a job ID.")
    const { workstream, root, fs } = this.lifecycleContext(workstreamId), before = this.manifest(workstreamId)
    try {
      const result = await validatePhaseDocs({ jobs: workstream.lifecycle.jobs, approval: workstream.lifecycle.approvals.find(a => a.phase === phase) ?? null, researchWarnings: async () => this.getResearchIndex(workstreamId).warnings }, { repoRoot: this.primaryCheckout, user: "local", workstreamId }, root, phase, workstream.type, options, fs)
      fs.assertTree()
      const manifest = this.manifest(workstreamId)
      if (result.captureHashes.some(capture => manifest.find(file => file.path === capture.path)?.hash !== capture.hash)) fail("CONFLICT", "Validated capture bytes differ from final artifact evidence.")
      if (JSON.stringify(before) !== JSON.stringify(manifest) || this.getWorkstream(workstreamId).revision !== workstream.revision) fail("CONFLICT", "Artifacts or state changed during validation.")
      return { ...result, revision: workstream.revision, manifest, fileHashes: result.files.map(path => ({ path, hash: manifest.find(f => f.path === path)!.hash })) }
    } catch (error) { return artifactError(error) }
  }
  validateWorkstream(workstreamId: string, phase: string, options: { reportId?: string; completingJobs?: boolean } = {}) { return this.validatePhase(workstreamId, phase, options) }
  private registerValidatedJobs(workstreamId: string, files: string[], approvalId: string): LifecycleJob[] {
    return registerPlannedJobs(this.jobs(workstreamId), files, spec => {
      const job: LifecycleJob = { job_id: spec.jobId, spec_path: spec.specPath, report_path: null, status: "planned", updated_at: now() }
      this.run("INSERT INTO jobs(workstream_id,job_id,spec_path,status,updated_at,planning_approval_id) VALUES(?,?,?,?,?,?)", workstreamId, job.job_id, job.spec_path, job.status, job.updated_at, approvalId)
      return job
    })
  }
  async approvePhase(workstreamId: string, requestedPhase: string, userReference: string, context: MutationContext) {
    this.mutationContext(context); id(workstreamId); text(userReference, "userReference"); const phase = lifecyclePhase(requestedPhase)
    const release = acquireArtifactLock(this.stateRoot, workstreamId)
    try {
      const validation = await this.validatePhase(workstreamId, phase, { completingJobs: phase === "execution" })
      if (!validation.ok) fail("CONFLICT", `Cannot approve ${phase}:\n${validation.problems.join("\n")}`)
      // Synchronous final recheck after async validation, immediately before BEGIN.
      if (JSON.stringify(validation.manifest) !== JSON.stringify(this.manifest(workstreamId))) fail("CONFLICT", "Artifact manifest changed before approval.")
      return this.transaction(context, () => {
        this.revision(workstreamId, context, validation.revision)
        const approvalId = randomUUID(), timestamp = now()
        const event = this.event(context, "phase_approved", workstreamId, approvalId, { phase, userReference, snapshotHash: validation.hash })
        this.run("INSERT INTO approvals VALUES(?,?,?,?,1,?,?,?,NULL)", approvalId, workstreamId, phase, userReference, validation.hash, timestamp, event)
        for (const file of validation.fileHashes) this.run("INSERT INTO approval_files VALUES(?,?,?)", approvalId, file.path, file.hash)
        let jobs: LifecycleJob[] = []
        if (phase === "planning") jobs = this.registerValidatedJobs(workstreamId, validation.files, approvalId)
        if (phase === "execution") { this.run("UPDATE jobs SET status='completed',revision=revision+1,updated_at=? WHERE workstream_id=? AND status!='completed'", timestamp, workstreamId); jobs = this.jobs(workstreamId) }
        this.run("UPDATE phase_states SET status='approved',current_approval_id=?,revision=revision+1 WHERE workstream_id=? AND phase=?", approvalId, workstreamId, phase)
        this.touch(workstreamId)
        return { workstreamId, id: approvalId, phase, files: validation.files, sane_hash: validation.hash, approval_ref: userReference, approved_at: timestamp, jobs, warnings: validation.warnings }
      })
    } finally { release() }
  }
  approveWorkstream(workstreamId: string, phase: string, reference: string, context: MutationContext) { return this.approvePhase(workstreamId, phase, reference, context) }
  async registerJobs(workstreamId: string, context: MutationContext) {
    this.mutationContext(context); id(workstreamId); const release = acquireArtifactLock(this.stateRoot, workstreamId)
    try {
      const approved = this.row("SELECT current_approval_id FROM phase_states WHERE workstream_id=? AND phase='planning'", workstreamId)?.current_approval_id
      if (!approved) fail("CONFLICT", "Cannot register jobs without existing Planning approval.")
      const validation = await this.validatePhase(workstreamId, "planning")
      if (!validation.ok) fail("CONFLICT", validation.problems.join("\n"))
      if (JSON.stringify(validation.manifest) !== JSON.stringify(this.manifest(workstreamId))) fail("CONFLICT", "Artifacts changed before job registration.")
      return this.transaction(context, () => { this.revision(workstreamId, context, validation.revision); const jobs = this.registerValidatedJobs(workstreamId, validation.files, approved); this.touch(workstreamId); this.event(context, "jobs_registered", workstreamId, approved, { jobs: jobs.map(j => j.job_id) }); return { jobs, warnings: validation.warnings } })
    } finally { release() }
  }
  registerWorkstreamJobs(workstreamId: string, context: MutationContext) { return this.registerJobs(workstreamId, context) }
  updateJob(workstreamId: string, jobId: string, status: string, context: MutationContext) {
    text(jobId, "jobId"); if (status !== "running" && status !== "completed") fail("INVALID_INPUT", "Expected job status running or completed.")
    return this.transaction(context, () => {
      this.revision(workstreamId, context); const job = this.row("SELECT * FROM jobs WHERE workstream_id=? AND job_id=?", workstreamId, jobId) ?? fail("NOT_FOUND", `Job not found: ${jobId}`)
      try { assertJobProgress(jobId, job.status, status) } catch (error) { fail("CONFLICT", (error as Error).message) }
      const changed = job.status !== status
      if (changed) { this.run("UPDATE jobs SET status=?,revision=revision+1,updated_at=? WHERE workstream_id=? AND job_id=?", status, now(), workstreamId, jobId); this.touch(workstreamId); this.event(context, "job_progressed", workstreamId, jobId, { from: job.status, to: status }) }
      return { workstreamId, jobId, status, changed }
    })
  }
  updateWorkstreamJob(workstreamId: string, jobId: string, status: string, context: MutationContext) { return this.updateJob(workstreamId, jobId, status, context) }
  setJobReportPath(workstreamId: string, jobId: string, path: string | null, context: MutationContext): void {
    if (path !== null) artifactRelative(path)
    this.transaction(context, () => { this.revision(workstreamId, context); if (!this.row("SELECT 1 FROM jobs WHERE workstream_id=? AND job_id=?", workstreamId, jobId)) fail("NOT_FOUND", "Unknown job."); this.run("UPDATE jobs SET report_path=?,revision=revision+1,updated_at=? WHERE workstream_id=? AND job_id=?", path, now(), workstreamId, jobId); this.touch(workstreamId); this.event(context, "job_report_assigned", workstreamId, jobId, { path }) })
  }
  getJobContext(workstreamId: string, jobId: string, caller: ConversationRef | null = null) {
    text(jobId, "jobId"); const { root, fs, workstream } = this.lifecycleContext(workstreamId)
    const job = workstream.lifecycle.jobs.find(j => j.job_id === jobId) ?? fail("NOT_FOUND", `Job not found: ${jobId}`)
    let executionCheckout: string | null = null
    if (caller) { const invocation = this.resolveContext(caller); if (invocation.workstream?.id !== workstreamId) fail("INVALID_CONTEXT", "Caller is not associated with this workstream."); executionCheckout = invocation.executionCheckout }
    else if (workstream.defaultCheckout) executionCheckout = revalidateCheckout(this.context, workstream.defaultCheckout).path
    const specPath = join(root, job.spec_path), reportPath = join(root, job.report_path ?? `execution/reports/${basename(job.spec_path)}`), reportTemplate = join(root, "resources/EXECUTION_REPORT_TEMPLATE.md")
    const present = (path: string) => { try { return fs.stat(path).isFile() } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return artifactError(error) } }
    return { workstreamId, workstreamRoot: root, executionCheckout, job: { jobId, status: job.status, specPath, specExists: present(specPath), reportPath, reportExists: present(reportPath) }, reportTemplate, reportTemplateExists: present(reportTemplate) }
  }
  getWorkstreamJob(workstreamId: string, jobId: string, caller?: ConversationRef) { return this.getJobContext(workstreamId, jobId, caller ?? null) }
  registerResearch(workstreamId: string, topic: string, reportPath: string, context: MutationContext) {
    this.mutationContext(context); id(workstreamId); id(topic); artifactRelative(reportPath)
    if (!reportPath.startsWith("research/")) fail("INVALID_ARTIFACT", "Research reports must be inside research/.")
    const release = acquireArtifactLock(this.stateRoot, workstreamId)
    try {
      const contentHash = hash(this.readArtifact(workstreamId, reportPath)), timestamp = now()
      this.transaction(context, () => {
        this.revision(workstreamId, context); const event = this.event(context, "research_registered", workstreamId, topic, { reportPath, contentHash })
        this.run("INSERT INTO research_reports VALUES(?,?,?,?,?,?,?) ON CONFLICT(workstream_id,topic) DO UPDATE SET report_path=excluded.report_path,content_hash=excluded.content_hash,updated_at=excluded.updated_at,actor_event_id=excluded.actor_event_id", workstreamId, topic, reportPath, contentHash, timestamp, timestamp, event)
        this.touch(workstreamId)
      })
      return this.getResearchIndex(workstreamId)
    } finally { release() }
  }
  unregisterResearch(workstreamId: string, topic: string, context: MutationContext): void {
    id(topic)
    this.transaction(context, () => { this.revision(workstreamId, context); const old = this.row("SELECT * FROM research_reports WHERE workstream_id=? AND topic=?", workstreamId, topic) ?? fail("NOT_FOUND", "Unknown research topic."); this.run("DELETE FROM research_reports WHERE workstream_id=? AND topic=?", workstreamId, topic); this.touch(workstreamId); this.event(context, "research_unregistered", workstreamId, topic, { reportPath: old.report_path, contentHash: old.content_hash }) })
  }
  getResearchIndex(workstreamId: string) {
    this.guard(); this.workstreamRow(workstreamId)
    const files = this.listArtifacts(workstreamId).filter(p => p.startsWith("research/")), warnings: string[] = []
    const registered = this.rows("SELECT * FROM research_reports WHERE workstream_id=? ORDER BY topic", workstreamId).map(r => {
      const missing = !files.includes(r.report_path), modified = !missing && hash(this.readArtifact(workstreamId, r.report_path)) !== r.content_hash
      if (missing || modified) warnings.push(`Research ${r.topic}: ${missing ? "missing" : "modified"} registered report ${r.report_path}`)
      return { topic: r.topic as string, reportPath: r.report_path as string, contentHash: r.content_hash as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string, missing, modified }
    })
    const unregistered = files.filter(p => !registered.some(r => r.reportPath === p)); for (const p of unregistered) warnings.push(`Unregistered research report: ${p}`)
    return { registered, unregistered, warnings }
  }
}
export function openRepositoryDomain(context: RepositoryContext): RepositoryDomain { return RepositoryDomain.open(context) }
