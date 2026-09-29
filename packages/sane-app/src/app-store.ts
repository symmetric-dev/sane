import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { normalizeNativeSource } from "sane-core/server";
import type { NativeSourceDescriptor, NativeAuthority, ConversationRef, CheckoutPin } from "sane-core/contracts";
import { uuid, validateMetadata } from "./history";

/** Fresh format only. Callers hold installation ownership, then data ownership. */
export type AppManifest = { format: "sane-app-store"; version: 1; storeId: string; createdAt: string };
export type SourceConfiguration = { cc: NativeSourceDescriptor; oc: NativeSourceDescriptor };
export type SourceRecord = { descriptor: NativeSourceDescriptor; authorityId: string | null };
export type SourceRecords = { version: 1; cc: SourceRecord; oc: SourceRecord };
export type AdmissionBinding = { workspaceId: string; worktreeId: string; bindingRevision: string; executionCheckout: string; checkoutPin: CheckoutPin | null; domain: { mode: "app-only" } | { mode: "repository"; repositoryId: string; primaryCheckout: string } };
export type Admission = {
  version: 1; requestId: string; sessionId: string; operation: "create" | "attach" | "enroll";
  state: "intent" | "native_creation_unknown" | "identity_known" | "ready" | "rejected";
  source: NativeAuthority; binding: AdmissionBinding; parent: ConversationRef | null;
  nativeId: string | null; createdAt: string; error: string | null;
};
export type AdmissionRecords = { version: 1; admissions: Admission[] };
export class AppStoreError extends Error {
  constructor(public readonly code: "APP_STORE_UNINITIALIZED" | "APP_STORE_UNSUPPORTED" | "APP_STORE_CORRUPT" | "APP_SOURCE_MISMATCH", message: string) { super(message); }
}
export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new AppStoreError("APP_STORE_CORRUPT", "Invalid fresh App record shape");
}
const absolute = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && !v.includes("\0");
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
function corrupt(message: string): never { throw new AppStoreError("APP_STORE_CORRUPT", message); }
function descriptor(value: unknown, harness: "cc" | "oc"): asserts value is NativeSourceDescriptor {
  const key = harness === "cc" ? "profileRoot" : "registrationFile";
  exact(value, ["version", "harness", "kind", key]);
  if (value.version !== 1 || value.harness !== harness || value.kind !== (harness === "cc" ? "local-profile" : "local-registration") || !absolute(value[key])) corrupt("Invalid native source descriptor");
}
export function validateSources(value: unknown): SourceRecords {
  exact(value, ["version", "cc", "oc"]);
  if (value.version !== 1) corrupt("Unsupported source record version");
  for (const harness of ["cc", "oc"] as const) {
    const record = value[harness]; exact(record, ["descriptor", "authorityId"]); descriptor(record.descriptor, harness);
    if (record.authorityId !== null && (typeof record.authorityId !== "string" || !new RegExp(`^sane-native-v1:${harness}:[a-f0-9]{64}$`).test(record.authorityId))) corrupt("Invalid source authority");
  }
  return value as SourceRecords;
}
export function resolveSources(config: SourceConfiguration): SourceRecords {
  const resolve = (harness: "cc" | "oc"): SourceRecord => {
    descriptor(config[harness], harness);
    try { return normalizeNativeSource(config[harness]); }
    catch (e) { if ((e as { code?: string }).code !== "SOURCE_UNAVAILABLE") throw e; return { descriptor: config[harness], authorityId: null }; }
  };
  return { version: 1, cc: resolve("cc"), oc: resolve("oc") };
}
function ref(value: unknown) {
  exact(value, ["harness", "authorityId", "nativeId"]);
  if (!["cc", "oc"].includes(value.harness) || typeof value.authorityId !== "string" || !new RegExp(`^sane-native-v1:${value.harness}:[a-f0-9]{64}$`).test(value.authorityId) || typeof value.nativeId !== "string" || !value.nativeId || value.nativeId.includes("\0")) corrupt("Invalid qualified reference");
}
export function validateAdmissions(value: unknown): AdmissionRecords {
  exact(value, ["version", "admissions"]);
  if (value.version !== 1 || !Array.isArray(value.admissions)) corrupt("Invalid admissions file");
  const ids = new Set<string>(), sessions = new Set<string>(), qualified = new Set<string>();
  for (const a of value.admissions) {
    exact(a, ["version", "requestId", "sessionId", "operation", "state", "source", "binding", "parent", "nativeId", "createdAt", "error"]);
    if (a.version !== 1 || !uuid(a.requestId) || !uuid(a.sessionId) || ids.has(a.requestId) || sessions.has(a.sessionId) || !["create", "attach", "enroll"].includes(a.operation) || !["intent", "native_creation_unknown", "identity_known", "ready", "rejected"].includes(a.state) || !time(a.createdAt) || a.error !== null && typeof a.error !== "string") corrupt("Invalid admission record");
    ids.add(a.requestId); sessions.add(a.sessionId);
    exact(a.source, ["descriptor", "authorityId"]);
    if (!["cc", "oc"].includes(a.source.descriptor?.harness)) corrupt("Invalid admission source");
    descriptor(a.source.descriptor, a.source.descriptor.harness);
    const harness = a.source.descriptor.harness;
    if (typeof a.source.authorityId !== "string" || !new RegExp(`^sane-native-v1:${harness}:[a-f0-9]{64}$`).test(a.source.authorityId)) corrupt("Invalid admission source authority");
    if (a.nativeId !== null) {
      ref({ harness, authorityId: a.source.authorityId, nativeId: a.nativeId });
      if (harness === "cc" ? !uuid(a.nativeId) : !/^ses[a-zA-Z0-9_-]{1,200}$/.test(a.nativeId)) corrupt("Invalid native identity");
      const key = JSON.stringify([harness, a.source.authorityId, a.nativeId]); if (qualified.has(key)) corrupt("Duplicate qualified native identity"); qualified.add(key);
    }
    if (["ready", "identity_known"].includes(a.state) && a.nativeId === null || a.state === "native_creation_unknown" && (a.operation !== "create" || a.nativeId !== null)) corrupt("Invalid admission state/identity");
    if (a.parent !== null) ref(a.parent);
    exact(a.binding, ["workspaceId", "worktreeId", "bindingRevision", "executionCheckout", "checkoutPin", "domain"]);
    const b = a.binding;
    if (![b.workspaceId, b.worktreeId, b.bindingRevision].every(uuid) || !absolute(b.executionCheckout)) corrupt("Invalid admission catalog binding");
    if (b.domain?.mode === "app-only") exact(b.domain, ["mode"]);
    else { exact(b.domain, ["mode", "repositoryId", "primaryCheckout"]); if (b.domain.mode !== "repository" || !uuid(b.domain.repositoryId) || !absolute(b.domain.primaryCheckout) || b.checkoutPin === null) corrupt("Invalid repository binding"); }
    if (b.checkoutPin !== null) {
      exact(b.checkoutPin, ["path", "commonDir", "gitDir", "device", "inode", "commonDevice", "commonInode", "gitDevice", "gitInode"]);
      if (![b.checkoutPin.path, b.checkoutPin.commonDir, b.checkoutPin.gitDir].every(absolute) || b.checkoutPin.path !== b.executionCheckout || ["device", "inode", "commonDevice", "commonInode", "gitDevice", "gitInode"].some(k => !Number.isSafeInteger(b.checkoutPin[k]) || b.checkoutPin[k] < 0)) corrupt("Invalid execution pin");
    }
  }
  return value as AdmissionRecords;
}
function readRecord(root: string, name: string): unknown {
  try { const path = join(root, name), s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) corrupt(`Unsafe required App file: ${name}`); return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { if (e instanceof AppStoreError) throw e; corrupt(`Missing or invalid required App file: ${name}`); }
}
export function atomicAppRecord(root: string, name: string, value: unknown): void {
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error("Invalid App record filename");
  const temporary = join(root, `.${name}.${crypto.randomUUID()}.tmp`), fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(root, name));
  const dir = openSync(root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
/** Strict noncreating validation. Never normalizes unavailable stored sources. */
export function validateAppStore(root: string) {
  try { if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) corrupt("App data must be a canonical directory"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AppStoreError("APP_STORE_UNINITIALIZED", "App setup is required"); throw e; }
  if (!readdirSync(root).length) throw new AppStoreError("APP_STORE_UNINITIALIZED", "App setup is required");
  const manifest = readRecord(root, "manifest.json"); exact(manifest, ["format", "version", "storeId", "createdAt"]);
  if (manifest.format !== "sane-app-store" || manifest.version !== 1) throw new AppStoreError("APP_STORE_UNSUPPORTED", "Unsupported App store format");
  if (!uuid(manifest.storeId) || !time(manifest.createdAt)) corrupt("Invalid App manifest");
  const sources = validateSources(readRecord(root, "sources.json")), admissions = validateAdmissions(readRecord(root, "admissions.json"));
  const rawMetadata = readRecord(root, "metadata.json"); exact(rawMetadata, ["version", "sessions", "runs", "reconciliationRequired"]);
  if (rawMetadata.version !== 1) corrupt("Unsupported App history version");
  const metadata = validateMetadata(rawMetadata);
  const catalog = readRecord(root, "catalog.json"); exact(catalog, ["version", "workspaces", "associations"]);
  if (catalog.version !== 1 || !Array.isArray(catalog.workspaces) || !catalog.associations || typeof catalog.associations !== "object" || Array.isArray(catalog.associations)) corrupt("Invalid catalog");
  const navigation = readRecord(root, "navigation.json"); exact(navigation, ["version", "bookmark"]);
  if (navigation.version !== 1) corrupt("Unsupported navigation");
  for (const session of metadata.sessions) {
    const a = admissions.admissions.find(a => a.sessionId === session.sessionId);
    if (!a || a.nativeId !== session.nativeSessionId || a.binding.executionCheckout !== session.cwd || (a.source.descriptor.harness === "cc" ? "claude-code" : "opencode") !== session.harness) corrupt("History has no matching admission");
  }
  for (const a of admissions.admissions) {
    const source = sources[a.source.descriptor.harness];
    if (source.authorityId !== a.source.authorityId || JSON.stringify(source.descriptor) !== JSON.stringify(a.source.descriptor)) corrupt("Admission source differs from store pin");
    if (a.state === "ready" && !metadata.sessions.some(s => s.sessionId === a.sessionId)) corrupt("Ready admission has no history");
  }
  return { manifest: manifest as AppManifest, sources, admissions, metadata, catalog, navigation };
}
/** Idempotent for a complete matching fresh store; never adopts partial bytes. */
export function initializeAppStore(root: string, config: SourceConfiguration) {
  if (!absolute(root)) throw new Error("App data path must be absolute");
  const sources = resolveSources(config);
  try { if (readdirSync(root).length) { const current = validateAppStore(root); assertSourceConfiguration(current.sources, config); return current; } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; mkdirSync(root, { recursive: true, mode: 0o700 }); }
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) corrupt("App data must be canonical");
  const records = {
    "sources.json": sources, "admissions.json": { version: 1, admissions: [] },
    "metadata.json": { version: 1, sessions: [], runs: [], reconciliationRequired: false },
    "catalog.json": { version: 1, workspaces: [], associations: {} },
    "navigation.json": { version: 1, bookmark: { revision: 0, workspaceId: null, worktreeId: null, conversationId: null, view: "chat", filePath: null, comparison: null } },
    "manifest.json": { format: "sane-app-store", version: 1, storeId: crypto.randomUUID(), createdAt: new Date().toISOString() },
  };
  // Completion marker last. Exclusive creation preserves partial failures.
  for (const [name, value] of Object.entries(records)) { const fd = openSync(join(root, name), "wx", 0o600); try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); } }
  const dir = openSync(root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  return validateAppStore(root);
}
export function assertSourceConfiguration(stored: SourceRecords, config: SourceConfiguration): void {
  const resolved = resolveSources(config);
  for (const harness of ["cc", "oc"] as const) {
    const prior = stored[harness], next = resolved[harness];
    if (JSON.stringify(prior.descriptor) !== JSON.stringify(next.descriptor) || prior.authorityId !== null && next.authorityId !== null && prior.authorityId !== next.authorityId) throw new AppStoreError("APP_SOURCE_MISMATCH", `Configured ${harness} source differs from the App store pin`);
  }
}
