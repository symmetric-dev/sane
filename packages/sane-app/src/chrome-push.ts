import { Database } from "bun:sqlite";
import { createECDH, createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import * as webPush from "web-push";
import { isPushPayload, normalizePushNotificationLabel, PUSH_SESSION_TITLE_MAX_CHARACTERS, PUSH_WORKSPACE_NAME_MAX_CHARACTERS,
  type ChromePushSubscription, type PushPayload } from "../shared/push-notifications";
import { isConversationUpdateSource, updateSourceKey, type ConversationUpdateCursor, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import type { ConversationUpdateStore } from "./conversation-update-store";
import type { Event, Run, Session } from "./history";

const MAX_DEVICES = 32, MAX_PENDING = 2048, MAX_RECORDS = 8192, MAX_COMPLETIONS = 256;
const LIFETIME = 24 * 60 * 60 * 1000, MAX_ATTEMPTS = 8, MAX_BACKOFF = 60 * 60 * 1000;
const FEED_INTERVAL = 1000, SEND_TIMEOUT = 10_000, BODY_LIMIT = 8192;
const APPLICATION_ID = 0x53505553, SCHEMA_VERSION = 1;
/** Yield null for each examined run/irrelevant event, not just matching events,
 * so each iterator.next() represents bounded work on the source journal. */
export type ChromePushRecoveryRecord = { session: Session; run: Run; event: Event } | null;
type Options = {
  dataDir: string;
  storeId: string;
  feed: ConversationUpdateStore;
  eligible: (conversationId: string, source: ConversationUpdateSource) => boolean;
  presentation?: (conversationId: string, source: ConversationUpdateSource) => { sessionTitle?: string; workspaceName?: string };
  recoverCompletions: () => Iterable<ChromePushRecoveryRecord>;
  subject?: string;
};
type Device = {
  id: string; endpoint: string; owner: string; p256dh: string; auth: string;
  expiration: number | null; enrolled: number; epoch: string; after_seq: number;
};
type Delivery = { id: string; device: string; payload: string; expires: number; attempts: number };
type Completion = { identity: string; payload: PushPayload };
class CapacityError extends Error {}
class RequestError extends Error { constructor(readonly status = 400) { super("Invalid push request"); } }
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const ownerKey = (owner: string) => digest(JSON.stringify(["push-owner", owner]));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** Chrome uses FCM on desktop/Android and standard Apple Web Push for iOS
 * Home Screen apps. Only known vendor hosts, never arbitrary HTTPS fetches.
 * Apple protocol: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers */
function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  // Check the original spelling as URL() otherwise normalizes explicit ports,
  // dot segments, empty fragments, whitespace and escaped hostnames away.
  const fcm = /^https:\/\/fcm\.googleapis\.com\/(?:fcm\/send|wp)\/[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/.test(value);
  // Apple's endpoint is one opaque URL-safe token, not the native APNs API.
  // Do not guess regional hosts or accept all *.push.apple.com subdomains.
  const apple = /^https:\/\/web\.push\.apple\.com\/[A-Za-z0-9_-]+$/.test(value);
  if (!fcm && !apple) return false;
  const url = new URL(value);
  return (url.hostname === "fcm.googleapis.com" || url.hostname === "web.push.apple.com")
    && url.href === value && !url.port && !url.username && !url.password && !url.search && !url.hash;
}
function keyBytes(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value ? bytes : undefined;
}
function validSubscription(value: unknown): value is ChromePushSubscription {
  if (!object(value) || !only(value, ["endpoint", "expirationTime", "keys"]) || !validEndpoint(value.endpoint)
    || value.expirationTime !== undefined && value.expirationTime !== null
      && (!Number.isSafeInteger(value.expirationTime) || (value.expirationTime as number) <= Date.now())
    || !object(value.keys) || !only(value.keys, ["p256dh", "auth"])) return false;
  const publicKey = keyBytes(value.keys.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !keyBytes(value.keys.auth, 16)) return false;
  try {
    // computeSecret rejects an off-curve P-256 point before enrollment or send.
    const curve = createECDH("prime256v1"); curve.generateKeys(); curve.computeSecret(publicKey);
    return true;
  } catch { return false; }
}
function subscription(device: Device): ChromePushSubscription {
  return { endpoint: device.endpoint, expirationTime: device.expiration, keys: { p256dh: device.p256dh, auth: device.auth } };
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.body || !/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) throw new RequestError();
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new RequestError(413);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const signal = AbortSignal.any([req.signal, controller.signal]);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new RequestError(408));
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_LIMIT) throw new RequestError(413);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new RequestError(); }
    if (!object(value)) throw new RequestError();
    return value;
  } catch (error) {
    // A disconnected/malformed HTTP body is not an outbox storage failure.
    if (error instanceof RequestError) throw error;
    throw new RequestError();
  } finally {
    clearTimeout(timer);
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/** Optional sidecar: never writes or sends inside the primary journal hook.
 * The outbox is at-least-once; stable device/occurrence topics suppress many,
 * but not all, duplicates across ambiguous external delivery or process death. */
export class ChromePushService {
  private db?: Database;
  private vapid?: webPush.VapidKeys;
  private appleVapid?: { authorization: string; renewAt: number };
  private directory?: string;
  private directoryIdentity?: { dev: number; ino: number };
  private fileIdentity?: { dev: number; ino: number };
  private started = false;
  private closed = false;
  private available = false;
  private problem = "not_started";
  private timer?: ReturnType<typeof setTimeout>;
  private wakeAt = Infinity;
  private nextFeed = 0;
  private nextRecovery = 0;
  private nextMaintenance = 0;
  private recovery?: Iterator<ChromePushRecoveryRecord>;
  private recoveryItem?: Completion;
  private readonly completions = new Map<string, Completion>();
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, { device: string; controller: AbortController; promise: Promise<void> }>();
  private readonly counters = { cursorGaps: 0, capacityPauses: 0, completionOverflow: 0, recoveryErrors: 0,
    accepted: 0, retries: 0, permanentFailures: 0, expiredDevices: 0 };

  constructor(private readonly options: Options) {}

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      this.open();
      this.available = true; this.problem = "none";
      // Must run after primary startup replay. New stores baseline at the head;
      // old stores keep their durable cursor and queued deliveries.
      this.alignCursor();
      try { this.recovery = this.options.recoverCompletions()[Symbol.iterator](); }
      catch { this.counters.recoveryErrors++; throw new Error("Completion recovery unavailable"); }
      this.schedule(0);
    } catch {
      this.fail(this.counters.recoveryErrors ? "completion_recovery_failed_requires_restart" : "storage_unavailable");
      try { this.db?.close(); } catch { /* Never leak a failed initialization handle. */ }
      this.db = undefined; this.vapid = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.available = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.shutdown.abort();
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
    try { this.recovery?.return?.(); } catch { /* Optional derived source. */ }
    this.recovery = undefined; this.recoveryItem = undefined; this.completions.clear();
    try { this.db?.close(); } catch { /* Shutdown cannot fail the bridge. */ }
    this.db = undefined; this.vapid = undefined; this.appleVapid = undefined;
  }

  /** Called only AFTER durable primary journal append. No disk/network work here. */
  journalCommitted(session: Session, run: Run, event: Event): void {
    try {
      if (this.closed || this.started && !this.available) return;
      const completion = this.completion(session, run, event);
      if (!completion) return;
      if (!this.completions.has(completion.identity) && this.completions.size >= MAX_COMPLETIONS) {
        // Do not falsely claim healthy delivery after losing a live source.
        // Committed journals remain the recovery authority on the next startup.
        this.counters.completionOverflow++; this.fail("completion_overflow_requires_restart"); return;
      }
      this.completions.set(completion.identity, completion);
      this.nextRecovery = 0; this.schedule(0);
    } catch { this.fail("completion_capture_requires_restart"); }
  }

  /** Enrollment is durable, owner association is not an enrollment lifetime.
   * Authenticated device requests rebind this association after cookie rotation. */
  revokeOwner(owner: string): void {
    try {
      if (!this.db) return;
      const devices = this.db.query<{ id: string }, [string]>("SELECT id FROM subscriptions WHERE owner = ?").all(ownerKey(owner));
      this.db.query("DELETE FROM subscriptions WHERE owner = ?").run(ownerKey(owner));
      for (const device of devices) this.abortDevice(device.id);
      this.schedule(0);
    } catch { this.fail("owner_revocation_failed_requires_restart"); }
  }

  /** Caller has already enforced browser Host/Origin and authentication. */
  async route(req: Request, owner: string, isCurrent: () => boolean = () => true): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/push/")) return null;
    if (!isCurrent()) return response({ error: "Authentication required" }, 401);
    const paths = ["/api/push/config", "/api/push/subscription", "/api/push/test", "/api/push/diagnostics"];
    if (!paths.includes(url.pathname)) return response({ error: "Not found" }, 404);
    if (url.pathname === "/api/push/config" && req.method === "GET") {
      return response({ available: this.available && !this.closed, storeId: this.options.storeId,
        ...(this.available && this.vapid ? { publicKey: this.vapid.publicKey } : {}) });
    }
    if (url.pathname === "/api/push/diagnostics" && req.method === "GET") {
      // Explicit developer-only details, never endpoint, owner, keys, or payloads.
      return response({ available: this.available, problem: this.problem, ...this.counters, active: this.active.size,
        bufferedCompletions: this.completions.size, recovering: !!this.recovery,
        limits: { devices: MAX_DEVICES, pending: MAX_PENDING, records: MAX_RECORDS, attempts: MAX_ATTEMPTS, lifetimeMs: LIFETIME } });
    }
    const allowed = url.pathname === "/api/push/subscription" ? ["GET", "POST", "DELETE"] : url.pathname === "/api/push/test" ? ["POST"] : [];
    if (!allowed.includes(req.method)) return response({ error: "Method not allowed" }, 405);
    if (!this.available || !this.db || this.closed) return response({ error: "Device notifications are unavailable" }, 503);
    try {
      const db = this.db, now = Date.now();
      if (req.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "endpoint") || url.searchParams.getAll("endpoint").length !== 1) throw new RequestError();
        const endpoint = url.searchParams.get("endpoint");
        if (!validEndpoint(endpoint)) throw new RequestError();
        const device = db.query<Device, [string]>("SELECT * FROM subscriptions WHERE endpoint = ?").get(endpoint);
        if (device?.expiration != null && device.expiration <= now) this.removeDevice(device.id);
        return response({ enabled: !!device && (device.expiration === null || device.expiration > now) });
      }
      const body = await readBody(req);
      // Input may arrive after sign-out. Check the captured browser authority
      // immediately before any mutation, with no subsequent asynchronous gap.
      if (!isCurrent()) return response({ error: "Authentication required" }, 401);
      // Awaiting an input must not retain an old DB after shutdown/failure.
      if (!this.available || this.closed || this.db !== db) return response({ error: "Device notifications are unavailable" }, 503);
      if (req.method === "POST" && url.pathname === "/api/push/subscription") {
        if (!only(body, ["subscription"]) || !validSubscription(body.subscription)) throw new RequestError();
        const sub = body.subscription;
        const head = this.options.feed.getHead();
        if (!head || head.storeId !== this.options.storeId) return response({ error: "Device notifications are unavailable" }, 503);
        const old = db.query<Device, [string]>("SELECT * FROM subscriptions WHERE endpoint = ?").get(sub.endpoint);
        // Unchanged device enrollment survives App/auth restarts. A changed key
        // pair is a fresh device; do not replay an old backlog to its new keys.
        const same = old && (old.expiration === null || old.expiration > Date.now())
          && old.p256dh === sub.keys.p256dh && old.auth === sub.keys.auth;
        db.transaction(() => {
          if (same && old) db.query("UPDATE subscriptions SET owner = ?, expiration = ? WHERE id = ?")
            .run(ownerKey(owner), sub.expirationTime ?? null, old.id);
          else {
            if (old) db.query("DELETE FROM subscriptions WHERE id = ?").run(old.id);
            const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM subscriptions").get()!.n;
            if (count >= MAX_DEVICES) throw new CapacityError();
            db.query("INSERT INTO subscriptions (id, endpoint, owner, p256dh, auth, expiration, enrolled, epoch, after_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(randomUUID(), sub.endpoint, ownerKey(owner), sub.keys.p256dh, sub.keys.auth, sub.expirationTime ?? null, Date.now(), head.epoch, head.through);
          }
        }).immediate();
        if (old && !same) this.abortDevice(old.id);
        this.schedule(0); return response({ enabled: true });
      }
      if (!only(body, ["endpoint"]) || !validEndpoint(body.endpoint)) throw new RequestError();
      const device = db.query<Device, [string]>("SELECT * FROM subscriptions WHERE endpoint = ?").get(body.endpoint);
      if (req.method === "DELETE") {
        if (device) this.removeDevice(device.id);
        return response({ enabled: false });
      }
      if (!device || device.expiration !== null && device.expiration <= Date.now()) throw new RequestError(409);
      db.query("UPDATE subscriptions SET owner = ? WHERE id = ?").run(ownerKey(owner), device.id);
      const payload: PushPayload = { version: 1, storeId: this.options.storeId, id: randomUUID(), kind: "test", createdAt: Date.now() };
      db.transaction(() => { this.enqueue(device, payload, JSON.stringify(["test", payload.id]), this.budget()); }).immediate();
      this.schedule(0); return response({ queued: true });
    } catch (error) {
      if (error instanceof RequestError) return response({ error: "Invalid device notification request" }, error.status);
      if (error instanceof CapacityError) return response({ error: "Device notification capacity reached" }, 429);
      this.fail("storage_unavailable"); return response({ error: "Device notifications are unavailable" }, 503);
    }
  }

  private assertFiles(): void {
    if (!this.directory) throw new Error("No private directory");
    const dir = lstatSync(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(this.directory) !== this.directory
      || (dir.mode & 0o077) !== 0 || typeof process.getuid === "function" && dir.uid !== process.getuid()) throw new Error("Unsafe push directory");
    if (this.directoryIdentity && (dir.dev !== this.directoryIdentity.dev || dir.ino !== this.directoryIdentity.ino)) throw new Error("Push directory replaced");
    this.directoryIdentity ??= { dev: dir.dev, ino: dir.ino };
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const stat = lstatSync(join(this.directory, `outbox.sqlite${suffix}`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
          || typeof process.getuid === "function" && stat.uid !== process.getuid()
          || stat.size > (suffix === "-shm" ? 1024 * 1024 : 64 * 1024 * 1024)) throw new Error("Unsafe push database file");
        if (!suffix && this.fileIdentity && (stat.dev !== this.fileIdentity.dev || stat.ino !== this.fileIdentity.ino)) throw new Error("Push database replaced");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !suffix && this.fileIdentity) throw error;
      }
    }
  }
  private open(): void {
    const root = resolve(this.options.dataDir), rootStat = lstatSync(root);
    if (root !== this.options.dataDir || realpathSync(root) !== root || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (rootStat.mode & 0o022) !== 0 || typeof process.getuid === "function" && rootStat.uid !== process.getuid()) throw new Error("Unsafe data directory");
    this.directory = join(root, "chrome-push");
    try { mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.assertFiles();
    const path = join(this.directory, "outbox.sqlite");
    let fresh = false;
    try {
      const stat = lstatSync(path);
      if (stat.size === 0) throw new Error("Incomplete push database requires reconciliation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try { lstatSync(path + suffix); throw new Error("Orphaned push database sidecar"); }
        catch (sidecarError) { if ((sidecarError as NodeJS.ErrnoException).code !== "ENOENT") throw sidecarError; }
      }
      const fd = openSync(path, "wx", 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(this.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
      fresh = true;
    }
    const stat = lstatSync(path);
    this.fileIdentity = { dev: stat.dev, ino: stat.ino };
    this.assertFiles();
    // Attach the handle immediately so every subsequent initialization failure
    // is closed by start(), including malformed schemas or VAPID material.
    const db = this.db = new Database(path, { create: false, strict: true });
    db.exec("PRAGMA busy_timeout = 250; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    if (!fresh) {
      if (db.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id !== APPLICATION_ID
        || db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== SCHEMA_VERSION
        || db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()?.quick_check !== "ok") throw new Error("Invalid push database");
    }
    if (fresh) {
      const keys = webPush.generateVAPIDKeys();
      db.transaction(() => {
        db.exec(`
          PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE subscriptions (
            id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
            p256dh TEXT NOT NULL, auth TEXT NOT NULL, expiration INTEGER,
            enrolled INTEGER NOT NULL, epoch TEXT NOT NULL, after_seq INTEGER NOT NULL CHECK (after_seq >= 0)
          );
          CREATE INDEX subscription_owner ON subscriptions(owner);
          CREATE TABLE deliveries (
            id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
            payload TEXT NOT NULL, expires INTEGER NOT NULL, next_attempt INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND ${MAX_ATTEMPTS}),
            state INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0, 1))
          );
          CREATE INDEX delivery_due ON deliveries(state, next_attempt);
          CREATE INDEX delivery_expiry ON deliveries(expires);
          CREATE INDEX delivery_device ON deliveries(device);
        `);
        const put = db.query("INSERT INTO meta (key, value) VALUES (?, ?)");
        put.run("storeId", this.options.storeId); put.run("schema", String(SCHEMA_VERSION));
        put.run("publicKey", keys.publicKey); put.run("privateKey", keys.privateKey);
      }).immediate();
    }
    if (this.meta("storeId") !== this.options.storeId || this.meta("schema") !== String(SCHEMA_VERSION)) throw new Error("Push store identity mismatch");
    const publicKey = this.meta("publicKey"), privateKey = this.meta("privateKey");
    const pub = keyBytes(publicKey, 65), priv = keyBytes(privateKey, 32);
    if (!pub || !priv) throw new Error("Invalid VAPID keys");
    const curve = createECDH("prime256v1"); curve.setPrivateKey(priv);
    if (!curve.getPublicKey().equals(pub)) throw new Error("VAPID pair mismatch");
    this.vapid = { publicKey: publicKey!, privateKey: privateKey! };
    this.cursor();
    // Local validation only; no global web-push configuration shared with others.
    webPush.getVapidHeaders("https://fcm.googleapis.com", this.subject(), publicKey!, privateKey!, "aes128gcm");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA max_page_count = 16384; PRAGMA wal_autocheckpoint = 128; PRAGMA journal_size_limit = 1048576;");
    this.assertFiles();
    const devices = this.devices();
    if (devices.length > MAX_DEVICES || this.budget().records > MAX_RECORDS || this.budget().pending > MAX_PENDING) throw new Error("Push database exceeds capacity");
    for (const device of devices) {
      // Expired devices are valid persisted records and are removed by maintenance.
      const sub = subscription(device); sub.expirationTime = null;
      if (!validSubscription(sub) || !Number.isSafeInteger(device.enrolled) || device.enrolled <= 0
        || !Number.isSafeInteger(device.after_seq) || device.after_seq < 0 || typeof device.epoch !== "string" || !device.epoch || device.epoch.length > 1024
        || !/^[0-9a-f-]{36}$/.test(device.id) || !/^[A-Za-z0-9_-]{43}$/.test(device.owner)
        || device.expiration !== null && (!Number.isSafeInteger(device.expiration) || device.expiration <= 0)) throw new Error("Invalid stored push device");
    }
    for (const row of db.query<Delivery & { state: number; next_attempt: number }, []>("SELECT * FROM deliveries").all()) {
      const payload: unknown = JSON.parse(row.payload);
      if (!isPushPayload(payload) || payload.storeId !== this.options.storeId
        || !/^[A-Za-z0-9_-]{43}$/.test(row.id) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS
        || !Number.isSafeInteger(row.next_attempt) || row.next_attempt < 0 || row.state !== 0 && row.state !== 1
        || !Number.isSafeInteger(row.expires) || row.expires !== payload.createdAt + LIFETIME) throw new Error("Invalid stored push delivery");
    }
    const foreign = db.query("PRAGMA foreign_key_check").get();
    if (foreign) throw new Error("Invalid push device relationship");
  }

  private subject(): string {
    const fallback = "mailto:push@sane.invalid", subject = this.options.subject ?? fallback;
    // Apple rejects HTTPS localhost VAPID subjects even for otherwise valid
    // subscriptions. A local App origin is not a public operator contact URL.
    // Keep a configured mailto/public HTTPS subject; avoid inventing accounts.
    const url = new URL(subject);
    if (url.protocol === "https:") {
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host)
        || host === "0.0.0.0" || host === "::" || host === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return fallback;
    }
    return subject;
  }
  private meta(key: string): string | undefined {
    return this.db!.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }
  private putMeta(key: string, value: string): void {
    this.db!.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  private cursor(): ConversationUpdateCursor | undefined {
    const value = this.meta("cursor");
    if (value === undefined) return;
    const cursor: unknown = JSON.parse(value);
    if (!object(cursor) || !only(cursor, ["epoch", "after"]) || typeof cursor.epoch !== "string" || !cursor.epoch || cursor.epoch.length > 1024
      || !Number.isSafeInteger(cursor.after) || (cursor.after as number) < 0) throw new Error("Invalid push cursor");
    return cursor as ConversationUpdateCursor;
  }
  private alignCursor(): ConversationUpdateCursor | undefined {
    const head = this.options.feed.getHead();
    if (!head) { this.problem = "feed_unavailable"; return; }
    if (head.storeId !== this.options.storeId) throw new Error("Push feed identity mismatch");
    const cursor = this.cursor();
    if (!cursor || cursor.epoch !== head.epoch || cursor.after < head.retainedAfter || cursor.after > head.through) {
      const gap = !!cursor;
      // Never bootstrap a retained snapshot into a backlog flood after a gap.
      const next = { epoch: head.epoch, after: head.through };
      this.db!.transaction(() => {
        this.putMeta("cursor", JSON.stringify(next));
        if (gap) this.db!.query("UPDATE subscriptions SET epoch = ?, after_seq = ?, enrolled = ?")
          .run(head.epoch, head.through, Date.now());
      }).immediate();
      if (gap) { this.counters.cursorGaps++; this.problem = "feed_gap_rebaselined"; }
      return next;
    }
    return cursor;
  }
  private devices(): Device[] { return this.db!.query<Device, []>(`SELECT * FROM subscriptions LIMIT ${MAX_DEVICES + 1}`).all(); }
  private budget(): { pending: number; records: number } {
    const db = this.db!;
    return { pending: db.query<{ n: number }, []>("SELECT count(*) AS n FROM deliveries WHERE state = 0").get()!.n,
      records: db.query<{ n: number }, []>("SELECT count(*) AS n FROM deliveries").get()!.n };
  }
  private enqueue(device: Device, payload: PushPayload, identity: string, budget: { pending: number; records: number }): void {
    const now = Date.now(), expires = payload.createdAt + LIFETIME;
    if (expires <= now || device.expiration !== null && device.expiration <= now) return;
    if (!isPushPayload(payload) || payload.storeId !== this.options.storeId) throw new Error("Invalid push payload");
    const id = digest(JSON.stringify([device.id, identity]));
    if (this.db!.query("SELECT id FROM deliveries WHERE id = ?").get(id)) return;
    if (budget.pending >= MAX_PENDING || budget.records >= MAX_RECORDS) throw new CapacityError();
    this.db!.query("INSERT INTO deliveries (id, device, payload, expires, next_attempt) VALUES (?, ?, ?, ?, ?)")
      .run(id, device.id, JSON.stringify(payload), expires, now);
    budget.pending++; budget.records++;
  }
  private isEligible(payload: PushPayload): boolean {
    if (payload.kind === "test") return true;
    try { return !!payload.conversationId && !!payload.source && this.options.eligible(payload.conversationId, payload.source); }
    catch { return false; }
  }
  private withPresentation(payload: PushPayload): PushPayload {
    if (payload.kind === "test" || !this.options.presentation || !payload.conversationId || !payload.source) return payload;
    const base = { ...payload };
    delete base.sessionTitle; delete base.workspaceName;
    try {
      const presentation = this.options.presentation(payload.conversationId, payload.source);
      const sessionTitle = normalizePushNotificationLabel(presentation.sessionTitle, PUSH_SESSION_TITLE_MAX_CHARACTERS);
      const workspaceName = normalizePushNotificationLabel(presentation.workspaceName, PUSH_WORKSPACE_NAME_MAX_CHARACTERS);
      const enriched = { ...base, ...(sessionTitle ? { sessionTitle } : {}), ...(workspaceName ? { workspaceName } : {}) };
      // Labels are optional encrypted presentation, never an outbox/device failure.
      return isPushPayload(enriched) ? enriched : base;
    } catch { return base; }
  }
  private consumeFeed(): boolean {
    const cursor = this.alignCursor();
    if (!cursor) return false;
    const head = this.options.feed.getHead();
    // An idle dispatcher must not rewrite its cursor or fsync the WAL every
    // second. Only newly committed source changes enter an outbox transaction.
    if (!head || cursor.epoch === head.epoch && cursor.after === head.through) return false;
    // Even a full page fanned out to every device must fit an empty outbox.
    const page = this.options.feed.page({ cursor, limit: 32 }, false, []);
    const devices = this.devices();
    try {
      this.db!.transaction(() => {
        const budget = this.budget();
        for (const update of page.updates) {
          if (update.historical || update.sequence !== update.occurrenceSequence) continue;
          const createdAt = Date.parse(update.occurredAt ?? update.observedAt);
          if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now() + 60_000) continue;
          // The occurrence already contains its qualified native source/boundary.
          // A derived feed epoch must not change external dedup identity.
          const identity = JSON.stringify(["feed", update.id]);
          const payload: PushPayload = { version: 1, storeId: this.options.storeId, id: digest(identity),
            kind: update.kind, createdAt, conversationId: update.conversationId, source: update.source };
          if (!this.isEligible(payload)) continue;
          for (const device of devices) {
            if (device.epoch === page.epoch && update.occurrenceSequence > device.after_seq && createdAt >= device.enrolled)
              this.enqueue(device, payload, identity, budget);
          }
        }
        // All device deliveries and the source position commit together.
        this.putMeta("cursor", JSON.stringify(page.nextCursor));
      }).immediate();
      return page.hasMore;
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
      this.counters.capacityPauses++; this.problem = "capacity_paused"; return false;
    }
  }
  private completion(session: Session, run: Run, event: Event): Completion | undefined {
    if (session.harness !== "opencode" || session.hidden || session.agentKind === "worker" || run.agentKind === "worker"
      || run.operation === "compact" || run.compact || run.status !== "completed" || event.kind !== "status"
      || !object(event.data) || event.data.status !== "completed" || event.data.nativeHistoryImportedAt !== undefined
      || event.data.historyRefreshFailed !== undefined || event.data.reconciliation !== undefined || run.sessionId !== session.sessionId
      || event.sessionId !== session.sessionId || event.runId !== run.runId || !Number.isSafeInteger(event.seq) || event.seq < 1) return;
    const source = { harness: session.harness, authorityId: session.authorityId, nativeSessionId: session.nativeSessionId };
    if (!isConversationUpdateSource(source)) return;
    const createdAt = Date.parse(event.time);
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now() + 60_000) return;
    const identity = JSON.stringify(["app-completed", updateSourceKey(source), run.runId]);
    const payload: PushPayload = { version: 1, storeId: this.options.storeId, id: digest(identity), kind: "completed",
      createdAt, conversationId: session.sessionId, source };
    if (!isPushPayload(payload)) return;
    return { identity, payload };
  }
  private enqueueCompletion(item: Completion): boolean {
    if (item.payload.createdAt + LIFETIME <= Date.now() || !this.isEligible(item.payload)) return true;
    try {
      this.db!.transaction(() => {
        const budget = this.budget();
        for (const device of this.devices()) if (item.payload.createdAt >= device.enrolled)
          this.enqueue(device, item.payload, item.identity, budget);
      }).immediate();
      return true;
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
      this.counters.capacityPauses++; this.problem = "capacity_paused"; return false;
    }
  }
  private consumeCompletions(): boolean {
    // A single startup iterator, never repeated per device, network retry or tick.
    // Retain the item on capacity failure; its source is also durable in journals.
    let scanned = 0;
    for (const [key, item] of this.completions) {
      if (scanned >= 100) return true;
      scanned++;
      if (!this.enqueueCompletion(item)) return false;
      this.completions.delete(key);
    }
    while (this.recovery && scanned < 100) {
      scanned++;
      if (!this.recoveryItem) {
        let next: IteratorResult<ChromePushRecoveryRecord>;
        try { next = this.recovery.next(); }
        catch {
          this.counters.recoveryErrors++; this.recovery = undefined;
          this.fail("completion_recovery_failed_requires_restart"); return false;
        }
        if (next.done) { this.recovery = undefined; return false; }
        if (next.value === null) continue;
        this.recoveryItem = this.completion(next.value.session, next.value.run, next.value.event);
        if (!this.recoveryItem) continue;
      }
      if (!this.enqueueCompletion(this.recoveryItem)) return false;
      this.recoveryItem = undefined;
    }
    return !!this.recovery || this.completions.size > 0;
  }
  private abortDevice(id: string): void {
    for (const item of this.active.values()) if (item.device === id) item.controller.abort();
  }
  private removeDevice(id: string): void {
    this.db!.query("DELETE FROM subscriptions WHERE id = ?").run(id);
    this.abortDevice(id);
  }
  private maintain(): void {
    const now = Date.now();
    for (const device of this.db!.query<{ id: string }, [number]>("SELECT id FROM subscriptions WHERE expiration IS NOT NULL AND expiration <= ?").all(now)) this.removeDevice(device.id);
    this.db!.query("DELETE FROM deliveries WHERE expires <= ?").run(now);
    this.assertFiles();
  }
  private schedule(delay: number): void {
    if (!this.started || !this.available || this.closed) return;
    const at = Date.now() + delay;
    if (this.timer && this.wakeAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.wakeAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; this.wakeAt = Infinity; this.turn(); }, delay);
    this.timer.unref?.();
  }
  private turn(): void {
    if (!this.available || this.closed || !this.db) return;
    try {
      const now = Date.now();
      if (now >= this.nextMaintenance) { this.maintain(); this.nextMaintenance = now + 60_000; }
      if (now >= this.nextFeed) {
        // The feed can be temporarily unavailable without poisoning a healthy
        // outbox. Existing retries continue, and the cursor remains unchanged.
        if (this.options.feed.getHealth().state === "ready") {
          this.nextFeed = now + (this.consumeFeed() ? 0 : FEED_INTERVAL);
        } else { this.problem = "feed_unavailable"; this.nextFeed = now + FEED_INTERVAL; }
      }
      if (now >= this.nextRecovery) this.nextRecovery = now + (this.consumeCompletions() ? 0 : FEED_INTERVAL);
      this.launchDue();
      let next = Math.min(this.nextFeed, this.nextRecovery, this.nextMaintenance);
      if (this.active.size < 2) {
        const excluded = [...this.active.keys()];
        const due = this.db.query<{ next_attempt: number }, (string | number)[]>(
          `SELECT next_attempt FROM deliveries WHERE state = 0 AND expires > ?${excluded.length ? ` AND id NOT IN (${excluded.map(() => "?").join(",")})` : ""} ORDER BY next_attempt LIMIT 1`
        ).get(Date.now(), ...excluded);
        if (due) next = Math.min(next, due.next_attempt);
      }
      this.schedule(Math.max(0, next - Date.now()));
    } catch { this.fail("storage_unavailable"); }
  }
  private launchDue(): void {
    if (!this.available || this.closed || this.active.size >= 2) return;
    // At most two active IDs need excluding; no per-device polling or JSON feed writes.
    const excluded = [...this.active.keys()];
    const sql = `SELECT id, device, payload, expires, attempts FROM deliveries WHERE state = 0 AND next_attempt <= ? AND expires > ?${excluded.length ? ` AND id NOT IN (${excluded.map(() => "?").join(",")})` : ""} ORDER BY next_attempt LIMIT ?`;
    const rows = this.db!.query<Delivery, (string | number)[]>(sql).all(Date.now(), Date.now(), ...excluded, 2 - this.active.size);
    for (const row of rows) {
      const controller = new AbortController();
      // The deferred promise registers active state before any request starts.
      const promise = Promise.resolve().then(() => this.send(row, controller)).catch(() => this.fail("storage_unavailable")).finally(() => {
        this.active.delete(row.id); this.schedule(0);
      });
      this.active.set(row.id, { device: row.device, controller, promise });
    }
  }
  private async send(row: Delivery, controller: AbortController): Promise<void> {
    if (!this.available || this.closed || !this.db || !this.vapid) return;
    const db = this.db;
    const device = db.query<Device, [string]>("SELECT * FROM subscriptions WHERE id = ?").get(row.device);
    if (!device) return;
    if (device.expiration !== null && device.expiration <= Date.now()) { this.removeDevice(device.id); return; }
    const payload: unknown = JSON.parse(row.payload);
    if (!isPushPayload(payload) || payload.storeId !== this.options.storeId) throw new Error("Invalid stored payload");
    if (!this.isEligible(payload) || row.expires <= Date.now()) { this.finish(row.id); return; }
    if (row.attempts >= MAX_ATTEMPTS) { this.finish(row.id); return; }
    // Resolve current names for old queued deliveries and retries, after eligibility.
    // This callback is synchronous; it adds no gap to the existing send fences.
    const serializedPayload = JSON.stringify(this.withPresentation(payload));
    let details: ReturnType<typeof webPush.generateRequestDetails>;
    let headers: Headers;
    try {
      if (!validEndpoint(device.endpoint)) throw new Error("Invalid stored endpoint");
      details = webPush.generateRequestDetails(subscription(device), serializedPayload, {
        vapidDetails: { ...this.vapid, subject: this.subject() }, contentEncoding: "aes128gcm", urgency: "normal",
        TTL: Math.max(1, Math.ceil((row.expires - Date.now()) / 1000)), topic: row.id.slice(0, 32),
      });
      if (details.endpoint !== device.endpoint || details.method !== "POST") throw new Error("Unexpected request target");
      headers = new Headers(details.headers);
      if (new URL(device.endpoint).hostname === "web.push.apple.com") {
        // Apple requires not refreshing the transmitted VAPID JWT more than
        // once per hour. Encryption remains fresh for every delivery; only
        // authorization for this single pinned vendor origin is cached.
        const now = Date.now();
        if (!this.appleVapid || now >= this.appleVapid.renewAt) this.appleVapid = {
          authorization: webPush.getVapidHeaders("https://web.push.apple.com", this.subject(),
            this.vapid.publicKey, this.vapid.privateKey, "aes128gcm").Authorization,
          renewAt: now + 60 * 60 * 1000,
        };
        headers.set("Authorization", this.appleVapid.authorization);
      }
    } catch {
      this.counters.permanentFailures++; this.removeDevice(device.id); return;
    }
    const attempt = row.attempts + 1;
    // Count the attempt before network I/O; process death cannot create an
    // unlimited retry loop. Reserve its retry time before handing it to fetch.
    const reserve = Date.now() + this.backoff(attempt);
    db.query("UPDATE deliveries SET attempts = ?, next_attempt = ? WHERE id = ? AND state = 0").run(attempt, reserve, row.id);
    const signal = AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT), this.shutdown.signal, controller.signal]);
    let status: number | undefined, retryAfter: string | null = null;
    try {
      // No await between final eligibility check and initiating the request.
      if (signal.aborted || !this.available || !this.isEligible(payload)) { this.finish(row.id); return; }
      const result = await fetch(details.endpoint, { method: "POST", headers,
        body: details.body as unknown as BodyInit, redirect: "error", signal });
      status = result.status; retryAfter = result.headers.get("retry-after");
      // Never buffer arbitrary service responses (which may contain secrets).
      if (result.body) void result.body.cancel().catch(() => undefined);
    } catch { /* Deadline/network/redirect failure: bounded retry of the same ID. */ }
    if (this.closed || !this.available || this.db !== db || controller.signal.aborted || this.shutdown.signal.aborted) return;
    if (status !== undefined && status >= 200 && status < 300) { this.counters.accepted++; this.finish(row.id); return; }
    if (status === 404 || status === 410) { this.counters.expiredDevices++; this.removeDevice(device.id); return; }
    if (status !== undefined && status < 500 && status !== 429) {
      this.counters.permanentFailures++; this.finish(row.id); return;
    }
    if (attempt >= MAX_ATTEMPTS || row.expires <= Date.now()) { this.counters.permanentFailures++; this.finish(row.id); return; }
    const next = Date.now() + Math.max(this.backoff(attempt), this.retryAfter(retryAfter));
    db.query("UPDATE deliveries SET next_attempt = ? WHERE id = ? AND state = 0").run(Math.min(next, row.expires), row.id);
    this.counters.retries++;
  }
  private finish(id: string): void {
    // Keep the dedup identity until the occurrence expires, not just until send.
    this.db!.query("UPDATE deliveries SET state = 1 WHERE id = ?").run(id);
  }
  private backoff(attempt: number): number {
    return Math.min(MAX_BACKOFF, 5000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.25);
  }
  private retryAfter(value: string | null): number {
    if (!value || value.length > 128) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, Math.min(MAX_BACKOFF, delay)) : 0;
  }
  private fail(problem: string): void {
    this.available = false; this.problem = problem;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.wakeAt = Infinity;
    for (const item of this.active.values()) item.controller.abort();
  }
}
