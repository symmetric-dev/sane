import { isDeepStrictEqual } from "node:util";
import { ScienceStorage } from "./science-storage";
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
function validate(v: unknown, storeId: string, trusted = new WeakSet<object>()): asserts v is RecordValue {
  scienceExact(v, ["version", "storeId", "chats"]);
  if (v.version !== 2 || v.storeId !== storeId || !Array.isArray(v.chats)) scienceFail(503, "Invalid science store");
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
      if (trusted.has(b)) { id(b.id); continue; }
      scienceExact(b, ["id", "revision", "source", "knownSources", "anchor", "creation"]); id(b.id); scienceAnchor(b.anchor);
      if (b.creation !== null) {
        scienceExact(b.creation, ["requestId", "initialSource", "expectedRevision", "state", "generation"]);
        if (!scienceId(b.creation.requestId) || !scienceText(b.creation.initialSource) || !scienceRevision(b.creation.expectedRevision) || b.creation.expectedRevision >= chat.revision || !["pending", "unknown", "created"].includes(b.creation.state) || (b.creation.state === "pending" ? b.creation.generation !== null : !scienceId(b.creation.generation))) scienceFail(503, "Invalid block addition intent");
      }
      if (!scienceRevision(b.revision) || b.revision > chat.revision || !scienceText(b.source) || !Array.isArray(b.knownSources) || !b.knownSources.length || !b.knownSources.every(scienceText) || b.knownSources.length > 1024 || new Set(b.knownSources).size !== b.knownSources.length) scienceFail(503, "Invalid science block");
    }
    const block = (value: unknown) => chat.blocks.some(b => b.id === value);
    for (const e of chat.entries) {
      if (trusted.has(e)) { id(e.id); continue; }
      scienceExact(e, ["id", "afterBlockId", "text"]); id(e.id);
      if (e.afterBlockId !== null && !block(e.afterBlockId) || !scienceText(e.text)) scienceFail(503, "Invalid science entry");
    }
    const requests = new Set<string>();
    for (const b of chat.blocks) if (b.creation) { if (requests.has(b.creation.requestId)) scienceFail(503, "Duplicate addition request"); requests.add(b.creation.requestId); }
    for (const o of chat.operations) {
      if (trusted.has(o)) { id(o.id); if (requests.has(o.requestId)) scienceFail(503, "Duplicate operation request"); requests.add(o.requestId); continue; }
      scienceExact(o, ["id", "requestId", "blockId", "revision", "source", "state", "createdAt", "observation", ...("error" in o ? ["error"] : [])]); id(o.id);
      if (!block(o.blockId) || !scienceId(o.requestId) || requests.has(o.requestId) || !scienceRevision(o.revision) || !scienceText(o.source) || !["not-executed", "unknown", "succeeded", "failed"].includes(o.state) || !time(o.createdAt) || ("error" in o && !scienceText(o.error)) || o.state === "not-executed" && o.observation !== null) scienceFail(503, "Invalid science operation");
      requests.add(o.requestId);
      if (o.revision > chat.blocks.find(b => b.id === o.blockId)!.revision) scienceFail(503, "Invalid operation revision");
      if (o.observation !== null) {
        scienceExact(o.observation, ["provenance", "text", "cell"]);
        if (o.observation.provenance !== "observed-unverified" || !scienceText(o.observation.text)) scienceFail(503, "Invalid science observation");
        if (o.observation.cell !== null) { validateCell(o.observation.cell); if (serializeScienceCell(o.observation.cell).agentText !== o.observation.text) scienceFail(503, "Observed serialization differs"); }
      }
    }
    for (const s of chat.shares) {
      if (trusted.has(s)) { id(s.id); if (requests.has(s.requestId)) scienceFail(503, "Duplicate share request"); requests.add(s.requestId); continue; }
      scienceExact(s, ["id", "requestId", "blockId", "revision", "source", "operationId", "representation", "agentText", "createdAt"]); id(s.id);
      if (!block(s.blockId) || !scienceId(s.requestId) || requests.has(s.requestId) || !scienceRevision(s.revision) || !scienceText(s.source) || !scienceText(s.agentText) || !time(s.createdAt) || !["source", "observed-text", "source-and-observed-text"].includes(s.representation) || s.operationId !== null && !chat.operations.some(o => o.id === s.operationId && o.blockId === s.blockId && o.source === s.source && o.revision === s.revision)) scienceFail(503, "Invalid science share");
      requests.add(s.requestId);
      const operation = chat.operations.find(o => o.id === s.operationId);
      if (s.revision > chat.blocks.find(b => b.id === s.blockId)!.revision || s.representation !== "source" && !operation?.observation || s.representation === "observed-text" && !operation?.observation?.cell) scienceFail(503, "Invalid frozen agent representation");
      const observation = operation?.observation;
      const output = s.representation === "source" ? undefined : observation!.cell ? serializeScienceCell(observation!.cell, { includeSource: false }).agentText : observation!.text;
      // Earlier combined snapshots included source inside the observed snapshot
      // as well. Accept their exact frozen bytes without rewriting sent context.
      const legacyCombined = s.representation === "source-and-observed-text" && s.agentText === materializeScienceShare(s.source, observation!.text, s.representation);
      if (s.agentText !== materializeScienceShare(s.source, output, s.representation) && !legacyCombined) scienceFail(503, "Invalid frozen agent representation");
    }
  }
}

/** V1 had no transcript placement or native addition intents. Preserve those
 * blocks at the explicit start, never infer placement from times/array indices. */
