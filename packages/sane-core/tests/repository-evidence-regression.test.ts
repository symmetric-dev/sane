import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkDiscovery, discoverRepository, inspectRepositoryStore, revalidateCheckout } from "../src/repository.ts"
import { fixture, git } from "./fixtures.ts"

test("captured discovery refuses a replacement primary directory even with its original Git and store", async () => {
  const f = fixture()
  try {
    const discovery = await discoverRepository(f.repo)
    f.domain.close()
    const saved = f.repo + "-saved"
    renameSync(f.repo, saved); mkdirSync(f.repo)
    for (const name of [".git", ".sane"]) renameSync(join(saved, name), join(f.repo, name))
    await expect(Promise.resolve().then(() => checkDiscovery(discovery))).rejects.toMatchObject({ code: "STALE_BINDING" })
    expect(await inspectRepositoryStore(discovery)).toMatchObject({ state: "stale-binding", code: "STALE_BINDING" })
    // Rediscovery must not adopt a persisted store bound to the old inode either.
    expect(await inspectRepositoryStore(await discoverRepository(f.repo))).toMatchObject({ state: "stale-binding", code: "STALE_BINDING" })
  } finally { f.cleanup() }
})

test("an execution pin refuses a replaced linked worktree and an independent clone", async () => {
  const f = fixture(true)
  try {
    const pin = f.context.invocationCheckout
    renameSync(f.checkout, f.checkout + "-saved"); mkdirSync(f.checkout)
    renameSync(join(f.checkout + "-saved", ".git"), join(f.checkout, ".git"))
    await expect(Promise.resolve().then(() => revalidateCheckout(f.context, pin))).rejects.toMatchObject({ code: "STALE_BINDING" })
    const clone = join(f.temporary, "clone")
    git(f.repo, "clone", "-q", f.repo, clone)
    const foreign = await discoverRepository(clone)
    await expect(Promise.resolve().then(() => revalidateCheckout(f.context, foreign.invocationCheckout))).rejects.toMatchObject({ code: "INVALID_CHECKOUT" })
  } finally { f.cleanup() }
})

test("inspection rechecks completion evidence and recovers only after valid evidence is restored", async () => {
  const f = fixture()
  try {
    const discovery = await discoverRepository(f.repo), marker = join(f.stateRoot, "complete.json")
    const original = readFileSync(marker, "utf8")
    expect((await inspectRepositoryStore(discovery)).state).toBe("ready")
    for (const contents of ["{broken", JSON.stringify({ ...JSON.parse(original), repositoryId: crypto.randomUUID() })]) {
      writeFileSync(marker, contents)
      expect(await inspectRepositoryStore(discovery)).toMatchObject({ state: "corrupt", code: "CORRUPT_STORE" })
      expect(readFileSync(marker, "utf8")).toBe(contents)
    }
    writeFileSync(marker, original)
    expect(await inspectRepositoryStore(discovery)).toMatchObject({ state: "ready", context: { repositoryId: f.context.repositoryId } })
  } finally { f.cleanup() }
})
