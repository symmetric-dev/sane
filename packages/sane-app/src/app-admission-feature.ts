import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { decodeAppAdmissionKey } from "../shared/conversation/app-admission-contract";
import { initializeAppAdmissionService, type AppAdmissionServicePorts } from "./app-admission-service";
import { AppAdmissionRequestError, AppAdmissionStorageError } from "./app-admission-store";
import { synchronousDispatchHook } from "./dispatch-evidence";

export type AppAdmissionFeatureMarker = Readonly<{
  version: 2;
  storeId: string;
  generationId: string;
  state: "initializing" | "enabled";
}>;
export type AppAdmissionFeature = Readonly<{ state: "requires-initialization" }>
  | Readonly<{ state: "enabled"; assertCurrent(): void }>;
export type AppAdmissionFeatureSetupPorts = Pick<AppAdmissionServicePorts, "enqueue" | "assertStorage" | "failClosed">;

declare const originalRootBrand: unique symbol;
/** Process-private original-root proof, not JSON authority. Capture ONCE,
 * synchronously before startup awaits, and keep the SAME capability for feature
 * classification/setup AND receipt assertStorage. Never recapture after drift. */
export type OriginalAppAdmissionRootProof = Readonly<{
  [originalRootBrand]: true;
  /** Callback-free read-only verification; never initializes, adopts or repairs. */
  assertCurrent: () => void;
}>;

const INITIALIZING = "app-admission-feature.initializing.json";
const ENABLED = "app-admission-feature.enabled.json";
const LEGACY = "app-admission-feature.json";
const DIRECTORY = "app-admissions";
const MAX_MARKER_BYTES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Pin = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "mode" | "uid" | "nlink">;
type Snapshot = Readonly<{ pin: Pin; bytes: Buffer }>;
type Root = Readonly<{ path: string; storeId: string; pin: Pin; manifest: Snapshot }>;
type InitializedLedger = Readonly<{ pin: Pin; marker: Snapshot }>;
type OriginalRoot = {
  app: Root;
  /** Monotonic witnesses. Disappearance can never restore legacy classification. */
  observed: Set<string>;
  pins: Map<string, Pin>;
  failure?: AppAdmissionStorageError;
};
const originalRoots = new WeakMap<OriginalAppAdmissionRootProof, OriginalRoot>();

function unsafe(message: string): never { throw new AppAdmissionStorageError("corrupt", message); }
function storageError(cause: unknown): AppAdmissionStorageError {
  return cause instanceof AppAdmissionStorageError ? cause
    : new AppAdmissionStorageError("unavailable", "App admission feature storage is unavailable; no automatic repair", cause);
}
const identity = (a: Pin, b: Pin) => a.dev === b.dev && a.ino === b.ino;
const equalPin = (a: Pin, b: Pin) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs
  && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;

/** Match baseline App observation rules without imposing optional-feature
 * permissions on untouched legacy history. UID/mode are still pinned exactly. */
