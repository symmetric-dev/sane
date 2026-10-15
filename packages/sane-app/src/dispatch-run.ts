import type { Run, Session } from "./history";
import { saneContextSnapshot } from "./agent-launch";

export const NATIVE_COMMAND_PREFIX = "msg_";
const NATIVE_COMMAND_PATTERN = /^msg_[a-zA-Z0-9_-]+$/;

export function isNativeCommandId(value: unknown): value is string {
  return typeof value === "string" && NATIVE_COMMAND_PATTERN.test(value);
}

export function newNativeCommandId(): string {
  return `${NATIVE_COMMAND_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Single Run factory. Replaces 8 hand-rolled copies in bridge.ts. */
export function newDispatchRun(
  session: Pick<Session, "sessionId" | "harness" | "cwd" | "model" | "effort" | "agent" | "agentKind" | "nativeAgentSelected" | "profileId">,
  extra?: Partial<Run>,
): { run: Run; commandId: string } {
  const run: Run = {
    runId: crypto.randomUUID(),
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: "running",
    createdAt: new Date().toISOString(),
    model: session.model,
    effort: session.effort,
    agent: session.agent,
    agentKind: session.agentKind,
    nativeAgentSelected: session.nativeAgentSelected,
    profileId: session.profileId,
    ...saneContextSnapshot(session as Session),
    ...extra,
  };
  const commandId =
    session.harness === "opencode" ? newNativeCommandId() : `${run.runId}:user`;
  if (session.harness === "opencode") {
    run.nativeCommandId = commandId;
    run.nativePhase = "preparing";
  }
  return { run, commandId };
}
