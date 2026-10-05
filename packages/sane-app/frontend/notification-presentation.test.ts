import { expect, test } from "bun:test";
import { notificationDeliveryMessage, notificationFeedMessage, notificationLocation, type NotificationFeedStatus } from "./notification-presentation";

test("notification copy is chosen from public statuses, never raw diagnostics", () => {
  expect(notificationFeedMessage(null)).toBe("");
  expect(notificationFeedMessage("refresh-error")).toBe("Notifications couldn’t refresh. Retrying automatically.");
  expect(notificationFeedMessage("refreshing")).toBe("Refreshing notifications…");
  expect(notificationFeedMessage("session-error")).toBe("Sessions couldn’t refresh. Retrying automatically.");
  expect(notificationFeedMessage("storage-error")).toBe("Notification history couldn’t load. Retrying automatically.");
  for (const diagnostic of ["Native 2.0.21 replay is unqualified", "Occurrence identity changed", "Validated checkpoint exceeded bounds"]) {
    expect(notificationFeedMessage(diagnostic as NotificationFeedStatus)).toBe(notificationFeedMessage("refresh-error"));
  }
});

test("delivery health is concise and relevant to the selected session only", () => {
  expect(notificationDeliveryMessage(["old-session"], "current-session")).toBe("");
  expect(notificationDeliveryMessage(["current-session"], "")).toBe("");
  expect(notificationDeliveryMessage(undefined, "current-session")).toBe("");
  expect(notificationDeliveryMessage(["current-session"], "current-session")).toBe("Reply notifications may be incomplete for this session.");
  expect(notificationDeliveryMessage(["current-session"], "current-session", notificationFeedMessage("refresh-error"))).toBe("");
});

test("unresolved notification locations never substitute an internal workspace ID", () => {
  const id = "7460b8d0-68da-4e86-b06d-76415da8955b";
  expect(notificationLocation(id)).toBe("Workspace unavailable");
  expect(notificationLocation(id, "", "stale-worktree")).toBe("Workspace unavailable");
  expect(notificationLocation(null)).toBe("Unassociated workspace");
  expect(notificationLocation(id, "My workspace", "feature")).toBe("My workspace · feature");
  expect(notificationLocation(id, "My workspace")).toBe("My workspace");
});
