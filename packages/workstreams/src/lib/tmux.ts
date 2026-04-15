/**
 * tmux session management utilities
 *
 * Provides functions for creating, managing, and attaching to tmux sessions
 * for parallel thread execution.
 */

import { execSync, spawn, type ChildProcess } from "child_process"
import { randomBytes } from "crypto"
import { WORKSTREAM_HEADLESS_ENV } from "./opencode.ts"

/** Delay between starting threads to avoid bun install race conditions */
export const THREAD_START_DELAY_MS = 3000
export const HEADLESS_SESSION_OPTION = "@workstream-headless"

/**
 * Sleep with countdown logging to console
 * Shows "Waiting Ns..." countdown for visibility
 */
export function sleepWithCountdown(ms: number, label: string = "Waiting"): void {
    const seconds = Math.ceil(ms / 1000)
    for (let i = seconds; i > 0; i--) {
        process.stdout.write(`\r  ${label} ${i}s...`)
        Bun.sleepSync(1000)
    }
    process.stdout.write(`\r  ${label} done.   \n`)
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(name: string): boolean {
    try {
        execSync(`tmux has-session -t "${name}" 2>/dev/null`, {
            stdio: "pipe",
        })
        return true
    } catch {
        return false
    }
}

/**
 * Create a new tmux session with an initial window
 * The session is created detached (-d) so we can add more windows before attaching
 */
export function createSession(
    sessionName: string,
    windowName: string,
    command: string
): void {
    // Use spawn with arguments to avoid shell quoting issues
    const result = Bun.spawnSync([
        "tmux",
        "new-session",
        "-d",
        "-s", sessionName,
        "-n", windowName,
        command
    ])
    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session: ${result.stderr.toString()}`)
    }
}

/**
 * Add a new window to an existing tmux session
 */
export function addWindow(
    sessionName: string,
    windowName: string,
    command: string
): void {
    // Use spawn with arguments to avoid shell quoting issues
    const result = Bun.spawnSync([
        "tmux",
        "new-window",
        "-t", sessionName,
        "-n", windowName,
        command
    ])
    if (result.exitCode !== 0) {
        throw new Error(`Failed to add tmux window: ${result.stderr.toString()}`)
    }
}

/**
 * Get the current pane ID for a target (session:window.pane)
 */
export function getPaneId(target: string): string {
    try {
        const output = execSync(
            `tmux list-panes -t "${target}" -F "#{pane_id}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        return output.trim().split("\n")[0] || ""
    } catch {
        return ""
    }
}

/**
 * Split a window/pane
 */
export function splitWindow(
    target: string,
    command: string,
    size?: number,
    direction: 'h' | 'v' = 'h'
): void {
    const args = [
        "split-window",
        "-t", target,
        direction === 'h' ? "-h" : "-v",
    ]

    if (size) {
        args.push("-l", size.toString() + "%")
    } else {
        // If no size specified, default behavior (usually 50%)
    }

    args.push(command)

    const result = Bun.spawnSync(["tmux", ...args])
    if (result.exitCode !== 0) {
        throw new Error(`Failed to split window: ${result.stderr.toString()}`)
    }
}

/**
 * Join a pane from src to dst
 */
export function joinPane(src: string, dst: string, size?: number, direction: 'h' | 'v' = 'h'): void {
    const args = [
        "join-pane",
        "-s", src,
        "-t", dst,
        direction === 'h' ? "-h" : "-v"
    ]

    if (size) {
        args.push("-l", size.toString() + "%")
    }

    const result = Bun.spawnSync(["tmux", ...args])
    if (result.exitCode !== 0) {
        throw new Error(`Failed to join pane: ${result.stderr.toString()}`)
    }
}


/**
 * Break a pane out of its window into a new window (effectively hiding it from the dashboard)
 */
export function breakPane(src: string): void {
    const result = Bun.spawnSync([
        "tmux",
        "break-pane",
        "-s", src,
        "-d" // detached
    ])

    // We ignore errors here because sometimes the pane might already be broken or invalid
    // and we don't want to crash the navigator
}

/**
 * Resize a pane
 */
export function resizePane(target: string, size: number, direction: 'x' | 'y' = 'x'): void {
    const result = Bun.spawnSync([
        "tmux",
        "resize-pane",
        "-t", target,
        direction === 'x' ? "-x" : "-y",
        size.toString() + "%"
    ])
}

/**
 * Select a specific window in a session (0-indexed)
 */
export function selectWindow(sessionName: string, windowIndex: number): void {
    execSync(`tmux select-window -t "${sessionName}:${windowIndex}"`, {
        stdio: "pipe",
    })
}

