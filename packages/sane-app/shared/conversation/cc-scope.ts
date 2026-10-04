export function claudeRecordScope(value: unknown): "root" | "child" | "lifecycle" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const present = (field: unknown) => field !== undefined && field !== null;
  if (present(record.parent_tool_use_id) || present(record.parent_agent_id) || present(record.isSidechain) && record.isSidechain !== false) return "child";
  if (record.hook_event_name === "SubagentStart" || record.hook_event_name === "SubagentStop") return "lifecycle";
  if (present(record.agent_id) || present(record.subagent_type)) return "child";
  return "root";
}

export function isClaudeRootRecord(value: unknown): boolean {
  return claudeRecordScope(value) === "root";
}
