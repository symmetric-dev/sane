import { isAbsolute, join } from "node:path"

export function nativeIntegrationConfiguration(input: { pluginDirectory: string; registrationFile: string; profileRoot: string; bindingRoot: string; bunExecutable: string; appConnectionFile?: string }) {
  const required = [input.pluginDirectory, input.registrationFile, input.profileRoot, input.bindingRoot, input.bunExecutable]
  if ([...required, ...(input.appConnectionFile === undefined ? [] : [input.appConnectionFile])].some(value => typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))) throw new Error("Native integration paths must be explicit absolute paths")
  const runtime = join(input.pluginDirectory, "runtime", "packages", "sane-cli", "src")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return {
    opencode: { plugins: [{ package: input.pluginDirectory, options: { registrationFile: input.registrationFile, ...(input.appConnectionFile ? { appConnectionFile: input.appConnectionFile } : {}) } }] },
    claudeMcp: { mcpServers: { sane: { type: "stdio", command: input.bunExecutable, args: [join(runtime, "native-claude-mcp.ts"), input.profileRoot, input.bindingRoot, ...(input.appConnectionFile ? [input.appConnectionFile] : [])] } } },
    claudeSettings: { hooks: { PreToolUse: [{ matcher: "mcp__sane__sane_link|mcp__sane__sane_context|mcp__sane__sane_handoff|mcp__sane__sane_handoff_status|Bash", hooks: [{ type: "command", command: [input.bunExecutable, join(runtime, "native-claude-hook.ts"), input.profileRoot, input.bindingRoot].map(quote).join(" ") }] }] } },
  }
}
