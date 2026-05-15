/**
 * CLI: Multi Navigator
 *
 * Provides an SST-style TUI for navigating between thread panes in a tmux session.
 * This runs in a sidebar pane and controls the main content pane.
 */

import { join } from "path"
import { readFileSync } from "fs"
import readline from "readline"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { queryThreadsForWorkstream } from "../lib/hierarchy-query.ts"
import { loadAgentsConfig, getAgentYaml } from "../lib/agents-yaml.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import type { StreamDocument, BatchDefinition, StageDefinition } from "../lib/types.ts"
import {
    joinPane,
    breakPane,
    getPaneId,
    listWindows
} from "../lib/tmux.ts"

interface NavigatorArgs {
    repoRoot?: string
    streamId?: string
    batch?: string
    session?: string
    help?: boolean
}

// UI State
interface ThreadItem {
    id: string
    name: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    paneId?: string // associated tmux pane ID if known
    windowName: string // the window name where this thread lives (detached)
}

function parseArgs(argv: string[]): NavigatorArgs | null {
    const args = argv.slice(2)
    const parsed: Partial<NavigatorArgs> = {}

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]

        switch (arg) {
            case "--repo-root":
                parsed.repoRoot = next
                i++
                break
            case "--stream":
                parsed.streamId = next
                i++
                break
            case "--batch":
                parsed.batch = next
                i++
                break
            case "--session":
                parsed.session = next
                i++
                break
            case "--help":
            case "-h":
                parsed.help = true
                break
        }
    }
    return parsed as NavigatorArgs
}

function getThreadStatus(status: string | undefined): 'pending' | 'running' | 'completed' | 'failed' {
    if (status === 'blocked') return 'failed'
    if (status === 'in_progress') return 'running'
    if (status === 'completed') return 'completed'
    return 'pending'
}

class Navigator {
    private threads: ThreadItem[] = []
    private selectedIndex = 0
    private sessionName: string
    private currentContentPaneId: string | null = null
    private repoRoot: string
    private streamId: string

    constructor(
        repoRoot: string,
        streamId: string,
        threads: ThreadItem[],
        sessionName: string
    ) {
        this.repoRoot = repoRoot
        this.streamId = streamId
        this.threads = threads
        this.sessionName = sessionName

        // Initial setup handling
        // We assume the FIRST thread is already showing in the main pane (right side)
        // We need to find its pane ID.
        // But actually, multi.ts will start with Thread 1 showing.
    }

