import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isPushPayload, parsePushNotificationFragment, type PushPayload } from "../shared/push-notifications";
import { updateSourceKey } from "../shared/conversation/conversation-updates";
import { notificationSourceMatches } from "./notification-source";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { wakePolls } from "./poll-wake";

async function refreshFromPush(payload: PushPayload) {
  let current = store.snapshot();
  const config = current.config;
  if (current.phase !== "ready" || config?.authenticated !== true || !config.storeId
    || payload.storeId !== config.storeId || payload.kind === "test" || !payload.conversationId || !current.conversationsReady) return;
  try { await store.ensureConversations([payload.conversationId]); }
  catch { return; } // A refresh hint is best effort, never a navigation action.
  current = store.snapshot();
  if (current.phase !== "ready" || current.config !== config || current.config?.authenticated !== true) return;
  const target = current.conversations.find(conversation => conversation.id === payload.conversationId);
  const workerAttention = payload.kind === "worker-attention";
  if (!target || target.hidden || target.replacedBy || !workerAttention && (target.worker || target.agentKind === "worker")
    || workerAttention && !target.worker && target.agentKind !== "worker"
    || !payload.source || !notificationSourceMatches(target, updateSourceKey(payload.source))) return;
  // Resolve identity from the current authenticated rows, without retaining a
  // hint across auth/source rebinds. Readers own visibility and request fencing.
  // Never select a conversation, acknowledge attention, or adopt push content.
  wakePolls(target.id);
}

type PendingClick = { payload: PushPayload | null; fragment: string | null; serial: number };
export function usePushInbox() {
  const serial = useRef(0);
  const initialHash = useRef(window.location.hash);
  const [pending, setPending] = useState<PendingClick | null>(() => initialHash.current.startsWith("#notification=")
    ? { payload: parsePushNotificationFragment(initialHash.current), fragment: initialHash.current, serial: ++serial.current } : null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const hash = () => {
      const fragment = window.location.hash;
      if (fragment.startsWith("#notification=")) {
        setNotice(""); setPending({ payload: parsePushNotificationFragment(fragment), fragment, serial: ++serial.current });
      }
    };
    const message = (event: MessageEvent) => {
      // Only accept messages from our same-origin notification service worker.
      const source = event.source as ServiceWorker | null;
      if (event.origin !== location.origin || !source || typeof source.scriptURL !== "string"
        || source.scriptURL !== new URL("/push-worker.js", location.origin).href
        || !["sane:push-open", "sane:push-refresh"].includes(event.data?.type) || !isPushPayload(event.data.payload)) return;
      if (event.data.type === "sane:push-refresh") {
        void refreshFromPush(event.data.payload);
        return;
      }
      // The latest explicit click supersedes an older notification fragment,
      // but never takes ownership of an unrelated application hash.
      const fragment = window.location.hash.startsWith("#notification=") ? window.location.hash : null;
      setNotice(""); setPending({ payload: event.data.payload, fragment, serial: ++serial.current });
      // Acknowledge only validated clicks already queued locally, including
      // clicks waiting for authentication or catalog hydration.
      try { event.ports[0]?.postMessage("sane:push-queued"); } catch { /* The worker can fall back to the notification fragment. */ }
    };
    window.addEventListener("hashchange", hash);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => { window.removeEventListener("hashchange", hash); navigator.serviceWorker?.removeEventListener("message", message); };
  }, []);
  const handled = (click: PendingClick, error = "") => {
    if (click.fragment && window.location.hash === click.fragment)
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    setPending(current => current?.serial === click.serial ? null : current);
    setNotice(error);
  };
  return { pending, handled, notice, dismiss: () => setNotice("") };
}
export type PushInbox = ReturnType<typeof usePushInbox>;

export function PushNavigation({ state, inbox, hydrationReady, openNotification }: {
  state: State; inbox: PushInbox; hydrationReady: boolean; openNotification: (id: string) => boolean;
}) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const processed = useRef(0);
  const openRef = useRef(openNotification), handledRef = useRef(inbox.handled);
  openRef.current = openNotification; handledRef.current = inbox.handled;
  const click = inbox.pending;
  useEffect(() => {
    if (!click || processed.current === click.serial) return;
    const current = store.snapshot(), config = current.config;
    if (current.phase !== "ready" || config?.authenticated !== true || !config.storeId) return;
    const finish = (error = "") => { processed.current = click.serial; handledRef.current(click, error); };
    const payload = click.payload;
    if (!payload) { finish("This notification link is invalid."); return; }
    if (payload.storeId !== config.storeId) { finish("This notification belongs to a different bridge."); return; }
    if (payload.kind === "test") { finish(); return; }
    const conversationId = payload.conversationId;
    if (!conversationId) { finish("This notification link is invalid."); return; }
    if (!hydrationReady || !catalog.snapshot().ready || catalog.snapshot().loading || !current.conversationsReady || current.sending) return;
    const navigation = catalog.snapshot().navigation;
    const controller = new AbortController();
    const open = async () => {
      try { await store.ensureConversations([conversationId], controller.signal); }
      catch {
        if (!controller.signal.aborted) finish("Could not look up this notification’s conversation. Try opening the notification again.");
        return;
      }
      const latest = store.snapshot();
      if (controller.signal.aborted || latest.phase !== "ready" || latest.config !== config
        || latest.config?.authenticated !== true || latest.sending) return;
      if (latest.selected !== current.selected || latest.drafts !== current.drafts || catalog.snapshot().navigation !== navigation) {
        finish(); return; // A newer browsing/composer intent wins, without acknowledgment.
      }
      const target = latest.conversations.find(conversation => conversation.id === payload.conversationId);
      const workerAttention = payload.kind === "worker-attention";
      if (!target || target.hidden || target.replacedBy || !workerAttention && (target.worker || target.agentKind === "worker")
        || workerAttention && !target.worker && target.agentKind !== "worker"
        || !payload.source || !notificationSourceMatches(target, updateSourceKey(payload.source))) {
        finish("This notification’s conversation is no longer available."); return;
      }
      finish(openRef.current(target.id) ? "" : "Could not open this notification’s conversation. Open it from the sidebar.");
    };
    void open();
    // Summary publication rerenders the shell. It must not cancel/restart the
    // lookup it just completed; only a different click/auth/readiness owns it.
    return () => controller.abort();
  }, [click?.serial, state.phase, state.config, state.conversationsReady, state.sending, hydrationReady, repository.ready, repository.loading]);
  return null;
}
