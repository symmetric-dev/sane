import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationRef, Harness, NativeSourceDescriptor } from "sane-core/contracts";
import { DomainError } from "sane-core/server";
import * as sources from "./app-sources";
import type { SourceConfiguration, SourceRecord, SourceRecords } from "./app-sources";
import * as store from "./app-store";
import type { Admission, SourceConfiguration as PublicConfiguration, SourceRecord as PublicRecord, SourceRecords as PublicRecords } from "./app-store";
import { AppStoreError, exact } from "./app-store-format";

// Compile-time checks accompany the runtime reexport-identity checks. Do not
// replace the real core normalizer: these fixtures exercise its filesystem rules.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Check<T extends true> = T;
type PublicCompatibility = [
  Check<Equal<PublicConfiguration, SourceConfiguration>>,
  Check<Equal<PublicRecord, SourceRecord>>,
  Check<Equal<PublicRecords, SourceRecords>>,
  Check<Equal<SourceConfiguration, { cc: NativeSourceDescriptor; oc: NativeSourceDescriptor }>>,
  Check<Equal<SourceRecord, { descriptor: NativeSourceDescriptor; authorityId: string | null }>>,
  Check<Equal<SourceRecords, { version: 1; cc: SourceRecord; oc: SourceRecord }>>,
  Check<Equal<typeof store.validateSources, (value: unknown) => SourceRecords>>,
  Check<Equal<typeof store.resolveSources, (config: SourceConfiguration) => SourceRecords>>,
  Check<Equal<typeof store.assertSourceConfiguration, (stored: SourceRecords, config: SourceConfiguration) => void>>,
];
const publicCompatibility: PublicCompatibility = [true, true, true, true, true, true, true, true, true];

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => {
  // Only directories created by this file are ever removed.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const authority = (harness: Harness, hash = "a".repeat(64)) => `sane-native-v1:${harness}:${hash}`;
function configuration(root: string): SourceConfiguration {
  return {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: join(root, "cc") },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "registration.json") },
  };
}
function records(): SourceRecords {
  const config = configuration(join(TEMP, "unavailable-app-sources-fixture"));
  return { version: 1, cc: { descriptor: config.cc, authorityId: authority("cc") }, oc: { descriptor: config.oc, authorityId: authority("oc") } };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(TEMP, "app-sources-test-")));
  roots.push(root);
  mkdirSync(join(root, "cc"));
  return { root, config: configuration(root) };
}
function caught(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected operation to refuse");
}
function corrupt(work: () => unknown) {
  const error = caught(work);
  expect(error).toBeInstanceOf(AppStoreError);
  expect(error).toBeInstanceOf(store.AppStoreError);
  expect(error).toMatchObject({ code: "APP_STORE_CORRUPT" });
}
function mismatch(stored: SourceRecords, config: SourceConfiguration, harness: Harness) {
  const before = JSON.stringify(stored);
  const error = caught(() => sources.assertSourceConfiguration(stored, config));
  expect(error).toBeInstanceOf(store.AppStoreError);
  expect(error).toMatchObject({ code: "APP_SOURCE_MISMATCH", message: `Configured ${harness} source differs from the App store pin` });
  expect(JSON.stringify(stored)).toBe(before);
}

