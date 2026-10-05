import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isPushPayload, parsePushNotificationFragment, type PushPayload } from "../shared/push-notifications";
import { updateSourceKey } from "../shared/conversation/conversation-updates";
import { notificationSourceMatches } from "./notification-source";
import { catalog } from "./catalog";
import { store, type State } from "./store";

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
      if (!source || typeof source.scriptURL !== "string" || source.scriptURL !== new URL("/push-worker.js", location.origin).href
        || event.data?.type !== "sane:push-open" || !isPushPayload(event.data.payload)) return;
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
  useEffect(() => {
    const click = inbox.pending;
    if (!click || processed.current === click.serial) return;
    const current = store.snapshot(), config = current.config;
    if (current.phase !== "ready" || config?.authenticated !== true || !config.storeId) return;
    const finish = (error = "") => { processed.current = click.serial; inbox.handled(click, error); };
    const payload = click.payload;
    if (!payload) { finish("This notification link is invalid."); return; }
    if (payload.storeId !== config.storeId) { finish("This notification belongs to a different bridge."); return; }
    if (payload.kind === "test") { finish(); return; }
    if (!hydrationReady || !catalog.snapshot().ready || catalog.snapshot().loading || !current.conversationsReady || current.sending) return;
    const target = current.conversations.find(conversation => conversation.id === payload.conversationId);
    if (!target || target.hidden || target.replacedBy || target.worker || target.agentKind === "worker"
      || !payload.source || !notificationSourceMatches(target, updateSourceKey(payload.source))) {
      finish("This notification’s conversation is no longer available."); return;
    }
    finish(openNotification(target.id) ? "" : "Could not open this notification’s conversation. Open it from the sidebar.");
  }, [state, inbox, hydrationReady, repository, openNotification]);
  return null;
}
