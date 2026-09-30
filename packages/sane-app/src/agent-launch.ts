import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAssistantAgentId, isWorkerAgentId, nativeAgentId, type SaneAgentIdentity } from "sane-core/agent-catalog";
import type { AgentSnapshot } from "./history";
import type { ResolvedAgentLaunch } from "./agent-profiles-contract";

/** Safe to persist/display: messages contain only our diagnostic and canonical agent ID. */
export class AgentLaunchConfigurationError extends Error {}

/** Persist only after native selection is established (or CC launch is configured).
 * OC callers should overlay the effective model/variant returned by resolveLaunch. */
export function agentLaunchSnapshot(launch: ResolvedAgentLaunch): AgentSnapshot & Pick<ResolvedAgentLaunch, "profileId" | "model" | "effort"> {
  return { profileId: launch.profileId, ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), ...(launch.identity ? { agent: launch.identity.role, agentKind: launch.identity.kind, nativeAgentSelected: true } : {}) };
}

/** Legacy assistant records retain their meaning; worker identity is explicit. */
export function snapshotIdentity(snapshot: AgentSnapshot): SaneAgentIdentity | undefined {
  if (snapshot.agent === undefined && snapshot.agentKind === undefined) return;
  if (snapshot.agentKind === "worker" && isWorkerAgentId(snapshot.agent)) return { kind: "worker", role: snapshot.agent };
  if ((snapshot.agentKind === undefined || snapshot.agentKind === "assistant") && isAssistantAgentId(snapshot.agent)) return { kind: "assistant", role: snapshot.agent };
  throw new Error("Invalid stored SANE agent identity");
}

/** App-owned Claude runs auto-allow installed ask rules: explicit ask rules
 * still prompt in bypassPermissions mode, and headless runs cannot approve them.
 * Keep explicit deny rules and leave the installed settings file unchanged. */
export async function claudeAgentSettings(claudeRoot: string, identity: SaneAgentIdentity) {
  const agent = nativeAgentId(identity, "claude-code");
  const path = join(claudeRoot, "sane-agent-settings", `${agent}.settings.json`);
  let settings: unknown;
  try { settings = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new AgentLaunchConfigurationError(`Missing or invalid installed settings for ${agent}; reinstall SANE agent context`); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new AgentLaunchConfigurationError(`Invalid installed settings for ${agent}; reinstall SANE agent context`);
  const installed = (settings as { permissions?: unknown }).permissions;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) throw new AgentLaunchConfigurationError(`Missing or invalid installed permissions for ${agent}; reinstall SANE agent context`);
  const { ask, ...permissions } = installed as Record<string, unknown>;
  for (const rules of [permissions.allow, ask]) {
    if (rules !== undefined && (!Array.isArray(rules) || !rules.every(rule => typeof rule === "string"))) throw new AgentLaunchConfigurationError(`Invalid installed permission rules for ${agent}; reinstall SANE agent context`);
  }
  if (Array.isArray(ask) && ask.length) permissions.allow = [...new Set([...((permissions.allow as string[] | undefined) ?? []), ...ask])];
  return { agent, permissions };
}
