import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"

import {
  type DashboardTerminalScrollbackSnapshot,
  buildDashboardTerminalViewId,
  buildDashboardTerminalViewRoutes,
  type DashboardTerminalViewMetadata,
  type DashboardTmuxSessionMetadata,
} from "@agenv/workstreams/internal/dashboard-contracts"

import { LOCAL_ONLY_HOSTNAME } from "../config.ts"
import type {
  TerminalObservabilityCapability,
  TerminalObservabilityListViewsOptions,
  TerminalObservabilityProvider,
  TerminalObservabilityReadScrollbackOptions,
  TerminalObservabilityResolvedTarget,
  TerminalObservabilityView,
} from "./terminal.ts"

const DEFAULT_TTYD_STARTUP_TIMEOUT_MS = 3_000
const TTYD_READY_POLL_INTERVAL_MS = 50

interface TtydLaunchRequest {
  label: string
  sessionName: string
  terminalViewId: string
}

export interface BuildTtydLaunchArgsOptions {
  label: string
  port: number
  sessionName: string
}

export interface SpawnedTtydInstance {
  closed: Promise<void>
  pid: number
  port: number
  stop(): void
  upstreamOrigin: string
  upstreamPath: string
}

export interface TtydProcessLauncher {
  getCapability(): Promise<TerminalObservabilityCapability>
  launch(request: TtydLaunchRequest): Promise<SpawnedTtydInstance>
}

export interface TtydTerminalObservabilityProviderOptions {
  launcher?: TtydProcessLauncher
}

interface TerminalViewRegistryEntry {
  baseView: TerminalObservabilityView
  capabilityEnabled: boolean
  instance?: SpawnedTtydInstance
  lastLaunchError?: string
  launchPromise?: Promise<SpawnedTtydInstance>
  manageable: boolean
  manageabilityReason?: string
  sessionName: string
}

interface ObservedPaneSummary {
  active: boolean
  paneId: string
  title?: string
}

function buildImplementationThreadLabel(session: DashboardTmuxSessionMetadata): string {
  return session.thread_id
    ? `Thread ${session.thread_id} terminal`
    : `Implementation session ${session.session_name}`
}

function buildTerminalViewLabel(session: DashboardTmuxSessionMetadata): string {
  if (session.role === "implementation_thread") {
    return buildImplementationThreadLabel(session)
  }

  if (session.role === "supervision_run") {
    return session.run_id
      ? `Supervision run ${session.run_id} terminal`
      : `Supervision session ${session.session_name}`
  }

  return `Supervision branch ${session.correlation.target_id} terminal`
}

function getManageability(args: {
  capabilityEnabled: boolean
  session: DashboardTmuxSessionMetadata
}): { manageable: boolean; reason?: string } {
  if (!args.capabilityEnabled) {
    return {
      manageable: false,
    }
  }

  if (args.session.correlation.status === "missing") {
    return {
      manageable: false,
      reason: "tmux did not observe the referenced session, so no terminal can be launched.",
    }
  }

  if (args.session.state === "unknown") {
    return {
      manageable: false,
      reason: "Session state is unknown, so ttyd launch was skipped conservatively.",
    }
  }

  return { manageable: true }
}

function getViewNotes(entry: TerminalViewRegistryEntry): string | undefined {
  if (!entry.capabilityEnabled && !entry.instance) {
    return entry.manageabilityReason
  }

  if (!entry.manageable) {
    return entry.manageabilityReason
  }

  if (entry.lastLaunchError) {
    return entry.lastLaunchError
  }

  if (entry.baseView.correlation.status === "stale") {
    return "The tmux session is still observable, but its persisted runtime target is stale."
  }

  if (entry.baseView.correlation.status === "ambiguous") {
    return "The tmux session matched multiple runtime targets, so terminal routing remains ambiguous."
  }

  return undefined
}

function getViewStatus(entry: TerminalViewRegistryEntry): DashboardTerminalViewMetadata["status"] {
  if ((!entry.capabilityEnabled && !entry.instance) || !entry.manageable || entry.lastLaunchError) {
    return "unavailable"
  }

  return entry.baseView.correlation.status === "matched" ? "available" : "degraded"
}

