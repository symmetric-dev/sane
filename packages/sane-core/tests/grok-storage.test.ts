import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { RegisterConversationInput, RepositoryDiscovery } from "../src/contracts.ts"
import { DomainError } from "../src/errors.ts"
import { normalizeNativeSource } from "../src/native-source.ts"
import { discoverRepository, inspectRepositoryStore, upgradeRepository } from "../src/repository.ts"
import { SCHEMA_V5, SCHEMA_V6 } from "../src/schema.ts"
import { migrateV5ToV6 } from "../src/schema-upgrade.ts"
import { openRepositoryDomain } from "../src/server.ts"

const temporaryRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode"
const createdDirectories: string[] = []
const closers: Array<{ close(): void }> = []

function fixtureRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(realpathSync(temporaryRoot), prefix)))
  createdDirectories.push(root)
  return root
}

afterEach(() => {
  for (const closer of closers.splice(0)) closer.close()
  for (const root of createdDirectories.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})

function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim()
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function snapshot(db: Database) {
  return {
    metadata: db.query("SELECT repository_id, primary_checkout, common_dir, primary_pin, created_at, version FROM store_metadata WHERE id=1").get(),
    authorities: db.query("SELECT harness, authority_id, kind, locator FROM native_authorities ORDER BY harness, authority_id").all(),
    conversations: db.query("SELECT id, harness, authority_id, native_id, execution_pin_id, parent_id, created_at FROM conversations ORDER BY id").all(),
    fixtureAudit: db.query("SELECT id, correlation_id, actor_kind, actor_conversation_id, operation, workstream_id, entity_id, details, timestamp FROM audit_events WHERE operation='fixture' ORDER BY id").all(),
  }
}

function readStore(path: string) {
  const db = new Database(path, { readonly: true, create: false, strict: true })
  try { return snapshot(db) } finally { db.close() }
}

// Completed v5 store. initializeRepository would write v6, so this seeder must not call it.
function seedV5() {
  const temporary = fixtureRoot("sane-storage-")
  const checkout = join(temporary, "repo")
  mkdirSync(checkout)
  git(checkout, "init", "-q")
  git(checkout, "-c", "user.name=Core Test", "-c", "user.email=core@example.invalid", "commit", "--allow-empty", "-qm", "fixture")
  const discovery = discoverRepository(realpathSync(checkout))
  mkdirSync(discovery.stateRoot, { mode: 0o700 })
  mkdirSync(join(discovery.stateRoot, "workstreams"), { mode: 0o700 })
  mkdirSync(join(discovery.stateRoot, "locks"), { mode: 0o700 })
  const profile = join(temporary, "profile")
  mkdirSync(profile)
  const source = normalizeNativeSource({ profileRoot: profile, kind: "local-profile", harness: "cc", version: 1 })
  const repositoryId = randomUUID()
  const createdAt = new Date().toISOString()
  const pinId = randomUUID()
  const pin = discovery.primaryPin
  const db = new Database(discovery.databasePath, { strict: true })
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL")
    db.exec(SCHEMA_V5)
    db.query("INSERT INTO store_metadata VALUES(1,'sane-domain',5,?,?,?,?,?)").run(repositoryId, discovery.primaryCheckout, discovery.commonDir, JSON.stringify(pin), createdAt)
    db.query("INSERT INTO checkout_pins VALUES(?,?,?,?,?,?,?,?,?,?)").run(pinId, pin.path, pin.commonDir, pin.gitDir, pin.device, pin.inode, pin.commonDevice, pin.commonInode, pin.gitDevice, pin.gitInode)
    db.query("INSERT INTO native_authorities VALUES(?,?,?,?)").run(source.descriptor.harness, source.authorityId, source.descriptor.kind, source.descriptor.profileRoot)
    db.query("INSERT INTO conversations VALUES(?,?,?,?,?,?,?)").run(randomUUID(), "cc", source.authorityId, randomUUID(), pinId, null, createdAt)
    db.query("INSERT INTO audit_events(correlation_id,actor_kind,actor_conversation_id,operation,workstream_id,entity_id,details,timestamp) VALUES(?,?,?,?,?,?,?,?)").run("fixture", "local", null, "fixture", null, null, "{}", createdAt)
    const markerPath = join(discovery.stateRoot, "complete.json")
    writeFileSync(markerPath, JSON.stringify({ format: "sane-domain", version: 5, repositoryId }), { flag: "wx", mode: 0o600 })
    const seeded = snapshot(db)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return { temporary, discovery, profile, markerPath, seeded }
  } finally { db.close() }
}

