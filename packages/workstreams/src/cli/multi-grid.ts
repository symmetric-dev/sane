/**
 * CLI: Multi Grid Controller
 *
 * Manages the 2x2 grid view for work multi sessions with pagination.
 * Runs in a small status bar at the bottom and handles keybindings.
 */

import { join } from "path"
import { readFileSync } from "fs"
import readline from "readline"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { queryThreadsForWorkstream } from "../lib/hierarchy-query.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import {
    respawnPane,
    listPaneIds,
    selectPane,
} from "../lib/tmux.ts"

interface GridArgs {
    repoRoot?: string
    streamId?: string
    batch?: string
    session?: string
    help?: boolean
}

interface ThreadInfo {
    id: string        // "01.01.01"
    name: string
    command: string   // Full command to run this thread
    status: 'pending' | 'running' | 'completed' | 'failed'
}

/**
 * Grid position mapping
 * We have 4 pane slots: TL(0), TR(1), BL(2), BR(3)
 */
type GridPosition = 0 | 1 | 2 | 3

/**
 * Parse command line arguments
 */
function parseArgs(argv: string[]): GridArgs | null {
    const args = argv.slice(2)
    const parsed: Partial<GridArgs> = {}

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
    return parsed as GridArgs
}

/**
 * Get thread status from canonical hierarchy state
 */
function getThreadStatus(repoRoot: string, streamId: string, threadId: string): ThreadInfo['status'] {
    const thread = queryThreadsForWorkstream(repoRoot, streamId).find((candidate) => candidate.threadId === threadId)
    if (!thread) return 'pending'
    if (thread.aggregateStatus === 'blocked') return 'failed'
    if (thread.aggregateStatus === 'in_progress') return 'running'
    if (thread.aggregateStatus === 'completed') return 'completed'
    return 'pending'
}

class GridController {
    private threads: ThreadInfo[] = []
    private sessionName: string
    private repoRoot: string
    private streamId: string
    private paneIds: string[] = []  // Current pane IDs [TL, TR, BL, BR]

    // Pagination state
    private offset = 0  // Index of thread currently in TL position
    private readonly gridSize = 4

    constructor(
        repoRoot: string,
        streamId: string,
        threads: ThreadInfo[],
        sessionName: string,
        paneIds: string[]
    ) {
        this.repoRoot = repoRoot
        this.streamId = streamId
        this.threads = threads
        this.sessionName = sessionName
        this.paneIds = paneIds
    }

