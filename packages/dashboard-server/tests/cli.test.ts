import { describe, expect, test } from "bun:test"

import { parseDashboardServerCliArgs } from "../bin/dashboard-server.ts"

describe("dashboard server CLI parsing", () => {
  test("parses explicit repo root and port", () => {
    expect(
      parseDashboardServerCliArgs([
        "--repo-root",
        "/tmp/repo",
        "--port",
        "43120",
      ]),
    ).toEqual({
      port: 43120,
      repoRoot: "/tmp/repo",
    })
  })

  test("returns null for help", () => {
    expect(parseDashboardServerCliArgs(["--help"])).toBeNull()
  })

  test("rejects unknown flags", () => {
    expect(() => parseDashboardServerCliArgs(["--host", "0.0.0.0"])).toThrow(
      'Unknown option: --host',
    )
  })
})
