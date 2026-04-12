import { describe, expect, test, afterEach } from "bun:test"
import {
    getWorkSessionName,
    buildCreateSessionCommand,
    buildAddWindowCommand,
    buildAttachCommand,
    getSessionPaneStatuses,
    getPaneStatus,
    isPaneAlive,
    getPaneExitCode,
    getExitedPanes,
    getAlivePanes,
    type PaneStatus,
    createSession,
    addWindow,
    sessionExists,
    listWindows,
    killSession,
    listPaneIds,
    splitWindow,
    getPaneIndex,
    setGlobalOption,
    markSessionHeadless,
    isSessionHeadless,
    createGridLayout,
    respawnPane,
    waitForAllPanesExit,
    getSessionInfo,
    getPaneId,
    sendKeys,
    joinPane,
    breakPane,
    resizePane,
    selectWindow,
    selectPane,
} from "../src/lib/tmux"
import { execSync } from "child_process"

describe("tmux lib", () => {
    const describeTmuxIntegration = process.env.CI ? describe.skip : describe

    describeTmuxIntegration("integration", () => {
        const testSessions: string[] = []

        const getTestSessionName = () => {
            const name = `test-session-${Math.random().toString(36).substring(7)}`
            testSessions.push(name)
            return name
        }

        afterEach(() => {
            testSessions.forEach(name => {
                try {
                    execSync(`tmux kill-session -t "${name}" 2>/dev/null`)
                } catch {}
            })
            testSessions.length = 0
        })

        test("createSession creates a new session with initial window", () => {
            const sessionName = getTestSessionName()
            const windowName = "initial"
            createSession(sessionName, windowName, "sleep 10")
            expect(sessionExists(sessionName)).toBe(true)
            const windows = listWindows(sessionName)
            expect(windows).toContain(windowName)
        })

        test("addWindow adds a window to existing session", () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "win1", "sleep 10")
            const win2 = "win2"
            addWindow(sessionName, win2, "sleep 10")
            const windows = listWindows(sessionName)
            expect(windows).toHaveLength(2)
            expect(windows).toContain("win1")
            expect(windows).toContain(win2)
        })

        test("splitWindow splits the current pane", () => {
            const sessionName = getTestSessionName()
            const windowName = "split-test"
            createSession(sessionName, windowName, "sleep 10")
            const target = `${sessionName}:${windowName}`
            const paneIdsBefore = listPaneIds(target)
            expect(paneIdsBefore).toHaveLength(1)
            splitWindow(target, "sleep 10", 50, 'h')
            const paneIdsAfter = listPaneIds(target)
            expect(paneIdsAfter).toHaveLength(2)
        })

        test("createGridLayout creates 2x2 grid for 4 commands", () => {
            const sessionName = getTestSessionName()
            const windowName = "grid-test"
            createSession(sessionName, windowName, "sleep 10")
            const target = `${sessionName}:${windowName}`
            const commands = ["sleep 10", "sleep 10", "sleep 10", "sleep 10"]
            const panes = createGridLayout(target, commands)
            expect(panes).toHaveLength(4)
            const currentPanes = listPaneIds(target)
            expect(currentPanes).toHaveLength(4)
            panes.forEach(p => expect(currentPanes).toContain(p))
        }, 15000) // Extended timeout for 3s stagger delays between threads

        test("getSessionPaneStatuses returns correct status", () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "status-test", "sleep 10")
            const statuses = getSessionPaneStatuses(sessionName)
            expect(statuses).toHaveLength(1)
            const status = statuses[0]
            expect(status?.windowIndex).toBe(0)
            expect(status?.paneIndex).toBe(0)
            expect(status?.paneDead).toBe(false)
            expect(status?.paneId).toBeDefined()
            expect(status?.paneId).toStartWith("%")
        })

        test("waitForAllPanesExit detects completion", async () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "wait-test", "sleep 10")
            execSync(`tmux set-option -t "${sessionName}" remain-on-exit on`)
            respawnPane(`${sessionName}:0.0`, "sleep 0.5")
            const result = await waitForAllPanesExit(sessionName, 100, 2000)
            expect(result).not.toBeNull()
            expect(result).toHaveLength(1)
            expect(result![0]!.paneDead).toBe(true)
        })

        test("waitForAllPanesExit times out if panes stay alive", async () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "timeout-test", "sleep 10")
            const result = await waitForAllPanesExit(sessionName, 100, 200)
            expect(result).toBeNull()
        })

        test("respawnPane restarts the pane command", async () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "respawn-test", "sleep 10")
            const paneId = `${sessionName}:0.0`
            const initialStatus = getPaneStatus(paneId)
            const initialPid = initialStatus?.panePid
            expect(initialPid).toBeDefined()
            respawnPane(paneId, "sleep 10")
            await new Promise(r => setTimeout(r, 500))
            const newStatus = getPaneStatus(paneId)
            expect(newStatus?.panePid).toBeDefined()
            expect(newStatus?.panePid).not.toBe(initialPid)
            expect(newStatus?.paneDead).toBe(false)
       })

       test("getSessionInfo returns correct info", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "info-test", "sleep 10")
           addWindow(sessionName, "win2", "sleep 10")
           const info = getSessionInfo(sessionName)
           expect(info).not.toBeNull()
           expect(info?.name).toBe(sessionName)
           expect(info?.windows).toBe(2)
       })

       test("getPaneId returns valid pane id", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "pane-id-test", "sleep 10")
           const paneId = getPaneId(`${sessionName}:0.0`)
           expect(paneId).toStartWith("%")
       })

       test("sendKeys sends keys to pane", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "keys-test", "cat")
           sendKeys(`${sessionName}:0.0`, "hello\n")
       })

       test("createGridLayout handles 1 and 2 commands", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "grid-test-small", "sleep 10")
           const panes1 = createGridLayout(`${sessionName}:0`, ["sleep 10"])
           expect(panes1).toHaveLength(1)
           addWindow(sessionName, "win2", "sleep 10")
           const panes2 = createGridLayout(`${sessionName}:win2`, ["sleep 10", "sleep 10"])
           expect(panes2).toHaveLength(2)
       }, 10000) // Extended timeout for 3s stagger delay
       
       test("joinPane moves pane between windows", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "join-test", "sleep 10")
           addWindow(sessionName, "win2", "sleep 10")
           joinPane(`${sessionName}:win2.0`, `${sessionName}:0`, 30)
           const panes = listPaneIds(`${sessionName}:0`)
           expect(panes).toHaveLength(2)
       })

       test("breakPane removes pane from window", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "break-test", "sleep 10")
           splitWindow(`${sessionName}:0`, "sleep 10")
           
           const panes = listPaneIds(`${sessionName}:0`)
           expect(panes).toHaveLength(2)
           const paneToBreak = panes[1]!
           
           breakPane(paneToBreak)
           
           const panesAfter = listPaneIds(`${sessionName}:0`)
           expect(panesAfter).toHaveLength(1)
       })

       test("isPaneAlive check", () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "alive-test", "sleep 10")
            expect(isPaneAlive(`${sessionName}:0.0`)).toBe(true)
       })

       test("getPaneIndex returns index", () => {
            const sessionName = getTestSessionName()
            createSession(sessionName, "index-test", "sleep 10")
            const index = getPaneIndex(`${sessionName}:0.0`)
            expect(index).toBe(0)
       })

        test("setGlobalOption sets option", () => {
             const sessionName = getTestSessionName()
             createSession(sessionName, "opt-test", "sleep 10")
             setGlobalOption(sessionName, "remain-on-exit", "on")
            
             const output = execSync(`tmux show-options -t "${sessionName}" -v remain-on-exit`, {encoding: 'utf-8'})
             expect(output.trim()).toBe("on")
        })

        test("markSessionHeadless marks tmux session metadata", () => {
             const sessionName = getTestSessionName()
             createSession(sessionName, "headless-test", "sleep 10")

             markSessionHeadless(sessionName)

             expect(isSessionHeadless(sessionName)).toBe(true)
             const option = execSync(`tmux show-options -t "${sessionName}" -v @workstream-headless`, { encoding: 'utf-8' })
             const env = execSync(`tmux show-environment -t "${sessionName}" WORKSTREAM_HEADLESS`, { encoding: 'utf-8' })
             expect(option.trim()).toBe("1")
             expect(env.trim()).toBe("WORKSTREAM_HEADLESS=1")
        })

       test("resizePane changes pane size", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "resize-test", "sleep 10")
           splitWindow(`${sessionName}:0`, "sleep 10")
           const panes = listPaneIds(`${sessionName}:0`)
           
           // Just verify it runs without error
           resizePane(panes[0]!, 20, 'x')
       })

       test("selectWindow and selectPane execution", () => {
           const sessionName = getTestSessionName()
           createSession(sessionName, "select-test", "sleep 10")
           addWindow(sessionName, "win2", "sleep 10")
           
           selectWindow(sessionName, 1)
           selectPane(`${sessionName}:0.0`)
       })
    })

    describe("getWorkSessionName", () => {
        test("truncates long names", () => {
            const longId = "001-very-long-stream-name-that-is-too-long"
            const name = getWorkSessionName(longId)
            expect(name).toBe("work-001-very-long-stream")
            expect(name.length).toBeLessThanOrEqual(25) // work- prefix + 20 chars
        })

        test("keeps short names", () => {
            const shortId = "001-test"
            expect(getWorkSessionName(shortId)).toBe("work-001-test")
        })
    })

    describe("build commands", () => {
        test("buildCreateSessionCommand quotes arguments", () => {
            const cmd = buildCreateSessionCommand("session", "win", "echo 'hello'")
            expect(cmd).toBe('tmux new-session -d -s "session" -n "win" "echo \'hello\'"')
        })

        test("buildAddWindowCommand quotes arguments", () => {
            const cmd = buildAddWindowCommand("session", "win2", "ls -la")
            expect(cmd).toBe('tmux new-window -t "session" -n "win2" "ls -la"')
        })

        test("buildAttachCommand quotes session name", () => {
            const cmd = buildAttachCommand("session-name")
            expect(cmd).toBe('tmux attach -t "session-name"')
        })
    })

    describe("pane status functions", () => {
        // Note: These functions interact with tmux, so we can only test 
        // their behavior when tmux is not available (graceful fallbacks)

        test("getSessionPaneStatuses returns empty array for non-existent session", () => {
            const statuses = getSessionPaneStatuses("non-existent-session-12345")
            expect(statuses).toEqual([])
        })

        test("getPaneStatus returns null for non-existent pane", () => {
            const status = getPaneStatus("non-existent-session:0.0")
            expect(status).toBeNull()
        })

        test("isPaneAlive returns false for non-existent pane", () => {
            const alive = isPaneAlive("non-existent-session:0.0")
            expect(alive).toBe(false)
        })

        test("getPaneExitCode returns null for non-existent pane", () => {
            const exitCode = getPaneExitCode("non-existent-session:0.0")
            expect(exitCode).toBeNull()
        })

        test("getExitedPanes returns empty array for non-existent session", () => {
            const exited = getExitedPanes("non-existent-session-12345")
            expect(exited).toEqual([])
        })

        test("getAlivePanes returns empty array for non-existent session", () => {
            const alive = getAlivePanes("non-existent-session-12345")
            expect(alive).toEqual([])
        })
    })
})
