import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

/** Include both the selected session and its native identity when forming a scope. */
export type ChatFlowScope = {
  sessionId: string;
  nativeSessionId?: string | null;
  harness?: string | null;
  workspaceId: string | null;
  worktreeId: string | null;
};

function scopeKey(scope: ChatFlowScope): string {
  return JSON.stringify([scope.sessionId, scope.nativeSessionId ?? null, scope.harness ?? null, scope.workspaceId, scope.worktreeId]);
}

export type ChatFlowSidebar = {
  scope: ChatFlowScope;
  content: ReactNode;
  title?: string;
};

type Registration = { owner: symbol; scope: string; generation: object; content: ReactNode; title?: string };
type RegistrationContext = {
  scope: string | null;
  generation: object;
  register: (registration: Registration) => () => void;
};

// Separate writers from readers: publishing a slot must not rerender its owner.
const RegistrationContext = createContext<RegistrationContext | null>(null);
const SidebarContext = createContext<Pick<ChatFlowSidebar, "content" | "title"> | null>(null);

/** Shell-local navigation completion; desktop content needs no dismissal. */
export const ChatFlowSidebarDismissContext = createContext<(() => void) | undefined>(undefined);

export function useChatFlowSidebarDismiss() {
  return useContext(ChatFlowSidebarDismissContext);
}

/** Layout state only. Flow controllers and send restrictions stay in Thread. */
export function ChatFlowLayoutProvider({ scope, children }: { scope: ChatFlowScope | null; children: ReactNode }) {
  const key = scope ? scopeKey(scope) : null;
  // A return to a previous session/view cannot revive an earlier registration.
  const generation = useMemo(() => ({}), [key]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const register = useCallback((next: Registration) => {
    setRegistration(next);
    return () => setRegistration(current => current?.owner === next.owner ? null : current);
  }, []);
  const writer = useMemo(() => ({ scope: key, generation, register }), [key, generation, register]);
  const sidebar = key !== null && registration?.scope === key && registration.generation === generation ? registration : null;
  return <RegistrationContext.Provider value={writer}><SidebarContext.Provider value={sidebar}>{children}</SidebarContext.Provider></RegistrationContext.Provider>;
}

/**
 * The active Thread controller publishes one winning flow, or null when inactive
 * (including pending-input precedence). Pass the flow's own scope, not a newly
 * selected session's identity. Memoize content to avoid unnecessary publications.
 * Published content renders in shell context; pass controller data via props.
 */
export function useChatFlowSidebar(sidebar: ChatFlowSidebar | null): void {
  const layout = useContext(RegistrationContext);
  const key = sidebar ? scopeKey(sidebar.scope) : null;
  const content = sidebar?.content;
  const title = sidebar?.title;
  useLayoutEffect(() => {
    if (!layout || key === null || layout.scope !== key) return;
    return layout.register({ owner: Symbol("chat-flow-sidebar"), scope: key, generation: layout.generation, content, title });
  }, [layout, key, content, title]);
}

export function useChatFlowSidebarSlot(): Pick<ChatFlowSidebar, "content" | "title"> | null {
  return useContext(SidebarContext);
}
