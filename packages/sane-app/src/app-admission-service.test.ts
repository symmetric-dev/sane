import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appAdmissionPayloadSha256, decodeAppAdmissionEnvelope, decodeAppAdmissionIntent, type AppAdmissionEnvelope } from "../shared/conversation/app-admission-contract";
import { AppAdmissionService, assertAppAdmissionEligibility, initializeAppAdmissionService } from "./app-admission-service";
import { AppAdmissionRequestError, AppAdmissionStorageError } from "./app-admission-store";
import { WorkstreamAdapterError } from "./workstreams";

// Real private store IO only. No bridge boot, HTTP, native session, child or model.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(check: () => void) {
  const root = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/app-admission-service-test-"));
  roots.push(root);
  const storeId = crypto.randomUUID(), failures: AppAdmissionStorageError[] = [];
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt: "2026-10-27T00:00:00.000Z" }), { mode: 0o600 });
  let serial = Promise.resolve(), checks = 0;
  const enqueue = (work: () => Promise<void>) => {
    const next = serial.then(work);
    // Deliberately no queue failure latch: sticky failures below must come from
    // the real store, not from a test queue that refuses every later operation.
    serial = next.catch(() => {});
    return next;
  };
  const ports = { enqueue, assertStorage: () => {}, failClosed: (error: AppAdmissionStorageError) => { failures.push(error); } };
  await initializeAppAdmissionService(root, storeId, ports);
  const service = new AppAdmissionService(root, storeId, { ...ports, assertCanBegin: () => { checks++; check(); } });
  return { service, storeId, failures, enqueue, files: () => readdirSync(join(root, "app-admissions")).sort(), get checks() { return checks; } };
}

async function envelope(storeId: string) {
  const conversationId = crypto.randomUUID();
  const intent = decodeAppAdmissionIntent({ version: 1, operation: "message", conversationId,
    expectedSource: { harnessId: "claude-code", authorityId: `sane-native-v1:cc:${"a".repeat(64)}`, nativeSessionId: crypto.randomUUID(), cwd: "/offline/app-admission" },
    expectedLiveRunId: null, chainId: crypto.randomUUID(), payload: { sessionId: conversationId, prompt: "Offline intake", nativeStopped: false } });
  return decodeAppAdmissionEnvelope({ version: 1, storeId, clientRequestId: crypto.randomUUID(), payloadSha256: await appAdmissionPayloadSha256(intent), intent });
}
function keyOf({ storeId, clientRequestId, payloadSha256 }: AppAdmissionEnvelope) { return { storeId, clientRequestId, payloadSha256 }; }

