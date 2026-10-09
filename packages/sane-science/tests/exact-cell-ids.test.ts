import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { marimoSourceHash } from "../src/marimo-pair.ts"
import { operationSnippet, type CellOperation } from "../src/marimo-snippets.ts"

test("adapter snippets reject names accepted by upstream cell lookup while admitting exact IDs", () => {
  const operations = (id: string): CellOperation[] => [
    { kind: "create", code: "y = 2", after: id, run: false },
    { kind: "edit", cellId: id, code: "x = 2", expectedSourceHash: marimoSourceHash("x = 1"), run: false },
    { kind: "run", cellId: id, run: true },
  ]
  const cases = [...operations("friendly_name"), ...operations("abcd")]
  const python = process.env.SCIENCE_TEST_PYTHON ?? fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
  const results = JSON.parse(execFileSync(python, ["-I", fileURLToPath(new URL("./exact-cell-ids.py", import.meta.url))], {
    input: JSON.stringify(cases.map(operation => ({ snippet: operationSnippet(operation, "RESULT:") }))),
    encoding: "utf8", timeout: 15_000,
  })) as { error: string | null; calls: string[]; stdout: string }[]
  expect(results).toHaveLength(6)
  for (const result of results.slice(0, 3)) {
    expect(result.error).toContain("Unknown exact")
    expect(result.calls).toEqual([])
  }
  for (const [index, kind] of ["create", "edit", "run"].entries()) {
    const result = results[index + 3]!
    expect(result.error).toBeNull()
    expect(result.calls).toEqual([kind])
    const accepted = JSON.parse(result.stdout.trim().slice("RESULT:".length))
    expect(accepted).toEqual({ cellId: kind === "create" ? "newid" : "abcd", mutation: kind === "run" ? "not-requested" : "accepted" })
  }
}, 20_000)
