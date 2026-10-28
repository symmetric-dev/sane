import { issueClaudeInvocation, qualifyClaudeHook, claudeNativeTools } from "./native-claude.ts"
import { nativeShellCaller } from "./native-caller.ts"

// Grok imports compatible Claude settings, but must never run Claude's SANE
// identity rewrite. Leave unrelated compatible hooks enabled and untouched.
if (process.env.GROK_SESSION_ID) process.exit(0)

try {
  const [profileRoot, bindingRoot] = process.argv.slice(2)
  if (!profileRoot || !bindingRoot) throw new Error()
  const hook = JSON.parse(await Bun.stdin.text())
  if (hook.hook_event_name === "PreToolUse" && claudeNativeTools.some(tool => `mcp__sane__${tool}` === hook.tool_name)) {
    const updatedInput = issueClaudeInvocation(bindingRoot, profileRoot, hook)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  } else if (hook.hook_event_name === "PreToolUse" && hook.tool_name === "Bash" && typeof hook.tool_input?.command === "string") {
    let reference: string
    // Refusal carries the cause (e.g. a stale installed runtime rejecting a newer
    // schema) so shell commands report it instead of a generic caller error.
    try { reference = JSON.stringify(nativeShellCaller(qualifyClaudeHook(profileRoot, hook))) } catch (error) {
      const code = (error as { code?: unknown })?.code
      reference = JSON.stringify({ version: 1, unavailable: `${typeof code === "string" ? `${code}: ` : ""}${error instanceof Error ? error.message : "qualification failed"}` })
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const updatedInput = { ...hook.tool_input, command: `export SANE_CALLER_CONTEXT=${quote(reference)}\nunset SANE_SESSION_ID OPENCODE_SESSION_ID\n${hook.tool_input.command}` }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }))
  }
} catch {
  console.error("SANE native caller hook unavailable")
  process.exitCode = 2
}