describe("App admission intake eligibility classification", () => {
  for (const refusal of [
    { code: "session-retired", status: 409, requestCode: "target-conflict" },
    { code: "session-retirement-pending", status: 409, requestCode: "pending-admission" },
    { code: "startup-classifying", status: 503, requestCode: "pending-admission" },
  ] as const) test(`${refusal.code} refuses before intent without poisoning unrelated intake`, async () => {
    const error = new WorkstreamAdapterError(refusal.status, refusal.code, `Expected ${refusal.code} refusal`);
    let blocked = true;
    const f = await fixture(() => assertAppAdmissionEligibility(() => { if (blocked) throw error; }));
    const original = await envelope(f.storeId), refusing = f.service.begin(original, () => {});
    await expect(refusing).rejects.toBeInstanceOf(AppAdmissionRequestError);
    await expect(refusing).rejects.toMatchObject({ status: 409, code: refusal.requestCode, message: error.message });
    expect(f.checks).toBe(1); expect(f.failures).toEqual([]);
    expect(f.files()).toEqual(["store.json"]); expect(f.service.readPending()).toEqual([]);
    expect(f.service.lookup(keyOf(original))).toEqual({ kind: "absent", key: keyOf(original) });

    blocked = false;
    const other = await envelope(f.storeId), admitted = await f.service.begin(other, () => {});
    expect(admitted).toMatchObject({ kind: "created", intent: other, binding: { version: 1, kind: "existing", conversationId: other.intent.conversationId },
      receipt: { version: 1, ...keyOf(other), state: "pending", target: null, rejection: null } });
    expect(f.checks).toBe(2); expect(f.failures).toEqual([]);
    expect(f.files()).toEqual([`${other.clientRequestId}.pending.json`, "store.json"]);
    expect(f.service.lookup(keyOf(original))).toEqual({ kind: "absent", key: keyOf(original) });
  });

  test("shutdown after queuing intake is an expected refusal and does not fence the queue", async () => {
    let closing = false;
    const f = await fixture(() => assertAppAdmissionEligibility(() => {
      if (closing) throw new WorkstreamAdapterError(503, "startup-classifying", "Startup execution classification is incomplete; no mutation was admitted");
    }));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holding = f.enqueue(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const original = await envelope(f.storeId);
    const refusing = f.service.begin(original, () => {}).then(() => { throw new Error("Queued shutdown intake unexpectedly succeeded"); }, error => error);
    try { expect(f.checks).toBe(0); expect(f.files()).toEqual(["store.json"]); closing = true; }
    finally { release.resolve(); }
    await holding;
    const rejection = await refusing;
    expect(rejection).toBeInstanceOf(AppAdmissionRequestError);
    expect(rejection).toMatchObject({ status: 409, code: "pending-admission", message: "Startup execution classification is incomplete; no mutation was admitted" });
    expect(f.checks).toBe(1); expect(f.failures).toEqual([]);
    expect(f.files()).toEqual(["store.json"]); expect(f.service.readPending()).toEqual([]);
    expect(f.service.lookup(keyOf(original))).toEqual({ kind: "absent", key: keyOf(original) });

    closing = false;
    const other = await envelope(f.storeId);
    expect(await f.service.begin(other, () => {})).toMatchObject({ kind: "created", intent: other });
    expect(f.checks).toBe(2); expect(f.failures).toEqual([]);
    expect(f.files()).toEqual([`${other.clientRequestId}.pending.json`, "store.json"]);
  });

  for (const failure of [
    { name: "unknown invariant error", create: () => new Error("Unexpected intake invariant failure") },
    { name: "unrecognized workstream error", create: () => new WorkstreamAdapterError(503, "storage-unavailable", "Storage ownership is unavailable") },
    { name: "actual storage corruption", create: () => new AppAdmissionStorageError("corrupt", "Pinned metadata changed") },
  ]) test(`${failure.name} still fails closed and remains sticky`, async () => {
    const error = failure.create();
    // Eligibility translation must pass every non-allowlisted failure unchanged.
    expect(() => assertAppAdmissionEligibility(() => { throw error; })).toThrow(error);
    let broken = true;
    const f = await fixture(() => assertAppAdmissionEligibility(() => { if (broken) throw error; }));
    const original = await envelope(f.storeId);
    const fatal = await f.service.begin(original, () => {}).then(() => { throw new Error("Unsafe intake unexpectedly succeeded"); }, error => error);
    expect(fatal).toBeInstanceOf(AppAdmissionStorageError);
    if (error instanceof AppAdmissionStorageError) expect(fatal).toBe(error);
    else expect(fatal.cause).toBe(error);
    expect(f.failures).toEqual([fatal]); expect(f.checks).toBe(1); expect(f.files()).toEqual(["store.json"]);
    broken = false;
    await expect(f.service.begin(await envelope(f.storeId), () => {})).rejects.toBe(fatal);
    expect(f.failures).toEqual([fatal]); expect(f.checks).toBe(1); expect(f.files()).toEqual(["store.json"]);
  });

  test("the same retired refusal is request-scoped only at the explicit intake wrapper", async () => {
    const error = new WorkstreamAdapterError(409, "session-retired", "Conversation is retired from the active catalog");
    const f = await fixture(() => { throw error; });
    const fatal = await f.service.begin(await envelope(f.storeId), () => {}).then(() => { throw new Error("Unwrapped refusal unexpectedly succeeded"); }, error => error);
    expect(fatal).toBeInstanceOf(AppAdmissionStorageError); expect(fatal.cause).toBe(error);
    expect(f.failures).toEqual([fatal]); expect(f.files()).toEqual(["store.json"]);
    await expect(f.service.begin(await envelope(f.storeId), () => {})).rejects.toBe(fatal);
    expect(f.failures).toEqual([fatal]); expect(f.checks).toBe(1);

    const wrapped = await fixture(() => assertAppAdmissionEligibility(() => { throw error; }));
    const refusing = wrapped.service.begin(await envelope(wrapped.storeId), () => {});
    await expect(refusing).rejects.toBeInstanceOf(AppAdmissionRequestError);
    await expect(refusing).rejects.toMatchObject({ status: 409, code: "target-conflict", message: error.message });
    expect(wrapped.failures).toEqual([]); expect(wrapped.files()).toEqual(["store.json"]);
  });
});
