import { WorkspaceError } from "./workspace";

/** Import compatibility for legacy backend consumers only. The bridge no longer
 * constructs this service or exposes its route. Construction intentionally does
 * not load, migrate or claim persisted notebooks; no action can execute. Remove
 * this shim when the remaining legacy consumer has been retired. */
export class ScienceChatService {
  constructor(_store: unknown, _science: unknown, _catalog: unknown, _admissions: unknown, _session: (id: string) => unknown, _ownsMessage?: (conversationId: string, messageId: string) => Promise<boolean>) {}

  async handle(_workspaceId: string, _worktreeId: string, _conversationId: string, _input: unknown, _authorized: () => boolean): Promise<{ chat: null }> {
    throw new WorkspaceError(409, "science-chat-retired", "Science chat has been retired; saved submission history remains available");
  }
}
