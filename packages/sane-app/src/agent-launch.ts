import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isStoredAssistantAgentId, isWorkerAgentId, nativeAgentId, type StoredSaneAgentIdentity, type WorkerAgentId } from "sane-core/agent-catalog";
import { frameworkContext, sessionContext, workerContext } from "sane-core/sane-context";
import type { RepositoryDomain } from "sane-core/server";
import type { ConversationRef } from "sane-core/contracts";
import type { AgentSnapshot, CanonicalAgentSnapshot, Run, SaneSessionContext, Session } from "./history";
import type { ResolvedAgentLaunch } from "./agent-profiles-contract";
import type { ExecutionContext } from "./workstreams";

/** Safe to persist/display: messages contain only our diagnostic and exact native agent ID. */
export class AgentLaunchConfigurationError extends Error {}

/** Persist only after native selection is established (or CC launch is configured).
 * OC callers should overlay the effective model/variant returned by resolveLaunch. */
export function agentLaunchSnapshot(launch: ResolvedAgentLaunch): CanonicalAgentSnapshot & Pick<ResolvedAgentLaunch, "profileId" | "model" | "effort"> {
  return { profileId: launch.profileId, ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), ...(launch.identity ? { agent: launch.identity.role, agentKind: launch.identity.kind, nativeAgentSelected: true } : {}) };
}

/** Only SANE session creation records context; allowlisted identities only. */
export function saneSessionContext(identity: StoredSaneAgentIdentity | undefined, assignment?: string): Pick<Session, "saneContext"> {
  const framework = frameworkContext(identity);
  return framework ? { saneContext: { version: framework.version, framework: framework.text, ...(assignment !== undefined ? { assignment } : {}) } } : {};
}
/** Resolve a new worker's procedure, roots and assigned jobs from its enrolled identity. An
 * implementer starts its planned job; other roles never change job state. Throws when unusable. */
export function workerAssignment(domain: RepositoryDomain, child: ConversationRef, parent: ConversationRef, role: WorkerAgentId, jobIds: readonly string[], correlationId: string): string {
  const context = domain.resolveContext(child);
  const roots = { workstreamRoot: context.artifactsRoot, implementationRoot: context.executionCheckout };
  const workstream = context.workstream;
  if (jobIds.length && !workstream) throw new Error(`Jobs ${jobIds.join(", ")} require a workstream; the worker has none`);
  const jobs = jobIds.map(jobId => {
    const job = domain.getJobContext(workstream!.id, jobId, child);
    if (!job.job.specExists) throw new Error(`Job ${jobId} spec is missing: ${job.job.specPath}`);
    if (!job.reportTemplateExists) throw new Error(`Job ${jobId} report template is missing: ${job.reportTemplate}`);
    return { jobId, status: job.job.status, specPath: job.job.specPath, reportPath: job.job.reportPath, reportTemplatePath: job.reportTemplate };
  });
  if (role === "implementer") for (const job of jobs) if (job.status === "planned") domain.updateJob(workstream!.id, job.jobId, "running", { actor: { kind: "native", repositoryId: domain.repositoryId, ref: parent }, correlationId });
  return workerContext(role, roots, jobs.map(({ status: _, ...job }) => job));
}
/** The text delivered once into history when the native session is created. */
export function saneContextText(context: SaneSessionContext): string {
  return context.assignment === undefined ? context.framework : `${context.framework}\n\n${context.assignment}`;
}
/** Stable per conversation so a retried creation delivers the framework once. */
export function saneFrameworkMessageId(sessionId: string): string {
  return `msg_${sessionId.replaceAll("-", "")}`;
}
/** The SANE Session block every run applies, from current membership; SANE sessions only. */
export function saneSessionText(session: Pick<Session, "saneContext">, context: ExecutionContext): string | null {
  return session.saneContext ? sessionContext({ workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: context.executionCheckout }) : null;
}
/** Runs record the context version their session was created with. */
export function saneContextSnapshot(session: Pick<Session, "saneContext">): Pick<Run, "saneContextVersion"> {
  return session.saneContext ? { saneContextVersion: session.saneContext.version } : {};
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
  for (const rules of [permissions.allow, ask, permissions.deny]) {
    if (rules !== undefined && (!Array.isArray(rules) || !rules.every(rule => typeof rule === "string"))) throw new AgentLaunchConfigurationError(`Invalid installed permission rules for ${agent}; ${recovery}`);
  }
  if (Array.isArray(ask) && ask.length) permissions.allow = [...new Set([...((permissions.allow as string[] | undefined) ?? []), ...ask])];
  return { agent, permissions };
}
