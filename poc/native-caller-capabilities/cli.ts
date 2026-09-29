import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { home } from "./deps";
import { record } from "./evidence";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const [command, target, extra, mode = "normal"] = process.argv.slice(2);
try {
  if (command === "prepare") {
    if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error("prepare requires a fresh simple run name");
    if (extra && !isAbsolute(extra)) throw new Error("Registration must be an explicit absolute path");
    const dir = join(home, ".local", target);
    if (existsSync(dir)) throw new Error("Run directory exists; choose a fresh run name");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const bun = process.execPath;
    for (const variant of ["normal", "continue", "missing", "tamper"]) {
      const hook = [bun, join(home, "claude-hook.ts"), dir, variant === "missing" || variant === "tamper" ? variant : "bind", variant === "continue" ? "continue-once" : "observe"].map(quote).join(" ");
      const hooks = Object.fromEntries(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "TaskCompleted", "Notification"].map(event => [event, [{ hooks: [{ type: "command", command: hook, timeout: 10 }] }]]));
      write(`claude-${variant}.json`, { hooks });
    }
    write("mcp.json", { mcpServers: { native_probe: { type: "stdio", command: bun, args: [join(home, "claude-mcp.ts"), dir] } } });
    if (extra) {
      mkdirSync(join(dir, "oc-workspace"), { mode: 0o700 });
      write("oc-workspace/opencode.json", { $schema: "https://opencode.ai/config.json", plugins: [{ package: join(home, "opencode-plugin"), options: { evidence: dir, registration: extra } }] });
    }
    console.log(JSON.stringify({ directory: dir, nativeProcessesLaunched: false, managedRegistrationRead: false, opencodeConfigPrepared: !!extra }, null, 2));
  } else if (command === "view") {
    if (!target || !isAbsolute(target)) throw new Error("view requires the absolute prepared run directory");
    const events = join(target, "events");
    const records = existsSync(events) ? readdirSync(events).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(events, f), "utf8"))) : [];
    records.sort((a, b) => BigInt(a.monotonicNs) < BigInt(b.monotonicNs) ? -1 : BigInt(a.monotonicNs) > BigInt(b.monotonicNs) ? 1 : a.id.localeCompare(b.id));
    for (const item of records) console.log(JSON.stringify(item));
  } else if (command === "run") {
    if (!target || !extra || !isAbsolute(target) || !isAbsolute(extra) || !["normal", "continue", "missing", "tamper", "interactive"].includes(mode)) throw new Error("run requires absolute run directory, absolute cwd, and an optional mode");
    if (!existsSync(join(target, "mcp.json"))) throw new Error("Prepare configuration first");
    const { observe } = await import("./observe");
    await observe(resolve(target), resolve(extra), mode);
  } else if (command === "mark") {
    if (!target || !isAbsolute(target) || !["operator-interrupt", "operator-background-visible", "operator-turn-visible"].includes(extra ?? "")) throw new Error("mark requires run directory and a documented marker");
    record(target, "operator.observation", { observation: extra, authority: "operator-only-not-native-proof" });
  } else {
    console.log("prepare <fresh-name> [absolute-managed-registration]\nview <absolute-run-dir>\nrun <absolute-run-dir> <absolute-cwd> [normal|continue|missing|tamper|interactive]\nmark <absolute-run-dir> <operator-interrupt|operator-background-visible|operator-turn-visible>");
  }
} catch (error) {
  // Only our own CLI validation messages are safe to show. No imported error detail.
  console.error("PoC command failed; check arguments, fresh run name, local permissions and installed dependencies. No capability conclusion.");
  process.exitCode = 1;
}