/** Single bridge writer, atomic publication; uncertain writes poison this instance. */
export class ScienceStore {
  private value: RecordValue;
  private storage: ScienceStorage;
  private trusted = new WeakSet<object>();
  private failed = false;
  constructor(readonly dataDir: string, private storeId: string) {
    this.value = { version: 2, storeId, chats: [] };
    this.storage = new ScienceStorage(dataDir, storeId);
    try {
      const chats = this.storage.load();
      if (chats) {
        const value = { version: 2, storeId, chats }; validate(value, storeId); this.value = value; this.remember(); return;
      }
    } catch { this.failed = true; }
    if (!this.failed) {
      try { this.storage.migrate(this.value.chats); this.remember(); }
      catch { this.failed = true; }
    }
  }
  private remember() { for (const chat of this.value.chats) for (const kind of ["blocks", "entries", "operations", "shares"] as const) for (const record of chat[kind]) this.trusted.add(record); }
  get(id: string) { this.assert(); return structuredClone(this.value.chats.find(c => c.conversationId === id)); }
  associations() { this.assert(); return this.value.chats.map(c => ({ workspaceId: c.workspaceId, notebook: c.notebook })); }
  private assert() { if (this.failed) scienceFail(503, "Science storage is unavailable; repair the durable record before restarting"); }
  put(chat: ScienceChatState) {
    this.assert();
    const index = this.value.chats.findIndex(c => c.conversationId === chat.conversationId), prior = this.value.chats[index];
    const next = { ...chat };
    // The compatible API accepts mutable, detached full-chat values. Compare
    // records, then reuse owned immutable objects: unchanged payloads are neither
    // cloned, serialized, hashed, revalidated nor rewritten on a draft save.
    for (const kind of ["blocks", "entries", "operations", "shares"] as const) {
      if (!Array.isArray(chat[kind])) scienceFail(503, "Invalid science collection");
      const old = new Map<string, any>(prior?.[kind].map(record => [record.id, record]) ?? []);
      (next[kind] as unknown[]) = chat[kind].map(record => {
        const previous = old.get(record.id);
        return previous && isDeepStrictEqual(previous, record) ? previous : structuredClone(record);
      });
    }
    if (prior) {
      if (next.revision < prior.revision || next.workspaceId !== prior.workspaceId || next.worktreeId !== prior.worktreeId || next.admissionKey !== prior.admissionKey) scienceFail(409, "Science durable identity or revision changed");
      const reassociate = prior.revision === 0 && !prior.notebookCreated && !prior.entries.length && !prior.operations.length && !prior.shares.length && next.notebookKind === "existing" && next.notebookCreated && !next.blocks.length;
      if (!reassociate && (next.notebook !== prior.notebook || next.notebookKind !== prior.notebookKind || prior.notebookCreated && !next.notebookCreated)) scienceFail(409, "Science notebook ownership changed");
      for (const kind of ["blocks", "entries", "operations", "shares"] as const) {
        if (kind === "blocks" && reassociate) continue;
        if (next[kind].length < prior[kind].length) scienceFail(409, "Science history cannot be removed");
        prior[kind].forEach((record, i) => {
          const updated = next[kind][i]!;
          if (record.id !== updated.id) scienceFail(409, "Science history cannot be reordered");
          if (kind === "shares" || kind === "entries") { if (record !== updated) scienceFail(409, "Science snapshot is immutable"); }
        });
      }
      for (let i = 0; i < prior.blocks.length && !reassociate; i++) {
        const a = prior.blocks[i]!, b = next.blocks[i]!;
        if (b.revision < a.revision || !isDeepStrictEqual(a.anchor, b.anchor) || a.knownSources.some(s => !b.knownSources.includes(s))) scienceFail(409, "Science block evidence cannot regress");
        if (a.source !== b.source && (b.revision <= a.revision || next.revision <= prior.revision)) scienceFail(409, "Science draft revision must advance");
        if (a.creation === null ? b.creation !== null : !b.creation || a.creation.requestId !== b.creation.requestId || a.creation.initialSource !== b.creation.initialSource || a.creation.expectedRevision !== b.creation.expectedRevision || a.creation.state !== "pending" && b.creation.state === "pending") scienceFail(409, "Science addition intent cannot change");
      }
      for (let i = 0; i < prior.operations.length; i++) {
        const a = prior.operations[i]!, b = next.operations[i]!;
        if (a === b) continue;
        const { state: as, observation: ao, error: ae, ...af } = a, { state: bs, observation: _observation, error: _error, ...bf } = b;
        const transition = as === "not-executed" && ae === undefined ? bs === "not-executed" || bs === "unknown" : as === "unknown" && bs !== "not-executed";
        if (!isDeepStrictEqual(af, bf) || !transition || ao !== null) scienceFail(409, "Science operation snapshot is immutable");
      }
    }
    validate({ version: 2, storeId: this.storeId, chats: [next] }, this.storeId, this.trusted);
    if (this.value.chats.some(c => c.conversationId !== next.conversationId && c.workspaceId === next.workspaceId && c.notebook === next.notebook)) scienceFail(409, "Notebook is already associated with a chat");
    try { this.storage.check(next); } catch (e) { scienceFail(413, e instanceof Error ? e.message : "Science storage capacity exceeded"); }
    try { this.storage.put(next); } catch { this.failed = true; scienceFail(503, "Science persistence failed; native work is fenced"); }
    if (index < 0) this.value.chats.push(next); else this.value.chats[index] = next;
    for (const kind of ["blocks", "entries", "operations", "shares"] as const) for (const record of next[kind]) this.trusted.add(record);
  }
  share(conversationId: string, snapshotId: string) { this.assert(); return structuredClone(this.value.chats.find(c => c.conversationId === conversationId)?.shares.find(s => s.id === snapshotId)); }
}
