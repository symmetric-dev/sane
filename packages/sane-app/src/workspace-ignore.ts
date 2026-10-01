import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const WORKSPACE_IGNORE_MAX_RULE_LENGTH = 4096;
const MAX_SCOPES = 256, MAX_BYTES = 512 * 1024, MAX_RULES = 2000;
const MAX_BATCH = 128, MAX_PATH = 4096, MAX_FRAME = 4 * 1024 * 1024, MAX_REPLY = 2048;

/** Dedicated error: the workspace coordinator maps ignore-limit to truncation
 * and preserves cancellation/deadline errors. No workspace import cycle. */
export class WorkspaceIgnoreError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "WorkspaceIgnoreError"; }
}
const limit = () => new WorkspaceIgnoreError(413, "ignore-limit", "Ignore snapshot budget reached");
const unavailable = () => new WorkspaceIgnoreError(503, "ignore-unavailable", "Ignore evaluator is unavailable");

/** Conservative admission accounting, not a replacement gitignore parser.
 * In ignore@7, tabs and other non-ASCII whitespace are meaningful patterns. */
export function countIgnoreRules(text: string): number {
  let rules = 0;
  for (const line of text.split(/\r?\n/)) if (line && !line.startsWith("#") && !/^\uFEFF? *$/.test(line)) rules++;
  return rules;
}

export function validateIgnoreSnapshot(text: string): { rules: number } {
  if (typeof text !== "string" || text.length > MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES) throw limit();
  let rules = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || /^\uFEFF? *$/.test(line)) continue;
    if (line.length > WORKSPACE_IGNORE_MAX_RULE_LENGTH || ++rules > MAX_RULES) throw limit();
  }
  return { rules };
}

function validPath(path: string, root = false): boolean {
  return typeof path === "string" && path.length <= MAX_PATH && !/[\0\\]/.test(path)
    && (path === "" ? root : path.split("/").every(part => !!part && part !== "." && part !== ".."));
}

/** One CPU-only, killable Bun process per operation. Only already-guarded text
 * snapshots cross this boundary; this is isolation from blocking CPU, NOT an
 * OS sandbox. Shared request admission belongs to the workspace coordinator. */
export class WorkspaceIgnoreEvaluator {
  private readonly operation: { signal?: AbortSignal; deadline: number };
  private child?: Bun.Subprocess<"pipe", "pipe", "ignore">;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = Buffer.alloc(0);
  private scopes = new Set<string>();
  private bytes = 0;
  private rules = 0;
  private sequence = 0;
  private busy = false;
  private terminal?: WorkspaceIgnoreError;
  private closing?: Promise<void>;
  private rejectCurrent?: (error: WorkspaceIgnoreError) => void;

  constructor(operation: { signal?: AbortSignal; deadline?: number }) {
    // Optional controls still have a finite CPU budget. The absolute deadline
    // is captured once, never renewed by startup, registration or matching.
    this.operation = { signal: operation.signal, deadline: operation.deadline ?? Date.now() + 8000 };
    if (!Number.isFinite(this.operation.deadline)) throw unavailable();
  }

  private check(): void {
    if (this.operation.signal?.aborted) throw new WorkspaceIgnoreError(499, "search-aborted", "Search cancelled");
    if (Date.now() >= this.operation.deadline) throw new WorkspaceIgnoreError(504, "search-time-limit", "Search time budget reached");
    if (this.terminal) throw this.terminal;
  }

  private async ready(): Promise<void> {
    try { this.check(); }
    catch (error) {
      this.terminal ??= error instanceof WorkspaceIgnoreError ? error : unavailable();
      await this.stop();
      throw this.terminal;
    }
  }

  private kill(): void {
    if (!this.child) return;
    try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
    try { this.child.kill("SIGKILL"); } catch {}
  }

