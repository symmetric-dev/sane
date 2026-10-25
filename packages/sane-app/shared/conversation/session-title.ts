/** New titles are deliberately shorter than the historical 200-character limit. */
export const MAX_SESSION_TITLE_LENGTH = 120;
export const SESSION_TITLE_SOURCES = ["fallback", "generated", "manual", "handoff", "branch", "legacy"] as const;
export type SessionTitleSource = typeof SESSION_TITLE_SOURCES[number];
export type SessionTitleResponse = { title: string; titleSource: SessionTitleSource; titleRevision: number };
export type SessionTitleGeneration = {
  state: "pending" | "completed" | "failed" | "discarded";
  attemptId: string;
  requestedAt: string;
  expectedRevision: number;
  automatic: boolean;
  /** Fixed diagnostic codes only: never source transcript or runner errors. */
  error?: "generation-failed" | "interrupted" | "no-output";
};

export function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) return;
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_SESSION_TITLE_LENGTH ? title : undefined;
}
