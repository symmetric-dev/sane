import { isPushPayload, pushNotificationBody, pushNotificationFragment, pushNotificationTitle, type PushPayload } from "../shared/push-notifications";

// A push-only worker: it never intercepts requests or caches authenticated data.
type WorkerClient = { url: string; focus(): Promise<WorkerClient>; postMessage(value: unknown, transfer?: Transferable[]): void };
type WorkerEvent = {
  waitUntil(work: Promise<unknown>): void;
  data?: { json(): unknown };
  notification?: { data: unknown; close(): void };
};
type PushWorker = {
  location: { origin: string };
  registration: ServiceWorkerRegistration;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WorkerClient[]>;
    openWindow(url: string): Promise<WorkerClient | null>;
  };
  addEventListener(name: string, listener: (event: WorkerEvent) => void): void;
};
const worker = globalThis as unknown as PushWorker;
async function hintRefresh(payload: PushPayload): Promise<void> {
  if (payload.kind === "test") return;
  try {
    const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      try {
        const destination = new URL(client.url);
        if (destination.origin !== worker.location.origin || destination.pathname !== "/") continue;
        // A read hint only: never focus, navigate, or wait for a page acknowledgement.
        client.postMessage({ type: "sane:push-refresh", payload });
      } catch { /* A disappearing or inaccessible window must not block other clients. */ }
    }
  } catch { /* Notification delivery does not depend on window enumeration. */ }
}
async function handOff(client: WorkerClient, payload: unknown): Promise<boolean> {
  const channel = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>(resolve => {
      channel.port1.onmessage = event => resolve(event.data === "sane:push-queued");
      timer = setTimeout(() => resolve(false), 1500);
      try { client.postMessage({ type: "sane:push-open", payload }, [channel.port2]); }
      catch { resolve(false); }
    });
  } finally {
    clearTimeout(timer); channel.port1.close(); channel.port2.close();
  }
}
worker.addEventListener("install", event => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload: unknown;
    try { payload = event.data?.json(); } catch { /* Never show sender-controlled text. */ }
    if (!isPushPayload(payload)) {
      // Chrome's userVisibleOnly contract requires a visible notification.
      await worker.registration.showNotification("New activity", { body: "Open SANE to check for new activity.", tag: "sane:activity", silent: true });
      return;
    }
    const options: NotificationOptions & { renotify: boolean } = {
      body: pushNotificationBody(payload.kind, payload.workspaceName, payload.sessionTitle),
      icon: "/assets/pwa/icon-192.png",
      tag: JSON.stringify(["sane", payload.storeId, payload.id]),
      renotify: false,
      silent: true,
      data: payload,
    };
    // Start OS delivery before enumerating clients; a failed refresh hint must
    // neither delay nor replace the user-visible notification.
    const notification = worker.registration.showNotification(pushNotificationTitle(payload), options);
    await Promise.all([notification, hintRefresh(payload)]);
  })());
});

worker.addEventListener("notificationclick", event => {
  const payload: unknown = event.notification?.data;
  event.notification?.close();
  event.waitUntil((async () => {
    const url = new URL("/", worker.location.origin);
    if (isPushPayload(payload)) url.hash = pushNotificationFragment(payload);
    const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Bound acknowledgement waits even when many tabs are open.
    for (const client of clients.slice(0, 2)) {
      try {
        const destination = new URL(client.url);
        if (destination.origin !== url.origin || destination.pathname !== "/") continue;
        // Keep drafts and active execution intact; navigation happens in the
        // authenticated shell, never through a reload or a URL from the sender.
        await client.focus();
        if (isPushPayload(payload) && !await handOff(client, payload)) continue;
        return;
      } catch { /* A disappearing window does not prevent a fresh opening. */ }
    }
    await worker.clients.openWindow(url.href);
  })());
});
