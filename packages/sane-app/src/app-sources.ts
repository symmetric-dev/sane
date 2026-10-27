import { normalizeNativeSource } from "sane-core/server";
import type { ConversationRef, GrokSourceDescriptor, Harness, NativeSourceDescriptor } from "sane-core/contracts";
import { isNativeHarness, nativeSourceFormat, validNativeAuthorityId, validPinnedAuthorityId } from "sane-core/native-source-contract";
import { AppStoreError, absolute, corrupt, exact } from "./app-store-format";

// sources.json v1 is exactly these two source pins, not an extensible harness map.
export type SourceConfiguration = { cc: NativeSourceDescriptor; oc: NativeSourceDescriptor };
export type SourceRecord = { descriptor: NativeSourceDescriptor; authorityId: string | null };
export type GrokSourceRecord = { descriptor: GrokSourceDescriptor; authorityId: string | null };
export type SourceRecords = { version: 1; cc: SourceRecord; oc: SourceRecord };
export type SourceRecordsV2 = { version: 2; cc: SourceRecord; oc: SourceRecord; gk?: GrokSourceRecord };
export type StoredSourceRecords = SourceRecords | SourceRecordsV2;

export function assertSourceDescriptor(value: unknown, harness: Harness): asserts value is NativeSourceDescriptor {
  const format = nativeSourceFormat(harness);
  if (!format) corrupt("Invalid native source descriptor");
  exact(value, ["version", "harness", "kind", format.locatorKey]);
  if (value.version !== 1 || value.harness !== harness || value.kind !== format.kind || !absolute(value[format.locatorKey])) corrupt("Invalid native source descriptor");
}

/** Qualified refs do not impose the App admission's narrower native-ID bounds. */
export function assertQualifiedReference(value: unknown): asserts value is ConversationRef {
  exact(value, ["harness", "authorityId", "nativeId"]);
  if (!isNativeHarness(value.harness) || !validNativeAuthorityId(value.harness, value.authorityId) || typeof value.nativeId !== "string" || !value.nativeId || value.nativeId.includes("\0")) corrupt("Invalid qualified reference");
}

/** Validate persisted bytes without normalizing paths or rebuilding descriptors. */
export function validateSources(value: unknown): SourceRecords {
  exact(value, ["version", "cc", "oc"]);
  if (value.version !== 1) corrupt("Unsupported source record version");
  for (const harness of ["cc", "oc"] as const) {
    const record = value[harness]; exact(record, ["descriptor", "authorityId"]); assertSourceDescriptor(record.descriptor, harness);
    if (record.authorityId !== null && !validNativeAuthorityId(harness, record.authorityId)) corrupt("Invalid source authority");
  }
  return value as SourceRecords;
}

function assertGrokDescriptor(value: unknown): asserts value is GrokSourceDescriptor {
  const format = nativeSourceFormat("gk");
  if (!format) corrupt("Invalid native source descriptor");
  exact(value, ["version", "harness", "kind", format.locatorKey]);
  if (value.version !== 1 || value.harness !== "gk" || value.kind !== format.kind || !absolute(value[format.locatorKey])) corrupt("Invalid native source descriptor");
}

function assertPinnedRecord(record: unknown, harness: "cc" | "oc" | "gk"): void {
  exact(record, ["descriptor", "authorityId"]);
  if (harness === "gk") assertGrokDescriptor(record.descriptor);
  else assertSourceDescriptor(record.descriptor, harness);
  if (record.authorityId !== null && !validPinnedAuthorityId(harness, record.authorityId)) corrupt("Invalid source authority");
}

/** v1 stays the closed CC/OC reader. v2 may add a gk pin. Neither path rewrites. */
export function validateStoredSources(value: unknown): StoredSourceRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) corrupt("Unsupported source record version");
  const version = (value as { version?: unknown }).version;
  if (version === 1) return validateSources(value);
  if (version !== 2) corrupt("Unsupported source record version");
  const keys = Object.keys(value as object).sort();
  if (keys.join(",") !== (keys.includes("gk") ? "cc,gk,oc,version" : "cc,oc,version")) corrupt("Invalid fresh App record shape");
  const row = value as Record<string, unknown>;
  if (Object.hasOwn(row, "gk") && (row.gk === null || row.gk === undefined)) corrupt("Invalid source record");
  assertPinnedRecord(row.cc, "cc");
  assertPinnedRecord(row.oc, "oc");
  if (Object.hasOwn(row, "gk")) assertPinnedRecord(row.gk, "gk");
  return value as SourceRecordsV2;
}

/** Configured Grok home. A missing directory is unresolved, not hashed. */
export function grokSourceRecord(homeRoot: string): GrokSourceRecord {
  if (!absolute(homeRoot)) throw new AppStoreError("APP_STORE_CORRUPT", "Grok home must be an absolute path");
  const descriptor = { version: 1 as const, harness: "gk" as const, kind: "local-home" as const, homeRoot };
  try { return normalizeNativeSource(descriptor); }
  catch (e) { if ((e as { code?: string }).code !== "SOURCE_UNAVAILABLE") throw e; return { descriptor, authorityId: null }; }
}

export function resolveSources(config: SourceConfiguration): SourceRecords {
  const resolve = (harness: Harness): SourceRecord => {
    assertSourceDescriptor(config[harness], harness);
    try { return normalizeNativeSource(config[harness]); }
    catch (e) { if ((e as { code?: string }).code !== "SOURCE_UNAVAILABLE") throw e; return { descriptor: config[harness], authorityId: null }; }
  };
  return { version: 1, cc: resolve("cc"), oc: resolve("oc") };
}

export function assertSourceConfiguration(stored: { cc: SourceRecord; oc: SourceRecord }, config: SourceConfiguration): void {
  const resolved = resolveSources(config);
  for (const harness of ["cc", "oc"] as const) {
    const prior = stored[harness], next = resolved[harness];
    if (JSON.stringify(prior.descriptor) !== JSON.stringify(next.descriptor) || prior.authorityId !== null && next.authorityId !== null && prior.authorityId !== next.authorityId) throw new AppStoreError("APP_SOURCE_MISMATCH", `Configured ${harness} source differs from the App store pin`);
  }
}
