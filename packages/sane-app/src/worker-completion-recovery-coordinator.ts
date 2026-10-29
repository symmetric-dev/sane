import type { DispatchReadiness, DispatchSource } from "../shared/conversation/dispatch-contract";

/** Only an original lifecycle (or explicitly classified durable startup evidence)
 * may provide settlement proof. A status refresh is not a trigger or a proof. */
export type WorkerCompletionRecoveryCandidate = Readonly<{
  runId: string;
  source: DispatchSource;
  successfulSettlement: () => Promise<DispatchReadiness>;
}>;

export const WORKER_COMPLETION_REMINDER = [
  "App-owned worker completion recovery (not parent guidance).",
  "Your previous turn ended without completing the assignment or declaring a wait.",
  "Do not replay the original task. If finished, discover and use the worker_complete tool with your full result.",
  "Otherwise use the allowed wait or consultation operations, or report the blocker through worker_complete with a failed outcome.",
].join("\n");

/** Event-driven, single-flight and coalesced. No timer, store subscription, or
 * presentation/read entry point. A blocked candidate remains dormant until an
 * explicit lifecycle/operational event, never its own diagnostic write. */
export class WorkerCompletionRecoveryCoordinator {
  private readonly candidates = new Map<string, WorkerCompletionRecoveryCandidate>();
  private readonly dirty = new Set<string>();
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;

  constructor(private readonly ports: {
    available: () => boolean;
    reconsider: (candidate: WorkerCompletionRecoveryCandidate, isCurrent: () => boolean, signal: AbortSignal) => Promise<void>;
    onError: (error: unknown) => void;
  }) {}

  has(sessionId: string): boolean { return this.candidates.has(sessionId); }

  track(candidate: WorkerCompletionRecoveryCandidate, done?: Promise<void>): void {
    if (this.shutdown.signal.aborted) return;
    this.candidates.set(candidate.source.sessionId, candidate);
    if (done) void done.then(() => {
      if (this.candidates.get(candidate.source.sessionId) === candidate) this.notify(candidate.source.sessionId);
    }, this.ports.onError);
    else this.notify(candidate.source.sessionId);
  }

  /** Omit the session only for an explicit cross-session operational event. */
  notify(sessionId?: string): void {
    if (this.shutdown.signal.aborted) return;
    if (sessionId) { if (this.candidates.has(sessionId)) this.dirty.add(sessionId); }
    else for (const id of this.candidates.keys()) this.dirty.add(id);
    if (!this.task && this.dirty.size && this.ports.available()) {
      const task = Promise.resolve().then(() => this.drain());
      this.task = task;
      void task.finally(() => {
        this.task = undefined;
        if (this.dirty.size && !this.shutdown.signal.aborted && this.ports.available()) this.notify();
      }).catch(this.ports.onError);
    }
  }

  private async drain(): Promise<void> {
    while (this.dirty.size && !this.shutdown.signal.aborted && this.ports.available()) {
      const id = this.dirty.values().next().value!;
      this.dirty.delete(id);
      const candidate = this.candidates.get(id);
      if (!candidate) continue;
      const isCurrent = () => !this.shutdown.signal.aborted && this.ports.available() && this.candidates.get(id) === candidate;
      try { await this.ports.reconsider(candidate, isCurrent, this.shutdown.signal); }
      catch (error) { this.ports.onError(error); }
    }
  }

  close(): Promise<void> {
    this.shutdown.abort(); this.dirty.clear(); this.candidates.clear();
    return this.task ?? Promise.resolve();
  }
}
