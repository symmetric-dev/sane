import { APP_ADMISSION_MAX_RECEIPT_BYTES, appAdmissionRecoveryStorageKey } from "../shared/conversation/app-admission-contract";
import type { AppAdmissionLookup, AppAdmissionReceipt, AppAdmissionRecoveryScope } from "../shared/conversation/app-admission-contract";
import { decodeAppAdmissionRecovery, encodeAppAdmissionRecovery, settleAppAdmissionRecovery } from "./app-admission-recovery";
import type { AppAdmissionRecoveryRecord } from "./app-admission-recovery";

export const APP_ADMISSION_LEDGER_MAX_RECORDS = 256;
export const APP_ADMISSION_LEDGER_MAX_BYTES = 8_000_000;
// Counts only expirable terminals; admitted science recoveries stay protected.
export const APP_ADMISSION_LEDGER_MAX_TERMINAL_RECORDS = 64;

// Mirrors app-admission-recovery's private MAX_RECORD_BYTES. Reserving aggregate
// space alone is insufficient if that codec would refuse the terminal record.
const MAX_RECOVERY_RECORD_BYTES = 1_000_000;

type StorageEntry = { key: string; raw: string };
type VerifiedEntry = StorageEntry & { record: AppAdmissionRecoveryRecord; reservedBytes: number };

/** One immutable request per key. Only terminal browser recoveries may expire;
 * absence and capacity pressure never authorize retransmission. */
export class AppAdmissionLedger {
  readonly prefix: string;
  private mutation: Promise<unknown> = Promise.resolve();
  private verified = new Map<string, VerifiedEntry>();
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

