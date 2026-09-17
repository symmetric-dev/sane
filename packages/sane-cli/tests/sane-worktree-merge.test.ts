/**
 * SANE 0.2.0 M5: worktree + merge protocol tests (docs/SANE_0_2_0.md Sec 4).
 *
 * Covers slug/branch naming, base_rev recorded, isolated-checks only
 * (no dev-server/migrate/deploy invocable), protocol order enforced,
 * cross-workstream overlap stops with report, and cleanup refused before
 * merge_commit recorded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  ALLOWED_WORKTREE_CHECKS,
  assertIsolatedCheckAllowed,
  branchName,
  createWorktree,
  defaultWorktreesDir,
  isIsolatedCheckAllowed,
  normalizeWorkstreamSlug,
  parseCliArguments as parseWorktreeArgs,
  removeWorktree,
  runCli as runWorktreeCli,
  USAGE as WORKTREE_USAGE,
  worktreePath,
} from "../src/sane-worktree-command.ts"
import {
  assertMergeStepOrder,
  checkConflictScope,
  CrossWorkstreamConflictError,
  MERGE_PROTOCOL_STEPS,
  mergeProtocol,
  parseCliArguments as parseMergeArgs,
  runCli as runMergeCli,
  runSaneMergeCommand,
  SaneMergeError,
  USAGE as MERGE_USAGE,
} from "../src/sane-merge-command.ts"
import {
  getMerge,
  initSchema,
  openSaneDb,
  recordMergeCommit,
  resolveSaneIdentity,
  upsertMerge,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

describe("sane worktree + merge (M5 Sec 4)", () => {
  let tempDirectory: string
  let repo: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-worktree-m5-"))
    repo = join(tempDirectory, "repo")
    await mkdir(repo, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", repo])
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"])
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"])
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // slug / branch naming
  // -------------------------------------------------------------------------

  test("slug/branch naming flattens separators (sane/<user>/<slug>)", () => {
    expect(normalizeWorkstreamSlug("01-csv-export")).toBe("01-csv-export")
    expect(normalizeWorkstreamSlug("nested/01-export")).toBe("nested-01-export")
    expect(normalizeWorkstreamSlug("a/b/c")).toBe("a-b-c")
    expect(branchName("alice", "01-csv-export")).toBe("sane/alice/01-csv-export")
    expect(branchName("alice", "nested/01-export")).toBe("sane/alice/nested-01-export")
    expect(branchName("bob", "a/b/c")).toBe("sane/bob/a-b-c")
    expect(worktreePath("/tmp/wt", "alice", "nested/01-export")).toBe(
      join("/tmp/wt", "alice", "nested-01-export"),
    )
    expect(defaultWorktreesDir(repo)).toBe(join(repo, ".sane", "worktrees"))
    expect(() => normalizeWorkstreamSlug("../outside")).toThrow()
    expect(() => normalizeWorkstreamSlug("/absolute")).toThrow()
    expect(() => branchName("", "01-x")).toThrow()
    expect(() => worktreePath("", "alice", "01-x")).toThrow()
  })

  // -------------------------------------------------------------------------
  // base_rev recorded
  // -------------------------------------------------------------------------

  test("createWorktree runs git worktree add and records base_rev", async () => {
    const calls: string[][] = []
    const result = await createWorktree(
      {
        repo,
        worktreesDir: join(tempDirectory, "wt"),
        user: "alice",
        workstreamId: "nested/01-export",
        baseRev: "abc123head",
        actorRole: "execution",
        sessionId: "ses-wt-1",
      },
      {
        execGit: async (args) => {
          calls.push(args)
          return ""
        },
      },
    )
    expect(result.branch).toBe("sane/alice/nested-01-export")
    expect(result.slug).toBe("nested-01-export")
    expect(result.worktreePath).toBe(join(tempDirectory, "wt", "alice", "nested-01-export"))
    expect(result.baseRev).toBe("abc123head")
    // git worktree add <path> -b <branch> <base_rev>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      "-C",
      result.repoRoot,
      "worktree",
      "add",
      result.worktreePath,
      "-b",
      "sane/alice/nested-01-export",
      "abc123head",
    ])

    const identity = await resolveSaneIdentity(repo, "nested/01-export", "alice")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      const row = getMerge(db, identity)
      expect(row).not.toBeNull()
      expect(row?.branch).toBe("sane/alice/nested-01-export")
      expect(row?.base_rev).toBe("abc123head")
      expect(row?.merge_commit).toBeNull()
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("only execution may create worktrees", async () => {
    await expect(
      createWorktree(
        {
          repo,
          worktreesDir: join(tempDirectory, "wt"),
          user: "alice",
          workstreamId: "01-x",
          baseRev: "abc",
          actorRole: "design",
        },
        { execGit: async () => "" },
      ),
    ).rejects.toThrow(/Only the execution role/)
  })

  // -------------------------------------------------------------------------
  // isolated checks only
  // -------------------------------------------------------------------------

  test("worktrees run isolated checks only (no dev-server/migrate/deploy)", () => {
    for (const allowed of ALLOWED_WORKTREE_CHECKS) {
      expect(() => assertIsolatedCheckAllowed(allowed)).not.toThrow()
      expect(isIsolatedCheckAllowed(allowed)).toBe(true)
    }
    expect(() => assertIsolatedCheckAllowed("typecheck")).not.toThrow()
    expect(() => assertIsolatedCheckAllowed("unit")).not.toThrow()
    expect(() => assertIsolatedCheckAllowed("lint")).not.toThrow()
    for (const forbidden of ["dev-server", "migrate", "deploy"]) {
      expect(() => assertIsolatedCheckAllowed(forbidden)).toThrow(/isolated checks only|Forbidden/)
      expect(isIsolatedCheckAllowed(forbidden)).toBe(false)
    }
    // Wrapped invocations are also refused.
    expect(() => assertIsolatedCheckAllowed("bun run dev-server")).toThrow(/Forbidden/)
    expect(() => assertIsolatedCheckAllowed("prisma migrate deploy")).toThrow(/Forbidden/)
    expect(() => assertIsolatedCheckAllowed("some-deploy-step")).toThrow()
    // Unknown checks are not silently allowed either.
    expect(() => assertIsolatedCheckAllowed("e2e-prod")).toThrow()
  })

  test("mergeProtocol only invokes isolated checks (never dev-server/migrate/deploy)", async () => {
    const seen: Array<{ scope: string; check: string }> = []
    const gitCalls: string[][] = []
    const result = await mergeProtocol(
      {
        repo,
        worktreesDir: join(tempDirectory, "wt"),
        user: "alice",
        workstreamId: "01-demo",
      },
      {
        execGit: async (args) => {
          gitCalls.push(args)
          if (args.includes("status")) return ""
          if (args.includes("rev-parse")) return "merge-sha-1"
          return ""
        },
        runChecks: async (scope, check) => {
          seen.push({ scope, check })
          // The protocol must never ask for forbidden commands.
          expect(check.toLowerCase()).not.toContain("dev-server")
          expect(check.toLowerCase()).not.toContain("migrate")
          expect(check.toLowerCase()).not.toContain("deploy")
          // Worktree scope additionally enforces isolated-only.
          if (scope === "worktree") assertIsolatedCheckAllowed(check)
        },
        reviewDiff: async () => {},
        requireUserApproval: async () => ({ approvalRef: "user-ok-merge" }),
        recordMergeCommit: async () => {},
      },
    )
    expect(result.completedSteps).toEqual([...MERGE_PROTOCOL_STEPS])
    expect(seen.map((s) => s.check)).toContain("typecheck")
    expect(seen.map((s) => s.check)).toContain("unit")
    for (const entry of seen) {
      expect(["typecheck", "unit", "lint", "smoke"].includes(entry.check)).toBe(true)
    }
    // Step 5 always uses --no-ff.
    const mergeCall = gitCalls.find((args) => args.includes("merge"))
    expect(mergeCall).toBeDefined()
    expect(mergeCall).toContain("--no-ff")
  })

  // -------------------------------------------------------------------------
  // protocol order enforced
  // -------------------------------------------------------------------------

  test("protocol order is enforced (skip-ahead refused)", () => {
    expect(() => assertMergeStepOrder([], "rebase")).not.toThrow()
    expect(() => assertMergeStepOrder(["rebase"], "checks")).not.toThrow()
    expect(() => assertMergeStepOrder([], "checks")).toThrow(/Protocol order violated/)
    expect(() => assertMergeStepOrder(["rebase"], "merge")).toThrow(/Protocol order violated/)
    expect(() => assertMergeStepOrder(["rebase", "checks"], "merge")).toThrow(
      /Protocol order violated/,
    )
    expect(() => assertMergeStepOrder(["rebase", "checks", "review"], "merge")).toThrow(
      /Protocol order violated/,
    )
    // Full prefix then next is ok.
    expect(() =>
      assertMergeStepOrder(["rebase", "checks", "review", "approval"], "merge"),
    ).not.toThrow()
    // Cleanup before record is refused.
    expect(() =>
      assertMergeStepOrder(
        ["rebase", "checks", "review", "approval", "merge", "main-checks"],
        "cleanup",
      ),
    ).toThrow(/Protocol order violated/)
  })

  test("mergeProtocol refuses merge without gate-5 approval", async () => {
    await expect(
      mergeProtocol(
        {
          repo,
          worktreesDir: join(tempDirectory, "wt"),
          user: "alice",
          workstreamId: "01-demo",
        },
        {
          execGit: async (args) => {
            if (args.includes("status")) return ""
            if (args.includes("rev-parse")) return "sha"
            return ""
          },
          runChecks: async () => {},
          reviewDiff: async () => {},
          requireUserApproval: async () => null,
          recordMergeCommit: async () => {},
        },
      ),
    ).rejects.toThrow(/gate-5.*approval|Merge refused/)
  })

  test("mergeProtocol refuses dirty main before --no-ff merge", async () => {
    await expect(
      mergeProtocol(
        {
          repo,
          worktreesDir: join(tempDirectory, "wt"),
          user: "alice",
          workstreamId: "01-demo",
        },
        {
          execGit: async (args) => {
            if (args.includes("status")) return " M dirty-file.ts"
            return ""
          },
          runChecks: async () => {},
          reviewDiff: async () => {},
          requireUserApproval: async () => ({ approvalRef: "user-ok" }),
          recordMergeCommit: async () => {},
        },
      ),
    ).rejects.toThrow(/not clean/)
  })

  test("merge CLI refuses --merge without gate-5 approval row", async () => {
    await expect(
      runSaneMergeCommand({
        implementationRepository: repo,
        workstreamPath: "01-demo",
        action: "merge",
        noFf: true,
        userOverride: "alice",
        write: () => {},
      }),
    ).rejects.toThrow(/gate-5/)
  })

  // -------------------------------------------------------------------------
  // cross-workstream overlap stops with report
  // -------------------------------------------------------------------------

  test("own-surface conflict returns own scope", () => {
    const result = checkConflictScope({
      ownWorkstreamId: "01-export",
      ownBaseRev: "base-aaa",
      conflictingPaths: ["packages/export/csv.ts"],
      activeWorkstreams: [
        { workstreamId: "02-import", baseRev: "base-bbb", paths: ["packages/import"] },
      ],
    })
    expect(result).toEqual({ scope: "own" })
  })

  test("cross-workstream overlap STOPs with both IDs/paths/base_revs", () => {
    let caught: unknown
    try {
      checkConflictScope({
        ownWorkstreamId: "01-export",
        ownBaseRev: "base-aaa",
        conflictingPaths: ["packages/shared/util.ts", "packages/export/only.ts"],
        activeWorkstreams: [
          { workstreamId: "02-import", baseRev: "base-bbb", paths: ["packages/shared"] },
        ],
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CrossWorkstreamConflictError)
    const report = (caught as CrossWorkstreamConflictError).report
    expect(report).toContain("01-export")
    expect(report).toContain("02-import")
    expect(report).toContain("base-aaa")
    expect(report).toContain("base-bbb")
    expect(report).toContain("packages/shared/util.ts")
    expect((caught as CrossWorkstreamConflictError).ownWorkstreamId).toBe("01-export")
    expect((caught as CrossWorkstreamConflictError).otherWorkstreamId).toBe("02-import")
    expect((caught as CrossWorkstreamConflictError).ownBaseRev).toBe("base-aaa")
    expect((caught as CrossWorkstreamConflictError).otherBaseRev).toBe("base-bbb")
    expect((caught as CrossWorkstreamConflictError).overlappingPaths).toContain(
      "packages/shared/util.ts",
    )
    expect((caught as Error).message).toMatch(/serialize|follow-up|user-directed approval/)
  })

  test("mergeProtocol surfaces cross-workstream STOP on rebase conflict", async () => {
    const conflict = new CrossWorkstreamConflictError({
      ownWorkstreamId: "01-export",
      otherWorkstreamId: "02-import",
      overlappingPaths: ["packages/shared/util.ts"],
      conflictingPaths: ["packages/shared/util.ts"],
      ownBaseRev: "base-aaa",
      otherBaseRev: "base-bbb",
      report: "Cross-workstream conflict STOP: 01-export vs 02-import",
    })
    await expect(
      mergeProtocol(
        {
          repo,
          worktreesDir: join(tempDirectory, "wt"),
          user: "alice",
          workstreamId: "01-export",
          ownBaseRev: "base-aaa",
          activeWorkstreams: [
            { workstreamId: "02-import", baseRev: "base-bbb", paths: ["packages/shared"] },
          ],
        },
        {
          execGit: async () => {
            throw conflict
          },
          runChecks: async () => {},
          reviewDiff: async () => {},
          requireUserApproval: async () => ({ approvalRef: "r" }),
          recordMergeCommit: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(CrossWorkstreamConflictError)
  })

  // -------------------------------------------------------------------------
  // cleanup refused before merge_commit recorded
  // -------------------------------------------------------------------------

  test("cleanup refused before merge_commit recorded; forced needs user", async () => {
    const wtDir = join(tempDirectory, "wt")
    await createWorktree(
      {
        repo,
        worktreesDir: wtDir,
        user: "alice",
        workstreamId: "01-demo",
        baseRev: "base-1",
        sessionId: "ses-1",
      },
      { execGit: async () => "" },
    )
    // Normal removal refuses while merge_commit is NULL.
    await expect(
      removeWorktree(
        { repo, worktreesDir: wtDir, user: "alice", workstreamId: "01-demo" },
        { execGit: async () => "" },
      ),
    ).rejects.toThrow(/Cleanup refused before merge_commit/)

    // Forced removal without user direction is also refused.
    await expect(
      removeWorktree(
        {
          repo,
          worktreesDir: wtDir,
          user: "alice",
          workstreamId: "01-demo",
          force: true,
          actorRole: "execution",
        },
        { execGit: async () => "" },
      ),
    ).rejects.toThrow(/explicit user direction/)

    // Forced removal with user direction succeeds (records --force git flag).
    const forcedCalls: string[][] = []
    const forced = await removeWorktree(
      {
        repo,
        worktreesDir: wtDir,
        user: "alice",
        workstreamId: "01-demo",
        force: true,
        actorRole: "user",
      },
      {
        execGit: async (args) => {
          forcedCalls.push(args)
          return ""
        },
      },
    )
    expect(forced.forced).toBe(true)
    expect(forcedCalls[0]).toContain("--force")

    // Record merge_commit, then normal cleanup succeeds.
    const identity = await resolveSaneIdentity(repo, "01-demo", "alice")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      // createWorktree wrote NULL; upsert a fresh row then record.
      upsertMerge(
        db,
        identity,
        { branch: "sane/alice/01-demo", baseRev: "base-1" },
        { actorRole: "execution", sessionId: "ses-2" },
      )
      recordMergeCommit(db, identity, "merge-sha-9", {
        actorRole: "execution",
        sessionId: "ses-2",
      })
      expect(getMerge(db, identity)?.merge_commit).toBe("merge-sha-9")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
    const calls: string[][] = []
    const cleaned = await removeWorktree(
      { repo, worktreesDir: wtDir, user: "alice", workstreamId: "01-demo" },
      {
        execGit: async (args) => {
          calls.push(args)
          return ""
        },
      },
    )
    expect(cleaned.forced).toBe(false)
    expect(calls[0]).toEqual(["-C", cleaned.repoRoot, "worktree", "remove", cleaned.worktreePath])
  })

  test("merge --cleanup CLI refuses before merge_commit recorded", async () => {
    const wtDir = join(tempDirectory, "wt-cli")
    await createWorktree(
      {
        repo,
        worktreesDir: wtDir,
        user: "alice",
        workstreamId: "01-cli",
        baseRev: "base-1",
        sessionId: "ses-cli",
      },
      { execGit: async () => "" },
    )
    await expect(
      runSaneMergeCommand({
        implementationRepository: repo,
        workstreamPath: "01-cli",
        action: "cleanup",
        worktreesDir: wtDir,
        userOverride: "alice",
        write: () => {},
      }),
    ).rejects.toThrow(/Cleanup refused before merge_commit/)
  })

  // -------------------------------------------------------------------------
  // CLI idioms (--json / --repo-root / single flags)
  // -------------------------------------------------------------------------

  test("worktree CLI parse matches --json/--repo-root idioms", () => {
    const parsed = parseWorktreeArgs([repo, "01-demo", "--create", "--base-rev", "abc", "--json"])
    expect(parsed).toMatchObject({ mode: "create", baseRev: "abc", json: true })
    const viaRoot = parseWorktreeArgs(["--repo-root", repo, "01-demo", "--remove", "--json"])
    expect(viaRoot.implementationRepository).toBe(repo)
    expect(viaRoot.workstreamPath).toBe("01-demo")
    expect(viaRoot.mode).toBe("remove")
    expect(viaRoot.json).toBe(true)
    const single = parseWorktreeArgs(["01-demo", "--create", "--base-rev", "abc"])
    expect(single.workstreamPath).toBe("01-demo")
    expect(single.implementationRepository).toBe(process.cwd())
    expect(() => parseWorktreeArgs([repo, "01-demo", "--create", "--bogus"])).toThrow(
      /Unknown option: --bogus/,
    )
    expect(() => parseWorktreeArgs([repo, "01-demo"])).toThrow(/exactly one of --create/)
    expect(() => parseWorktreeArgs([repo, "01-demo", "--create", "--remove"])).toThrow(
      /exactly one of --create/,
    )
    expect(() => parseWorktreeArgs([repo, "01-demo", "--create", "--force"])).toThrow(
      /--force applies only to --remove/,
    )
    expect(WORKTREE_USAGE).toContain("sane-alpha worktree")
    expect(WORKTREE_USAGE).toContain("--create")
    expect(WORKTREE_USAGE).toContain("--remove")
    expect(WORKTREE_USAGE).toContain("--json")
    expect(WORKTREE_USAGE).toContain("--repo-root")
  })

  test("merge CLI parse enforces --merge --no-ff and --record/--cleanup idioms", () => {
    const rebase = parseMergeArgs([repo, "01-demo", "--rebase"])
    expect(rebase.action).toBe("rebase")
    const withRoot = parseMergeArgs(["--repo-root", repo, "01-demo", "--checks", "--json"])
    expect(withRoot.implementationRepository).toBe(repo)
    expect(withRoot.json).toBe(true)
    const merge = parseMergeArgs([repo, "01-demo", "--merge", "--no-ff"])
    expect(merge.action).toBe("merge")
    expect(merge.noFf).toBe(true)
    const record = parseMergeArgs([repo, "01-demo", "--record", "deadbeef"])
    expect(record.action).toBe("record")
    expect(record.recordCommit).toBe("deadbeef")
    expect(() => parseMergeArgs([repo, "01-demo", "--merge"])).toThrow(/requires --no-ff/)
    expect(() => parseMergeArgs([repo, "01-demo", "--checks", "--no-ff"])).toThrow(
      /applies only to --merge/,
    )
    expect(() => parseMergeArgs([repo, "01-demo"])).toThrow(/exactly one of/)
    expect(() => parseMergeArgs([repo, "01-demo", "--rebase", "--checks"])).toThrow(
      /exactly one of/,
    )
    expect(() => parseMergeArgs([repo, "01-demo", "--bogus"])).toThrow(/Unknown option/)
    expect(MERGE_USAGE).toContain("sane-alpha merge")
    expect(MERGE_USAGE).toContain("--rebase")
    expect(MERGE_USAGE).toContain("--no-ff")
    expect(MERGE_USAGE).toContain("--record")
    expect(MERGE_USAGE).toContain("--cleanup")
  })

  test("worktree/merge runCli returns 0/1", async () => {
    expect(await runWorktreeCli([repo, "01-demo", "--bogus"])).toBe(1)
    expect(await runMergeCli([repo, "01-demo", "--bogus"])).toBe(1)
    expect(await runMergeCli([repo, "01-demo", "--merge"])).toBe(1)
  })

  test("merge --record CLI persists merge_commit (step 7)", async () => {
    const wtDir = join(tempDirectory, "wt-record")
    await createWorktree(
      {
        repo,
        worktreesDir: wtDir,
        user: "alice",
        workstreamId: "01-record",
        baseRev: "base-1",
        sessionId: "ses-record",
      },
      { execGit: async () => "" },
    )
    const lines: string[] = []
    const result = await runSaneMergeCommand({
      implementationRepository: repo,
      workstreamPath: "01-record",
      action: "record",
      recordCommit: "merge-sha-record",
      worktreesDir: wtDir,
      userOverride: "alice",
      json: true,
      write: (line) => lines.push(line),
    })
    expect(result.action).toBe("record")
    const identity = await resolveSaneIdentity(repo, "01-record", "alice")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(getMerge(db, identity)?.merge_commit).toBe("merge-sha-record")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
    expect(() => JSON.parse(lines.join("\n"))).not.toThrow()
  })

  test("SaneMergeError is thrown for invalid merge inputs", async () => {
    await expect(
      mergeProtocol(
        { repo: "", worktreesDir: "/tmp", user: "alice", workstreamId: "01-x" },
        {
          execGit: async () => "",
          runChecks: async () => {},
          reviewDiff: async () => {},
          requireUserApproval: async () => ({ approvalRef: "r" }),
          recordMergeCommit: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(SaneMergeError)
  })
})
