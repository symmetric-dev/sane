import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ASSISTANT_AGENT_IDS, WORKER_AGENT_IDS, UTILITY_AGENT_IDS } from "sane-core/agent-catalog";
import { loadAgentModelConfig } from "../../sane-cli/src/agent-model-config";
import type { AgentProfile } from "./agent-profiles-contract";
import { operationModel, parseCanonicalAgentOperations, type OperationModel } from "./canonical-agent-operations";
import { OpenCodeError, type OpenCodeAdapter, type OpenCodeUtilityTransport } from "./opencode";

const agentID = "sane/utility/session-namer";
const timeoutMs = 60_000;
const transcriptBytes = 64 * 1024;
const outputBytes = 64 * 1024;

// Defense in depth: remove inherited instrumentation, then pin off values in
// BOTH the child environment and --settings.env. User settings reapply their env
// at startup/live reload, so sanitizing process.env alone is insufficient.
// https://code.claude.com/docs/en/monitoring-usage.md
// https://code.claude.com/docs/en/env-vars#precedence
const privacyEnvironment: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
  ENABLE_ENHANCED_TELEMETRY_BETA: "0",
  ENABLE_BETA_TRACING_DETAILED: "0",
  BETA_TRACING_ENDPOINT: "",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL: "0",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  OTEL_SDK_DISABLED: "true",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  ANT_OTEL_LOGS_EXPORTER: "none",
  OTEL_LOG_USER_PROMPTS: "0",
  OTEL_LOG_ASSISTANT_RESPONSES: "0",
  OTEL_LOG_TOOL_DETAILS: "0",
  OTEL_LOG_TOOL_CONTENT: "0",
  OTEL_LOG_MANAGED_SETTINGS: "0",
  OTEL_LOG_RAW_API_BODIES: "0",
  TRACEPARENT: "",
  TRACESTATE: "",
  BAGGAGE: "",
  CLAUDE_CODE_PROPAGATE_TRACEPARENT: "0",
  DEBUG: "",
  CLAUDE_CODE_DEBUG_LOGS_DIR: "",
};
const instrumentationBinding = /^(?:(?:ANT_)?OTEL_|CLAUDE_CODE_(?:.*TELEMETRY|.*OTEL|.*TRACING|PROPAGATE_TRACEPARENT|DEBUG)|ENABLE_(?:BETA_TRACING|ENHANCED_TELEMETRY)|BETA_TRACING_|TRACEPARENT$|TRACESTATE$|BAGGAGE$|DEBUG$)/i;

/** The adapter owns endpoint discovery and authentication. This deliberately
 * narrow capability must use a request-bound AbortSignal and a bounded response
 * reader; never expose credentials or reconstruct discovery in the utility.
 *
 * V2: POST /api/experimental/generate, { prompt, model? } -> { data: { text } }.
 * Unlike session.generate, this endpoint has no session context, tools, skill or
 * MCP inventory, instruction discovery, session storage, or worker lifecycle.
 * https://opencode.ai/v2/docs/api
 * https://opencode.ai/v2/docs/build/client
 */
export type SessionNamingOpenCodeTransport = OpenCodeUtilityTransport;

type Input = {
  sourceRoot: string;
  dataDir: string;
  claudeBin: string;
  claudeRoot: string;
  oc: OpenCodeAdapter;
  profile: AgentProfile;
  transcript: string;
  signal?: AbortSignal;
  /** Same optional authored agent-model override file used by normal launches. */
  agentModelConfig?: string;
};
type ModelSelection = { model?: string; effort?: string };

class UtilityError extends Error {}
const failure = (message: string) => new UtilityError(`Session naming utility: ${message}`);
function check(signal: AbortSignal) {
  if (signal.aborted) throw failure("cancelled or timed out");
}

/** No normal App sessions/runs/events are created, and no source-session ID is
 * accepted. The caller owns semantic title validation (including its 120-char
 * limit). This layer checks transport success and bounded, plain single-line
 * output, and never includes prompts, credentials or native stderr in errors. */
