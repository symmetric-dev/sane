/** Private SQLite capabilities and explicit history-preserving upgrades. */
import { Database } from "bun:sqlite"
import { fail } from "./errors.ts"
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, CANONICAL_PHASE_SQL } from "./schema.ts"

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string }
const definitions = new Map<number, SchemaObject[]>()
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ").replace(/;$/, "")
function objects(db: Database): SchemaObject[] {
  return db.query<SchemaObject, []>("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()
}
function expected(version: 1 | 2 | 3 | 4 | 5 | 6): SchemaObject[] {
  let result = definitions.get(version)
  if (!result) {
    const model = new Database(":memory:", { strict: true })
    const sql = version === 1 ? SCHEMA_V1 : version === 2 ? SCHEMA_V2 : version === 3 ? SCHEMA_V3 : version === 4 ? SCHEMA_V4 : version === 5 ? SCHEMA_V5 : SCHEMA_V6
    try { model.exec(sql); result = objects(model); definitions.set(version, result) }
    finally { model.close() }
  }
  return result
}
/** Check definitions, not merely object names: constraints and history triggers are capabilities. */
export function assertSchemaCapabilities(db: Database, version: 1 | 2 | 3 | 4 | 5 | 6): void {
  const actual = objects(db), required = expected(version)
  if (actual.length !== required.length) fail("CORRUPT_STORE", `Unexpected or missing sane-domain v${version} schema objects.`)
  for (let i = 0; i < required.length; i++) {
    const a = actual[i]!, e = required[i]!
    if (a.type !== e.type || a.name !== e.name || a.tbl_name !== e.tbl_name || !a.sql || normalize(a.sql) !== normalize(e.sql)) fail("CORRUPT_STORE", `Altered or missing sane-domain v${version} capability: ${e.name}.`)
  }
}
export function assertStoreIntegrity(db: Database): void {
  if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().some(row => row.quick_check !== "ok") || db.query("PRAGMA foreign_key_check").all().length) fail("CORRUPT_STORE", "Domain integrity check failed.")
  if (db.query("SELECT w.id FROM workstreams w LEFT JOIN phase_states p ON p.workstream_id=w.id GROUP BY w.id HAVING count(p.phase)!=4").all().length) fail("CORRUPT_STORE", "Workstream is missing lifecycle phase rows.")
  if (db.query(`SELECT a.id FROM phase_assignments a JOIN memberships m ON m.id=a.membership_id
    WHERE a.started_at<m.started_at OR (m.ended_at IS NOT NULL AND (a.ended_at IS NULL OR a.ended_at>m.ended_at))`).all().length) fail("CORRUPT_STORE", "Assignment is outside its membership interval.")
  if (db.query(`SELECT membership_id FROM phase_assignments WHERE ended_at IS NULL GROUP BY membership_id,(${CANONICAL_PHASE_SQL}) HAVING count(*)>1`).all().length) fail("CORRUPT_STORE", "Conflicting active support-track aliases in one membership; resolve explicitly with the prior compatible SANE version before upgrading. No history was selected or deleted.")
}
/** Caller owns an IMMEDIATE transaction. No foreign-key/trigger safety pragmas are disabled. */
export function migrateV1ToV2(db: Database): void {
  rebuildAssignmentCapability(db, 1, 2)
}
export function migrateV2ToV3(db: Database): void {
  rebuildAssignmentCapability(db, 2, 3)
}
export function migrateV3ToV4(db: Database): void {
  rebuildHandoffCapability(db, 3, 4)
}
export function migrateV4ToV5(db: Database): void {
  rebuildJobsCapability(db, 4, 5)
}
/** Finish an already-journaled upgrade whose target is still v5. */
export function migrateThroughV5(db: Database, fromVersion: 1 | 2 | 3 | 4): void {
  if (fromVersion === 1) migrateV1ToV2(db)
  if (fromVersion <= 2) migrateV2ToV3(db)
  if (fromVersion <= 3) migrateV3ToV4(db)
  migrateV4ToV5(db)
}
/** Deliberate path to the current schema within the caller's single transaction. */
export function migrateToCurrent(db: Database, fromVersion: 1 | 2 | 3 | 4 | 5): void {
  if (fromVersion <= 4) migrateThroughV5(db, fromVersion as 1 | 2 | 3 | 4)
  migrateV5ToV6(db)
}
/** v5 -> v6 widens native_authorities so a gk local-home pin can be inserted.
 * Child tables are copied, not rewritten. A failed comparison aborts the caller's transaction. */
