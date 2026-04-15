import { randomBytes } from "crypto"
import { spawnSync } from "child_process"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { logWorkstreamToolEvent } from "./debug-log.ts"

import {
  DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
  prepareMessageBoundaryForkLaunch,
  type ForkedSessionArgs,
  type ForkedSessionResult,
  findNativeSessionIdByTitle,
} from "./launch-supervision-opencode.ts"

export const DEFAULT_TMUX_SESSION_SUFFIX_LENGTH = 6
export const DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS = 3000
export const DEFAULT_TMUX_LAUNCH_VALIDATION_POLL_INTERVAL_MS = 100

export interface SupervisionTmuxLaunchMetadata {
  sessionName: string
  attachCommand: string
  launchDirectory: string
  wrapperPath: string
  readyMarkerPath: string
  commandPath: string
  metadataPath: string
}

export interface SupervisionTmuxInspection {
  exists: boolean
  paneDead: boolean
  exitStatus?: number
  paneOutput?: string
}

export function formatSupervisionTmuxObservability(metadata: SupervisionTmuxLaunchMetadata): string {
  return [
    "Tmux observability:",
    `- Session: ${metadata.sessionName}`,
    `- Attach: ${metadata.attachCommand}`,
    `- Launch directory: ${metadata.launchDirectory}`,
    `- Wrapper script: ${metadata.wrapperPath}`,
    `- Ready marker: ${metadata.readyMarkerPath}`,
    `- Recorded command: ${metadata.commandPath}`,
    `- Launch metadata: ${metadata.metadataPath}`,
  ].join("\n")
}

