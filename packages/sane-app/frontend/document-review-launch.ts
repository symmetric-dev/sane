/** Explicit Settings-to-chat entry. Reading a document never chooses a recipient. */
export type DocumentReviewLaunch = {
  sessionId: string;
  workspaceId: string;
  repositoryId: string;
  workstreamId: string;
};

export type DocumentReviewRequest = DocumentReviewLaunch & { requestId: number };
