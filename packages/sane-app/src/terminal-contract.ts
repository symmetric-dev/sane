/** Same-origin cookie-authenticated worktree resource, independent of harness runs.
 * Base: /api/workspaces/:workspaceId/worktrees/:worktreeId/terminal
 * GET -> TerminalState (never starts); POST TerminalStart -> state (explicit start).
 * POST base/close or base/restart with TerminalStart -> state.
 * GET base/socket upgrades to WebSocket; exact configured Origin required.
 * Every attachment begins with hello then snapshot. Apply snapshot to a reset
 * xterm at its dimensions; acknowledge ONLY from xterm.write's completion callback.
 * Thereafter apply sequenced output/resize in order, acknowledging each completion.
 * Multiple deltas may be in flight within bounded frame/serialized-byte windows.
 * ACK exactly the oldest pending frame (not cumulative); the initial snapshot
 * must complete and be acknowledged before any delta is sent. Later sends do
 * not extend the oldest pending frame's acknowledgement deadline.
 * Output is base64 of original PTY bytes; pass decoded Uint8Array to xterm.write.
 * Snapshot data is a serialized ANSI string (NOT base64). Input data is base64
 * bytes too. Snapshot seq may be zero; subsequent output/resize seq increases by
 * exactly one. State dimensions are informational; apply live resize only from
 * sequenced resize messages. No input buffering/replay on reconnect.
 * claim/take/release require the last observed generation; reconnect is a viewer.
 * A close (including overload) requires a fresh attach/snapshot, never delta replay.
 * Socket close codes: 4401 revoked auth, 1008 invalid protocol, 1009 oversize,
 * 1012 replacement/shutdown, 1013 backlog/gap/ack or snapshot timeout.
 * Terminal status is the shell/resource lifecycle; ptyClosed is independent.
 * exitCode comes only from Subprocess.exited, never from the PTY exit callback.
 * Config capability: GET /api/config -> capabilities.terminal.
 */
export const TERMINAL_LIMITS = { terminals: 8, attachments: 8, cols: 240, rows: 100, minCols: 20, minRows: 5, inputBytes: 8192, chunkBytes: 16384, backlogBytes: 1048576, snapshotBytes: 2097152, outputWindowFrames: 32, outputWindowBytes: 262144, scrollback: 500 } as const;
export type TerminalCapability = { available: boolean; reason?: string };
export type TerminalStart = { bindingRevision: string; cols?: number; rows?: number };
export type TerminalState = {
  capability: TerminalCapability; workspaceId: string; worktreeId: string;
  terminalId: string | null; bindingRevision: string; status: "absent" | "running" | "exited" | "closed" | "overloaded";
  cols: number; rows: number; generation: number; controllerId: string | null;
  exitCode: number | null; ptyClosed: boolean; reason?: string;
};
export type TerminalClientMessage =
  | { type: "ack"; seq: number }
  | { type: "claim" | "take" | "release"; generation: number }
  | { type: "input"; generation: number; data: string }
  | { type: "resize"; generation: number; cols: number; rows: number }
  | { type: "interrupt"; generation: number };
export type TerminalServerMessage =
  | { type: "hello"; attachmentId: string; state: TerminalState }
  | { type: "snapshot"; seq: number; data: string; cols: number; rows: number }
  | { type: "output"; seq: number; data: string }
  | { type: "resize"; seq: number; cols: number; rows: number }
  | { type: "state"; state: TerminalState }
  | { type: "error"; code: string; message: string };
