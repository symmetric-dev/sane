import { ApiError, request } from "./cc-client";
import { store } from "./store";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";
import type { PushConfig } from "../shared/push-notifications";

type PushState = {
  supported: boolean; reason: string; permissionHelp: string; permission: NotificationPermission;
  config: PushConfig | null; enabled: boolean; stale: boolean; subscribed: boolean;
  busy: boolean; error: string; notice: string;
};
type Binding = { endpoint: string; storeId: string; publicKey: string };
const bindingKey = "sane.chrome-push.binding.v1";
function support() {
  const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { brands: { brand: string }[] } };
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  const features = "serviceWorker" in nav && "PushManager" in window && "Notification" in window
    && typeof Notification.requestPermission === "function";
  const permissionHelp = ios
    ? "Notifications are blocked. Open Settings → Notifications → SANE and allow notifications, then return to the installed app."
    : "Notifications are blocked in Chrome. Open Chrome’s site settings → Notifications → Allow, then return here. On Android, also check Chrome’s system notification permission.";
  if (!window.isSecureContext) return { supported: false, permissionHelp, reason: "Device notifications require HTTPS or a localhost/loopback address." };
  if (ios && !standalone) return { supported: false, permissionHelp, reason: "Add SANE to your Home Screen, then open the installed app to enable notifications." };
  const chrome = (nav.userAgentData?.brands.some(item => item.brand === "Google Chrome")
    ?? (/Chrome\//.test(nav.userAgent) && !/Edg\/|OPR\/|Firefox\/|FxiOS\//.test(nav.userAgent)))
    && !/CriOS\//.test(nav.userAgent);
  // Home Screen apps use the iOS engine and may have a Safari-shaped UA,
  // even when installed from Chrome. Desktop Safari remains out of scope.
  if (!features || !(ios && standalone || !ios && chrome))
    return { supported: false, permissionHelp, reason: "Use a current version of Chrome or the installed iOS Home Screen app for device notifications." };
  return { supported: true, permissionHelp, reason: "" };
}
const permission = (): NotificationPermission => "Notification" in window ? Notification.permission : "default";
function binding(): Binding | null {
  try {
    const value = JSON.parse(localStorage.getItem(bindingKey) ?? "null");
    return value && typeof value.endpoint === "string" && typeof value.storeId === "string" && typeof value.publicKey === "string" ? value : null;
  } catch { return null; }
}
function saveBinding(value: Binding | null) {
  try { if (value) localStorage.setItem(bindingKey, JSON.stringify(value)); else localStorage.removeItem(bindingKey); } catch { /* Browser key + server lookup remain authoritative. */ }
}
function vapidKey(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid push configuration.");
  return bytes;
}
function keyMatches(subscription: PushSubscription, publicKey: string) {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  const expected = vapidKey(publicKey), actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}
async function registration() {
  const result = await navigator.serviceWorker.register("/push-worker.js", { scope: "/", updateViaCache: "none" });
  if (result.active) return result;
  const worker = result.installing ?? result.waiting;
  if (!worker) throw new Error("Notification worker is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); worker.removeEventListener("statechange", check); error ? reject(error) : resolve(); };
    const check = () => { if (worker.state === "activated") finish(); else if (worker.state === "redundant") finish(new Error("Notification worker could not start.")); };
    const timer = setTimeout(() => finish(new Error("Notification worker timed out.")), 25000);
    worker.addEventListener("statechange", check); check();
  });
  return result;
}

