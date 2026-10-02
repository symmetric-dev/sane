import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isStoredAssistantAgentId, isWorkerAgentId, nativeAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { AgentSnapshot, CanonicalAgentSnapshot } from "./history";
import type { ResolvedAgentLaunch } from "./agent-profiles-contract";

/** Safe to persist/display: messages contain only our diagnostic and exact native agent ID. */
export class AgentLaunchConfigurationError extends Error {}

/** Persist only after native selection is established (or CC launch is configured).
 * OC callers should overlay the effective model/variant returned by resolveLaunch. */
export function agentLaunchSnapshot(launch: ResolvedAgentLaunch): CanonicalAgentSnapshot & Pick<ResolvedAgentLaunch, "profileId" | "model" | "effort"> {
  return { profileId: launch.profileId, ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), ...(launch.identity ? { agent: launch.identity.role, agentKind: launch.identity.kind, nativeAgentSelected: true } : {}) };
}

/** Legacy assistant records retain their meaning; worker identity is explicit. */
export function snapshotIdentity(snapshot: AgentSnapshot): StoredSaneAgentIdentity | undefined {
  if (snapshot.agent === undefined && snapshot.agentKind === undefined) return;
  if (snapshot.agentKind === "worker" && isWorkerAgentId(snapshot.agent)) return { kind: "worker", role: snapshot.agent };
  if ((snapshot.agentKind === undefined || snapshot.agentKind === "assistant") && isStoredAssistantAgentId(snapshot.agent)) return { kind: "assistant", role: snapshot.agent };
  throw new Error("Invalid stored SANE agent identity");
}

/** App-owned Claude runs auto-allow installed ask rules: explicit ask rules
 * still prompt in bypassPermissions mode, and headless runs cannot approve them.
 * Keep explicit deny rules and leave the installed settings file unchanged. */
export async function claudeAgentSettings(claudeRoot: string, identity: StoredSaneAgentIdentity) {
  const agent = nativeAgentId(identity, "claude-code");
  const path = join(claudeRoot, "sane-agent-settings", `${agent}.settings.json`);
  const recovery = identity.kind === "assistant" && identity.role === "knowledge"
    ? "restore the archived Knowledge installation required by this historical conversation; Curation is not a compatible replacement"
    : "reinstall SANE agent context";
  let settings: unknown;
  try { settings = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new AgentLaunchConfigurationError(`Missing or invalid installed settings for ${agent}; ${recovery}`); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new AgentLaunchConfigurationError(`Invalid installed settings for ${agent}; ${recovery}`);
  const installed = (settings as { permissions?: unknown }).permissions;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) throw new AgentLaunchConfigurationError(`Missing or invalid installed permissions for ${agent}; ${recovery}`);
  const { ask, ...permissions } = installed as Record<string, unknown>;
  for (const rules of [permissions.allow, ask]) {
    if (rules !== undefined && (!Array.isArray(rules) || !rules.every(rule => typeof rule === "string"))) throw new AgentLaunchConfigurationError(`Invalid installed permission rules for ${agent}; ${recovery}`);
  }
  if (Array.isArray(ask) && ask.length) permissions.allow = [...new Set([...((permissions.allow as string[] | undefined) ?? []), ...ask])];
  return { agent, permissions };
}
