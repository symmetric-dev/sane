import type { Event, Run, Session } from "./history";
import { normalizeMessage, type NativeMessage, type OpenCodeAdapter } from "./opencode";
import { OpenCodeObservationService } from "./opencode-observation-service";
import { nativeSubagentRevision, projectNativeSubagents, type OpenCodeSubagentEvidence } from "./native-subagent-projection";

/** Optional read-only native observation, persisted separately from parent messages. */
export class OpenCodeSubagentRecorder {
  private readonly observations: OpenCodeObservationService;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly checked = new Map<string, { time: number; delay: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, () => void>();
  private stopped = false;
  constructor(private readonly oc: OpenCodeAdapter, private readonly events: (runId: string) => readonly Event[],
    private readonly emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>, private readonly closing: () => boolean,
    private readonly catalogVisible: (session: Session) => boolean = () => true,
    private readonly appendEligible: (run: Run) => boolean = () => true) {
    this.observations = new OpenCodeObservationService(oc);
  }
  /** Routine callers respect final captures and backoff; force is user initiated. */
  refresh(session: Session, run: Run, toolId?: string, force = false) {
    if (this.stopped || this.closing() || !this.catalogVisible(session) || !this.appendEligible(run) || session.harness !== "opencode" || !session.nativeSessionId) return;
    for (const child of projectNativeSubagents(session, run, this.events(run.runId))) {
      const { parentToolUseId, nativeSessionId } = child.summary;
      if (toolId && toolId !== parentToolUseId) continue;
      const key = JSON.stringify([run.runId, session.nativeSessionId, session.cwd, session.authorityId, parentToolUseId, nativeSessionId]);
      if (!nativeSessionId && !force && child.summary.recovery?.state === "exhausted") continue;
      // Only a successful native history capture seals a child. Parent tool
      // completion alone cannot prove that its final history was retained.
      const last = this.events(run.runId).findLast(event => {
        if (event.kind !== "native-subagent") return false;
        const data = event.data as OpenCodeSubagentEvidence;
        return data?.parentNativeSessionId === session.nativeSessionId && data.parentToolUseId === parentToolUseId && data.nativeSessionId === nativeSessionId;
      })?.data as OpenCodeSubagentEvidence | undefined;
      if (!force && last?.messageIds && !last.warning && ["completed", "failed", "interrupted"].includes(last.status ?? "")) {
        clearTimeout(this.timers.get(key)); this.timers.delete(key);
        continue;
      }
      const checked = this.checked.get(key);
      const pinned = { ...session };
      const current = () => !this.stopped && !this.closing() && this.catalogVisible(session) && this.appendEligible(run) && session.harness === pinned.harness && session.nativeSessionId === pinned.nativeSessionId && session.cwd === pinned.cwd && session.authorityId === pinned.authorityId;
      const retry = () => {
        if (current() && projectNativeSubagents(session, run, this.events(run.runId)).some(child => child.summary.parentToolUseId === parentToolUseId && child.summary.nativeSessionId === nativeSessionId)) {
          this.refresh(session, run, parentToolUseId, force);
        }
      };
      if (this.flights.has(key)) {
        // A manual retry during a flight must survive its result, including the
        // sixth failed recovery. One forced follow-up per identity resets its budget.
        if (force) this.pending.set(key, retry);
        continue;
      }
      if (!force && checked && Date.now() - checked.time < checked.delay) continue;
      if (this.flights.size >= 4) {
        // FIFO admission prevents frequently polled children from starving recovery.
        if (!this.pending.has(key) || force) this.pending.set(key, retry);
        continue;
      }
      this.pending.delete(key);
      clearTimeout(this.timers.get(key)); this.timers.delete(key);
      this.checked.delete(key); this.checked.set(key, { time: Date.now(), delay: checked?.delay ?? 2000 });
      while (this.checked.size > 256) this.checked.delete(this.checked.keys().next().value!);
      const task = (nativeSessionId ? this.capture(pinned, run, parentToolUseId, nativeSessionId, current)
        : this.resolve(pinned, run, child.summary.parentMessageId, parentToolUseId, force ? 0 : child.summary.recovery?.attempts ?? 0, current)).catch(() => {
        // The bridge owns journal write failures. Observation never changes run ownership.
      }).finally(() => {
        this.flights.delete(key);
        if (current()) {
          const latest = projectNativeSubagents(session, run, this.events(run.runId)).find(child => child.summary.parentToolUseId === parentToolUseId);
          const delay = !latest?.summary.nativeSessionId ? Math.min(2000 * 2 ** Math.max(0, (latest?.summary.recovery?.attempts ?? 1) - 1), 30000)
            : latest.summary.status === "running" ? 2000 : Math.min((checked?.delay ?? 2000) * 2, 30000);
          this.checked.set(key, { time: Date.now(), delay });
          while (this.checked.size > 256) this.checked.delete(this.checked.keys().next().value!);
          if (latest && (latest.summary.nativeSessionId ? !nativeSessionId || ["running", "unknown"].includes(latest.summary.status) : latest.summary.recovery?.state !== "exhausted")) this.timers.set(key, setTimeout(() => {
            this.timers.delete(key); if (current()) this.refresh(session, run, parentToolUseId);
          }, delay + 100));
        }
        // Finish old-flight bookkeeping before admission, so it cannot overwrite
        // the follow-up's timer/backoff. Busy identities retain their queued retry.
        for (const [nextKey, next] of this.pending) {
          if (this.flights.size >= 4 || this.stopped || this.closing()) break;
          if (this.flights.has(nextKey)) continue;
          this.pending.delete(nextKey); next();
        }
      });
      this.flights.set(key, task);
    }
  }
  async drain() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    await Promise.all(this.flights.values());
  }
  resume(session: Session, run: Run) {
    if (!this.catalogVisible(session) || !this.appendEligible(run)) return;
    for (const child of projectNativeSubagents(session, run, this.events(run.runId))) {
      if (!child.summary.nativeSessionId || ["running", "unknown"].includes(child.summary.status)) this.refresh(session, run, child.summary.parentToolUseId);
    }
  }

