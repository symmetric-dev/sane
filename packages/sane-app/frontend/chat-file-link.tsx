import { createContext, useContext, useState, type ReactNode } from "react";
import { catalog, worktreeScope } from "./catalog";
import { store } from "./store";
import { useWorkspace, type ActiveView } from "./workspace-controller";
import { workspaceEpoch } from "./workspace-store";

/** Chat has no containing document: local links are relative to the execution worktree root. */
function chatFilePath(href: string): string | null {
  if (!href || href.startsWith("/") || href.endsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  // No filesystem/app URLs, double decoding, query strings, or unsupported heading locations.
  if (decoded.startsWith("/") || decoded.endsWith("/") || /[\u0000-\u001f\u007f\\%?#:]/.test(decoded)) return null;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else if (segment && segment !== ".") {
      if ([".git", ".sane"].includes(segment.toLowerCase())) return null;
      segments.push(segment);
    }
  }
  return segments.length ? segments.join("/") : null;
}

const ChatFileNavigation = createContext<((sessionId: string, path: string) => string | undefined) | null>(null);

/** Shell-owned navigation keeps standalone/read-only transcript renderers independent of Files. */
export function ChatFileNavigationProvider({ children, navigate }: { children: ReactNode; navigate: (view: ActiveView) => void }) {
  const controller = useWorkspace();
  const open = (sessionId: string, path: string) => {
    const state = store.snapshot(), repository = catalog.snapshot();
    const conversation = state.conversations.find(item => item.id === sessionId);
    if (state.phase !== "ready" || state.selected !== sessionId || repository.navigation.view !== "chat") return "Open this conversation in Chat before opening its files.";
    if (!conversation?.workspaceId || !conversation.worktreeId || conversation.association !== "resolved") return "This conversation's execution worktree is unavailable.";
    const { workspaceId, worktreeId } = conversation;
    const worktree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
    if (!repository.ready || !worktree || worktree.state !== "available") return "This conversation's execution worktree is unavailable. Reconnect or refresh the workspace catalog.";
    const scope = controller.scope, navigation = repository.navigation;
    if (scope?.id === worktreeScope(workspaceId, worktreeId) && scope.auth === workspaceEpoch()
      && scope.bindingRevision === worktree.bindingRevision && scope.reader.current()
      && navigation.workspaceId === workspaceId && navigation.worktreeId === worktreeId) {
      controller.activate({ view: "code", path });
    } else {
      // Browsing selection can differ from execution. Resolve the correct root before reading,
      // preserving all existing buffers and never selecting a different conversation.
      catalog.navigate({ workspaceId, worktreeId, filePath: path, comparison: null });
      navigate("code");
    }
    return undefined;
  };
  return <ChatFileNavigation.Provider value={open}>{children}</ChatFileNavigation.Provider>;
}

export function ChatFileLink({ children, href, title, sessionId }: { children?: ReactNode; href?: string; title?: string; sessionId: string }) {
  const open = useContext(ChatFileNavigation);
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const key = JSON.stringify([sessionId, href]);
  // Preserve ReactMarkdown's URL sanitization and existing external-link behavior.
  if (href && (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//"))) return <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
  const path = href ? chatFilePath(href) : null;
  if (!path || !open) return <span title={title || "File link unavailable: use a worktree-relative file path in Chat."}>{children}</span>;
  return <><a href={`#file=${encodeURIComponent(path)}`} title={title || `Open ${path} in Files`} onClick={event => {
    event.preventDefault();
    const message = open(sessionId, path);
    setFailure(message ? { key, message } : undefined);
  }}>{children}</a>{failure?.key === key && <span role="alert" className="muted"> — {failure.message}</span>}</>;
}
