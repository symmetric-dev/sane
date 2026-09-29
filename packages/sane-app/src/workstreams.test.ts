import { describe, expect, test } from "bun:test";
import { authenticatedWorkstreamRoute, WorkstreamAdapterError, validateWorkstreamInput, flushAndCloseWorkstreams } from "./workstreams";
import { DomainError } from "sane-core/server";

describe("candidate authenticated route boundary", () => {
  test("denial never parses or invokes the operation", async () => {
    let calls = 0;
    const denial = new Response("Forbidden", { status: 403 });
    const response = await authenticatedWorkstreamRoute(new Request("http://localhost/api/workstreams"), () => denial, () => { calls++; });
    expect(response).toBe(denial);
    expect(calls).toBe(0);
  });

  test("ambiguous targets retain the core conflict code", async () => {
    const response = await authenticatedWorkstreamRoute(new Request("http://localhost/api/workstreams/target"), () => null, () => {
      throw new DomainError("AMBIGUOUS_TARGET", "Supply a qualified target");
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Supply a qualified target", code: "AMBIGUOUS_TARGET" });
  });

  test("adapter identity conflicts remain explicit", async () => {
    const response = await authenticatedWorkstreamRoute(new Request("http://localhost/api/workstreams/context"), () => null, () => {
      throw new WorkstreamAdapterError(409, "app-checkout-mismatch", "Different checkout");
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("app-checkout-mismatch");
  });

  test("unexpected storage faults reach bridge handling", async () => {
    const fault = new Error("Storage failure");
    await expect(authenticatedWorkstreamRoute(new Request("http://localhost/api/workstreams"), () => null, () => { throw fault; })).rejects.toThrow("Storage failure");
  });
});

describe("workstream transport validation", () => {
  test("artifact reads require a path and writes are not an App operation", () => {
    for (const path of [undefined, null, false, 42, {}]) {
      expect(() => validateWorkstreamInput("artifacts/read", { id: "example", path })).toThrow("path");
    }
    expect(() => validateWorkstreamInput("artifacts/write", { id: "example", path: "note.md", content: "text" })).toThrow("Unknown workstream operation");
  });

  test("supplied target cannot become implicit selection through a falsey value", () => {
    for (const target of [undefined, null, false, 0, "", [], {}, { harness: "oc", nativeId: "ses_example" }]) {
      expect(() => validateWorkstreamInput("target", { id: "example", phase: "design", target })).toThrow("qualified target");
    }
    expect(() => validateWorkstreamInput("target", { id: "example", phase: "design" })).not.toThrow();
    expect(() => validateWorkstreamInput("target", { id: "example", phase: "design", target: { harness: "oc", authorityId: "scratch", nativeId: "ses_example" } })).not.toThrow();
  });

  test("missing nullable fields are not interpreted as explicit unassignment", () => {
    expect(() => validateWorkstreamInput("associate", { sessionId: "app" })).toThrow("workstreamId");
    expect(() => validateWorkstreamInput("default-checkout", { id: "example" })).toThrow("checkout");
    expect(() => validateWorkstreamInput("associate", { sessionId: "app", workstreamId: null })).not.toThrow();
  });

  test("path and phase policy is delegated to core", () => {
    expect(() => validateWorkstreamInput("artifacts/read", { id: "example", path: "../escape" })).not.toThrow();
    expect(() => validateWorkstreamInput("phase/assign", { sessionId: "app", phase: "invalid-domain-phase" })).not.toThrow();
  });
});

describe("domain shutdown", () => {
  test("failed catalog flush still closes core and retains ownership", async () => {
    const calls: string[] = [];
    await expect(flushAndCloseWorkstreams(async () => { calls.push("flush"); throw new Error("catalog failed"); }, () => { calls.push("close"); }, () => { calls.push("retain"); })).rejects.toThrow("catalog failed");
    expect(calls).toEqual(["flush", "retain", "close"]);
  });

  test("successful flush closes core without retaining ownership", async () => {
    const calls: string[] = [];
    await flushAndCloseWorkstreams(async () => { calls.push("flush"); }, () => { calls.push("close"); }, () => { calls.push("retain"); });
    expect(calls).toEqual(["flush", "close"]);
  });
});
