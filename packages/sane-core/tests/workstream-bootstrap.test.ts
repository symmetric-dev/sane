import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DomainError, openRepositoryDomain } from "../src/server.ts"
import { SUPPORTED_WORKSTREAM_TYPES, type CreateWorkstreamInput } from "../src/contracts.ts"
import { DEFAULT_TEMPLATE_ROOT, INITIAL_DIRECTORIES, initialTemplateRegistry } from "../src/bootstrap-registry.ts"
import { ConfinedLifecycleFileSystem } from "../src/confined-lifecycle-filesystem.ts"
import { fixture, mutation } from "./fixtures.ts"
const cleanup: (() => void)[] = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
function setup() { const f=fixture(); cleanup.push(f.cleanup); return {...f,destination:(id:string)=>join(f.stateRoot,"workstreams",id)} }
for (const type of SUPPORTED_WORKSTREAM_TYPES) test(`${type}: typed relational row and all artifacts preserve shared bootstrap policy`, () => {
  const { domain, context, destination } = setup()
  expect(domain.createWorkstream({id:type,title:type,type},mutation).type).toBe(type)
  const entries = initialTemplateRegistry(type), paths=entries.map(e=>e.destination).sort()
  expect(domain.listArtifacts(type)).toEqual(paths)
  for (const e of entries) expect(readFileSync(join(destination(type),e.destination))).toEqual(readFileSync(join(DEFAULT_TEMPLATE_ROOT,e.source)))
  for (const directory of INITIAL_DIRECTORIES) expect(lstatSync(join(destination(type),directory)).isDirectory()).toBe(true)
  const reopened=openRepositoryDomain(context)
  try { expect(reopened.getWorkstream(type).type).toBe(type); expect(reopened.listArtifacts(type)).toEqual(paths) } finally {reopened.close()}
  domain.writeArtifact(type,"design/SDD.md","authored",mutation)
  expect(()=>domain.createWorkstream({id:type,title:"replacement",type},mutation)).toThrow("already exists")
  expect(domain.readArtifact(type,"design/SDD.md")).toBe("authored")
})
test("invalid types/IDs fail before rows, bootstrap or started events", () => {
  const {domain,stateRoot}=setup(); const before=domain.readAudit()
  for (const type of [undefined,null,"","Feature","other",1,{},[]]) {
    try {domain.createWorkstream({id:"bad",title:"Bad",type} as CreateWorkstreamInput,mutation);throw new Error("Expected rejection")}
    catch(error){expect(error).toBeInstanceOf(DomainError);expect((error as DomainError).code).toBe("INVALID_INPUT")}
  }
  for (const id of ["Upper","../bad","a".repeat(97)]) expect(()=>domain.createWorkstream({id,title:id,type:"issue"},mutation)).toThrow()
  expect(domain.listWorkstreams()).toEqual([]);expect(readdirSync(join(stateRoot,"workstreams"))).toEqual([]);expect(domain.readAudit()).toEqual(before)
})
test("empty, authored, regular and dangling-symlink orphan destinations are never adopted",()=>{
  const {domain,destination,temporary}=setup()
  mkdirSync(destination("empty"));mkdirSync(destination("authored"));writeFileSync(join(destination("authored"),"README.md"),"owner")
  writeFileSync(destination("file"),"owner file");symlinkSync(join(temporary,"absent"),destination("link"))
  for(const id of ["empty","authored","file","link"]) expect(()=>domain.createWorkstream({id,title:id,type:"issue"},mutation)).toThrow()
  expect(readdirSync(destination("empty"))).toEqual([]);expect(readFileSync(join(destination("authored"),"README.md"),"utf8")).toBe("owner")
  expect(readFileSync(destination("file"),"utf8")).toBe("owner file");expect(lstatSync(destination("link")).isSymbolicLink()).toBe(true);expect(domain.listWorkstreams()).toEqual([])
})
test("partial publication retains explicit orphan/audit evidence, never silently retries or deletes",()=>{
  const {domain,destination}=setup();const original=ConfinedLifecycleFileSystem.prototype.writeBytes
  const spy=spyOn(ConfinedLifecycleFileSystem.prototype,"writeBytes").mockImplementation(function(this: ConfinedLifecycleFileSystem,path,bytes,exclusive){if(path.endsWith("design/SDD.md"))throw new Error("fixture disk failure");return original.call(this,path,bytes,exclusive)})
  try{expect(()=>domain.createWorkstream({id:"new",title:"New",type:"foundation"},mutation)).toThrow("fixture disk failure")}finally{spy.mockRestore()}
  expect(domain.listWorkstreams()).toEqual([]);expect(existsSync(destination("new"))).toBe(true)
  expect(domain.unresolvedArtifactOperations("new")).toHaveLength(1)
  expect(domain.readAudit("new").at(-1)!.operation).toBe("artifact_operation_failed")
  expect(()=>domain.createWorkstream({id:"new",title:"Retry",type:"foundation"},mutation)).toThrow("Orphan")
})
test("DB row failure preserves existing bytes and surfaces orphan instead of adopting it",()=>{
  const {domain,destination}=setup();domain.createWorkstream({id:"existing",title:"Existing",type:"feature"},mutation)
  domain.writeArtifact("existing","README.md","authored",mutation)
  const db=(domain as unknown as {db:Database}).db,query=db.query
  let injected=false
  const fault=spyOn(db,"query").mockImplementation(function(this:Database,sql:string){
    if(sql.startsWith("INSERT INTO workstreams(")){
      expect(this.inTransaction).toBe(true)
      for(const entry of initialTemplateRegistry("issue")) expect(readFileSync(join(destination("new"),entry.destination))).toEqual(readFileSync(join(DEFAULT_TEMPLATE_ROOT,entry.source)))
      injected=true
      throw new Error("fixture database failure")
    }
    return query.call(this,sql)
  } as typeof db.query)
  try{
     expect(()=>domain.createWorkstream({id:"new",title:"New",type:"issue"},mutation)).toThrow("fixture database failure")
     expect(injected).toBe(true)
  }finally{fault.mockRestore()}
  expect(domain.listWorkstreams().map(w=>w.id)).toEqual(["existing"]);expect(existsSync(destination("new"))).toBe(true)
  expect(domain.readArtifact("existing","README.md")).toBe("authored");expect(domain.unresolvedArtifactOperations("new")).toHaveLength(1)
  expect(domain.readAudit("new").at(-1)!.operation).toBe("artifact_operation_failed")
  expect(()=>domain.createWorkstream({id:"new",title:"Retry",type:"issue"},mutation)).toThrow("Orphan")
})
test("deferred COMMIT failure rolls back all domain rows; published bytes remain diagnosed",()=>{
  const {domain,destination}=setup();const db=(domain as unknown as {db:Database}).db
  const query=db.query,preferences=db.query("SELECT * FROM cli_preferences").all()
  let inserted=false,auditWrites=0
  const fault=spyOn(db,"query").mockImplementation(function(this:Database,sql:string){
    if(sql.startsWith("INSERT INTO workstreams(")){
      expect(this.inTransaction).toBe(true)
      // Defer an existing FK until the real COMMIT; leave schema admission intact.
      this.exec("PRAGMA defer_foreign_keys=ON")
      query.call(this,"UPDATE cli_preferences SET selected_workstream_id='missing' WHERE id=1").run()
      inserted=true
    }
    if(inserted&&auditWrites<2&&sql.startsWith("INSERT INTO audit_events(")){
      expect(query.call(this,"SELECT COUNT(*) AS count FROM phase_states WHERE workstream_id='new'").get()).toEqual({count:4})
      auditWrites++
    }
    return query.call(this,sql)
  } as typeof db.query)
  try{expect(()=>domain.createWorkstream({id:"new",title:"New",type:"issue"},mutation)).toThrow("FOREIGN KEY")}
  finally{fault.mockRestore()}
  expect(inserted).toBe(true);expect(auditWrites).toBe(2)
  expect(db.query("SELECT * FROM phase_states").all()).toEqual([])
  expect(db.query("SELECT * FROM cli_preferences").all()).toEqual(preferences)
  expect(domain.readAudit("new").some(e=>e.operation==="workstream_created"||e.operation==="artifact_operation_completed")).toBe(false)
  expect(domain.readAudit("new").at(-1)!.operation).toBe("artifact_operation_failed")
  expect(domain.listWorkstreams()).toEqual([]);expect(existsSync(destination("new"))).toBe(true);expect(domain.unresolvedArtifactOperations("new")).toHaveLength(1)
})
test("template preflight failure publishes nothing; initial-audit failure publishes nothing",()=>{
  const {domain,destination}=setup();const original=ConfinedLifecycleFileSystem.prototype.readBytes
  const spy=spyOn(ConfinedLifecycleFileSystem.prototype,"readBytes").mockImplementation(function(this: ConfinedLifecycleFileSystem,path){if(path.endsWith("shared/sdd/SDD.md"))throw new Error("unavailable template");return original.call(this,path)})
  try{expect(()=>domain.createWorkstream({id:"new",title:"New",type:"issue"},mutation)).toThrow("unavailable template")}finally{spy.mockRestore()}
  expect(existsSync(destination("new"))).toBe(false)
  const db=(domain as unknown as {db:Database}).db,query=db.query,audit=domain.readAudit()
  const fault=spyOn(db,"query").mockImplementation(function(this:Database,sql:string){
    if(sql.startsWith("INSERT INTO audit_events(")){
      expect(this.inTransaction).toBe(true)
      throw new Error("audit refused")
    }
    return query.call(this,sql)
  } as typeof db.query)
  try{
     expect(()=>domain.createWorkstream({id:"new",title:"New",type:"issue"},mutation)).toThrow("audit refused");expect(existsSync(destination("new"))).toBe(false)
  }finally{fault.mockRestore()}
  expect(domain.listWorkstreams()).toEqual([]);expect(domain.readAudit()).toEqual(audit)
})
test("fresh schema independently rejects typeless records rather than default-filling old state",()=>{
  const {stateRoot,domain}=setup();const db=new Database(join(stateRoot,"sane.db"))
  try{expect(()=>db.exec("INSERT INTO workstreams(id,title,created_at,updated_at) VALUES('bad','Bad','2026','2026')")).toThrow("NOT NULL")}finally{db.close()}
  expect(domain.listWorkstreams()).toEqual([])
})