    start() {
        readline.emitKeypressEvents(process.stdin)
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true)
        }

        process.stdin.on('keypress', (str, key) => {
            if (key.ctrl && key.name === 'c') {
                this.exit()
            } else if (key.name === 'q') {
                this.exit()
            } else if (key.name === 'n' || key.name === 'right') {
                this.nextPage()
            } else if (key.name === 'p' || key.name === 'left') {
                this.prevPage()
            } else if (key.name === 'x') {
                this.killSessionIfDone()
            } else if (key.name === '1') {
                this.focusPane(0)
            } else if (key.name === '2') {
                this.focusPane(1)
            } else if (key.name === '3') {
                this.focusPane(2)
            } else if (key.name === '4') {
                this.focusPane(3)
            }
        })

        // Initial render
        this.render()

        // Poll for status updates
        setInterval(() => this.updateStatus(), 2000)
    }

    private exit() {
        console.clear()
        process.exit(42)  // Special code for intentional quit
    }

    /**
     * Move to next page (scroll by 1)
     *
     * Pane rotation (scroll-by-1):
     *   TL ← TR  (old TR moves to TL)
     *   TR ← BR  (old BR moves to TR)
     *   BL stays BL
     *   BR ← new thread (or wraps)
     */
    private nextPage() {
        const maxOffset = Math.max(0, this.threads.length - this.gridSize)
        if (this.offset >= maxOffset) {
            // Already at last page
            return
        }

        this.offset++

        // Get the thread indices for new positions
        // After scroll: TL=offset, TR=offset+1, BL=offset+2, BR=offset+3
        this.updatePaneContents()
        this.render()
    }

    /**
     * Move to previous page (scroll by 1)
     *
     * Reverse rotation:
     *   BR ← TR  (old TR moves to BR)
     *   TR ← TL  (old TL moves to TR)
     *   BL stays BL
     *   TL ← previous thread
     */
    private prevPage() {
        if (this.offset <= 0) {
            // Already at first page
            return
        }

        this.offset--
        this.updatePaneContents()
        this.render()
    }

    /**
     * Update all pane contents based on current offset
     */
    private updatePaneContents() {
        // Grid positions: [TL, TR, BL, BR]
        // Thread indices: [offset, offset+1, offset+2, offset+3]
        const positions: GridPosition[] = [0, 1, 2, 3]

        for (const pos of positions) {
            const threadIdx = this.offset + pos
            if (threadIdx < this.threads.length && this.paneIds[pos]) {
                const thread = this.threads[threadIdx]!
                respawnPane(this.paneIds[pos]!, thread.command)
            }
        }
    }

    private focusPane(position: GridPosition) {
        if (this.paneIds[position]) {
            selectPane(this.paneIds[position]!)
        }
    }

    private updateStatus() {
        try {
            let changed = false
            for (const thread of this.threads) {
                const newStatus = getThreadStatus(this.repoRoot, this.streamId, thread.id)
                if (newStatus !== thread.status) {
                    thread.status = newStatus
                    changed = true
                }
            }
            if (changed) this.render()
        } catch {
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

    private render() {
        console.clear()

        // Calculate page info
        const currentPage = Math.floor(this.offset / 1) + 1  // scroll-by-1
        const totalPages = Math.max(1, this.threads.length - this.gridSize + 1)

        // Status icons for visible threads
        const visibleThreads = this.threads.slice(this.offset, this.offset + this.gridSize)
        const statusLine = visibleThreads.map((t, i) => {
            const pos = i + 1
            let icon = "○"
            let color = "\x1b[37m"
            if (t.status === 'running') { icon = "◐"; color = "\x1b[36m" }
            else if (t.status === 'completed') { icon = "●"; color = "\x1b[32m" }
            else if (t.status === 'failed') { icon = "✗"; color = "\x1b[31m" }
            return `${color}${pos}:${icon}\x1b[0m`
        }).join("  ")

        const allDone = this.threads.every(t => t.status === 'completed' || t.status === 'failed')

        // Compact status bar
        let bar = ` ${statusLine}`
        if (this.threads.length > this.gridSize) {
            bar += `  \x1b[90m[${this.offset + 1}-${Math.min(this.offset + this.gridSize, this.threads.length)}/${this.threads.length}]\x1b[0m`
            bar += `  \x1b[90mn/p:page\x1b[0m`
        }
        bar += `  \x1b[90m1-4:focus  q:quit\x1b[0m`
        if (allDone) {
            bar += `  \x1b[32mx:kill\x1b[0m`
        }

        console.log(bar)
    }
}

export async function main(argv: string[] = process.argv) {
    const args = parseArgs(argv)
    if (!args || !args.batch || !args.session) {
        console.error("Missing required arguments. Need --batch and --session")
        process.exit(1)
    }

    const repoRoot = args.repoRoot || getRepoRoot()
    const streamId = args.streamId || "default"

    // Load stream and batch info
    const idx = loadIndex(repoRoot)
    const stream = getResolvedStream(idx, streamId)
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

    // Build thread info with commands
    // We need to reconstruct the commands (port, model, prompt path)
    // For now, we'll receive these via environment or args
    // Simplified: use placeholder commands
    const threads: ThreadInfo[] = batch.threads.map((t) => {
        const tId = `${sStr}.${bStr}.${t.id.toString().padStart(2, '0')}`
        return {
            id: tId,
            name: t.name,
            command: process.env[`THREAD_CMD_${t.id}`] || `echo "Thread ${t.id}: ${t.name}"`,
            status: 'pending' as const
        }
    })

    // Get current pane IDs from the grid window
    const paneIds = listPaneIds(`${args.session}:0`)

    const controller = new GridController(repoRoot, streamId, threads, args.session!, paneIds)
    controller.start()
}

if (import.meta.main) {
    main()
}
