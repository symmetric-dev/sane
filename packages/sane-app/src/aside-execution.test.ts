import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ASIDE_EXECUTION_AVAILABILITY, type AsideRecord, type AsideSourceSnapshot } from "../shared/aside-contract";
import type { AsideContextProvider, AsideIndependentSessionReference, AsideNativeForkEvidenceReference, AsideReferenceSessionEvidenceReference } from "../shared/aside-execution-contract";
import type { Harness } from "../shared/conversation/types";
import { AsideExecutionService, type AsideExecutionPorts } from "./aside-execution";
import { createAsideExecutionRoute, matchesAsideExecutionRoute, type AsideExecutionRoutePorts } from "./aside-execution-routes";
import { capturedAt, createRequest, ids, sourceFixture, storeFixture } from "./aside-fixtures";
import { AsideError } from "./aside-store";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const asideId = "10000000-0000-4000-8000-000000000006";
const message = { requestId: "message-1", expectedRevision: 1, text: "Explain this" };
const executionURL = `http://localhost/api/asides/${asideId}/execution`;
const messagesURL = `http://localhost/api/asides/${asideId}/messages`;

function recordFixture(): AsideRecord {
  return { version: 1, id: asideId, source: sourceFixture(), purpose: "discussion", lifecycle: "open", draft: "Unsent draft",
    revision: 1, createdAt: capturedAt, updatedAt: capturedAt };
}

function fixture(overrides: Partial<AsideExecutionPorts> = {}) {
  const record = recordFixture();
  let current = true, reads = 0, assertions = 0;
  const ports: AsideExecutionPorts = {
    getAside: id => { expect(id).toBe(asideId); reads++; return record; },
    assertCurrent: id => {
      expect(id).toBe(asideId); assertions++;
      if (!current) throw new AsideError(401, "aside-owner-revoked", "Authentication revoked");
    },
    ...overrides,
  };
  const service = new AsideExecutionService(ports);
  return { record, ports, service, revoke: () => { current = false; }, counts: () => ({ reads, assertions }) };
}

function routeFixture(overrides: Partial<AsideExecutionRoutePorts> = {}) {
  const h = fixture();
  const route = createAsideExecutionRoute({ inspect: id => h.service.inspect(id), submit: (id, input) => h.service.submit(id, input),
    assertCurrent: () => h.ports.assertCurrent(asideId), ...overrides });
  const call = (url = executionURL, init?: RequestInit) => route(new Request(url, init), new URL(url));
  return { ...h, call };
}

