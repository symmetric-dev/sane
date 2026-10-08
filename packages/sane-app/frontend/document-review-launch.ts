/** Explicit Sane Review entry. The session assignment seeds the initial phase;
 * phase/search filters belong to the controller, not the launch or recipient.
 * Reading a document never chooses a recipient. */
export type DocumentReviewLaunch = {
  sessionId: string;
  workspaceId: string;
  repositoryId: string;
  workstreamId: string;
};

export type DocumentReviewRequest = DocumentReviewLaunch & { requestId: number };
