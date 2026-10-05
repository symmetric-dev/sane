import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DomainError } from "../src/server.ts"
import type { DomainErrorCode } from "../src/contracts.ts"
import * as repository from "../src/repository.ts"
import * as schema from "../src/schema-upgrade.ts"
import { fixture, mutation } from "./fixtures.ts"

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup(linked = false) { const f = fixture(linked); cleanups.push(f.cleanup); return f }
function code(action: () => unknown, expected: DomainErrorCode) { try { action(); throw new Error("Expected failure") } catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(expected) } }
function clock(time = Date.now() + 60_000) { const spy = spyOn(Date, "now").mockReturnValue(time); cleanups.push(() => spy.mockRestore()); return spy }
function validationSpies() {
  const checkout = spyOn(repository, "checkDiscovery"), store = spyOn(repository, "safeStoreFiles"), sqlite = spyOn(schema, "assertSchemaCapabilities")
  cleanups.push(() => { checkout.mockRestore(); store.mockRestore(); sqlite.mockRestore() })
  return { checkout, store, sqlite, clear: () => { checkout.mockClear(); store.mockClear(); sqlite.mockClear() } }
}
function warm(f: ReturnType<typeof setup>) { clock(); f.domain.listWorkstreams() }

test("settled reads reuse Git and SQLite validation across read APIs", () => {
  const f = setup(), { domain, repo, ref } = f
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  domain.registerConversation({ ref: ref("a"), executionCheckout: repo }, mutation)
  domain.associateConversation(ref("a"), "alpha", mutation)
  warm(f)
  const spies = validationSpies()
  for (let i = 0; i < 3; i++) {
    expect(domain.listWorkstreams()).toHaveLength(1)
    expect(domain.getWorkstream("alpha").id).toBe("alpha")
    expect(domain.listConversations()).toHaveLength(1)
    expect(domain.getConversation(ref("a"))!.workstreamId).toBe("alpha")
    expect(domain.getWorkstreamStatus("alpha").conversations).toHaveLength(1)
    expect(domain.getStatus("alpha").workstream.id).toBe("alpha")
    expect(domain.listStatuses()).toHaveLength(1)
    expect(domain.getResearchIndex("alpha").registered).toEqual([])
    expect(domain.readAudit("alpha").length).toBeGreaterThan(0)
    expect(domain.listArtifacts("alpha")).toContain("PRD.md")
    expect(domain.readArtifact("alpha", "PRD.md")).toBeTruthy()
    expect(domain.getApprovalHistory("alpha")).toEqual([])
    expect(domain.listHandoffs()).toEqual([])
    expect(domain.findHandoff(ref("a"), "absent")).toBeNull()
  }
  expect(spies.checkout).not.toHaveBeenCalled()
  expect(spies.store).not.toHaveBeenCalled()
  expect(spies.sqlite).not.toHaveBeenCalled()
})

test("recent evidence cannot reuse validation until the freshness window settles", () => {
  const f = setup(), { domain, context } = f
  const recent = Math.ceil(Math.max(statSync(context.databasePath).ctimeMs, statSync(join(context.commonDir, "HEAD")).ctimeMs)) + 1000
  const time = clock(recent), spies = validationSpies()
  expect(repository.repositoryEvidence(context, "checkout")).not.toBe(repository.repositoryEvidence(context, "checkout"))
  expect(repository.repositoryEvidence(context, "store")).not.toBe(repository.repositoryEvidence(context, "store"))
  domain.listWorkstreams(); domain.listWorkstreams()
  expect(spies.checkout).toHaveBeenCalledTimes(2)
  expect(spies.store).toHaveBeenCalledTimes(2)
  expect(spies.sqlite).toHaveBeenCalledTimes(4)
  time.mockReturnValue(recent + 60_000)
  domain.listWorkstreams()
  spies.clear()
  domain.listWorkstreams(); domain.listConversations()
  expect(repository.repositoryEvidence(context, "checkout")).toBe(repository.repositoryEvidence(context, "checkout"))
  expect(repository.repositoryEvidence(context, "store")).toBe(repository.repositoryEvidence(context, "store"))
  expect(spies.checkout).not.toHaveBeenCalled()
  expect(spies.store).not.toHaveBeenCalled()
  expect(spies.sqlite).not.toHaveBeenCalled()
})

