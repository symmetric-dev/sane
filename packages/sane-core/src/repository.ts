import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { CheckoutPin, RepositoryContext, RepositoryDiscovery, StoreAvailability } from "./contracts.ts"
import { DomainError, fail, storageError } from "./errors.ts"
import { SCHEMA } from "./schema.ts"

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
  for (const path of [discovery.stateRoot, join(discovery.stateRoot,"workstreams"), join(discovery.stateRoot,"locks"), ...["", "-wal", "-shm", "-journal"].map(s => discovery.databasePath + s), join(discovery.stateRoot, "complete.json")]) {
    let stat
    try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error }
    const directory = [discovery.stateRoot, join(discovery.stateRoot,"workstreams"), join(discovery.stateRoot,"locks")].includes(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("CORRUPT_STORE", `Unsafe domain path: ${path}`)
  }
}
export function inspectRepositoryStore(discovery: RepositoryDiscovery): StoreAvailability {
  let db: Database | undefined
  try {
    checkDiscovery(discovery); safeStoreFiles(discovery)
    if (!existsSync(discovery.stateRoot) || readdirSync(discovery.stateRoot).length === 0) return { state: "uninitialized", code: "NOT_INITIALIZED", message: `Not initialized: ${discovery.stateRoot}`, path: discovery.stateRoot }
    if (!existsSync(discovery.databasePath)) fail("INCOMPLETE_INITIALIZATION", `Missing database/completion marker in nonempty ${discovery.stateRoot}; no adoption or overwrite is supported.`)
    db = new Database(discovery.databasePath, { readonly: true, create: false, strict: true })
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000")
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_metadata'").get()) fail("UNSUPPORTED_SCHEMA", `Unsupported schema at ${discovery.databasePath}. Expected sane-domain v1.`)
    const row = db.query<any, []>("SELECT * FROM store_metadata WHERE id=1").get()
    if (!row || row.format !== "sane-domain" || row.version !== 1) fail("UNSUPPORTED_SCHEMA", `Unsupported sane-domain version at ${discovery.databasePath}. Expected v1.`)
    const objects = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master").all().map(o => o.name))
    for (const match of SCHEMA.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) (\w+)/g)) if (!objects.has(match[1]!)) fail("CORRUPT_STORE", `Missing required schema object ${match[1]} at ${discovery.databasePath}.`)
    if (!existsSync(join(discovery.stateRoot, "complete.json"))) fail("INCOMPLETE_INITIALIZATION", `Missing completion marker: ${join(discovery.stateRoot,"complete.json")}`)
    const marker = JSON.parse(readFileSync(join(discovery.stateRoot, "complete.json"), "utf8"))
    if (marker.format !== "sane-domain" || marker.version !== 1 || marker.repositoryId !== row.repository_id) fail("CORRUPT_STORE", "Domain completion marker does not match metadata.")
    if (row.primary_checkout !== discovery.primaryCheckout || row.common_dir !== discovery.commonDir || !samePin(JSON.parse(row.primary_pin), discovery.primaryPin)) fail("STALE_BINDING", "Domain database belongs to different repository filesystem evidence; relocation/adoption is unsupported.")
    if ((db.query<any, []>("PRAGMA quick_check").get()?.quick_check) !== "ok" || db.query("PRAGMA foreign_key_check").all().length) fail("CORRUPT_STORE", "Domain integrity check failed.")
    if (db.query("SELECT w.id FROM workstreams w LEFT JOIN phase_states p ON p.workstream_id=w.id GROUP BY w.id HAVING count(p.phase)!=4").all().length) fail("CORRUPT_STORE", "Workstream is missing lifecycle phase rows.")
    for (const name of ["workstreams", "locks"]) if (!existsSync(join(discovery.stateRoot, name))) fail("CORRUPT_STORE", `Missing domain directory ${name}.`)
    return { state: "ready", context: { ...discovery, repositoryId: row.repository_id, schemaVersion: 1 } }
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
      db!.query("INSERT INTO store_metadata VALUES(1,'sane-domain',1,?,?,?,?,?)").run(repositoryId, discovery.primaryCheckout, discovery.commonDir, JSON.stringify(discovery.primaryPin), new Date().toISOString())
    }).immediate()
    mkdirSync(join(discovery.stateRoot, "workstreams"), { mode: 0o700 }); mkdirSync(join(discovery.stateRoot, "locks"), { mode: 0o700 })
    writeFileSync(join(discovery.stateRoot, "complete.json"), JSON.stringify({ format: "sane-domain", version: 1, repositoryId }), { flag: "wx", mode: 0o600 })
    return { ...discovery, repositoryId, schemaVersion: 1 }
  } catch (error) { return storageError(error) } finally { db?.close() }
}
export function revalidateCheckout(context: RepositoryContext, pin: CheckoutPin): CheckoutPin {
  checkDiscovery(context)
  const current = pinCheckout(pin.path, context.commonDir)
  if (!samePin(current, pin)) fail("STALE_BINDING", `Checkout binding changed: ${pin.path}`)
  return current
}
