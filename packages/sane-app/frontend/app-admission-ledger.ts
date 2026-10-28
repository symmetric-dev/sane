import { APP_ADMISSION_MAX_RECEIPT_BYTES, appAdmissionRecoveryStorageKey } from "../shared/conversation/app-admission-contract";
import type { AppAdmissionLookup, AppAdmissionReceipt, AppAdmissionRecoveryScope } from "../shared/conversation/app-admission-contract";
import { decodeAppAdmissionRecovery, encodeAppAdmissionRecovery, settleAppAdmissionRecovery } from "./app-admission-recovery";
import type { AppAdmissionRecoveryRecord } from "./app-admission-recovery";

export const APP_ADMISSION_LEDGER_MAX_RECORDS = 256;
export const APP_ADMISSION_LEDGER_MAX_BYTES = 8_000_000;

// Mirrors app-admission-recovery's private MAX_RECORD_BYTES. Reserving aggregate
// space alone is insufficient if that codec would refuse the terminal record.
const MAX_RECOVERY_RECORD_BYTES = 1_000_000;

/** One immutable request per key. Storage failures always fail closed; neither
 * absence nor capacity pressure authorizes eviction or retransmission. */
export class AppAdmissionLedger {
  readonly prefix: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(readonly scope: AppAdmissionRecoveryScope, private readonly storage: Storage) {
    this.prefix = `${appAdmissionRecoveryStorageKey(scope)}:`;
  }

  private key(requestId: string): string { return `${this.prefix}${requestId}`; }

  private verifyLiveTarget(record: AppAdmissionRecoveryRecord) {
    if (record.envelope.intent.operation === "live-input" && record.receipt?.state === "admitted"
      && record.receipt.target.dispatch.runId !== record.envelope.intent.expectedLiveRunId) {
      throw new Error("App admission live-input target does not match the original frozen run.");
    }
  }

