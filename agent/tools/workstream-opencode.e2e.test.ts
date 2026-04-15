import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { exportSession } from "../../packages/workstreams/src/lib/session-export.ts"
import { findNativeSessionIdByTitle } from "../../packages/workstreams/src/lib/workstream-tool/launch-supervision-opencode.ts"

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0
const hasOpencode = spawnSync("opencode", ["--version"], { stdio: "ignore" }).status === 0
const e2eModel = process.env.OPENCODE_E2E_MODEL
const runOpencodeE2E = process.env.RUN_OPENCODE_TOOL_E2E === "1"
const describeOpencodeE2E = runOpencodeE2E && hasTmux && hasOpencode && e2eModel ? describe : describe.skip

describeOpencodeE2E("opencode tool -> tmux e2e", () => {
  const sessionsToKill: string[] = []

  async function waitFor<T>(
    producer: () => Promise<T | undefined> | T | undefined,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 60000
    const intervalMs = options.intervalMs ?? 1000
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const result = await producer()
      if (result !== undefined) {
        return result
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for E2E condition.`)
  }

  afterEach(() => {
    for (const sessionName of sessionsToKill.splice(0)) {
      try {
        spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" })
      } catch {}
    }
  })

  test("an opencode session can call a tool that launches a tmux session", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "opencode-tool-e2e-"))
    const realConfigRoot = join(homedir(), ".config", "opencode")
    const toolsDir = join(realConfigRoot, "tools")
    const workspaceDir = join(tempRoot, "workspace")
    const metadataPath = join(tempRoot, "tmux-metadata.json")
    const sessionName = `e2e-tool-${Date.now().toString(36)}`
    const sessionTitle = `e2e-tool-export-${Date.now().toString(36)}`
    const launchDir = join(tempRoot, "launch")
    const markerPath = join(launchDir, "ready.txt")
    const tempToolPath = join(toolsDir, `launch-real-opencode-tmux-e2e-${Date.now().toString(36)}.ts`)

    sessionsToKill.push(sessionName)

    try {
      await mkdir(toolsDir, { recursive: true })
      await mkdir(workspaceDir, { recursive: true })
      await mkdir(launchDir, { recursive: true })
      await writeFile(join(workspaceDir, "README.md"), "# opencode tool e2e\n")

      await writeFile(
        tempToolPath,
        `import { tool } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const launch_real_opencode_tmux = tool({
  description: "Launches a real opencode run inside tmux for e2e testing.",
  args: {
    sessionName: tool.schema.string().describe("tmux session name"),
    model: tool.schema.string().describe("model for the inner opencode run"),
  },
  async execute(args) {
    const sessionName = args.sessionName;
    const model = args.model;
    const markerPath = ${JSON.stringify(markerPath)};
    const metadataPath = process.env.MOCK_TMUX_METADATA_PATH;
    const workspaceDir = ${JSON.stringify(workspaceDir)};
    const wrapperPath = join(${JSON.stringify(launchDir)}, "launch-real-opencode.sh");
    const wrapper = [
      "#!/bin/sh",
      "set -eu",
      "echo READY > " + JSON.stringify(markerPath),
      "exec opencode run --model " + JSON.stringify(model) + " --dir " + JSON.stringify(workspaceDir) + " --title " + JSON.stringify(sessionTitle) + " --dangerously-skip-permissions hello",
      "",
    ].join("\\n");
    writeFileSync(wrapperPath, wrapper);
    chmodSync(wrapperPath, 0o755);

    const command = [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      "opencode",
      "sh",
      "-lc",
      wrapperPath,
    ];

    const create = spawnSync("tmux", command, { encoding: "utf-8" });
    if (create.status !== 0) {
      throw new Error((create.stderr || create.stdout || "failed to create tmux session").trim());
    }

    spawnSync("tmux", ["set-option", "-t", sessionName, "remain-on-exit", "on"], {
      encoding: "utf-8",
    });

    if (metadataPath) {
      writeFileSync(metadataPath, JSON.stringify({ sessionName, markerPath, wrapperPath }, null, 2));
    }

    return 'Started real opencode tmux session ' + sessionName + '. Attach with tmux attach -t ' + sessionName + '.';
  },
});
`,
      )

      const prompt = [
        `Call the launch_real_opencode_tmux tool with sessionName \"${sessionName}\" and model \"${e2eModel}\".`,
        "Do not ask questions.",
        'After the tool succeeds, respond with exactly: DONE',
      ].join(" ")

      const run = spawnSync(
        "opencode",
        [
          "run",
          "--format",
          "default",
          "--model",
          e2eModel!,
          "--dir",
          workspaceDir,
          "--dangerously-skip-permissions",
          prompt,
        ],
        {
          encoding: "utf-8",
          timeout: 120000,
          env: {
            ...process.env,
            MOCK_TMUX_METADATA_PATH: metadataPath,
          },
        },
      )

      expect(run.status).toBe(0)
      expect(`${run.stdout}\n${run.stderr}`).toContain("DONE")
      expect(existsSync(metadataPath)).toBe(true)

      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
        sessionName: string
        markerPath: string
        wrapperPath: string
      }

      expect(metadata.sessionName).toBe(sessionName)

      const hasSession = spawnSync("tmux", ["has-session", "-t", sessionName], {
        stdio: "ignore",
      }).status === 0
      expect(hasSession).toBe(true)
      expect(existsSync(metadata.markerPath)).toBe(true)
      expect(readFileSync(metadata.wrapperPath, "utf-8")).toContain("exec opencode run --model")

      const nativeSessionId = await waitFor(() =>
        findNativeSessionIdByTitle(workspaceDir, sessionTitle),
      )
      const sessionExport = await waitFor(async () => {
        try {
          const exported = await exportSession(nativeSessionId)
          return exported.messages.length > 0 ? exported : undefined
        } catch {
          return undefined
        }
      })

      expect(sessionExport.info.id).toBe(nativeSessionId)
      expect(sessionExport.info.title).toBe(sessionTitle)
      expect(Array.isArray(sessionExport.messages)).toBe(true)
      expect(sessionExport.messages.length).toBeGreaterThan(0)
    } finally {
      await rm(tempToolPath, { force: true })
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 180000)
})