function baseline(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || !directory && stat.nlink !== 1) unsafe("Unsafe App root or manifest identity");
}
function secure(stat: Stats, directory: boolean): void {
  baseline(stat, directory);
  if ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || process.getuid && stat.uid !== process.getuid()) unsafe("Unsafe App admission feature permissions or identity");
}
function observedDirectory(path: string, expected?: Pin): Stats {
  const stat = lstatSync(path); baseline(stat, true);
  // Contents, size, ctime and nlink can legitimately change as App files grow.
  if (realpathSync(path) !== path || expected && (!identity(stat, expected) || stat.mode !== expected.mode || stat.uid !== expected.uid)) unsafe("App admission feature directory identity changed");
  return stat;
}
function directory(path: string, expected?: Pin): Pin {
  const stat = observedDirectory(path, expected); secure(stat, true); return stat;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw cause; }
}
function read(path: string, max: number, permissions: "feature" | "baseline" = "feature"): Snapshot {
  const check = (stat: Stats) => permissions === "feature" ? secure(stat, false) : baseline(stat, false);
  const before = lstatSync(path); check(before);
  if (before.size > max || realpathSync(path) !== path) unsafe("Unsafe or oversized App admission feature record");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); check(opened);
    if (!equalPin(before, opened) || opened.size > max) unsafe("App admission feature record changed before read");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) unsafe("App admission feature record ended during read");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) unsafe("App admission feature record grew during read");
    const after = fstatSync(fd), current = lstatSync(path); check(after); check(current);
    if (!equalPin(opened, after) || !equalPin(after, current) || bytes.length !== after.size) unsafe("App admission feature record changed during read");
    return { pin: after, bytes };
  } finally { closeSync(fd); }
}
function parsed(snapshot: Snapshot): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes)); }
  catch (cause) { throw new AppAdmissionStorageError("corrupt", "Malformed App admission feature record", cause); }
}
function record(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
}
function marker(snapshot: Snapshot, storeId: string, state: AppAdmissionFeatureMarker["state"]): AppAdmissionFeatureMarker {
  const value = parsed(snapshot);
  if (!record(value, "generationId,state,storeId,version") || value.version !== 2 || value.storeId !== storeId
    || typeof value.generationId !== "string" || !UUID.test(value.generationId) || value.state !== state) unsafe("App admission feature phase identity or schema mismatch");
  return value as AppAdmissionFeatureMarker;
}
function verify(path: string, expected: Snapshot, max: number, permissions: "feature" | "baseline" = "feature"): void {
  const current = read(path, max, permissions);
  if (!equalPin(current.pin, expected.pin) || !current.bytes.equals(expected.bytes)) unsafe("Pinned App admission feature record changed");
}
function root(path: string, storeId: string): Root {
  if (resolve(path) !== path) unsafe("App admission feature root must be canonical");
  const pin = observedDirectory(path);
  decodeAppAdmissionKey({ storeId, clientRequestId: storeId, payloadSha256: "0".repeat(64) });
  const manifest = read(join(path, "manifest.json"), 4096, "baseline"), value = parsed(manifest);
  if (!record(value, "createdAt,format,storeId,version") || value.format !== "sane-app-store" || value.version !== 1
    || value.storeId !== storeId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) unsafe("App admission feature manifest identity mismatch");
  const app = { path, storeId, pin, manifest }; checkRoot(app); return app;
}
function checkRoot(app: Root): void {
  observedDirectory(app.path, app.pin);
  verify(join(app.path, "manifest.json"), app.manifest, 4096, "baseline");
  observedDirectory(app.path, app.pin);
}
function poison(original: OriginalRoot, cause: unknown): AppAdmissionStorageError {
  original.failure ??= storageError(cause);
  return original.failure;
}
function assertRoot(original: OriginalRoot): void {
  if (original.failure) throw original.failure;
  try { checkRoot(original.app); } catch (cause) { throw poison(original, cause); }
}
/** Feature use is stricter than observing pristine legacy App history. Never
 * repin or normalize the baseline proof to make these permission checks pass. */
function assertStrictRoot(original: OriginalRoot): void {
  assertRoot(original);
  directory(original.app.path, original.app.pin);
  verify(join(original.app.path, "manifest.json"), original.app.manifest, 4096);
  directory(original.app.path, original.app.pin);
}
function activationPermissions(app: Root): boolean {
  return (app.pin.mode & 0o7777) === 0o700 && (app.manifest.pin.mode & 0o7777) === 0o600
    && (!process.getuid || app.pin.uid === process.getuid() && app.manifest.pin.uid === process.getuid());
}
function requireOriginal(dataDir: string, storeId: string, proof: OriginalAppAdmissionRootProof): OriginalRoot {
  const original = originalRoots.get(proof);
  if (!original || original.app.path !== dataDir || original.app.storeId !== storeId) unsafe("Original App root capability is missing or belongs to another installation");
  assertRoot(original); return original;
}
function featureName(name: string): boolean {
  // Reserve the entire known phase/staging namespace, including the previous
  // atomic writer's .app-admission-feature.json.<uuid>.tmp crash leftovers.
  return name === DIRECTORY || name === LEGACY || name.startsWith("app-admission-feature") || name.startsWith(".app-admission-feature");
}
/** Raw, callback-free namespace check. Only capture may witness preexisting names;
 * setup registers its own proven exclusive publications explicitly. */