function createBaseView(args: {
  checkedAt: string
  session: DashboardTmuxSessionMetadata
}): DashboardTerminalViewMetadata {
  const terminalViewId = buildDashboardTerminalViewId(args.session)

  return {
    terminal_view_id: terminalViewId,
    label: buildTerminalViewLabel(args.session),
    status: "available",
    transport: "ttyd",
    read_only: true,
    session_id: args.session.session_id,
    session_name: args.session.session_name,
    role: args.session.role,
    observed_at: args.checkedAt,
    ...(args.session.stage_id ? { stage_id: args.session.stage_id } : {}),
    ...(args.session.batch_id ? { batch_id: args.session.batch_id } : {}),
    ...(args.session.thread_id ? { thread_id: args.session.thread_id } : {}),
    routes: buildDashboardTerminalViewRoutes(terminalViewId),
    correlation: args.session.correlation,
  }
}

function runTmuxCommand(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })

  if (result.error || result.status !== 0) {
    return { ok: false, stdout: "" }
  }

  return {
    ok: true,
    stdout: result.stdout ?? "",
  }
}

function listSessionPanes(sessionName: string): ObservedPaneSummary[] {
  const result = runTmuxCommand([
    "list-panes",
    "-s",
    "-t",
    sessionName,
    "-F",
    "#{pane_id}\t#{pane_active}\t#{pane_title}",
  ])

  if (!result.ok) {
    return []
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, active, ...titleParts] = line.split("\t")
      const title = titleParts.join("\t")

      return {
        active: active === "1",
        paneId: paneId ?? "",
        ...(title.length > 0 ? { title } : {}),
      }
    })
    .filter((pane) => pane.paneId.length > 0)
}

function readSessionScrollback(
  sessionName: string,
  options: Pick<TerminalObservabilityReadScrollbackOptions, "capturedAt" | "limit" | "offset" | "terminalViewId">,
): DashboardTerminalScrollbackSnapshot | null {
  const panes = listSessionPanes(sessionName)
  const pane = panes.find((candidate) => candidate.active) ?? panes[0]
  if (!pane) {
    return null
  }

  const capture = runTmuxCommand([
    "capture-pane",
    "-p",
    "-t",
    pane.paneId,
    "-S",
    "-",
    "-E",
    "-",
  ])

  if (!capture.ok) {
    return null
  }

  const lines = capture.stdout.split("\n")
  if (lines.at(-1) === "") {
    lines.pop()
  }

  const totalLines = lines.length
  const limit = Math.max(1, Math.trunc(options.limit))
  const requestedOffset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset))
      : Math.max(0, totalLines - limit)
  const maxOffset = Math.max(0, totalLines - limit)
  const offset = Math.min(requestedOffset, maxOffset)
  const endOffset = Math.min(totalLines, offset + limit)

  return {
    terminal_view_id: options.terminalViewId,
    session_name: sessionName,
    captured_at: options.capturedAt,
    read_only: true,
    status: "available",
    pane_id: pane.paneId,
    ...(pane.title ? { pane_title: pane.title } : {}),
    total_lines: totalLines,
    offset,
    limit,
    end_offset: endOffset,
    is_at_top: offset === 0,
    is_at_bottom: endOffset >= totalLines,
    lines: lines.slice(offset, endOffset),
    notes: "Captured from the tmux active pane for read-only monitoring.",
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(0, LOCAL_ONLY_HOSTNAME, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a ttyd port.")))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForTtydReady(args: {
  startupTimeoutMs: number
  upstreamOrigin: string
  getStatus: () => { exitCode: number | null; errored: boolean; errorMessage: string }
}): Promise<void> {
  const deadline = Date.now() + args.startupTimeoutMs

  while (Date.now() <= deadline) {
    const status = args.getStatus()
    if (status.errored || status.exitCode !== null) {
      throw new Error(
        status.errorMessage.length > 0
          ? status.errorMessage
          : `ttyd exited before it became ready at ${args.upstreamOrigin}.`,
      )
    }

    try {
      const response = await fetch(args.upstreamOrigin, {
        signal: AbortSignal.timeout(TTYD_READY_POLL_INTERVAL_MS),
      })

      response.body?.cancel()
      if (response.status < 500) {
        return
      }
    } catch {
      // Keep polling until the startup deadline expires or the process exits.
    }

    await sleep(TTYD_READY_POLL_INTERVAL_MS)
  }

  throw new Error(`ttyd did not become ready at ${args.upstreamOrigin} within ${args.startupTimeoutMs}ms.`)
}

