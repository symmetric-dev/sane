import type { Conversation, ConversationRef, WorkstreamStatus, ResearchIndex, LifecyclePhase } from "sane-core/contracts";
export type { WorkstreamDocumentPhase, WorkstreamDocument, WorkstreamDocumentCatalog } from "sane-core/contracts";

export type WorkstreamAction = 'validate' | 'provide';
export type WorkstreamActionInput = { id: string; phase: LifecyclePhase; repositoryId: string; expectedRevision: number; sessionId?: string };
export type WorkstreamActionResult = { action: WorkstreamAction; phase: LifecyclePhase; ok: boolean };
export type WorkstreamCompleteInput = { id: string; repositoryId: string; expectedRevision: number; sessionId?: string };
export type WorkstreamCompleteResult = { action: 'complete'; id: string; ok: boolean };

export type WorkstreamConversation = { ref: ConversationRef | null; sessionId: string | null; title: string; conversation: Conversation | null };
export type WorkstreamOverview = {
  repositoryId: string;
  workstreams: (WorkstreamStatus & { research: ResearchIndex })[];
  conversations: WorkstreamConversation[];
};
