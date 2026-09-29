import { fields, hash, identityKeys, record, root, taskFields } from "./evidence";
import { mint, payload, toolName } from "./binding";

try {
  const dir = root(process.argv[2]);
  const mode = process.argv[3] ?? "bind";
  const stopMode = process.argv[4] ?? "observe";
  const input = JSON.parse(await Bun.stdin.text());
  const event = record(dir, "claude.hook", {
    ...fields(input, [...identityKeys, "hook_event_name", "stop_hook_active", "is_interrupt", "task_id", "notification_type"]),
    background_tasks: taskFields(input, "background_tasks", ["id", "type", "status"]),
    session_crons: taskFields(input, "session_crons", ["id", "recurring"]),
    // Only identifiers/status from child launch results; never prompt/output/command.
    child: input.tool_name === "Agent" || input.tool_name === "Task"
      ? fields(input.tool_response, ["agentId", "status"]) : null,
    tool: input.tool_name === toolName ? "native_probe.capture" : input.tool_name === "Agent" || input.tool_name === "Task" ? "child-launch" : "other",
    invocationFingerprint: input.tool_name === toolName && typeof input.tool_input?._invocation === "string" ? hash(input.tool_input._invocation) : null,
  });
  if (input.hook_event_name === "PreToolUse" && input.tool_name === toolName) {
    const body = payload(input.tool_input);
    let token: string | undefined;
    if (mode !== "missing") token = mint(dir, input, event);
    if (mode === "tamper" && token) token = (token[0] === "0" ? "1" : "0") + token.slice(1);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...body, ...(token ? { _invocation: token } : {}) } } }));
  }
  if (input.hook_event_name === "Stop") {
    const block = stopMode === "continue-once" && input.stop_hook_active === false;
    record(dir, "claude.stop-proposal", { hookEvent: event, session_id: input.session_id ?? null, prompt_id: input.prompt_id ?? null, proposal: block ? "block" : "no-decision", aggregateDecision: "unknown" });
    if (block) console.log(JSON.stringify({ decision: "block", reason: "PoC continuation: reply once with CONTINUED, then finish. Do not use tools." }));
  }
} catch {
  // Never echo raw input or exception text; hooks failing open is itself a gap.
  console.error("native capability hook failed; evidence/binding unavailable");
  process.exitCode = 1;
}
