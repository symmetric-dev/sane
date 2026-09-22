/**
 * SANE 0.2.0: `sane research` command.
 *
 * Research is an append-only archive of `research/<topic>/REPORT.md` files
 * indexed in the `research_reports` table (docs/SANE_0_2_0.md Sec 2).
 * - `--index` (default) prints topic, relative path, and file status, plus
 *   unregistered files. `--verbose` adds creation time, hash, and commit.
 * - `--register --topic <t> [--path <p>] [--git-commit <c>]` hashes the report
 *   file and upserts its registry row. Re-registering refreshes the row.
 * - `--unregister --topic <t>` removes a registry row (index repair).
 *
 * Research has no approval semantics: these commands record and report only. Freshness
 * warnings surface through pickup, not here.
 *
 * Supports `--json` and `--repo-root` detection idioms matching existing
 * CLIs. No dispatcher wiring here (bin/sane.ts stays with the
 * integrator).
 */

import { lstat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import {
  deleteResearchReport,
  getResearchReport,
  initSchema,
  listResearchReports,
  openSaneDb,
  registerResearchReport,
  resolveSaneIdentity,
} from "./sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { hashFile, normalizeGitCommit } from "./sane-hash.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  SaneWorkstreamStateError,
  recheckResearchIndex,
} from "./sane-workstream-state.ts"

export type SaneResearchMode = "index" | "register" | "unregister"

