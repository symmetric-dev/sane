import { validNativeAuthorityId } from "sane-core/native-source-contract";
import { parseAsideSourceSnapshot, type AsideSourceSnapshot, type AsideTarget, type AsideTranscriptSnapshot } from "../shared/aside-contract";
import type { UserQuestionsRecord } from "../shared/user-questions-contract";
import { AsideError } from "./aside-store";
import { toNativeHarness } from "./harness-names";
import { uuid, type Session } from "./history";
import { canonicalJSON, canonicalPath } from "./prepared-input-codec";

export interface AsideSourceAuthorization {
  session: Session;
  binding: AsideSourceSnapshot["binding"];
  /** Must recheck source membership, native identity, binding admission, and
   * request/store authority, including replacement of the session object. */
  assertCurrent(): void;
}

export interface AsideSourcePorts {
  storeId: string;
  /** Historical App records need not retain a live native session or checkout. */
  authorizeRead(sessionId: string): () => void;
  /** Creation requires a live, qualified source and its pinned admission. */
  authorizeSource(sessionId: string): Promise<AsideSourceAuthorization>;
  /** The bridge loads existing journals before invoking transcript capture. */
  captureTranscript(session: Session): Promise<AsideTranscriptSnapshot>;
  question(sessionId: string, formId: string): UserQuestionsRecord | undefined;
}

export interface ResolvedAsideSource {
  source: AsideSourceSnapshot;
  assertCurrent(): void;
}

const changed = (): never => { throw new AsideError(409, "aside-source-changed", "Aside source identity, binding, context, or question changed during capture"); };
// Do not pin streaming status or run IDs. Context text participates only in a
// transient drift check; the durable source contains revision references only.
const sourcePin = (session: Session, binding: AsideSourceSnapshot["binding"]) => JSON.stringify([
  session.sessionId, session.harness, session.authorityId, session.nativeSessionId,
  session.cwd, session.attachment, session.agent, session.agentKind,
  session.nativeAgentSelected, session.profileId, session.saneExecution,
  session.saneContext, binding,
]);

/** Captures inert App references only. No native fork, run, context selection,
 * or authorization to execute is created by resolving a source. */
export class AsideSourceResolver {
  constructor(private ports: AsideSourcePorts) {}

  authorizeRead(sessionId: string): () => void {
    const assertCurrent = this.ports.authorizeRead(sessionId);
    assertCurrent();
    return assertCurrent;
  }

  async resolve(sessionId: string, target: AsideTarget): Promise<ResolvedAsideSource> {
    const authorization = await this.ports.authorizeSource(sessionId);
    authorization.assertCurrent();
    const { session, binding } = authorization;
    if (session.sessionId !== sessionId) throw new AsideError(409, "aside-source-identity", "Source authorization belongs to another conversation");
    if (!session.harness || session.attachment && session.attachment.state !== "ready") throw new AsideError(409, "aside-source-not-ready", "Aside capture requires a ready native source");
    let harness: AsideSourceSnapshot["native"]["harness"];
    try { harness = toNativeHarness(session.harness); }
    catch { throw new AsideError(409, "aside-source-identity", "Aside capture requires a supported native harness"); }
    if (!validNativeAuthorityId(harness, session.authorityId)
      || !(harness === "oc" ? typeof session.nativeSessionId === "string" && /^ses[a-zA-Z0-9_-]{1,200}$/.test(session.nativeSessionId) : uuid(session.nativeSessionId))) {
      throw new AsideError(409, "aside-source-identity", "Aside capture requires a qualified native identity");
    }
    if (!canonicalPath(binding.cwd) || binding.cwd !== session.cwd) throw new AsideError(409, "aside-source-binding", "Source binding does not match the conversation directory");
    const native: AsideSourceSnapshot["native"] = { harness, authorityId: session.authorityId, nativeId: session.nativeSessionId! };
    const pinnedBinding = structuredClone(binding), pin = sourcePin(session, binding);
    const context: NonNullable<AsideSourceSnapshot["context"]> = {
      ...(session.saneExecution ? { executionRevision: session.saneExecution.revision } : {}),
      ...(session.saneContext?.package ? { packageRevision: session.saneContext.package.revision } : {}),
    };
    const readQuestion = (): AsideSourceSnapshot["question"] => {
      if (target.kind !== "question") return undefined;
      let form: UserQuestionsRecord | undefined;
      try { form = this.ports.question(sessionId, target.formId); }
      catch (error) {
        if ((error as { status?: number })?.status === 404) throw new AsideError(404, "aside-question-missing", "Question form is not available in this conversation");
        throw error;
      }
      if (!form) throw new AsideError(404, "aside-question-missing", "Question form is not available in this conversation");
      if (form.id !== target.formId || form.sessionId !== sessionId || canonicalJSON(form.native) !== canonicalJSON(native)
        || form.workspaceId !== pinnedBinding.workspaceId || form.worktreeId !== pinnedBinding.worktreeId
        || form.bindingRevision !== pinnedBinding.bindingRevision || form.cwd !== pinnedBinding.cwd) {
        throw new AsideError(409, "aside-question-source", "Question does not belong to the authorized source binding");
      }
      const question = form.input.pages[target.questionIndex];
      if (!Number.isSafeInteger(target.questionIndex) || target.questionIndex < 0 || !question) throw new AsideError(404, "aside-question-missing", "Question page does not exist");
      // Never include answers, submission, or delivery state in the source.
      return structuredClone({ formId: form.id, formRevision: form.revision, questionIndex: target.questionIndex, question, anchor: form.anchor });
    };
    const question = readQuestion(), questionPin = question ? canonicalJSON(question) : null;
    const assertCurrent = () => {
      authorization.assertCurrent();
      if (sourcePin(session, binding) !== pin) changed();
      if (questionPin !== null && canonicalJSON(readQuestion()) !== questionPin) changed();
    };
    assertCurrent();
    // Detached input prevents the async projection from seeing in-place identity
    // changes; the authority callback rejects replacement and drift afterward.
    const transcript = await this.ports.captureTranscript(structuredClone(session));
    assertCurrent();
    let source: AsideSourceSnapshot;
    try {
      source = parseAsideSourceSnapshot({
        storeId: this.ports.storeId, sessionId, rootSessionId: sessionId,
        native, binding: pinnedBinding, capturedAt: new Date().toISOString(), transcript,
        ...(question ? { question } : {}), ...(Object.keys(context).length ? { context } : {}),
      });
    } catch (error) {
      if (error instanceof AsideError) throw error;
      throw new AsideError(409, "aside-source-invalid", "The captured App reference is invalid or exceeds the snapshot budget");
    }
    assertCurrent();
    return { source: structuredClone(source), assertCurrent };
  }
}

export function createAsideSourceResolver(ports: AsideSourcePorts): AsideSourceResolver {
  return new AsideSourceResolver(ports);
}