test("external SQLite writes invalidate store validation without repeating unchanged Git validation", () => {
  const f = setup(), { domain, context } = f
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  warm(f)
  const spies = validationSpies(), db = new Database(context.databasePath)
  try { db.query("UPDATE workstreams SET title=? WHERE id='alpha'").run("External title") } finally { db.close() }
  expect(domain.getWorkstream("alpha").title).toBe("External title")
  expect(spies.checkout).not.toHaveBeenCalled()
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  spies.clear()
  domain.getWorkstream("alpha")
  expect(spies.store).not.toHaveBeenCalled()
})

test("external metadata changes fail closed despite warm validation", () => {
  const f = setup(), { domain, context } = f
  warm(f)
  const db = new Database(context.databasePath)
  try {
    const trigger = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='store_metadata_immutable'").get()!
    db.transaction(() => { db.exec("DROP TRIGGER store_metadata_immutable"); db.query("UPDATE store_metadata SET repository_id=? WHERE id=1").run("changed"); db.exec(trigger.sql) }).immediate()
  } finally { db.close() }
  code(() => domain.listWorkstreams(), "STALE_BINDING")
  code(() => domain.listConversations(), "STALE_BINDING")
})

test("completion marker replacement invalidates evidence and corrupt changes clear cached validity", () => {
  const f = setup(), { domain, stateRoot } = f
  warm(f)
  const spies = validationSpies(), marker = join(stateRoot, "complete.json"), bytes = readFileSync(marker)
  renameSync(marker, marker + "-saved"); writeFileSync(marker, bytes)
  expect(domain.listWorkstreams()).toEqual([])
  expect(spies.checkout).not.toHaveBeenCalled()
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  writeFileSync(marker, JSON.stringify({ ...JSON.parse(bytes.toString()), repositoryId: "changed" }))
  code(() => domain.listWorkstreams(), "STALE_BINDING")
  code(() => domain.listWorkstreams(), "STALE_BINDING")
  writeFileSync(marker, bytes)
  spies.clear()
  expect(domain.listWorkstreams()).toEqual([])
  expect(spies.checkout).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
})

test.each(["upgrading.json", ".complete-upgrade.json"])("warm reads fail closed when %s appears", name => {
  const f = setup()
  warm(f)
  writeFileSync(join(f.stateRoot, name), "{}")
  code(() => f.domain.listWorkstreams(), "UNSUPPORTED_SCHEMA")
  code(() => f.domain.readAudit(), "UNSUPPORTED_SCHEMA")
})

test("warm reads reject a replaced database inode even when its bytes match", () => {
  const f = setup(), { domain, context } = f
  warm(f)
  renameSync(context.databasePath, context.databasePath + "-saved")
  copyFileSync(context.databasePath + "-saved", context.databasePath)
  code(() => domain.listWorkstreams(), "STALE_BINDING")
})

test.each(["directory symlink", "marker hardlink"])("warm store validation rejects %s", kind => {
  const f = setup(), { domain, stateRoot, temporary } = f
  warm(f)
  if (kind === "directory symlink") {
    const path = join(stateRoot, "workstreams")
    renameSync(path, path + "-saved"); symlinkSync(path + "-saved", path)
  } else linkSync(join(stateRoot, "complete.json"), join(temporary, "marker-link"))
  code(() => domain.listWorkstreams(), "CORRUPT_STORE")
})

test("Git evidence changes trigger a full read guard and a replaced primary Git directory fails closed", () => {
  const f = setup(), { domain, context } = f
  warm(f)
  const spies = validationSpies(), config = join(context.commonDir, "config")
  writeFileSync(config, readFileSync(config, "utf8") + "\n")
  domain.listWorkstreams()
  expect(spies.checkout).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  renameSync(context.commonDir, context.commonDir + "-saved")
  mkdirSync(context.commonDir)
  code(() => domain.listWorkstreams(), "INVALID_CHECKOUT")
})

test("mutations and explicit handle validation always perform the full guard with warm evidence", () => {
  const f = setup(), { domain } = f
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  warm(f)
  const spies = validationSpies()
  domain.validateHandle()
  expect(spies.checkout).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  spies.clear()
  domain.selectWorkstream("alpha", mutation)
  expect(spies.checkout).toHaveBeenCalledTimes(2)
  expect(spies.store).toHaveBeenCalledTimes(2)
  expect(spies.sqlite).toHaveBeenCalledTimes(4)
  expect(domain.getSelectedWorkstream()!.id).toBe("alpha")
  spies.clear()
  domain.listWorkstreams()
  spies.checkout.mockImplementation(() => { throw new DomainError("STALE_BINDING", "Changed binding during mutation") })
  code(() => domain.selectWorkstream(null, mutation), "STALE_BINDING")
  expect(spies.checkout).toHaveBeenCalledTimes(1)
})

