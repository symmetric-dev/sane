import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { isConversationUpdateSource, updateSourceKey, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import { openCodeIncarnation, type OpenCodeCreationIdentity } from "../shared/conversation/oc-reply-reducer";

/** Optional notification evidence, never a prerequisite for App execution. */
export type OpenCodeReplyBindingRecord = {
  version: 1;
  conversationId: string;
  source: ConversationUpdateSource;
  creation: OpenCodeCreationIdentity;
  initialBaselineThrough: number;
  registrationRevision: string;
  nativeVersion: string;
};
const filename = "opencode-reply-bindings.json";
const MAX_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);

export function isOpenCodeReplyBindingRecord(value: unknown): value is OpenCodeReplyBindingRecord {
  try {
    return object(value) && Object.keys(value).sort().join() === ["version", "conversationId", "source", "creation", "initialBaselineThrough", "registrationRevision", "nativeVersion"].sort().join()
      && value.version === 1 && text(value.conversationId) && isConversationUpdateSource(value.source)
      && value.source.harness === "opencode" && object(value.creation)
      && Object.keys(value.creation).sort().join() === "createdAt,eventId"
      && value.source.incarnation === openCodeIncarnation(value.creation as OpenCodeCreationIdentity)
      && Number.isSafeInteger(value.initialBaselineThrough) && (value.initialBaselineThrough as number) >= 0
      && text(value.registrationRevision) && text(value.nativeVersion);
  } catch { return false; }
}
function baseKey(source: ConversationUpdateSource): string {
  return updateSourceKey({ harness: source.harness, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId });
}

/** Append-only admissions: an established creation identity, fence and revision
 * are never replaced. Retain malformed rows when adding unrelated good rows. */
export class OpenCodeReplyBindings {
  private rows: unknown[] = [];
  private records = new Map<string, OpenCodeReplyBindingRecord>();
  private problems = new Set<string>();
  private sourceProblems = new Set<string>();
  private unavailable = false;
  private loaded = false;
  constructor(private dataDir: string, private save: typeof atomicAppRecord = atomicAppRecord) {}
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const path = join(this.dataDir, filename), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error();
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!object(value) || value.version !== 1 || Object.keys(value).sort().join() !== "bindings,version" || !Array.isArray(value.bindings)) throw new Error();
      this.rows = value.bindings;
      const sources = new Map<string, string>();
      for (const row of this.rows) {
        if (!isOpenCodeReplyBindingRecord(row)) {
          if (object(row) && text(row.conversationId)) this.problems.add(row.conversationId);
          if (object(row) && object(row.source)) {
            const source = { harness: row.source.harness, authorityId: row.source.authorityId, nativeSessionId: row.source.nativeSessionId };
            if (isConversationUpdateSource(source)) this.sourceProblems.add(baseKey(source));
          }
          continue;
        }
        const key = baseKey(row.source), previous = sources.get(key);
        const oldConversation = this.records.get(row.conversationId);
        if (oldConversation || previous !== undefined) {
          this.problems.add(row.conversationId);
          if (previous !== undefined) this.problems.add(previous);
          if (oldConversation) this.sourceProblems.add(baseKey(oldConversation.source));
          this.sourceProblems.add(key);
        }
        sources.set(key, row.conversationId);
        this.records.set(row.conversationId, structuredClone(row));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unavailable = true;
    }
  }
  problem(conversationId: string, source?: ConversationUpdateSource): string | undefined {
    if (!this.loaded || this.unavailable) return "Optional OpenCode reply binding storage is unavailable; App run alerts remain available";
    if (this.problems.has(conversationId) || source && this.sourceProblems.has(baseKey(source))) return "OpenCode reply binding is invalid or ambiguous; explicit reconciliation is required";
  }
  get(conversationId: string): OpenCodeReplyBindingRecord | undefined {
    const record = this.records.get(conversationId);
    return record && !this.problem(conversationId, record.source) ? structuredClone(record) : undefined;
  }
  admit(value: OpenCodeReplyBindingRecord): void {
    if (!isOpenCodeReplyBindingRecord(value) || this.problem(value.conversationId, value.source)) throw new Error("OpenCode reply binding admission unavailable");
    const captured = structuredClone(value), prior = this.records.get(captured.conversationId);
    if (prior) {
      if (updateSourceKey(prior.source) !== updateSourceKey(captured.source)
        || openCodeIncarnation(prior.creation) !== openCodeIncarnation(captured.creation)
        || prior.initialBaselineThrough !== captured.initialBaselineThrough || prior.nativeVersion !== captured.nativeVersion
        || prior.registrationRevision !== captured.registrationRevision) throw new Error("Established OpenCode reply binding cannot be replaced");
      return;
    }
    if ([...this.records.values()].some(record => baseKey(record.source) === baseKey(captured.source))) throw new Error("OpenCode reply identity is already admitted");
    const next = { version: 1, bindings: [...this.rows, captured] };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error("OpenCode reply binding capacity exceeded");
    try { this.save(this.dataDir, filename, next); }
    catch { this.unavailable = true; throw new Error("OpenCode reply binding publication failed"); }
    this.rows = next.bindings;
    this.records.set(captured.conversationId, captured);
  }
  /** Rotate only the registration token for a remove/rebind (ABA). Native
   * creation identity, source, native version and the first fence stay pinned. */
  renewRegistration(conversationId: string): OpenCodeReplyBindingRecord {
    const prior = this.get(conversationId);
    if (!prior) throw new Error("OpenCode reply registration cannot be renewed");
    const nextRecord = { ...prior, registrationRevision: crypto.randomUUID() };
    const next = { version: 1, bindings: this.rows.map(row => isOpenCodeReplyBindingRecord(row) && row.conversationId === conversationId ? nextRecord : row) };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error("OpenCode reply binding capacity exceeded");
    try { this.save(this.dataDir, filename, next); }
    catch { this.unavailable = true; throw new Error("OpenCode reply registration publication failed"); }
    this.rows = next.bindings;
    this.records.set(conversationId, nextRecord);
    return structuredClone(nextRecord);
  }
}