export interface SaneResearchCommandOptions {
  implementationRepository: string
  workstreamPath: string
  mode: SaneResearchMode
  topic?: string
  reportPath?: string
  gitCommit?: string | null
  json?: boolean
  verbose?: boolean
  userOverride?: string
  sessionId?: string
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane research [<implementation-repository> <workstream-relative-path>] [--index|--register|--unregister] [--topic <topic>] [--path <report-path>] [--git-commit <commit>] [--json] [--verbose] [--repo-root <path>] (default: compact index; --verbose: hashes, timestamps and commits; no positionals: auto-detect target)"

function singleLine(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined
  if (value.includes("\n") || value.trim() === "") {
    throw new SaneWorkstreamStateError(`Option ${option} must be a non-empty single-line value.`)
  }
  return value
}

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  mode: SaneResearchMode
  topic?: string
  reportPath?: string
  gitCommit?: string | null
  json: boolean
  verbose?: boolean
} {
  let json = false
  let verbose = false
  let index = false
  let register = false
  let unregister = false
  let topic: string | undefined
  let reportPath: string | undefined
  let gitCommit: string | null | undefined
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let indexArg = 0; indexArg < args.length; indexArg += 1) {
    const argument = args[indexArg]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--verbose") {
      verbose = true
    } else if (parseOptions && argument === "--index") {
      if (index) throw new SaneWorkstreamStateError("Option --index may be provided only once.")
      index = true
    } else if (parseOptions && argument === "--register") {
      if (register) throw new SaneWorkstreamStateError("Option --register may be provided only once.")
      register = true
    } else if (parseOptions && argument === "--unregister") {
      if (unregister) throw new SaneWorkstreamStateError("Option --unregister may be provided only once.")
      unregister = true
    } else if (parseOptions && argument === "--topic") {
      const value = args[indexArg + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --topic requires a value.")
      }
      if (topic !== undefined) {
        throw new SaneWorkstreamStateError("Option --topic may be provided only once.")
      }
      topic = singleLine(value, "--topic")
      indexArg += 1
    } else if (parseOptions && argument === "--path") {
      const value = args[indexArg + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --path requires a value.")
      }
      if (reportPath !== undefined) {
        throw new SaneWorkstreamStateError("Option --path may be provided only once.")
      }
      reportPath = singleLine(value, "--path")
      indexArg += 1
    } else if (parseOptions && argument === "--git-commit") {
      const value = args[indexArg + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --git-commit requires a value.")
      }
      if (gitCommit !== undefined) {
        throw new SaneWorkstreamStateError("Option --git-commit may be provided only once.")
      }
      gitCommit = singleLine(value, "--git-commit") ?? null
      indexArg += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[indexArg + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneWorkstreamStateError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      indexArg += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  const modes = [index, register, unregister].filter(Boolean).length
  if (modes > 1) {
    throw new SaneWorkstreamStateError("Provide at most one of --index, --register, --unregister.")
  }
  const mode: SaneResearchMode = register ? "register" : unregister ? "unregister" : "index"
  if ((mode === "register" || mode === "unregister") && topic === undefined) {
    throw new SaneWorkstreamStateError(`Option --topic is required with --${mode}.`)
  }
  if (reportPath !== undefined && mode !== "register") {
    throw new SaneWorkstreamStateError("Option --path requires --register.")
  }
  if (gitCommit !== undefined && mode !== "register") {
    throw new SaneWorkstreamStateError("Option --git-commit requires --register.")
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneWorkstreamStateError(
        "Provide exactly one workstream relative path when --repo-root is used.",
      )
    }
    implementationRepository = repoRootOpt
    workstreamPath = positional[0]
  } else if (positional.length === 2 && positional[0] && positional[1]) {
    implementationRepository = positional[0]
    workstreamPath = positional[1]
  } else if (positional.length === 1 && positional[0]) {
    implementationRepository = process.cwd()
    workstreamPath = positional[0]
  } else if (positional.length === 0) {
    // Bare invocation: the async run path auto-detects the target from CWD.
    implementationRepository = ""
    workstreamPath = ""
  } else {
    throw new SaneWorkstreamStateError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  return { implementationRepository, workstreamPath, mode, topic, reportPath, gitCommit, json, ...(verbose ? { verbose } : {}) }
}

/** Resolve a workstream-relative report path; reject absolute paths and escapes. */
function resolveReportPath(workstreamDir: string, topic: string, reportPath?: string): { relative: string; absolute: string } {
  const relativePath = reportPath ?? `research/${topic}/REPORT.md`
  const absolute = resolve(workstreamDir, relativePath)
  const rootRelative = relative(workstreamDir, absolute)
  if (rootRelative === "" || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
    throw new SaneWorkstreamStateError(
      `Report path must stay inside the workstream: ${JSON.stringify(relativePath)}`,
    )
  }
  return { relative: rootRelative.split(sep).join("/"), absolute }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

function shortHash(value: string): string {
  if (!value) return "(unhashed)"
  return `${value.slice(0, 12)}…`
}

/** Print the research index: registered rows plus unregistered files on disk. */
export async function runSaneResearchCommand(options: SaneResearchCommandOptions): Promise<void> {
  const write = options.write ?? console.log
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  )
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  )
  const db = await openSaneDb(pointer.implementationRepository)
  const sessionId = options.sessionId ?? `cli-research-${Date.now()}`
  const timestamp = new Date().toISOString()
  try {
    initSchema(db)
    if (options.mode === "register") {
      const topic = options.topic!
      const { relative, absolute } = resolveReportPath(workstream.path, topic, options.reportPath)
      if (!(await isRegularFile(absolute))) {
        throw new SaneWorkstreamStateError(`Report file missing, nothing registered: ${absolute}`)
      }
      const row = registerResearchReport(
        db,
        identity,
        {
          topic,
          path: relative,
          createdAt: timestamp,
          saneHash: await hashFile(absolute),
          gitCommit: normalizeGitCommit(options.gitCommit ?? null),
        },
        { actorRole: "research", sessionId, timestamp },
      )
      if (options.json === true) {
        write(JSON.stringify({
          repo_root: identity.repoRoot,
          user: identity.user,
          workstream_id: identity.workstreamId,
          mode: "register",
          topic: row.topic,
          path: row.path,
          created_at: row.created_at,
          sane_hash: row.sane_hash,
          git_commit: row.git_commit,
        }, null, 2))
        return
      }
      write(`registered ${JSON.stringify(row.topic)}: ${row.sane_hash.slice(0, 12)}… ${row.path}`)
      return
    }

    if (options.mode === "unregister") {
      const topic = options.topic!
      const existing = getResearchReport(db, identity, topic)
      if (!existing) {
        throw new SaneWorkstreamStateError(`No research report registered for topic ${JSON.stringify(topic)}.`)
      }
      deleteResearchReport(db, identity, topic, { actorRole: "research", sessionId, timestamp })
      if (options.json === true) {
        write(JSON.stringify({
          repo_root: identity.repoRoot,
          user: identity.user,
          workstream_id: identity.workstreamId,
          mode: "unregister",
          topic,
        }, null, 2))
        return
      }
      write(`unregistered ${JSON.stringify(topic)}`)
      return
    }

    const { reports, unregisteredFiles } = await recheckResearchIndex(db, identity, workstream.path)
    const rows = listResearchReports(db, identity)
    const byTopic = new Map(rows.map((row) => [row.topic, row]))
    const entries = reports.map((report) => {
      const row = byTopic.get(report.topic)!
      const status = !report.fileExists
        ? "missing"
        : !report.registeredHash
          ? "unhashed"
          : report.currentHash !== report.registeredHash
            ? "modified"
            : "ok"
      return {
        topic: report.topic,
        path: report.path,
        created_at: row.created_at,
        sane_hash: report.registeredHash,
        git_commit: row.git_commit,
        file_present: report.fileExists,
        status,
      }
    })
    if (options.json === true) {
      write(JSON.stringify({
        repo_root: identity.repoRoot,
        user: identity.user,
        workstream_id: identity.workstreamId,
        mode: "index",
        reports: entries,
        unregistered_files: unregisteredFiles,
      }, null, 2))
      return
    }
    write(`research index: ${identity.workstreamId} (${entries.length} report(s))`)
    if (entries.length === 0) {
      write(`(no research registered)`)
    } else if (options.verbose) {
      write(`| topic | created | sane_hash | git_commit | path | status |`)
      write(`| --- | --- | --- | --- | --- | --- |`)
      for (const entry of entries) {
        write(
          `| ${entry.topic} | ${entry.created_at || "(unknown)"} | ${shortHash(entry.sane_hash)} | ${entry.git_commit ? entry.git_commit.slice(0, 12) : "-"} | ${entry.path} | ${entry.status} |`,
        )
      }
    }
    if (entries.length > 0 && !options.verbose) {
      write("Paths relative to workstream:")
      for (const entry of entries) write(`  ${entry.topic} ${entry.status} — ${entry.path}`)
    }
    if (unregisteredFiles.length > 0) {
      write(`unregistered report files:`)
      for (const relative of unregisteredFiles) write(`- ${relative}`)
    }
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed)
    await runSaneResearchCommand({ ...parsed, ...address })
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
