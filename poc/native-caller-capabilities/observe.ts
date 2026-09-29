import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fields, record, taskFields } from "./evidence";

// This is an operator-invoked local CLI launch, never an SDK query or attach.
export async function observe(dir: string, cwd: string, mode: string) {
  const interactive = mode === "interactive";
  const settings = mode === "continue" ? "continue" : mode === "missing" || mode === "tamper" ? mode : "normal";
  const launchID = randomUUID();
  process.env.NATIVE_PROBE_LAUNCH_ID = launchID;
  const args = ["--settings", join(dir, `claude-${settings}.json`), "--strict-mcp-config", "--mcp-config", join(dir, "mcp.json"), "--setting-sources", ""];
  if (!interactive) {
    const prompt = await Bun.stdin.text();
    if (!prompt.trim()) throw new Error("Pipe a non-sensitive scenario prompt on stdin");
    args.push("-p", prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", "mcp__native_probe__capture");
  }
  record(dir, "process.launch-request", { cwd, mode, interactive });
  const child = spawn("claude", args, {
    cwd, env: { ...process.env, NATIVE_PROBE_LAUNCH_ID: launchID },
    stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const streams: Promise<void>[] = [];
  let stderrBytes = 0;
  let frames = 0;
  let stateEvents = 0;
  let backgroundEvents = 0;
  let results = 0;
  // Do not forward signals or kill any child. Terminal-delivered signals may
  // independently reach both processes; Esc interruption has no OS signal.
  const interrupt = () => record(dir, "process.observer-signal", { signal: "SIGINT", childPID: child.pid ?? null });
  process.on("SIGINT", interrupt);
  if (child.stdout) streams.push((async () => {
    const lines = createInterface({ input: child.stdout! });
    for await (const line of lines) {
      let input: any;
      try { input = JSON.parse(line); } catch { record(dir, "stream.non-json", {}); continue; }
      frames++;
      if (input.subtype === "session_state_changed") stateEvents++;
      if (input.subtype === "background_tasks_changed") backgroundEvents++;
      if (input.type === "result") results++;
      // No message content, prompts, result text, errors, hook stdout or stderr.
      record(dir, "claude.stream", {
        ...fields(input, ["type", "subtype", "session_id", "uuid", "prompt_id", "user_message_uuid", "parent_tool_use_id", "tool_use_id", "task_id", "task_type", "status", "state", "is_error", "stop_reason", "aborted", "claude_code_version", "cwd", "exit_code"]),
        user_message_uuids: Array.isArray(input.user_message_uuids) ? input.user_message_uuids.filter((id: unknown) => typeof id === "string") : null,
        message: fields(input.message, ["id", "stop_reason"]),
        tasks: taskFields(input, "tasks", ["task_id", "task_type", "ambient"]),
      });
    }
  })());
  if (child.stderr) streams.push((async () => { for await (const chunk of child.stderr!) stderrBytes += chunk.length; })());
  const outcome = await new Promise<{ code: number | null; signal: string | null; spawnError: boolean }>(resolve => {
    child.once("spawn", () => record(dir, "process.spawn", { childPID: child.pid ?? null, cwd }));
    child.once("error", () => resolve({ code: null, signal: null, spawnError: true }));
    child.once("exit", (code, signal) => {
      record(dir, "process.exit", { childPID: child.pid ?? null, code, signal });
    });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError: false }));
  });
  await Promise.all(streams);
  process.removeListener("SIGINT", interrupt);
  record(dir, "process.observation-end", { ...outcome, stderrBytes, frames, stateEvents, backgroundEvents, results, completionConclusion: "not-inferred" });
  console.log(JSON.stringify({ launchID, ...outcome, frames, stateEvents, backgroundEvents, results, evidence: dir }));
  process.exitCode = outcome.spawnError ? 1 : outcome.code ?? 1;
}
