import { issueClaudeInvocation, qualifyClaudeHook, claudeNativeTools } from "./native-claude.ts"
import { nativeShellCaller } from "./native-caller.ts"

try {
  const [profileRoot, bindingRoot] = process.argv.slice(2)
  if (!profileRoot || !bindingRoot) throw new Error()
  const hook = JSON.parse(await Bun.stdin.text())
  if (hook.hook_event_name === "PreToolUse" && claudeNativeTools.some(tool => `mcp__sane__${tool}` === hook.tool_name)) {
    const updatedInput = issueClaudeInvocation(bindingRoot, profileRoot, hook)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  } else if (hook.hook_event_name === "PreToolUse" && hook.tool_name === "Bash" && typeof hook.tool_input?.command === "string") {
    let reference: string
    try { reference = JSON.stringify(nativeShellCaller(qualifyClaudeHook(profileRoot, hook))) } catch { reference = "unavailable" }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const updatedInput = { ...hook.tool_input, command: `export SANE_CALLER_CONTEXT=${quote(reference)}\nunset SANE_SESSION_ID OPENCODE_SESSION_ID\n${hook.tool_input.command}` }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  }
} catch {
  console.error("SANE native caller hook unavailable")
  process.exitCode = 2
}