test("bulk status and research reads validate once while retaining DTO, research and audit semantics", () => {
  const { domain, repo, ref, context, stateRoot } = setup()
  for (const id of ["alpha", "beta"]) domain.createWorkstream({ id, title: id, type: "feature", defaultCheckout: repo }, mutation)
  for (const name of ["a", "b", "child"]) domain.registerConversation({ ref: ref(name), executionCheckout: repo, ...(name === "child" ? { parent: ref("a") } : {}) }, mutation)
  domain.associateConversation(ref("a"), "alpha", mutation)
  const ended = domain.assignPhase(ref("a"), "design", mutation)
  domain.endAssignment(ended.id, mutation)
  const active = domain.assignPhase(ref("a"), "design", mutation)
  domain.associateConversation(ref("b"), "alpha", mutation)
  domain.associateConversation(ref("b"), "beta", mutation)
  domain.associateConversation(ref("child"), "alpha", mutation)
  const native = { actor: { kind: "native" as const, repositoryId: domain.repositoryId, ref: ref("a") }, correlationId: "native-status" }
  domain.setWorkstreamStatus("alpha", "done", native)
  for (const topic of ["clean", "changed", "missing"]) {
    domain.writeArtifact("alpha", `research/${topic}.md`, `# ${topic}\n`, mutation)
    domain.registerResearch("alpha", topic, `research/${topic}.md`, mutation)
  }
  domain.writeArtifact("alpha", "research/changed.md", "# Modified\n", mutation)
  domain.writeArtifact("alpha", "research/unregistered.md", "# Unregistered\n", mutation)
  rmSync(join(stateRoot, "workstreams/alpha/research/missing.md"))
  const db = new Database(context.databasePath)
  try {
    const insert = db.query("INSERT INTO audit_events(correlation_id,actor_kind,operation,workstream_id,entity_id,details,timestamp) VALUES(?,'local',?,'alpha',?,'{}',?)")
    for (const [operation, entity] of [["artifact_operation_started", "finished"], ["artifact_operation_started", "pending"], ["artifact_operation_completed", "finished"]]) insert.run("bulk-status", operation!, entity!, new Date().toISOString())
  } finally { db.close() }
  const expected = ["alpha", "beta"].map(id => ({ ...domain.getWorkstreamStatus(id), research: domain.getResearchIndex(id), audit: domain.readAudit(id), unresolvedArtifactOperations: domain.unresolvedArtifactOperations(id) }))
  clock(0)
  const spies = validationSpies(), read = spyOn(domain, "validateRead")
  cleanups.push(() => read.mockRestore())
  const statuses = domain.listStatuses()
  expect(read).toHaveBeenCalledTimes(1)
  expect(spies.checkout).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  expect(statuses).toEqual(expected)
  expect(statuses.map(s => s.workstream.id)).toEqual(["alpha", "beta"])
  const alpha = statuses[0]!
  expect(alpha.workstream.defaultCheckout!.path).toBe(repo)
  expect(alpha.workstream.lifecycle.status).toBe("done")
  expect(alpha.conversations.map(c => c.ref.nativeId)).toEqual(["a", "child"])
  expect(alpha.conversations.find(c => c.ref.nativeId === "child")!.parent).toEqual(ref("a"))
  expect(alpha.activePhases.map(p => p.id)).toEqual([active.id])
  expect(alpha.phaseHistory.map(p => p.id)).toEqual([ended.id])
  expect(alpha.research.registered).toEqual([
    expect.objectContaining({ topic: "changed", missing: false, modified: true }),
    expect.objectContaining({ topic: "clean", missing: false, modified: false }),
    expect.objectContaining({ topic: "missing", missing: true, modified: false }),
  ])
  expect(alpha.research.unregistered).toEqual(["research/unregistered.md"])
  expect(alpha.research.warnings).toEqual([
    "Research changed: modified registered report research/changed.md",
    "Research missing: missing registered report research/missing.md",
    "Unregistered research report: research/unregistered.md",
  ])
  expect(alpha.audit.find(e => e.operation === "workstream_status_changed")!.actor).toEqual(native.actor)
  expect(alpha.audit.some(e => e.operation === "conversation_associated" && e.workstreamId === "beta" && e.details.from === "alpha")).toBe(true)
  expect(alpha.unresolvedArtifactOperations.map(e => e.entityId)).toEqual(["pending"])
  read.mockClear(); spies.clear()
  expect(domain.getStatus("alpha")).toEqual(expected[0]!)
  expect(read).toHaveBeenCalledTimes(1)
  expect(spies.checkout).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
  read.mockClear(); spies.clear()
  expect(domain.getResearchIndex("alpha")).toEqual(expected[0]!.research)
  expect(read).toHaveBeenCalledTimes(1)
  expect(spies.store).toHaveBeenCalledTimes(1)
  expect(spies.sqlite).toHaveBeenCalledTimes(2)
})