  private stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.kill();
    this.closing = (async () => {
      try { this.child?.stdin.end(); } catch {}
      // Reap before exposing cancellation/error to the coordinator.
      if (this.child) await this.child.exited.catch(() => {});
      try { await this.reader?.cancel(); } catch {}
      this.buffered = Buffer.alloc(0);
      this.scopes.clear();
    })();
    return this.closing;
  }

  private async reply(id: number, count?: number): Promise<boolean[]> {
    const reader = this.reader!;
    while (true) {
      if (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32BE(0);
        if (!length || length > MAX_REPLY) throw unavailable();
        if (this.buffered.length >= length + 4) {
          // Never accept trailing/unsolicited frames or late response IDs.
          if (this.buffered.length !== length + 4) throw unavailable();
          let value: unknown;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffered.subarray(4))); }
          catch { throw unavailable(); }
          this.buffered = Buffer.alloc(0);
          if (!value || typeof value !== "object") throw unavailable();
          const result = value as { id?: unknown; values?: unknown };
          if (Object.keys(result).length !== 2 || result.id !== id || !Array.isArray(result.values)
            || result.values.length !== (count ?? 0) || !result.values.every(item => typeof item === "boolean")) throw unavailable();
          return result.values;
        }
      }
      const { done, value } = await reader.read();
      if (done || this.buffered.length + value.length > MAX_REPLY + 4) throw unavailable();
      this.buffered = Buffer.concat([this.buffered, value]);
    }
  }

  private async request(message: object, count?: number): Promise<boolean[]> {
    // Reject, don't enqueue: even caller mistakes cannot create an unbounded
    // promise/message queue or concurrent stdin writes.
    if (this.busy) throw new WorkspaceIgnoreError(503, "ignore-busy", "Ignore evaluator already has an outstanding request");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        this.rejectCurrent = reject;
        const interrupt = (error: WorkspaceIgnoreError) => { this.terminal = error; this.kill(); reject(error); };
        onAbort = () => interrupt(new WorkspaceIgnoreError(499, "search-aborted", "Search cancelled"));
        this.operation.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => interrupt(new WorkspaceIgnoreError(504, "search-time-limit", "Search time budget reached")), Math.max(0, this.operation.deadline - Date.now()));
      });
      const work = async () => {
        this.check();
        if (!this.child) {
          const entrypoint = fileURLToPath(new URL("./workspace-ignore-evaluator.ts", import.meta.url));
          // Absolute trusted installation entrypoint/cwd, no workspace env,
          // auto-install or .env. No shell, Git or repository/config reads.
          try {
            this.child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entrypoint], {
              cwd: dirname(entrypoint), env: { LANG: "C", LC_ALL: "C" }, detached: true,
              stdin: "pipe", stdout: "pipe", stderr: "ignore",
            });
          } catch { throw unavailable(); }
          this.reader = this.child.stdout.getReader();
          // Exactly one exit listener for the process lifetime, not one still-
          // pending child.exited reaction retained for every completed batch.
          void this.child.exited.then(() => {
            this.terminal ??= unavailable();
            this.rejectCurrent?.(this.terminal);
          }, () => {
            this.terminal ??= unavailable();
            this.rejectCurrent?.(this.terminal);
          });
          await this.reply(0);
          this.check();
        }
        const id = ++this.sequence;
        const payload = Buffer.from(JSON.stringify({ ...message, id }));
        if (payload.length > MAX_FRAME) throw limit();
        const frame = Buffer.allocUnsafe(payload.length + 4);
        frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
        // Read and flush concurrently: neither side can block on a full pipe
        // while waiting to drain the other. Both are cancelled by process kill.
        const response = this.reply(id, count);
        // A synchronous pipe-write failure must not orphan the read promise.
        void response.catch(() => {});
        this.child.stdin.write(frame);
        const [, values] = await Promise.all([Promise.resolve(this.child.stdin.flush()), response]);
        this.check();
        return values;
      };
      const result = await Promise.race([work(), interrupted]);
      this.check();
      return result;
    } catch (error) {
      this.terminal ??= error instanceof WorkspaceIgnoreError ? error : unavailable();
      await this.stop();
      throw this.terminal;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) this.operation.signal?.removeEventListener("abort", onAbort);
      this.rejectCurrent = undefined;
      this.busy = false;
    }
  }

  async register(scopeId: string, text: string): Promise<void> {
    await this.ready();
    if (this.busy) throw new WorkspaceIgnoreError(503, "ignore-busy", "Ignore evaluator already has an outstanding request");
    if (!validPath(scopeId, true) || this.scopes.has(scopeId)) throw unavailable();
    const { rules } = validateIgnoreSnapshot(text), bytes = Buffer.byteLength(text);
    if (this.scopes.size >= MAX_SCOPES || this.bytes + bytes > MAX_BYTES || this.rules + rules > MAX_RULES) throw limit();
    await this.request({ kind: "register", scopeId, text });
    this.scopes.add(scopeId); this.bytes += bytes; this.rules += rules;
  }

  async test(scopeIds: readonly string[], candidates: readonly { path: string; directory: boolean }[]): Promise<boolean[]> {
    await this.ready();
    if (this.busy) throw new WorkspaceIgnoreError(503, "ignore-busy", "Ignore evaluator already has an outstanding request");
    if (!Array.isArray(scopeIds) || scopeIds.length > MAX_SCOPES || !Array.isArray(candidates) || candidates.length > MAX_BATCH) throw limit();
    for (let i = 0; i < scopeIds.length; i++) {
      const scope = scopeIds[i]!;
      if (!this.scopes.has(scope) || (i > 0 && (!scope || scope === scopeIds[i - 1] || (scopeIds[i - 1] && !scope.startsWith(scopeIds[i - 1] + "/"))))) throw unavailable();
    }
    if (candidates.some(candidate => !candidate || !validPath(candidate.path) || typeof candidate.directory !== "boolean"
      || scopeIds.some(scope => scope && !candidate.path.startsWith(scope + "/")))) throw unavailable();
    return this.request({ kind: "test", scopeIds, candidates: candidates.map(({ path, directory }) => ({ path, directory })) }, candidates.length);
  }

  async close(): Promise<void> {
    this.terminal ??= unavailable();
    await this.stop();
  }
}
