/**
 * SANE 0.2.0 M3-B: `sane-alpha baseline` command.
 *
 * Research support-track baseline record/recheck (docs/SANE_0_2_0.md Sec 2):
 * - `--record` increments `baselines.revision` via `recordBaselineRevision`.
 * - `--recheck` compares recorded vs current via `recheckBaseline`.
 * - `--topic <t>` with `--record` also upserts a `research_reports` row for
 *   that topic (baseline_rev defaults to the new revision); with `--recheck`
 *   it filters the stale-report check to that topic.
 * - `--baseline-rev <n>` requires `--topic`; with `--record` it sets the
 *   report's baseline_rev explicitly, with `--recheck` it asserts the
 *   recorded baseline revision (and, when `--topic` names a report, that
 *   report's baseline_rev).
 *
 * Supports `--json` and `--repo-root` detection idioms matching existing
 * CLIs. No dispatcher wiring here (bin/sane-alpha.ts stays with the
 * integrator).
 */

import {
  getResearchReport,
  initSchema,
  listResearchReports,
  openSaneDb,
  resolveSaneIdentity,
  upsertResearchReport,
} from "./sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import {
  SaneWorkstreamStateError,
  recheckBaseline,
  recordBaselineRevision,
} from "./sane-workstream-state.ts"

export type SaneBaselineMode = "record" | "recheck"

export interface SaneBaselineCommandOptions {
  implementationRepository: string
  workstreamPath: string
  mode: SaneBaselineMode
  topic?: string
  baselineRev?: number
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane-alpha baseline <implementation-repository> <workstream-relative-path> --record|--recheck [--topic <topic> --baseline-rev <n>] [--json] [--repo-root <path>]"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  mode: SaneBaselineMode
  topic?: string
  baselineRev?: number
  json: boolean
} {
  let json = false
  let record = false
  let recheck = false
  let topic: string | undefined
  let baselineRev: number | undefined
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--record") {
      if (record) throw new SaneWorkstreamStateError("Option --record may be provided only once.")
      record = true
    } else if (parseOptions && argument === "--recheck") {
      if (recheck) throw new SaneWorkstreamStateError("Option --recheck may be provided only once.")
      recheck = true
    } else if (parseOptions && argument === "--topic") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --topic requires a value.")
      }
      if (topic !== undefined) {
        throw new SaneWorkstreamStateError("Option --topic may be provided only once.")
      }
      if (value.includes("\n") || value.trim() === "") {
        throw new SaneWorkstreamStateError("Option --topic must be a non-empty single-line value.")
      }
      topic = value
      index += 1
    } else if (parseOptions && argument === "--baseline-rev") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --baseline-rev requires a value.")
      }
      if (baselineRev !== undefined) {
        throw new SaneWorkstreamStateError("Option --baseline-rev may be provided only once.")
      }
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new SaneWorkstreamStateError(
          `Option --baseline-rev must be an integer >= 0 (got ${JSON.stringify(value)}).`,
        )
      }
      baselineRev = parsed
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneWorkstreamStateError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (record === recheck) {
    throw new SaneWorkstreamStateError("Provide exactly one of --record or --recheck.")
  }
  if (baselineRev !== undefined && topic === undefined) {
    throw new SaneWorkstreamStateError("Option --baseline-rev requires --topic.")
  }

  const mode: SaneBaselineMode = record ? "record" : "recheck"

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
  } else {
    throw new SaneWorkstreamStateError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  return { implementationRepository, workstreamPath, mode, topic, baselineRev, json }
}