test.each(["symlink", "hardlink"])("warm research and bulk status reads reject a registered report replaced with a %s", kind => {
  const f = setup(), { domain, stateRoot, temporary } = f
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  domain.writeArtifact("alpha", "research/topic.md", "# Report\n", mutation)
  domain.registerResearch("alpha", "topic", "research/topic.md", mutation)
  warm(f)
  const outside = join(temporary, "outside.md"), report = join(stateRoot, "workstreams/alpha/research/topic.md")
  writeFileSync(outside, "# External report\n")
  rmSync(report)
  if (kind === "symlink") symlinkSync(outside, report)
  else linkSync(outside, report)
  code(() => domain.getResearchIndex("alpha"), "INVALID_ARTIFACT")
  code(() => domain.getStatus("alpha"), "INVALID_ARTIFACT")
  code(() => domain.listStatuses(), "INVALID_ARTIFACT")
  expect(readFileSync(outside, "utf8")).toBe("# External report\n")
})

test("warm polling reuses selected checkout validation but missing and replaced invocation roots fail", () => {
  const f = setup(true), { domain, checkout, ref } = f
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature", defaultCheckout: checkout }, mutation)
  domain.registerConversation({ ref: ref("a"), executionCheckout: checkout }, mutation)
  domain.associateConversation(ref("a"), "alpha", mutation)
  const artifact = domain.readArtifact("alpha", "PRD.md"), audit = domain.readAudit("alpha")
  warm(f)
  domain.validatePolling()
  const pin = spyOn(repository, "pinCheckout")
  cleanups.push(() => pin.mockRestore())
  domain.validatePolling(); expect(domain.listHandoffsForPolling()).toEqual([])
  expect(pin).not.toHaveBeenCalled()
  renameSync(checkout, checkout + "-saved")
  code(() => domain.validatePolling(), "INVALID_CHECKOUT")
  code(() => domain.listHandoffsForPolling(), "INVALID_CHECKOUT")
  code(() => domain.resolveContext(ref("a")), "INVALID_CHECKOUT")
  expect(domain.getConversation(ref("a"))!.executionCheckout.path).toBe(checkout)
  expect(domain.readAudit("alpha")).toEqual(audit)
  expect(domain.readArtifact("alpha", "PRD.md")).toBe(artifact)
  expect(domain.listArtifacts("alpha")).toContain("PRD.md")
  expect(domain.getStatus("alpha").workstream.id).toBe("alpha")
  expect(domain.listStatuses()).toHaveLength(1)
  mkdirSync(checkout); renameSync(join(checkout + "-saved", ".git"), join(checkout, ".git"))
  code(() => domain.validatePolling(), "STALE_BINDING")
  code(() => domain.listHandoffsForPolling(), "STALE_BINDING")
  code(() => domain.resolveContext(ref("a")), "STALE_BINDING")
  expect(domain.getStatus("alpha").audit).toEqual(audit)
  expect(domain.readArtifact("alpha", "PRD.md")).toBe(artifact)
})

test("warm polling detects selected checkout Git-file changes while history remains readable", () => {
  const f = setup(true)
  warm(f)
  f.domain.validatePolling()
  writeFileSync(join(f.checkout, ".git"), "gitdir: missing-administration\n")
  code(() => f.domain.validatePolling(), "INVALID_CHECKOUT")
  expect(f.domain.listConversations()).toEqual([])
  expect(f.domain.readAudit().length).toBeGreaterThan(0)
})

test("closed warm handles reject ordinary and polling reads", () => {
  const f = setup()
  warm(f)
  f.domain.close()
  code(() => f.domain.listWorkstreams(), "INVALID_CONTEXT")
  code(() => f.domain.listStatuses(), "INVALID_CONTEXT")
  code(() => f.domain.validatePolling(), "INVALID_CONTEXT")
})
