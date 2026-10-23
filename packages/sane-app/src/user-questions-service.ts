import type { NativeUserQuestionsRequest } from "../../sane-cli/src/native-user-questions-contract";
import { parsePresentQuestionsInput, type UserQuestionsRecord, type UserQuestionsReceipt } from "../shared/user-questions-contract";
import { exact } from "./app-store";
import { body } from "./bridge-http";
import { UserQuestionsError, UserQuestionsStore } from "./user-questions-store";

type Identity = Pick<UserQuestionsRecord, "sessionId" | "native" | "anchor" | "workspaceId" | "worktreeId" | "bindingRevision" | "cwd">;
export interface UserQuestionsAuthorization {
  identity: Identity;
  assertCurrent(): void;
  refresh?(): Promise<void>;
}

function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function parseNativeRequest(value: unknown): NativeUserQuestionsRequest {
  try {
    exact(value, ["version", "caller", "invocation", "input"]);
    exact(value.caller, ["source", "authorityId", "nativeId", "cwd"]);
    exact(value.invocation, ["toolCallId", "invocationId"], ["messageId", "wrapper"]);
    if (value.version !== 1 || ![value.caller.authorityId, value.caller.nativeId, value.caller.cwd, value.invocation.toolCallId, value.invocation.invocationId].every(token)
      || value.invocation.messageId !== undefined && !token(value.invocation.messageId)
      || value.invocation.wrapper !== undefined && value.invocation.wrapper !== "execute"
      || !value.caller.source || !["cc", "oc"].includes(value.caller.source.harness)
      || value.caller.source.harness === "oc" && (!token(value.invocation.messageId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.invocation.invocationId))
      || value.caller.source.harness === "cc" && (value.invocation.wrapper !== undefined || value.invocation.invocationId !== value.invocation.toolCallId)) throw new Error();
    return { version: 1, caller: value.caller, invocation: value.invocation, input: parsePresentQuestionsInput(value.input) };
  } catch { throw new UserQuestionsError(400, "user-questions-invalid", "Invalid questions or native invocation"); }
}

/** The native transport returns after publication. Answer submission is a
 * separate browser operation and never holds the author's tool call open. */
export class UserQuestionsService {
  private pending = new Map<string, Promise<UserQuestionsRecord>>();
  constructor(private store: UserQuestionsStore, private resolveSession: (request: NativeUserQuestionsRequest) => string,
    private authorize: (request: NativeUserQuestionsRequest, old?: UserQuestionsRecord) => Promise<UserQuestionsAuthorization>) {}
  async handle(req: Request): Promise<UserQuestionsReceipt> {
    if (req.method !== "POST") throw new UserQuestionsError(405, "method-not-allowed", "Use POST");
    let raw: unknown;
    try { raw = await body(req); } catch { throw new UserQuestionsError(400, "user-questions-invalid", "Invalid or oversized request body"); }
    const request = parseNativeRequest(raw), sessionId = this.resolveSession(request);
    const key = JSON.stringify([sessionId, request.caller.authorityId, request.caller.nativeId, request.invocation]);
    const previous = this.pending.get(key);
    if (previous) { try { await previous; } catch { /* Reauthorize and inspect the original operation, never native-retry. */ } }
    const operation = this.publish(request, sessionId);
    this.pending.set(key, operation);
    try { const form = await operation; return { form_id: form.id, status: "presented" }; }
    finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
  private async publish(request: NativeUserQuestionsRequest, sessionId: string): Promise<UserQuestionsRecord> {
    const old = this.store.list(sessionId).find(form => form.native.harness === request.caller.source.harness
      && form.native.authorityId === request.caller.authorityId && form.native.nativeId === request.caller.nativeId
      && form.anchor.toolCallId === request.invocation.toolCallId && form.anchor.messageId === (request.invocation.messageId ?? null)
      && form.anchor.invocationId === request.invocation.invocationId && form.anchor.wrapper === (request.invocation.wrapper ?? null));
    const authorization = await this.authorize(request, old);
    await authorization.refresh?.();
    authorization.assertCurrent();
    return this.store.publish(authorization.identity, request.input, authorization.assertCurrent);
  }
}