  /** Older parent snapshots predate retention of the native child link. Read the
   * exact recorded parent message; never guess links from names or output text. */
  private async resolve(parent: Session, run: Run, messageId: string | undefined, toolId: string, attempts: number, current: () => boolean) {
    try {
      if (messageId) {
        await this.oc.activity(parent.nativeSessionId!, parent.cwd);
        const response = await this.oc.request<{ data: NativeMessage }>(this.oc.path(parent.nativeSessionId!) + `/message/${encodeURIComponent(messageId)}`);
        const snapshot = response.data?.id === messageId ? normalizeMessage(response.data) : undefined;
        if (snapshot?.role === "assistant" && snapshot.parts.some(part => part.type === "tool" && part.id === toolId && part.name === "subagent" && part.nativeSubagentSessionId)) {
          if (current()) await this.emit(run, "message", snapshot);
          return;
        }
      }
    } catch { /* Missing metadata and transient native failures share a bounded retry budget. */ }
    const recovery = { attempts: attempts + 1, state: attempts + 1 >= 6 ? "exhausted" as const : "retrying" as const };
    if (current()) await this.emit(run, "native-subagent", { parentNativeSessionId: parent.nativeSessionId!, parentToolUseId: toolId, recovery,
      warning: recovery.state === "exhausted" ? "Native child link could not be recovered after 6 attempts. Use Retry history to try again." : "Native child link is not available yet. Retrying automatically." } satisfies OpenCodeSubagentEvidence);
  }

  private async capture(parent: Session, run: Run, parentToolUseId: string, nativeSessionId: string, current: () => boolean) {
    const base = { parentNativeSessionId: parent.nativeSessionId!, parentToolUseId, nativeSessionId };
    const previous = this.events(run.runId).filter(event => event.kind === "native-subagent").flatMap(event => {
      const data = event.data as OpenCodeSubagentEvidence;
      return data?.parentNativeSessionId === base.parentNativeSessionId && data.parentToolUseId === parentToolUseId && data.nativeSessionId === nativeSessionId ? [data] : [];
    });
    let evidence: OpenCodeSubagentEvidence;
    try {
      const before = await this.oc.session(nativeSessionId);
      if (before.parentID !== parent.nativeSessionId || before.id !== nativeSessionId || before.location?.directory !== parent.cwd) throw new Error("Native child relationship or directory could not be verified.");
      const history = await this.observations.get({ ...parent, sessionId: `native-subagent:${nativeSessionId}`, nativeSessionId });
      const after = await this.oc.activity(nativeSessionId, parent.cwd);
      if (after.session.parentID !== parent.nativeSessionId || after.session.time.created !== before.time.created) throw new Error("Native child identity changed during observation.");
      const status = after.active || after.pending || history.activity === "active" ? "running"
        : after.session.outcome === "succeeded" ? "completed" : after.session.outcome === "failed" ? "failed"
        : after.session.outcome === "interrupted" ? "interrupted" : "unknown";
      const old = new Map<string, string>();
      for (const data of previous) {
        for (const message of data.messages ?? []) old.set(message.messageId, nativeSubagentRevision(message));
        if (data.messageIds) { const retained = new Set(data.messageIds); for (const id of old.keys()) if (!retained.has(id)) old.delete(id); }
      }
      const messages = history.messages.filter(message => old.get(message.messageId) !== nativeSubagentRevision(message));
      const messageIds = history.messages.map(message => message.messageId);
      const last = previous.at(-1);
      const lastIds = previous.findLast(data => data.messageIds)?.messageIds;
      if (!messages.length && last?.status === status && !last.warning && JSON.stringify(lastIds) === JSON.stringify(messageIds)) return;
      evidence = { ...base, status, messages, messageIds };
    } catch (error) {
      const warning = `Native child history unavailable: ${error instanceof Error ? error.message : "observation failed"}. Previously recorded activity is preserved.`;
      if (previous.at(-1)?.warning === warning) return;
      evidence = { ...base, warning };
    }
    if (current()) await this.emit(run, "native-subagent", evidence);
  }
}