export function migrateV5ToV6(db: Database): void {
  assertSchemaCapabilities(db, 5); assertStoreIntegrity(db)
  const rebuilt = ["handoff_attempts", "handoffs", "phase_assignments", "memberships", "jobs", "phase_states", "approval_files", "approvals", "research_reports", "audit_events", "conversations", "native_authorities", "store_metadata"]
  const createOrder = ["store_metadata", "native_authorities", "conversations", "memberships", "phase_assignments", "audit_events", "approvals", "approval_files", "phase_states", "jobs", "research_reports", "handoffs", "handoff_attempts"]
  for (const table of rebuilt) db.exec(`CREATE TEMP TABLE _sane_upgrade_${table} AS SELECT * FROM ${table}`)
  for (const item of expected(5).filter(item => rebuilt.includes(item.tbl_name) && item.type === "trigger")) db.exec(`DROP TRIGGER ${item.name}`)
  for (const table of rebuilt) db.exec(`DROP TABLE ${table}`)
  const target = expected(6).filter(item => rebuilt.includes(item.tbl_name))
  for (const table of createOrder) db.exec(target.find(item => item.type === "table" && item.tbl_name === table)?.sql ?? fail("CORRUPT_STORE", `Missing v6 table: ${table}.`))
  db.exec(`INSERT INTO store_metadata SELECT id,format,6,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata;
    INSERT INTO native_authorities SELECT * FROM _sane_upgrade_native_authorities`)
  let guard = 0
  while (true) {
    const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM conversations").get()!.n
    db.exec(`INSERT INTO conversations SELECT * FROM _sane_upgrade_conversations AS s
      WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.id)
      AND (s.parent_id IS NULL OR EXISTS (SELECT 1 FROM conversations p WHERE p.id = s.parent_id))`)
    const after = db.query<{ n: number }, []>("SELECT count(*) AS n FROM conversations").get()!.n
    const total = db.query<{ n: number }, []>("SELECT count(*) AS n FROM _sane_upgrade_conversations").get()!.n
    if (after === total) break
    if (after === before || ++guard > total + 1) fail("CORRUPT_STORE", "Upgrade could not preserve conversation parent links. No history was deleted.")
  }
  for (const table of ["memberships", "phase_assignments", "audit_events", "approvals", "approval_files", "phase_states", "jobs", "research_reports", "handoffs", "handoff_attempts"]) db.exec(`INSERT INTO ${table} SELECT * FROM _sane_upgrade_${table}`)
  db.exec(`UPDATE sqlite_sequence SET seq = COALESCE((SELECT MAX(id) FROM audit_events), 0) WHERE name = 'audit_events'`)
  db.exec(`INSERT INTO sqlite_sequence(name, seq) SELECT 'audit_events', COALESCE(MAX(id), 0) FROM audit_events WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'audit_events')`)
  for (const item of target.filter(item => item.type !== "table")) db.exec(item.sql)
  for (const table of rebuilt.filter(table => table !== "store_metadata")) {
    if (db.query(`SELECT * FROM _sane_upgrade_${table} EXCEPT SELECT * FROM ${table}`).all().length
      || db.query(`SELECT * FROM ${table} EXCEPT SELECT * FROM _sane_upgrade_${table}`).all().length) fail("CORRUPT_STORE", `Upgrade failed to preserve ${table} history. No history was deleted.`)
  }
  if (db.query(`SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata
      EXCEPT SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM store_metadata`).all().length) fail("CORRUPT_STORE", "Upgrade failed to preserve metadata history. No history was deleted.")
  for (const table of rebuilt) db.exec(`DROP TABLE _sane_upgrade_${table}`)
  assertSchemaCapabilities(db, 6); assertStoreIntegrity(db)
}
function rebuildAssignmentCapability(db: Database, fromVersion: 1 | 2, toVersion: 2 | 3): void {
  assertSchemaCapabilities(db, fromVersion); assertStoreIntegrity(db)
  const rebuilt = ["phase_assignments", "store_metadata"]
  // Snapshot all columns, including ended assignment history, before dropping protected tables.
  for (const table of rebuilt) db.exec(`CREATE TEMP TABLE _sane_upgrade_${table} AS SELECT * FROM ${table}`)
  for (const item of expected(fromVersion).filter(item => rebuilt.includes(item.tbl_name) && item.type === "trigger")) db.exec(`DROP TRIGGER ${item.name}`)
  for (const table of rebuilt) db.exec(`DROP TABLE ${table}`)
  const target = expected(toVersion).filter(item => rebuilt.includes(item.tbl_name))
  for (const item of target.filter(item => item.type === "table")) db.exec(item.sql)
  db.exec(`INSERT INTO phase_assignments SELECT * FROM _sane_upgrade_phase_assignments;
    INSERT INTO store_metadata SELECT id,format,${toVersion},repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata`)
  for (const item of target.filter(item => item.type !== "table")) db.exec(item.sql)
  if (db.query(`SELECT * FROM _sane_upgrade_phase_assignments EXCEPT SELECT * FROM phase_assignments`).all().length
    || db.query(`SELECT * FROM phase_assignments EXCEPT SELECT * FROM _sane_upgrade_phase_assignments`).all().length
    || db.query(`SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata
      EXCEPT SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM store_metadata`).all().length) fail("CORRUPT_STORE", "Upgrade failed to preserve assignment/metadata history.")
  for (const table of rebuilt) db.exec(`DROP TABLE _sane_upgrade_${table}`)
  assertSchemaCapabilities(db, toVersion); assertStoreIntegrity(db)
}
/** v3 -> v4 broadens the handoffs status CHECK with awaiting_approval.
 * Child handoff_attempts is rebuilt alongside its parent so the FK stays
 * enforced throughout; no history rows are rewritten. */
