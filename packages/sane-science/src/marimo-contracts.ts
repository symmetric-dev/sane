export interface MarimoBinding {
  url: string
  sessionId: string
  /** Caller-owned launch identity, not a marimo revision or kernel generation. */
  serverGeneration: string
}

export interface MarimoPairOptions {
  python: string
  tokenFile: string
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface MarimoNotebook {
  server: { url: string }
  name: string | null
  path: string | null
  sessions: { id: string }[]
}

export interface MarimoListing {
  notebooks: MarimoNotebook[]
  /** A successful CLI exit does not imply these warnings are empty. */
  warnings: string[]
  next?: string
}

export type MarimoCellStatus = "idle" | "exception" | "stale" | "cancelled" | "interrupted" | "marimo-error" | "disabled" | "queued" | "running" | null
export type MarimoJson = null | boolean | number | string | MarimoJson[] | { [key: string]: MarimoJson }
export interface MarimoOutput {
  channel: string
  mimetype: string
  data: MarimoJson
  timestamp: number
}

export interface MarimoCell {
  id: string
  code: string
  sourceHash: string
  name: string
  status: MarimoCellStatus
  errors: { kind: "graph" | "runtime"; message: string }[]
  output: MarimoOutput | null
  consoleOutputs: MarimoOutput[]
}

export interface MarimoSnapshot {
  binding: MarimoBinding
  cells: MarimoCell[]
  /** Runtime graph, which can lag edited, unexecuted document source. */
  graph: { parents: Record<string, string[]>; children: Record<string, string[]> }
}

export interface MarimoOperationResult {
  binding: MarimoBinding
  cellId: string
  mutation: "accepted" | "rejected" | "unknown" | "not-requested"
  execution: "succeeded" | "failed" | "unknown" | "not-requested"
  /** Code-mode autosave is asynchronous and is not acknowledged by pair. */
  durability: "unconfirmed"
  stdout: string
  stderr: string
  error?: string
  snapshot?: MarimoSnapshot
  snapshotError?: string
}

export class MarimoPairError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "VERSION_MISMATCH" | "PROCESS_FAILED" | "INVALID_RESPONSE" | "PAIR_FAILED",
    message: string,
    public readonly outcome: "not-started" | "unknown" = "not-started",
  ) { super(message); this.name = "MarimoPairError" }
}
