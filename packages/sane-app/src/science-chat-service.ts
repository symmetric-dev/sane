import { createHash } from "node:crypto";
import { materializeScienceShare, type ScienceChatRequest, type ScienceOperation } from "../shared/science-chat-contract";
import type { ScienceCell, ScienceRequest, ScienceResponse } from "../shared/science-contract";
import type { AdmissionService } from "./admission";
import type { CatalogService } from "./catalog";
import type { ScienceService } from "./science";
import type { ScienceChatNativeRequest } from "./science";
import { serializeScienceCell } from "../shared/science-share";
import { ScienceStore, scienceAnchor, scienceExact, scienceFail, scienceId, scienceRevision, scienceText } from "./science-store";
import { body, json } from "./bridge-http";
import { WorkspaceError } from "./workspace";
import { scienceSpan, scienceTimed, scienceTiming } from "sane-science/timing";
import { timeScienceRun } from "./science-timing";

type AppIdentity = { sessionId: string; cwd: string; nativeSessionId?: string; authorityId?: string; harness?: string };
type NativeInput<T = ScienceChatNativeRequest> = T extends ScienceChatNativeRequest ? Omit<T, "bindingRevision"> : never;
function validate(input: unknown): ScienceChatRequest {
  if (!input || typeof input !== "object") scienceFail(400, "Expected science action");
  const action = (input as { action?: string }).action;
  const fields: Record<string, string[]> = { provision: ["anchor"], open: ["anchor"], close: [], "associate-existing": ["expectedRevision", "notebook"], draft: ["blockId", "expectedRevision", "source"], "add-block": ["requestId", "expectedRevision", "source", "anchor"], entry: ["expectedRevision", "afterBlockId", "text"], run: ["requestId", "blockId", "expectedRevision"], share: ["requestId", "blockId", "expectedRevision", "operationId", "representation"] };
  if (!action || !Object.hasOwn(fields, action)) scienceFail(400, "Unknown science action");
  const keys = fields[action]!.filter(key => key !== "anchor" || action === "add-block" || "anchor" in input);
  scienceExact(input, ["action", ...keys]);
  if ("anchor" in input) scienceAnchor(input.anchor);
  for (const key of ["blockId", "requestId"]) if (key in input && !scienceId(input[key])) scienceFail(400, "Invalid identity");
  if ("expectedRevision" in input && !scienceRevision(input.expectedRevision) || "source" in input && !scienceText(input.source) || "text" in input && !scienceText(input.text) || "afterBlockId" in input && input.afterBlockId !== null && !scienceId(input.afterBlockId) || "operationId" in input && input.operationId !== null && !scienceId(input.operationId) || "representation" in input && !["source", "observed-text", "source-and-observed-text"].includes(input.representation as string) || "notebook" in input && (typeof input.notebook !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.py$/.test(input.notebook))) scienceFail(400, "Invalid science action fields");
  return input as unknown as ScienceChatRequest;
}
const marker = (id: string) => `# sane-science-block:${id}\n`;
// Marimo's notebook parser strips trailing whitespace on reload, including the
// final newline of a marker-only cell. Accept that exact persisted spelling of
// an already recorded, block-owned source; never infer ownership from a marker
// alone or normalize arbitrary external cell contents.
// Python 3.12 str.rstrip() whitespace differs from JavaScript trimEnd(): it
// includes U+001C–001F/U+0085 and does not include U+FEFF.
const notebookSource = (source: string) => source.replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "");
function knownSource(id: string, sources: readonly string[], code: string) {
  return sources.some(source => source === code || source.startsWith(marker(id)) && notebookSource(source) === code);
}
const markedSource = (id: string, source: string) => notebookSource(marker(id) + source);
function observed(cell: ScienceCell | undefined): ScienceOperation["observation"] {
  if (!cell) return null;
  // A structured rich output (including Marimo's error output) must not discard
  // the independent cell.errors or text console output. Keep an unsupported MIME
  // placeholder so the renderer and share serializer explicitly account for the
  // omission, without persisting arbitrary structured data as agent transport.
  const captureOutput = (output: NonNullable<ScienceCell["output"]>) => typeof output.data === "string"
    ? output
    : { ...output, mimetype: "application/x-sane-omitted", data: "" };
  const captured = structuredClone({ ...cell, output: cell.output ? captureOutput(cell.output) : null, consoleOutputs: cell.consoleOutputs.map(captureOutput) });
  if (Buffer.byteLength(JSON.stringify(captured)) > 256 * 1024) return null;
  return { provenance: "observed-unverified", text: serializeScienceCell(captured).agentText, cell: captured };
}
export class ScienceChatService {
  private busy = new Set<string>();
  constructor(readonly store: ScienceStore, private science: ScienceService, private catalog: CatalogService, private admissions: AdmissionService, private session: (id: string) => AppIdentity | undefined, private ownsMessage: (conversationId: string, messageId: string) => Promise<boolean> = async () => false) {
    for (const c of store.associations()) science.claimChatNotebook(c.workspaceId, c.notebook);
  }
  private identity(workspaceId: string, worktreeId: string, id: string) {
    const a = this.admissions.get(id), s = this.session(id), association = this.catalog.association(id);
    if (!a || a.state !== "ready" || !s || a.sessionId !== s.sessionId || a.nativeId !== s.nativeSessionId || a.source.authorityId !== s.authorityId || (a.source.descriptor.harness === "cc" ? "claude-code" : "opencode") !== s.harness || a.binding.executionCheckout !== s.cwd || a.binding.workspaceId !== workspaceId || a.binding.worktreeId !== worktreeId || association.workspaceId !== workspaceId || association.worktreeId !== worktreeId) scienceFail(409, "Conversation admission and selected workspace identity differ");
    return a;
  }
  /** Backend send integration: freeze these returned IDs/texts into its own dispatch intent.
   * Never look up live source/output while retrying an already materialized dispatch. */
  resolveShareSnapshots(conversationId: string, snapshotIds: readonly string[]) {
    if (!Array.isArray(snapshotIds) || !snapshotIds.length || snapshotIds.length > 32 || !snapshotIds.every(scienceId) || new Set(snapshotIds).size !== snapshotIds.length) scienceFail(400, "Invalid science share selection");
    const chat = this.store.get(conversationId);
    if (!chat) scienceFail(404, "Science chat not found");
    const admission = this.identity(chat.workspaceId, chat.worktreeId, conversationId);
    if (chat.admissionKey !== createHash("sha256").update(JSON.stringify(admission)).digest("hex")) scienceFail(409, "Science share admission changed");
    const snapshots = snapshotIds.map(id => {
      const snapshot = chat.shares.find(s => s.id === id);
      if (!snapshot) scienceFail(404, "Science share snapshot not found in this conversation");
      return snapshot;
    });
    if (snapshots.reduce((n, s) => n + Buffer.byteLength(s.agentText), 0) > 256 * 1024) scienceFail(413, "Science share selection exceeds payload limit");
    return snapshots;
  }
  async handle(workspaceId: string, worktreeId: string, id: string, input: ScienceChatRequest | undefined, authorized: () => boolean) {
    if (![workspaceId, worktreeId, id].every(scienceId)) scienceFail(400, "Invalid science identity");
    if (input?.action === "run" && scienceId(input.requestId) && scienceId(input.blockId)) {
      return timeScienceRun(this.store.dataDir, { requestId: input.requestId, blockId: input.blockId, conversationId: id }, () => this.perform(workspaceId, worktreeId, id, input, authorized));
    }
    return this.perform(workspaceId, worktreeId, id, input, authorized);
  }
  private async perform(workspaceId: string, worktreeId: string, id: string, input: ScienceChatRequest | undefined, authorized: () => boolean) {
    if (this.busy.has(id)) scienceFail(409, "Science chat operation pending");
    this.busy.add(id);
    try {
      const admission = this.identity(workspaceId, worktreeId, id), pin = JSON.stringify(admission);
      const admissionKey = createHash("sha256").update(pin).digest("hex");
      const current = () => { if (!authorized() || JSON.stringify(this.identity(workspaceId, worktreeId, id)) !== pin) scienceFail(409, "Science conversation authorization changed"); };
      current();
      let chat = this.store.get(id);
      if (!chat) {
        if (!input) return { chat: null };
        if (input.action !== "open" && input.action !== "provision" && input.action !== "associate-existing") scienceFail(404, "Science chat not found");
        const anchor = "anchor" in input && input.anchor ? input.anchor : { kind: "start" as const };
        if (anchor.kind === "after-message" && !await this.ownsMessage(id, anchor.messageId)) scienceFail(409, "Anchor is not an exact canonical message in this conversation");
        current();
        chat = { conversationId: id, workspaceId, worktreeId, admissionKey, notebook: `chat-${crypto.randomUUID()}.py`, notebookKind: "owned", notebookCreated: false, revision: 0, blocks: [{ id: crypto.randomUUID(), revision: 0, source: "", knownSources: [""], anchor: structuredClone(anchor), creation: null }], entries: [], operations: [], shares: [] };
        this.science.claimChatNotebook(workspaceId, chat.notebook);
        this.store.put(chat);
      }
      if (chat.workspaceId !== workspaceId || chat.worktreeId !== worktreeId || chat.admissionKey !== admissionKey) scienceFail(409, "Durable science association differs");
      this.science.claimChatNotebook(workspaceId, chat.notebook);
      if (!input) return { chat }; // Durable history remains readable without checkout or Python.
      const save = () => { const end = scienceSpan("persistence"); try { current(); this.store.put(chat!); end(); } catch (error) { end("error"); throw error; } };
      const cas = (revision: number) => { if (input && "expectedRevision" in input && input.expectedRevision !== revision) scienceFail(409, "Science revision conflict"); };
      const block = "blockId" in input ? chat.blocks.find(b => b.id === input.blockId) : undefined;
      if ("blockId" in input && !block) scienceFail(404, "Science block not found");
      const addition = "requestId" in input ? chat.blocks.find(b => b.creation?.requestId === input.requestId) : undefined;
      if (input.action !== "add-block" && addition) scienceFail(409, "Request identity belongs to a block addition");
      if (input.action === "add-block") {
        if (addition) {
          if (addition.creation!.initialSource !== input.source || addition.creation!.expectedRevision !== input.expectedRevision || JSON.stringify(addition.anchor) !== JSON.stringify(input.anchor)) scienceFail(409, "Block addition request identity reused");
          return { chat };
        }
        if (chat.operations.some(o => o.requestId === input.requestId) || chat.shares.some(s => s.requestId === input.requestId)) scienceFail(409, "Request identity reused");
        cas(chat.revision);
        if (chat.notebookKind === "existing" && !chat.blocks.some(b => b.creation === null)) scienceFail(409, "Open the existing notebook before adding blocks");
        if (input.anchor.kind === "after-message" && !await this.ownsMessage(id, input.anchor.messageId)) scienceFail(409, "Anchor is not an exact canonical message in this conversation");
        current();
        const blockId = crypto.randomUUID(), code = markedSource(blockId, input.source);
        if (!scienceText(code)) scienceFail(413, "Marked source exceeds limit");
        chat.blocks.push({ id: blockId, revision: 0, source: input.source, knownSources: [code], anchor: structuredClone(input.anchor), creation: { requestId: input.requestId, initialSource: input.source, expectedRevision: input.expectedRevision, state: "pending", generation: null } });
        chat.revision++; save();
      } else if (input.action === "draft") { cas(block!.revision); block!.source = input.source; block!.revision++; chat.revision++; save(); }
      else if (input.action === "entry") {
        cas(chat.revision); if (input.afterBlockId !== null && !chat.blocks.some(b => b.id === input.afterBlockId)) scienceFail(409, "Entry anchor missing");
        chat.entries.push({ id: crypto.randomUUID(), afterBlockId: input.afterBlockId, text: input.text }); chat.revision++; save();
      } else if (input.action === "associate-existing") {
        cas(chat.revision); if (chat.revision !== 0 || chat.notebookCreated) scienceFail(409, "Notebook association is already initialized");
        if (this.store.associations().some(c => c.workspaceId === workspaceId && c.notebook === input.notebook)) scienceFail(409, "Notebook is already associated with a chat");
        // Claim before publishing ownership; no await separates claim and save.
        // Retain the claim if persistence fails with an uncertain write outcome.
        this.science.claimChatNotebook(workspaceId, input.notebook);
        chat.notebook = input.notebook; chat.notebookKind = "existing"; chat.notebookCreated = true; chat.blocks = []; chat.revision++; save();
      } else if (input.action === "share") {
        const prior = chat.shares.find(s => s.requestId === input.requestId);
        if (prior) {
          if (prior.blockId !== input.blockId || prior.revision !== input.expectedRevision || prior.operationId !== input.operationId || prior.representation !== input.representation) scienceFail(409, "Share request identity reused");
          return { chat };
        }
        if (chat.operations.some(o => o.requestId === input.requestId)) scienceFail(409, "Request identity reused");
        const op = input.operationId === null ? undefined : chat.operations.find(o => o.id === input.operationId && o.blockId === block!.id);
        cas(op?.revision ?? block!.revision);
        if (input.operationId !== null && !op || input.representation !== "source" && !op?.observation) scienceFail(409, "Exact observed text representation unavailable; use source sharing");
        if (input.representation === "observed-text" && !op?.observation?.cell) scienceFail(409, "Output-only snapshot unavailable for this run");
        const source = op?.source ?? block!.source, revision = op?.revision ?? block!.revision;
        const observation = op?.observation;
        const output = input.representation === "source" ? undefined : observation!.cell ? serializeScienceCell(observation!.cell, { includeSource: false }).agentText : observation!.text;
        const agentText = materializeScienceShare(source, output, input.representation);
        if (!scienceText(agentText)) scienceFail(413, "Share exceeds payload limit");
        chat.shares.push({ id: crypto.randomUUID(), requestId: input.requestId, blockId: block!.id, revision, source, operationId: input.operationId, representation: input.representation, agentText, createdAt: new Date().toISOString() }); chat.revision++; save();
      } else {
        if (input.action === "run") {
          const prior = chat.operations.find(o => o.requestId === input.requestId);
           if (prior) { if (prior.blockId !== input.blockId || prior.revision !== input.expectedRevision) scienceFail(409, "Run request identity reused"); const trace = scienceTiming.getStore(); if (trace) trace.outcome = "reused-request"; return { chat }; }
          if (chat.shares.some(s => s.requestId === input.requestId)) scienceFail(409, "Request identity reused");
          cas(block!.revision);
          if (chat.operations.some(o => o.state === "unknown")) scienceFail(409, "An execution outcome is unknown; automatic replay is fenced");
        }
        if (admission.binding.domain.mode !== "repository") scienceFail(409, "Science execution requires repository admission");
        const repositoryId = admission.binding.domain.repositoryId;
        return await this.science.withChatOperation(workspaceId, worktreeId, { cwd: admission.binding.executionCheckout, bindingRevision: admission.binding.bindingRevision, repositoryId, notebook: chat.notebook }, () => { current(); return true; }, async native => {
        const call = async (request?: NativeInput, stage: string = request?.action ?? "readiness-status") => {
          current();
          const result = await scienceTimed(stage, () => native(request ? { ...request, bindingRevision: admission.binding.bindingRevision } as ScienceChatNativeRequest : undefined));
          current(); if (result.status.repositoryId !== repositoryId) scienceFail(409, "Admitted science repository differs");
          return result;
        };
        let status = await call();
        if (input.action === "provision") { await call({ action: "provision" }); return { chat }; }
        if (input.action === "close") {
          const session = status.status.sessions.find(s => s.notebook === chat!.notebook);
          if (session) await call({ action: "close", notebook: chat.notebook, generation: session.generation } as ScienceRequest);
          return { chat };
        }
        if (!status.status.notebooks.includes(chat.notebook)) {
          if (chat.notebookKind !== "owned" || chat.notebookCreated) scienceFail(409, "Associated notebook is unavailable; durable history retained");
          if (status.status.environment.state !== "ready") scienceFail(409, "Explicitly provision the science environment before opening a notebook");
          // A crash before/during creation is not permission to recreate a lost notebook.
          chat.notebookCreated = true; save();
          await call({ action: "create", notebook: chat.notebook } as ScienceRequest);
        }
        const session = status.status.sessions.find(s => s.notebook === chat!.notebook);
        const trace = scienceTiming.getStore(); if (trace) trace.sessionEvidence = session ? "existing-session" : "open-required";
        status = session ? await call({ action: "inspect", notebook: chat.notebook, generation: session.generation } as ScienceRequest) : await call({ action: "open", notebook: chat.notebook } as ScienceRequest);
        let cells = status.snapshot?.cells;
        if (!cells || !status.session) scienceFail(409, "Native notebook snapshot unavailable");
        if (!chat.blocks.length) {
          chat.blocks = cells.map(c => ({ id: crypto.randomUUID(), revision: 0, source: c.code, knownSources: [c.code], anchor: { kind: "start" }, creation: null })); chat.revision++; save();
        }
        const mapped = new Map<string, ScienceCell>(), claimed = new Set<string>();
        const materialize: typeof chat.blocks = [];
        let generationChanged = false;
        for (const b of chat.blocks) {
          if (b.creation?.state === "unknown") scienceFail(409, "Native cell addition outcome is unknown; automatic replay is fenced");
          if (b.creation?.state === "pending") { materialize.push(b); continue; }
          const matches = cells.filter(c => knownSource(b.id, b.knownSources, c.code));
          // A confirmed, nonexecuting addition may be absent after restart because
          // native autosave was never acknowledged. Re-materialize from durable
          // source only in a different generation with an otherwise exact map.
          if (!matches.length && b.creation?.state === "created" && b.creation.generation !== status.session.generation) { materialize.push(b); continue; }
          if (matches.length !== 1 || claimed.has(matches[0]!.id)) scienceFail(409, "Notebook source mapping is ambiguous or externally changed");
          mapped.set(b.id, matches[0]!); claimed.add(matches[0]!.id);
          if (b.creation && b.creation.generation !== status.session.generation) { b.creation.generation = status.session.generation; generationChanged = true; }
        }
        if (claimed.size !== cells.length) scienceFail(409, "Notebook cell set changed externally");
        if (generationChanged) save();
        for (const b of materialize) {
          const code = markedSource(b.id, b.source);
          if (!scienceText(code)) scienceFail(413, "Marked source exceeds limit");
          if (!b.knownSources.includes(code)) b.knownSources.push(code);
          b.creation!.state = "unknown"; b.creation!.generation = status.session.generation; save();
          const after = [...mapped.values()].at(-1)?.id;
          const result = await call({ action: "create-cell", notebook: chat.notebook, generation: status.session.generation, code, ...(after ? { after } : {}) });
          if (result.operation?.mutation !== "accepted") scienceFail(409, "Native cell addition was not confirmed; intent retained");
          const inspection = await call({ action: "inspect", notebook: chat.notebook, generation: status.session.generation });
          const matches = inspection.snapshot?.cells.filter(c => c.code === code) ?? [];
          if (matches.length !== 1 || claimed.has(matches[0]!.id) || inspection.snapshot!.cells.length !== claimed.size + 1 || inspection.snapshot!.cells.some(c => c.id !== matches[0]!.id && ![...mapped.values()].some(prior => prior.id === c.id && prior.code === c.code))) scienceFail(409, "Native addition mapping is unconfirmed");
          mapped.set(b.id, matches[0]!); claimed.add(matches[0]!.id);
          b.creation!.state = "created"; save();
        }
        if (input.action === "open") return { chat };
        if (input.action !== "run") scienceFail(400, "Unsupported science action");
        const cell = mapped.get(block!.id)!, code = markedSource(block!.id, block!.source);
        if (!scienceText(code)) scienceFail(413, "Marked source exceeds limit");
        if (!block!.knownSources.includes(code)) block!.knownSources.push(code);
        const operation: ScienceOperation = { id: crypto.randomUUID(), requestId: input.requestId, blockId: block!.id, revision: block!.revision, source: block!.source, state: "not-executed", createdAt: new Date().toISOString(), observation: null };
        chat.operations.push(operation); chat.revision++; save(); // Intent AND source precede native mutation.
        const selected = { notebook: chat.notebook, generation: status.session.generation };
        const editFailure = (message: string) => { operation.error = message.slice(0, 8192); save(); if (trace) trace.outcome = "edit-unconfirmed"; return { chat }; };
        let edited: ScienceResponse;
        try { edited = await call({ action: "edit", ...selected, cellId: cell.id, code, expectedSourceHash: cell.sourceHash } as ScienceRequest); }
        catch (error) { return editFailure(error instanceof Error ? error.message : "Source edit failed before execution"); }
        if (edited.operation?.mutation !== "accepted") return editFailure(edited.operation?.error || "Source edit was not confirmed; Python execution was not requested.");
        let verified: boolean;
        try { verified = await scienceTimed("edit-verification", async () => {
          // Edit returns a fresh snapshot from a separate post-mutation pair request.
          const snapshot = edited.snapshot ?? (await call({ action: "inspect", ...selected } as ScienceRequest, "edit-verification-inspect")).snapshot;
          return snapshot?.cells.find(c => c.id === cell.id)?.code === code;
        }); } catch (error) { return editFailure(error instanceof Error ? error.message : "Source verification failed before execution"); }
        if (!verified) return editFailure("Source edit verification failed; Python execution was not requested.");
        // Fence only after the edit is verified, immediately before execution dispatch.
        operation.state = "unknown"; save();
        let result: ScienceResponse;
        try { result = await call({ action: "run", ...selected, cellId: cell.id } as ScienceRequest); }
        catch (error) {
          operation.error = (error instanceof Error ? error.message : "Execution outcome unconfirmed").slice(0, 8192);
          save();
          if (trace) trace.outcome = "unknown";
          return { chat };
        }
        // Finalize once; observations explicitly have no causal source guarantee.
        operation.state = result.operation?.execution === "succeeded" ? "succeeded" : result.operation?.execution === "failed" ? "failed" : "unknown";
        if (result.operation?.error) operation.error = result.operation.error.slice(0, 8192);
        const captured = scienceSpan("observation-capture");
        try { operation.observation = observed(result.snapshot?.cells.find(c => c.id === cell.id)); captured(operation.observation ? "captured" : "unavailable"); }
        catch (error) { captured("error"); throw error; }
        save();
        if (trace) trace.outcome = operation.state;
        return { chat };
        });
      }
      return { chat };
    } finally { this.busy.delete(id); }
  }
}
export async function scienceChatRoute(req: Request, service: ScienceChatService, authorized: () => boolean): Promise<Response | null> {
  const url = new URL(req.url), match = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/science\/chats\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    if (url.search) scienceFail(400, "Query parameters are unsupported");
    if (!["GET", "POST"].includes(req.method)) return json({ error: "Method not allowed" }, 405);
    let input: ScienceChatRequest | undefined;
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") scienceFail(415, "Expected JSON");
      let parsed: unknown; try { parsed = await body(req); } catch { scienceFail(400, "Invalid JSON or body exceeds 1 MiB"); }
      input = validate(parsed);
    }
    return json(await service.handle(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), decodeURIComponent(match[3]!), input, authorized));
  } catch (e) { return e instanceof WorkspaceError ? json({ error: e.message, code: e.code }, e.status) : json({ error: "Science chat unavailable; durable history retained", code: "science-chat-unavailable" }, 503); }
}
