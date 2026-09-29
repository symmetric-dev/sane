import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export class OwnershipError extends Error {
  constructor(readonly code: "INVALID_PATH" | "OWNER_BUSY" | "OWNER_STALE" | "OWNER_MALFORMED" | "OWNER_UNVERIFIABLE" | "RECONCILIATION_GATE" | "OWNER_CHANGED", message: string) { super(message); }
}
export type OwnershipPaths = Readonly<{ packageDir: string; dataDir?: string; installationLock: string; dataLock?: string }>;
export type OwnerRecord = {
  format: "sane-app-owner"; version: 1; kind: "installation" | "data";
  pid: number; processStart: string; token: string; packageDir: string; dataDir: string | null;
  phase: "setup" | "build" | "starting" | "serving" | "draining" | "retained";
  listener: { host: string; port: number } | null;
};
type ProcessEvidence = { state: "live"; start: string } | { state: "dead" } | { state: "unverifiable" };
const fail = (code: OwnershipError["code"], message: string): never => { throw new OwnershipError(code, message); };
function stat(path: string) {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
/** Canonicalize existing ancestors, but refuse a selected symlink leaf or wrong type. No writes. */
function directory(path: string, mustExist = false): string {
  const absolute = resolve(path), info = stat(absolute);
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) fail("INVALID_PATH", `Not a non-symlink directory: ${absolute}`);
    return realpathSync(absolute);
  }
  if (mustExist) fail("INVALID_PATH", `Missing directory: ${absolute}`);
  const parent = dirname(absolute);
  if (parent === absolute) fail("INVALID_PATH", `Unavailable root: ${absolute}`);
  // Ancestor aliases are canonicalized so every client uses the same lock name.
  let canonicalParent: string;
  if (stat(parent)) canonicalParent = realpathSync(parent);
  else canonicalParent = directory(parent);
  return join(canonicalParent, basename(absolute));
}
export function validateOwnershipPaths(packageDir: string, dataDir?: string): OwnershipPaths {
  const pkg = directory(packageDir, true);
  const runtime = join(pkg, ".runtime"); directory(runtime);
  const data = dataDir === undefined ? undefined : directory(dataDir);
  if (data && dirname(data) === data) fail("INVALID_PATH", "App data cannot be a filesystem root");
  return Object.freeze({ packageDir: pkg, ...(data ? { dataDir: data, dataLock: join(dirname(data), `.${basename(data)}.sane-app.lock`) } : {}), installationLock: join(runtime, "installation.lock") });
}