/**
 * Attach to a tmux session
 * This spawns tmux in the foreground and takes over the terminal
 */
export function attachSession(sessionName: string): ChildProcess {
    const child = spawn("tmux", ["attach", "-t", sessionName], {
        stdio: "inherit",
    })
    return child
}

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): void {
    try {
        execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" })
    } catch {
        // Session might not exist, ignore
    }
}

/**
 * List windows in a session
 * Returns array of window names
 */
export function listWindows(sessionName: string): string[] {
    try {
        const output = execSync(
            `tmux list-windows -t "${sessionName}" -F "#{window_name}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        return output.trim().split("\n").filter(Boolean)
    } catch {
        return []
    }
}

/**
 * Get session info for a session
 * Returns null if session doesn't exist
 */
export function getSessionInfo(sessionName: string): {
    name: string
    windows: number
    attached: boolean
} | null {
    try {
        const output = execSync(
            `tmux list-sessions -F "#{session_name}:#{session_windows}:#{session_attached}" 2>/dev/null`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        const lines = output.trim().split("\n")
        for (const line of lines) {
            const [name, windows, attached] = line.split(":")
            if (name === sessionName) {
                return {
                    name,
                    windows: parseInt(windows || "0", 10),
                    attached: attached === "1",
                }
            }
        }
        return null
    } catch {
        return null
    }
}

/**
 * Generate the session name for a workstream
 */
export type WorkTmuxSessionSource = "implementation" | "supervision"

function formatWorkstreamTmuxPrefix(streamId: string, streamOrder?: number): string {
    if (typeof streamOrder === "number" && Number.isFinite(streamOrder) && streamOrder >= 0) {
        return Math.trunc(streamOrder).toString().padStart(3, "0")
    }

    const match = streamId.match(/^(\d{1,})/)
    if (match?.[1]) {
        return match[1].padStart(3, "0")
    }

    return "000"
}

function generateTmuxSuffix(length: number = 6): string {
    return randomBytes(Math.max(3, Math.ceil(length / 2))).toString("hex").slice(0, length)
}

export function getWorkSessionName(args: {
    streamId: string
    source: WorkTmuxSessionSource
    streamOrder?: number
    suffixLength?: number
}): string {
    const prefix = formatWorkstreamTmuxPrefix(args.streamId, args.streamOrder)
    const suffix = generateTmuxSuffix(args.suffixLength)
    return `${prefix}-${args.source}-${suffix}`
}

export function createUniqueWorkSessionName(args: {
    streamId: string
    source: WorkTmuxSessionSource
    streamOrder?: number
    suffixLength?: number
    maxAttempts?: number
}): string {
    const maxAttempts = args.maxAttempts ?? 10

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const sessionName = getWorkSessionName(args)
        if (!sessionExists(sessionName)) {
            return sessionName
        }
    }

    throw new Error(`Failed to allocate a unique tmux session name for ${args.source}`)
}

/**
 * Build a tmux command string for display (dry-run mode)
 */
export function buildCreateSessionCommand(
    sessionName: string,
    windowName: string,
    command: string
): string {
    return `tmux new-session -d -s "${sessionName}" -n "${windowName}" "${command}"`
}

/**
 * Build a tmux new-window command string for display (dry-run mode)
 */
export function buildAddWindowCommand(
    sessionName: string,
    windowName: string,
    command: string
): string {
    return `tmux new-window -t "${sessionName}" -n "${windowName}" "${command}"`
}

/**
 * Build a tmux attach command string for display (dry-run mode)
 */
export function buildAttachCommand(sessionName: string): string {
    return `tmux attach -t "${sessionName}"`
}

/**
 * Set a global option for a tmux session
 */
export function setGlobalOption(sessionName: string, option: string, value: string): void {
    const result = Bun.spawnSync([
        "tmux",
        "set-option",
        "-t", sessionName,
        option,
        value
    ])
    if (result.exitCode !== 0) {
        // Warning only, don't crash
        console.warn(`Warning: Failed to set tmux option ${option}: ${result.stderr.toString()}`)
    }
}

/**
 * Set a tmux session environment variable
 */
export function setSessionEnvironment(sessionName: string, name: string, value: string): void {
    const result = Bun.spawnSync([
        "tmux",
        "set-environment",
        "-t", sessionName,
        name,
        value,
    ])
    if (result.exitCode !== 0) {
        console.warn(`Warning: Failed to set tmux environment ${name}: ${result.stderr.toString()}`)
    }
}

/**
 * Mark a tmux session as headless for unattended execution.
 */
export function markSessionHeadless(sessionName: string): void {
    setGlobalOption(sessionName, HEADLESS_SESSION_OPTION, "1")
    setGlobalOption(sessionName, "remain-on-exit", "off")
    setSessionEnvironment(sessionName, WORKSTREAM_HEADLESS_ENV, "1")
}

/**
 * Check whether a tmux session has been marked headless.
 */
export function isSessionHeadless(sessionName: string): boolean {
    try {
        const output = execSync(
            `tmux show-options -t "${sessionName}" -v ${HEADLESS_SESSION_OPTION}`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        return output.trim() === "1"
    } catch {
        return false
    }
}

/**
 * Create a 2x2 grid layout in a window
 * Returns the 4 pane IDs in order: [TL, TR, BL, BR]
 *
 * Layout creation sequence:
 * 1. Start with single pane (pane 0)
 * 2. Split horizontally → [Left, Right]
 * 3. Split left vertically → [TL, BL, Right]
 * 4. Split right vertically → [TL, BL, TR, BR]
 */
export function createGridLayout(
    sessionWindow: string,
    commands: string[]
): string[] {
    // Ensure we have at least 1 command
    if (commands.length === 0) {
        throw new Error("createGridLayout requires at least 1 command")
    }

    // For 1 command, just return the existing pane
    if (commands.length === 1) {
        const paneIds = listPaneIds(sessionWindow)
        return paneIds.length > 0 ? [paneIds[0]!] : []
    }

    // For 2 commands, just split horizontally
    if (commands.length === 2) {
        // Split horizontally for second pane
        const splitResult = Bun.spawnSync([
            "tmux", "split-window",
            "-t", sessionWindow,
            "-h",
            commands[1]!
        ])
        if (splitResult.exitCode !== 0) {
            throw new Error(`Failed to create 2-pane layout: ${splitResult.stderr.toString()}`)
        }
        sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")
        return listPaneIds(sessionWindow)
    }

    // For 3+ commands, create grid
    // Step 1: Split horizontally (creates right pane)
    Bun.spawnSync([
        "tmux", "split-window",
        "-t", `${sessionWindow}.0`,
        "-h",
        commands[1]!
    ])
    sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")

    // Capture the right pane ID before it shifts
    // After horizontal split: pane 0 = left, pane 1 = right
    const panesAfterHSplit = listPaneIds(sessionWindow)
    const rightPaneId = panesAfterHSplit[1] // This is the right pane

    // Step 2: Split left pane vertically (creates bottom-left)
    // This will shift pane indices, but we have the right pane ID saved
    Bun.spawnSync([
        "tmux", "split-window",
        "-t", `${sessionWindow}.0`,
        "-v",
        commands[2]!
    ])
    sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")

    // Step 3: Split right pane vertically (creates bottom-right) if we have 4 commands
    // Use the saved pane ID to target the correct pane (not index-based)
    if (commands.length >= 4 && rightPaneId) {
        Bun.spawnSync([
            "tmux", "split-window",
            "-t", rightPaneId,
            "-v",
            commands[3]!
        ])
        sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")
    }

    return listPaneIds(sessionWindow)
}

/**
 * Respawn a pane with a new command
 * This replaces the command running in the pane, losing scrollback
 */
export function respawnPane(paneId: string, command: string): void {
    // First kill the pane's process
    Bun.spawnSync(["tmux", "respawn-pane", "-t", paneId, "-k", command])
}

/**
 * Get all pane IDs in a window
 */
export function listPaneIds(sessionWindow: string): string[] {
    try {
        const output = execSync(
            `tmux list-panes -t "${sessionWindow}" -F "#{pane_id}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        return output.trim().split("\n").filter(Boolean)
    } catch {
        return []
    }
}

/**
 * Send keys to a pane
 */
export function sendKeys(target: string, keys: string): void {
    Bun.spawnSync(["tmux", "send-keys", "-t", target, keys])
}

/**
 * Get the current pane index within a window
 */
export function getPaneIndex(paneId: string): number | null {
    try {
        const output = execSync(
            `tmux display-message -p -t "${paneId}" "#{pane_index}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        return parseInt(output.trim(), 10)
    } catch {
        return null
    }
}

/**
 * Focus (select) a specific pane
 */
export function selectPane(target: string): void {
    Bun.spawnSync(["tmux", "select-pane", "-t", target])
}

// ============================================
// PANE STATUS TRACKING (for session monitoring)
// ============================================

/**
 * Information about a pane's status
 */
export interface PaneStatus {
    paneId: string
    windowIndex: number
    paneIndex: number
    panePid: number | null    // PID of the process running in the pane
    paneTitle: string         // Pane title (if set)
    paneDead: boolean         // true if the pane's command has exited
    exitStatus: number | null // Exit status if pane is dead
}

/**
 * Get detailed status of all panes in a session
 * Useful for monitoring thread status in multi-window execution
 */
export function getSessionPaneStatuses(sessionName: string): PaneStatus[] {
    try {
        // Format: window_index, pane_index, pane_id, pane_pid, pane_title, pane_dead, pane_dead_status
        const output = execSync(
            `tmux list-panes -s -t "${sessionName}" -F "#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_title}|#{pane_dead}|#{pane_dead_status}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        
        return output.trim().split("\n").filter(Boolean).map(line => {
            const [windowIndex, paneIndex, paneId, panePid, paneTitle, paneDead, exitStatus] = line.split("|")
            return {
                paneId: paneId || "",
                windowIndex: parseInt(windowIndex || "0", 10),
                paneIndex: parseInt(paneIndex || "0", 10),
                panePid: panePid ? parseInt(panePid, 10) : null,
                paneTitle: paneTitle || "",
                paneDead: paneDead === "1",
                exitStatus: exitStatus ? parseInt(exitStatus, 10) : null,
            }
        })
    } catch {
        return []
    }
}

/**
 * Get the status of a specific pane
 * Returns null if the pane doesn't exist
 */
export function getPaneStatus(target: string): PaneStatus | null {
    try {
        const output = execSync(
            `tmux display-message -p -t "${target}" "#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_title}|#{pane_dead}|#{pane_dead_status}"`,
            { stdio: "pipe", encoding: "utf-8" }
        )
        
        const [windowIndex, paneIndex, paneId, panePid, paneTitle, paneDead, exitStatus] = output.trim().split("|")
        
        // If paneId is empty, the pane doesn't exist
        if (!paneId) {
            return null
        }
        
        return {
            paneId: paneId,
            windowIndex: parseInt(windowIndex || "0", 10),
            paneIndex: parseInt(paneIndex || "0", 10),
            panePid: panePid ? parseInt(panePid, 10) : null,
            paneTitle: paneTitle || "",
            paneDead: paneDead === "1",
            exitStatus: exitStatus ? parseInt(exitStatus, 10) : null,
        }
    } catch {
        return null
    }
}

/**
 * Check if a pane is still running (not dead)
 */
export function isPaneAlive(target: string): boolean {
    const status = getPaneStatus(target)
    return status !== null && !status.paneDead
}

/**
 * Get the exit code of a dead pane
 * Returns null if pane is still alive or doesn't exist
 */
export function getPaneExitCode(target: string): number | null {
    const status = getPaneStatus(target)
    if (!status || !status.paneDead) return null
    return status.exitStatus
}

/**
 * Poll all panes in a session and return those that have exited
 * Useful for detecting thread completion in batch execution
 */
export function getExitedPanes(sessionName: string): PaneStatus[] {
    return getSessionPaneStatuses(sessionName).filter(p => p.paneDead)
}

/**
 * Poll all panes in a session and return those that are still running
 */
export function getAlivePanes(sessionName: string): PaneStatus[] {
    return getSessionPaneStatuses(sessionName).filter(p => !p.paneDead)
}

/**
 * Wait for all panes in a session to exit (with optional timeout)
 * Returns the final status of all panes
 * 
 * @param sessionName - tmux session name
 * @param pollIntervalMs - How often to check (default: 1000ms)
 * @param timeoutMs - Max time to wait (default: 0 = infinite)
 * @returns Array of final pane statuses, or null if timeout
 */
export async function waitForAllPanesExit(
    sessionName: string,
    pollIntervalMs: number = 1000,
    timeoutMs: number = 0
): Promise<PaneStatus[] | null> {
    const startTime = Date.now()
    
    while (true) {
        const statuses = getSessionPaneStatuses(sessionName)
        
        // If session doesn't exist or no panes, we're done
        if (statuses.length === 0) {
            return []
        }
        
        // Check if all panes are dead
        const allDead = statuses.every(s => s.paneDead)
        if (allDead) {
            return statuses
        }
        
        // Check timeout
        if (timeoutMs > 0 && (Date.now() - startTime) >= timeoutMs) {
            return null // Timeout
        }
        
        // Wait before next poll
        await Bun.sleep(pollIntervalMs)
    }
}

/**
 * Set a pane's title (visible in tmux status bar)
 * Useful for tracking which thread is in which pane
 */
export function setPaneTitle(target: string, title: string): void {
    Bun.spawnSync(["tmux", "select-pane", "-t", target, "-T", title])
}
