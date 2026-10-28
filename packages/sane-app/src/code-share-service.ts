import { createHash } from "node:crypto";
import { CODE_SHARE_LIMITS, codeShareInputSnippets, codeShareSnippetRange, isInlineCodeShareSnippet, normalizeCodeShareText, parseCodeShareInput, resolveCodeShareLanguage, type CodeShareFileSnapshot, type CodeShareRecord, type CodeShareSnapshot, type NativeCodeShareRequest, type CodeShareReceipt } from "../shared/code-share-contract";
import { exact } from "./app-store";
import { canonicalJSON, canonicalPath } from "./prepared-input-codec";
import { assertSourceDescriptor } from "./app-sources";
import { isNativeHarness, validNativeAuthorityId } from "sane-core/native-source-contract";
import { uuid } from "./history";
import { body } from "./bridge-http";
import { CodeShareError, CodeShareStore, codeShareId, codeShareKey } from "./code-share-store";
import type { WorkspaceService } from "./workspace";

function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
export function parseCodeShareRequest(value: unknown): NativeCodeShareRequest {
  try {
    exact(value, ["version", "caller", "invocation", "input"]);
    exact(value.caller, ["source", "authorityId", "nativeId", "cwd"]);
    exact(value.invocation, ["toolCallId", "invocationId"], ["messageId", "wrapper"]);
    if (!isNativeHarness(value.caller.source?.harness)) throw new Error();
    assertSourceDescriptor(value.caller.source, value.caller.source.harness);
    if (value.version !== 1 || ![value.caller.authorityId, value.caller.nativeId, value.caller.cwd, value.invocation.toolCallId, value.invocation.invocationId].every(token)
      || value.invocation.messageId !== undefined && !token(value.invocation.messageId) || value.invocation.wrapper !== undefined && value.invocation.wrapper !== "execute"
      || value.caller.source.harness === "oc" && !token(value.invocation.messageId)
      || value.caller.source.harness === "oc" && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.invocation.invocationId)
      || value.caller.source.harness !== "oc" && (value.invocation.wrapper !== undefined || value.invocation.invocationId !== value.invocation.toolCallId)) throw new Error();
    if (value.caller.source.harness === "gk") {
      const descriptor = { version: 1, harness: "gk", kind: "local-home", homeRoot: value.caller.source.homeRoot };
      if (!canonicalPath(descriptor.homeRoot) || !validNativeAuthorityId("gk", value.caller.authorityId) || !uuid(value.caller.nativeId)
        || value.caller.authorityId !== `sane-native-v1:gk:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`) throw new Error();
    }
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
  constructor(private store: CodeShareStore, private workspace: Pick<WorkspaceService, "file">, private resolveSession: (request: NativeCodeShareRequest) => string, private authorize: (request: NativeCodeShareRequest, old?: CodeShareRecord) => Promise<CodeShareAuthorization>) {}
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
      if (share.version === 3) return { type: "sane.code-share", version: 3, shareId: share.id, snippets: share.snippets.map(({ input }) => codeShareSnippetRange(input)) };
      if (share.version === 2) return { type: "sane.code-share", version: 2, shareId: share.id, snippets: share.snippets.map(({ input: { path, startLine, endLine } }) => ({ path, startLine, endLine })) };
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
    const files = new Map<string, Awaited<ReturnType<WorkspaceService["file"]>>>();
    const snippets: CodeShareSnapshot[] = [];
    let totalBytes = 0;
    for (const input of codeShareInputSnippets(request.input)) {
      authorization.assertCurrent();
      let snippet: CodeShareSnapshot;
      if (isInlineCodeShareSnippet(input)) {
        const code = normalizeCodeShareText(input.code);
        snippet = { input, sourceRevision: createHash("sha256").update(code).digest("hex"), language: resolveCodeShareLanguage("", input.format), code };
      } else {
        // Reuse one captured revision when several pages reference the same file.
        const file = files.get(input.path) ?? await this.workspace.file(`${workspaceId}/${worktreeId}`, bindingRevision, input.path);
        files.set(input.path, file);
        authorization.assertCurrent();
        if (file.text === null || file.revision === null) throw new CodeShareError(400, "code-share-text", "Only UTF-8 text files up to 256 KiB can be shared");
        // Like CodeMirror, splitting normalized LF includes an empty EOF line.
        const lines = file.text.split("\n"), { startLine, endLine } = input;
        if (endLine > lines.length) throw new CodeShareError(400, "code-share-range", `The requested range exceeds the source document: ${input.path}`);
        snippet = { input, sourceRevision: file.revision, language: resolveCodeShareLanguage(input.path, input.format), code: lines.slice(startLine - 1, endLine).join("\n") };
      }
      const bytes = Buffer.byteLength(snippet.code);
      if (bytes > CODE_SHARE_LIMITS.bytes) throw new CodeShareError(400, "code-share-size", "Each snippet must be at most 64 KiB");
      totalBytes += bytes;
      if (totalBytes > CODE_SHARE_LIMITS.totalBytes) throw new CodeShareError(400, "code-share-size", "Combined snippet code exceeds 256 KiB");
      snippets.push(snippet);
    }
    await authorization.refresh?.();
    authorization.assertCurrent();
    const identity = { id: codeShareId(key), sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId }, anchor: { runId, toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null }, workspaceId, worktreeId, bindingRevision, createdAt: new Date().toISOString() };
    // Commit the complete collection atomically; a failed page saves no pages.
    const fileSnippets = snippets.filter((snippet): snippet is CodeShareFileSnapshot => !isInlineCodeShareSnippet(snippet.input));
    const record: CodeShareRecord = "snippets" in request.input
      ? fileSnippets.length === snippets.length
        ? { ...identity, version: 2, input: { snippets: fileSnippets.map(snippet => snippet.input) }, snippets: fileSnippets }
        : { ...identity, version: 3, input: request.input, snippets }
      : { ...identity, version: 1, ...snippets[0]!, input: request.input };
    return this.store.commit(record, authorization.assertCurrent);
  }
}