describe("aside execution readiness boundary", () => {
  test("missing provider exposes only explicit unavailable status, not source or fake run identity", async () => {
    const h = fixture(), before = structuredClone(h.record);
    expect(await h.service.inspect(asideId)).toEqual(ASIDE_EXECUTION_AVAILABILITY);
    expect(h.counts()).toEqual({ reads: 1, assertions: 2 });
    expect(h.record).toEqual(before);
  });

  test("valid submission is rejected without mutating durable drafts or producing receipts", async () => {
    const { store, dir } = storeFixture(directories);
    const aside = store.create(ids.session, createRequest(), sourceFixture(), () => {});
    const before = readFileSync(join(dir, "asides.json"));
    const service = new AsideExecutionService({ getAside: id => store.get(id), assertCurrent: () => {} });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.submit(aside.id, message)).rejects.toMatchObject({ status: 409, code: "aside-context-unconfigured" });
    }
    expect(readFileSync(join(dir, "asides.json"))).toEqual(before);
    expect(store.get(aside.id)).toEqual(aside);
  });

  test("a provider object alone is not readiness or permission to prepare/native dispatch", async () => {
    let calls = 0;
    const provider: AsideContextProvider = {
      strategy: "native-fork",
      prepare: async () => { calls++; throw new Error("Preparation must not run in this slice"); },
    };
    const h = fixture({ contextProvider: provider });
    expect(await h.service.inspect(asideId)).toEqual(ASIDE_EXECUTION_AVAILABILITY);
    await expect(h.service.submit(asideId, message)).rejects.toMatchObject({ status: 409, code: "aside-context-unconfigured" });
    expect(calls).toBe(0);
  });

  for (const lifecycle of ["archived", "discarded"] as const) {
    test(`${lifecycle} remains historically readable with a distinct lifecycle conflict`, async () => {
      const h = fixture(); h.record.lifecycle = lifecycle; h.record.revision = 2;
      expect(await h.service.inspect(asideId)).toEqual({ available: false, code: `aside-${lifecycle}` });
      await expect(h.service.submit(asideId, { ...message, expectedRevision: 2 })).rejects.toMatchObject({ status: 409, code: `aside-${lifecycle}` });
    });
  }

  test("revision mismatch is not hidden behind context unavailability", async () => {
    const h = fixture(); h.record.revision = 2;
    await expect(h.service.submit(asideId, message)).rejects.toMatchObject({ status: 409, code: "aside-conflict" });
  });

  test("strict bounded message validation rejects malformed/empty input", async () => {
    const h = fixture();
    for (const input of [null, [], {}, { ...message, requestId: "" }, { ...message, expectedRevision: 0 },
      { ...message, expectedRevision: 1.5 }, { ...message, text: " \n\t" }, { ...message, text: "" },
      { ...message, text: "bad\0text" }, { ...message, text: "x".repeat(100001) }, { ...message, nativeSessionId: ids.session }]) {
      await expect(h.service.submit(asideId, input)).rejects.toMatchObject({ status: 400, code: "aside-input" });
    }
    expect(h.record.revision).toBe(1);
  });

  test("missing records do not manufacture an execution identity", async () => {
    const h = fixture({ getAside: () => undefined });
    await expect(h.service.inspect(asideId)).rejects.toMatchObject({ status: 404, code: "aside-missing" });
    await expect(h.service.submit(asideId, message)).rejects.toMatchObject({ status: 404, code: "aside-missing" });
  });

  test("authorization failure prevents even an aside read", async () => {
    const h = fixture(); h.revoke();
    await expect(h.service.inspect(asideId)).rejects.toMatchObject({ status: 401 });
    await expect(h.service.submit(asideId, message)).rejects.toMatchObject({ status: 401 });
    expect(h.counts().reads).toBe(0);
  });

  for (const fails of [false, true]) {
    for (const operation of ["inspect", "submit"] as const) {
      test(`${operation} revalidates ownership after ${fails ? "rejected" : "fulfilled"} record awaits`, async () => {
        const h = fixture({ getAside: async () => {
          await Promise.resolve(); h.revoke();
          if (fails) throw new Error("Private storage detail");
          return h.record;
        } });
        await expect(operation === "inspect" ? h.service.inspect(asideId) : h.service.submit(asideId, message))
          .rejects.toMatchObject({ status: 401, code: "aside-owner-revoked" });
      });
    }
  }
});

