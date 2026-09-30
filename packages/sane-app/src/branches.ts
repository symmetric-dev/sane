import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid } from "./history";

export type BranchOperation = {
  id: string; sourceId: string; destinationId: string; nativeId?: string;
  boundary: string; before?: string; sourceFingerprint: string; selector: string; replace: boolean;
  state: "reserved" | "creation_unknown" | "confirmed" | "completed" | "failed";
  createdAt: string; error?: string;
  firstMessage?: string; firstRunId?: string;
};
/** Publish before every irreversible step. Unknown native creation is never replayed. */
export class BranchStore {
  private records: BranchOperation[];
  constructor(private directory: string) {
    const path = join(directory, "branches.json");
    const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, operations: [] };
    if (data.version !== 1 || !Array.isArray(data.operations)) throw new Error("Invalid branch operation journal");
    const ids = new Set<string>();
    for (const op of data.operations) {
      if (!uuid(op.id) || ids.has(op.id) || !uuid(op.sourceId) || !uuid(op.destinationId) || op.sourceId === op.destinationId || typeof op.boundary !== "string" || !op.boundary || typeof op.replace !== "boolean" || !["reserved", "creation_unknown", "confirmed", "completed", "failed"].includes(op.state) || !Number.isFinite(Date.parse(op.createdAt)) || op.nativeId !== undefined && typeof op.nativeId !== "string" || op.before !== undefined && typeof op.before !== "string" || op.error !== undefined && typeof op.error !== "string") throw new Error("Invalid branch operation journal");
      ids.add(op.id);
      if (!/^[a-f0-9]{64}$/.test(op.sourceFingerprint) || ["confirmed", "completed"].includes(op.state) && !op.nativeId) throw new Error("Invalid branch native evidence");
      if (typeof op.selector !== "string" || !/^(run|message):.+$/.test(op.selector)) throw new Error("Invalid branch selector");
      if (op.firstMessage !== undefined && (typeof op.firstMessage !== "string" || !op.firstMessage.trim() || op.firstMessage.length > 100000) || op.firstRunId !== undefined && (!uuid(op.firstRunId) || !op.firstMessage)) throw new Error("Invalid branch first-message reservation");
    }
    this.records = data.operations;
  }
  list() { return structuredClone(this.records); }
  get(id: string) { return this.list().find(op => op.id === id); }
  pending(sessionId: string) { return this.list().find(op => !["completed", "failed"].includes(op.state) && (op.sourceId === sessionId || op.destinationId === sessionId)); }
  replaced(sessionId: string) { return this.list().find(op => op.sourceId === sessionId && op.replace && op.state === "completed"); }
  save(operation: BranchOperation) {
    const old = this.records.find(op => op.id === operation.id);
    if (old) {
      for (const key of ["sourceId", "destinationId", "boundary", "before", "sourceFingerprint", "selector", "replace", "createdAt", "firstMessage"] as const) if (old[key] !== operation[key]) throw new Error("Branch operation identity is immutable");
      if (old.nativeId && old.nativeId !== operation.nativeId) throw new Error("Branch native identity is immutable");
      if (old.firstRunId && old.firstRunId !== operation.firstRunId) throw new Error("Branch first run is immutable");
      const transitions: Record<BranchOperation["state"], BranchOperation["state"][]> = { reserved: ["reserved", "creation_unknown", "failed"], creation_unknown: ["creation_unknown", "confirmed"], confirmed: ["confirmed", "completed"], completed: ["completed"], failed: ["failed"] };
      if (!transitions[old.state].includes(operation.state)) throw new Error("Invalid branch operation transition");
    } else if (operation.state !== "reserved" || this.pending(operation.sourceId) || this.pending(operation.destinationId)) throw new Error("Conversation already has a branch reservation");
    const next = this.records.filter(op => op.id !== operation.id).concat(structuredClone(operation));
    atomicAppRecord(this.directory, "branches.json", { version: 1, operations: next });
    this.records = next;
  }
}
