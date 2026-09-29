import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { openRepositoryDomain } from "../src/server.ts"
import { ROOT_DOC_BY_TYPE } from "../src/bootstrap-registry.ts"
import { SUPPORTED_WORKSTREAM_TYPES } from "../src/workstream-type.ts"
import { LIFECYCLE_PHASES } from "../src/lifecycle.ts"
import { fixture, mutation } from "./fixtures.ts"
const cleanup:(()=>void)[]=[]
afterEach(()=>{while(cleanup.length)cleanup.pop()!()})
const plan="# Plan\n## Execution Checkpoints\n| Checkpoint | After job(s) |\n| --- | --- |\n| Checkpoint 1 | 01 |\n"
function setup(type:(typeof SUPPORTED_WORKSTREAM_TYPES)[number]="feature"){
  const f=fixture();cleanup.push(f.cleanup);f.domain.createWorkstream({id:"demo",title:"Demo",type,defaultCheckout:f.repo},mutation)
  const write=(path:string,content:string)=>f.domain.writeArtifact("demo",path,content,mutation)
  const planning=()=>{write("execution/PLAN.md",plan);write("execution/jobs/01-first.md","# Job Spec 01: first\nWork.\n");write("execution/verification/checkpoint-1.md","# Verify\n")}
  return {...f,write,planning}
}
test.each([...SUPPORTED_WORKSTREAM_TYPES])("%s: shared provision, authored protection, validation, no phase-order gate and drift",async type=>{
  const {domain,write}=setup(type)
  expect(domain.getWorkstream("demo").lifecycle.phases.map(p=>p.status)).toEqual(["pending","pending","pending","pending"])
  for(const phase of LIFECYCLE_PHASES){const result=await domain.providePhase("demo",phase,{},mutation);expect(result.phase).toBe(phase);expect((await domain.validatePhase("demo",phase)).ok).toBe(false);expect((await domain.providePhase("demo",phase,{},mutation)).created).toEqual([])}
  write("design/solutions/SOLUTION.md","# Solution\n")
  expect((await domain.validatePhase("demo","engineering")).ok).toBe(true)
  await domain.approvePhase("demo","engineering","explicit owner approval",mutation)
  write(ROOT_DOC_BY_TYPE[type],"# Root\n");write("design/SDD.md","# Design\n")
  await domain.approvePhase("demo","design","owner",mutation)
  write("design/SDD.md","# Amended design\n")
  expect((await domain.validatePhase("demo","design")).warnings.some(w=>w.includes("changed since approval"))).toBe(true)
  write("resources/SDD_TEMPLATE.md","old resource")
  expect((await domain.providePhase("demo","design",{refreshTemplates:true},mutation)).refreshed).toContain("resources/SDD_TEMPLATE.md")
  expect(domain.readArtifact("demo","design/SDD.md")).toBe("# Amended design\n")
  expect(domain.readArtifact("demo","resources/SDD_TEMPLATE.md")).not.toBe("old resource")
  await domain.approvePhase("demo","design","owner reapproval",mutation)
  const history=domain.getApprovalHistory("demo").filter(a=>a.phase==="design")
  expect(history).toHaveLength(2);expect(history[0]!.snapshotHash).not.toBe(history[1]!.snapshotHash)
  expect(domain.getWorkstream("demo").lifecycle.approvals.filter(a=>a.phase==="design")).toHaveLength(1)
},20000)
test("Planning authority, amendments, forward progress, job context, scoped reports and Execution completion",async()=>{
  const {domain,write,planning,repo}=setup();planning()
  await expect(domain.registerJobs("demo",mutation)).rejects.toThrow("existing Planning approval")
  await domain.approvePhase("demo","planning","owner",mutation)
  const authority=domain.getWorkstream("demo").lifecycle.approvals
  write("execution/jobs/02-second.md","# Job Spec 02: second\nAdditional authorized work.\n")
  const registration=await domain.registerJobs("demo",mutation)
  expect(registration.jobs.map(j=>j.job_id)).toEqual(["01","02"]);expect(registration.warnings.some(w=>w.includes("routine amendments"))).toBe(true)
  expect(domain.getWorkstream("demo").lifecycle.approvals).toEqual(authority)
  await domain.registerJobs("demo",mutation);expect(domain.getWorkstream("demo").lifecycle.jobs).toHaveLength(2)
  expect(domain.updateJob("demo","01","running",mutation).changed).toBe(true)
  expect(domain.updateJob("demo","01","running",mutation).changed).toBe(false)
  domain.updateJob("demo","01","completed",mutation)
  expect(()=>domain.updateJob("demo","01","running",mutation)).toThrow("backward moves rejected")
  expect(domain.getJobContext("demo","01").executionCheckout).toBe(repo)
  write("execution/FINAL_REPORT.md","# Final\nDelivered.\n")
  expect((await domain.validatePhase("demo","execution")).ok).toBe(false)
  for(const [job,name] of [["01","first"],["02","second"]])write(`execution/reports/${job}-${name}.md`,`# Job ${job}: ${name} Report\n\n## Outcome\nResults.\n## Unresolved Issues\nNone\n## Recommendations\nNone\n`)
  expect((await domain.validatePhase("demo","execution",{reportId:"01"})).ok).toBe(true)
  expect((await domain.validatePhase("demo","execution")).ok).toBe(true)
  await expect(domain.approvePhase("demo","execution","owner",mutation)).rejects.toThrow("execution/test-reports/checkpoint-1.md")
  write("execution/test-reports/checkpoint-1.md","# Verification\nPassed.\n")
  await domain.approvePhase("demo","execution","owner",mutation)
  expect(domain.getWorkstream("demo").lifecycle.jobs.every(j=>j.status==="completed")).toBe(true)
  expect(domain.getWorkstream("demo").lifecycle.status).toBe("open")
  expect(domain.readAudit("demo").some(e=>e.operation==="phase_approved"&&e.actor.kind==="local")).toBe(true)
},20000)
test("invalid guidance/placeholders/checkpoints/colliding IDs reject without authority",async()=>{
  const {domain,write,planning,stateRoot}=setup();planning()
  write("execution/jobs/01-first.md","<!-- unfinished -->")
  expect((await domain.validatePhase("demo","planning")).ok).toBe(false)
  write("execution/jobs/01-first.md","# Job Spec 01: first\n{{unresolved}}")
  expect((await domain.validatePhase("demo","planning")).ok).toBe(false)
  write("execution/jobs/01-first.md","# Job Spec 01: first\nDone.\n")
  write("execution/verification/extra.md","# Extra\n")
  expect((await domain.validatePhase("demo","planning")).problems).toContain("execution/verification/extra.md: no matching Plan checkpoint")
  rmSync(join(stateRoot,"workstreams/demo/execution/verification/extra.md"))
  write("execution/jobs/01-collision.md","# Collision\n")
  const before=domain.getLifecycleStatus("demo")
  await expect(domain.approvePhase("demo","planning","owner",mutation)).rejects.toThrow("Duplicate job ID")
  expect(domain.getLifecycleStatus("demo")).toEqual(before)
})
test("independent handles serialize artifact/approval operations; phase membership never approves",async()=>{
  const {domain,context,write,ref,repo}=setup();write("PRD.md","# Direction\n");write("design/SDD.md","# Design\n")
  domain.registerConversation({ref:ref("a"),executionCheckout:repo},mutation);domain.associateConversation(ref("a"),"demo",mutation);domain.assignPhase(ref("a"),"design",mutation)
  expect(domain.getWorkstream("demo").lifecycle.phases.every(p=>p.status==="pending")).toBe(true)
  const second=openRepositoryDomain(context)
  try{const results=await Promise.allSettled([domain.approvePhase("demo","design","one",mutation),second.approvePhase("demo","design","two",mutation)])
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1)
    expect(second.getLifecycleStatus("demo")).toEqual(domain.getLifecycleStatus("demo"))
  }finally{second.close()}
})
test("SQLite failure rolls approval/jobs/audit back, malformed/unknown reports and renamed specs reject",async()=>{
  const {domain,planning,write,stateRoot}=setup();planning();const before=domain.getLifecycleStatus("demo"),audit=domain.readAudit("demo")
  const db=new Database(join(stateRoot,"sane.db"))
  try{db.exec("CREATE TRIGGER refuse_approval BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT,'injected failure'); END")
    await expect(domain.approvePhase("demo","planning","owner",mutation)).rejects.toThrow("injected failure")
    expect(domain.getLifecycleStatus("demo")).toEqual(before);expect(domain.readAudit("demo")).toEqual(audit);db.exec("DROP TRIGGER refuse_approval")
  }finally{db.close()}
  await domain.approvePhase("demo","planning","owner",mutation)
  write("execution/reports/01-first.md","# Wrong\n<!-- unresolved -->")
  expect((await domain.validatePhase("demo","execution",{reportId:"01"})).ok).toBe(false)
  expect((await domain.validatePhase("demo","execution",{reportId:"unknown"})).ok).toBe(false)
  write("execution/reports/unregistered.md","# Unassigned\n")
  expect((await domain.validatePhase("demo","execution")).problems.some(p=>p.includes("no registered job assignment"))).toBe(true)
  rmSync(join(stateRoot,"workstreams/demo/execution/jobs/01-first.md"));write("execution/jobs/01-renamed.md","# Job Spec 01: first\nWork.\n")
  await expect(domain.registerJobs("demo",mutation)).rejects.toThrow("cannot reassign")
})
test("missing resources, retired layouts and symlinks are rejected without repair",async()=>{
  const {domain,stateRoot,temporary}=setup(),root=join(stateRoot,"workstreams/demo")
  rmSync(join(root,"resources/SDD_TEMPLATE.md"))
  await expect(domain.providePhase("demo","design",{refreshTemplates:true},mutation)).rejects.toThrow("missing regular file")
  expect(existsSync(join(root,"resources/SDD_TEMPLATE.md"))).toBe(false)
  writeFileSync(join(root,"resources/SDD_TEMPLATE.md"),"restored")
  writeFileSync(join(root,"SDD.md"),"old layout")
  await expect(domain.validatePhase("demo","design")).rejects.toThrow("old-layout file")
  rmSync(join(root,"SDD.md"));const outside=join(temporary,"outside.md");writeFileSync(outside,"untouched")
  rmSync(join(root,"resources/SDD_TEMPLATE.md"));symlinkSync(outside,join(root,"resources/SDD_TEMPLATE.md"))
  await expect(domain.providePhase("demo","design",{refreshTemplates:true},mutation)).rejects.toThrow(/symlink/i)
})
test("Research index tracks unregistered/missing/modified evidence, unregister retains artifact and audit",async()=>{
  const {domain,write,stateRoot}=setup();write("research/topic.md","# Evidence\n")
  expect(domain.getResearchIndex("demo").unregistered).toEqual(["research/topic.md"])
  domain.registerResearch("demo","topic","research/topic.md",mutation)
  expect(domain.getResearchIndex("demo").registered[0]).toMatchObject({missing:false,modified:false})
  write("research/topic.md","# Changed\n")
  expect(domain.getResearchIndex("demo").registered[0]!.modified).toBe(true)
  expect((await domain.validatePhase("demo","design")).warnings.some(w=>w.includes("modified"))).toBe(true)
  domain.registerResearch("demo","topic","research/topic.md",mutation)
  domain.unregisterResearch("demo","topic",mutation)
  expect(domain.readArtifact("demo","research/topic.md")).toBe("# Changed\n")
  domain.registerResearch("demo","topic","research/topic.md",mutation);rmSync(join(stateRoot,"workstreams/demo/research/topic.md"))
  expect(domain.getResearchIndex("demo").registered[0]!.missing).toBe(true)
  expect(domain.readAudit("demo").some(e=>e.operation==="research_unregistered")).toBe(true)
})
