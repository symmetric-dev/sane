export type NotificationFeedStatus = "refresh-error" | "refreshing" | "session-error" | "storage-error";

/** UI copy is chosen by consequence, never by backend diagnostic text. */
export function notificationFeedMessage(status: NotificationFeedStatus | null): string {
  switch (status) {
    case null: return "";
    case "refreshing": return "Refreshing notifications…";
    case "session-error": return "Sessions couldn’t refresh. Retrying automatically.";
    case "storage-error": return "Notification history couldn’t load. Retrying automatically.";
    default: return "Notifications couldn’t refresh. Retrying automatically.";
  }
}

export const SESSION_REFRESH_ERROR = "Sessions couldn’t refresh. Retrying automatically.";

export function notificationDeliveryMessage(issues: readonly string[] | undefined, selected: string, refreshError = ""): string {
  return !refreshError && !!selected && issues?.includes(selected) ? "Reply notifications may be incomplete for this session." : "";
}

export function notificationLocation(workspaceId?: string | null, workspaceName?: string | null, worktreeLabel?: string | null): string {
  if (!workspaceName?.trim()) return workspaceId ? "Workspace unavailable" : "Unassociated workspace";
  return [workspaceName.trim(), worktreeLabel?.trim()].filter(Boolean).join(" · ");
}