export function buildTtydLaunchArgs(options: BuildTtydLaunchArgsOptions): string[] {
  return [
    "-i",
    LOCAL_ONLY_HOSTNAME,
    "-p",
    `${options.port}`,
    "-q",
    "-t",
    "disableLeaveAlert=true",
    "-t",
    "disableReconnect=true",
    "-t",
    "disableResizeOverlay=true",
    "-t",
    `titleFixed=${options.label}`,
    "tmux",
    "attach-session",
    "-r",
    "-t",
    options.sessionName,
  ]
}

function createSystemTtydProcessLauncher(args: {
  startupTimeoutMs?: number
} = {}): TtydProcessLauncher {
  const startupTimeoutMs = args.startupTimeoutMs ?? DEFAULT_TTYD_STARTUP_TIMEOUT_MS

  return {
    async getCapability(): Promise<TerminalObservabilityCapability> {
      const result = spawnSync("ttyd", ["-v"], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      })

      if (result.error || result.status !== 0) {
        const stderr = (result.stderr ?? "").trim()
        return {
          enabled: false,
          message:
            stderr.length > 0
              ? `ttyd is unavailable: ${stderr}`
              : "ttyd is unavailable or not installed on this machine.",
          mode: "ttyd",
        }
      }

      return {
        enabled: true,
        message: "ttyd is available for read-only terminal observability.",
        mode: "ttyd",
      }
    },
    async launch(request: TtydLaunchRequest): Promise<SpawnedTtydInstance> {
      const port = await reservePort()
      const upstreamOrigin = `http://${LOCAL_ONLY_HOSTNAME}:${port}`
      const child = spawn(
        "ttyd",
        buildTtydLaunchArgs({
          label: request.label,
          port,
          sessionName: request.sessionName,
        }),
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      )

      let stderr = ""
      let stdout = ""
      let errored = false

      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.once("error", (error) => {
        errored = true
        stderr = stderr.length > 0 ? stderr : error.message
      })

      const closed = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve()
        })
        child.once("close", () => {
          resolve()
        })
      })

      try {
        await waitForTtydReady({
          startupTimeoutMs,
          upstreamOrigin,
          getStatus: () => ({
            exitCode: child.exitCode,
            errored,
            errorMessage: [stderr.trim(), stdout.trim()].filter((value) => value.length > 0).join("\n"),
          }),
        })
      } catch (error) {
        if (child.exitCode === null && !errored) {
          child.kill("SIGTERM")
        }

        throw error
      }

      return {
        closed,
        pid: child.pid ?? -1,
        port,
        stop(): void {
          if (child.exitCode === null && !errored) {
            child.kill("SIGTERM")
          }
        },
        upstreamOrigin,
        upstreamPath: "/",
      }
    },
  }
}

