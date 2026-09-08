import { describe, expect, test } from "bun:test"

import { COMMANDS, type AlphaCommand, runSaneAlpha } from "./sane-alpha.ts"

const expectedCommands: AlphaCommand[] = [
  "init-sane",
  "create-workstream",
  "select-workstream",
  "install-context-packages",
  "sane-path",
]

describe("sane-alpha dispatcher", () => {
  test("exposes every repository-aware Alpha utility and not the low-level bootstrap", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...expectedCommands].sort())
    expect(COMMANDS).not.toHaveProperty("create-sane-workstream")
  })

  test("forwards each command argument without modification and returns its exit status", async () => {
    const received: Array<{ command: AlphaCommand; args: string[] }> = []
    const handlers = Object.fromEntries(expectedCommands.map((command, index) => [
      command,
      async (args: string[]) => {
        received.push({ command, args })
        return index + 10
      },
    ])) as Record<AlphaCommand, (args: string[]) => Promise<number>>
    const argumentsToPreserve = ["", "two words", "--", "--type", "feature"]

    const result = await runSaneAlpha(
      ["create-workstream", ...argumentsToPreserve],
      handlers,
    )

    expect(result).toBe(expectedCommands.indexOf("create-workstream") + 10)
    expect(received).toEqual([{ command: "create-workstream", args: argumentsToPreserve }])
  })

  test("prints help successfully and rejects an unknown command", async () => {
    expect(await runSaneAlpha([])).toBe(0)
    expect(await runSaneAlpha(["--help"])).toBe(0)
    expect(await runSaneAlpha(["not-an-alpha-command"])).toBe(1)
  })
})