export async function runSessionNamingUtility(input: Input): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let directory: string | undefined;
  try {
    if (input.signal?.aborted) abort();
    check(controller.signal);
    const { profile } = input;
    // String checks avoid depending on another role's lifecycle/launch resolver.
    if (profile.id !== "utility:session-namer" || String(profile.kind) !== "utility" || String(profile.role) !== "session-namer"
      || !["claude-code", "opencode"].includes(profile.harness)
      || typeof profile.model !== "string" || typeof profile.effort !== "string"
      || /[\x00-\x1f\x7f]/.test(profile.model + profile.effort)) throw failure("invalid utility profile");
    if (typeof input.transcript !== "string" || !input.transcript.trim()
      || Buffer.byteLength(input.transcript, "utf8") > transcriptBytes) throw failure("transcript is empty or exceeds 64 KiB");
    if (![input.sourceRoot, input.dataDir, input.claudeRoot].every(value => isAbsolute(value) && !value.includes("\0"))) throw failure("invalid configured directory");

    let system: string, canonicalModel: OperationModel | undefined;
    try {
      const sourceRoot = await realpath(input.sourceRoot);
      const path = join(sourceRoot, "context/agents/sane/utility/session-namer.md");
      if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw failure("canonical prompt must be a regular authored file");
      // Match canonical-store source containment and also protect the final
      // open against symlink replacement; never read a FIFO/device as a prompt.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let markdown: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024) throw failure("invalid canonical prompt file or size");
        markdown = await file.readFile("utf8");
      } finally { await file.close(); }
      if (Buffer.byteLength(markdown, "utf8") > 32 * 1024) throw failure("canonical prompt exceeds its budget");
      const names = [...ASSISTANT_AGENT_IDS.map(id => `sane/assistant/${id}.md`), ...WORKER_AGENT_IDS.map(id => `sane/worker/${id}.md`), ...UTILITY_AGENT_IDS.map(id => `sane/utility/${id}.md`)];
      const overrides = input.agentModelConfig ? await loadAgentModelConfig(input.agentModelConfig, names) : undefined;
      const policy = parseCanonicalAgentOperations(markdown, agentID, overrides?.get(agentID));
      if (policy.spec.kind !== "utility" || !policy.spec.body.trim()) throw failure("invalid canonical utility prompt");
      system = policy.spec.body;
      canonicalModel = policy.model;
    } catch { throw failure("canonical deny-all session-namer definition is unavailable or invalid"); }
    const selection = selectModel(profile, canonicalModel);
    check(controller.signal);
    // This directory contains neither the source transcript nor agent settings.
    // Startup instruction discovery is independently disabled, even when dataDir
    // itself happens to be nested in a checkout.
    const root = join(input.dataDir, "utility-execution");
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await realpath(await mkdtemp(join(root, "session-namer-")));
    await chmod(directory, 0o700);
    check(controller.signal);
    const prompt = JSON.stringify({ transcript: input.transcript });
    const result = profile.harness === "claude-code"
      ? await runClaude(input, selection, directory, system, prompt, controller.signal)
      : await runOpenCode(input, selection, system, prompt, controller.signal);
    check(controller.signal);
    if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > 4096) throw failure("invalid or oversized title response");
    const title = result.trim();
    if (!title || /[\x00-\x1f\x7f\u2028\u2029]/.test(title)) throw failure("expected a nonempty single-line title");
    return title;
  } catch (error) {
    if (controller.signal.aborted) throw failure("cancelled or timed out");
    if (error instanceof UtilityError) throw error;
    // utilityTransport and endpoint discovery emit fixed diagnostics only;
    // neither contains response bodies, endpoint URLs, or provider errors.
    if (error instanceof OpenCodeError) throw failure(error.message);
    throw failure("configured harness failed; inspect its private native diagnostics");
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    // Remove only our own empty directory. Never recursively remove harness
    // files or any global state, even after a native failure.
    if (directory) await rmdir(directory).catch(() => {});
  }
}

/** Profile model wins without inheriting a replaced canonical model's variant.
 * Otherwise use authored/override model+variant, then native configured defaults.
 * No provider remapping or source-conversation selection is permitted. */
function selectModel(profile: AgentProfile, canonical?: OperationModel): ModelSelection {
  if (profile.model) return { model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}) };
  if (!canonical) return profile.effort ? { effort: profile.effort } : {};
  let model = `${canonical.providerID}/${canonical.id}`;
  if (profile.harness === "claude-code") {
    if (canonical.providerID !== "anthropic" || !/^claude-[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/.test(canonical.id)) throw failure("authored model cannot be mapped to Claude; configure an explicit Claude utility profile model");
    model = canonical.id;
  }
  const effort = profile.effort || canonical.variant;
  return { model, ...(effort ? { effort } : {}) };
}