export function createTtydTerminalObservabilityProvider(
  options: TtydTerminalObservabilityProviderOptions = {},
): TerminalObservabilityProvider {
  const launcher = options.launcher ?? createSystemTtydProcessLauncher()
  const entries = new Map<string, TerminalViewRegistryEntry>()

  function stopEntry(terminalViewId: string): void {
    const entry = entries.get(terminalViewId)
    if (!entry) {
      return
    }

    entry.instance?.stop()
    entries.delete(terminalViewId)
  }

  function syncEntry(args: {
    baseView: TerminalObservabilityView
    capabilityEnabled: boolean
    manageable: boolean
    manageabilityReason?: string
    sessionName: string
  }): TerminalViewRegistryEntry {
    const existing = entries.get(args.baseView.terminal_view_id)

    if (existing && existing.sessionName !== args.sessionName) {
      stopEntry(args.baseView.terminal_view_id)
    }

    const nextEntry: TerminalViewRegistryEntry = {
      baseView: args.baseView,
      capabilityEnabled: args.capabilityEnabled,
      instance: existing?.instance,
      lastLaunchError: existing?.lastLaunchError,
      launchPromise: existing?.launchPromise,
      manageable: args.manageable,
      manageabilityReason: args.manageabilityReason,
      sessionName: args.sessionName,
    }

    if (!nextEntry.manageable) {
      nextEntry.instance?.stop()
      delete nextEntry.instance
      delete nextEntry.launchPromise
    }

    entries.set(args.baseView.terminal_view_id, nextEntry)
    return nextEntry
  }

  async function ensureLaunched(entry: TerminalViewRegistryEntry): Promise<TerminalObservabilityResolvedTarget> {
    if (entry.instance) {
      return {
        terminalViewId: entry.baseView.terminal_view_id,
        sessionName: entry.sessionName,
        upstreamOrigin: entry.instance.upstreamOrigin,
        upstreamPath: entry.instance.upstreamPath,
        port: entry.instance.port,
        pid: entry.instance.pid,
      }
    }

    if (entry.launchPromise) {
      const instance = await entry.launchPromise
      return {
        terminalViewId: entry.baseView.terminal_view_id,
        sessionName: entry.sessionName,
        upstreamOrigin: instance.upstreamOrigin,
        upstreamPath: instance.upstreamPath,
        port: instance.port,
        pid: instance.pid,
      }
    }

    const launchPromise = launcher.launch({
      label: entry.baseView.label,
      sessionName: entry.sessionName,
      terminalViewId: entry.baseView.terminal_view_id,
    })
    entry.launchPromise = launchPromise

    try {
      const instance = await launchPromise
      const currentEntry = entries.get(entry.baseView.terminal_view_id)
      if (currentEntry !== entry) {
        instance.stop()
        throw new Error(`ttyd target ${entry.baseView.terminal_view_id} was replaced during launch.`)
      }

      entry.instance = instance
      delete entry.launchPromise
      delete entry.lastLaunchError
      void instance.closed.finally(() => {
        const activeEntry = entries.get(entry.baseView.terminal_view_id)
        if (activeEntry?.instance === instance) {
          delete activeEntry.instance
        }
      })

      return {
        terminalViewId: entry.baseView.terminal_view_id,
        sessionName: entry.sessionName,
        upstreamOrigin: instance.upstreamOrigin,
        upstreamPath: instance.upstreamPath,
        port: instance.port,
        pid: instance.pid,
      }
    } catch (error) {
      delete entry.launchPromise
      entry.lastLaunchError =
        error instanceof Error ? error.message : "ttyd launch failed for an unknown reason."
      throw error
    }
  }

  return {
    async getCapability(): Promise<TerminalObservabilityCapability> {
      return await launcher.getCapability()
    },
    async listViews(options: TerminalObservabilityListViewsOptions): Promise<TerminalObservabilityView[]> {
      const capability = await launcher.getCapability()
      const activeViewIds = new Set<string>()
      const views: TerminalObservabilityView[] = []

      for (const session of options.tmux.sessions) {
        const baseView = createBaseView({
          checkedAt: options.checkedAt,
          session,
        })
        const { manageable, reason } = getManageability({
          capabilityEnabled: capability.enabled,
          session,
        })
        const entry = syncEntry({
          baseView,
          capabilityEnabled: capability.enabled,
          manageable,
          manageabilityReason: capability.enabled ? reason : capability.message,
          sessionName: session.session_name,
        })

        activeViewIds.add(baseView.terminal_view_id)
        views.push({
          ...baseView,
          status: getViewStatus(entry),
          ...(getViewNotes(entry) ? { notes: getViewNotes(entry) } : {}),
        })
      }

      for (const terminalViewId of [...entries.keys()]) {
        if (!activeViewIds.has(terminalViewId)) {
          stopEntry(terminalViewId)
        }
      }

      return views
    },
    async readScrollback(
      options: TerminalObservabilityReadScrollbackOptions,
    ): Promise<DashboardTerminalScrollbackSnapshot | null> {
      const entry = entries.get(options.terminalViewId)
      if (!entry) {
        return null
      }

      return readSessionScrollback(entry.sessionName, options)
    },
    async resolveViewTarget(terminalViewId: string): Promise<TerminalObservabilityResolvedTarget | null> {
      const entry = entries.get(terminalViewId)
      if (!entry) {
        return null
      }

      if (!entry.manageable && !entry.instance) {
        return null
      }

      if (!entry.capabilityEnabled && !entry.instance) {
        return null
      }

      return await ensureLaunched(entry)
    },
    close(): void {
      for (const terminalViewId of [...entries.keys()]) {
        stopEntry(terminalViewId)
      }
    },
  }
}

export type { TtydLaunchRequest }
