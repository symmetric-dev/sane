import type { Event, Run, Session } from "./history";
import { normalizeMessage, type NativeMessage, type OpenCodeAdapter } from "./opencode";
import { OpenCodeObservationService } from "./opencode-observation-service";
import { nativeSubagentRevision, projectNativeSubagents, type OpenCodeSubagentEvidence } from "./native-subagent-projection";

/** Optional read-only native observation, persisted separately from parent messages. */
export class OpenCodeSubagentRecorder {
  private readonly observations: OpenCodeObservationService;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly checked = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly oc: OpenCodeAdapter, private readonly events: (runId: string) => readonly Event[],
    private readonly emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>, private readonly closing: () => boolean) {
    this.observations = new OpenCodeObservationService(oc);
  }
  refresh(session: Session, run: Run, toolId?: string) {
    if (this.closing() || session.harness !== "opencode" || !session.nativeSessionId) return;
    for (const child of projectNativeSubagents(session, run, this.events(run.runId))) {
      const { parentToolUseId, nativeSessionId } = child.summary;
      if (toolId && toolId !== parentToolUseId) continue;
      const key = JSON.stringify([run.runId, parentToolUseId, nativeSessionId]);
      if (this.flights.has(key) || Date.now() - (this.checked.get(key) ?? 0) < 2000) continue;
      if (this.flights.size >= 4) {
        if (!this.timers.has(key)) this.timers.set(key, setTimeout(() => {
          this.timers.delete(key); this.refresh(session, run, parentToolUseId);
        }, 2100));
        continue;
      }
      clearTimeout(this.timers.get(key)); this.timers.delete(key);
      this.checked.delete(key); this.checked.set(key, Date.now());
      while (this.checked.size > 256) this.checked.delete(this.checked.keys().next().value!);
      const pinned = { ...session };
      const current = () => !this.closing() && session.nativeSessionId === pinned.nativeSessionId && session.cwd === pinned.cwd && session.authorityId === pinned.authorityId;
      const task = (nativeSessionId ? this.capture(pinned, run, parentToolUseId, nativeSessionId, current)
        : this.resolve(pinned, run, child.summary.parentMessageId, parentToolUseId, current)).catch(() => {
        // The bridge owns journal write failures. Observation never changes run ownership.
      }).finally(() => {
        this.flights.delete(key);
        const latest = projectNativeSubagents(session, run, this.events(run.runId)).find(child => child.summary.parentToolUseId === parentToolUseId);
        if (current() && latest?.summary.nativeSessionId && ["running", "unknown"].includes(latest.summary.status)) this.timers.set(key, setTimeout(() => {
          this.timers.delete(key); this.refresh(session, run, parentToolUseId);
        }, 2100));
      });
      this.flights.set(key, task);
    }
  }
  async drain() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.flights.values());
  }
  resume(session: Session, run: Run) {
    for (const child of projectNativeSubagents(session, run, this.events(run.runId))) {
      if (child.summary.nativeSessionId && ["running", "unknown"].includes(child.summary.status)) this.refresh(session, run, child.summary.parentToolUseId);
    }
  }

  /** Older parent snapshots predate retention of the native child link. Read the
   * exact recorded parent message; never guess links from names or output text. */
  private async resolve(parent: Session, run: Run, messageId: string | undefined, toolId: string, current: () => boolean) {
    if (!messageId) return;
    await this.oc.activity(parent.nativeSessionId!, parent.cwd);
    const response = await this.oc.request<{ data: NativeMessage }>(this.oc.path(parent.nativeSessionId!) + `/message/${encodeURIComponent(messageId)}`);
    if (response.data?.id !== messageId) return;
    const snapshot = normalizeMessage(response.data);
    if (!snapshot?.parts.some(part => part.type === "tool" && part.id === toolId && part.name === "subagent" && part.nativeSubagentSessionId)) return;
    if (current()) await this.emit(run, "message", snapshot);
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
