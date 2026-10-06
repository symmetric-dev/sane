import { resolve } from "node:path";
import { isAssistantAgentId, nativeAgentId, type AssistantAgentId } from "sane-core/agent-catalog";
import { canAssign, historicalAgentProfile, legacyProfileId, resolveAgentLaunch, templateProfileId, type AgentProfile, type AgentProfiles } from "./agent-profiles-contract";
import { requireOperation, validateHarness } from "./harness-operations";
import { validEffort, validModel, validVariant, type AgentSnapshot, type Session } from "./history";
import type { Harness } from "./oc-contract";
import type { OpenCodeLaunch } from "./opencode";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type RequestedSettings = { harness?: JsonValue; model?: JsonValue; effort?: JsonValue; agent?: JsonValue; profileId?: JsonValue };
type NormalizedSettings = { harness?: Harness; model?: string; effort?: string; agent?: AssistantAgentId; profileId?: string };
type Configuration = AgentSnapshot & Pick<Session, "model" | "effort" | "saneContext" | "attachment"> & { profileId: string };
type Binding = { conversationId: string; harness: Harness; authorityId: string; nativeSessionId?: string; cwd: string };

/** A launch authority, not a request/session alias. Optional keys retain omission
 * semantics even after a JSON round trip. No functions or native handles live here. */
export type PreparedUserInput = Readonly<{
  version: 1;
  prompt: string;
  binding: Immutable<Binding>;
  resume: boolean;
  requested: Readonly<RequestedSettings>;
  normalized: Readonly<NormalizedSettings>;
  configuration: Immutable<Configuration>;
  expectedPrior?: Immutable<{ binding: Binding; configuration: Configuration }>;
  selectedProfile?: Immutable<AgentProfile>;
  stagedUpgrade?: Immutable<AgentProfile>;
  nativeLaunch?: Immutable<OpenCodeLaunch>;
  associationSelection: Readonly<{ workspaceId?: JsonValue; worktreeId?: JsonValue }>;
  nativeStopped: boolean;
}>;

export class UserInputPreparationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly code?: string, readonly reason?: string) { super(message); }
}

export type UserInputPreparationDependencies = {
  profiles: AgentProfiles;
  getSession: (sessionId: string) => Session | undefined;
  defaultCwd: string;
  conversationId: () => string;
  sourceAuthorityId: (harness: Harness) => string;
  selectedDirectory: (workspaceId: string, worktreeId: string) => Promise<string>;
  ensureDirectory: (cwd: string) => Promise<void>;
  validateOpenCodeModel: (model: string, effort?: string) => unknown;
  resolveOpenCodeLaunch: (cwd: string, settings: { model?: string; effort?: string; agent?: string }) => Promise<OpenCodeLaunch>;
};

export type UserInputRevalidationDependencies = {
  getSession: (sessionId: string) => Session | undefined;
  profiles: AgentProfiles;
  sourceAuthorityId: (harness: Harness) => string;
  ensureDirectory: (cwd: string) => Promise<void>;
  /** Bridge-owned admission/execution/association checks. Must not reselect a
   * model, variant or agent from today's catalog. Called before directory I/O. */
  validateBinding?: (prepared: PreparedUserInput, session: Session | undefined) => void | Promise<void>;
};

const profileId = (s: Session) => s.profileId ?? legacyProfileId(s.harness ?? "claude-code", s.agent);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const snapshot = (s: Session): Configuration => copy({ profileId: profileId(s), model: s.model, effort: s.effort, agent: s.agent, agentKind: s.agentKind, nativeAgentSelected: s.nativeAgentSelected, saneContext: s.saneContext, attachment: s.attachment });
const sessionBinding = (s: Session, authorityId: string): Binding => copy({ conversationId: s.sessionId, harness: validateHarness(s.harness, { defaultHarness: "claude-code" }), authorityId: s.authorityId ?? authorityId, nativeSessionId: s.nativeSessionId, cwd: s.cwd });
const same = (a: unknown, b: unknown): boolean => {
  // JSON object insertion order is not identity (including after persistence).
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, i) => key === right[i] && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};
function launchValid(harness: Harness, model: unknown, effort: unknown): boolean {
  return (model === undefined || validModel(model)) && (effort === undefined || (requireOperation(harness, "prompt").policies.effortMode === "model-variant" ? validVariant(effort) : validEffort(effort)));
}

/** Preparation corresponds to the user POST's selection/validation stage. Native
 * resolution occurs once, before admission; resumes never resolve a new launch. */
