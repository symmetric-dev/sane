/**
 * CWD-based target auto-detection: resolver unit tests plus bare-invocation
 * coverage for `state`, `pickup`, and `research` via their `runCli` entry
 * points (no positionals).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  resolveCommandAddress,
  resolveCwdTarget,
} from "../src/sane-cwd-target.ts"
import {
  branchForWorkstream,
  currentUser,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  upsertSelection,
  type SaneIdentity,
} from "../src/sane-db.ts"
import { resolveImplementationRepository } from "../src/sane-repository.ts"
import { runCli as runPickupCli } from "../src/sane-pickup-command.ts"
import { runCli as runResearchCli } from "../src/sane-research-command.ts"
import { runCli as runStateCli } from "../src/sane-state-command.ts"

const execFileAsync = promisify(execFile)

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" })
  return stdout.trim()
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(previous)
  }
}

async function captureOutput(fn: () => Promise<number>): Promise<{
  exit: number
  out: string
  err: string
}> {
  const out: string[] = []
  const err: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "))
  }
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(" "))
  }
  try {
    const exit = await fn()
    return { exit, out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

describe("sane-cwd-target resolver", () => {
  let tempDirectory = ""
  let repo = ""
  let repoRoot = ""
  let user = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-cwd-"))
    repo = join(tempDirectory, "repo")
    await mkdir(repo, { recursive: true })
    await git(["init", "--quiet", repo])
    await git(["-C", repo, "config", "user.email", "test@example.com"])
    await git(["-C", repo, "config", "user.name", "Test"])
    await writeFile(join(repo, "README.md"), "fixture\n")
    await git(["-C", repo, "add", "."])
    await git(["-C", repo, "commit", "--quiet", "-m", "init"])
    await initializeSaneRepository({ implementationRepository: repo, write: () => {} })
    await createSaneRepositoryWorkstream({
      implementationRepository: repo,
      workstreamPath: "01-demo",
      type: "feature",
      write: () => {},
    })
    repoRoot = await resolveImplementationRepository(repo)
    user = currentUser()
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  async function registerSelection(
    identity: SaneIdentity,
    worktreePath: string,
    sessionId: string,
  ): Promise<void> {
    const db = await openSaneDb(repoRoot)
    try {
      initSchema(db)
      upsertSelection(
        db,
        identity,
        {
          slot: "execution",
          sessionId,
          worktreePath,
          branch: branchForWorkstream(identity.user, identity.workstreamId),
        },
        { actorRole: "execution", sessionId },
      )
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  async function addWorktree(name: string, workstreamId = "01-demo"): Promise<string> {
    const wtDir = join(tempDirectory, name)
    await git([
      "-C",
      repoRoot,
      "worktree",
      "add",
      wtDir,
      "-b",
      branchForWorkstream(user, workstreamId),
    ])
    return wtDir
  }

  test("main-repo context resolves the current-workstream pointer", async () => {
    const fromRoot = await resolveCwdTarget(repoRoot)
    expect(fromRoot).toMatchObject({
      repoRoot,
      workstreamId: "01-demo",
      user,
      source: "main-pointer",
    })
    const nested = join(repoRoot, ".sane", "workstreams", "01-demo")
    const fromNested = await resolveCwdTarget(nested)
    expect(fromNested).toMatchObject({ repoRoot, workstreamId: "01-demo" })
  })

  test("main-repo context without a pointer names select-workstream", async () => {
    const bare = join(tempDirectory, "bare")
    await mkdir(bare, { recursive: true })
    await git(["init", "--quiet", bare])
    await initializeSaneRepository({ implementationRepository: bare, write: () => {} })
    await expect(resolveCwdTarget(bare)).rejects.toThrow("select-workstream")
  })

  test("worktree context matches the selections row", async () => {
    const wtDir = await addWorktree("wt-01")
    const identity = await resolveSaneIdentity(repoRoot, "01-demo", user)
    await registerSelection(identity, wtDir, "ses-wt-01")
    const target = await resolveCwdTarget(wtDir)
    expect(target).toMatchObject({
      repoRoot,
      workstreamId: "01-demo",
      user,
      source: "worktree-selection",
    })
  })

  test("worktree match compares realpath-resolved paths", async () => {
    const wtDir = await addWorktree("wt-real")
    const link = join(tempDirectory, "wt-link")
    await symlink(wtDir, link)
    // Register the symlinked spelling; resolve from the physical path (and
    // vice versa). A lexical compare would miss; realpath must match.
    const identity = await resolveSaneIdentity(repoRoot, "01-demo", user)
    await registerSelection(identity, link, "ses-wt-link")
    expect((await resolveCwdTarget(wtDir)).workstreamId).toBe("01-demo")
    expect((await resolveCwdTarget(link)).workstreamId).toBe("01-demo")
  })

  test("worktree without a matching row asks for explicit args", async () => {
    const wtDir = await addWorktree("wt-ghost", "99-ghost")
    await expect(resolveCwdTarget(wtDir)).rejects.toThrow("explicitly")
  })

  test("outside any git tree asks for explicit args", async () => {
    const plain = join(tempDirectory, "plain")
    await mkdir(plain, { recursive: true })
    await expect(resolveCwdTarget(plain)).rejects.toThrow("explicitly")
  })

  test("ambiguous worktree registrations error", async () => {
    await createSaneRepositoryWorkstream({
      implementationRepository: repo,
      workstreamPath: "02-other",
      type: "feature",
      write: () => {},
    })
    const wtDir = join(tempDirectory, "wt-shared")
    await git(["-C", repoRoot, "worktree", "add", wtDir, "-b", branchForWorkstream(user, "01-demo")])
    await registerSelection(await resolveSaneIdentity(repoRoot, "01-demo", user), wtDir, "ses-a")
    await registerSelection(await resolveSaneIdentity(repoRoot, "02-other", user), wtDir, "ses-b")
    await expect(resolveCwdTarget(wtDir)).rejects.toThrow("Ambiguous")
  })

  test("a single other-user registration is adopted", async () => {
    const wtDir = await addWorktree("wt-other")
    await registerSelection(
      { repoRoot, user: "someone-else", workstreamId: "01-demo" },
      wtDir,
      "ses-other",
    )
    const target = await resolveCwdTarget(wtDir)
    expect(target).toMatchObject({ workstreamId: "01-demo", user: "someone-else" })
  })

  test("an explicit user never falls back to another user's registration", async () => {
    const wtDir = await addWorktree("wt-strict")
    await registerSelection(
      { repoRoot, user: "someone-else", workstreamId: "01-demo" },
      wtDir,
      "ses-strict",
    )
    await expect(resolveCwdTarget(wtDir, "nobody-here")).rejects.toThrow("explicitly")
  })

  test("explicit addresses win without touching git or the DB", async () => {
    const plain = join(tempDirectory, "plain-explicit")
    await mkdir(plain, { recursive: true })
    // CWD is outside any git tree; an explicit address must still pass through.
    const address = await resolveCommandAddress(
      { implementationRepository: "/explicit/repo", workstreamPath: "ws-name" },
      { cwd: plain },
    )
    expect(address).toEqual({
      implementationRepository: "/explicit/repo",
      workstreamPath: "ws-name",
      userOverride: undefined,
    })
    const withUser = await resolveCommandAddress(
      { implementationRepository: "/explicit/repo", workstreamPath: "ws-name" },
      { cwd: plain, userOverride: "alice" },
    )
    expect(withUser.userOverride).toBe("alice")
  })

  test("bare addresses delegate to CWD detection", async () => {
    const address = await resolveCommandAddress(
      { implementationRepository: "", workstreamPath: "" },
      { cwd: repoRoot },
    )
    expect(address).toMatchObject({
      implementationRepository: repoRoot,
      workstreamPath: "01-demo",
      userOverride: user,
    })
  })
})

describe("bare invocation via runCli (state, pickup, research)", () => {
  let tempDirectory = ""
  let repo = ""
  let repoRoot = ""
  let user = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-cwd-cli-"))
    repo = join(tempDirectory, "repo")
    await mkdir(repo, { recursive: true })
    await git(["init", "--quiet", repo])
    await git(["-C", repo, "config", "user.email", "test@example.com"])
    await git(["-C", repo, "config", "user.name", "Test"])
    await writeFile(join(repo, "README.md"), "fixture\n")
    await git(["-C", repo, "add", "."])
    await git(["-C", repo, "commit", "--quiet", "-m", "init"])
    await initializeSaneRepository({ implementationRepository: repo, write: () => {} })
    await createSaneRepositoryWorkstream({
      implementationRepository: repo,
      workstreamPath: "01-demo",
      type: "feature",
      write: () => {},
    })
    repoRoot = await resolveImplementationRepository(repo)
    user = currentUser()
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  async function addRegisteredWorktree(): Promise<string> {
    const wtDir = join(tempDirectory, "wt-cli")
    await git(["-C", repoRoot, "worktree", "add", wtDir, "-b", branchForWorkstream(user, "01-demo")])
    const identity = await resolveSaneIdentity(repoRoot, "01-demo", user)
    const db = await openSaneDb(repoRoot)
    try {
      initSchema(db)
      upsertSelection(
        db,
        identity,
        {
          slot: "execution",
          sessionId: "ses-wt-cli",
          worktreePath: wtDir,
          branch: branchForWorkstream(user, "01-demo"),
        },
        { actorRole: "execution", sessionId: "ses-wt-cli" },
      )
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
    return wtDir
  }

  test("state bare from the main repo", async () => {
    const result = await withCwd(repoRoot, () => captureOutput(() => runStateCli([])))
    expect(result.exit).toBe(0)
    expect(result.out).toContain("01-demo")
  })

  test("state bare from a registered worktree", async () => {
    const wtDir = await addRegisteredWorktree()
    const result = await withCwd(wtDir, () => captureOutput(() => runStateCli([])))
    expect(result.exit).toBe(0)
    expect(result.out).toContain("01-demo")
  })

  test("pickup bare from the main repo", async () => {
    const result = await withCwd(repoRoot, () => captureOutput(() => runPickupCli([])))
    expect(result.exit).toBe(0)
    expect(result.out).toContain("01-demo")
  })

  test("research bare from the main repo and from a worktree", async () => {
    const fromMain = await withCwd(repoRoot, () => captureOutput(() => runResearchCli([])))
    expect(fromMain.exit).toBe(0)
    expect(fromMain.out).toContain("research index: 01-demo")
    const wtDir = await addRegisteredWorktree()
    const fromWorktree = await withCwd(wtDir, () => captureOutput(() => runResearchCli([])))
    expect(fromWorktree.exit).toBe(0)
    expect(fromWorktree.out).toContain("research index: 01-demo")
  })

  test("bare outside any git tree exits 1 with explicit-args guidance", async () => {
    const plain = join(tempDirectory, "plain-cli")
    await mkdir(plain, { recursive: true })
    const result = await withCwd(plain, () => captureOutput(() => runStateCli([])))
    expect(result.exit).toBe(1)
    expect(result.err).toContain("explicitly")
  })
})
