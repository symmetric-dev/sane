import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  getDefaultSupervisorConfig,
  getSupervisorConfigPath,
  loadSupervisorConfig,
  validateAndNormalizeSupervisorConfig,
} from "../../src/lib/supervisor/config"

describe("Supervisor Config", () => {
  let tempDir: string
  let workDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "supervisor-config-test-"))
    workDir = join(tempDir, "work")
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("getSupervisorConfigPath returns work/supervisor.json path", () => {
    expect(getSupervisorConfigPath("/repo/root")).toBe("/repo/root/work/supervisor.json")
  })

  test("getDefaultSupervisorConfig returns conservative v1 defaults", () => {
    const config = getDefaultSupervisorConfig()

    expect(config.issue_taxonomy.severity).toEqual(["high", "medium", "low"])
    expect(config.issue_taxonomy.difficulty).toEqual(["complex", "regular", "trivial"])
    expect(config.issue_taxonomy.ownership).toEqual(["product", "engineering"])
    expect(config.issue_taxonomy.effort).toEqual(["tasks", "revision", "workstream"])
    expect(config.review_limits.max_fix_cycles_per_batch).toBe(1)
    expect(config.stage_completion).toEqual({ stop: true, contact_user: true })
    expect(config.escalation.contact_user_on.severity.values).toEqual([])
    expect(config.escalation.contact_user_on.difficulty.values).toEqual(["complex"])
    expect(config.escalation.contact_user_on.ownership.values).toEqual(["product"])
    expect(config.escalation.contact_user_on.effort.values).toEqual(["revision", "workstream"])
    expect(config.escalation.contact_user_on.review_fix_limit_reached).toBe(true)
    expect(config.escalation.contact_user_on.stage_completion).toBe(true)
  })

  test("getDefaultSupervisorConfig returns a fresh object", () => {
    const first = getDefaultSupervisorConfig()
    const second = getDefaultSupervisorConfig()

    first.issue_taxonomy.severity.push("low")

    expect(second.issue_taxonomy.severity).toEqual(["high", "medium", "low"])
  })

  test("loadSupervisorConfig returns defaults when file is missing", () => {
    const config = loadSupervisorConfig(tempDir)

    expect(config).toEqual(getDefaultSupervisorConfig())
  })

  test("loadSupervisorConfig merges partial config with defaults", () => {
    writeFileSync(
      join(workDir, "supervisor.json"),
      JSON.stringify({
        review_limits: {
          max_fix_cycles_per_batch: 0,
        },
        stage_completion: {
          stop: false,
        },
        escalation: {
          contact_user_on: {
            severity: {
              values: ["high"],
            },
          },
        },
      }),
    )

    const config = loadSupervisorConfig(tempDir)

    expect(config.review_limits.max_fix_cycles_per_batch).toBe(0)
    expect(config.stage_completion).toEqual({ stop: false, contact_user: true })
    expect(config.escalation.contact_user_on.severity).toEqual({ values: ["high"], min_count: 1 })
    expect(config.escalation.contact_user_on.ownership).toEqual({ values: ["product"], min_count: 1 })
  })

  test("validateAndNormalizeSupervisorConfig normalizes enum values", () => {
    const normalized = validateAndNormalizeSupervisorConfig({
      issue_taxonomy: {
        severity: [" HIGH ", "medium", "high"],
      },
      escalation: {
        contact_user_on: {
          effort: {
            values: [" Revision ", "WORKSTREAM", "revision"],
            min_count: 2,
          },
        },
      },
    })

    expect(normalized.issue_taxonomy.severity).toEqual(["high", "medium"])
    expect(normalized.escalation.contact_user_on.effort).toEqual({
      values: ["revision", "workstream"],
      min_count: 2,
    })
  })

  test("loadSupervisorConfig throws actionable error for invalid JSON", () => {
    writeFileSync(join(workDir, "supervisor.json"), "{ invalid json")

    expect(() => loadSupervisorConfig(tempDir)).toThrow(
      /Failed to parse supervisor config at .*work\/supervisor\.json/,
    )
  })

  test("validateAndNormalizeSupervisorConfig throws actionable validation errors", () => {
    expect(() =>
      validateAndNormalizeSupervisorConfig(
        {
          review_limits: {
            max_fix_cycles_per_batch: -1,
          },
          stage_completion: {
            stop: "yes",
          },
          escalation: {
            contact_user_on: {
              ownership: {
                values: ["design"],
                min_count: 0,
              },
              unknown_rule: true,
            },
          },
          unknown: true,
        },
        "/repo/work/supervisor.json",
      ),
    ).toThrow(`Invalid supervisor config at /repo/work/supervisor.json:
- /repo/work/supervisor.json contains unknown key "unknown".
- /repo/work/supervisor.json.escalation.contact_user_on contains unknown key "unknown_rule".
- /repo/work/supervisor.json.review_limits.max_fix_cycles_per_batch must be >= 0. Received -1.
- /repo/work/supervisor.json.stage_completion.stop must be a boolean.
- /repo/work/supervisor.json.escalation.contact_user_on.ownership.values[0] must be one of: product, engineering. Received "design".
- /repo/work/supervisor.json.escalation.contact_user_on.ownership.min_count must be >= 1. Received 0.`)
  })

  test("validateAndNormalizeSupervisorConfig rejects empty issue taxonomy arrays", () => {
    expect(() =>
      validateAndNormalizeSupervisorConfig({
        issue_taxonomy: {
          severity: [],
        },
      }),
    ).toThrow(/issue_taxonomy\.severity must contain at least one value/)
  })

  test("validateAndNormalizeSupervisorConfig requires a top-level object", () => {
    expect(() => validateAndNormalizeSupervisorConfig(["not-an-object"])).toThrow(
      /expected a JSON object at the top level/,
    )
  })
})