async function runOpenCode(input: Input, selection: ModelSelection, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  const model = selection.model ? operationModel(selection.model, selection.effort) : undefined;
  // /api/model/default is location-scoped (including the server's cwd when no
  // location is supplied), whereas stateless generation uses base configuration.
  // No documented route exposes that base default. Never substitute a project
  // model, send a client-local temp path to a remote server, or guess a model.
  if (!model && selection.effort) throw failure("OpenCode effort requires an explicit utility model; configure provider/model in the utility profile or canonical definition, or clear effort to use the harness default");
  // No fallback to session/worker APIs, global agent edits, or uncancellable HTTP.
  const transport = await input.oc.utilityTransport({ signal });
  check(signal);
  // The stateless API accepts one prompt, not separate system/user messages.
  // JSON encodes the untrusted transcript; canonical instructions surround it.
  const result = await transport.generate({ prompt: `${system}\n\nTranscript data (JSON):\n${prompt}\n\nReturn only the conversation title, following the instructions above.`, ...(model ? { model } : {}) }, { signal, maxResponseBytes: outputBytes });
  return result.text;
}

/** Safe mode preserves native OAuth/keychain and provider credentials. Bare
 * mode is intentionally NOT used: it skips subscription login credentials.
 * User settings retain configured model/provider defaults; safe mode disables
 * their customizations, and no project/local settings are loaded.
 * https://code.claude.com/docs/en/cli-reference
 * https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
 */
async function runClaude(input: Input, selection: ModelSelection, cwd: string, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  if (selection.effort && !["low", "medium", "high", "xhigh", "max"].includes(selection.effort)) throw failure("unsupported Claude effort");
  const launchEnvironment = {
    ...privacyEnvironment,
    CLAUDE_CODE_SAFE_MODE: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // This variable outranks --effort, so replace ambient/settings values with
    // the utility's selection. Empty means no env override: native effort and
    // modelSettings defaults still apply when no utility effort was selected.
    CLAUDE_CODE_EFFORT_LEVEL: selection.effort ?? "",
  };
  const args = ["--print", "--safe-mode", "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true, otelHeadersHelper: "", env: launchEnvironment }),
    "--system-prompt", system, "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-chrome", "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--no-session-persistence", "--max-turns", "1", "--output-format", "json"];
  if (selection.model) args.push("--model", selection.model);
  if (selection.effort) args.push("--effort", selection.effort);
  // Preserve auth/provider environment, but never inherit source-session,
  // bridge, instrumentation, or ambient launch-mode bindings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
    && !instrumentationBinding.test(name)
    && name.toUpperCase() !== "CLAUDE_CODE_EFFORT_LEVEL"
    && !/^(CC_WEB_|SANE_|OPENCODE_|CLAUDECODE$|CLAUDE_CODE_(?:SIMPLE$|BARE|SESSION|PARENT|HOST|ENTRYPOINT|PROJECT|ADDITIONAL|EXTRA|PLUGIN|SKILL|HOOK|RESUME)|BUN_INSPECT|NODE_OPTIONS$)/i.test(name)));
  Object.assign(env, launchEnvironment, { CLAUDE_CONFIG_DIR: input.claudeRoot });
  check(signal);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(input.claudeBin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let stdout = "", received = 0, stderrBytes = 0, stopped: UtilityError | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, name); } catch { /* Already exited; close is authoritative. */ }
    };
    const stop = (error: UtilityError) => {
      if (stopped) return;
      stopped = error;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const abort = () => stop(failure("cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      received += data.length;
      if (received > outputBytes) stop(failure("Claude response exceeded 64 KiB"));
      else stdout += decoder.write(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > outputBytes) stop(failure("Claude diagnostic output exceeded 64 KiB"));
    });
    child.stdin.on("error", () => stop(failure("Claude prompt delivery failed")));
    child.on("error", () => { stopped ??= failure("configured Claude executable could not start"); });
    child.on("close", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      if (escalation) clearTimeout(escalation);
      // A prompt/auth helper must not survive an interrupted private process
      // merely because the CLI closed its own descriptors first.
      if (stopped) kill("SIGKILL");
      stdout += decoder.end();
      if (stopped) { reject(stopped); return; }
      if (code !== 0 || exitSignal) { reject(failure("Claude invocation failed (authentication, model, or isolation flags may be unsupported)")); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.type !== "result" || result.subtype !== "success" || result.is_error !== false || typeof result.result !== "string"
          || !Array.isArray(result.permission_denials) || result.permission_denials.length) throw failure("Claude did not return a successful tool-free result");
        resolve(result.result);
      } catch { reject(failure("Claude returned an invalid or unsuccessful result")); }
    });
    if (!stopped) child.stdin.end(prompt);
    else child.stdin.end();
  });
}
