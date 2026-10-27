import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validNativeAuthorityId, validPinnedAuthorityId } from "sane-core/native-source-contract";
import { decodeAppAdmissionTarget, AppAdmissionCodecError } from "../shared/conversation/app-admission-contract.ts";
import { resolveAppConfig } from "./app-config";
import { assertQualifiedReference, grokSourceRecord, resolveSources, validateStoredSources } from "./app-sources";
import { AppStoreError, initializeAppStore, publishGrokSourcePin, validateAdmissions, validateAppStore } from "./app-store";
import { isNativeHarness, toSessionHarness } from "./harness-names";
import { validateStoredMetadata } from "./history";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roots: string[] = [];
afterEach(() => {
  // Only directories created by this file are ever removed.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-storage-")));
  roots.push(root);
  return root;
}
function snapshot(dir: string) {
  const listing = readdirSync(dir, { recursive: true }).map(entry => String(entry)).sort();
  const bytes: Record<string, string> = {};
  for (const name of listing) {
    const path = join(dir, name);
    if (statSync(path).isFile()) bytes[name] = readFileSync(path).toString("hex");
  }
  return { listing, bytes };
}
/** Profile stays outside the store: initialize refuses a non-empty data directory. */
function v1Store() {
  const root = tempRoot();
  const profileRoot = join(root, "cc");
  mkdirSync(profileRoot);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const registrationFile = join(root, "registration.json");
  initializeAppStore(dataDir, {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile },
  });
  return { root, dataDir, profileRoot, registrationFile };
}
function caught(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected operation to refuse");
}

