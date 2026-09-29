import { afterEach, expect, test } from "bun:test"
import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DomainError, openRepositoryDomain } from "../src/server.ts"
import type { DomainErrorCode, Phase } from "../src/contracts.ts"
import { fixture, git, mutation } from "./fixtures.ts"
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() { const f = fixture(true); cleanups.push(f.cleanup); return f }
function code(action: () => unknown, expected: DomainErrorCode) { try { action(); throw new Error("Expected failure") } catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(expected) } }

test("qualified IDs, shared primary authority and independent handles", () => {
  const { domain, context, checkout, ref, temporary } = setup()
  domain.createWorkstream({ id: "alpha", title: "Alpha", type: "feature" }, mutation)
  const other = join(temporary,"other-profile"); mkdirSync(other)
  const source = domain.declareNativeAuthority({ version: 1, harness: "cc", kind: "local-profile", profileRoot: other }, mutation)
  const oc = domain.declareNativeAuthority({ version: 1, harness: "oc", kind: "local-registration", registrationFile: join(temporary,"service.json") }, mutation)
  const refs = [ref("same"), { ...ref("same"), authorityId: source.authorityId }, { harness: "oc" as const, authorityId: oc.authorityId, nativeId: "same" }]
  for (const r of refs) expect(domain.registerConversation({ ref: r, executionCheckout: checkout }, mutation).workstreamId).toBeNull()
  expect(domain.getConversation(ref("unknown"))).toBeNull()
  domain.selectWorkstream("alpha", mutation)
  expect(domain.resolveInvocation(ref("same")).workstream).toBeNull()
  code(() => domain.resolveInvocation(ref("unknown")), "NOT_FOUND")
  domain.associateConversation(ref("same"), "alpha", mutation)
  code(() => domain.associateConversation(ref("same"), "absent", mutation), "NOT_FOUND")
  expect(domain.getConversation(ref("same"))!.workstreamId).toBe("alpha")
  expect(domain.getConversation(refs[1]!)!.workstreamId).toBeNull()
  const second = openRepositoryDomain(context)
  try { expect(second.getWorkstreamStatus("alpha").conversations).toHaveLength(1); second.createWorkstream({id:"beta",title:"Beta",type:"issue"},mutation); expect(domain.listWorkstreams()).toHaveLength(2) } finally { second.close() }
})
test("child snapshots null or membership once, never phases; retry preserves later edits", () => {
  const { domain, checkout, ref } = setup()
  for (const id of ["alpha","beta"]) domain.createWorkstream({id,title:id,type:"feature"},mutation)
  domain.registerConversation({ref:ref("parent"),executionCheckout:checkout},mutation)
  domain.registerConversation({ref:ref("early"),executionCheckout:checkout,parent:ref("parent")},mutation)
  domain.associateConversation(ref("parent"),"alpha",mutation); domain.assignPhase(ref("parent"),"design",mutation)
  domain.registerConversation({ref:ref("late"),executionCheckout:checkout,parent:ref("parent")},mutation)
  domain.associateConversation(ref("parent"),"beta",mutation)
  domain.registerConversation({ref:ref("early"),executionCheckout:checkout,parent:ref("parent")},mutation)
  expect(domain.getConversation(ref("early"))!.workstreamId).toBeNull()
  expect(domain.getConversation(ref("late"))!.workstreamId).toBe("alpha")
  expect(domain.getWorkstreamStatus("alpha").activePhases).toHaveLength(0)
  expect(domain.getWorkstreamStatus("alpha").phaseHistory).toHaveLength(1)
  domain.associateConversation(ref("late"),null,mutation)
  domain.registerConversation({ref:ref("late"),executionCheckout:checkout,parent:ref("parent")},mutation)
  expect(domain.getConversation(ref("late"))!.workstreamId).toBeNull()
  code(() => domain.registerConversation({ref:ref("missing"),executionCheckout:checkout,parent:ref("absent")},mutation),"NOT_FOUND")
  expect(domain.getConversation(ref("missing"))).toBeNull()
})
test("all phases permit many targets; exact assignment IDs cannot end a replacement episode", () => {
  const { domain, checkout, ref } = setup()
  domain.createWorkstream({id:"alpha",title:"Alpha",type:"feature"},mutation)
  for (const name of ["a","b"]) { domain.registerConversation({ref:ref(name),executionCheckout:checkout},mutation); domain.associateConversation(ref(name),"alpha",mutation) }
  const phases: Phase[] = ["design","engineering","planning","execution","research","research:topic"]
  for (const phase of phases) {
    const first = domain.assignPhase(ref("a"),phase,mutation)
    expect(domain.assignPhase(ref("a"),phase,mutation).id).toBe(first.id)
    domain.assignPhase(ref("b"),phase,mutation)
    code(() => domain.resolvePhaseTarget("alpha",phase),"AMBIGUOUS_TARGET")
    expect(domain.resolvePhaseTarget("alpha",phase,ref("b")).ref).toEqual(ref("b"))
    domain.endAssignment(first.id,mutation)
    const next = domain.assignPhase(ref("a"),phase,mutation)
    domain.endAssignment(first.id,mutation)
    expect(domain.getWorkstreamStatus("alpha").activePhases.some(a=>a.id===next.id)).toBe(true)
    domain.endAssignment(next.id,mutation)
    expect(domain.resolvePhaseTarget("alpha",phase).ref).toEqual(ref("b"))
  }
  domain.associateConversation(ref("b"),null,mutation)
  expect(domain.getWorkstreamStatus("alpha").activePhases).toHaveLength(0)
  expect(domain.getWorkstreamStatus("alpha").phaseHistory).toHaveLength(18)
  code(() => domain.assignPhase(ref("b"),"design",mutation),"CONFLICT")
})
test("default changes and reassociation never change immutable execution/parent", () => {
  const { domain, repo, checkout, ref } = setup()
  for (const id of ["alpha","beta"]) domain.createWorkstream({id,title:id,type:"foundation",defaultCheckout:checkout},mutation)
  domain.registerConversation({ref:ref("a"),executionCheckout:repo},mutation)
  domain.associateConversation(ref("a"),"alpha",mutation)
  domain.setDefaultCheckout("alpha",null,mutation); domain.associateConversation(ref("a"),"beta",mutation)
  expect(domain.resolveContext(ref("a")).executionCheckout).toBe(repo)
  code(()=>domain.registerConversation({ref:ref("a"),executionCheckout:checkout},mutation),"CONFLICT")
  code(()=>domain.registerConversation({ref:ref("bad"),executionCheckout:join(repo,".sane")},mutation),"INVALID_CHECKOUT")
})
test("missing and replaced execution roots fail without blocking valid artifact/history reads", () => {
  const { domain, checkout, ref } = setup()
  domain.createWorkstream({id:"alpha",title:"Alpha",type:"feature"},mutation)
  domain.registerConversation({ref:ref("a"),executionCheckout:checkout},mutation)
  renameSync(checkout,checkout+"-saved")
  code(()=>domain.resolveContext(ref("a")),"INVALID_CHECKOUT")
  expect(domain.readArtifact("alpha","README.md")).toBeTruthy()
  mkdirSync(checkout); renameSync(join(checkout+"-saved",".git"),join(checkout,".git"))
  code(()=>domain.resolveContext(ref("a")),"STALE_BINDING")
  expect(domain.getConversation(ref("a"))!.executionCheckout.path).toBe(checkout)
})
test("independent clones and cross-repository actors fail before effects", () => {
  const { domain, repo, temporary, ref } = setup()
  const clone = join(temporary,"clone"); git(repo,"clone",repo,clone)
  code(()=>domain.registerConversation({ref:ref("foreign"),executionCheckout:clone},mutation),"INVALID_CHECKOUT")
  code(()=>domain.createWorkstream({id:"bad",title:"Bad",type:"feature"},{actor:{kind:"native",repositoryId:"other",ref:ref("foreign")},correlationId:"cross"}),"INVALID_CONTEXT")
  expect(domain.listWorkstreams()).toEqual([])
})
test("all artifact access rejects traversal, symlinks and hardlinks", () => {
  const { domain, temporary, stateRoot } = setup()
  domain.createWorkstream({id:"alpha",title:"Alpha",type:"feature"},mutation)
  for (const path of ["../escape.md","/absolute.md","file.txt","a\\b.md",null, false, 0]) {
    code(()=>domain.writeArtifact("alpha",path as string,"bad",mutation),"INVALID_ARTIFACT")
    code(()=>domain.readArtifact("alpha",path as string),"INVALID_ARTIFACT")
  }
  const outside = join(temporary,"outside.md"); writeFileSync(outside,"untouched")
  symlinkSync(outside,join(stateRoot,"workstreams/alpha/link.md"))
  code(()=>domain.readArtifact("alpha","link.md"),"INVALID_ARTIFACT")
  code(()=>domain.writeArtifact("alpha","link.md","changed",mutation),"INVALID_ARTIFACT")
  expect(readFileSync(outside,"utf8")).toBe("untouched")
  domain.createWorkstream({id:"beta",title:"Beta",type:"issue"},mutation)
  linkSync(outside,join(stateRoot,"workstreams/beta/hard.md"))
  code(()=>domain.listArtifacts("beta"),"INVALID_ARTIFACT")
  code(()=>domain.readArtifact("beta","hard.md"),"INVALID_ARTIFACT")
})
test("mutation audit records qualified actor and expected revisions prevent stale updates", () => {
  const { domain, checkout, ref } = setup()
  domain.registerConversation({ref:ref("actor"),executionCheckout:checkout},mutation)
  const native = { actor:{kind:"native" as const,repositoryId:domain.repositoryId,ref:ref("actor")},correlationId:"native-operation" }
  const w=domain.createWorkstream({id:"alpha",title:"Alpha",type:"feature"},native)
  domain.setWorkstreamStatus("alpha","done",{...native,expectedRevision:w.revision})
  code(()=>domain.setDefaultCheckout("alpha",null,{...native,expectedRevision:w.revision}),"CONFLICT")
  expect(domain.readAudit("alpha").every(e=>e.actor.kind==="native")).toBe(true)
  expect(domain.readAudit("alpha").find(e=>e.operation==="workstream_created")!.actor).toEqual(native.actor)
  expect(domain.getWorkstream("alpha").lifecycle.phases.every(p=>p.status==="pending")).toBe(true)
})
