import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { WorkspaceError } from "./workspace";
import { materializeScienceShare, type ScienceChatState } from "../shared/science-chat-contract";
import type { ScienceCell } from "../shared/science-contract";
import { serializeScienceCell } from "../shared/science-share";

export function scienceFail(status: number, message: string): never { throw new WorkspaceError(status, "science-chat", message); }
export const scienceId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const scienceText = (v: unknown): v is string => typeof v === "string" && Buffer.byteLength(v) <= 256 * 1024;
export const scienceRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function scienceExact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) scienceFail(400, "Invalid science record fields");
}
export function scienceAnchor(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) scienceFail(400, "Invalid transcript anchor");
  const a = v as Record<string, unknown>;
  if (a.kind === "start") scienceExact(a, ["kind"]);
  else {
    scienceExact(a, ["kind", "messageId"]);
    if (a.kind !== "after-message" || typeof a.messageId !== "string" || !a.messageId.length || a.messageId.length > 2048 || /[\u0000-\u001f\u007f]/.test(a.messageId)) scienceFail(400, "Invalid canonical transcript message ID");
  }
}
function validateCell(v: unknown): asserts v is ScienceCell {
  scienceExact(v, ["id", "code", "sourceHash", "name", "status", "errors", "output", "consoleOutputs"]);
  if (!scienceText(v.id) || !scienceText(v.code) || !scienceText(v.name) || typeof v.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(v.sourceHash) || ![null, "idle", "exception", "stale", "cancelled", "interrupted", "marimo-error", "disabled", "queued", "running"].includes(v.status as null) || !Array.isArray(v.errors) || !Array.isArray(v.consoleOutputs) || Buffer.byteLength(JSON.stringify(v)) > 256 * 1024) scienceFail(503, "Invalid observed cell");
  for (const e of v.errors) { scienceExact(e, ["kind", "message"]); if (!["graph", "runtime"].includes(e.kind as string) || !scienceText(e.message)) scienceFail(503, "Invalid observed error"); }
  for (const o of [...v.consoleOutputs, ...(v.output === null ? [] : [v.output])]) {
    scienceExact(o, ["channel", "mimetype", "data", "timestamp"]);
    if (!scienceText(o.channel) || !scienceText(o.mimetype) || !scienceText(o.data) || typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) scienceFail(503, "Invalid observed output");
  }
}
type RecordValue = { version: 2; storeId: string; chats: ScienceChatState[] };
function time(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function validate(v: unknown, storeId: string): asserts v is RecordValue {
  scienceExact(v, ["version", "storeId", "chats"]);
  if (v.version !== 2 || v.storeId !== storeId || !Array.isArray(v.chats) || Buffer.byteLength(JSON.stringify(v)) > 16 * 1024 * 1024) scienceFail(503, "Invalid science store");
  const chats = new Set<string>(), notebooks = new Set<string>();
  for (const c of v.chats) {
    scienceExact(c, ["conversationId", "workspaceId", "worktreeId", "admissionKey", "notebook", "notebookKind", "notebookCreated", "revision", "blocks", "entries", "operations", "shares"]);
    if (![c.conversationId, c.workspaceId, c.worktreeId].every(scienceId) || !scienceRevision(c.revision) || typeof c.notebook !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.py$/.test(c.notebook) || !["owned", "existing"].includes(c.notebookKind as string) || ![c.blocks, c.entries, c.operations, c.shares].every(Array.isArray)) scienceFail(503, "Invalid science chat");
    if (typeof c.notebookCreated !== "boolean" || typeof c.admissionKey !== "string" || !/^[a-f0-9]{64}$/.test(c.admissionKey)) scienceFail(503, "Invalid notebook admission evidence");
    const chat = c as unknown as ScienceChatState, key = `${chat.workspaceId}/${chat.notebook}`;
    if (chats.has(chat.conversationId) || notebooks.has(key)) scienceFail(503, "Duplicate science identity");
    chats.add(chat.conversationId); notebooks.add(key);
    const ids = new Set<string>();
    const id = (value: unknown) => { if (!scienceId(value) || ids.has(value)) scienceFail(503, "Invalid science identity"); ids.add(value); };
    for (const b of chat.blocks) {
      scienceExact(b, ["id", "revision", "source", "knownSources", "anchor", "creation"]); id(b.id); scienceAnchor(b.anchor);
      if (b.creation !== null) {
        scienceExact(b.creation, ["requestId", "initialSource", "expectedRevision", "state", "generation"]);
        if (!scienceId(b.creation.requestId) || !scienceText(b.creation.initialSource) || !scienceRevision(b.creation.expectedRevision) || b.creation.expectedRevision >= chat.revision || !["pending", "unknown", "created"].includes(b.creation.state) || (b.creation.state === "pending" ? b.creation.generation !== null : !scienceId(b.creation.generation))) scienceFail(503, "Invalid block addition intent");
      }
      if (!scienceRevision(b.revision) || b.revision > chat.revision || !scienceText(b.source) || !Array.isArray(b.knownSources) || !b.knownSources.length || !b.knownSources.every(scienceText) || b.knownSources.length > 1024 || new Set(b.knownSources).size !== b.knownSources.length) scienceFail(503, "Invalid science block");
    }
    const block = (value: unknown) => chat.blocks.some(b => b.id === value);
    for (const e of chat.entries) {
      scienceExact(e, ["id", "afterBlockId", "text"]); id(e.id);
      if (e.afterBlockId !== null && !block(e.afterBlockId) || !scienceText(e.text)) scienceFail(503, "Invalid science entry");
    }
    const requests = new Set<string>();
    for (const b of chat.blocks) if (b.creation) { if (requests.has(b.creation.requestId)) scienceFail(503, "Duplicate addition request"); requests.add(b.creation.requestId); }
    for (const o of chat.operations) {
      scienceExact(o, ["id", "requestId", "blockId", "revision", "source", "state", "createdAt", "observation"]); id(o.id);
      if (!block(o.blockId) || !scienceId(o.requestId) || requests.has(o.requestId) || !scienceRevision(o.revision) || !scienceText(o.source) || !["unknown", "succeeded", "failed"].includes(o.state) || !time(o.createdAt)) scienceFail(503, "Invalid science operation");
      requests.add(o.requestId);
      if (o.revision > chat.blocks.find(b => b.id === o.blockId)!.revision) scienceFail(503, "Invalid operation revision");
      if (o.observation !== null) {
        scienceExact(o.observation, ["provenance", "text", "cell"]);
        if (o.observation.provenance !== "observed-unverified" || !scienceText(o.observation.text)) scienceFail(503, "Invalid science observation");
        if (o.observation.cell !== null) { validateCell(o.observation.cell); if (serializeScienceCell(o.observation.cell).agentText !== o.observation.text) scienceFail(503, "Observed serialization differs"); }
      }
    }
    for (const s of chat.shares) {
      scienceExact(s, ["id", "requestId", "blockId", "revision", "source", "operationId", "representation", "agentText", "createdAt"]); id(s.id);
      if (!block(s.blockId) || !scienceId(s.requestId) || requests.has(s.requestId) || !scienceRevision(s.revision) || !scienceText(s.source) || !scienceText(s.agentText) || !time(s.createdAt) || !["source", "source-and-observed-text"].includes(s.representation) || s.operationId !== null && !chat.operations.some(o => o.id === s.operationId && o.blockId === s.blockId && o.source === s.source && o.revision === s.revision)) scienceFail(503, "Invalid science share");
      requests.add(s.requestId);
      const operation = chat.operations.find(o => o.id === s.operationId);
      if (s.revision > chat.blocks.find(b => b.id === s.blockId)!.revision || s.representation === "source-and-observed-text" && !operation?.observation || s.agentText !== materializeScienceShare(s.source, s.representation === "source-and-observed-text" ? operation!.observation!.text : undefined)) scienceFail(503, "Invalid frozen agent representation");
    }
  }
}

/** V1 had no transcript placement or native addition intents. Preserve those
 * blocks at the explicit start, never infer placement from times/array indices. */
function upgrade(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return value;
  scienceExact(value, ["version", "storeId", "chats"]);
  if (!Array.isArray(value.chats)) scienceFail(503, "Invalid legacy science store");
  for (const chat of value.chats) {
    if (!chat || !Array.isArray(chat.blocks) || !Array.isArray(chat.operations)) scienceFail(503, "Invalid legacy science chat");
    for (const block of chat.blocks) {
      scienceExact(block, ["id", "revision", "source", "knownSources"]);
      block.anchor = { kind: "start" }; block.creation = null;
    }
    for (const op of chat.operations) if (op.observation !== null) {
      scienceExact(op.observation, ["provenance", "text"]); op.observation.cell = null;
    }
  }
  value.version = 2;
  return value;
}

/** Single bridge writer, atomic publication; uncertain writes poison this instance. */
export class ScienceStore {
  private value: RecordValue;
  private failed = false;
  constructor(private dataDir: string, private storeId: string) {
    this.value = { version: 2, storeId, chats: [] };
    let found = false;
    try {
      const path = join(dataDir, "science-chats.json"), stat = lstatSync(path);
      found = true;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid store file");
      const value: unknown = upgrade(JSON.parse(readFileSync(path, "utf8"))); validate(value, storeId); this.value = value;
    } catch (e) { if (found || (e as NodeJS.ErrnoException).code !== "ENOENT") this.failed = true; }
  }
  get(id: string) { this.assert(); return structuredClone(this.value.chats.find(c => c.conversationId === id)); }
  associations() { this.assert(); return this.value.chats.map(c => ({ workspaceId: c.workspaceId, notebook: c.notebook })); }
  private assert() { if (this.failed) scienceFail(503, "Science storage is unavailable; repair the durable record before restarting"); }
  put(chat: ScienceChatState) {
    this.assert(); const next = structuredClone(this.value), index = next.chats.findIndex(c => c.conversationId === chat.conversationId);
    if (index < 0) next.chats.push(structuredClone(chat)); else next.chats[index] = structuredClone(chat);
    validate(next, this.storeId);
    try { atomicAppRecord(this.dataDir, "science-chats.json", next); } catch { this.failed = true; scienceFail(503, "Science persistence failed; native work is fenced"); }
    this.value = next;
  }
  share(conversationId: string, snapshotId: string) { return this.get(conversationId)?.shares.find(s => s.id === snapshotId); }
}
