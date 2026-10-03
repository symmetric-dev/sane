/** UI contract. Harness-specific records stay behind ConversationClient. */
import type { CompactRequest, CompactResponse, CompactState, Interaction, InteractionReply } from "../shared/conversation/native-contract";
import type { DiagnosticEvent, Harness, ModelChoice, Run, RunMetadata, RunStatus } from "../shared/conversation/types";
import type { HarnessCapabilities } from "../shared/conversation/harness-capabilities";
export type { HarnessCapabilities } from "../shared/conversation/harness-capabilities";
export type { RunStatus, Harness, ModelChoice, TextPart, ToolPart, Message, UsageSnapshot, DiagnosticEvent, Run, RunMetadata } from "../shared/conversation/types";
export { active } from "../shared/conversation/types";
import type { Association } from "../src/catalog-contract";
import type { AgentProfile, AgentProfileInput, AgentProfiles } from "../src/agent-profiles-contract";
import type { TranscriptPage, TranscriptMetadataPage, TranscriptRefresh, TranscriptRefreshRequest } from "../src/transcript-contract";
export type { AgentProfile, AgentProfileInput, AgentProfiles } from "../src/agent-profiles-contract";
export type { Interaction, InteractionReply, FormField } from "../shared/conversation/native-contract";
export type WorkerSessionMetadata = { id: string; parent: { sessionId: string; runId: string; toolCallId: string } };
export const harnessName = (harness: Harness) => harness === "opencode" ? "OpenCode" : "Claude Code";
export const harnessShort = (harness: Harness): "OC" | "CC" => harness === "opencode" ? "OC" : "CC";
export type AgentChoice = { id: string; label: string; description: string };
export type Conversation = { id: string; harness: Harness; nativeSessionId?: string; cwd: string; lastRunId: string | null; status: RunStatus; title?: string; hidden?: boolean; model?: string; effort?: string; agent?: string; agentKind?: "assistant" | "worker"; nativeAgentSelected?: boolean; profileId?: string; availability?: Availability; attachment?: { state: "pending" | "ready"; error?: string }; worker?: WorkerSessionMetadata; directWorkerCount?: number; branchOrigin?: string; branchDraft?: string; replacedBy?: string } & Partial<Association>;
export type Capabilities = {
  concurrency: { scope: "bridge" | "conversation"; limit: number; perConversation?: number; sharedCheckoutWrites?: boolean };
  cancelRun: boolean; midRunInput: boolean; permissionReplies: boolean;
  attachments: boolean; modelSelection: boolean; effortValues: string[];
};
/** Local submission, retained after acknowledgement only until its recorded user turn arrives. */
export type PendingTurn = { id: string; conversationId: string; runId?: string; text: string; time: string };
export type HarnessInfo = { id: Harness; available: boolean; connected: boolean; state: string; reason?: string; capabilities: Partial<HarnessCapabilities> };
export type Config = { authRequired: boolean; authenticated: boolean; cwd?: string; capabilities?: Capabilities; agents?: AgentChoice[]; agentProfiles?: AgentProfiles; harnesses?: HarnessInfo[] };
export type Availability = { canSend: boolean; reason?: string };
export type SearchHit = { sessionId: string; runId?: string; snippet: string; score: number };
export interface ConversationClient {
  transcriptPage?(id: string, query?: TranscriptQuery, signal?: AbortSignal): Promise<TranscriptPage>;
  transcriptMeta?(id: string, cursor?: string, signal?: AbortSignal): Promise<TranscriptMetadataPage>;
  transcriptRefresh?(id: string, input: TranscriptRefreshRequest, signal?: AbortSignal): Promise<TranscriptRefresh>;
  config(signal?: AbortSignal): Promise<Config>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  conversations(signal?: AbortSignal): Promise<{ conversations: Conversation[]; availability: Availability }>;
  runs(id: string, signal?: AbortSignal): Promise<RunMetadata[]>;
  compactState?(id: string, signal?: AbortSignal): Promise<CompactState>;
  compact?(id: string, input: CompactRequest): Promise<CompactResponse>;
  workers?(id: string, signal?: AbortSignal): Promise<import("./worker-client").WorkerProjection>;
  events(run: Run, signal?: AbortSignal): Promise<{ events: DiagnosticEvent[]; nextCursor: number; status: RunStatus }>;
   models(cwd: string, signal?: AbortSignal): Promise<ModelChoice[]>;
   interactions(id: string, signal?: AbortSignal): Promise<Interaction[]>;
   reply(id: string, interactionId: string, reply: InteractionReply): Promise<void>;
    cancel(id: string): Promise<{ interrupted: boolean }>;
    hide?(id: string): Promise<void>;
    unhide?(id: string): Promise<void>;
    search?(query: string, opts?: { workspaceId?: string | null; worktreeId?: string | null; limit?: number; signal?: AbortSignal }): Promise<{ results: import("./types").SearchHit[] }>;
     reconcile?(id: string): Promise<{ history: import("../shared/conversation/native-history-contract").ReconciledHistory }>;
     nativeHistory?(id: string, signal?: AbortSignal): Promise<{ history: import("../shared/conversation/native-history-contract").ReconciledHistory | null }>;
    agents?(signal?: AbortSignal): Promise<AgentProfiles>;
    createAgent?(fromId: string, input?: AgentProfileInput): Promise<{ profile: AgentProfile }>;
    updateAgent?(id: string, input: AgentProfileInput): Promise<{ profile: AgentProfile }>;
    deleteAgent?(id: string): Promise<{ ok: true }>;
    resetAgent?(id: string): Promise<{ profile: AgentProfile }>;
    orderAgents?(input: { order?: string[]; defaultId?: string }): Promise<AgentProfiles>;
   submit(input: { text: string; conversationId?: string; nativeStopped?: boolean; harness?: Harness; cwd?: string; workspaceId?: string; worktreeId?: string; model?: string; effort?: string; agent?: string; profileId?: string }): Promise<{ conversationId: string; runId: string }>;
}
export type TranscriptQuery = { cursor?: string; targetKind?: "worker" | "handoff"; targetId?: string; targetMessageId?: string; targetRunId?: string; toolCallId?: string };
