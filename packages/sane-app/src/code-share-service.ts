import { CODE_SHARE_LIMITS, parseCodeShareInput, resolveCodeShareLanguage, type CodeShareRecord, type NativeCodeShareRequest, type CodeShareReceipt } from "../shared/code-share-contract";
import { exact } from "./app-store";
import { canonicalJSON } from "./prepared-input-codec";
import { body } from "./bridge-http";
import { CodeShareError, CodeShareStore, codeShareId, codeShareKey } from "./code-share-store";
import type { WorkspaceService } from "./workspace";

function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
export function parseCodeShareRequest(value: unknown): NativeCodeShareRequest {
  try {
    exact(value, ["version", "caller", "invocation", "input"]);
    exact(value.caller, ["source", "authorityId", "nativeId", "cwd"]);
    exact(value.invocation, ["toolCallId", "invocationId"], ["messageId", "wrapper"]);
    if (value.version !== 1 || ![value.caller.authorityId, value.caller.nativeId, value.caller.cwd, value.invocation.toolCallId, value.invocation.invocationId].every(token)
      || value.invocation.messageId !== undefined && !token(value.invocation.messageId) || value.invocation.wrapper !== undefined && value.invocation.wrapper !== "execute"
      || !value.caller.source || !["cc", "oc"].includes(value.caller.source.harness)
      || value.caller.source.harness === "oc" && !token(value.invocation.messageId)
      || value.caller.source.harness === "oc" && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.invocation.invocationId)
      || value.caller.source.harness === "cc" && (value.invocation.wrapper !== undefined || value.invocation.invocationId !== value.invocation.toolCallId)) throw new Error();
    return { version: 1, caller: { source: value.caller.source, authorityId: value.caller.authorityId, nativeId: value.caller.nativeId, cwd: value.caller.cwd }, invocation: { toolCallId: value.invocation.toolCallId, invocationId: value.invocation.invocationId, ...(value.invocation.messageId !== undefined ? { messageId: value.invocation.messageId } : {}), ...(value.invocation.wrapper !== undefined ? { wrapper: value.invocation.wrapper } : {}) }, input: parseCodeShareInput(value.input) };
  } catch { throw new CodeShareError(400, "invalid-code-share", "Invalid code share request"); }
}
export interface CodeShareAuthorization {
  sessionId: string; runId: string; workspaceId: string; worktreeId: string; bindingRevision: string;
  assertCurrent(): void;
  refresh?(): Promise<void>;
}
export class CodeShareService {
  private pending = new Map<string, Promise<CodeShareRecord>>();
  constructor(private store: CodeShareStore, private workspace: WorkspaceService, private resolveSession: (request: NativeCodeShareRequest) => string, private authorize: (request: NativeCodeShareRequest, old?: CodeShareRecord) => Promise<CodeShareAuthorization>) {}
  async handle(req: Request): Promise<CodeShareReceipt> {
    if (req.method !== "POST") throw new CodeShareError(405, "method-not-allowed", "Use POST");
    let raw: unknown;
    try { raw = await body(req); } catch { throw new CodeShareError(400, "invalid-code-share", "Invalid or oversized request body"); }
    const request = parseCodeShareRequest(raw), sessionId = this.resolveSession(request), key = codeShareKey(sessionId, request);
    // Concurrent identical callbacks wait for the original commit. Conflicting
    // callbacks then fail against its input without reading the source again.
    const prior = this.pending.get(key);
    if (prior) { try { await prior; } catch { /* Recheck current authorization; never replay native execution. */ } }
    const operation = this.capture(request, key);
    this.pending.set(key, operation);
    try {
      const share = await operation;
      return { type: "sane.code-share", version: 1, shareId: share.id, path: share.input.path, startLine: share.input.startLine, endLine: share.input.endLine };
    } finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
  private async capture(request: NativeCodeShareRequest, key: string): Promise<CodeShareRecord> {
    const old = this.store.find(key);
    if (old && canonicalJSON(old.input) !== canonicalJSON(request.input)) throw new CodeShareError(409, "code-share-conflict", "This invocation already shared a different excerpt");
    const authorization = await this.authorize(request, old);
    authorization.assertCurrent();
    if (old) return old; // Recovery must work after source deletion/checkout loss.
    const { sessionId, runId, workspaceId, worktreeId, bindingRevision } = authorization;
    const file = await this.workspace.file(`${workspaceId}/${worktreeId}`, bindingRevision, request.input.path);
    await authorization.refresh?.();
    authorization.assertCurrent();
    if (file.text === null || file.revision === null) throw new CodeShareError(400, "code-share-text", "Only UTF-8 text files up to 256 KiB can be shared");
    // WorkspaceService decodes strict UTF-8 and normalizes CRLF/CR to LF.
    // Like CodeMirror, splitting LF includes the empty final line after EOF LF.
    const lines = file.text.split("\n"), { startLine, endLine } = request.input;
    if (endLine > lines.length) throw new CodeShareError(400, "code-share-range", "The requested range exceeds the source document");
    const code = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(code) > CODE_SHARE_LIMITS.bytes) throw new CodeShareError(400, "code-share-size", "The excerpt exceeds 64 KiB");
    return this.store.commit({ version: 1, id: codeShareId(key), sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId }, anchor: { runId, toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null }, workspaceId, worktreeId, bindingRevision, sourceRevision: file.revision, language: resolveCodeShareLanguage(request.input.path, request.input.format), createdAt: new Date().toISOString(), input: request.input, code }, authorization.assertCurrent);
  }
}