function scan(original: OriginalRoot, capture = false): Set<string> {
  assertRoot(original);
  const names = new Set(readdirSync(original.app.path).filter(featureName));
  // ANY activation evidence (including staging/old markers) requires strict
  // feature root+manifest permissions; it can never take the legacy-only path.
  if (names.size) assertStrictRoot(original);
  for (const name of original.observed) if (!names.has(name)) unsafe("Observed App admission setup disappeared; explicit maintenance required");
  for (const name of names) {
    if (name !== INITIALIZING && name !== ENABLED && name !== DIRECTORY) unsafe("Unproven or staged App admission activation exists; explicit maintenance required");
    if (!original.observed.has(name) && !capture) unsafe("App admission setup appeared outside this original activation");
    const path = join(original.app.path, name), expected = original.pins.get(name);
    let stat: Pin;
    if (name === DIRECTORY) stat = directory(path, expected);
    else {
      const file = lstatSync(path); secure(file, false);
      if (expected && !equalPin(file, expected)) unsafe("Observed App admission phase identity changed");
      stat = file;
    }
    original.observed.add(name); original.pins.set(name, expected ?? stat);
  }
  assertRoot(original); return names;
}

/** MUST run synchronously after data ownership + manifest validation and BEFORE
 * assets build, stat/cwd/catalog work or any other startup await. Pin before the
 * supplied ownership callback, then finish raw verification after it. The proof
 * does not replace ongoing lock checks, write, repair, or change permissions.
 * Pristine legacy roots are observed under baseline App rules (e.g. 0755), with
 * their actual UID/mode pinned; activation evidence requires strict permissions. */
export function captureOriginalAppAdmissionRootProof(dataDir: string, storeId: string, assertStorage: () => void): OriginalAppAdmissionRootProof {
  try {
    const original: OriginalRoot = { app: root(dataDir, storeId), observed: new Set(), pins: new Map() };
    scan(original, true);
    synchronousDispatchHook(assertStorage);
    assertRoot(original); scan(original);
    const proof = Object.freeze({ assertCurrent: () => assertRoot(original) }) as OriginalAppAdmissionRootProof;
    originalRoots.set(proof, original); return proof;
  } catch (cause) { throw storageError(cause); }
}
function phase(original: OriginalRoot, name: string, snapshot: Snapshot, state: AppAdmissionFeatureMarker["state"]): AppAdmissionFeatureMarker {
  assertStrictRoot(original);
  const pin = original.pins.get(name);
  if (!pin || !equalPin(pin, snapshot.pin)) unsafe("App admission phase was not proven by the original activation");
  const value = marker(snapshot, original.app.storeId, state);
  verify(join(original.app.path, name), snapshot, MAX_MARKER_BYTES); assertRoot(original); return value;
}
function complete(original: OriginalRoot, initializing: Snapshot, enabled: Snapshot, receiptPin: Pin): void {
  const names = scan(original);
  if (names.size !== 3 || !names.has(INITIALIZING) || !names.has(ENABLED) || !names.has(DIRECTORY)) unsafe("Incomplete App admission activation; explicit maintenance required");
  const first = phase(original, INITIALIZING, initializing, "initializing"), last = phase(original, ENABLED, enabled, "enabled");
  if (first.generationId !== last.generationId) unsafe("App admission activation generations differ");
  directory(join(original.app.path, DIRECTORY), receiptPin);
  verify(join(original.app.path, INITIALIZING), initializing, MAX_MARKER_BYTES);
  verify(join(original.app.path, ENABLED), enabled, MAX_MARKER_BYTES);
  assertRoot(original); scan(original); directory(join(original.app.path, DIRECTORY), receiptPin);
}

/** Initialization-only proof of the just-created EMPTY ledger. This is captured
 * before returning to the external queue, not after its resolution await. It is
 * deliberately not a permanent feature read guard: later legitimate receipts
 * may grow the ledger, whose inventory is then owned by AppAdmissionStore. */