    start() {
        // Setup readline for key input
        readline.emitKeypressEvents(process.stdin)
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true)
        }

        process.stdin.on('keypress', (str, key) => {
            if (key.ctrl && key.name === 'c') {
                this.exit()
            } else if (key.name === 'q') {
                this.exit()
            } else if (key.name === 'up' || key.name === 'k') {
                this.moveSelection(-1)
            } else if (key.name === 'down' || key.name === 'j') {
                this.moveSelection(1)
            } else if (key.name === 'return' || key.name === 'enter') {
                this.activateThread(this.selectedIndex)
            } else if (key.name === 'i') {
                this.enterInteractiveMode()
            } else if (key.name === 'x') {
                this.killSessionIfDone()
            }
        })

        // Initial render
        this.render()

        // Start polling for status updates
        setInterval(() => this.updateStatus(), 1000)
    }

    private exit() {
        console.clear()
        process.exit(42)  // Special code for intentional quit (recognized by restart loop)
    }

    private moveSelection(delta: number) {
        const newIndex = this.selectedIndex + delta
        if (newIndex >= 0 && newIndex < this.threads.length) {
            this.selectedIndex = newIndex
            this.render()
            // User must press Enter to actually switch windows
        }
    }

    private updateStatus() {
        try {
            const threads = queryThreadsForWorkstream(this.repoRoot, this.streamId)

            let changed = false
            for (const thread of this.threads) {
                const newStatus = getThreadStatus(threads.find(candidate => candidate.threadId === thread.id)?.aggregateStatus)
                if (newStatus !== thread.status) {
                    thread.status = newStatus
                    changed = true
                }
            }
            if (changed) this.render()
        } catch (e) {
            // ignore
        }
    }

    private enterInteractiveMode() {
        // Switch focus to the content pane
        // We assume the content pane is the "other" pane in the current window (Dashboard)
        const myPaneId = process.env.TMUX_PANE
        if (!myPaneId) return

        // We can just use "last-pane" if there are only 2 panes, or find it.
        // `tmux select-pane -t :.+` selects the next pane.
        try {
            Bun.spawnSync(["tmux", "select-pane", "-t", `${this.sessionName}:0.+`])
        } catch (e) {
            // ignore
        }
    }

    private killSessionIfDone() {
        const allDone = this.threads.every(t => t.status === 'completed' || t.status === 'failed')
        if (allDone) {
            Bun.spawnSync(["tmux", "kill-session", "-t", this.sessionName])
            process.exit(0)
        }
    }

    // Simple file-based logger for debugging
    private log(msg: string) {
        const fs = typeof require !== 'undefined' ? require('fs') : null
        if (fs) {
            fs.appendFileSync("/tmp/work-navigator.log", `[${new Date().toISOString()}] ${msg}\n`)
        }
    }

    private async activateThread(index: number) {
        const targetThread = this.threads[index]!
        const myPaneId = process.env.TMUX_PANE
        this.log(`activateThread(${index}): myPaneId=${myPaneId}`)

        if (!myPaneId) return

        if (this.activeThreadIndex === index) {
            this.log(`Already active index ${index}`)
            return
        }

        const newThread = this.threads[index]!
        this.log(`Switching to ${newThread.id} (Window: ${newThread.windowName})`)

        // Simple approach: just switch to the target window
        // The navigator stays visible in current window but focus moves to thread window
        try {
            // Use select-window to switch to the target thread's window
            const selectCmd = ["tmux", "select-window", "-t", `${this.sessionName}:${newThread.windowName}`]
            this.log(`Running: ${selectCmd.join(" ")}`)
            const res = Bun.spawnSync(selectCmd)
            if (res.exitCode !== 0) {
                this.log(`select-window failed: ${await new Response(res.stderr).text()}`)
            }

            this.activeThreadIndex = index
            this.render()
            this.log(`Switch complete`)

        } catch (e) {
            this.log(`Exception during switch: ${e}`)
        }
    }

    // We track the index of the thread currently displayed in the content pane
    private activeThreadIndex = 0

    private render() {
        console.clear()
        console.log(`\n  \x1b[1m\x1b[36mWORK SESSIONS\x1b[0m\n`)

        this.threads.forEach((thread, idx) => {
            const isSelected = idx === this.selectedIndex
            const isActive = idx === this.activeThreadIndex

            let icon = "○"
            let color = "\x1b[37m" // white

            if (thread.status === 'running') {
                icon = "◐"
                color = "\x1b[36m" // cyan
            } else if (thread.status === 'completed') {
                icon = "●"
                color = "\x1b[32m" // green
            } else if (thread.status === 'failed') {
                icon = "x"
                color = "\x1b[31m" // red
            }

            const prefix = isSelected ? " \x1b[36m>\x1b[0m " : "   "
            const nameColor = isSelected ? "\x1b[1m\x1b[37m" : "\x1b[37m"
            const activeMarker = isActive ? "\x1b[33m*\x1b[0m" : " "

            console.log(`${prefix}${color}${icon}\x1b[0m ${nameColor}${thread.name}\x1b[0m ${activeMarker}`)
        })

        const allDone = this.threads.every(t => t.status === 'completed' || t.status === 'failed')

        console.log(`\n  \x1b[90mUse j/k to navigate\x1b[0m`)
        console.log(`  \x1b[90mi: interact / q: quit\x1b[0m`)
        if (allDone) {
            console.log(`  \x1b[32mx: kill session (all done)\x1b[0m`)
        }
    }
}

export async function main(argv: string[] = process.argv) {
    const args = parseArgs(argv)
    if (!args || !args.batch || !args.session) {
        console.error("Missing required arguments. Need --batch and --session")
        process.exit(1)
    }

    const repoRoot = args.repoRoot || getRepoRoot()
    const streamId = args.streamId || "default" // Should passed in

    // Load batch info
    // We need to duplicate some logic to find threads, or pass them in?
    // Let's reload them to be safe and stateless.

    // TODO: Ideally we get thread list passed in JSON or similar to avoid re-parsing logic.
    // But for now let's re-parse for robustness.

    // ... Copying logic from multi.ts to load threads ...
    // Simplified: we only need ID and Name to list them.

    // ...
    // Let's stick with PLAN.md loading for correctness
    const idx = loadIndex(repoRoot)
    const stream = getResolvedStream(idx, streamId)
    const planPath = join(repoRoot, "agenv", "work", stream.id, "PLAN.md")
    // Note: path might vary based on getWorkDir.
    // Let's use standard helpers if possible.

    // Just re-use the working parser logic?
    const wDir = getWorkDir(repoRoot)
    const pPath = join(wDir, stream.id, "PLAN.md")
    const content = readFileSync(pPath, "utf-8")
    const doc = parseStreamDocument(content, [])

    if (!doc) process.exit(1)

    // Find the batch
    const [sStr, bStr] = args.batch!.split(".")
    const sNum = parseInt(sStr!)
    const bNum = parseInt(bStr!)

    const stage = doc.stages.find(s => s.id === sNum)
    const batch = stage?.batches.find(b => b.id === bNum)

    if (!batch) process.exit(1)

    const threads: ThreadItem[] = batch.threads.map((t, idx) => {
        const tId = `${sStr}.${bStr}.${t.id.toString().padStart(2, '0')}`
        return {
            id: tId,
            name: t.name,
            windowName: `T${idx + 1}`, // Simple generic names: T1, T2, T3...
            status: 'pending' // will update
        }
    })

    const app = new Navigator(repoRoot, streamId, threads, args.session!)
    app.start()
}

if (import.meta.main) {
    main()
}