  private snapshot(): { key: string; raw: string }[] {
    const entries: { key: string; raw: string }[] = [];
    let bytes = 0;
    // Snapshot all scoped strings before hashing; never partially publish a
    // corrupt ledger or silently skip an unrecognized scoped record.
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) throw new Error("App admission recovery changed while reading. Check again; nothing was sent.");
      bytes += new TextEncoder().encode(key + raw).byteLength;
      entries.push({ key, raw });
      if (entries.length > APP_ADMISSION_LEDGER_MAX_RECORDS || bytes > APP_ADMISSION_LEDGER_MAX_BYTES) {
        throw new Error("App admission recovery ledger exceeds its capacity. No records were discarded.");
      }
    }
    return entries;
  }

  private unchanged(entries: readonly { key: string; raw: string }[]) {
    const current = this.snapshot(), expected = new Map(entries.map(entry => [entry.key, entry.raw]));
    if (current.length !== entries.length || current.some(entry => expected.get(entry.key) !== entry.raw)) {
      throw new Error("App admission recovery changed during verification. Check again; no replacement request was sent.");
    }
  }

  private verifyCapacity(entries: readonly { key: string; raw: string }[], records: readonly AppAdmissionRecoveryRecord[]) {
    let bytes = 0;
    for (let index = 0; index < records.length; index++) {
      const record = records[index], { key, raw } = entries[index];
      let recordBytes = new TextEncoder().encode(raw).byteLength;
      if (!record.receipt || record.receipt.state === "pending") {
        // Count the complete encoded wrapper, frozen envelope, recovery draft,
        // lineage and source metadata, including JSON escaping. The receipt is
        // embedded JSON, not a JSON-encoded string: the shared bound already
        // includes all of its escaping. `false` is the longer boolean spelling.
        // Deliberately keep the four bytes for null as additional headroom:
        // terminal <= base - 4 + MAX_RECEIPT_BYTES < reserved. Using the same
        // base for null AND pending keeps their allowance stable during lookup.
        const base = encodeAppAdmissionRecovery({ ...record, receipt: null, uncertain: false });
        const reserved = new TextEncoder().encode(base).byteLength + APP_ADMISSION_MAX_RECEIPT_BYTES;
        if (reserved > MAX_RECOVERY_RECORD_BYTES) {
          throw new Error("App admission recovery cannot reserve a terminal receipt within its record byte limit. No records were discarded; nothing may be resent.");
        }
        // Retain actual persisted bytes too (e.g. noncanonical whitespace).
        recordBytes = Math.max(recordBytes, reserved);
      }
      bytes += new TextEncoder().encode(key).byteLength + recordBytes;
    }
    if (records.length > APP_ADMISSION_LEDGER_MAX_RECORDS || bytes > APP_ADMISSION_LEDGER_MAX_BYTES) {
      throw new Error("App admission recovery ledger exceeds its reserved terminal capacity. No records were discarded; nothing may be resent.");
    }
  }

  private async verifiedRead() {
    const entries = this.snapshot(), records: AppAdmissionRecoveryRecord[] = [];
    for (const { key, raw } of entries) {
      const record = await decodeAppAdmissionRecovery(raw, this.scope);
      this.verifyLiveTarget(record);
      if (key !== this.key(record.envelope.clientRequestId)) throw new Error("App admission recovery storage identity mismatch.");
      records.push(record);
    }
    // Old persisted ledgers must meet the same reservations as new intake. No
    // eviction, migration or retry can make an overcommitted ledger safe.
    this.verifyCapacity(entries, records);
    this.unchanged(entries);
    return { entries, records };
  }

  async read(): Promise<readonly AppAdmissionRecoveryRecord[]> { return (await this.verifiedRead()).records; }

  private async write(record: AppAdmissionRecoveryRecord, records: readonly AppAdmissionRecoveryRecord[], entries: readonly { key: string; raw: string }[]): Promise<AppAdmissionRecoveryRecord> {
    const raw = encodeAppAdmissionRecovery(record), key = this.key(record.envelope.clientRequestId);
    // Also verifies scope and intent hash for freshly constructed records.
    const decoded = await decodeAppAdmissionRecovery(raw, this.scope);
    this.verifyLiveTarget(decoded);
    const others = records.filter(item => item.envelope.clientRequestId !== record.envelope.clientRequestId);
    this.verifyCapacity([...entries.filter(entry => entry.key !== key), { key, raw }], [...others, decoded]);
    this.unchanged(entries);
    this.storage.setItem(key, raw);
    if (this.storage.getItem(key) !== raw) throw new Error("App admission recovery could not be verified after writing. Nothing may be retransmitted.");
    // Reservations are derived only from verified persisted records, never a
    // response or an in-memory terminal. The Web Lock remains held through this
    // readback; later intake can use released headroom only after it succeeds
    // (or after its own strict read verifies a durably written terminal).
    return decoded;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(() => {
      // Per-request keys alone cannot atomically fence two tabs minting distinct
      // UUIDs for the same draft. Hold the origin/store lock through validation
      // and read-back; lack of safe locking is a refusal, never a weak fallback.
      if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Cross-tab-safe App admission recovery locking is unavailable. Your draft is unchanged; nothing may be resent.");
      return navigator.locks.request(this.prefix, operation);
    });
    this.mutation = result.catch(() => {});
    return await result;
  }

  reserve(record: AppAdmissionRecoveryRecord): Promise<AppAdmissionRecoveryRecord> {
    return this.serialize(() => this.reserveRecord(record));
  }

  private async reserveRecord(record: AppAdmissionRecoveryRecord): Promise<AppAdmissionRecoveryRecord> {
    const { records, entries } = await this.verifiedRead();
    if (records.some(item => item.envelope.clientRequestId === record.envelope.clientRequestId)) throw new Error("This App admission request already exists; only exact status lookup is allowed.");
    const intent = record.envelope.intent;
    if (records.some(item => (!item.receipt || item.receipt.state === "pending")
      && (item.draftKey === record.draftKey || item.envelope.intent.chainId === intent.chainId
        || intent.conversationId !== null && item.envelope.intent.conversationId === intent.conversationId))) {
      throw new Error("Resolve the original App admission request before sending in this conversation or draft chain.");
    }
    return this.write(record, records, entries);
  }

  settle(record: AppAdmissionRecoveryRecord, evidence: AppAdmissionLookup | AppAdmissionReceipt): Promise<AppAdmissionRecoveryRecord> {
    return this.serialize(() => this.settleRecord(record, evidence));
  }

  private async settleRecord(record: AppAdmissionRecoveryRecord, evidence: AppAdmissionLookup | AppAdmissionReceipt): Promise<AppAdmissionRecoveryRecord> {
    const { records, entries } = await this.verifiedRead();
    const previous = records.find(item => item.envelope.clientRequestId === record.envelope.clientRequestId);
    if (!previous) throw new Error("The original App admission recovery record is missing. No replacement request is allowed.");
    // Correlate to both the original caller and current durable state. A known
    // terminal must survive a stale pending/absent observation from either.
    const observed = settleAppAdmissionRecovery(record, evidence);
    const merged = settleAppAdmissionRecovery(previous, observed.receipt ?? { kind: "absent", key: observed.envelope });
    return this.write(merged, records, entries);
  }

  /** Called only for an explicit discard action, never capacity-driven eviction. */
  removeTerminal(record: AppAdmissionRecoveryRecord): Promise<void> {
    return this.serialize(async () => {
      const { records, entries } = await this.verifiedRead();
      const previous = records.find(item => item.envelope.clientRequestId === record.envelope.clientRequestId);
      if (!previous?.receipt || previous.receipt.state === "pending") throw new Error("Unresolved App admission recovery cannot be discarded.");
      settleAppAdmissionRecovery(record, previous.receipt);
      this.unchanged(entries);
      const key = this.key(record.envelope.clientRequestId);
      this.storage.removeItem(key);
      if (this.storage.getItem(key) !== null) throw new Error("App admission recovery discard could not be verified.");
    });
  }
}