function initializedLedger(original: OriginalRoot): InitializedLedger {
  const pin = original.pins.get(DIRECTORY);
  if (!pin) unsafe("Strict receipt initialization did not supply its original directory witness");
  const snapshot = read(join(original.app.path, DIRECTORY, "store.json"), MAX_MARKER_BYTES), value = parsed(snapshot);
  if (!record(value, "storeId,version") || value.version !== 2 || value.storeId !== original.app.storeId) unsafe("Strict receipt initialization marker is unavailable or unproven");
  const proof = { pin, marker: snapshot };
  verifyInitializedLedger(original, proof); return proof;
}
function verifyInitializedLedger(original: OriginalRoot, proof: InitializedLedger): void {
  assertRoot(original);
  const path = join(original.app.path, DIRECTORY);
  directory(path, proof.pin);
  const names = readdirSync(path);
  if (names.length !== 1 || names[0] !== "store.json") unsafe("Fresh receipt initialization inventory changed");
  verify(join(path, "store.json"), proof.marker, MAX_MARKER_BYTES);
  directory(path, proof.pin); assertRoot(original);
  const final = readdirSync(path);
  if (final.length !== 1 || final[0] !== "store.json") unsafe("Fresh receipt initialization inventory changed after proof");
}

/** Read-only feature classification using the SAME pre-await root capability.
 * Receipt inventory/content proof remains AppAdmissionStore's responsibility. */
export function readAppAdmissionFeature(dataDir: string, storeId: string, proof: OriginalAppAdmissionRootProof): AppAdmissionFeature {
  const original = requireOriginal(dataDir, storeId, proof);
  try {
    const names = scan(original);
    if (!names.size) {
      // No fallback exists after ANY observed presence. A second scan can only
      // confirm pristine absence or fail closed on disappearance/appearance.
      if (scan(original).size) unsafe("App admission setup changed during legacy classification");
      return Object.freeze({ state: "requires-initialization" });
    }
    if (names.size !== 3 || !names.has(INITIALIZING) || !names.has(ENABLED) || !names.has(DIRECTORY)) unsafe("Incomplete App admission activation; explicit maintenance required");
    const initializing = read(join(dataDir, INITIALIZING), MAX_MARKER_BYTES), enabled = read(join(dataDir, ENABLED), MAX_MARKER_BYTES);
    const receiptPin = original.pins.get(DIRECTORY)!;
    // Namespace/phase parsing and generation agreement are startup lifecycle
    // checks. Runtime operations retain these exact immutable files and root;
    // they do not need to rediscover and reconstruct the activation protocol.
    complete(original, initializing, enabled, receiptPin);
    const assertCurrent = () => {
      try {
        assertStrictRoot(original);
        verify(join(dataDir, INITIALIZING), initializing, MAX_MARKER_BYTES);
        verify(join(dataDir, ENABLED), enabled, MAX_MARKER_BYTES);
        directory(join(dataDir, DIRECTORY), receiptPin);
      }
      catch (cause) { throw poison(original, cause); }
    };
    return Object.freeze({ state: "enabled", assertCurrent });
  } catch (cause) { throw poison(original, cause); }
}

function syncDirectory(app: Root): void {
  checkRoot(app);
  const fd = openSync(app.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd); secure(stat, true); if (!identity(stat, app.pin) || stat.mode !== app.pin.mode || stat.uid !== app.pin.uid) unsafe("App admission root changed before fsync"); fsyncSync(fd); }
  finally { closeSync(fd); }
  checkRoot(app);
}
/** Atomic no-overwrite publication. Crashed temporary links are NEVER cleaned by
 * classification/setup. Only this synchronous writer removes its proven-owned
 * transitional link on the successful path, then fsyncs the directory. */
