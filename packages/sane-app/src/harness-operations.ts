import { getHarnessDescriptor, isHarness, type Harness, type HarnessDescriptor, type HarnessOperation } from "../shared/conversation/harness-capabilities";

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

export function requireOwnedOperation(session: { sessionId: string; harness: unknown }, owner: { run: { sessionId: string }; native?: boolean }, operation: HarnessOperation): HarnessDescriptor {
  const descriptor = requireOperation(session.harness, operation);
  // `native` remains private transport state for native monitors and teardown;
  // it must agree with the admitted session, never select an execution fallback.
  if (owner.run.sessionId !== session.sessionId || owner.native !== (descriptor.nativeHarness === "oc")) {
    throw new HarnessOperationError("Run owner harness or conversation differs from its session", 409, "owner-harness-mismatch");
  }
  return descriptor;
}

export function dispatchOwnedOperation<CC, OC>(session: { sessionId: string; harness: unknown }, owner: { run: { sessionId: string }; native?: boolean }, operation: HarnessOperation, callbacks: { "claude-code": () => CC; opencode: () => OC }): CC | OC {
  const descriptor = requireOwnedOperation(session, owner, operation);
  return dispatchHarness(descriptor.id, callbacks);
}