export function appendSupervisionTmuxObservability(
  text: string,
  metadata?: SupervisionTmuxLaunchMetadata,
): string {
  if (!metadata) {
    return text
  }

  return `${text}\n\n${formatSupervisionTmuxObservability(metadata)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function formatWorkstreamTmuxPrefix(streamId: string): string {
  const match = streamId.match(/^(\d{1,})/)
  if (match?.[1]) {
    return match[1].padStart(3, "0")
  }

  return "000"
}

export function createSupervisionTmuxSessionName(streamId: string): string {
  return `${formatWorkstreamTmuxPrefix(streamId)}-supervision-${randomBytes(
    Math.max(3, Math.ceil(DEFAULT_TMUX_SESSION_SUFFIX_LENGTH / 2)),
  )
    .toString("hex")
    .slice(0, DEFAULT_TMUX_SESSION_SUFFIX_LENGTH)}`
}

export function tmuxSessionExists(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    stdio: "ignore",
  })
  return result.status === 0
}

function getTmuxSinglePaneState(sessionName: string): { dead: boolean; exitStatus?: number } | undefined {
  const result = spawnSync(
    "tmux",
    ["list-panes", "-t", sessionName, "-F", "#{pane_dead}:#{pane_exit_status}"],
    { encoding: "utf-8" },
  )

  if (result.status !== 0) {
    return undefined
  }

  const [paneLine] = (result.stdout ?? "").trim().split("\n")
  if (!paneLine) {
    return undefined
  }

  const [dead, exitStatus] = paneLine.split(":")
  const parsed = Number(exitStatus)
  return {
    dead: dead === "1",
    ...(Number.isFinite(parsed) ? { exitStatus: parsed } : {}),
  }
}

export function inspectSupervisionTmuxSession(sessionName: string): SupervisionTmuxInspection {
  const exists = tmuxSessionExists(sessionName)
  if (!exists) {
    return {
      exists: false,
      paneDead: false,
    }
  }

  const paneState = getTmuxSinglePaneState(sessionName)
  const paneOutput = captureTmuxPaneOutput(sessionName)

  return {
    exists: true,
    paneDead: paneState?.dead === true,
    ...(typeof paneState?.exitStatus === "number" ? { exitStatus: paneState.exitStatus } : {}),
    ...(paneOutput ? { paneOutput } : {}),
  }
}

export function captureTmuxPaneOutput(sessionName: string): string {
  const result = spawnSync("tmux", ["capture-pane", "-p", "-t", sessionName], {
    encoding: "utf-8",
  })
  return (result.stdout ?? result.stderr ?? "").trim()
}

export function createSupervisionTmuxLaunchMetadata(args: {
  tmuxSessionName: string
  repoRoot: string
  commandArgs: string[]
}): SupervisionTmuxLaunchMetadata {
  logWorkstreamToolEvent("workstream.launch.tmux", "createSupervisionTmuxLaunchMetadata:before", {
    tmuxSessionName: args.tmuxSessionName,
    repoRoot: args.repoRoot,
    commandArgsLength: args.commandArgs.length,
  })
  const launchDirectory = mkdtempSync(join(tmpdir(), "workstream-supervision-"))
  const wrapperPath = join(launchDirectory, "launch-supervision.sh")
  const readyMarkerPath = join(launchDirectory, "launch.ready")
  const commandPath = join(launchDirectory, "opencode-command.sh")
  const metadataPath = join(launchDirectory, "launch-metadata.json")
  const attachCommand = `tmux attach -t ${args.tmuxSessionName}`

  writeFileSync(
    commandPath,
    ["#!/bin/sh", `cd ${shellQuote(args.repoRoot)}`, 'exec opencode "$@"', ""].join("\n"),
    "utf-8",
  )
  chmodSync(commandPath, 0o755)

  writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      "set -eu",
      `READY_MARKER=${shellQuote(readyMarkerPath)}`,
      `COMMAND_PATH=${shellQuote(commandPath)}`,
      `METADATA_PATH=${shellQuote(metadataPath)}`,
      'printf "ready\\n" > "$READY_MARKER"',
      `exec "$COMMAND_PATH" ${args.commandArgs.map((arg) => shellQuote(arg)).join(" ")}`,
      "",
    ].join("\n"),
    "utf-8",
  )
  chmodSync(wrapperPath, 0o755)

  const metadata: SupervisionTmuxLaunchMetadata = {
    sessionName: args.tmuxSessionName,
    attachCommand,
    launchDirectory,
    wrapperPath,
    readyMarkerPath,
    commandPath,
    metadataPath,
  }

  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8")
  logWorkstreamToolEvent("workstream.launch.tmux", "createSupervisionTmuxLaunchMetadata:after", {
    tmuxSessionName: args.tmuxSessionName,
    launchDirectory,
  })
  return metadata
}

export async function validateSupervisionTmuxLaunch(
  metadata: SupervisionTmuxLaunchMetadata,
): Promise<void> {
  logWorkstreamToolEvent("workstream.launch.tmux", "validateSupervisionTmuxLaunch:before", {
    sessionName: metadata.sessionName,
  })
  const startedAt = Date.now()

  while (Date.now() - startedAt < DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS) {
    const readyMarkerExists = (() => {
      try {
        return readFileSync(metadata.readyMarkerPath, "utf-8").trim().length > 0
      } catch {
        return false
      }
    })()

    if (readyMarkerExists) {
      logWorkstreamToolEvent("workstream.launch.tmux", "validateSupervisionTmuxLaunch:after", {
        sessionName: metadata.sessionName,
      })
      return
    }

    const sessionExists = tmuxSessionExists(metadata.sessionName)
    const paneState = sessionExists
      ? getTmuxSinglePaneState(metadata.sessionName)
      : undefined

    if (!sessionExists || paneState?.dead) {
      const paneOutput = sessionExists ? captureTmuxPaneOutput(metadata.sessionName) : ""
      const detail = !sessionExists
        ? `Supervision tmux launch validation failed for ${metadata.sessionName}: session exited before the launch handshake completed.`
        : `Supervision tmux launch validation failed for ${metadata.sessionName}: pane exited before the launch handshake completed${typeof paneState?.exitStatus === "number" ? ` (exit ${paneState.exitStatus})` : ""}.`
      logWorkstreamToolEvent("workstream.launch.tmux", "validateSupervisionTmuxLaunch:error", {
        sessionName: metadata.sessionName,
        detail,
        paneOutput,
      })
      throw new Error(
        [
          detail,
          `Attach with \`${metadata.attachCommand}\` to inspect it.`,
          ...(paneOutput ? [`Captured tmux pane output:\n${paneOutput}`] : []),
        ].join("\n"),
      )
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DEFAULT_TMUX_LAUNCH_VALIDATION_POLL_INTERVAL_MS),
    )
  }

  const sessionExists = tmuxSessionExists(metadata.sessionName)
  const paneOutput = sessionExists ? captureTmuxPaneOutput(metadata.sessionName) : ""
  logWorkstreamToolEvent("workstream.launch.tmux", "validateSupervisionTmuxLaunch:timeout", {
    sessionName: metadata.sessionName,
    paneOutput,
  })
  throw new Error(
    [
      `Supervision tmux launch validation failed for ${metadata.sessionName} within ${DEFAULT_TMUX_LAUNCH_VALIDATION_TIMEOUT_MS}ms.`,
      `Attach with \`${metadata.attachCommand}\` to inspect it.`,
      ...(paneOutput ? [`Captured tmux pane output:\n${paneOutput}`] : []),
    ].join("\n"),
  )
}

export async function waitForTmuxSessionExit(
  sessionName: string,
  timeoutMs: number = DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
): Promise<number> {
  logWorkstreamToolEvent("workstream.launch.tmux", "waitForTmuxSessionExit:before", {
    sessionName,
    timeoutMs,
  })
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const sessionExists = tmuxSessionExists(sessionName)
    if (!sessionExists) {
      logWorkstreamToolEvent("workstream.launch.tmux", "waitForTmuxSessionExit:missing-session", {
        sessionName,
      })
      throw new Error(
        `Supervision tmux session "${sessionName}" vanished before an exit status could be observed. This is not treated as implicit success; inspect tmux/server lifecycle and supervision logs for the missing process-end evidence.`,
      )
    }

    const paneState = getTmuxSinglePaneState(sessionName)
    if (paneState?.dead) {
      logWorkstreamToolEvent("workstream.launch.tmux", "waitForTmuxSessionExit:after", {
        sessionName,
        exitStatus: paneState.exitStatus,
      })
      return typeof paneState.exitStatus === "number" ? paneState.exitStatus : 1
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
    )
  }

  logWorkstreamToolEvent("workstream.launch.tmux", "waitForTmuxSessionExit:timeout", {
    sessionName,
    timeoutMs,
  })
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for supervision session "${sessionName}" to finish. Attach with \`tmux attach -t ${sessionName}\` to inspect it.`,
  )
}