export async function prepareUserInput(value: unknown, deps: UserInputPreparationDependencies): Promise<PreparedUserInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserInputPreparationError("Invalid request", 400);
  const raw = value as Record<string, unknown>;
  if (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.cwd !== undefined && typeof raw.cwd !== "string" || raw.sessionId !== undefined && typeof raw.sessionId !== "string") throw new UserInputPreparationError("Invalid request", 400);
  if (/^\s*\/compact(?:\s|$)/i.test(raw.prompt)) throw new UserInputPreparationError("Use the dedicated Compact action for /compact; it requires an existing idle conversation and a durable request ID", 400, "compact-action-required");
  // Clone before the first await: neither callers nor callbacks can rewrite the request.
  const input = copy(raw);
  const requested = copy(Object.fromEntries(["harness", "model", "effort", "agent", "profileId"].filter(key => input[key] !== undefined).map(key => [key, input[key]]))) as RequestedSettings;
  if (input.harness !== undefined) validateHarness(input.harness);
  const found = input.sessionId ? deps.getSession(input.sessionId as string) : undefined;
  if (input.sessionId !== undefined && !found) throw new UserInputPreparationError("Unknown session", 404);
  const session = found && copy(found);
  // Snapshot the catalog as well: asynchronous directory/native resolution cannot
  // allow a profile edit to rewrite a staged upgrade or creation.
  const profiles = copy(deps.profiles);
  if (session && input.profileId === undefined && isAssistantAgentId(input.agent)) input.profileId = templateProfileId(input.agent);
  if (session?.agent === "knowledge" && input.profileId === undefined && input.agent === "knowledge") input.profileId = profileId(session);
  if (input.profileId !== undefined && typeof input.profileId !== "string") throw new UserInputPreparationError("Invalid request", 400);
  const profile = input.profileId !== undefined ? profiles.profiles.find(p => p.id === input.profileId) : undefined;
  const historical = session && input.profileId === profileId(session) ? historicalAgentProfile(session) : undefined;
  if (input.profileId !== undefined && !profile && !historical) throw new UserInputPreparationError("Unknown agent profile", 400);
  let upgrade: AgentProfile | undefined;
  if (profile && !session) {
    const check = canAssign(undefined, profile);
    if (!check.ok) throw new UserInputPreparationError(check.reason, 400);
    const launch = resolveAgentLaunch(profile);
    Object.assign(input, { harness: launch.harness, model: launch.model, effort: launch.effort, agent: launch.identity?.role });
  } else if (profile && session) {
    if (profile.id !== profileId(session)) {
      const current = profiles.profiles.find(p => p.id === profileId(session)) ?? { kind: session.agent ? "assistant" as const : "base" as const, harness: session.harness ?? "claude-code" };
      const check = profile.hidden ? { ok: false, reason: "Hidden agent" } : canAssign(current, profile);
      if (!check.ok) throw new UserInputPreparationError(check.reason === "Different harness" ? "Session harness cannot change" : "Session agent cannot change", 400, undefined, check.reason);
      upgrade = profile;
    }
    Object.assign(input, { harness: undefined, model: undefined, effort: undefined, agent: undefined });
  } else if (historical) Object.assign(input, { harness: undefined, model: undefined, effort: undefined, agent: undefined });
  const harness = validateHarness(input.harness !== undefined ? input.harness : session?.harness, { defaultHarness: "claude-code" });
  const descriptor = requireOperation(harness, "prompt");
  const authorityId = deps.sourceAuthorityId(harness);
  if (session && validateHarness(session.harness, { defaultHarness: "claude-code" }) !== harness) throw new UserInputPreparationError("Session harness cannot change", 400);
  if (session?.attachment && descriptor.policies.attachedSendRequiresNativeStopped && input.nativeStopped !== true) throw new UserInputPreparationError("External assistant activity is unknown. Explicitly acknowledge external execution is stopped before each SANE submission.", 409, "native-acknowledgement-required");
  if (input.model !== undefined && !validModel(input.model)) throw new UserInputPreparationError("Invalid model ID", 400);
  if (input.effort !== undefined && !(descriptor.policies.effortMode === "model-variant" ? validVariant(input.effort) : validEffort(input.effort))) throw new UserInputPreparationError(descriptor.policies.effortMode === "model-variant" ? "Invalid native variant ID" : "effort must be low, medium, high, xhigh, or max", 400);
  if (input.agent !== undefined && !isAssistantAgentId(input.agent)) throw new UserInputPreparationError("Unknown agent", 400);
  if (session?.agent !== undefined && input.agent !== undefined && session.agent !== input.agent) throw new UserInputPreparationError("Session agent cannot change", 400);
  if (harness === "opencode" && input.model !== undefined) deps.validateOpenCodeModel(input.model as string, input.effort as string | undefined);
  let model = upgrade ? upgrade.model || undefined : input.model as string | undefined ?? session?.model;
  let effort = upgrade ? upgrade.effort || undefined : input.effort as string | undefined ?? session?.effort;
  const agent = upgrade ? upgrade.role ?? undefined : input.agent as AssistantAgentId | undefined ?? session?.agent;
  if (harness === "opencode" && input.model === undefined && model !== undefined) deps.validateOpenCodeModel(model, effort);
  const selectedCwd = !session && input.cwd === undefined && typeof input.workspaceId === "string" && typeof input.worktreeId === "string" ? await deps.selectedDirectory(input.workspaceId, input.worktreeId) : undefined;
  const cwd = resolve(input.cwd as string | undefined ?? session?.cwd ?? selectedCwd ?? deps.defaultCwd);
  try { await deps.ensureDirectory(cwd); } catch { throw new UserInputPreparationError("cwd must be an existing directory", 400); }
  if (session && session.cwd !== cwd) throw new UserInputPreparationError("Session cwd cannot change", 400);
  const nativeLaunch = harness === "opencode" && !session ? copy(await deps.resolveOpenCodeLaunch(cwd, { model, effort, ...(isAssistantAgentId(agent) ? { agent: nativeAgentId({ kind: "assistant", role: agent }, harness) } : {}) })) : undefined;
  if (nativeLaunch?.model) {
    model = input.model = `${nativeLaunch.model.providerID}/${nativeLaunch.model.id}`;
    effort = input.effort = nativeLaunch.model.variant;
  }
  const binding = session ? sessionBinding(session, authorityId) : { conversationId: deps.conversationId(), harness, authorityId, cwd };
  const normalized = copy({ harness: input.harness, model: input.model, effort: input.effort, agent: input.agent, profileId: input.profileId }) as NormalizedSettings;
  const configuration: Configuration = copy({ ...(session ? snapshot(session) : {}), profileId: upgrade?.id ?? (session ? profileId(session) : profile?.id ?? legacyProfileId(harness, agent)), model, effort, agent,
    ...(!session && agent !== undefined ? { agentKind: "assistant", nativeAgentSelected: true } : {}) });
  // An upgrade clearing model/effort must not retain inherited defaults.
  if (model === undefined) delete configuration.model;
  if (effort === undefined) delete configuration.effort;
  return freeze(copy({ version: 1, prompt: input.prompt, binding, resume: !!session, requested, normalized, configuration,
    ...(session ? { expectedPrior: { binding: sessionBinding(session, authorityId), configuration: snapshot(session) } } : {}),
    ...(profile ? { selectedProfile: profile } : {}), ...(upgrade ? { stagedUpgrade: upgrade } : {}), ...(nativeLaunch ? { nativeLaunch } : {}),
    associationSelection: { workspaceId: input.workspaceId, worktreeId: input.worktreeId }, nativeStopped: input.nativeStopped === true })) as unknown as PreparedUserInput;
}

