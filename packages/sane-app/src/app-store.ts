import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { NativeAuthority, ConversationRef, CheckoutPin } from "sane-core/contracts";
import { isNativeHarness, nativeSourceFormat, validNativeAuthorityId, validPinnedAuthorityId } from "sane-core/native-source-contract";
import { AppStoreError, exact, absolute, time, corrupt } from "./app-store-format";
import { assertSourceDescriptor, assertQualifiedReference, validateSources, validateStoredSources, grokSourceRecord, resolveSources, assertSourceConfiguration, type SourceConfiguration, type StoredSourceRecords } from "./app-sources";
import { uuid, validateStoredMetadata, validModel, validEffort, validVariant, validProfileId } from "./history";
import { isAssistantAgentId, ASSISTANT_AGENT_IDS, ASSISTANT_AGENT_LABELS, ASSISTANT_AGENT_DESCRIPTIONS, isWorkerAgentId, WORKER_AGENT_IDS } from "sane-core/agent-catalog";
import { isUtilityAgentId, UTILITY_AGENT_IDS } from "sane-core/agent-catalog";
import { AGENT_COLOR_IDS, AGENT_ICON_IDS, BASE_PROFILE_IDS, LEGACY_KNOWLEDGE_PROFILE, builtinProfiles, builtinWorkerDefaults, seedAgentProfiles, templateProfileId, workerTemplateProfileId, utilityTemplateProfileId, type AgentProfiles } from "./agent-profiles-contract";

export { AppStoreError, exact } from "./app-store-format";
export { validateSources, validateStoredSources, grokSourceRecord, resolveSources, assertSourceConfiguration, type SourceConfiguration, type SourceRecord, type SourceRecords, type StoredSourceRecords } from "./app-sources";

