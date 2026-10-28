import { describe, expect, test } from "bun:test";
import type { Admission } from "./app-store";
import { createExecutionPreparationService, type ExecutionPreparationDependencies } from "./execution-preparation-service";
import type { Session } from "./history";

const sessionId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const worktreeId = "10000000-0000-4000-8000-000000000003";
const bindingRevision = "10000000-0000-4000-8000-000000000004";
const cwd = "/offline/canonical-execution";
const revision = "b".repeat(64);

function identity(descriptor: "cc" | "oc") {
  const nativeId = descriptor === "cc" ? sessionId : "ses_canonical";
  const authorityId = `sane-native-v1:${descriptor}:${"a".repeat(64)}`;
  return { nativeId, authorityId };
}

function admission(descriptor: "cc" | "oc"): Admission {
  const { nativeId, authorityId } = identity(descriptor);
  return {
    version: 1, requestId: sessionId, sessionId, operation: "create", state: "ready",
    source: { authorityId, descriptor: descriptor === "cc"
      ? { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/offline/profile" }
      : { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/offline/service.json" } },
    binding: { workspaceId, worktreeId, bindingRevision, executionCheckout: cwd, checkoutPin: null, domain: { mode: "app-only" } },
    parent: null, nativeId, createdAt: "2026-10-27T00:00:00.000Z", error: null,
  };
}

function session(harness: Session["harness"] | "grok" | undefined, descriptor: "cc" | "oc"): Session {
  const { nativeId, authorityId } = identity(descriptor);
  return {
    sessionId, nativeSessionId: nativeId, authorityId, cwd, lastStatus: "unknown", lastRunId: null,
    saneExecution: { schema: 1, revision },
    ...(harness === undefined ? {} : { harness: harness as Session["harness"] }),
  };
}

function prepare(current: Session, ready: Admission) {
  let executionContextCalls = 0;
  const unused = async () => { throw new Error("Canonical harness check must not touch stores"); };
  const dependencies: ExecutionPreparationDependencies = {
    dataDir: "/offline/unused",
    executionPackages: { create: unused, load: unused },
    contextPackages: { create: unused, load: unused },
    getSession: () => current,
    getAdmission: () => ready,
    executionContext: async () => { executionContextCalls += 1; throw new Error("executionContext must not run"); },
  };
  return { service: createExecutionPreparationService(dependencies), calls: () => executionContextCalls };
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); }
  catch (error) { return error; }
  return undefined;
}

describe("canonical execution harness binding", () => {
  test("claude-code with cc passes the harness clause and stops at paired context", async () => {
    const { service, calls } = prepare(session("claude-code", "cc"), admission("cc"));
    const error = await errorOf(() => service.canonicalExecution(sessionId));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Canonical execution requires paired context");
    expect(calls()).toBe(0);
  });

  test("opencode with oc passes the harness clause and stops at paired context", async () => {
    const { service, calls } = prepare(session("opencode", "oc"), admission("oc"));
    const error = await errorOf(() => service.canonicalExecution(sessionId));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Canonical execution requires paired context");
    expect(calls()).toBe(0);
  });

  test("opencode with cc still requires an exact ready admission", async () => {
    const { service, calls } = prepare(session("opencode", "cc"), admission("cc"));
    const error = await errorOf(() => service.canonicalExecution(sessionId));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Canonical execution requires an exact ready admission");
    expect(calls()).toBe(0);
  });

  test("unknown session harness grok does not fall through to cc", async () => {
    const { service, calls } = prepare(session("grok", "cc"), admission("cc"));
    const error = await errorOf(() => service.canonicalExecution(sessionId));
    expect(calls()).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toBe("Canonical execution requires paired context");
    expect(error instanceof TypeError
      ? error.message === "Unknown session harness" || error.message === "Unknown native harness"
      : (error as Error).message === "Canonical execution requires an exact ready admission").toBe(true);
  });

  test("omitted session harness does not match cc", async () => {
    const { service, calls } = prepare(session(undefined, "cc"), admission("cc"));
    const error = await errorOf(() => service.canonicalExecution(sessionId));
    expect(calls()).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toBe("Canonical execution requires paired context");
    expect(error instanceof TypeError
      ? error.message === "Unknown session harness" || error.message === "Unknown native harness"
      : (error as Error).message === "Canonical execution requires an exact ready admission").toBe(true);
  });
});
