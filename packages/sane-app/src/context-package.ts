import { createHash } from "node:crypto";
import { isAssistantAgentId, isStoredAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import { frameworkNames, readFramework } from "sane-core/sane-framework";
import { readWorkerProcedure, workerProcedureSource } from "sane-core/sane-worker-procedures";

export const contextHash = (text: string) => createHash("sha256").update(text).digest("hex");
export type ContextAsset = { id: string; source: string; text: string; sha256: string; description: string; kind: "role" | "framework" | "procedure" | "resource" };
export type ContextPackage = { schema: 1; identity: StoredSaneAgentIdentity; assets: ContextAsset[]; initial: string[]; revision: string };
export type ContextPackageRef = { schema: 1; revision: string; delivery: "standing-native-role"; activation?: "upgrade" };
export type ContextSegment = { id: string; source: string; sha256: string; text: string; reason: string; channel: "standing" | "dynamic" | "native-role-reference" };
export type ContextBinding = { sessionId: string; harness: string; authorityId: string; nativeSessionId: string; cwd: string };
export type ContextDelivery = { schema: 1; binding: ContextBinding; packageRevision: string; staticHash: string; dynamicHash: string; payloadHash: string; standing: string; dynamic: string; segments: ContextSegment[] };

export function contextAsset(id: string, source: string, text: string, kind: ContextAsset["kind"], description = ""): ContextAsset {
  if (!id || !source || !text.trim()) throw new Error(`Empty context asset: ${id}`);
  return { id, source, text, kind, description, sha256: contextHash(text) };
}

/** Stores supply pinned procedure bytes; direct callers can use the authored default. */
export function createContextPackage(identity: StoredSaneAgentIdentity, supplied: ContextAsset[]): ContextPackage {
  if (!identity || (identity.kind === "assistant" ? !isAssistantAgentId(identity.role) : identity.kind !== "worker" || !isWorkerAgentId(identity.role))) throw new Error("An archived role requires its original context package; current roles are not substitutes");
  const assets = supplied.map(a => {
    if (a.sha256 !== contextHash(a.text)) throw new Error(`Modified supplied context asset: ${a.id}`);
    return contextAsset(a.id, a.source, a.text, a.kind, a.description);
  });
  for (const name of frameworkNames(identity)) if (!assets.some(a => a.id === `framework.${name}`)) {
    const fragment = readFramework(name);
    assets.push(contextAsset(`framework.${name}`, fragment.source, fragment.text, "framework", fragment.description));
  }
  if (identity.kind === "worker" && !assets.some(a => a.id === `worker-procedure.${identity.role}`)) {
    assets.push(contextAsset(`worker-procedure.${identity.role}`, workerProcedureSource(identity.role), readWorkerProcedure(identity.role), "procedure"));
  }
  assets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const initial = identity.kind === "assistant" ? [`sane-assistant-${identity.role}-pickup`] : [];
  const body = { schema: 1 as const, identity: { kind: identity.kind, role: identity.role } as StoredSaneAgentIdentity, assets, initial };
  const bundle = { ...body, revision: contextHash(JSON.stringify(body)) };
  validateContextPackage(bundle);
  return bundle;
}

export function validateContextPackage(value: unknown): asserts value is ContextPackage {
  const fail = (): never => { throw new Error("Invalid or modified canonical context package"); };
  if (!value || typeof value !== "object") fail();
  const p = value as ContextPackage;
  if (p.schema !== 1 || !p.identity || !["assistant", "worker"].includes(p.identity.kind) || !Array.isArray(p.assets) || !Array.isArray(p.initial)) fail();
  if (p.identity.kind === "assistant" ? !isStoredAssistantAgentId(p.identity.role) : !isWorkerAgentId(p.identity.role)) fail();
  const ids = new Set<string>();
  for (const a of p.assets) {
    if (!a || typeof a.id !== "string" || !/^[a-z0-9][a-z0-9._/-]*$/.test(a.id) || a.id.split("/").includes("..") || ids.has(a.id)
      || typeof a.source !== "string" || !a.source.trim() || typeof a.description !== "string" || typeof a.text !== "string" || !a.text.trim()
      || !["role", "framework", "procedure", "resource"].includes(a.kind) || a.sha256 !== contextHash(a.text)) fail();
    ids.add(a.id);
  }
  if (p.assets.filter(a => a.kind === "role").length !== 1 || !ids.has("framework.core") || p.initial.some(id => !p.assets.some(a => a.id === id && a.kind === "procedure"))) fail();
  if (!p.assets.some(a => a.kind === "role" && a.id === `role.${p.identity.kind}.${p.identity.role}`)
    || p.assets.some(a => a.id.startsWith("worker-procedure.") && (p.identity.kind !== "worker" || a.id !== `worker-procedure.${p.identity.role}`))) fail();
  if (new Set(p.initial).size !== p.initial.length || !p.assets.some(a => a.id === "framework.core" && a.kind === "framework")) fail();
  if (p.identity.kind === "worker" && (p.initial.length || p.assets.some(a => a.id.startsWith("sane-assistant-") || a.id === "framework.assistant" || a.id === "framework.assignment-discipline"))) fail();
  const body = { schema: p.schema, identity: p.identity, assets: p.assets, initial: p.initial };
  if (p.revision !== contextHash(JSON.stringify(body))) fail();
}

/** Native role selection remains the execution-policy source in this migration stage. */
export function renderContextDelivery(bundle: ContextPackage, binding: ContextBinding, paths: Readonly<Record<string, string>>, dynamic: string, assignment?: string, injectRole = false): ContextDelivery {
  validateContextPackage(bundle);
  validateContextBinding(binding);
  if (typeof dynamic !== "string") throw new Error("Context dynamic bytes must be a string");
  if (assignment !== undefined && (bundle.identity.kind !== "worker" || !assignment.trim())) throw new Error("Context assignment requires a worker and nonempty bytes");
  const segments: ContextSegment[] = [];
  const append = (id: string, source: string, text: string, reason: string, channel: ContextSegment["channel"]) => segments.push({ id, source, text, reason, channel, sha256: contextHash(text) });
  const role = bundle.assets.find(a => a.kind === "role")!;
  append(role.id, role.source, role.text, injectRole ? "Explicit role activation" : "Authored role reference; native launch evidence identifies the actual selected definition. Not injected a second time.", injectRole ? "standing" : "native-role-reference");
  for (const id of ["framework.core", "framework.assistant", "framework.assignment-discipline"]) {
    const a = bundle.assets.find(a => a.id === id);
    if (a) append(a.id, a.source, a.text, "Required framework", "standing");
  }
  const procedures = bundle.assets.filter(a => a.kind === "resource" || a.kind === "procedure" && !a.id.startsWith("worker-procedure."));
  if (procedures.length) {
    const index = ["# SANE private procedures", "Resolve the SANE lifecycle procedure names in your role instructions using this index and the ordinary file-reading tool, rather than native Skill discovery. Other repository skills retain their normal loading mechanism.",
      "Load only the procedure needed for the current lifecycle step. The initial Pickup procedure is included below; do not repeat Pickup merely because these standing instructions remain present on resume.",
      ...procedures.map(a => { if (!paths[a.id]) throw new Error(`Missing pinned context resource: ${a.id}`); return `- ${a.id}: ${paths[a.id]}${a.description ? ` — ${a.description}` : ""}`; })].join("\n\n");
    append("procedure-index", `package:${bundle.revision}`, index, "Selective loading from pinned files", "standing");
  }
  for (const id of bundle.initial) { const a = bundle.assets.find(a => a.id === id)!; append(a.id, a.source, a.text, "Initial lifecycle procedure", "standing"); }
  if (assignment) {
    const procedure = bundle.assets.find(a => a.id === `worker-procedure.${bundle.identity.role}`);
    if (procedure && assignment.startsWith(procedure.text + "\n\n") && assignment.slice(procedure.text.length + 2).trim()) {
      append(procedure.id, procedure.source, procedure.text, "Applicable worker procedure", "standing");
      append("worker-assignment", "session.saneContext.assignment", assignment.slice(procedure.text.length + 2), "Pinned worker roots and assigned jobs", "standing");
    } else {
      if (bundle.identity.role !== "implementer" || assignment.startsWith("# SANE Procedure:")) throw new Error("Worker assignment does not match its pinned procedure");
      append("worker-assignment", "session.saneContext.assignment", assignment, "Pinned free-mode worker assignment", "standing");
    }
  }
  append("session", "App execution context", dynamic, "Current membership and implementation roots", "dynamic");
  const standing = segments.filter(s => s.channel === "standing").map(s => s.text).join("\n\n");
  const staticHash = contextHash(standing), dynamicHash = contextHash(dynamic);
  return { schema: 1, binding: { ...binding }, packageRevision: bundle.revision, staticHash, dynamicHash, payloadHash: contextHash(`${standing}\n\n${dynamic}`), standing, dynamic, segments };
}

export function validateContextBinding(binding: ContextBinding): void {
  if (!binding || ![binding.sessionId, binding.authorityId, binding.nativeSessionId, binding.cwd].every(v => typeof v === "string" && v.trim())
    || !["opencode", "claude-code"].includes(binding.harness)) throw new Error("Context delivery requires an exact native binding");
}

/** Structural integrity only. Dispatch must also verify against trusted package inputs. */
export function validateContextDelivery(delivery: ContextDelivery): void {
  const fail = (): never => { throw new Error("Invalid or modified canonical context delivery"); };
  if (!delivery || delivery.schema !== 1 || !/^[a-f0-9]{64}$/.test(delivery.packageRevision) || !Array.isArray(delivery.segments)) fail();
  validateContextBinding(delivery.binding);
  const ids = new Set<string>();
  for (const s of delivery.segments) {
    if (!s || typeof s.id !== "string" || !s.id || ids.has(s.id) || typeof s.text !== "string"
      || typeof s.source !== "string" || !s.source.trim() || typeof s.reason !== "string" || !s.reason.trim()
      || !["standing", "dynamic", "native-role-reference"].includes(s.channel) || contextHash(s.text) !== s.sha256) fail();
    ids.add(s.id);
  }
  if (delivery.segments.filter(s => s.channel === "dynamic").length !== 1
    || delivery.segments.filter(s => s.channel === "native-role-reference").length > 1
    || delivery.standing !== delivery.segments.filter(s => s.channel === "standing").map(s => s.text).join("\n\n")
    || delivery.dynamic !== delivery.segments.filter(s => s.channel === "dynamic").map(s => s.text).join("\n\n")
    || delivery.staticHash !== contextHash(delivery.standing) || delivery.dynamicHash !== contextHash(delivery.dynamic)
    || delivery.payloadHash !== contextHash(`${delivery.standing}\n\n${delivery.dynamic}`)) fail();
}

export type ContextComposition = {
  bundle: ContextPackage;
  binding: ContextBinding;
  paths: Readonly<Record<string, string>>;
  dynamic: string;
  assignment?: string;
  injectRole: boolean;
};

/** Inputs must come from the pinned store and authoritative session state, never
 * from the untrusted delivery. Recomposition checks required fragments, order,
 * sources, channels, role policy, assignment splitting and exact bytes. */
export function validateContextComposition(delivery: ContextDelivery, expected: ContextComposition): void {
  validateContextDelivery(delivery);
  const actual = renderContextDelivery(expected.bundle, expected.binding, expected.paths, expected.dynamic, expected.assignment, expected.injectRole);
  const bindingMatches = (Object.keys(actual.binding) as (keyof ContextBinding)[]).every(key => actual.binding[key] === delivery.binding[key]);
  const segmentMatches = actual.segments.length === delivery.segments.length && actual.segments.every((s, index) =>
    (Object.keys(s) as (keyof ContextSegment)[]).every(key => s[key] === delivery.segments[index][key]));
  if (!bindingMatches || !segmentMatches || actual.packageRevision !== delivery.packageRevision
    || actual.standing !== delivery.standing || actual.dynamic !== delivery.dynamic) throw new Error("Canonical context composition does not match trusted pinned inputs");
}
