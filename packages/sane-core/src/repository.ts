import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { CheckoutPin, RepositoryContext, RepositoryDiscovery, StoreAvailability } from "./contracts.ts"
import { DomainError, fail, storageError } from "./errors.ts"
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts"
import { assertSchemaCapabilities, assertStoreIntegrity, migrateV1ToV2 } from "./schema-upgrade.ts"

export function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim()
}
export function pinCheckout(path: string, expectedCommon?: string): CheckoutPin {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("An absolute checkout is required.")
    const canonical = realpathSync(path)
    const [top, commonPath, adminPath] = git(canonical, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir").split("\n")
    if (canonical !== realpathSync(top!)) throw new Error("Expected checkout root.")
    const commonDir = realpathSync(commonPath!)
    const gitDir = realpathSync(adminPath!)
    if (expectedCommon && commonDir !== expectedCommon) throw new Error("Checkout belongs to another repository.")
    const stat = statSync(canonical), common = statSync(commonDir), admin = statSync(gitDir)
    return { path: canonical, commonDir, gitDir, device: stat.dev, inode: stat.ino, commonDevice: common.dev, commonInode: common.ino, gitDevice: admin.dev, gitInode: admin.ino }
  } catch (error) { return fail("INVALID_CHECKOUT", `Invalid checkout ${String(path)}: ${(error as Error).message}`) }
}
export function samePin(a: CheckoutPin, b: CheckoutPin): boolean {
  return (["path", "commonDir", "gitDir", "device", "inode", "commonDevice", "commonInode", "gitDevice", "gitInode"] as const).every(k => a[k] === b[k])
}
export function discoverRepository(path: string): RepositoryDiscovery {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) fail("INVALID_CONTEXT", "Supply an absolute repository path.")
    const cwd = realpathSync(path)
    if (git(cwd, "rev-parse", "--is-bare-repository") === "true") fail("FEATURE_UNAVAILABLE", "Bare repositories have no supported primary checkout.")
    const invocationCheckout = pinCheckout(realpathSync(git(cwd, "rev-parse", "--show-toplevel")))
    // Porcelain -z avoids quoted/escaped path parsing; Git lists the primary first.
    const first = git(cwd, "worktree", "list", "--porcelain", "-z").split("\0")[0]!
    if (!first.startsWith("worktree ")) fail("INVALID_CONTEXT", "Git did not identify a primary checkout.")
    // With --separate-git-dir and no core.worktree, Git may enumerate its
    // administration directory instead of the primary checkout. A direct
    // primary invocation still has conclusive top-level + git-dir evidence.
    // A linked invocation without that evidence must not guess a sibling path.
    const enumerated = realpathSync(first.slice(9))
    const primaryPath = enumerated === invocationCheckout.commonDir
      ? invocationCheckout.gitDir === invocationCheckout.commonDir ? invocationCheckout.path : git(enumerated, "rev-parse", "--show-toplevel")
      : enumerated
    let primaryPin: CheckoutPin
    try { primaryPin = pinCheckout(primaryPath, invocationCheckout.commonDir) }
    catch (error) { return fail("INVALID_CONTEXT", `Git cannot locate a valid primary checkout from ${path}; nonstandard Git administration requires unambiguous Git worktree/core.worktree evidence. ${(error as Error).message}`) }
    if (primaryPin.gitDir !== primaryPin.commonDir) fail("INVALID_CONTEXT", "Git primary checkout evidence is inconsistent.")
    const stateRoot = join(primaryPin.path, ".sane")
    return { primaryCheckout: primaryPin.path, commonDir: primaryPin.commonDir, stateRoot, databasePath: join(stateRoot, "sane.db"), primaryPin, invocationCheckout }
  } catch (error) { if (error instanceof DomainError) throw error; return fail("INVALID_CONTEXT", `Cannot discover repository: ${(error as Error).message}`) }
}
export function checkDiscovery(discovery: RepositoryDiscovery): void {
  const actual = pinCheckout(discovery.primaryCheckout)
  const stateRoot = join(actual.path, ".sane")
  if (!samePin(actual, discovery.primaryPin) || actual.gitDir !== actual.commonDir || stateRoot !== discovery.stateRoot || join(stateRoot,"sane.db") !== discovery.databasePath || actual.commonDir !== discovery.commonDir) fail("STALE_BINDING", "Repository primary/common-directory binding changed.")
}
export function safeStoreFiles(discovery: RepositoryDiscovery): void {
  for (const path of [discovery.stateRoot, join(discovery.stateRoot,"workstreams"), join(discovery.stateRoot,"locks"), ...["", "-wal", "-shm", "-journal"].map(s => discovery.databasePath + s), ...["complete.json", "upgrading.json", ".complete-upgrade.json"].map(name => join(discovery.stateRoot, name))]) {
    let stat
    try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error }
    const directory = [discovery.stateRoot, join(discovery.stateRoot,"workstreams"), join(discovery.stateRoot,"locks")].includes(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("CORRUPT_STORE", `Unsafe domain path: ${path}`)
  }
}
/** Shared by ordinary inspection and explicit upgrade; only upgrade may examine a split marker. */
function validateStore(db: Database, discovery: RepositoryDiscovery, recovery = false): { row: any; marker: any } {
  checkDiscovery(discovery); safeStoreFiles(discovery)
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_metadata'").get()) fail("UNSUPPORTED_SCHEMA", `Unsupported schema at ${discovery.databasePath}. Expected sane-domain.`)
  const row = db.query<any, []>("SELECT * FROM store_metadata WHERE id=1").get()
  if (!row || row.format !== "sane-domain" || ![1, SCHEMA_VERSION].includes(row.version)) fail("UNSUPPORTED_SCHEMA", `Unsupported sane-domain version at ${discovery.databasePath}.`)
  assertSchemaCapabilities(db, row.version)
  if (!existsSync(join(discovery.stateRoot, "complete.json"))) fail("INCOMPLETE_INITIALIZATION", "Missing domain completion marker; upgrade cannot adopt a partial initialization.")
  const marker = JSON.parse(readFileSync(join(discovery.stateRoot, "complete.json"), "utf8"))
  if (marker.format !== "sane-domain" || marker.repositoryId !== row.repository_id || ![1, SCHEMA_VERSION].includes(marker.version) || (!recovery && marker.version !== row.version)) fail("CORRUPT_STORE", "Domain completion marker does not match metadata.")
  if (row.primary_checkout !== discovery.primaryCheckout || row.common_dir !== discovery.commonDir || !samePin(JSON.parse(row.primary_pin), discovery.primaryPin)) fail("STALE_BINDING", "Domain database belongs to different repository filesystem evidence; relocation/adoption is unsupported.")
  assertStoreIntegrity(db)
  for (const name of ["workstreams", "locks"]) if (!existsSync(join(discovery.stateRoot, name))) fail("CORRUPT_STORE", `Missing domain directory ${name}.`)
  return { row, marker }
}
export function inspectRepositoryStore(discovery: RepositoryDiscovery): StoreAvailability {
  let db: Database | undefined
  try {
    checkDiscovery(discovery); safeStoreFiles(discovery)
    if (!existsSync(discovery.stateRoot) || readdirSync(discovery.stateRoot).length === 0) return { state: "uninitialized", code: "NOT_INITIALIZED", message: `Not initialized: ${discovery.stateRoot}`, path: discovery.stateRoot }
    if (!existsSync(discovery.databasePath)) fail("INCOMPLETE_INITIALIZATION", `Missing database/completion marker in nonempty ${discovery.stateRoot}; no adoption or overwrite is supported.`)
    if (existsSync(join(discovery.stateRoot, "upgrading.json")) || existsSync(join(discovery.stateRoot, ".complete-upgrade.json"))) fail("INCOMPLETE_INITIALIZATION", "Explicit schema upgrade is pending; close other SANE processes and rerun sane upgrade locally.")
    db = new Database(discovery.databasePath, { readonly: true, create: false, strict: true })
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000")
    const { row } = validateStore(db, discovery)
    if (row.version !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", "sane-domain v1 requires an explicit local sane upgrade (or sane upgrade --dry-run); no implicit migration is supported.")
    return { state: "ready", context: { ...discovery, repositoryId: row.repository_id, schemaVersion: SCHEMA_VERSION } }
  } catch (error) {
    const code = error instanceof DomainError ? error.code : /busy|locked/i.test(String(error)) ? "BUSY" : /permission|EACCES|EPERM/i.test(String(error)) ? "UNAVAILABLE" : "CORRUPT_STORE"
    const state = code === "STALE_BINDING" || code === "INVALID_CHECKOUT" || code === "INVALID_CONTEXT" ? "stale-binding" : code === "UNSUPPORTED_SCHEMA" ? "unsupported" : code === "UNAVAILABLE" || code === "BUSY" ? "unavailable" : "corrupt"
    return { state, code, message: (error as Error).message, path: discovery.databasePath }
  } finally { db?.close() }
}
export function initializeRepository(discovery: RepositoryDiscovery): RepositoryContext {
  const availability = inspectRepositoryStore(discovery)
  if (availability.state === "ready") return availability.context
  if (availability.state !== "uninitialized") fail(availability.code, availability.message)
  let db: Database | undefined
  try {
    checkDiscovery(discovery)
    if (!existsSync(discovery.stateRoot)) mkdirSync(discovery.stateRoot, { mode: 0o700 })
    safeStoreFiles(discovery)
    // Exclusive ownership is internal to the fresh destination and intentionally
    // remains on crash. No initializer adopts or resets a partial directory.
    writeFileSync(join(discovery.stateRoot, "initializing.json"), JSON.stringify({ pid: process.pid, token: randomUUID() }), { flag: "wx", mode: 0o600 })
    if (readdirSync(discovery.stateRoot).some(n => n !== "initializing.json")) fail("CONFLICT", "Domain destination became nonempty during initialization.")
    writeFileSync(discovery.databasePath, "", { flag: "wx", mode: 0o600 })
    db = new Database(discovery.databasePath, { create: false, strict: true })
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000")
    const repositoryId = randomUUID()
    db.transaction(() => {
      db!.exec(SCHEMA)
      db!.query("INSERT INTO store_metadata VALUES(1,'sane-domain',?, ?,?,?,?,?)").run(SCHEMA_VERSION, repositoryId, discovery.primaryCheckout, discovery.commonDir, JSON.stringify(discovery.primaryPin), new Date().toISOString())
    }).immediate()
    mkdirSync(join(discovery.stateRoot, "workstreams"), { mode: 0o700 }); mkdirSync(join(discovery.stateRoot, "locks"), { mode: 0o700 })
    writeFileSync(join(discovery.stateRoot, "complete.json"), JSON.stringify({ format: "sane-domain", version: SCHEMA_VERSION, repositoryId }), { flag: "wx", mode: 0o600 })
    return { ...discovery, repositoryId, schemaVersion: SCHEMA_VERSION }
  } catch (error) { return storageError(error) } finally { db?.close() }
}
interface UpgradeJournal { format: "sane-domain-upgrade"; version: 1; repositoryId: string; fromVersion: 1; toVersion: 2; token: string; pid: number; host: string; processStart: string; bootId: string }
export interface RepositoryUpgrade { operation: "upgrade"; dryRun: boolean; repositoryId: string; fromVersion: 1 | 2; toVersion: 2; changed: boolean; recovery: boolean; context?: RepositoryContext }
function syncPath(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd) } finally { closeSync(fd) } }
function bootIdentity(): string {
  try {
    if (process.platform === "darwin") {
      const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/)
      if (!boot) fail("UNAVAILABLE", "Cannot parse OS boot identity.")
      return `darwin:${boot[1]}:${boot[2]}`
    }
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch { fail("UNAVAILABLE", "Cannot establish OS boot identity; refusing automatic upgrade/recovery.") }
  return fail("FEATURE_UNAVAILABLE", "Safe upgrade process identification is supported only on macOS and Linux.")
}
function processStart(pid: number): string {
  try {
    const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }).trim()
    if (start) return start
  } catch { /* A concurrent exit is handled by the caller's liveness recheck. */ }
  return fail("BUSY", "Cannot establish process-instance identity; refusing recovery. Do not stop an unrelated process or remove the journal.")
}
function journalAt(path: string): UpgradeJournal {
  const value = JSON.parse(readFileSync(path, "utf8"))
  if (!value || value.format !== "sane-domain-upgrade" || value.version !== 1 || value.fromVersion !== 1 || value.toVersion !== 2 || typeof value.repositoryId !== "string" || typeof value.token !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.host !== hostname() || typeof value.processStart !== "string" || !value.processStart || typeof value.bootId !== "string" || !value.bootId) fail("CORRUPT_STORE", "Invalid or foreign-host upgrade journal; automatic recovery is unsafe.")
  return value
}
function assertOwnerStopped(journal: UpgradeJournal): void {
  if (journal.bootId !== bootIdentity()) return
  try { process.kill(journal.pid, 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; fail("BUSY", "Cannot establish that the previous upgrade process stopped.") }
  try { if (processStart(journal.pid) !== journal.processStart) return }
  catch (error) {
    try { process.kill(journal.pid, 0) } catch (exit) { if ((exit as NodeJS.ErrnoException).code === "ESRCH") return }
    throw error
  }
  fail("BUSY", "The recorded upgrade process instance is still alive. Close that SANE upgrade process before retrying; do not remove the journal manually.")
}
/** Filesystem-only capture: SQLite never opens the real store during dry-run.
 * Copy DB + WAL (not SHM) only when repeated bytes and filesystem evidence agree.
 * SQLite may rebuild auxiliary files in this disposable private directory, not .sane.
 */
function dryRunSnapshot(discovery: RepositoryDiscovery): { path: string; dispose: () => void } {
  const capture = () => {
    safeStoreFiles(discovery)
    return ["", "-wal", "-journal"].map(suffix => {
      const path = discovery.databasePath + suffix
      if (!existsSync(path)) return { suffix, bytes: null, evidence: "absent" }
      const before = lstatSync(path), bytes = readFileSync(path), after = lstatSync(path)
      const evidence = (stat: typeof before) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
      if (evidence(before) !== evidence(after)) fail("BUSY", "Store changed during read-only upgrade capture; stop other SANE processes and retry.")
      // A rollback journal can require recovery writes. Never simulate/adopt that recovery.
      if (suffix === "-journal" && bytes.length) fail("BUSY", "Rollback journal present; dry-run cannot safely inspect an unrecovered store.")
      return { suffix, bytes, evidence: evidence(after) }
    })
  }
  const first = capture(), second = capture()
  if (first.some((file, i) => file.evidence !== second[i]!.evidence || (file.bytes === null ? second[i]!.bytes !== null : !second[i]!.bytes || !file.bytes.equals(second[i]!.bytes!)))) fail("BUSY", "Store changed during read-only upgrade capture; stop other SANE processes and retry.")
  const directory = mkdtempSync(join(tmpdir(), "sane-upgrade-inspect-")), path = join(directory, "sane.db")
  try {
    for (const file of second) if (file.bytes && file.suffix !== "-journal") writeFileSync(path + file.suffix, file.bytes, { flag: "wx", mode: 0o600 })
    return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
/** Human/local maintenance only. Never called by native enrollment or ordinary mutations.
 * DB changes commit atomically. The durable journal + audit token allow only an explicit
 * retry to publish/finish the marker after interruption; ordinary handles fail closed.
 */
export function upgradeRepository(discovery: RepositoryDiscovery, options: { dryRun?: boolean } = {}): RepositoryUpgrade {
  let db: Database | undefined
  let snapshot: ReturnType<typeof dryRunSnapshot> | undefined
  const journalPath = join(discovery.stateRoot, "upgrading.json"), markerPath = join(discovery.stateRoot, "complete.json"), stagedPath = join(discovery.stateRoot, ".complete-upgrade.json")
  try {
    checkDiscovery(discovery); safeStoreFiles(discovery)
    if (!samePin(pinCheckout(discovery.invocationCheckout.path, discovery.commonDir), discovery.invocationCheckout)) fail("STALE_BINDING", "Upgrade invocation checkout changed.")
    if (!existsSync(discovery.databasePath)) fail("NOT_INITIALIZED", "Upgrade requires an existing completed sane-domain store; it never initializes or adopts one.")
    const identity = lstatSync(discovery.databasePath)
    let journal = existsSync(journalPath) ? journalAt(journalPath) : undefined
    const recovery = Boolean(journal)
    if (journal) assertOwnerStopped(journal)
    if (!journal && existsSync(stagedPath)) fail("CORRUPT_STORE", "Orphaned upgrade marker without journal; refusing adoption.")
    // Inspect a byte-stable private copy for dry-run, including uncheckpointed WAL history.
    if (options.dryRun) snapshot = dryRunSnapshot(discovery)
    db = new Database(snapshot?.path ?? discovery.databasePath, { readonly: true, create: false, strict: true })
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000")
    const before = validateStore(db, discovery, recovery)
    const checkRecovery = (database: Database, row: any, marker: any) => {
      if (!journal) { if (row.version !== marker.version) fail("CORRUPT_STORE", "Version disagreement without an upgrade journal."); return }
      if (journal.repositoryId !== row.repository_id || marker.version > row.version) fail("CORRUPT_STORE", "Upgrade journal/marker/metadata disagreement.")
      const events = database.query<any, [string]>("SELECT * FROM audit_events WHERE correlation_id=? AND operation='schema_upgraded'").all(journal.token)
      if (row.version === 2 && (events.length !== 1 || events[0].actor_kind !== "local" || events[0].entity_id !== row.repository_id || events[0].details !== JSON.stringify({ fromVersion: 1, toVersion: 2 }))) fail("CORRUPT_STORE", "Committed upgrade is missing its transactional audit evidence.")
      if (row.version === 1 && (events.length || marker.version !== 1 || existsSync(stagedPath))) fail("CORRUPT_STORE", "Uncommitted upgrade has inconsistent publication evidence.")
    }
    checkRecovery(db, before.row, before.marker)
    const result: RepositoryUpgrade = { operation: "upgrade", dryRun: Boolean(options.dryRun), repositoryId: before.row.repository_id, fromVersion: before.row.version, toVersion: 2, changed: before.row.version === 1 || recovery, recovery }
    if (options.dryRun) return result
    if (!result.changed) return { ...result, context: { ...discovery, repositoryId: result.repositoryId, schemaVersion: SCHEMA_VERSION } }
    db.close(); db = undefined
    // Recovery retains the original token and owner evidence. SQLite IMMEDIATE serializes
    // concurrent explicit retries; publication is also performed while holding that lock.
    const checkBinding = () => {
      checkDiscovery(discovery); safeStoreFiles(discovery)
      if (!samePin(pinCheckout(discovery.invocationCheckout.path, discovery.commonDir), discovery.invocationCheckout)) fail("STALE_BINDING", "Upgrade invocation checkout changed.")
      const actual = lstatSync(discovery.databasePath)
      if (actual.dev !== identity.dev || actual.ino !== identity.ino) fail("STALE_BINDING", "Upgrade database binding changed.")
      if (journal ? JSON.stringify(journalAt(journalPath)) !== JSON.stringify(journal) : existsSync(journalPath)) fail("BUSY", "Upgrade journal binding changed; another upgrade may be active.")
    }
    checkBinding()
    db = new Database(discovery.databasePath, { create: false, strict: true })
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL")
    db.transaction(() => {
      checkBinding()
      const current = validateStore(db!, discovery, Boolean(journal))
      if (current.row.repository_id !== result.repositoryId) fail("STALE_BINDING", "Upgrade repository UUID changed.")
      checkRecovery(db!, current.row, current.marker)
      if (!journal) {
        if (current.row.version !== before.row.version || existsSync(stagedPath)) fail("CONFLICT", "Store changed before upgrade admission; retry explicitly.")
        const owner: UpgradeJournal = { format: "sane-domain-upgrade", version: 1, repositoryId: result.repositoryId, fromVersion: 1, toVersion: 2, token: randomUUID(), pid: process.pid, host: hostname(), processStart: processStart(process.pid), bootId: bootIdentity() }
        const temporary = join(discovery.stateRoot, `.upgrading-${owner.token}.json`)
        // Publication is atomic, and admission is serialized by SQLite IMMEDIATE.
        // A crash before rename leaves only an inert private temp and rolls back the DB.
        writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); syncPath(temporary)
        checkBinding(); renameSync(temporary, journalPath); syncPath(discovery.stateRoot)
        journal = owner
      }
      if (current.row.version === 1) {
        migrateV1ToV2(db!)
        db!.query("INSERT INTO audit_events(correlation_id,actor_kind,operation,entity_id,details,timestamp) VALUES(?,'local','schema_upgraded',?,?,?)").run(journal!.token, result.repositoryId, JSON.stringify({ fromVersion: 1, toVersion: 2 }), new Date().toISOString())
      }
    }).immediate()
    // DB commit precedes publication. A crash here leaves a recoverable, unavailable store.
    db.transaction(() => {
      checkBinding()
      const current = validateStore(db!, discovery, true); checkRecovery(db!, current.row, current.marker)
      if (current.row.version !== 2) fail("CORRUPT_STORE", "Upgrade did not commit v2 metadata.")
      const marker = JSON.stringify({ ...current.marker, version: SCHEMA_VERSION })
      // Staging has no authority: reconstruct even a truncated interrupted write from
      // the validated journal, transactional audit token, metadata and original marker.
      if (existsSync(stagedPath)) unlinkSync(stagedPath)
      writeFileSync(stagedPath, marker, { flag: "wx", mode: 0o600 }); syncPath(stagedPath); syncPath(discovery.stateRoot)
      renameSync(stagedPath, markerPath); syncPath(discovery.stateRoot)
      validateStore(db!, discovery)
      unlinkSync(journalPath); syncPath(discovery.stateRoot)
    }).immediate()
    const state = inspectRepositoryStore(discovery)
    if (state.state !== "ready") fail(state.code, state.message)
    return { ...result, context: state.context }
  } catch (error) { return storageError(error) } finally { try { db?.close() } finally { snapshot?.dispose() } }
}
export function revalidateCheckout(context: RepositoryContext, pin: CheckoutPin): CheckoutPin {
  checkDiscovery(context)
  const current = pinCheckout(pin.path, context.commonDir)
  if (!samePin(current, pin)) fail("STALE_BINDING", `Checkout binding changed: ${pin.path}`)
  return current
}