export async function runForkedSessionInTmux(
  args: Omit<ForkedSessionArgs, "forkMode"> & {
    forkMode?: "message" | "latest_session_fork"
    tmuxSessionName: string
  },
  helpers: {
    findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle
  } = {
    findNativeSessionIdByTitle,
  },
): Promise<ForkedSessionResult> {
  logWorkstreamToolEvent("workstream.launch.tmux", "runForkedSessionInTmux:before", {
    tmuxSessionName: args.tmuxSessionName,
    sessionId: args.sessionId,
    title: args.title,
    checkpointMessageId: args.checkpointMessageId,
  })
  const preparedLaunch = args.checkpointMessageId
    ? await prepareMessageBoundaryForkLaunch({
        sessionId: args.sessionId,
        repoRoot: args.repoRoot,
        title: args.title,
        prompt: args.prompt,
        checkpointMessageId: args.checkpointMessageId,
        onNativeSessionId: args.onNativeSessionId,
      })
    : {
        commandArgs: [
          "run",
          "--session",
          args.sessionId,
          "--fork",
          "--dir",
          args.repoRoot,
          "--title",
          args.title,
          "--format",
          "json",
          args.prompt,
        ],
      }

  const tmuxMetadata = createSupervisionTmuxLaunchMetadata({
    tmuxSessionName: args.tmuxSessionName,
    repoRoot: args.repoRoot,
    commandArgs: preparedLaunch.commandArgs,
  })

  const createResult = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      args.tmuxSessionName,
      "-n",
      "supervision",
      tmuxMetadata.wrapperPath,
    ],
    {
      cwd: args.repoRoot,
      env: process.env,
      encoding: "utf-8",
    },
  )

  if (createResult.status !== 0) {
    logWorkstreamToolEvent("workstream.launch.tmux", "runForkedSessionInTmux:create-error", {
      tmuxSessionName: args.tmuxSessionName,
      stderr: createResult.stderr,
      stdout: createResult.stdout,
    })
    throw new Error(
      (
        createResult.stderr ||
        createResult.stdout ||
        "Failed to create supervision tmux session."
      ).trim(),
    )
  }

  spawnSync("tmux", ["set-option", "-t", args.tmuxSessionName, "remain-on-exit", "on"], {
    encoding: "utf-8",
  })

  await validateSupervisionTmuxLaunch(tmuxMetadata)

  let nativeSessionId = "nativeSessionId" in preparedLaunch ? preparedLaunch.nativeSessionId : undefined
  let pollError: unknown
  let stopped = false
  let pollPromise: Promise<void> | undefined

  if (!nativeSessionId && args.onNativeSessionId) {
    const handleNativeSessionId = args.onNativeSessionId
    pollPromise = (async () => {
      while (!stopped && !nativeSessionId) {
        try {
          const foundSessionId = await helpers.findNativeSessionIdByTitle(
            args.repoRoot,
            args.title,
          )
          if (foundSessionId) {
            nativeSessionId = foundSessionId
            logWorkstreamToolEvent("workstream.launch.tmux", "runForkedSessionInTmux:poll-native-session", {
              tmuxSessionName: args.tmuxSessionName,
              nativeSessionId: foundSessionId,
            })
            await handleNativeSessionId(foundSessionId)
            return
          }
        } catch (error) {
          pollError = error
          return
        }

        await new Promise((resolve) =>
          setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
        )
      }
    })()
  }

  try {
    const code = await waitForTmuxSessionExit(args.tmuxSessionName, DEFAULT_BRANCH_TOOL_TIMEOUT_MS)
    stopped = true
    await pollPromise

    if (pollError) {
      throw pollError
    }

    if (!nativeSessionId) {
      nativeSessionId = await helpers.findNativeSessionIdByTitle(args.repoRoot, args.title)
    }

    const result = {
      code,
      stdout: captureTmuxPaneOutput(args.tmuxSessionName),
      stderr: "",
      ...(nativeSessionId ? { nativeSessionId } : {}),
      tmuxSessionName: args.tmuxSessionName,
      tmuxMetadata,
    }
    logWorkstreamToolEvent("workstream.launch.tmux", "runForkedSessionInTmux:after", {
      tmuxSessionName: args.tmuxSessionName,
      code: result.code,
      nativeSessionId: result.nativeSessionId,
    })
    return result
  } finally {
    stopped = true
  }
}