function publish(original: OriginalRoot, name: string, value: AppAdmissionFeatureMarker, guard: () => void): Snapshot {
  const app = original.app, bytes = Buffer.from(JSON.stringify(value));
  const temporary = join(app.path, `.${name}.${randomUUID()}.tmp`), destination = join(app.path, name);
  guard(); assertStrictRoot(original);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let installed: Pin | undefined;
  try {
    secure(fstatSync(fd), false); writeFileSync(fd, bytes); fsyncSync(fd);
    const owned = fstatSync(fd), current = lstatSync(temporary); secure(owned, false); secure(current, false);
    if (!equalPin(owned, current) || owned.size !== bytes.length) unsafe("App admission feature temporary inode changed");
    guard(); assertRoot(original);
    // The callback above may have rewritten/restored the owned temporary inode.
    // Compare the FULL pre-callback pin before link legitimately changes ctime.
    const beforeLink = read(temporary, MAX_MARKER_BYTES);
    if (!equalPin(fstatSync(fd), owned) || !equalPin(beforeLink.pin, owned) || !beforeLink.bytes.equals(bytes)) unsafe("App admission feature temporary changed across its publication guard");
    linkSync(temporary, destination); // EEXIST is never overwritten or adopted.
    const linked = lstatSync(destination), retained = lstatSync(temporary), opened = fstatSync(fd);
    if (!identity(linked, owned) || !identity(retained, owned) || !identity(opened, owned)
      || linked.nlink !== 2 || retained.nlink !== 2 || opened.nlink !== 2 || linked.mode !== owned.mode || linked.uid !== owned.uid || linked.size !== bytes.length) unsafe("App admission feature exclusive link changed");
    guard(); assertRoot(original);
    if (!equalPin(lstatSync(temporary), retained)) unsafe("App admission feature temporary link changed before unlink");
    unlinkSync(temporary);
    const final = fstatSync(fd), published = lstatSync(destination); secure(final, false); secure(published, false);
    if (!equalPin(final, published) || !identity(final, owned)) unsafe("App admission feature installed inode changed");
    installed = final;
  } finally { closeSync(fd); }
  guard(); syncDirectory(app); guard();
  // LAST callback precedes full owned-inode/stamp/byte and raw-root proof.
  assertRoot(original);
  const snapshot = read(destination, MAX_MARKER_BYTES);
  if (!installed || !equalPin(installed, snapshot.pin) || !snapshot.bytes.equals(bytes)) unsafe("App admission feature publication inode, stamps or bytes changed");
  assertRoot(original); return snapshot;
}
function registerPublished(original: OriginalRoot, name: string, snapshot: Snapshot): void {
  if (original.observed.has(name)) unsafe("App admission phase cannot be published twice");
  verify(join(original.app.path, name), snapshot, MAX_MARKER_BYTES);
  original.observed.add(name); original.pins.set(name, snapshot.pin);
}

/** Explicit maintenance/CLI initialization ONLY. Callers hold existing locks and
 * pass the original pre-await root proof. Two immutable generation-correlated
 * markers OUTSIDE the deletable receipt ledger preserve activation history.
 * No overwriting phase transition, rollback, adoption, repair, or second queue. */
