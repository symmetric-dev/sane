import { describe, expect, test } from "bun:test"

import { COMMANDS, type AlphaCommand, runSaneAlpha } from "./sane-alpha.ts"

const expectedCommands: AlphaCommand[] = [
  "init-sane-repository",
  "create-workstream",
  "select-sane-workstream",
  "provision-sane-role",
  "install-sane-agent-context-packages",
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
    const argumentsToPreserve = ["", "two words", "--", "--stage", "01-foundation"]

    const result = await runSaneAlpha(
      ["provision-sane-role", ...argumentsToPreserve],
      handlers,
    )

    expect(result).toBe(expectedCommands.indexOf("provision-sane-role") + 10)
    expect(received).toEqual([{ command: "provision-sane-role", args: argumentsToPreserve }])
  })

  test("prints help successfully and rejects an unknown command", async () => {
    expect(await runSaneAlpha([])).toBe(0)
    expect(await runSaneAlpha(["--help"])).toBe(0)
    expect(await runSaneAlpha(["not-an-alpha-command"])).toBe(1)
  })
})
