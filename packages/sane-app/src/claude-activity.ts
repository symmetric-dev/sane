import type { ConversationActivity } from "../shared/conversation/activity";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const terminal = (status: unknown) => status === "completed" || status === "failed" || status === "stopped";

/** Presentation only. Stop may precede native continuations; it is NOT process
 * exit, run completion, or permission to release the execution owner. */
export class ClaudeActivity {
  private tasks = new Set<string>();
  private stopped = false;
  private phase: ConversationActivity["phase"] = "starting";
  private observedAt: string;

  constructor(private runId: string, private createdAt: string) { this.observedAt = createdAt; }

  private observe(phase: ConversationActivity["phase"]) {
    this.phase = phase;
    this.observedAt = new Date().toISOString();
  }

  running() { this.observe("running"); }
  finishing() { this.observe("finishing"); }

  private snapshot(tasks: unknown[], idKey: "id" | "task_id") {
    this.tasks = new Set(tasks.filter(object).filter(task => !terminal(task.status))
      .map(task => task[idKey]).filter((id): id is string => typeof id === "string" && !!id));
  }

  hook(event: string, payload: unknown) {
    if (this.phase === "finishing" || !object(payload) || !isClaudeRootRecord(payload)) return;
    if (Array.isArray(payload.background_tasks)) this.snapshot(payload.background_tasks, "id");
    if (event === "UserPromptSubmit" || event === "PreToolUse") this.stopped = false;
    if (event === "Stop") this.stopped = true;
    if (event === "SessionEnd") { this.finishing(); return; }
    if (["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(event)) {
      // No active-task evidence means only that the root turn stopped. Until
      // exit/SessionEnd, claim neither completion nor lifecycle cleanup.
      this.observe(this.stopped ? this.tasks.size ? "background" : "waiting" : "running");
    }
  }

  stdout(value: unknown, nativeSessionId: string) {
    if (this.phase === "finishing" || !object(value) || value.session_id !== nativeSessionId || !isClaudeRootRecord(value) || value.type !== "system") return;
    if (value.subtype === "background_tasks_changed" && Array.isArray(value.tasks)) {
      this.snapshot(value.tasks, "task_id");
    } else if (value.subtype === "task_updated" && typeof value.task_id === "string" && object(value.patch) && terminal(value.patch.status)) {
      this.tasks.delete(value.task_id);
    } else if (value.subtype === "task_notification") {
      if (typeof value.task_id === "string" && terminal(value.status)) this.tasks.delete(value.task_id);
      // A task report can wake the root assistant; wait for its next Stop.
      this.stopped = false;
    } else return;
    this.observe(this.stopped ? this.tasks.size ? "background" : "waiting" : "running");
  }

  get(): ConversationActivity {
    return { phase: this.phase, runId: this.runId, startedAt: this.createdAt, observedAt: this.observedAt,
      ...(this.tasks.size ? { backgroundTaskCount: this.tasks.size } : {}) };
  }
}
