import type { DispatchSource } from "../shared/conversation/dispatch-contract";
import type { ContextMessageBinding } from "./context-message";
import type { Session } from "./history";
import type { Harness } from "./oc-contract";
import { WorkstreamAdapterError } from "./workstreams";

export type DispatchSourceDependencies = {
  sessionHarness: (session: Session) => Harness;
  nativeSource: (harness?: string) => string;
};

/** Source resolution remains with the caller's configured harness authority. */
export function createDispatchSource({ sessionHarness, nativeSource }: DispatchSourceDependencies) {
  function dispatchSource(session: Session): DispatchSource {
    return Object.freeze({ harnessId: sessionHarness(session), sessionId: session.sessionId,
      authorityId: session.authorityId ?? nativeSource(sessionHarness(session)), nativeSessionId: session.nativeSessionId ?? null, cwd: session.cwd });
  }
  function dispatchSnapshot(session: Session) {
    return JSON.stringify([dispatchSource(session), session.profileId, session.model, session.effort, session.agent,
      session.agentKind, session.nativeAgentSelected, session.saneContext, session.saneExecution, session.attachment]);
  }
  function contextBinding(session: Session): ContextMessageBinding {
    const source = dispatchSource(session);
    if (!source.authorityId || !source.nativeSessionId) throw new WorkstreamAdapterError(409, "context-source-unavailable", "Shared context requires its exact admitted native source");
    return { ...source, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId };
  }
  return { dispatchSource, dispatchSnapshot, contextBinding };
}