class ChromePush {
  private listeners = new Set<() => void>();
  private state: PushState = { ...support(), permission: permission(), config: null, enabled: false, stale: false, subscribed: false, busy: false, error: "", notice: "" };
  private generation = 0;
  private controller = new AbortController();
  private identity: unknown;
  private epoch = -1;
  private active = false;
  // Keep browser mutations serialized even if their auth session is suspended.
  private mutating = false;
  private subscription: PushSubscription | null = null;
  private registeredEndpoint = "";
  private signOutPause: { identity: unknown; leftReady: boolean } | null = null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<PushState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  suspend = () => {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.identity = undefined; this.subscription = null; this.registeredEndpoint = "";
    this.update({ config: null, enabled: false, stale: false, subscribed: false, busy: this.mutating, error: "", notice: "" });
  };
  beginSignOut = () => {
    this.signOutPause = { identity: this.session(), leftReady: false };
    this.suspend();
  };
  private session() {
    const current = store.snapshot();
    return current.phase === "ready" && current.config?.authenticated === true && !!current.config.storeId ? current.config : undefined;
  }
  start = () => {
    if (this.active) return () => {};
    this.active = true;
    const sync = () => {
      const identity = this.session(), epoch = workspaceEpoch();
      // Logout publishes workspace/auth updates before clearing the old config.
      // Do not restore its owner binding, even if those updates change the epoch.
      // An ambiguous logout stays paused until a genuinely new sign-in/boot.
      if (this.signOutPause) {
        if (!identity) { this.signOutPause.leftReady = true; return; }
        if (!this.signOutPause.leftReady || identity === this.signOutPause.identity) return;
        this.signOutPause = null;
      }
      if (identity === this.identity && epoch === this.epoch) return;
      this.suspend(); this.identity = identity; this.epoch = epoch;
      if (identity) void this.refresh();
    };
    const refreshPermission = () => {
      if (document.hidden) return;
      this.update({ permission: permission(), ...(permission() === "denied" ? { enabled: false } : {}) });
      if (this.session() && !this.state.busy) void this.refresh();
    };
    const unsubscribe = store.subscribe(sync), unworkspace = subscribeWorkspace(sync);
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);
    sync();
    return () => { this.active = false; unsubscribe(); unworkspace(); window.removeEventListener("focus", refreshPermission); document.removeEventListener("visibilitychange", refreshPermission); this.suspend(); };
  };
  private fence() {
    const generation = this.generation, identity = this.identity, epoch = this.epoch;
    return () => generation === this.generation && identity === this.session() && epoch === workspaceEpoch() && !!identity;
  }
  private api(path: string, init: RequestInit = {}) {
    return request(path, { ...init, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(25000)]) });
  }
  private failure(error: unknown, action: string) {
    if (error instanceof ApiError && error.status === 401) {
      this.suspend(); store.reconnect();
      this.update({ error: "Sign-in expired. Reconnect or sign in again to manage device notifications." });
    } else this.update({ permission: permission(), error: `${action} Check the bridge connection and notification permissions, then retry.` });
  }
  private finishMutation(current: () => boolean) {
    this.mutating = false;
    this.update({ busy: false });
    if (!current() && this.identity && this.identity === this.session()) void this.refresh();
  }
  refresh = async () => {
    if (!this.identity || this.identity !== this.session() || this.state.busy) return;
    const current = this.fence();
    this.update({ busy: true, error: "", permission: permission() });
    try {
      const config: PushConfig = await this.api("/api/push/config");
      if (!current()) return;
      if (!config || typeof config.available !== "boolean" || config.storeId !== store.snapshot().config?.storeId
        || config.available && typeof config.publicKey !== "string") throw new Error("Invalid push configuration.");
      this.update({ config, ...(!config.available ? { enabled: false } : {}) });
      if (!this.state.supported) return;
      const worker = await registration();
      if (!current()) return;
      const subscription = await worker.pushManager.getSubscription();
      if (!current()) return;
      this.subscription = subscription;
      if (!subscription) { this.registeredEndpoint = ""; this.update({ enabled: false, subscribed: false, stale: false }); return; }
      const stored = binding();
      const stale = !config.publicKey || !keyMatches(subscription, config.publicKey)
        || !!stored && (stored.storeId !== config.storeId || stored.publicKey !== config.publicKey || stored.endpoint !== subscription.endpoint);
      const response = await this.api(`/api/push/subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`);
      if (!current()) return;
      if (typeof response.enabled !== "boolean") throw new Error("Invalid subscription status.");
      if (!response.enabled) this.registeredEndpoint = "";
      const enabled = response.enabled && !stale && config.available && permission() === "granted";
      // Preserve a valid prior opt-in while binding it to this authenticated
      // session, so sign-out can revoke ownership after a bridge restart.
      // A disabled subscription must never be silently enabled by hydration.
      if (enabled && this.registeredEndpoint !== subscription.endpoint) {
        if (!current()) return;
        const registered = await this.api("/api/push/subscription", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
        if (!current()) return;
        if (registered.enabled !== true) throw new Error("Subscription ownership was not confirmed.");
        this.registeredEndpoint = subscription.endpoint;
      }
      if (enabled) saveBinding({ endpoint: subscription.endpoint, storeId: config.storeId, publicKey: config.publicKey! });
      this.update({ enabled, subscribed: true, stale, permission: permission() });
    } catch (error) { if (current()) this.failure(error, "Could not check device notifications."); }
    finally { if (current()) this.update({ busy: false }); }
  };
  enable = async () => {
    const config = this.state.config;
    if (this.state.busy || this.mutating || !this.state.supported || !config?.available || !config.publicKey || !this.session()) return;
    if (permission() === "denied") { this.update({ permission: "denied", error: this.state.permissionHelp }); return; }
    const current = this.fence();
    this.mutating = true;
    this.update({ busy: true, error: "", notice: "" });
    let created: PushSubscription | null = null;
    try {
      // Request synchronously in the click handler, before the first await.
      const allowed = permission() === "granted" ? "granted" : await Notification.requestPermission();
      if (!current()) return;
      this.update({ permission: allowed });
      if (allowed !== "granted") { this.update({ enabled: false, notice: allowed === "denied" ? this.state.permissionHelp : "Notifications were not enabled. You can try again when ready." }); return; }
      const worker = await registration();
      if (!current()) return;
      let subscription = await worker.pushManager.getSubscription();
      if (!current()) return;
      this.subscription = subscription;
      this.update({ subscribed: !!subscription });
      const stored = binding();
      if (subscription && (!keyMatches(subscription, config.publicKey) || this.state.stale
        || stored && stored.storeId !== config.storeId)) {
        const response = await this.api("/api/push/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
        if (!current()) return;
        if (response.enabled !== false) throw new Error("Disable was not confirmed.");
        this.registeredEndpoint = "";
        this.update({ enabled: false });
        if (!await subscription.unsubscribe()) throw new Error("Old subscription could not be removed.");
        if (!current()) return;
        subscription = null; this.subscription = null; saveBinding(null);
        this.update({ subscribed: false, stale: false });
      }
      if (!subscription) {
        created = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(config.publicKey) });
        subscription = created;
      }
      if (!current()) { if (created) await created.unsubscribe().catch(() => false); return; }
      const response = await this.api("/api/push/subscription", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      if (!current()) { if (created) await created.unsubscribe().catch(() => false); return; }
      if (response.enabled !== true) throw new Error("Enable was not confirmed.");
      this.subscription = subscription;
      this.registeredEndpoint = subscription.endpoint;
      saveBinding({ endpoint: subscription.endpoint, storeId: config.storeId, publicKey: config.publicKey });
      this.update({ enabled: true, stale: false, subscribed: true, notice: "Device notifications enabled." });
    } catch (error) {
      const rolledBack = !created || await created.unsubscribe().catch(() => false);
      if (current()) {
        if (created && rolledBack) {
          this.subscription = null; this.registeredEndpoint = ""; saveBinding(null);
        } else if (!rolledBack) this.subscription = created;
        this.update({ enabled: false, subscribed: !!this.subscription,
          stale: !rolledBack || !!this.subscription && this.state.stale });
        this.failure(error, "Could not enable device notifications.");
        if (!rolledBack && current()) this.update({ notice: "Browser cleanup is incomplete. Refresh status, then disable notifications before trying again." });
      }
    } finally { this.finishMutation(current); }
  };
  disable = async () => {
    if (this.state.busy || this.mutating || !this.session() || !this.subscription) return;
    const current = this.fence(), subscription = this.subscription;
    this.mutating = true;
    this.update({ busy: true, error: "", notice: "" });
    try {
      const response = await this.api("/api/push/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
      if (!current()) return;
      if (response.enabled !== false) throw new Error("Disable was not confirmed.");
      this.registeredEndpoint = "";
      this.update({ enabled: false }); saveBinding(null);
      if (!await subscription.unsubscribe()) throw new Error("Browser subscription could not be removed.");
      if (!current()) return;
      this.subscription = null;
      this.update({ subscribed: false, stale: false, notice: "Device notifications disabled." });
    } catch (error) { if (current()) this.failure(error, "Could not finish disabling device notifications."); }
    finally { this.finishMutation(current); }
  };
  test = async () => {
    if (this.state.busy || !this.state.enabled || permission() !== "granted" || !this.subscription || !this.session()) return;
    const current = this.fence(), endpoint = this.subscription.endpoint;
    this.update({ busy: true, error: "", notice: "" });
    try {
      const response = await this.api("/api/push/test", { method: "POST", body: JSON.stringify({ endpoint }) });
      if (!current()) return;
      if (response.queued !== true) throw new Error("Test was not queued.");
      this.update({ notice: "Test queued. Your device will show a notification if delivery succeeds." });
    } catch (error) { if (current()) this.failure(error, "Could not send a test notification."); }
    finally { if (current()) this.update({ busy: false }); }
  };
}

export const chromePush = new ChromePush();
