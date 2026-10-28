import { issueGrokRuntimeProof, readGrokRuntimeBinding } from "./native-grok-binding.ts"

try {
  const [directory, bindingId] = process.argv.slice(2)
  if (!directory || !bindingId) throw new Error("Missing Grok runtime binding")
  const event = JSON.parse(await Bun.stdin.text())
  if (typeof event.toolName === "string" && event.toolName.startsWith("sane__")) {
    const updatedInput = issueGrokRuntimeProof(directory, bindingId, event)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  } else if (["run_terminal_command", "run_terminal_cmd", "Shell"].includes(event.toolName) && typeof event.toolInput?.command === "string"
    // Grok refuses a changed string that still carries its " [truncated]" cut
    // marker, which would block the shell call. Leave such input untouched.
    && event.toolInputTruncated === false) {
    const binding = readGrokRuntimeBinding(directory, bindingId)
    const root = event.sessionId === binding.nativeSessionId && process.env.GROK_SESSION_ID === binding.nativeSessionId
    const envelope = root && binding.repository ? JSON.stringify({ version: 1, repository: binding.repository,
      source: binding.source, authorityId: binding.authorityId, nativeId: binding.nativeSessionId }) : "unavailable"
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    // A native child may use all native tools, but cannot inherit the root App's
    // managed caller authority. App-managed workers get their own runtime.
    const updatedInput = { ...event.toolInput, command: `export SANE_CALLER_CONTEXT=${quote(envelope)}\nunset SANE_SESSION_ID OPENCODE_SESSION_ID\n${event.toolInput.command}` }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  }
} catch (error) {
  console.log(JSON.stringify({ decision: "deny", reason: error instanceof Error ? error.message : "Grok native caller unavailable" }))
  process.exitCode = 2
}
