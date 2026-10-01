import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Supported local SDK/CLI source selectors. Never modify native configuration. */
export function claudeSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) throw new Error("CLAUDE_CODE_PROJECT_DIR_NAME is unsupported by App native attachment/resume; preserve the native configuration and use a separately agreed supported launch environment");
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && (!isAbsolute(configured) || configured.includes("\0"))) throw new Error("CLAUDE_CONFIG_DIR must be an absolute directory; relative or empty configuration could select different stores for SDK reads and CLI resume");
  return resolve((configured ?? join(homedir(), ".claude")).normalize("NFC"));
}

export function assertClaudeSource(root: string): void {
  if (claudeSourceRoot() !== root) throw new Error("Native source changed since bridge startup; restore the pinned launch environment");
}
