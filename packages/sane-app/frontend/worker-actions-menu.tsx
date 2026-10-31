import { FiGitBranch, FiInfo, FiRefreshCw, FiSquare } from "react-icons/fi";
import { ChatOverflowMenu, type ChatMenuItem } from "./chat-ui";
import type { useWorkerRefresh } from "./worker-refresh";

export { ChatOverflowMenu as WorkerOverflowMenu } from "./chat-ui";
export type WorkerMenuItem = ChatMenuItem;

export function WorkerActionsMenu({ attention, busy, canCancel, refresh, refreshedAt, onDetails, onCancel, onCancelTree }: {
  attention: boolean;
  busy: boolean;
  canCancel: boolean;
  refresh: ReturnType<typeof useWorkerRefresh>;
  refreshedAt: string;
  onDetails: (trigger: HTMLButtonElement) => void;
  onCancel: () => void;
  onCancelTree?: () => void;
}) {
  const items: WorkerMenuItem[] = [
    { id: "details", label: "Details", icon: <FiInfo />, opensDialog: true, ariaLabel: attention ? "Details, attention needed" : undefined, onSelect: onDetails },
    { id: "refresh", label: refresh.loading ? `${refresh.busyLabel}…` : refresh.label, icon: <FiRefreshCw />, disabled: refresh.disabled, busy: refresh.loading,
      title: `${refresh.loading ? `${refresh.busyLabel}…` : refresh.label}. ${refreshedAt}`, onSelect: () => void refresh.refresh() },
    { id: "separator", separator: true },
    { id: "cancel", label: "Cancel worker", icon: <FiSquare />, danger: true, disabled: !canCancel || busy, onSelect: onCancel },
  ];
  if (onCancelTree) items.push({ id: "cancel-tree", label: "Cancel worker tree", icon: <FiGitBranch />, danger: true, disabled: busy, onSelect: onCancelTree });
  return <ChatOverflowMenu label="Worker actions" attention={attention} busy={busy} busyLabel="Worker actions, requesting cancellation" items={items} />;
}