/** Never signals a process except a zero-signal existence check; uncertainty blocks reclamation. */
export function processEvidence(pid: number): ProcessEvidence {
  try { process.kill(pid, 0); } catch (e) { return { state: (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unverifiable" }; }
  try {
    // lstart is stable across this process lifetime (not elapsed time or PID alone).
    const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return start ? { state: "live", start } : { state: "unverifiable" };
  } catch { return { state: "unverifiable" }; }
}
function validateRecord(value: unknown): OwnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("OWNER_MALFORMED", "Malformed ownership record");
  const r = value as OwnerRecord;
  const keys = ["format", "version", "kind", "pid", "processStart", "token", "packageDir", "dataDir", "phase", "listener"];
  if (Object.keys(r).sort().join() !== keys.sort().join() || r.format !== "sane-app-owner" || r.version !== 1 || !["installation", "data"].includes(r.kind) || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.processStart !== "string" || !r.processStart.trim() || typeof r.token !== "string" || !/^[0-9a-f-]{36}$/.test(r.token) || typeof r.packageDir !== "string" || !r.packageDir.startsWith("/") || !(r.dataDir === null || typeof r.dataDir === "string" && r.dataDir.startsWith("/")) || !["setup", "build", "starting", "serving", "draining", "retained"].includes(r.phase)) fail("OWNER_MALFORMED", "Malformed ownership record");
  if (r.listener !== null && (!r.listener || Object.keys(r.listener).sort().join() !== "host,port" || typeof r.listener.host !== "string" || !r.listener.host || !Number.isInteger(r.listener.port) || r.listener.port < 0 || r.listener.port > 65535)) fail("OWNER_MALFORMED", "Malformed listener evidence");
  return r;
}
function readOwner(lock: string): OwnerRecord {
  const info = stat(lock), ownerPath = join(lock, "owner.json"), ownerInfo = stat(ownerPath);
  if (!info?.isDirectory() || info.isSymbolicLink() || !ownerInfo?.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1) fail("OWNER_MALFORMED", `Malformed ownership at ${lock}`);
  try { return validateRecord(JSON.parse(readFileSync(ownerPath, "utf8"))); }
  catch (e) { if (e instanceof OwnershipError) throw e; return fail("OWNER_MALFORMED", `Malformed ownership at ${lock}`); }
}
function samePaths(record: OwnerRecord, paths: OwnershipPaths, kind: OwnerRecord["kind"]): boolean {
  // A data guard may belong to another installation. Its installation must still be
  // canonical; data identity, not the requesting package, governs shared-data exclusion.
  if (record.kind !== kind || record.packageDir !== resolve(record.packageDir) || record.dataDir !== (kind === "data" ? paths.dataDir : null)) return false;
  if (kind === "installation") return record.packageDir === paths.packageDir;
  try { return realpathSync(record.packageDir) === record.packageDir; } catch { return false; }
}
function withGate<T>(lock: string, body: () => T): T {
  const gate = `${lock}.reconcile-gate`;
  try { mkdirSync(gate, { mode: 0o700 }); } catch { return fail("RECONCILIATION_GATE", `Ownership gate blocks acquisition/reconciliation: ${gate}`); }
  const identity = lstatSync(gate);
  try { return body(); }
  finally {
    const current = stat(gate);
    if (!current || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) fail("OWNER_CHANGED", `Ownership gate changed: ${gate}`);
    rmdirSync(gate);
  }
}
function removeOwned(lock: string, token: string): void {
  if (readOwner(lock).token !== token) fail("OWNER_CHANGED", `Owner token changed: ${lock}`);
  unlinkSync(join(lock, "owner.json"));
  // Deliberately not recursive: unknown residue is never destroyed.
  rmdirSync(lock);
}

const issuedHandles = new WeakSet<OwnershipHandle>();
/** Reject constructor/structural forgeries; verify current durable ownership as well. */
export function assertInstallationOwnership(handle: OwnershipHandle, packageDir: string): void {
  if (!issuedHandles.has(handle)) fail("OWNER_CHANGED", "Installation handle was not issued by acquisition");
  OwnershipHandle.prototype.assertOwned.call(handle);
  const owner = handle.owner;
  if (owner.kind !== "installation" || owner.pid !== process.pid || owner.packageDir !== realpathSync(packageDir) || owner.phase === "retained") fail("OWNER_CHANGED", "Not current installation ownership");
}
export class OwnershipHandle {
  private released = false;
  private retained = false;
  private readonly ownedToken: string;
  constructor(readonly paths: OwnershipPaths, readonly lock: string, private record: OwnerRecord) { this.ownedToken = record.token; }
  get owner(): Readonly<OwnerRecord> { return structuredClone(this.record); }
  assertOwned(): void {
    const fresh = validateOwnershipPaths(this.paths.packageDir, this.paths.dataDir);
    if (JSON.stringify(fresh) !== JSON.stringify(this.paths)) fail("OWNER_CHANGED", "Ownership paths changed");
    if (this.released || readOwner(this.lock).token !== this.ownedToken) fail("OWNER_CHANGED", `Ownership no longer held: ${this.lock}`);
  }
  update(phase: OwnerRecord["phase"], listener: OwnerRecord["listener"] = this.record.listener): void {
    withGate(this.lock, () => {
      this.assertOwned();
      const next = validateRecord({ ...this.record, phase, listener });
      const temporary = join(this.lock, `owner.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      this.assertOwned(); renameSync(temporary, join(this.lock, "owner.json")); this.record = next;
    });
  }
  /** Failed drain leaves durable ownership. Only explicit proven-dead reconciliation can reclaim it. */
  retain(): void { this.update("retained"); this.retained = true; }
  release(): void {
    if (this.released || this.retained) return;
    withGate(this.lock, () => { this.assertOwned(); removeOwned(this.lock, this.ownedToken); this.released = true; });
  }
}
export type AcquireOptions = { phase: OwnerRecord["phase"]; reconcileInterrupted?: boolean; createDataParent?: boolean };

function acquire(paths: OwnershipPaths, kind: OwnerRecord["kind"], options: AcquireOptions): OwnershipHandle {
  // Revalidate after any setup parent creation and before every acquisition.
  const fresh = validateOwnershipPaths(paths.packageDir, paths.dataDir);
  if (JSON.stringify(fresh) !== JSON.stringify(paths)) fail("INVALID_PATH", "Ownership paths changed since validation");
  const lock = kind === "installation" ? paths.installationLock : paths.dataLock!;
  return withGate(lock, () => {
    if (stat(lock)) {
      const prior = readOwner(lock);
      if (!samePaths(prior, paths, kind)) fail("OWNER_MALFORMED", `Owner paths disagree: ${lock}`);
      const evidence = processEvidence(prior.pid);
      if (evidence.state === "unverifiable") fail("OWNER_UNVERIFIABLE", `Cannot verify ${kind} owner: ${lock}`);
      if (evidence.state === "live" && evidence.start === prior.processStart) fail("OWNER_BUSY", `Live ${kind} owner: ${lock}`);
      // A reused PID with different start evidence proves the recorded instance dead.
      if (!options.reconcileInterrupted) fail("OWNER_STALE", `Stale ${kind} owner; explicit reconciliation required: ${lock}`);
      removeOwned(lock, prior.token);
    }
    const own = processEvidence(process.pid);
    if (own.state !== "live") throw new OwnershipError("OWNER_UNVERIFIABLE", "Cannot establish current process start evidence");
    const record: OwnerRecord = { format: "sane-app-owner", version: 1, kind, pid: process.pid, processStart: own.start, token: randomUUID(), packageDir: paths.packageDir, dataDir: kind === "data" ? paths.dataDir! : null, phase: options.phase, listener: null };
    mkdirSync(lock, { mode: 0o700 });
    // A failed write intentionally leaves a blocking partial lock, not a guessed owner.
    writeFileSync(join(lock, "owner.json"), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    const handle = new OwnershipHandle(paths, lock, record);
    issuedHandles.add(handle);
    return handle;
  });
}
/** Standalone builds hold only this handle. Pass it to builders; do not reacquire. */
export function acquireInstallation(paths: OwnershipPaths, options: AcquireOptions): OwnershipHandle {
  const fresh = validateOwnershipPaths(paths.packageDir, paths.dataDir);
  if (JSON.stringify(fresh) !== JSON.stringify(paths)) fail("INVALID_PATH", "Ownership paths changed since validation");
  mkdirSync(dirname(paths.installationLock), { recursive: true, mode: 0o700 });
  return acquire(paths, "installation", options);
}
/** Enforces installation-before-data; creation is explicit and never creates the data root. */
export function acquireData(installation: OwnershipHandle, options: AcquireOptions): OwnershipHandle {
  installation.assertOwned();
  if (installation.owner.kind !== "installation" || !installation.paths.dataDir) fail("INVALID_PATH", "Data acquisition requires an installation handle with data paths");
  const paths = installation.paths;
  if (options.createDataParent) mkdirSync(dirname(paths.dataDir!), { recursive: true, mode: 0o700 });
  directory(dirname(paths.dataDir!), true);
  return acquire(paths, "data", options);
}