/** Fresh format only. Callers hold installation ownership, then data ownership. */
export type AppManifest = { format: "sane-app-store"; version: 1; storeId: string; createdAt: string };
export type AdmissionBinding = { workspaceId: string; worktreeId: string; bindingRevision: string; executionCheckout: string; checkoutPin: CheckoutPin | null; domain: { mode: "app-only" } | { mode: "repository"; repositoryId: string; primaryCheckout: string } };
export type Admission = {
  version: 1; requestId: string; sessionId: string; operation: "create" | "attach" | "enroll";
  state: "intent" | "native_creation_unknown" | "identity_known" | "ready" | "rejected";
  source: NativeAuthority; binding: AdmissionBinding; parent: ConversationRef | null;
  nativeId: string | null; createdAt: string; error: string | null;
};
export type AdmissionRecords = { version: 1; admissions: Admission[] };
export type StoredAdmissions = AdmissionRecords | { version: 2; admissions: Admission[] };
function validAdmissionNativeId(harness: unknown, nativeId: string): boolean {
  switch (harness) {
    case "cc": return uuid(nativeId);
    case "oc": return /^ses[a-zA-Z0-9_-]{1,200}$/.test(nativeId);
    default: return false;
  }
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
    if (!isNativeHarness(a.source.descriptor?.harness)) corrupt("Invalid admission source");
    assertSourceDescriptor(a.source.descriptor, a.source.descriptor.harness);
    const harness = a.source.descriptor.harness;
    if (!validNativeAuthorityId(harness, a.source.authorityId)) corrupt("Invalid admission source authority");
    if (a.nativeId !== null) {
      assertQualifiedReference({ harness, authorityId: a.source.authorityId, nativeId: a.nativeId });
      if (!validAdmissionNativeId(harness, a.nativeId)) corrupt("Invalid native identity");
      const key = JSON.stringify([harness, a.source.authorityId, a.nativeId]); if (qualified.has(key)) corrupt("Duplicate qualified native identity"); qualified.add(key);
    }
    if (["ready", "identity_known"].includes(a.state) && a.nativeId === null || a.state === "native_creation_unknown" && (a.operation !== "create" || a.nativeId !== null)) corrupt("Invalid admission state/identity");
    if (a.parent !== null) assertQualifiedReference(a.parent);
    assertAdmissionBinding(a as { binding: any });
  }
  return value as AdmissionRecords;
}
function assertAdmissionBinding(a: { binding: any }): void {
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
/** v1 remains validateAdmissions. v2 may contain create-only gk rows and is not rewritten on read. */
export function validateStoredAdmissions(value: unknown): StoredAdmissions {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) return validateAdmissions(value);
  exact(value, ["version", "admissions"]);
  if (!Array.isArray(value.admissions)) corrupt("Invalid admissions file");
  const gk = value.admissions.filter((a: { source?: { descriptor?: { harness?: unknown } } }) => a?.source?.descriptor?.harness === "gk");
  const rest = value.admissions.filter((a: { source?: { descriptor?: { harness?: unknown } } }) => a?.source?.descriptor?.harness !== "gk");
  validateAdmissions({ version: 1, admissions: rest });
  const ids = new Set(rest.map((a: Admission) => a.requestId)), sessions = new Set(rest.map((a: Admission) => a.sessionId));
  const qualified = new Set(rest.filter((a: Admission) => a.nativeId !== null).map((a: Admission) => JSON.stringify([a.source.descriptor.harness, a.source.authorityId, a.nativeId])));
  for (const a of gk) {
    exact(a, ["version", "requestId", "sessionId", "operation", "state", "source", "binding", "parent", "nativeId", "createdAt", "error"]);
    if (a.version !== 1 || a.operation !== "create" || !uuid(a.requestId) || !uuid(a.sessionId) || ids.has(a.requestId) || sessions.has(a.sessionId) || !["intent", "native_creation_unknown", "identity_known", "ready", "rejected"].includes(a.state) || !time(a.createdAt) || a.error !== null && typeof a.error !== "string") corrupt("Invalid admission record");
    ids.add(a.requestId); sessions.add(a.sessionId);
    exact(a.source, ["descriptor", "authorityId"]);
    const format = nativeSourceFormat("gk");
    exact(a.source.descriptor, ["version", "harness", "kind", format?.locatorKey ?? "homeRoot"]);
    if (a.source.descriptor.version !== 1 || a.source.descriptor.harness !== "gk" || a.source.descriptor.kind !== "local-home" || !absolute(a.source.descriptor.homeRoot) || !validPinnedAuthorityId("gk", a.source.authorityId)) corrupt("Invalid admission source");
    if (a.nativeId !== null) {
      if (!uuid(a.nativeId)) corrupt("Invalid native identity");
      const key = JSON.stringify(["gk", a.source.authorityId, a.nativeId]);
      if (qualified.has(key)) corrupt("Duplicate qualified native identity");
      qualified.add(key);
    }
    if (["ready", "identity_known"].includes(a.state) && a.nativeId === null || a.state === "native_creation_unknown" && a.nativeId !== null) corrupt("Invalid admission state/identity");
    if (a.parent !== null) assertQualifiedReference(a.parent);
    assertAdmissionBinding(a as { binding: any });
  }
  return value as StoredAdmissions;
}
const PROFILE_KEYS = ["id", "kind", "role", "harness", "model", "effort", "label", "description", "icon", "color", "builtin", "locked", "order", "updatedAt"] as const;
// Utility configuration is not a conversation snapshot identity. Keep history's
// narrower profile-ID validator unchanged so utilities cannot be assigned there.
const validConfiguredProfileId = (value: unknown): value is string => validProfileId(value)
  || typeof value === "string" && value.startsWith("utility:") && isUtilityAgentId(value.slice(8));
/** Validate relationships before normalization; only the original Knowledge
 * builtin or a custom UUID may carry the legitimate legacy assistant role. */