function rebuildHandoffCapability(db: Database, fromVersion: 3, toVersion: 4): void {
  assertSchemaCapabilities(db, fromVersion); assertStoreIntegrity(db)
  const rebuilt = ["handoffs", "handoff_attempts", "store_metadata"]
  for (const table of rebuilt) db.exec(`CREATE TEMP TABLE _sane_upgrade_${table} AS SELECT * FROM ${table}`)
  for (const item of expected(fromVersion).filter(item => rebuilt.includes(item.tbl_name) && item.type === "trigger")) db.exec(`DROP TRIGGER ${item.name}`)
  // Child first so the parent drop never violates the enforced FK.
  for (const table of ["handoff_attempts", "handoffs", "store_metadata"]) db.exec(`DROP TABLE ${table}`)
  const target = expected(toVersion).filter(item => rebuilt.includes(item.tbl_name))
  // Parent first so the child FK resolves on creation.
  for (const table of ["store_metadata", "handoffs", "handoff_attempts"]) {
    const sql = target.find(item => item.type === "table" && item.tbl_name === table)?.sql ?? fail("CORRUPT_STORE", `Missing v${toVersion} table: ${table}.`)
    db.exec(sql)
  }
  db.exec(`INSERT INTO handoffs SELECT * FROM _sane_upgrade_handoffs;
    INSERT INTO handoff_attempts SELECT * FROM _sane_upgrade_handoff_attempts;
    INSERT INTO store_metadata SELECT id,format,${toVersion},repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata`)
  for (const item of target.filter(item => item.type !== "table")) db.exec(item.sql)
  if (db.query(`SELECT * FROM _sane_upgrade_handoffs EXCEPT SELECT * FROM handoffs`).all().length
    || db.query(`SELECT * FROM handoffs EXCEPT SELECT * FROM _sane_upgrade_handoffs`).all().length
    || db.query(`SELECT * FROM _sane_upgrade_handoff_attempts EXCEPT SELECT * FROM handoff_attempts`).all().length
    || db.query(`SELECT * FROM handoff_attempts EXCEPT SELECT * FROM _sane_upgrade_handoff_attempts`).all().length
    || db.query(`SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata
      EXCEPT SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM store_metadata`).all().length) fail("CORRUPT_STORE", "Upgrade failed to preserve handoff/metadata history.")
  for (const table of rebuilt) db.exec(`DROP TABLE _sane_upgrade_${table}`)
  assertSchemaCapabilities(db, toVersion); assertStoreIntegrity(db)
}
function rebuildJobsCapability(db: Database, fromVersion: 4, toVersion: 5): void {
  assertSchemaCapabilities(db, fromVersion); assertStoreIntegrity(db)
  const rebuilt = ["jobs", "store_metadata"]
  for (const table of rebuilt) db.exec(`CREATE TEMP TABLE _sane_upgrade_${table} AS SELECT * FROM ${table}`)
  for (const item of expected(fromVersion).filter(item => rebuilt.includes(item.tbl_name) && item.type === "trigger")) db.exec(`DROP TRIGGER ${item.name}`)
  for (const table of rebuilt) db.exec(`DROP TABLE ${table}`)
  const target = expected(toVersion).filter(item => rebuilt.includes(item.tbl_name))
  for (const item of target.filter(item => item.type === "table")) db.exec(item.sql)
  db.exec(`INSERT INTO jobs SELECT * FROM _sane_upgrade_jobs;
    INSERT INTO store_metadata SELECT id,format,${toVersion},repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata`)
  for (const item of target.filter(item => item.type !== "table")) db.exec(item.sql)
  if (db.query(`SELECT * FROM _sane_upgrade_jobs EXCEPT SELECT * FROM jobs`).all().length
    || db.query(`SELECT * FROM jobs EXCEPT SELECT * FROM _sane_upgrade_jobs`).all().length
    || db.query(`SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM _sane_upgrade_store_metadata
      EXCEPT SELECT id,format,repository_id,primary_checkout,common_dir,primary_pin,created_at FROM store_metadata`).all().length) fail("CORRUPT_STORE", "Upgrade failed to preserve jobs/metadata history.")
  for (const table of rebuilt) db.exec(`DROP TABLE _sane_upgrade_${table}`)
  assertSchemaCapabilities(db, toVersion); assertStoreIntegrity(db)
}