describe("extracted App source public contract", () => {
  test("public functions and error constructor are the same exports, not wrappers or duplicate classes", () => {
    expect(publicCompatibility).toEqual([true, true, true, true, true, true, true, true, true]);
    expect(store.validateSources).toBe(sources.validateSources);
    expect(store.resolveSources).toBe(sources.resolveSources);
    expect(store.assertSourceConfiguration).toBe(sources.assertSourceConfiguration);
    expect(store.AppStoreError).toBe(AppStoreError);
    expect(store.exact).toBe(exact);
    expect(new AppStoreError("APP_SOURCE_MISMATCH", "pin")).toBeInstanceOf(store.AppStoreError);
    expect(new store.AppStoreError("APP_STORE_CORRUPT", "shape")).toBeInstanceOf(AppStoreError);
    expect(Object.keys(sources).sort()).toEqual(["assertQualifiedReference", "assertSourceConfiguration", "assertSourceDescriptor", "resolveSources", "validateSources"]);
    expect(Object.keys(store).sort()).toEqual([
      "AppStoreError", "assertSourceConfiguration", "atomicAppRecord", "atomicNativeHistory", "exact", "initializeAppStore",
      "loadAgentProfiles", "resolveSources", "validateAdmissions", "validateAgentProfiles", "validateAppStore", "validateSources",
    ]);
  });

  test("extracted dependencies point downward, without a source/format/store import cycle", () => {
    const sourceModule = readFileSync(new URL("./app-sources.ts", import.meta.url), "utf8");
    const formatModule = readFileSync(new URL("./app-store-format.ts", import.meta.url), "utf8");
    expect(sourceModule).not.toMatch(/from\s+["']\.\/app-store["']/);
    expect(formatModule).not.toMatch(/from\s+["']\.\/(?:app-store|app-sources)["']/);
  });
});

describe("sources.json v1 strict, noncreating validation", () => {
  for (const [name, change] of [
    ["missing cc", (v: any) => { delete v.cc; }],
    ["missing oc", (v: any) => { delete v.oc; }],
    ["missing version", (v: any) => { delete v.version; }],
    ["unsupported version", (v: any) => { v.version = 2; }],
    ["string version", (v: any) => { v.version = "1"; }],
    ["extra top-level field", (v: any) => { v.extra = true; }],
    ["third harness", (v: any) => { v.third = v.cc; }],
    ["extra record field", (v: any) => { v.cc.extra = true; }],
    ["missing descriptor", (v: any) => { delete v.cc.descriptor; }],
    ["missing authority", (v: any) => { delete v.oc.authorityId; }],
    ["array record", (v: any) => { v.oc = []; }],
  ] as const) test(`refuses ${name}`, () => {
    const value = records(); change(value);
    corrupt(() => sources.validateSources(value));
  });

  for (const value of [null, [], "sources", 1]) test(`refuses non-record ${JSON.stringify(value)}`, () => {
    corrupt(() => sources.validateSources(value));
  });

  for (const harness of ["cc", "oc"] as const) {
    test(`${harness}: accepts a null authority without changing the record`, () => {
      const value = records(); value[harness].authorityId = null;
      expect(sources.validateSources(value)).toBe(value);
      expect(value[harness].authorityId).toBeNull();
    });
    for (const [name, id] of [
      ["wrong harness namespace", authority(harness === "cc" ? "oc" : "cc")],
      ["wrong format namespace", `sane-native-v2:${harness}:${"a".repeat(64)}`],
      ["short hash", authority(harness, "a".repeat(63))],
      ["long hash", authority(harness, "a".repeat(65))],
      ["uppercase hash", authority(harness, "A".repeat(64))],
      ["nonhex hash", authority(harness, "g".repeat(64))],
      ["NUL hash", `${authority(harness)}\0`],
      ["nonstring authority", 123],
    ] as const) test(`${harness}: refuses ${name}`, () => {
      const value = records(); (value[harness] as any).authorityId = id;
      corrupt(() => sources.validateSources(value));
    });
  }

  test("returns original objects, insertion order and unavailable paths without normalizing or writing", () => {
    const { root } = fixture();
    const cc: Extract<NativeSourceDescriptor, { harness: "cc" }> = { profileRoot: `${root}/absent/../still-absent`, kind: "local-profile", harness: "cc", version: 1 };
    const oc: Extract<NativeSourceDescriptor, { harness: "oc" }> = { registrationFile: `${root}/missing/./registration.json`, kind: "local-registration", harness: "oc", version: 1 };
    const value: SourceRecords = { oc: { authorityId: null, descriptor: oc }, version: 1, cc: { authorityId: authority("cc"), descriptor: cc } };
    const bytes = JSON.stringify(value);
    writeFileSync(join(root, "sources.json"), bytes);
    const files = readdirSync(root, { recursive: true }).sort();
    expect(sources.validateSources(value)).toBe(value);
    expect(value.cc.descriptor).toBe(cc); expect(value.oc.descriptor).toBe(oc);
    expect(JSON.stringify(value)).toBe(bytes);
    expect(Object.keys(value)).toEqual(["oc", "version", "cc"]);
    expect(Object.keys(value.cc)).toEqual(["authorityId", "descriptor"]);
    expect(Object.keys(cc)).toEqual(["profileRoot", "kind", "harness", "version"]);
    expect(readFileSync(join(root, "sources.json"), "utf8")).toBe(bytes);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(files);
  });
});

describe("strict source descriptors", () => {
  for (const harness of ["cc", "oc"] as const) {
    const locator = harness === "cc" ? "profileRoot" : "registrationFile";
    for (const [name, change] of [
      ["extra field", (d: any) => { d.extra = true; }],
      ["other locator field", (d: any) => { d[harness === "cc" ? "registrationFile" : "profileRoot"] = TEMP; }],
      ["missing locator", (d: any) => { delete d[locator]; }],
      ["wrong version", (d: any) => { d.version = 2; }],
      ["wrong harness", (d: any) => { d.harness = harness === "cc" ? "oc" : "cc"; }],
      ["wrong kind", (d: any) => { d.kind = harness === "cc" ? "local-registration" : "local-profile"; }],
      ["relative locator", (d: any) => { d[locator] = "relative/source"; }],
      ["empty locator", (d: any) => { d[locator] = ""; }],
      ["NUL locator", (d: any) => { d[locator] = `${TEMP}/bad\0source`; }],
      ["nonstring locator", (d: any) => { d[locator] = 42; }],
    ] as const) test(`${harness}: refuses ${name} in validation and resolution`, () => {
      const value = records(); change(value[harness].descriptor);
      corrupt(() => sources.validateSources(value));
      corrupt(() => sources.resolveSources({ cc: value.cc.descriptor, oc: value.oc.descriptor }));
    });
  }
  test("unsupported source harness refuses as App corruption, not an accidental property lookup", () => {
    corrupt(() => sources.assertSourceDescriptor({ version: 1, harness: "third", kind: "local-profile", profileRoot: TEMP }, "third" as Harness));
  });
});

describe("source resolution uses real canonical source rules", () => {
  test("canonicalizes parent aliases and dot paths, allows a missing OC leaf, and preserves serialized key/hash order", () => {
    const { root } = fixture();
    symlinkSync(root, join(root, "alias"), "dir");
    const config: SourceConfiguration = {
      cc: { profileRoot: `${root}/alias/./cc`, kind: "local-profile", harness: "cc", version: 1 },
      oc: { registrationFile: `${root}/alias/./registration.json`, kind: "local-registration", harness: "oc", version: 1 },
    };
    const before = JSON.stringify(config), files = readdirSync(root).sort();
    const result = sources.resolveSources(config);
    const canonical = configuration(root);
    expect(Object.keys(result)).toEqual(["version", "cc", "oc"]);
    for (const harness of ["cc", "oc"] as const) {
      const descriptor = canonical[harness];
      const descriptorBytes = JSON.stringify(descriptor);
      const authorityId = authority(harness, createHash("sha256").update(descriptorBytes, "utf8").digest("hex"));
      expect(result[harness]).toEqual({ descriptor, authorityId });
      expect(result[harness].descriptor).not.toBe(config[harness]);
      expect(Object.keys(result[harness])).toEqual(["descriptor", "authorityId"]);
      expect(Object.keys(result[harness].descriptor)).toEqual(["version", "harness", "kind", harness === "cc" ? "profileRoot" : "registrationFile"]);
    }
    expect(JSON.stringify(result)).toBe(JSON.stringify({ version: 1, cc: result.cc, oc: result.oc }));
    expect(JSON.stringify(config)).toBe(before);
    expect(readdirSync(root).sort()).toEqual(files);
  });

  test("existing OC registration identity does not require parsing native contents", () => {
    const { root, config } = fixture();
    writeFileSync(join(root, "registration.json"), "opaque, not JSON");
    const before = readFileSync(join(root, "registration.json"), "utf8");
    expect(sources.resolveSources(config).oc.authorityId).toMatch(/^sane-native-v1:oc:[a-f0-9]{64}$/);
    expect(readFileSync(join(root, "registration.json"), "utf8")).toBe(before);
  });

  test("SOURCE_UNAVAILABLE retains each original descriptor and a null authority without creating paths", () => {
    const { root } = fixture();
    const config = configuration(join(root, "unavailable"));
    const before = JSON.stringify(config), files = readdirSync(root).sort();
    const result = sources.resolveSources(config);
    expect(result).toEqual({ version: 1, cc: { descriptor: config.cc, authorityId: null }, oc: { descriptor: config.oc, authorityId: null } });
    expect(result.cc.descriptor).toBe(config.cc); expect(result.oc.descriptor).toBe(config.oc);
    expect(JSON.stringify(config)).toBe(before);
    expect(readdirSync(root).sort()).toEqual(files);
  });

  for (const harness of ["cc", "oc"] as const) {
    for (const kind of ["symlink", "wrong file type"] as const) test(`${harness}: ${kind} remains INVALID_INPUT, not unavailable/null`, () => {
      const { root, config } = fixture();
      const path = join(root, "invalid-leaf");
      if (kind === "symlink") symlinkSync(harness === "cc" ? join(root, "cc") : join(root, "registration.json"), path);
      else if (harness === "cc") writeFileSync(path, "not a directory");
      else mkdirSync(path);
      if (harness === "cc") config.cc = { version: 1, harness, kind: "local-profile", profileRoot: path };
      else config.oc = { version: 1, harness, kind: "local-registration", registrationFile: path };
      const error = caught(() => sources.resolveSources(config));
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    });
  }
});

describe("source configuration comparison preserves existing pins", () => {
  test("matching canonical descriptors and authorities pass without mutating stored pins", () => {
    const { root, config } = fixture();
    const stored = sources.resolveSources(config), before = JSON.stringify(stored);
    const prior = stored.cc.descriptor;
    config.cc = { version: 1, harness: "cc", kind: "local-profile", profileRoot: `${root}/./cc` };
    expect(() => sources.assertSourceConfiguration(stored, config)).not.toThrow();
    expect(JSON.stringify(stored)).toBe(before); expect(stored.cc.descriptor).toBe(prior);
  });

  for (const harness of ["cc", "oc"] as const) {
    test(`${harness}: different known authority refuses`, () => {
      const { config } = fixture();
      const stored = sources.resolveSources(config); stored[harness].authorityId = authority(harness);
      mismatch(stored, config, harness);
    });
    test(`${harness}: stored null versus resolved known is tolerated without upgrading pin`, () => {
      const { config } = fixture();
      const stored = sources.resolveSources(config); stored[harness].authorityId = null;
      const before = JSON.stringify(stored);
      expect(() => sources.assertSourceConfiguration(stored, config)).not.toThrow();
      expect(JSON.stringify(stored)).toBe(before); expect(stored[harness].authorityId).toBeNull();
    });
    test(`${harness}: stored known versus resolved null is tolerated without clearing pin`, () => {
      const { root } = fixture(), config = configuration(join(root, "unavailable"));
      const stored = sources.resolveSources(config); stored[harness].authorityId = authority(harness);
      const before = JSON.stringify(stored);
      expect(() => sources.assertSourceConfiguration(stored, config)).not.toThrow();
      expect(JSON.stringify(stored)).toBe(before); expect(stored[harness].authorityId).toBe(authority(harness));
    });
    test(`${harness}: equal descriptor values in different JSON key order still refuse`, () => {
      const { config } = fixture(), stored = sources.resolveSources(config);
      const d = stored[harness].descriptor;
      stored[harness].descriptor = Object.fromEntries(Object.entries(d).reverse()) as NativeSourceDescriptor;
      expect(stored[harness].descriptor).toEqual(d);
      mismatch(stored, config, harness);
    });
    for (const direction of ["stored null", "resolved null", "both null"] as const) test(`${harness}: descriptor mismatch refuses even with ${direction}`, () => {
      const { root, config: available } = fixture();
      const config = direction === "stored null" ? available : configuration(join(root, "unavailable"));
      const stored = sources.resolveSources(config);
      stored[harness].descriptor = configuration(join(root, "different"))[harness];
      if (direction === "stored null") stored[harness].authorityId = null;
      if (direction === "resolved null") stored[harness].authorityId = authority(harness);
      mismatch(stored, config, harness);
    });
  }
});

function admission(harness: Harness, nativeId: string | null, parent: ConversationRef | null = null): Admission {
  return {
    version: 1, requestId: "12345678-1234-4234-8234-123456789abc", sessionId: "12345678-1234-4234-8234-123456789abd",
    operation: "attach", state: nativeId === null ? "intent" : "identity_known",
    source: { descriptor: configuration(join(TEMP, "offline-app-admission"))[harness], authorityId: authority(harness) },
    binding: {
      workspaceId: "12345678-1234-4234-8234-123456789abe", worktreeId: "12345678-1234-4234-8234-123456789abf",
      bindingRevision: "12345678-1234-4234-8234-123456789ac0", executionCheckout: TEMP, checkoutPin: null, domain: { mode: "app-only" },
    },
    parent, nativeId, createdAt: "2026-10-27T00:00:00.000Z", error: null,
  };
}

describe("admission IDs stay narrower than qualified parent IDs", () => {
  for (const [harness, nativeId] of [
    ["cc", "12345678-1234-4234-8234-123456789abc"],
    ["cc", "ABCDEF12-1234-4234-8234-123456789ABC"],
    ["oc", "sesa"], ["oc", `ses${"a".repeat(200)}`], ["oc", "sesA_9-z"],
  ] as const) test(`${harness} admission accepts bounded native ID ${nativeId.length} chars unchanged`, () => {
    const value = { version: 1 as const, admissions: [admission(harness, nativeId)] }, before = JSON.stringify(value);
    expect(store.validateAdmissions(value)).toBe(value);
    expect(JSON.stringify(value)).toBe(before);
  });

  for (const [harness, nativeId] of [
    ["cc", "not-a-uuid"], ["cc", "12345678-1234-0234-8234-123456789abc"], ["cc", " 12345678-1234-4234-8234-123456789abc"],
    ["oc", "ses"], ["oc", `ses${"a".repeat(201)}`], ["oc", "ses!"], ["oc", "ses a"], ["oc", "SESabc"],
    ["cc", ""], ["oc", "ses\0a"],
  ] as const) test(`${harness} admission refuses malformed/out-of-bounds ID ${JSON.stringify(nativeId)}`, () => {
    corrupt(() => store.validateAdmissions({ version: 1, admissions: [admission(harness, nativeId)] }));
  });

  for (const harness of ["cc", "oc"] as const) {
    for (const nativeId of ["not-a-uuid", "ses", `ses${"a".repeat(201)}`, " ", "arbitrary / ID\n"]) test(`${harness} parent accepts broader NUL-free native ID unchanged: ${nativeId.length} chars`, () => {
      const parent = { harness, authorityId: authority(harness), nativeId };
      const value = { version: 1 as const, admissions: [admission("cc", null, parent)] }, before = JSON.stringify(value);
      expect(() => sources.assertQualifiedReference(parent)).not.toThrow();
      expect(store.validateAdmissions(value)).toBe(value);
      expect(value.admissions[0]!.parent).toBe(parent);
      expect(JSON.stringify(value)).toBe(before);
    });
    for (const nativeId of ["", "bad\0id", 42, null]) test(`${harness} parent refuses empty/NUL/nonstring ID ${JSON.stringify(nativeId)}`, () => {
      const parent = { harness, authorityId: authority(harness), nativeId };
      corrupt(() => sources.assertQualifiedReference(parent));
      const value = admission("cc", null); (value as any).parent = parent;
      corrupt(() => store.validateAdmissions({ version: 1, admissions: [value] }));
    });
  }

  test("unsupported admission source and malformed parent shape/authority refuse", () => {
    const value = admission("cc", null); (value.source.descriptor as any).harness = "third";
    corrupt(() => store.validateAdmissions({ version: 1, admissions: [value] }));
    for (const parent of [
      { harness: "third", authorityId: authority("cc"), nativeId: "parent" },
      { harness: "cc", authorityId: authority("oc"), nativeId: "parent" },
      { harness: "cc", authorityId: null, nativeId: "parent" },
      { harness: "cc", authorityId: authority("cc"), nativeId: "parent", extra: true },
      { harness: "cc", authorityId: authority("cc") },
    ]) {
      corrupt(() => sources.assertQualifiedReference(parent));
      const a = admission("oc", "sesa"); (a as any).parent = parent;
      corrupt(() => store.validateAdmissions({ version: 1, admissions: [a] }));
    }
  });
});
