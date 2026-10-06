import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isAssistantAgentId, isWorkerAgentId, nativeAgentId } from "sane-core/agent-catalog";
import { exact, validateAgentProfiles } from "./app-store";
import { builtinProfiles, historicalAgentProfile, legacyProfileId, resolveAgentLaunch, templateProfileId } from "./agent-profiles-contract";
import { uuid, validAgentSnapshot, validEffort, validModel, validProfileId, validVariant, validateMetadata } from "./history";
import type { PreparedUserInput } from "./user-input-preparation";
import { PendingInputCodecError } from "./pending-input-contract";

export const canonicalPath = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && resolve(v) === v && !/[\x00-\x1f\x7f]/.test(v);
export const token = (v: unknown): v is string => typeof v === "string" && !!v && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
export const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export function requireRecord(ok: unknown, message = "Invalid pending input record"): asserts ok { if (!ok) throw new PendingInputCodecError(message); }
export function shape(v: unknown, required: readonly string[], optional: readonly string[] = []): asserts v is Record<string, any> {
  try { exact(v, required, optional); } catch { throw new PendingInputCodecError("Invalid pending input keys"); }
}
export function immutable<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) immutable(child); Object.freeze(v); } return v;
}
/** Canonical JSON rejects non-JSON values instead of quietly omitting them. */
export function canonicalJSON(v: unknown): string {
  const ancestors = new Set<object>();
  const render = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (value && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      requireRecord(!ancestors.has(value), "Cyclic pending input value"); ancestors.add(value);
      requireRecord(Object.getOwnPropertySymbols(value).length === 0 && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, d]) => "value" in d && (d.enumerable || Array.isArray(value) && key === "length")), "Non-JSON pending input properties");
      let result: string;
      if (Array.isArray(value)) {
        requireRecord(Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean), "Sparse/non-JSON pending input array");
        result = `[${value.map(render).join(",")}]`;
      } else result = `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${render((value as Record<string, unknown>)[k])}`).join(",")}}`;
      ancestors.delete(value); return result;
    }
    throw new PendingInputCodecError("Non-JSON pending input value");
  };
  return render(v);
}
export const fingerprint = (v: unknown) => createHash("sha256").update(canonicalJSON(v)).digest("hex");
export const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
export function validateBinding(v: unknown) {
  shape(v, ["conversationId", "harness", "authorityId", "cwd"], ["nativeSessionId"]);
  requireRecord(uuid(v.conversationId) && ["claude-code", "opencode"].includes(v.harness) && canonicalPath(v.cwd));
  const native = v.harness === "opencode" ? "oc" : "cc";
  requireRecord(typeof v.authorityId === "string" && new RegExp(`^sane-native-v1:${native}:[a-f0-9]{64}$`).test(v.authorityId));
  if ("nativeSessionId" in v) requireRecord(v.harness === "opencode" ? typeof v.nativeSessionId === "string" && /^ses[a-zA-Z0-9_-]{1,200}$/.test(v.nativeSessionId) : uuid(v.nativeSessionId));
}
export function validateConfiguration(v: unknown, harness: string) {
  shape(v, ["profileId"], ["model", "effort", "agent", "agentKind", "nativeAgentSelected", "saneContext", "attachment"]);
  requireRecord(validProfileId(v.profileId) && validAgentSnapshot(v));
  if ("model" in v) requireRecord(validModel(v.model));
  if ("effort" in v) requireRecord(harness === "opencode" ? validVariant(v.effort) && !/\x7f/.test(v.effort) : validEffort(v.effort));
  if ("saneContext" in v) { shape(v.saneContext, ["version", "framework"], ["assignment"]); requireRecord(positive(v.saneContext.version) && typeof v.saneContext.framework === "string" && !!v.saneContext.framework && (!("assignment" in v.saneContext) || typeof v.saneContext.assignment === "string" && !!v.saneContext.assignment && v.agentKind === "worker")); }
  if ("attachment" in v) { shape(v.attachment, ["state", "source"], ["error"]); requireRecord(["pending", "ready"].includes(v.attachment.state) && token(v.attachment.source) && (!("error" in v.attachment) || typeof v.attachment.error === "string")); }
  // Existing actual metadata validator remains authoritative for nested agent,
  // framework and attachment relationships; the synthetic row has no run.
  try { validateMetadata({ sessions: [{ ...v, sessionId: "00000000-0000-4000-8000-000000000001", harness, authorityId: `sane-native-v1:${harness === "opencode" ? "oc" : "cc"}:${"a".repeat(64)}`, nativeSessionId: harness === "opencode" ? "ses_codec" : "00000000-0000-4000-8000-000000000002", cwd: "/codec", lastStatus: "unknown", lastRunId: null }], runs: [], reconciliationRequired: false }); }
  catch { throw new PendingInputCodecError("Invalid prepared configuration"); }
}
function profile(v: unknown) {
  shape(v, ["id", "kind", "role", "harness", "model", "effort", "label", "description", "icon", "color", "builtin", "locked", "order", "updatedAt"], ["hidden", "workerProfiles"]);
  requireRecord(["claude-code", "opencode"].includes(v.harness));
  const profiles = builtinProfiles();
  // Validate the snapshot with the actual profile validator, but not mutable
  // global mappings or current referenced target availability.
  const launch = { ...v }; delete launch.workerProfiles;
  const index = profiles.findIndex(p => p.id === launch.id);
  if (index < 0) profiles.push(launch as any); else profiles[index] = launch as any;
  const defaultId = profiles.find(p => p.kind === "base" && !p.hidden)!.id;
  try { validateAgentProfiles({ version: 1, defaultId, profiles }); } catch { throw new PendingInputCodecError("Invalid prepared profile"); }
  requireRecord(v.effort === "" || !/[\x00-\x1f\x7f]/.test(v.effort));
  if ("workerProfiles" in v) {
    requireRecord(v.workerProfiles && typeof v.workerProfiles === "object" && !Array.isArray(v.workerProfiles));
    for (const [role, id] of Object.entries(v.workerProfiles)) requireRecord(isWorkerAgentId(role) && (uuid(id) || id === `worker:${role}`));
  }
}
/** Replay only the pure selection steps of prepareUserInput, without consulting
 * today's catalog or native service. Raw JSON settings are ignored ONLY after
 * a selected resume profile or genuine saved Knowledge fallback selected them
 * out. Optional omission and inferred profile IDs must match normalized exactly.
 * OC creation's captured nativeLaunch may supply/replace model and variant. */
function validateRequestedNormalization(value: Record<string, any>) {
  const input = { ...value.requested }, prior = value.expectedPrior?.configuration;
  if (value.resume && input.profileId === undefined && isAssistantAgentId(input.agent)) input.profileId = templateProfileId(input.agent);
  if (value.resume && prior.agent === "knowledge" && input.profileId === undefined && input.agent === "knowledge") input.profileId = prior.profileId;
  const selected = value.selectedProfile;
  const historical = value.resume && input.profileId === prior.profileId && historicalAgentProfile({ ...prior, harness: value.binding.harness });
  requireRecord(input.profileId === undefined ? selected === undefined : selected?.id === input.profileId || !!historical, "Prepared requested profile selection mismatch");
  requireRecord(!selected || input.profileId === selected.id, "Prepared selected profile was not requested/inferred");
  requireRecord(!!value.stagedUpgrade === !!(value.resume && selected && selected.id !== prior.profileId), "Prepared upgrade selection mismatch");
  if (selected && !value.resume) {
    const launch = resolveAgentLaunch(selected);
    for (const [key, setting] of Object.entries({ harness: launch.harness, model: launch.model, effort: launch.effort, agent: launch.identity?.role })) {
      if (setting === undefined) delete input[key]; else input[key] = setting;
    }
  } else if (value.resume && (selected || historical)) {
    for (const key of ["harness", "model", "effort", "agent"]) delete input[key];
  }
  requireRecord((input.harness ?? (value.resume ? value.expectedPrior.binding.harness : "claude-code")) === value.binding.harness, "Prepared requested harness mismatch");
  if ("model" in input) requireRecord(validModel(input.model), "Invalid requested model");
  if ("effort" in input) requireRecord(value.binding.harness === "opencode" ? validVariant(input.effort) && !/\x7f/.test(input.effort) : validEffort(input.effort), "Invalid requested effort");
  if ("agent" in input) requireRecord(isAssistantAgentId(input.agent), "Invalid requested agent");
  if (value.resume && prior.agent !== undefined && input.agent !== undefined) requireRecord(prior.agent === input.agent, "Prepared requested agent cannot change");
  if (value.nativeLaunch?.model) {
    input.model = `${value.nativeLaunch.model.providerID}/${value.nativeLaunch.model.id}`;
    if ("variant" in value.nativeLaunch.model) input.effort = value.nativeLaunch.model.variant; else delete input.effort;
  }
  requireRecord(equal(input, value.normalized), "Prepared requested/normalized selection mismatch");
  if (!value.resume) requireRecord(value.configuration.profileId === (selected?.id ?? legacyProfileId(value.binding.harness, value.configuration.agent)), "Prepared creation profile mismatch");
}
export function decodePreparedUserInput(value: unknown): PreparedUserInput {
  canonicalJSON(value);
  shape(value, ["version", "prompt", "binding", "resume", "requested", "normalized", "configuration", "associationSelection", "nativeStopped"], ["expectedPrior", "selectedProfile", "stagedUpgrade", "nativeLaunch"]);
  requireRecord(value.version === 1 && typeof value.prompt === "string" && !!value.prompt.trim() && !/^\s*\/compact(?:\s|$)/i.test(value.prompt) && typeof value.resume === "boolean" && typeof value.nativeStopped === "boolean");
  validateBinding(value.binding); const harness = value.binding.harness;
  shape(value.requested, [], ["harness", "model", "effort", "agent", "profileId"]); // Ignored legacy selections remain JSON, exactly as submitted.
  requireRecord(!("harness" in value.requested) || ["claude-code", "opencode"].includes(value.requested.harness));
  requireRecord(!("profileId" in value.requested) || validProfileId(value.requested.profileId));
  shape(value.normalized, [], ["harness", "model", "effort", "agent", "profileId"]);
  const n = value.normalized;
  requireRecord(!("harness" in n) || n.harness === harness);
  requireRecord(!("model" in n) || validModel(n.model));
  requireRecord(!("effort" in n) || (harness === "opencode" ? validVariant(n.effort) && !/\x7f/.test(n.effort) : validEffort(n.effort)));
  requireRecord(!("agent" in n) || isAssistantAgentId(n.agent));
  requireRecord(!("profileId" in n) || validProfileId(n.profileId));
  validateConfiguration(value.configuration, harness);
  requireRecord(harness !== "claude-code" || !value.configuration.attachment || value.nativeStopped, "Prepared attached Claude input requires native-stopped acknowledgement");
  shape(value.associationSelection, [], ["workspaceId", "worktreeId"]);
  for (const id of Object.values(value.associationSelection)) requireRecord(uuid(id));
  requireRecord(value.resume === ("expectedPrior" in value));
  if (value.resume) {
    shape(value.expectedPrior, ["binding", "configuration"]); validateBinding(value.expectedPrior.binding); validateConfiguration(value.expectedPrior.configuration, harness);
    requireRecord(equal(value.binding, value.expectedPrior.binding), "Prepared prior source mismatch");
  }
  for (const key of ["selectedProfile", "stagedUpgrade"]) if (key in value) profile(value[key]);
  if ("selectedProfile" in value) requireRecord(value.selectedProfile.id === n.profileId, "Prepared selected profile mismatch");
  if (!value.resume && value.selectedProfile) {
    requireRecord(value.selectedProfile.harness === harness && !value.selectedProfile.hidden && value.selectedProfile.kind !== "worker");
    const launch = resolveAgentLaunch(value.selectedProfile);
    requireRecord(n.agent === launch.identity?.role && (launch.model === undefined || n.model === launch.model) && (launch.effort === undefined || n.effort === launch.effort), "Prepared profile launch mismatch");
  }
  if ("stagedUpgrade" in value) requireRecord(value.resume && equal(value.stagedUpgrade, value.selectedProfile) && value.configuration.profileId === value.stagedUpgrade.id && value.expectedPrior.configuration.agent === undefined && value.stagedUpgrade.kind === "assistant" && value.stagedUpgrade.harness === harness && !value.stagedUpgrade.hidden);
  for (const key of ["model", "effort", "agent"]) if (key in n) requireRecord(n[key] === value.configuration[key], "Prepared effective selection mismatch");
  if ("profileId" in n) requireRecord(n.profileId === value.configuration.profileId);
  const expected = value.resume ? structuredClone(value.expectedPrior.configuration) : { profileId: value.configuration.profileId };
  const upgrade = value.stagedUpgrade;
  expected.profileId = upgrade ? upgrade.id : value.resume ? value.expectedPrior.configuration.profileId : value.selectedProfile?.id ?? value.configuration.profileId;
  for (const key of ["model", "effort", "agent"]) {
    const setting = upgrade ? key === "agent" ? upgrade.role : upgrade[key] || undefined : key in n ? n[key] : value.resume ? value.expectedPrior.configuration[key] : undefined;
    if (setting === undefined) delete expected[key]; else expected[key] = setting;
  }
  if (!value.resume && expected.agent !== undefined) { expected.agentKind = "assistant"; expected.nativeAgentSelected = true; }
  requireRecord(equal(expected, value.configuration), "Prepared prior/effective configuration mismatch");
  if ("nativeLaunch" in value) {
    requireRecord(!value.resume && harness === "opencode"); shape(value.nativeLaunch, [], ["agent", "model"]);
    if ("agent" in value.nativeLaunch) requireRecord(token(value.nativeLaunch.agent));
    if (isAssistantAgentId(value.configuration.agent)) requireRecord(value.nativeLaunch.agent === nativeAgentId({ kind: "assistant", role: value.configuration.agent }, "opencode"), "Prepared native agent mismatch");
    if ("model" in value.nativeLaunch) {
      const model = value.nativeLaunch.model; shape(model, ["id", "providerID"], ["variant"]);
      requireRecord(validModel(`${model.providerID}/${model.id}`) && token(model.id) && token(model.providerID) && (!("variant" in model) || validVariant(model.variant) && !/\x7f/.test(model.variant)));
      requireRecord(value.configuration.model === `${model.providerID}/${model.id}` && value.configuration.effort === model.variant, "Prepared native launch mismatch");
    }
  }
  validateRequestedNormalization(value);
  // The cast follows exhaustive key/type/relationship validation, never parsing alone.
  return immutable(structuredClone(value)) as PreparedUserInput;
}