describe("grok storage does not widen v1", () => {
  test("a v1 app store loads without rewrite and a missing gk pin does not block startup", () => {
    const { root, dataDir, registrationFile } = v1Store();
    const before = snapshot(dataDir);
    const opened = validateAppStore(dataDir);
    expect(snapshot(dataDir)).toEqual(before);
    expect(readdirSync(root).includes("registration.json")).toBe(false);
    expect(registrationFile).toBe(join(root, "registration.json"));
    expect(opened.sources.version).toBe(1);
    expect(Object.hasOwn(opened.sources, "gk")).toBe(false);
    expect(opened.admissions.version).toBe(1);
    expect(opened.metadata.sessions.some(session => session.harness === "grok")).toBe(false);
    const metadataFile = JSON.parse(readFileSync(join(dataDir, "metadata.json"), "utf8"));
    expect(metadataFile.version).toBe(1);
    expect(metadataFile.sessions).toEqual([]);

    const sessionId = "12345678-1234-4234-8234-123456789abc";
    const nativeSessionId = "12345678-1234-4234-8234-123456789abd";
    const minimal = {
      version: 1,
      sessions: [{
        sessionId,
        harness: "claude-code",
        nativeSessionId,
        authorityId: `sane-native-v1:cc:${"a".repeat(64)}`,
        cwd: root,
        lastRunId: null,
        lastStatus: "unknown",
      }],
      runs: [],
      reconciliationRequired: false,
    };
    const beforeFields = JSON.stringify(minimal);
    expect(validateStoredMetadata(minimal)).toBe(minimal);
    expect(JSON.stringify(minimal)).toBe(beforeFields);
    expect(Object.keys(minimal)).toEqual(["version", "sessions", "runs", "reconciliationRequired"]);
    expect(Object.keys(minimal.sessions[0]!)).toEqual(["sessionId", "harness", "nativeSessionId", "authorityId", "cwd", "lastRunId", "lastStatus"]);
    expect(minimal.sessions[0]).toMatchObject({
      harness: "claude-code",
      nativeSessionId,
      authorityId: `sane-native-v1:cc:${"a".repeat(64)}`,
      cwd: root,
      lastRunId: null,
      lastStatus: "unknown",
    });
    expect(minimal.runs).toEqual([]);
    expect(minimal.reconciliationRequired).toBe(false);

    const configPath = join(root, "config.json");
    const configText = JSON.stringify({ format: "sane-app-config", version: 1 });
    writeFileSync(configPath, configText);
    const resolved = resolveAppConfig(["--config", configPath], { packageDir: root, invocationCwd: root, env: {}, home: root });
    expect(readFileSync(configPath, "utf8")).toBe(configText);
    expect(resolved.config.native.grok).toBeUndefined();
    expect(Object.hasOwn(resolved.config.native, "grok")).toBe(false);
    expect(resolved.sources.claude).toBeDefined();
    expect(resolved.sources.opencode).toBeDefined();
  });

  test("authorityId null is unresolved, not unconfigured", () => {
    const root = tempRoot();
    const profileRoot = join(root, "cc");
    mkdirSync(profileRoot);
    const registrationFile = join(root, "registration.json");
    const v1 = resolveSources({
      cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile },
    });
    expect(validateStoredSources(v1)).toBe(v1);
    expect(v1.version).toBe(1);
    expect(Object.hasOwn(v1, "gk")).toBe(false);

    const missing = join(root, "missing-grok-home");
    const unresolved = grokSourceRecord(missing);
    expect(unresolved.authorityId).toBeNull();
    expect(unresolved.descriptor).toEqual({ version: 1, harness: "gk", kind: "local-home", homeRoot: missing });
    const stored = { version: 2 as const, cc: v1.cc, oc: v1.oc, gk: unresolved };
    expect(validateStoredSources(stored)).toBe(stored);
    expect(Object.hasOwn(stored, "gk")).toBe(true);
    expect(stored.gk.authorityId).toBeNull();
    expect(stored.gk).toBe(unresolved);

    const home = join(root, "grok-home");
    mkdirSync(home);
    const pinned = grokSourceRecord(home);
    expect(pinned.authorityId).toMatch(/^sane-native-v1:gk:[a-f0-9]{64}$/);
    const otherProfile = join(root, "other-cc");
    mkdirSync(otherProfile);
    const other = resolveSources({
      cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: otherProfile },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile },
    });
    expect(other.cc.authorityId).toMatch(/^sane-native-v1:cc:[a-f0-9]{64}$/);
    expect(pinned.authorityId).not.toBe(other.cc.authorityId);
  });

  test("publishGrokSourcePin adds only version 2 and gk", () => {
    const { root, dataDir } = v1Store();
    const sourcePath = join(dataDir, "sources.json");
    const before = JSON.parse(readFileSync(sourcePath, "utf8"));
    const ccDescriptor = JSON.stringify(before.cc.descriptor);
    const ocDescriptor = JSON.stringify(before.oc.descriptor);
    const home = join(root, "grok-home");
    mkdirSync(home);
    const beforeSnapshot = snapshot(dataDir);
    publishGrokSourcePin(dataDir, home);
    const after = JSON.parse(readFileSync(sourcePath, "utf8"));
    expect(before.version).toBe(1);
    expect(Object.hasOwn(before, "gk")).toBe(false);
    expect(JSON.stringify(after.cc.descriptor)).toBe(ccDescriptor);
    expect(JSON.stringify(after.oc.descriptor)).toBe(ocDescriptor);
    expect(after.cc).toEqual(before.cc);
    expect(after.oc).toEqual(before.oc);
    expect(after.version).toBe(2);
    expect(Object.hasOwn(after, "gk")).toBe(true);
    expect(Object.keys(after).sort()).toEqual(["cc", "gk", "oc", "version"]);
    const afterSnapshot = snapshot(dataDir);
    expect(afterSnapshot.listing.filter(name => name !== "sources.json")).toEqual(beforeSnapshot.listing.filter(name => name !== "sources.json"));
    const { "sources.json": _published, ...unchanged } = afterSnapshot.bytes;
    const { "sources.json": _original, ...originalRest } = beforeSnapshot.bytes;
    expect(unchanged).toEqual(originalRest);
  });

  test("receipt v1 rejects a Grok session UUID and msg_0 as message identity", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const nativeSessionId = "22222222-2222-4222-8222-222222222222";
    const runId = "33333333-3333-4333-8333-333333333333";
    const nativeMessageId = "44444444-4444-4444-8444-444444444444";
    const grokSessionId = "55555555-5555-4555-8555-555555555555";
    for (const id of [sessionId, nativeSessionId, runId, nativeMessageId, grokSessionId]) expect(id).toMatch(UUID);
    const target = {
      kind: "run-initial",
      dispatch: {
        source: {
          harnessId: "claude-code",
          sessionId,
          authorityId: `sane-native-v1:cc:${"ab".repeat(32)}`,
          nativeSessionId,
          cwd: "/offline/receipt",
        },
        runId,
        nativeCommandId: null as string | null,
      },
      messageId: `${runId}:user`,
      nativeMessageId,
    };
    const decoded = decodeAppAdmissionTarget(target);
    expect(decoded.kind).toBe("run-initial");
    expect(decoded.dispatch.source).toEqual({
      harnessId: "claude-code", sessionId, authorityId: `sane-native-v1:cc:${"ab".repeat(32)}`, nativeSessionId, cwd: "/offline/receipt",
    });
    expect(decoded.dispatch.runId).toBe(runId);
    expect(decoded.dispatch.nativeCommandId).toBeNull();
    expect(decoded.messageId).toBe(`${runId}:user`);
    expect(decoded.nativeMessageId).toBe(nativeMessageId);

    const grok = structuredClone(target);
    grok.dispatch.source.harnessId = "grok";
    grok.dispatch.source.authorityId = `sane-native-v1:gk:${"ab".repeat(32)}`;
    grok.messageId = grokSessionId;
    grok.nativeMessageId = grokSessionId;
    expect(caught(() => decodeAppAdmissionTarget(grok))).toBeInstanceOf(AppAdmissionCodecError);

    const nativeOnly = structuredClone(target);
    nativeOnly.nativeMessageId = "msg_0";
    expect(caught(() => decodeAppAdmissionTarget(nativeOnly))).toBeInstanceOf(AppAdmissionCodecError);
    const both = structuredClone(target);
    both.messageId = "msg_0";
    both.nativeMessageId = "msg_0";
    expect(caught(() => decodeAppAdmissionTarget(both))).toBeInstanceOf(AppAdmissionCodecError);
  });

  test("gk is not looked up as Claude", () => {
    const gkId = `sane-native-v1:gk:${"ab".repeat(32)}`;
    expect(isNativeHarness("gk")).toBe(false);
    let sessionHarness: unknown = "not-called";
    let conversion: unknown;
    try { sessionHarness = toSessionHarness("gk" as "cc"); }
    catch (error) { conversion = error; }
    expect(sessionHarness).not.toBe("claude-code");
    expect(conversion).toBeInstanceOf(TypeError);
    expect((conversion as Error).message).toBe("Unknown native harness");
    expect((conversion as Error).message.toLowerCase()).not.toContain("claude");
    expect(validNativeAuthorityId("cc", gkId)).toBe(false);
    expect(validNativeAuthorityId("gk", gkId)).toBe(false);
    expect(validPinnedAuthorityId("gk", gkId)).toBe(true);

    const nativeId = "12345678-1234-4234-8234-123456789abc";
    const ref = { harness: "gk" as const, authorityId: gkId, nativeId };
    let returned: unknown = "threw";
    try { returned = assertQualifiedReference(ref); }
    catch (error) { expect(error).toBeInstanceOf(AppStoreError); }
    expect(returned).toBe("threw");
    expect(returned).not.toEqual(expect.objectContaining({ harness: "cc" }));
    expect(ref).toEqual({ harness: "gk", authorityId: gkId, nativeId });

    const base = {
      version: 1 as const,
      requestId: "12345678-1234-4234-8234-123456789abc",
      sessionId: "12345678-1234-4234-8234-123456789abd",
      operation: "create" as const,
      state: "intent" as const,
      binding: {
        workspaceId: "12345678-1234-4234-8234-123456789abe",
        worktreeId: "12345678-1234-4234-8234-123456789abf",
        bindingRevision: "12345678-1234-4234-8234-123456789ac0",
        executionCheckout: "/offline/checkout",
        checkoutPin: null,
        domain: { mode: "app-only" as const },
      },
      parent: null,
      nativeId: null,
      createdAt: "2026-10-27T00:00:00.000Z",
      error: null,
    };
    const gkFile = { version: 1 as const, admissions: [{ ...base, source: { descriptor: { version: 1, harness: "gk", kind: "local-home", homeRoot: "/offline/grok-home" }, authorityId: gkId } }] };
    expect(caught(() => validateAdmissions(gkFile))).toBeInstanceOf(AppStoreError);
    expect(gkFile.admissions[0]!.source.descriptor.harness).toBe("gk");
    const ccFile = {
      version: 1 as const,
      admissions: [{ ...base, source: { descriptor: { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/offline/claude-profile" }, authorityId: `sane-native-v1:cc:${"ab".repeat(32)}` } }],
    };
    expect(validateAdmissions(ccFile)).toBe(ccFile);
    expect(ccFile.admissions[0]!.source.descriptor.harness).toBe("cc");
  });
});