  private snapshot(): StorageEntry[] {
    const entries: StorageEntry[] = [];
    // Decode before deciding what can expire, including an older ledger which
    // exceeds today's bounds. Never silently drop an unrecognized record.
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) throw new Error("App admission recovery changed while reading. Check again; nothing was sent.");
      entries.push({ key, raw });
    }
    return entries;
  }

  private async decodeEntry({ key, raw }: StorageEntry): Promise<VerifiedEntry> {
    const cached = this.verified.get(key);
    // Exact persisted bytes are the cache boundary; edits from another tab (or
    // outside the App) must pass the full codec and intent hash again.
    if (cached?.raw === raw) return cached;
    const record = await decodeAppAdmissionRecovery(raw, this.scope);
    this.verifyLiveTarget(record);
    if (key !== this.key(record.envelope.clientRequestId)) throw new Error("App admission recovery storage identity mismatch.");
    let recordBytes = new TextEncoder().encode(raw).byteLength;
    if (!record.receipt || record.receipt.state === "pending") {
      // Include the frozen envelope, draft, lineage and JSON escaping. Keep
      // null's four bytes as headroom; using the same base for null and pending
      // keeps the terminal allowance stable during status lookup.
      const base = encodeAppAdmissionRecovery({ ...record, receipt: null, uncertain: false });
      const reserved = new TextEncoder().encode(base).byteLength + APP_ADMISSION_MAX_RECEIPT_BYTES;
      if (reserved > MAX_RECOVERY_RECORD_BYTES) {
        throw new Error("App admission recovery cannot reserve a terminal receipt within its record byte limit. No records were discarded; nothing may be resent.");
      }
      // Retain actual persisted bytes too (e.g. noncanonical whitespace).
      recordBytes = Math.max(recordBytes, reserved);
    }
    const entry = { key, raw, record, reservedBytes: new TextEncoder().encode(key).byteLength + recordBytes };
    return entry;
  }

  private async verifiedRead() {
    const snapshot = this.snapshot(), entries: VerifiedEntry[] = [];
    const keys = new Set(snapshot.map(entry => entry.key));
    for (const key of this.verified.keys()) if (!keys.has(key)) this.verified.delete(key);
    // Every caller holds the same cross-tab lock, including reads which prune.
    // Cache persisted bytes only; failed writes must not retain speculative keys.
    for (const entry of snapshot) {
      const decoded = await this.decodeEntry(entry);
      this.verified.set(entry.key, decoded);
      entries.push(decoded);
    }
    return entries;
  }

  private canExpire(record: AppAdmissionRecoveryRecord): boolean {
    return record.receipt?.state === "rejected"
      || record.receipt?.state === "admitted" && record.envelope.intent.operation !== "science-message";
  }

  private removeEntry(entry: VerifiedEntry) {
    this.storage.removeItem(entry.key);
    if (this.storage.getItem(entry.key) !== null) throw new Error("App admission recovery discard could not be verified.");
    this.verified.delete(entry.key);
  }

  private retain(entries: readonly VerifiedEntry[], protectedKey?: string, requireCapacity = false): VerifiedEntry[] {
    const retained = [...entries];
    let bytes = retained.reduce((total, entry) => total + entry.reservedBytes, 0);
    let terminals = retained.filter(entry => this.canExpire(entry.record)).length;
    // v1 has no timestamps. Expire entries in storage order (also used by the
    // recovery UI), keeping the record being written.
    for (const entry of entries) {
      if (retained.length <= APP_ADMISSION_LEDGER_MAX_RECORDS && bytes <= APP_ADMISSION_LEDGER_MAX_BYTES
        && terminals <= APP_ADMISSION_LEDGER_MAX_TERMINAL_RECORDS) break;
      if (entry.key === protectedKey || !this.canExpire(entry.record)) continue;
      this.removeEntry(entry);
      retained.splice(retained.indexOf(entry), 1);
      bytes -= entry.reservedBytes;
      terminals--;
    }
    if (requireCapacity && (retained.length > APP_ADMISSION_LEDGER_MAX_RECORDS || bytes > APP_ADMISSION_LEDGER_MAX_BYTES)) {
      throw new Error("App admission recovery is full of protected requests. Resolve or explicitly discard completed recoveries before sending; unresolved requests were not discarded and nothing was resent.");
    }
    return retained;
  }

  read(): Promise<readonly AppAdmissionRecoveryRecord[]> {
    return this.serialize(async () => this.retain(await this.verifiedRead()).map(entry => entry.record));
  }

  private async write(record: AppAdmissionRecoveryRecord, entries: readonly VerifiedEntry[], requireCapacity: boolean): Promise<AppAdmissionRecoveryRecord> {
    const raw = encodeAppAdmissionRecovery(record), key = this.key(record.envelope.clientRequestId);
    // Also verifies scope and intent hash for freshly constructed records.
    const decoded = await this.decodeEntry({ key, raw });
    const retained = this.retain([...entries.filter(entry => entry.key !== key), decoded], key, requireCapacity);
    for (;;) {
      try {
        this.storage.setItem(key, raw);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
        // Other localStorage users can leave less room than our scoped budget.
        // Only give up eligible terminal recoveries, never a pending request.
        const oldest = retained.find(entry => entry.key !== key && this.canExpire(entry.record));
        if (!oldest) throw error;
        this.removeEntry(oldest);
        retained.splice(retained.indexOf(oldest), 1);
      }
    }
    if (this.storage.getItem(key) !== raw) throw new Error("App admission recovery could not be verified after writing. Nothing may be retransmitted.");
    this.verified.set(key, decoded);
    // Reservations are derived only from verified persisted records, never a
    // response or an in-memory terminal. The Web Lock remains held through this
    // readback; later intake can use released headroom only after it succeeds
    // (or after its own strict read verifies a durably written terminal).
    return decoded.record;
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
    const entries = await this.verifiedRead(), records = entries.map(entry => entry.record);
    if (records.some(item => item.envelope.clientRequestId === record.envelope.clientRequestId)) throw new Error("This App admission request already exists; only exact status lookup is allowed.");
    const intent = record.envelope.intent;
    if (records.some(item => (!item.receipt || item.receipt.state === "pending")
      && (item.draftKey === record.draftKey || item.envelope.intent.chainId === intent.chainId
        || intent.conversationId !== null && item.envelope.intent.conversationId === intent.conversationId))) {
      throw new Error("Resolve the original App admission request before sending in this conversation or draft chain.");
    }
    return this.write(record, entries, true);
  }

  settle(record: AppAdmissionRecoveryRecord, evidence: AppAdmissionLookup | AppAdmissionReceipt): Promise<AppAdmissionRecoveryRecord> {
    return this.serialize(() => this.settleRecord(record, evidence));
  }

  private async settleRecord(record: AppAdmissionRecoveryRecord, evidence: AppAdmissionLookup | AppAdmissionReceipt): Promise<AppAdmissionRecoveryRecord> {
    const entries = await this.verifiedRead(), records = entries.map(entry => entry.record);
    const previous = records.find(item => item.envelope.clientRequestId === record.envelope.clientRequestId);
    // Correlate to both the original caller and current durable state. A known
    // terminal must survive a stale pending/absent observation from either.
    const observed = settleAppAdmissionRecovery(record, evidence);
    if (!previous) {
      // Another tab may have settled and expired this browser recovery. Only an
      // actual, correctly correlated terminal response can restore it. A prior
      // in-memory terminal alone, pending, or absence is not enough.
      const receipt = "kind" in evidence ? evidence.kind === "found" ? evidence.receipt : null : evidence;
      if (!receipt || receipt.state === "pending") throw new Error("The original App admission recovery record is missing. Check exact terminal status; no replacement request is allowed.");
    }
    const merged = previous
      ? settleAppAdmissionRecovery(previous, observed.receipt ?? { kind: "absent", key: observed.envelope })
      : observed;
    // Status resolution must remain possible even if protected legacy records
    // alone exceed capacity; settling one does not authorize a new POST.
    return this.write(merged, entries, false);
  }

  /** Explicit discard may also remove science recoveries after the caller has
   * checked terminal science evidence. Automatic retention never assumes it. */
  removeTerminal(record: AppAdmissionRecoveryRecord): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.verifiedRead();
      const entry = entries.find(item => item.record.envelope.clientRequestId === record.envelope.clientRequestId);
      if (!entry) return; // Already expired or discarded in another tab.
      const previous = entry.record;
      if (!previous.receipt || previous.receipt.state === "pending") throw new Error("Unresolved App admission recovery cannot be discarded.");
      settleAppAdmissionRecovery(record, previous.receipt);
      this.removeEntry(entry);
    });
  }
}
