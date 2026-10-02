/** Private SQLite capabilities and explicit history-preserving upgrades. */
import { Database } from "bun:sqlite"
import { fail } from "./errors.ts"
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, CANONICAL_PHASE_SQL } from "./schema.ts"

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string }
const definitions = new Map<number, SchemaObject[]>()
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ").replace(/;$/, "")
function objects(db: Database): SchemaObject[] {
  return db.query<SchemaObject, []>("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()
}
function expected(version: 1 | 2 | 3): SchemaObject[] {
  let result = definitions.get(version)
  if (!result) {
    const model = new Database(":memory:", { strict: true })
    try { model.exec(version === 1 ? SCHEMA_V1 : version === 2 ? SCHEMA_V2 : SCHEMA_V3); result = objects(model); definitions.set(version, result) }
    finally { model.close() }
  }
  return result
}
/** Check definitions, not merely object names: constraints and history triggers are capabilities. */
export function assertSchemaCapabilities(db: Database, version: 1 | 2 | 3): void {
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
/** Deliberate v1 -> v2 -> v3 path within the caller's single transaction. */
export function migrateToCurrent(db: Database, fromVersion: 1 | 2): void {
  if (fromVersion === 1) migrateV1ToV2(db)
  migrateV2ToV3(db)
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
