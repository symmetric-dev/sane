import { readFileSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { decodeCompactionContext } from "../src/compaction-context";
import { claudeCompactionRestorationNeeded } from "../src/claude-compaction-context";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";

let payload: unknown;
try {
  payload = JSON.parse(await Bun.stdin.text());
  const context = decodeCompactionContext(JSON.parse(readFileSync(process.argv[2]!, "utf8")));
  const index = Number(process.argv[3]);
  if (!Number.isSafeInteger(index) || !context.parts[index]) throw new Error("Invalid restoration part");
  if (!isClaudeRootRecord(payload)) process.exit(0);
  const input = payload as Record<string, unknown>;
  const binding = context.message.binding;
  if (input.hook_event_name !== "SessionStart" || input.session_id !== binding.nativeSessionId || binding.harnessId !== "claude-code")
    throw new Error("Restoration hook native identity mismatch");
  const child = typeof input.cwd === "string" ? relative(binding.cwd, input.cwd) : "..";
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Restoration hook execution checkout changed");
  if (input.source !== "compact" && input.source !== "resume") process.exit(0);
  const root = process.env.CLAUDE_CONFIG_DIR;
  if (!root || !isAbsolute(root)) throw new Error("Restoration requires its original Claude profile");
  const transcript = join(root, "projects", binding.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${binding.nativeSessionId}.jsonl`);
  if (input.transcript_path !== transcript) throw new Error("Restoration hook native transcript locator changed");
  if (input.source === "resume" && !claudeCompactionRestorationNeeded(context, transcript)[index]) process.exit(0);
  // SessionStart's additionalContext is a native user-context attachment, not
  // --system-prompt/--append-system-prompt. Each numbered part is below CC's
  // hard output ceiling, so no standing instructions become a file preview.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context.parts[index] } }));
} catch (error) {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  process.stderr.write(`SANE_CONTEXT_RESTORE: ${reason}\n`);
  const { CC_WEB_HOOK_URL: url, CC_WEB_RUN_ID: runId, CC_WEB_HOOK_SECRET: secret } = process.env;
  try {
    if (!url || !runId || !secret || !payload || new URL(url).hostname !== "127.0.0.1") throw new Error("Original restoration failure reporting is unavailable");
    await fetch(`${url}/hooks/SessionStart`, { method: "POST", headers: { "content-type": "application/json", "x-cc-web-secret": secret },
      body: JSON.stringify({ runId, payload, restorationFailure: reason }), signal: AbortSignal.timeout(8000) });
  } catch { /* The supervisor also rejects failed hook output and missing part acknowledgements. */ }
  process.exitCode = 1;
}
