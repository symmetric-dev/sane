import { isPendingInputRemovalRequest, isPendingInputRequest, isPendingInputResumeRequest, type PendingInputRemovalRequest, type PendingInputRequest, type PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";
import type { PendingInputOperation } from "./pending-input-presentation";

export type PendingInputRecord = {
  operation: PendingInputOperation; body: PendingInputRequest | PendingInputRemovalRequest | PendingInputResumeRequest;
  sourceScope: string; draftKey?: string; draftText?: string;
};
export const pendingInputLedgerKey = (origin: string, storeId: string) => `sane.pending-input.v1:${JSON.stringify([origin, storeId])}`;
const valid = (v: unknown): v is PendingInputRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as PendingInputRecord, o = r.operation;
  return typeof r.sourceScope === "string" && !!r.sourceScope && !!o && typeof o === "object"
    && ["pending", "unknown"].includes(o.state) && (o.text === undefined || typeof o.text === "string")
    && (o.error === undefined || typeof o.error === "string") && (r.draftKey === undefined || typeof r.draftKey === "string")
    && (r.draftText === undefined || typeof r.draftText === "string")
    && (o.kind === "enqueue" ? isPendingInputRequest(r.body, o) && r.body.text === o.text
      : o.kind === "remove" ? isPendingInputRemovalRequest(r.body, o) : o.kind === "resume" && isPendingInputResumeRequest(r.body, o));
};
/** Only unresolved intents live here. Never silently evict one to admit another.
 * localStorage is not an inter-tab mutex: read-before-write reduces collisions,
 * but independent tabs can legitimately submit separate UUID intents. */
export class PendingInputLedger {
  constructor(readonly key: string, private storage: Storage) {}
  read(): PendingInputRecord[] {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 32 || !value.every(valid) || new Set(value.map(r => r.operation.requestId)).size !== value.length) throw new Error("Pending-input recovery ledger is unreadable. No queue request was sent.");
    return value;
  }
  private write(records: PendingInputRecord[]) {
    const encoded = JSON.stringify(records);
    this.storage.setItem(this.key, encoded);
    if (this.storage.getItem(this.key) !== encoded) throw new Error("Pending-input recovery could not be saved. No new queue request was sent.");
  }
  reserve(record: PendingInputRecord) {
    if (!valid(record)) throw new Error("Invalid pending-input recovery identity.");
    const records = this.read();
    if (records.some(r => r.operation.conversationId === record.operation.conversationId)) throw new Error("Check the original unconfirmed queue operation before creating another.");
    if (records.length >= 32) throw new Error("Pending-input recovery ledger is full. Resolve an original operation first.");
    this.write([...records, record]);
  }
  unknown(record: PendingInputRecord, error: string) {
    const records = this.read(), next = { ...record, operation: { ...record.operation, state: "unknown" as const, error } };
    const old = records.findIndex(r => r.operation.requestId === record.operation.requestId);
    if (old >= 0) records[old] = next;
    else { if (records.length >= 32) throw new Error("Pending-input recovery ledger is full."); records.push(next); }
    this.write(records);
  }
  finish(requestId: string) { this.write(this.read().filter(r => r.operation.requestId !== requestId)); }
}