export async function initializeAppAdmissionFeature(dataDir: string, storeId: string, suppliedPorts: AppAdmissionFeatureSetupPorts,
  proof: OriginalAppAdmissionRootProof): Promise<void> {
  const ports = Object.freeze({ ...suppliedPorts }), original = requireOriginal(dataDir, storeId, proof);
  const alreadyInitialized = new AppAdmissionRequestError("already-initialized", "App admission feature is already enabled; it was not changed");
  const permissionsRequired = new AppAdmissionRequestError("invalid-request", "App admission activation requires an owner-controlled 0700 App directory and 0600 manifest. Explicitly correct permissions and restart before activating; no files were changed", 400);
  let failure: AppAdmissionStorageError | undefined;
  const fail = (cause: unknown) => {
    if (!failure) {
      failure = poison(original, cause);
      try { synchronousDispatchHook(() => ports.failClosed(failure!)); } catch { /* Preserve the physical/setup failure. */ }
    }
    return failure;
  };
  const assertStorage = () => {
    if (failure) throw failure;
    assertStrictRoot(original); synchronousDispatchHook(ports.assertStorage); assertStrictRoot(original);
    if (failure) throw failure;
  };
  const enqueueSync = async (action: () => void) => {
    let entered = false, completed = false;
    await ports.enqueue(async () => {
      try {
        if (entered) unsafe("App admission feature queue callback reentered");
        entered = true; synchronousDispatchHook(action); completed = true;
      } catch (cause) { throw fail(cause); }
    });
    if (failure) throw failure;
    if (!completed) unsafe("App admission feature queue callback did not finish");
  };
  try {
    if (readAppAdmissionFeature(dataDir, storeId, proof).state === "enabled") throw alreadyInitialized;
    // Expected operator refusal BEFORE generation, enqueue or any marker/store
    // creation. Mode/UID drift still fails the original proof above, not this
    // compatibility refusal; an existing proof never adopts a chmod/replacement.
    if (!activationPermissions(original.app)) throw permissionsRequired;
    assertStrictRoot(original);
    const generationId = randomUUID();
    let initializing: Snapshot | undefined, enabled: Snapshot | undefined;
    await enqueueSync(() => {
      assertStorage();
      if (scan(original).size) unsafe("App admission setup appeared before original initialization");
      initializing = publish(original, INITIALIZING, { version: 2, storeId, generationId, state: "initializing" }, assertStorage);
      registerPublished(original, INITIALIZING, initializing);
      if (scan(original).size !== 1) unsafe("Unexpected App admission setup during initial marker publication");
      phase(original, INITIALIZING, initializing, "initializing");
    });
    if (!initializing) unsafe("App admission initializing phase was not durably published");
    const ownedInitializing = initializing;
    let allowReceiptCreation = false;
    const initializingRaw = () => {
      phase(original, INITIALIZING, ownedInitializing, "initializing");
      const receiptPath = join(dataDir, DIRECTORY);
      if (present(receiptPath) && !original.observed.has(DIRECTORY)) {
        if (!allowReceiptCreation) unsafe("Receipt directory appeared outside strict initialization");
        // Observe BEFORE the dependency callback, INSIDE strict store setup. Its
        // own original directory proof must also pass; never repin after await.
        original.pins.set(DIRECTORY, directory(receiptPath)); original.observed.add(DIRECTORY);
      }
      const names = scan(original);
      if (names.has(ENABLED) || names.size !== (original.observed.has(DIRECTORY) ? 2 : 1)) unsafe("Unexpected App admission initializing namespace");
    };
    const assertInitializing = () => { initializingRaw(); assertStorage(); initializingRaw(); };
    assertInitializing();
    allowReceiptCreation = true;
    let ledger: InitializedLedger | undefined;
    try {
      await initializeAppAdmissionService(dataDir, storeId, {
        enqueue: work => ports.enqueue(async () => {
          let pending: Promise<void> | undefined;
          try {
            // initializeAppAdmissionService enters Store.initialize entirely in
            // this work callback's synchronous prefix. Capture immediately when
            // it returns, BEFORE the external queue can run a post-work callback.
            pending = work();
            if (failure) throw failure;
            if (ledger) unsafe("Strict receipt initialization callback reentered");
            ledger = initializedLedger(original);
            await pending;
            verifyInitializedLedger(original, ledger);
          } catch (cause) {
            if (pending) void pending.catch(() => {});
            throw fail(cause);
          }
        }),
        assertStorage: assertInitializing,
        failClosed: error => { fail(error); },
      });
    } finally { allowReceiptCreation = false; }
    assertInitializing();
    if (!ledger) unsafe("Strict receipt initialization did not complete its original ledger proof");
    const ownedLedger = ledger, receiptPin = ownedLedger.pin;
    verifyInitializedLedger(original, ownedLedger);
    const assertInitialPins = () => {
      phase(original, INITIALIZING, ownedInitializing, "initializing");
      verifyInitializedLedger(original, ownedLedger); assertRoot(original);
    };
    await enqueueSync(() => {
      assertInitializing();
      const guard = () => { assertInitialPins(); assertStorage(); assertInitialPins(); };
      enabled = publish(original, ENABLED, { version: 2, storeId, generationId, state: "enabled" }, guard);
      registerPublished(original, ENABLED, enabled);
      complete(original, ownedInitializing, enabled, receiptPin);
      verifyInitializedLedger(original, ownedLedger);
    });
    if (!enabled) unsafe("App admission enabled phase was not durably published");
    // The queue's resolution is another await. Final callback-free proof uses
    // ONLY original owned snapshots, not a fresh classify/capture of replacements.
    complete(original, ownedInitializing, enabled, receiptPin);
    verifyInitializedLedger(original, ownedLedger);
  } catch (cause) {
    if ((cause === alreadyInitialized || cause === permissionsRequired) && !failure && !original.failure) throw cause;
    throw fail(cause);
  }
}