describe("aside execution HTTP routes", () => {
  test("GET returns explicit unavailability without fake provider/session/message metadata", async () => {
    const h = routeFixture();
    const response = (await h.call())!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ execution: ASIDE_EXECUTION_AVAILABILITY });
  });

  test("message POST returns 409 unavailability, never an acceptance receipt", async () => {
    const h = routeFixture();
    const response = (await h.call(messagesURL, { method: "POST", body: JSON.stringify(message) }))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Aside execution context is not configured", code: "aside-context-unconfigured", execution: ASIDE_EXECUTION_AVAILABILITY });
    expect(h.record).toEqual(recordFixture());
  });

  test("matches only the exact endpoints; no fictitious cancel/stream endpoint", async () => {
    const h = routeFixture();
    for (const url of [executionURL, messagesURL]) expect(matchesAsideExecutionRoute(new URL(url))).toBe(true);
    for (const action of ["cancel", "events", "execution/cancel", "messages/stream", ""]) {
      const url = `http://localhost/api/asides/${asideId}/${action}`;
      expect(matchesAsideExecutionRoute(new URL(url))).toBe(false);
      expect(await h.call(url)).toBeNull();
    }
    expect(h.counts().reads).toBe(0);
  });

  test("invalid UUID/encoding and query selectors fail before any record read", async () => {
    const h = routeFixture();
    for (const url of [executionURL.replace(asideId, "bad"), executionURL.replace(asideId, "%ZZ"), executionURL.replace(asideId, "%2F"), `${executionURL}?source=other`, `${messagesURL}?resume=true`]) {
      const response = (await h.call(url))!;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "aside-input" });
    }
    expect(h.counts().reads).toBe(0);
  });

  test("wrong methods return 405 with precise Allow, without reading or submitting", async () => {
    const h = routeFixture();
    for (const [url, method, allow] of [[executionURL, "POST", "GET"], [messagesURL, "GET", "POST"], [messagesURL, "DELETE", "POST"]]) {
      const response = (await h.call(url, { method }))!;
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow!);
      expect(await response.json()).toMatchObject({ code: "aside-method-not-allowed" });
    }
    expect(h.counts().reads).toBe(0);
  });

  test("malformed JSON and both advertised/streamed body limits are bounded", async () => {
    const h = routeFixture();
    for (const [body, headers, status] of [["{", {}, 400], ["{}", { "content-length": "1048577" }, 413], [" ".repeat(1048577), {}, 413]] as const) {
      const response = (await h.call(messagesURL, { method: "POST", body, headers }))!;
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code: "aside-input" });
    }
    expect(h.counts().reads).toBe(0);
  });

  test("permission guard runs before method/input checks", async () => {
    const h = routeFixture(); h.revoke();
    const response = (await h.call(`${executionURL}?unexpected=true`, { method: "DELETE" }))!;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "aside-owner-revoked" });
    expect(h.counts().reads).toBe(0);
  });

  test("revocation during body read prevents service submission", async () => {
    let submissions = 0;
    const h = routeFixture({ submit: async () => { submissions++; throw new Error("Must not submit"); } });
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      h.revoke(); controller.enqueue(new TextEncoder().encode(JSON.stringify(message))); controller.close();
    } });
    const response = (await h.call(messagesURL, { method: "POST", body: stream }))!;
    expect(response.status).toBe(401);
    expect(submissions).toBe(0);
  });

  for (const fails of [false, true]) {
    test(`route revalidates ${fails ? "failed" : "successful"} service await`, async () => {
      const h = routeFixture({ inspect: async () => {
        await Promise.resolve(); h.revoke();
        if (fails) throw new Error("Private provider data");
        return ASIDE_EXECUTION_AVAILABILITY;
      } });
      const response = (await h.call())!;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Authentication revoked", code: "aside-owner-revoked" });
    });
  }

  test("unknown errors stay coded and generic", async () => {
    const h = routeFixture({ inspect: async () => { throw new Error("Private native context path"); } });
    const response = (await h.call())!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Aside execution is temporarily unavailable", code: "asides-unavailable" });
  });
});

// Compile-time assertions for the parent's typecheck; not executable proofs or
// materialization fixtures. No test fabricates a qualified native fork receipt.
function contractQualification(snapshot: AsideSourceSnapshot, referenceEvidence: AsideReferenceSessionEvidenceReference, qualifiedSession: AsideIndependentSessionReference) {
  const supportedHarnesses: readonly AsideIndependentSessionReference["harnessId"][] = ["claude-code", "opencode", "grok"];
  const supportedHarness: Harness = qualifiedSession.harnessId;
  // @ts-expect-error Native source codes are not App dispatch Harness IDs.
  const nativeHarnessAsDispatch: AsideIndependentSessionReference["harnessId"] = snapshot.native.harness;
  // @ts-expect-error An App observation is not native fork evidence.
  const fromSnapshot: AsideNativeForkEvidenceReference = snapshot;
  // @ts-expect-error Structurally plausible client metadata lacks qualification.
  const fromJSON: AsideNativeForkEvidenceReference = { kind: "native-fork-evidence", referenceId: "untrusted" };
  // @ts-expect-error Reference delivery evidence cannot claim native fork lineage.
  const wrongStrategy: AsideNativeForkEvidenceReference = referenceEvidence;
  // @ts-expect-error Non-null source identity alone is not an independently qualified aside session.
  const sourceAsDestination: AsideIndependentSessionReference = { harnessId: "claude-code", sessionId: snapshot.sessionId, authorityId: snapshot.native.authorityId, nativeSessionId: snapshot.native.nativeId, cwd: snapshot.binding.cwd };
  // @ts-expect-error Qualified evidence references are immutable.
  referenceEvidence.referenceId = "changed";
  void [supportedHarnesses, supportedHarness, nativeHarnessAsDispatch, fromSnapshot, fromJSON, wrongStrategy, sourceAsDestination];
}
void contractQualification;
