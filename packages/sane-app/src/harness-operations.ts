import { getHarnessDescriptor, isHarness, type Harness, type HarnessDescriptor, type HarnessOperation } from "../shared/conversation/harness-capabilities";
import type { DispatchSource } from "../shared/conversation/dispatch-contract";
import type { RunOwner } from "./run-owner";

export class HarnessOperationError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 501, readonly code: string) { super(message); }
}

/** Only a caller explicitly opting into historical omission may supply a default.
 * Null, malformed values and unknown future harnesses are never omissions. */
export function validateHarness(value: unknown, options?: { defaultHarness: Harness }): Harness {
  const selected = value === undefined && options ? options.defaultHarness : value;
  if (!isHarness(selected)) throw new HarnessOperationError("Unknown harness", 400, "unknown-harness");
  return selected;
}

export function requireOperation(value: unknown, operation: HarnessOperation): HarnessDescriptor {
  const descriptor = getHarnessDescriptor(validateHarness(value))!;
  const support = descriptor.operations[operation];
  if (!support.supported) throw new HarnessOperationError(support.reason, 501, "unsupported-harness-operation");
  return descriptor;
}

/** Preserve each native API's arguments and result, including richer history
 * shapes. There is intentionally no catch-all Claude driver. */
export function dispatchHarness<CC, OC>(value: unknown, callbacks: { "claude-code": () => CC; opencode: () => OC }): CC | OC {
  const harness = validateHarness(value);
  switch (harness) {
    case "claude-code": return callbacks["claude-code"]();
    case "opencode": return callbacks.opencode();
  }
  const exhaustive: never = harness;
  throw new HarnessOperationError(`Unknown harness: ${exhaustive}`, 400, "unknown-harness");
}

type OwnedOperationSession = { sessionId: string; harness: unknown; source?: DispatchSource; authorityId?: string | null; nativeSessionId?: string | null; cwd?: string };
type OperationOwner = { run: { sessionId: string }; native?: boolean; readonly controls?: RunOwner["controls"] };

export function requireOwnedOperation(session: OwnedOperationSession, owner: OperationOwner, operation: HarnessOperation): HarnessDescriptor {
  const descriptor = requireOperation(session.harness, operation);
  const controls = owner.controls, source = controls?.source;
  // Capability validation stays first. Lifecycle association comes from the
  // original bound controls, never the private legacy native monitor marker.
  if (!controls || !source || source.sessionId !== session.sessionId || source.harnessId !== descriptor.id) {
    throw new HarnessOperationError("Run owner harness or conversation differs from its session", 409, "owner-harness-mismatch");
  }
  // Stop targets the original owned resource. A native adapter validates its
  // source at interruption; local termination must survive launch metadata drift.
  if (operation === "cancelOwnedRun") controls.assertOwner(owner as RunOwner);
  else {
    if (owner.run.sessionId !== session.sessionId
      || (["authorityId", "nativeSessionId", "cwd"] as const).some(key => key in session && session[key] !== source[key])
      || (session.source !== undefined && (["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const).some(key => session.source![key] !== source[key]))) {
      throw new HarnessOperationError("Run owner harness or conversation differs from its session", 409, "owner-harness-mismatch");
    }
    controls.assertIdentity(owner as RunOwner);
  }
  return descriptor;
}

export function dispatchOwnedOperation<CC, OC>(session: OwnedOperationSession, owner: OperationOwner, operation: HarnessOperation, callbacks: { "claude-code": () => CC; opencode: () => OC }): CC | OC {
  const descriptor = requireOwnedOperation(session, owner, operation);
  return dispatchHarness(descriptor.id, callbacks);
}
