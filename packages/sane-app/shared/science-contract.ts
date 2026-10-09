/** Browser contract: no filesystem paths, runtime URLs, credentials, or raw pair output. */
export interface ScienceSession {
  notebook: string;
  /** Opaque App capability, replaced on every open; never a Marimo session ID. */
  generation: string;
  state: "server-unverified" | "awaiting-browser-session" | "awaiting-session-selection" | "session-ready" | "session-lost" | "stopped" | "failed";
}
export interface ScienceStatus {
  workspaceId: string;
  worktreeId: string;
  bindingRevision: string;
  repositoryId: string;
  environment: { state: "missing" | "scaffolded" | "ready" | "incompatible" | "provisioning"; python: string; marimo: string };
  nativeAvailable: boolean;
  notebooks: string[];
  sessions: ScienceSession[];
}
export type ScienceJson = null | boolean | number | string | ScienceJson[] | { [key: string]: ScienceJson };
/** Outputs are untrusted notebook content; HTML needs an isolated renderer. */
export interface ScienceOutput { channel: string; mimetype: string; data: ScienceJson; timestamp: number }
export interface ScienceCell {
  id: string;
  code: string;
  sourceHash: string;
  name: string;
  status: "idle" | "exception" | "stale" | "cancelled" | "interrupted" | "marimo-error" | "disabled" | "queued" | "running" | null;
  errors: { kind: "graph" | "runtime"; message: string }[];
  output: ScienceOutput | null;
  consoleOutputs: ScienceOutput[];
}
export interface ScienceSnapshot { cells: ScienceCell[]; graph: { parents: Record<string, string[]>; children: Record<string, string[]> } }
type Bound = { bindingRevision: string };
type Selected = Bound & { notebook: string; generation: string };
/** POST to the same URL as GET status. Unknown fields are rejected. */
export type ScienceRequest =
  | (Bound & { action: "provision" })
  | (Bound & { action: "create" | "open"; notebook: string })
  | (Selected & { action: "inspect" })
  | (Selected & { action: "close" })
  | (Selected & { action: "edit"; cellId: string; code: string; expectedSourceHash: string })
  | (Selected & { action: "run"; cellId: string });
export interface ScienceResponse {
  status: ScienceStatus;
  session?: ScienceSession;
  snapshot?: ScienceSnapshot;
  operation?: {
    cellId: string;
    mutation: "accepted" | "rejected" | "unknown" | "not-requested";
    execution: "succeeded" | "failed" | "unknown" | "not-requested";
    durability: "unconfirmed";
    /** Generic diagnostic only; backend stdout/stderr are never forwarded. */
    issue?: "operation-error" | "snapshot-unavailable";
  };
}