function validateProfileIdentity(p: Record<string, any>, allowLegacyKnowledge = false): void {
  const invalid = (): never => corrupt(`Invalid id/kind/role/builtin relationship for agent profile ${String(p.id)}; reconcile agents.json before restarting the App. No profile was written.`);
  const legacy = p.id === LEGACY_KNOWLEDGE_PROFILE.id;
  if (!validConfiguredProfileId(p.id) || legacy && !allowLegacyKnowledge) invalid();
  const base = Object.values(BASE_PROFILE_IDS).includes(p.id);
  const template = ASSISTANT_AGENT_IDS.some(role => templateProfileId(role) === p.id);
  const worker = WORKER_AGENT_IDS.some(role => workerTemplateProfileId(role) === p.id);
  const utility = UTILITY_AGENT_IDS.some(role => utilityTemplateProfileId(role) === p.id);
  if (p.builtin !== (base || template || worker || utility || legacy)) invalid();
  if (p.kind === "base" ? p.role !== null : p.kind === "worker" ? !isWorkerAgentId(p.role) : p.kind === "utility" ? !isUtilityAgentId(p.role) : p.kind !== "assistant" || !(isAssistantAgentId(p.role) || allowLegacyKnowledge && p.role === "knowledge")) invalid();
  if (p.role === "knowledge" && (!allowLegacyKnowledge || p.kind !== "assistant" || !(legacy || uuid(p.id)))) invalid();
  if (legacy && (p.kind !== "assistant" || p.role !== "knowledge")) invalid();
  if (base && (p.kind !== "base" || BASE_PROFILE_IDS[p.harness as "claude-code" | "opencode"] !== p.id)) invalid();
  if (template && (p.kind !== "assistant" || templateProfileId(p.role) !== p.id)) invalid();
  if (worker && (p.kind !== "worker" || workerTemplateProfileId(p.role) !== p.id)) invalid();
  if (utility && (p.kind !== "utility" || utilityTemplateProfileId(p.role) !== p.id)) invalid();
}
/** Strict agents.json validation; messages double as API 400 errors. */
export function validateAgentProfiles(value: unknown): AgentProfiles {
  exact(value, ["version", "defaultId", "profiles"], ["workerDefaults"]);
  if (value.version !== 1 || !Array.isArray(value.profiles) || typeof value.defaultId !== "string") corrupt("Invalid agent profiles file");
  const ids = new Set<string>(), bases = Object.values(BASE_PROFILE_IDS), templates = ASSISTANT_AGENT_IDS.map(templateProfileId), workers = WORKER_AGENT_IDS.map(workerTemplateProfileId);
  for (const p of value.profiles) {
    exact(p, PROFILE_KEYS, ["hidden", "workerProfiles"]);
    if (!validConfiguredProfileId(p.id) || p.id === LEGACY_KNOWLEDGE_PROFILE.id || ids.has(p.id)) corrupt("Invalid or duplicate agent profile id");
    ids.add(p.id);
    validateProfileIdentity(p);
    if (p.locked !== false) corrupt("Invalid agent profile locked flag");
    if (p.harness !== "claude-code" && p.harness !== "opencode") corrupt("Unknown harness");
    if (p.model !== "" && !validModel(p.model)) corrupt("Invalid model ID");
    if (p.effort !== "" && (p.harness === "opencode" ? !validVariant(p.effort) : !validEffort(p.effort))) corrupt(p.harness === "opencode" ? "Invalid native variant ID" : "effort must be low, medium, high, xhigh, or max");
    if (p.kind === "base" && p.harness === "opencode" && p.effort !== "" && p.model === "") corrupt("Select a model before selecting a variant");
    if (typeof p.label !== "string" || !p.label.trim() || p.label.length > 80) corrupt("Label must be 1-80 characters");
    if (typeof p.description !== "string" || p.description.length > 400) corrupt("Description must be at most 400 characters");
    if (!(AGENT_ICON_IDS as readonly string[]).includes(p.icon)) corrupt("Unknown icon");
    if (typeof p.color !== "string" || !(AGENT_COLOR_IDS as readonly string[]).includes(p.color) && !/^#[0-9a-fA-F]{6}$/.test(p.color)) corrupt("Invalid color");
    if (!Number.isSafeInteger(p.order) || !time(p.updatedAt) || p.hidden !== undefined && typeof p.hidden !== "boolean") corrupt("Invalid agent profile record");
  }
  if (![...bases, ...templates, ...workers, ...UTILITY_AGENT_IDS.map(utilityTemplateProfileId)].every(id => ids.has(id))) corrupt("Builtin agent profiles are missing");
  const mappings = (mapping: unknown, owner: string) => {
    if (mapping === undefined) return;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) corrupt(`Invalid worker mappings for ${owner}`);
    for (const [role, id] of Object.entries(mapping)) {
      if (!isWorkerAgentId(role) || !validProfileId(id)) corrupt(`Invalid worker mapping ${role} for ${owner}`);
      const target = value.profiles.find((p: any) => p.id === id);
      if (!target || target.kind !== "worker" || target.role !== role) corrupt(`Worker ${role} for ${owner} must map to an existing worker profile for that role`);
    }
  };
  mappings(value.workerDefaults, "global defaults");
  for (const p of value.profiles) {
    if (p.kind === "utility" && p.workerProfiles !== undefined) corrupt("Utility profiles cannot carry worker mappings");
    mappings(p.workerProfiles, p.id);
  }
  const fallback = value.profiles.find((p: any) => p.id === value.defaultId);
  if (!fallback || fallback.hidden || !["base", "assistant"].includes(fallback.kind)) corrupt("Default agent must be an existing visible Base or assistant profile");
  return value as AgentProfiles;
}
/** Migrate mutable configuration only; historical snapshot references stay untouched. */
function migrateKnowledgeProfiles(raw: Record<string, any>): boolean {
  exact(raw, ["version", "defaultId", "profiles"], ["workerDefaults"]);
  if (raw.version !== 1 || !Array.isArray(raw.profiles) || typeof raw.defaultId !== "string") corrupt("Invalid agent profiles file; reconcile agents.json before restarting the App");
  // Complete the original-identity preflight before converting even one record.
  const ids = new Set<string>();
  for (const p of raw.profiles) {
    exact(p, PROFILE_KEYS, ["hidden", "workerProfiles"]);
    validateProfileIdentity(p, true);
    if (ids.has(p.id)) corrupt(`Duplicate original agent profile id ${p.id}; reconcile agents.json before restarting the App. No profile was written.`);
    ids.add(p.id);
  }
  const oldId = LEGACY_KNOWLEDGE_PROFILE.id, newId = templateProfileId("curation");
  const legacy = raw.profiles.find((p: any) => p?.id === oldId);
  if (legacy && raw.profiles.some((p: any) => p?.id === newId)) corrupt("Both template:knowledge and template:curation exist in agents.json; reconcile these builtin configurations explicitly before restarting the App. Neither profile was overwritten.");
  let changed = false;
  for (const p of raw.profiles) {
    if (p?.id === oldId) {
      p.id = newId;
      if (p.label === LEGACY_KNOWLEDGE_PROFILE.label) p.label = ASSISTANT_AGENT_LABELS.curation;
      if (p.description === LEGACY_KNOWLEDGE_PROFILE.description) p.description = ASSISTANT_AGENT_DESCRIPTIONS.curation;
      changed = true;
    }
    if (p?.kind === "assistant" && p.role === "knowledge") { p.role = "curation"; changed = true; }
  }
  if (raw.defaultId === oldId) { raw.defaultId = newId; changed = true; }
  return changed;
}
/** Optional record: migrate Knowledge configuration, merge missing builtins, and clear legacy locked Base flags. */
export function loadAgentProfiles(root: string): AgentProfiles {
  try { lstatSync(join(root, "agents.json")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; const seeded = seedAgentProfiles(); atomicAppRecord(root, "agents.json", seeded); return seeded; }
  const raw = readRecord(root, "agents.json") as any;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) corrupt("Invalid agent profiles file");
  const migrated = migrateKnowledgeProfiles(raw);
  const missing = Array.isArray(raw?.profiles) ? builtinProfiles().filter(b => !raw.profiles.some((p: any) => p?.id === b.id)) : [];
  const legacy = Array.isArray(raw?.profiles) ? raw.profiles.filter((p: any) => p?.locked === true && Object.values(BASE_PROFILE_IDS).includes(p.id)) : [];
  for (const p of legacy) p.locked = false;
  const seedWorkers = raw?.workerDefaults === undefined;
  if (seedWorkers) raw.workerDefaults = builtinWorkerDefaults();
  const missingWorkerDefaults = raw.workerDefaults && typeof raw.workerDefaults === "object" && !Array.isArray(raw.workerDefaults)
    ? Object.entries(builtinWorkerDefaults()).filter(([role]) => !Object.hasOwn(raw.workerDefaults, role)) : [];
  for (const [role, id] of missingWorkerDefaults) raw.workerDefaults[role] = id;
  if (!missing.length && !legacy.length && !seedWorkers && !missingWorkerDefaults.length && !migrated) return validateAgentProfiles(raw);
  let order = Math.max(-1, ...raw.profiles.map((p: any) => Number.isSafeInteger(p?.order) ? p.order : -1));
  raw.profiles.push(...missing.map(b => ({ ...b, order: ++order })));
  const merged = validateAgentProfiles(raw); atomicAppRecord(root, "agents.json", merged); return merged;
}
function readRecord(root: string, name: string): unknown {
  try { const path = join(root, name), s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) corrupt(`Unsafe required App file: ${name}`); return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { if (e instanceof AppStoreError) throw e; corrupt(`Missing or invalid required App file: ${name}`); }
}
export function atomicAppRecord(root: string, name: string, value: unknown): void {
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error("Invalid App record filename");
  atomicRecord(root, name, value);
}
/** Native snapshots are keyed by App identity, not arbitrary record filenames. */
export function atomicNativeHistory(root: string, history: import("./reconcile").ReconciledHistory): void {
  if (!uuid(history.sessionId)) throw new Error("Invalid native history App session identity");
  atomicRecord(root, `${history.sessionId}.native-history.json`, history);
}
function atomicRecord(root: string, name: string, value: unknown): void {
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
  const sources = validateStoredSources(readRecord(root, "sources.json")), admissions = validateStoredAdmissions(readRecord(root, "admissions.json"));
  const rawMetadata = readRecord(root, "metadata.json"); exact(rawMetadata, ["version", "sessions", "runs", "reconciliationRequired"]);
  if (rawMetadata.version !== 1 && rawMetadata.version !== 2) corrupt("Unsupported App history version");
  const metadata = validateStoredMetadata(rawMetadata);
  const catalog = readRecord(root, "catalog.json"); exact(catalog, ["version", "workspaces", "associations"]);
  if (catalog.version !== 1 || !Array.isArray(catalog.workspaces) || !catalog.associations || typeof catalog.associations !== "object" || Array.isArray(catalog.associations)) corrupt("Invalid catalog");
  const navigation = readRecord(root, "navigation.json"); exact(navigation, ["version", "bookmark"]);
  if (navigation.version !== 1) corrupt("Unsupported navigation");
  for (const session of metadata.sessions) {
    const a = admissions.admissions.find(a => a.sessionId === session.sessionId);
    if (!a || a.nativeId !== session.nativeSessionId || a.source.authorityId !== session.authorityId || a.binding.executionCheckout !== session.cwd || storedSessionHarness(a.source.descriptor.harness) !== session.harness) corrupt("History has no matching admission");
  }
  for (const a of admissions.admissions) {
    const pin = a.source.descriptor.harness === "cc" || a.source.descriptor.harness === "oc" ? sources[a.source.descriptor.harness] : sources.version === 2 ? sources.gk : undefined;
    if (!pin || pin.authorityId !== a.source.authorityId || JSON.stringify(pin.descriptor) !== JSON.stringify(a.source.descriptor)) corrupt("Admission source differs from store pin");
    if (a.state === "ready" && !metadata.sessions.some(s => s.sessionId === a.sessionId)) corrupt("Ready admission has no history");
  }
  return { manifest: manifest as AppManifest, sources, admissions, metadata, catalog, navigation };
}
function storedSessionHarness(native: string): string {
  if (native === "cc") return "claude-code";
  if (native === "oc") return "opencode";
  if (native === "gk") return "grok";
  corrupt("Invalid admission source");
}
/** Explicit Grok source publication. Copies cc/oc pins. Does not upgrade a repository or rewrite on open. */
export function publishGrokSourcePin(root: string, homeRoot: string): StoredSourceRecords {
  const current = validateStoredSources(readRecord(root, "sources.json"));
  const next = { version: 2 as const, cc: structuredClone(current.cc), oc: structuredClone(current.oc), gk: grokSourceRecord(homeRoot) };
  const validated = validateStoredSources(next);
  atomicAppRecord(root, "sources.json", validated);
  return validated;
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
