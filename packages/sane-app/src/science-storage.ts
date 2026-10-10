import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ScienceStorageFiles } from "./science-storage-files";
import type { ScienceChatState } from "../shared/science-chat-contract";

const LIMIT = 16 * 1024 * 1024;
const CHAT_LIMIT = 32 * 1024 * 1024;
const lists = ["blocks", "entries", "operations", "shares"] as const;
type Kind = typeof lists[number];
type Head = { version: 3; storeId: string; chat: Omit<ScienceChatState, Kind>; records: Record<Kind, string[]> };
type Marker = { version: 3; storeId: string; generation: string; chats: string[] };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function fail(): never { throw new Error("Invalid incremental science storage"); }
function exact(v: any, keys: string[]) { if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(); }
function bounded(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIMIT) throw new Error("Science record exceeds 16 MiB limit");
  return text;
}

/** App ownership locks provide the single writer. Bytes and containing directories
 * are fsynced before references. Unreferenced crash remnants are never collected.
 * Only science-storage.json selects an authoritative generation.
 */
export class ScienceStorage {
  private marker: Marker | undefined;
  private root = "";
  private records = new WeakMap<object, { hash: string; bytes: number }>();
  private files: ScienceStorageFiles;
  constructor(private dataDir: string, private storeId: string) { this.files = new ScienceStorageFiles(dataDir); }
  load(): ScienceChatState[] | undefined {
    this.files.pin(this.dataDir);
    const path = join(this.dataDir, "science-storage.json");
    const markerText = this.files.read(path, LIMIT, true);
    if (markerText === undefined) return undefined;
    const marker = JSON.parse(markerText); exact(marker, ["version", "storeId", "generation", "chats"]);
    if (marker.version !== 3 || marker.storeId !== this.storeId || !id(marker.generation) || !Array.isArray(marker.chats) || !marker.chats.every(id) || new Set(marker.chats).size !== marker.chats.length) fail();
    this.marker = marker; this.root = join(this.dataDir, `science-history-${marker.generation}`); this.files.pin(this.root);
    return marker.chats.map((conversationId: string) => {
      const dir = join(this.root, conversationId); this.files.pin(dir);
      const head = JSON.parse(this.files.read(join(dir, "head.json"), LIMIT)!); exact(head, ["version", "storeId", "chat", "records"]); exact(head.records, [...lists]);
      exact(head.chat, ["conversationId", "workspaceId", "worktreeId", "admissionKey", "notebook", "notebookKind", "notebookCreated", "revision"]);
      if (head.version !== 3 || head.storeId !== this.storeId || head.chat?.conversationId !== conversationId) fail();
      const chat = { ...head.chat };
      let remaining = CHAT_LIMIT - Buffer.byteLength(bounded(head.chat));
      const references = new Set<string>();
      for (const kind of lists) {
        if (!Array.isArray(head.records[kind])) fail();
        chat[kind] = head.records[kind].map((hash: unknown) => {
          if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || references.has(hash)) fail();
          references.add(hash);
          const recordDir = join(dir, hash);
          // Reserve actual encoded bytes before parsing or retaining each record.
          // Duplicate references never cause repeated reads or allocations.
          const raw = this.files.read(join(recordDir, "record.json"), Math.min(LIMIT, remaining))!;
          remaining -= Buffer.byteLength(raw);
          if (remaining < 0) fail();
          const record = JSON.parse(raw); exact(record, ["version", "storeId", "conversationId", "kind", "value"]);
          const text = bounded(record);
          if (record.version !== 3 || record.storeId !== this.storeId || record.conversationId !== conversationId || record.kind !== kind || createHash("sha256").update(text).digest("hex") !== hash || !record.value || typeof record.value !== "object") fail();
          this.records.set(record.value, { hash, bytes: Buffer.byteLength(text) });
          return record.value;
        });
      }
      this.prepare(chat); // Enforce the aggregate per-chat budget on reads too.
      return chat as ScienceChatState;
    });
  }
  private prepare(chat: ScienceChatState) {
    const { blocks, entries, operations, shares, ...metadata } = chat;
    const head: Head = { version: 3, storeId: this.storeId, chat: metadata, records: { blocks: [], entries: [], operations: [], shares: [] } };
    const pending: { value: object; hash: string; bytes: number; record: unknown }[] = [];
    let bytes = Buffer.byteLength(bounded(metadata));
    for (const kind of lists) for (const value of chat[kind]) {
      let cached = this.records.get(value);
      if (!cached) {
        const record = { version: 3, storeId: this.storeId, conversationId: chat.conversationId, kind, value };
        const text = bounded(record); cached = { hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
        pending.push({ value, record, ...cached });
      }
      bytes += cached.bytes; head.records[kind].push(cached.hash);
      if (bytes > CHAT_LIMIT) throw new Error("Science chat encoded records exceed 32 MiB limit");
    }
    bounded(head);
    return { head, pending };
  }
  /** Preflight caps before any writes; rejected input does not poison the writer. */
  check(chat: ScienceChatState) {
    this.prepare(chat);
    if (this.marker && !this.marker.chats.includes(chat.conversationId)) bounded({ ...this.marker, chats: [...this.marker.chats, chat.conversationId] });
  }
  migrate(chats: ScienceChatState[]) {
    for (const chat of chats) this.check(chat);
    const generation = randomUUID(); this.root = this.files.mkdir(this.dataDir, `science-history-${generation}`); this.files.pin(this.root);
    for (const chat of chats) this.writeHead(chat, true);
    const marker: Marker = { version: 3, storeId: this.storeId, generation, chats: chats.map(c => c.conversationId) };
    this.files.write(join(this.dataDir, "science-storage.json"), bounded(marker)); this.marker = marker;
  }
  put(chat: ScienceChatState) {
    if (!this.marker) fail();
    const fresh = !this.marker.chats.includes(chat.conversationId);
    const marker = fresh ? { ...this.marker, chats: [...this.marker.chats, chat.conversationId] } : this.marker;
    if (fresh) bounded(marker);
    this.writeHead(chat, fresh);
    if (fresh) { this.files.write(join(this.dataDir, "science-storage.json"), bounded(marker)); this.marker = marker; }
  }
  private writeHead(chat: ScienceChatState, fresh: boolean) {
    const { head, pending } = this.prepare(chat);
    const dir = join(this.root, chat.conversationId);
    if (fresh) {
      this.files.mkdir(this.root, chat.conversationId, true);
    }
    this.files.pin(dir);
    for (const item of pending) {
      const recordDir = join(dir, item.hash);
      this.files.mkdir(dir, item.hash, true);
      // An interrupted prior write may have left this unreferenced directory.
      // Atomic replacement with the identical hash-qualified bytes repairs it.
      this.files.write(join(recordDir, "record.json"), bounded(item.record));
      this.records.set(item.value, { hash: item.hash, bytes: item.bytes });
    }
    this.files.write(join(dir, "head.json"), bounded(head));
  }
}
