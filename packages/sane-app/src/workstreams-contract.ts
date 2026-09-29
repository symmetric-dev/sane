import type { Conversation, ConversationRef, WorkstreamStatus, ResearchIndex } from "sane-core/contracts";

export type WorkstreamConversation = { ref: ConversationRef | null; sessionId: string | null; title: string; conversation: Conversation | null };
export type WorkstreamOverview = {
  repositoryId: string;
  workstreams: (WorkstreamStatus & { research: ResearchIndex })[];
  conversations: WorkstreamConversation[];
};