function absentUpgradeMarkers(discovery: RepositoryDiscovery) {
  expect(existsSync(join(discovery.stateRoot, "upgrading.json"))).toBe(false)
  expect(existsSync(join(discovery.stateRoot, ".complete-upgrade.json"))).toBe(false)
}

describe("grok storage contract", () => {
  test("Claude and OpenCode descriptor bytes are unchanged", () => {
    let root = fixtureRoot("descriptor-")
    for (let attempt = 0; root.includes("gk") || root.includes("homeRoot"); attempt++) {
      if (attempt === 4) throw new Error("Could not allocate a descriptor fixture path without gk.")
      root = fixtureRoot("descriptor-")
    }
    const profile = join(root, "profile")
    const registration = join(root, "registration.json")
    const home = join(root, "home")
    mkdirSync(profile)
    mkdirSync(home)
    writeFileSync(registration, "generated registration fixture")
    const claudeInput = { profileRoot: profile, kind: "local-profile" as const, harness: "cc" as const, version: 1 as const }
    const openCodeInput = { registrationFile: registration, kind: "local-registration" as const, harness: "oc" as const, version: 1 as const }
    const grokInput = { homeRoot: home, kind: "local-home" as const, harness: "gk" as const, version: 1 as const }
    const claude = normalizeNativeSource(claudeInput)
    const openCode = normalizeNativeSource(openCodeInput)
    const grok = normalizeNativeSource(grokInput)
    const canonicalProfile = realpathSync(profile)
    const canonicalFile = realpathSync(registration)
    const canonicalHome = realpathSync(home)
    const claudeSerialized = `{"version":1,"harness":"cc","kind":"local-profile","profileRoot":${JSON.stringify(canonicalProfile)}}`
    const openCodeSerialized = `{"version":1,"harness":"oc","kind":"local-registration","registrationFile":${JSON.stringify(canonicalFile)}}`
    const grokSerialized = `{"version":1,"harness":"gk","kind":"local-home","homeRoot":${JSON.stringify(canonicalHome)}}`

    expect(Object.keys(claude.descriptor)).toEqual(["version", "harness", "kind", "profileRoot"])
    expect(JSON.stringify(claude.descriptor)).toBe(claudeSerialized)
    expect(claude.authorityId).toBe(`sane-native-v1:cc:${sha256(claudeSerialized)}`)
    expect(claudeInput).toEqual({ profileRoot: profile, kind: "local-profile", harness: "cc", version: 1 })
    expect(Object.keys(openCode.descriptor)).toEqual(["version", "harness", "kind", "registrationFile"])
    expect(JSON.stringify(openCode.descriptor)).toBe(openCodeSerialized)
    expect(openCode.authorityId).toBe(`sane-native-v1:oc:${sha256(openCodeSerialized)}`)
    expect(openCodeInput).toEqual({ registrationFile: registration, kind: "local-registration", harness: "oc", version: 1 })
    expect(canonicalHome).not.toBe(canonicalProfile)
    expect(Object.keys(grok.descriptor)).toEqual(["version", "harness", "kind", "homeRoot"])
    expect(JSON.stringify(grok.descriptor)).toBe(grokSerialized)
    expect(grok.authorityId).toBe(`sane-native-v1:gk:${sha256(grokSerialized)}`)
    expect(grok.authorityId.startsWith("sane-native-v1:gk:")).toBe(true)
    expect(sha256(grokSerialized)).not.toBe(sha256(claudeSerialized))
    expect(claudeSerialized).not.toContain("homeRoot")
    expect(claudeSerialized).not.toContain("gk")
    expect(grokInput).toEqual({ homeRoot: home, kind: "local-home", harness: "gk", version: 1 })
    expect(SCHEMA_V5.includes("gk")).toBe(false)
    expect(SCHEMA_V5.includes("local-home")).toBe(false)
    expect(SCHEMA_V6.includes("CHECK(harness IN ('cc','oc','gk'))")).toBe(true)
    expect(SCHEMA_V6.includes("local-home")).toBe(true)
  })

  test("Opening a v5 repository does not migrate", () => {
    const { discovery, markerPath, seeded } = seedV5()
    const marker = readFileSync(markerPath)
    absentUpgradeMarkers(discovery)
    const availability = inspectRepositoryStore(discovery)
    expect(availability).toMatchObject({ state: "unsupported", code: "UNSUPPORTED_SCHEMA" })
    absentUpgradeMarkers(discovery)
    expect(readFileSync(markerPath).equals(marker)).toBe(true)
    const after = readStore(discovery.databasePath)
    expect(after.metadata).toEqual(seeded.metadata)
    expect((after.metadata as { version: number }).version).toBe(5)
    expect(after.authorities).toEqual(seeded.authorities)
    expect(after.conversations).toEqual(seeded.conversations)
  })

  test("Explicit upgrade preserves those rows and is the only writer", () => {
    const { discovery, seeded } = seedV5()
    const result = upgradeRepository(discovery)
    expect(result.operation).toBe("upgrade")
    expect(result.fromVersion).toBe(5)
    expect(result.toVersion).toBe(6)
    expect(result.changed).toBe(true)
    const availability = inspectRepositoryStore(discovery)
    expect(availability.state).toBe("ready")
    if (availability.state !== "ready") throw new Error(availability.message)
    expect(availability.context.schemaVersion).toBe(6)
    const after = readStore(discovery.databasePath)
    expect(after.authorities).toEqual(seeded.authorities)
    expect(after.conversations).toEqual(seeded.conversations)
    expect(after.fixtureAudit).toEqual(seeded.fixtureAudit)
    expect(after.fixtureAudit).toHaveLength(1)
    const beforeMetadata = seeded.metadata as { repository_id: string; primary_checkout: string; common_dir: string; primary_pin: string; created_at: string; version: number }
    const afterMetadata = after.metadata as typeof beforeMetadata
    expect(afterMetadata.repository_id).toBe(beforeMetadata.repository_id)
    expect(afterMetadata.primary_checkout).toBe(beforeMetadata.primary_checkout)
    expect(afterMetadata.common_dir).toBe(beforeMetadata.common_dir)
    expect(afterMetadata.primary_pin).toBe(beforeMetadata.primary_pin)
    expect(afterMetadata.created_at).toBe(beforeMetadata.created_at)
    expect(beforeMetadata.version).toBe(5)
    expect(afterMetadata.version).toBe(6)
    if (!result.context) throw new Error("upgradeRepository did not return a context")
    const domain = openRepositoryDomain(result.context)
    closers.push(domain)
    try {
      const beforeCount = domain.listConversations().length
      const home = join(discovery.stateRoot, "..", "grok-home")
      mkdirSync(home)
      const grok = domain.declareGrokAuthority({ version: 1, harness: "gk", kind: "local-home", homeRoot: home }, { actor: { kind: "local" }, correlationId: "grok-storage-test" })
      expect(domain.listConversations()).toHaveLength(beforeCount)
      const probe = new Database(discovery.databasePath, { readonly: true, create: false, strict: true })
      try {
        probe.exec("PRAGMA busy_timeout=1000")
        expect(probe.query("SELECT harness, authority_id, kind, locator FROM native_authorities WHERE harness='gk'").get()).toEqual({
          harness: "gk", authority_id: grok.authorityId, kind: "local-home", locator: grok.descriptor.homeRoot,
        })
      } finally { probe.close() }
      let caught: unknown
      try {
        domain.registerConversation({
          ref: { harness: "gk", authorityId: grok.authorityId, nativeId: randomUUID() },
          executionCheckout: discovery.primaryCheckout,
        } as unknown as RegisterConversationInput, { actor: { kind: "local" }, correlationId: "grok-storage-test" })
      } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(DomainError)
      expect((caught as DomainError).code).toBe("INVALID_INPUT")
      expect((caught as DomainError).message).toBe("Expected qualified native reference.")
      expect(domain.listConversations()).toHaveLength(beforeCount)
      expect(domain.getConversation({ harness: "cc", authorityId: grok.authorityId, nativeId: randomUUID() })).toBeNull()
    } finally { domain.close() }
  })

  test("A failed v5-to-v6 copy does not delete rows", () => {
    const { discovery, seeded } = seedV5()
    const db = new Database(discovery.databasePath, { strict: true })
    closers.push(db)
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=1000")
      let copied = false
      let caught: unknown
      try {
        db.transaction(() => {
          migrateV5ToV6(db)
          expect((db.query("SELECT version FROM store_metadata WHERE id=1").get() as { version: number }).version).toBe(6)
          copied = true
          throw new DomainError("CORRUPT_STORE", "Upgrade failed to preserve conversations history. No history was deleted.")
        }).immediate()
      } catch (error) {
        if (!copied) throw error
        caught = error
      }
      expect(copied).toBe(true)
      expect(caught).toBeInstanceOf(DomainError)
      expect((caught as DomainError).code).toBe("CORRUPT_STORE")
      expect((caught as DomainError).message).toBe("Upgrade failed to preserve conversations history. No history was deleted.")
      const after = snapshot(db)
      expect((after.metadata as { version: number }).version).toBe(5)
      expect(after.metadata).toEqual(seeded.metadata)
      expect(after.authorities).toEqual(seeded.authorities)
      expect(after.conversations).toEqual(seeded.conversations)
      expect(after.conversations).toHaveLength(1)
      absentUpgradeMarkers(discovery)
    } finally { db.close() }
  })
})