/** Record or recheck the support-track baseline revision. */
export async function runSaneBaselineCommand(options: SaneBaselineCommandOptions): Promise<void> {
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
  try {
    initSchema(db)
    if (options.mode === "record") {
      const recorded = recordBaselineRevision(db, identity, {
        mutation: {
          actorRole: "research",
          sessionId: "cli-baseline-record",
          timestamp: new Date().toISOString(),
        },
      })
      let report: { topic: string; baseline_rev: number; path: string } | undefined
      if (options.topic !== undefined) {
        const baselineRev = options.baselineRev ?? recorded.revision
        const row = upsertResearchReport(
          db,
          identity,
          {
            topic: options.topic,
            baselineRev,
            path: `research/${options.topic}/REPORT.md`,
          },
          {
            actorRole: "research",
            sessionId: "cli-baseline-record",
            timestamp: new Date().toISOString(),
          },
        )
        report = { topic: row.topic, baseline_rev: row.baseline_rev, path: row.path }
      }
      if (options.json === true) {
        write(
          JSON.stringify(
            {
              repo_root: identity.repoRoot,
              user: identity.user,
              workstream_id: identity.workstreamId,
              revision: recorded.revision,
              path: recorded.path,
              ...(report ? { report } : {}),
            },
            null,
            2,
          ),
        )
        return
      }
      write(`baseline: recorded r${recorded.revision} ${recorded.path}`)
      if (report) {
        write(
          `report ${JSON.stringify(report.topic)}: baseline r${report.baseline_rev} ${report.path}`,
        )
      }
      return
    }

    const result = await recheckBaseline(db, identity, workstream.path)
    let staleReports = result.staleReports
    const mismatches = [...result.mismatches]
    if (options.topic !== undefined) {
      staleReports = staleReports.filter((entry) => entry.topic === options.topic)
      // When filtering to one topic, only that topic's staleness counts.
      const topicMismatches = result.mismatches.filter((message) =>
        message.includes(JSON.stringify(options.topic!)),
      )
      mismatches.length = 0
      mismatches.push(...topicMismatches)
      if (!listResearchReports(db, identity).some((report) => report.topic === options.topic)) {
        // Surface an explicit note when the requested topic has no report;
        // this is informational, not a stale-baseline failure.
        if (options.json !== true) {
          write(`report ${JSON.stringify(options.topic)}: (no report recorded)`)
        }
      }
      if (options.baselineRev !== undefined) {
        const row = getResearchReport(db, identity, options.topic)
        if (row && row.baseline_rev !== options.baselineRev) {
          mismatches.push(
            `research report ${JSON.stringify(options.topic)} baseline r${row.baseline_rev} does not match expected r${options.baselineRev}`,
          )
        }
      }
    } else if (options.baselineRev !== undefined) {
      // Topic is always set when baselineRev is set (enforced by the parser),
      // but keep the branch for programmatic callers.
      if (result.recorded && result.recorded.revision !== options.baselineRev) {
        mismatches.push(
          `baseline revision r${result.recorded.revision} does not match expected r${options.baselineRev}`,
        )
      }
    }
    // Bare --baseline-rev is parser-rejected; programmatic use without topic
    // asserts the recorded revision.
    const ok = mismatches.length === 0
    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: identity.repoRoot,
            user: identity.user,
            workstream_id: identity.workstreamId,
            revision: result.recorded?.revision ?? null,
            path: result.recorded?.path ?? null,
            file: result.baselinePath,
            file_exists: result.fileExists,
            reports_checked: options.topic !== undefined ? staleReports.length : result.reportsChecked,
            stale_reports: staleReports,
            mismatches,
            ok,
          },
          null,
          2,
        ),
      )
      return
    }
    if (result.recorded) {
      write(
        `baseline: r${result.recorded.revision} ${result.recorded.path} file ${result.fileExists ? "present" : "missing"}`,
      )
    } else {
      write(`baseline: (no baseline recorded) file ${result.fileExists ? "present" : "missing"}`)
    }
    if (ok) {
      write(`Baseline ok: ${identity.workstreamId}`)
    } else {
      for (const mismatch of mismatches) write(`Mismatch: ${mismatch}`)
      write(`Baseline mismatch: ${mismatches.length} for ${identity.workstreamId}`)
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
    await runSaneBaselineCommand(parsed)
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