/** Delayed admission checks the exact prepared intent. It does not rebuild that
 * intent from the mutable request, session defaults, or current native catalog. */
export function assertPreparedUserInputCurrent(prepared: PreparedUserInput, deps: Pick<UserInputRevalidationDependencies, "getSession" | "sourceAuthorityId" | "profiles">, created?: Session): void {
  const session = deps.getSession(prepared.binding.conversationId);
  const authorityId = deps.sourceAuthorityId(prepared.binding.harness);
  const expected = created ? { binding: sessionBinding(created, authorityId), configuration: snapshot(created) } : prepared.expectedPrior;
  if (authorityId !== prepared.binding.authorityId || (prepared.resume || created ? !session || !expected || !same(sessionBinding(session, authorityId), expected.binding) || !same(snapshot(session), expected.configuration) : !!session)) throw new UserInputPreparationError("Conversation configuration changed before queued admission", 409);
  if (prepared.stagedUpgrade && !same(deps.profiles.profiles.find(p => p.id === prepared.stagedUpgrade!.id), prepared.stagedUpgrade)) throw new UserInputPreparationError("Selected profile changed before queued admission", 409);
  if (!launchValid(prepared.binding.harness, prepared.configuration.model, prepared.configuration.effort)) throw new UserInputPreparationError("Queued launch configuration is invalid", 409);
  if (session?.attachment && requireOperation(prepared.binding.harness, "prompt").policies.attachedSendRequiresNativeStopped && !prepared.nativeStopped) throw new UserInputPreparationError("External assistant activity is unknown. Explicitly acknowledge external execution is stopped before each SANE submission.", 409, "native-acknowledgement-required");
}
export async function revalidatePreparedUserInput(prepared: PreparedUserInput, deps: UserInputRevalidationDependencies): Promise<void> {
  assertPreparedUserInputCurrent(prepared, deps);
  const session = deps.getSession(prepared.binding.conversationId);
  await deps.validateBinding?.(prepared, session);
  try { await deps.ensureDirectory(prepared.binding.cwd); } catch { throw new UserInputPreparationError("Queued execution directory unavailable", 409); }
  assertPreparedUserInputCurrent(prepared, deps);
}
