import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { contextAsset, contextHash, createContextPackage, renderContextDelivery, type ContextPackage } from "../src/context-package";
import { claudeExecutionConfiguration, parseCanonicalAgentOperations } from "../src/canonical-agent-operations";

// Opt in explicitly. This is a REAL HARNESS / MOCK PROVIDER capture, never a
// model-behavior test. No ambient environment, credentials, or account copies.
// Documented routing/auth/traffic controls: https://code.claude.com/docs/en/env-vars
// macOS Seatbelt additionally denies every network destination except our listener.
const armed = process.env.SANE_ARM_CLAUDE_CAPTURE === "ZERO_PAID_MODEL";
const tempRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const source = resolve(import.meta.dir, "../hooks/session-context.ts");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const textBlocks = (value: any): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(v => typeof v.text === "string" ? [v.text] : []) : [];

(armed ? test : test.skip)("real Claude Code canonical context request capture (zero paid model)", async () => {
  const root = mkdtempSync(join(tempRoot, "canonical-claude-capture-"));
  console.log(`REAL HARNESS / MOCK PROVIDER evidence: ${root}`);
  const checks: any[] = [], observations: any[] = [], requests: any[] = [];
  const traces: Record<string, any> = {};
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const check = (id: string, status: string, summary: string, evidenceRef = join(root, "manifest.json")) => {
    checks.push({ id, status, scope: "real-harness/mock-provider; no live model behavior", evidenceKind: "fixture", evidenceRef, summary });
  };
  let phase = "prerequisites", version = "not launched", calls = 0;
  let scoutRole = "", scoutDispatched = false;
  const maxProviderCalls = 24;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const manifest: any = { schema: 1, classification: "real-harness/mock-provider", realModelInvoked: false,
    source, sourceSha256: contextHash(readFileSync(source, "utf8")), timeoutPerProcessMs: 35000, maxProviderCalls,
    documentation: "https://code.claude.com/docs/en/env-vars", artifacts: root };
  writeFileSync(join(root, "session-context.source.ts"), readFileSync(source), { mode: 0o600 });
  writeFileSync(join(root, "capture-test.source.ts"), readFileSync(import.meta.path), { mode: 0o600 });
  const home = join(root, "home"), config = join(root, "config"), cwd = join(root, "cwd");
  for (const dir of [home, config, cwd, join(root, "tmp")]) mkdirSync(dir, { mode: 0o700 });
  const active = new Set<number>();
  const kill = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
  try {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new Error("Prerequisite: macOS sandbox-exec required; refusing unsandboxed fallback");
    for (const path of ["/Library/Application Support/ClaudeCode", "/Library/Managed Preferences/com.anthropic.claudecode.plist"]) {
      if (existsSync(path)) throw new Error(`Prerequisite: unmanaged host required; managed configuration exists at ${path}`);
    }
    const located = Bun.which("claude");
    if (!located) throw new Error("Prerequisite: installed Claude Code required");
    const cli = realpathSync(located), bun = realpathSync(process.execPath);
    // A native executable only; do not execute a shell wrapper with hidden setup.
    const magic = readFileSync(cli).subarray(0, 4).toString("hex");
    if (!["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(magic)) throw new Error("Prerequisite: Claude executable is not a native Mach-O binary");
    const key = "sk-ant-api03-NOT-A-REAL-KEY-ZERO-PAID-CAPTURE";
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/isolation-probe") return new Response("local-only");
      const raw = await req.text();
      const requestId = `capture-${requests.length + 1}`;
      const entry: any = { requestId, phase, url: req.url, method: req.method, raw,
        dummyKeyMatched: req.headers.get("x-api-key") === key, apiKeyAbsent: !req.headers.has("x-api-key"), authorizationAbsent: !req.headers.has("authorization") };
      requests.push(entry);
      writeFileSync(join(root, `${requestId}.request.json`), raw, { mode: 0o600 });
      if (++calls > maxProviderCalls) {
        for (const pid of active) kill(pid);
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "capture call limit" } }, { status: 400 });
      }
      if (url.pathname === "/api/hello" && req.method === "HEAD" && entry.apiKeyAbsent && entry.authorizationAbsent) return new Response(null, { status: 200 });
      if (!entry.dummyKeyMatched || !entry.authorizationAbsent) return Response.json({ error: "unexpected authentication" }, { status: 401 });
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 100 });
      if (url.pathname !== "/v1/messages") return Response.json({ error: "unimplemented local endpoint" }, { status: 400 });
      const body = JSON.parse(raw);
      entry.body = body;
      const invokeScout = phase === "scout-native" && !scoutDispatched;
      if (invokeScout) scoutDispatched = true;
      if (phase === "scout-native") entry.nativeRequestKind = textBlocks(body.system).join("\n\n").includes(scoutRole) ? "scout-child" : "implementer-parent";
      const answer = phase === "compact" ? "Mock summary: capture conversation only; no model reasoning occurred." : "MOCK_PROVIDER_CAPTURE_OK";
      const usage = { input_tokens: 100, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const tool = { type: "tool_use", id: "toolu_capture_scout", name: "Agent", input: { subagent_type: "sane-worker-scout", description: "Capture bounded Scout request", prompt: `Inspect only ${cwd}. Scope: no file access needed. Question: report completion of this transport capture. Supplied context: fixture only. Forbidden: all file mutations and external access. Desired evidence: reply MOCK_PROVIDER_CAPTURE_OK and stop.` } };
      const message = { id: `msg_${requestId}`, type: "message", role: "assistant", model: body.model, content: invokeScout ? [tool] : [{ type: "text", text: answer }], stop_reason: invokeScout ? "tool_use" : "end_turn", stop_sequence: null, usage };
      if (!body.stream) return Response.json(message);
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: invokeScout ? { ...tool, input: {} } : { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: invokeScout ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage },
        { type: "message_stop" },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "request-id": requestId } });
    } });
    const endpoint = `http://127.0.0.1:${server.port}`;
    // No spread of process.env: paid credentials, provider toggles, proxies,
    // plugin paths and parent Claude/SANE session variables cannot leak in.
    const env = { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config, TMPDIR: join(root, "tmp"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", TERM: "dumb",
      ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: key,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", API_TIMEOUT_MS: "10000" };
    const realHome = homedir();
    const sandbox = join(root, "isolation.sb");
    writeFileSync(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${server.port}"))\n` +
      `(deny file-read* (subpath ${JSON.stringify(join(realHome, ".claude"))}) (subpath ${JSON.stringify(join(realHome, "Library/Keychains"))}))\n` +
      `(deny process-exec (literal "/usr/bin/security"))\n`, { mode: 0o600 });
    const run = async (name: string, executable: string, args: string[]) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-f", sandbox, executable, ...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const pid = child.pid;
      if (pid) active.add(pid);
      let out = "", err = "", timedOut = false;
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { err += chunk; });
      const timer = setTimeout(() => { timedOut = true; if (pid) kill(pid); }, 35000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
        write(`${name}.process.json`, { executable, args, code, timedOut, stdout: out, stderr: err });
        if (timedOut) throw new Error(`${name}: bounded timeout (35s)`);
        return { code, out, err };
      } finally { clearTimeout(timer); if (pid) { kill(pid); active.delete(pid); } }
    };
    // Verify Seatbelt before launching Claude. A second local listener is a safe
    // negative control: no outbound internet probe is needed or attempted.
    const forbidden = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("SHOULD_NOT_CONNECT") });
    try {
      const probe = await run("isolation", bun, ["-e", `const ok = await fetch(${JSON.stringify(endpoint + "/isolation-probe")}); if(await ok.text() !== 'local-only') process.exit(2); try { await fetch('http://127.0.0.1:${forbidden.port}', {signal:AbortSignal.timeout(2000)}); process.exit(3) } catch {} console.log('isolated');`]);
      if (probe.code !== 0 || !probe.out.includes("isolated")) throw new Error(`Prerequisite: network isolation probe failed: ${probe.err}`);
      check("isolation-before-cli", "passed", "Exact provider port reachable; second loopback port denied by kernel sandbox. All nonmatching network destinations denied; allowlisted environment only.");
    } finally { forbidden.stop(true); }
    const v = await run("version", cli, ["--version"]);
    version = v.out.trim();
    if (v.code !== 0 || !/^2\.1\.289\b/.test(version)) throw new Error(`Prerequisite: expected audited Claude Code 2.1.289, observed ${version}`);
    manifest.claudeVersion = version;
    manifest.cli = cli;
    manifest.environment = env; // Only the deliberately constructed dummy environment.
    const help = await run("help", cli, ["--help"]);
    // The App's --append-system-prompt-file is hidden in this CLI's help;
    // its acceptance is verified by the bounded native launch below.
    for (const flag of ["--agents", "--agent", "--settings", "--setting-sources", "--strict-mcp-config", "--resume"]) {
      if (!help.out.includes(flag)) throw new Error(`Prerequisite: required CLI flag absent: ${flag}`);
    }
    check("cli-version", "passed", version);
    const hookCopy = join(root, "session-context.source.ts");
    const pickupPath = join(root, "pickup.md");
    const role = "CAPTURE_ROLE_MARKER: Follow the bounded capture assignment.\n";
    const pickup = "CAPTURE_PICKUP_MARKER: This is inert fixture procedure text.\n";
    writeFileSync(pickupPath, pickup);
    const bundle = createContextPackage({ kind: "assistant", role: "design" }, [
      contextAsset("role.assistant.design", "fixture:role", role, "role"),
      contextAsset("sane-assistant-design-pickup", pickupPath, pickup, "procedure"),
    ]);
    write("source-package.json", bundle);
    const native = randomUUID(), sessionId = `fixture-${native}`;
    const binding = { sessionId, nativeSessionId: native, harness: "claude-code", authorityId: "isolated-capture", cwd };
    const common = ["-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-6", "--max-turns", "1",
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""];
    const launch = async (name: string, prompt: string, dynamic: string | null, resume = false,
      options: { nativeSessionId?: string; snapshot?: "on" | "off"; execution?: ReturnType<typeof claudeExecutionConfiguration>; bundle?: ContextPackage; assignment?: string } = {}) => {
      phase = name;
      const runId = `capture-${name}`;
      const nativeSessionId = options.nativeSessionId ?? (dynamic === null ? randomUUID() : native);
      const runSessionId = `fixture-${nativeSessionId}`;
      const delivery = dynamic === null ? null : renderContextDelivery(options.bundle ?? bundle, { ...binding, sessionId: runSessionId, nativeSessionId }, { "sane-assistant-design-pickup": pickupPath }, dynamic, options.assignment, true);
      const args = [...common, ...(resume ? ["--resume", nativeSessionId] : ["--session-id", nativeSessionId]),
        ...(options.snapshot ? ["--system-prompt-snapshot", options.snapshot] : [])];
      if (options.execution) {
        args[args.indexOf("--tools") + 1] = "default";
        args[args.indexOf("--max-turns") + 1] = "3";
        args.push("--dangerously-skip-permissions");
      }
      manifest.sessions ??= {};
      manifest.sessions[name] = { runId, sessionId: runSessionId, nativeSessionId };
      if (delivery) {
        const standingFile = join(root, `${name}.standing.txt`), dynamicFile = join(root, `${name}.dynamic.txt`), settingsFile = join(root, `${name}.settings.json`);
        writeFileSync(standingFile, delivery.standing); writeFileSync(dynamicFile, delivery.dynamic);
        write(`${name}.settings.json`, { ...(options.execution ? { permissions: options.execution.permissions } : {}), hooks: name === "compact" ? {} : { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(bun)} ${quote(hookCopy)} ${quote(dynamicFile)}`, timeout: 10 }] }] } });
        args.push(...(options.execution?.args ?? ["--agents", JSON.stringify({ "sane-app-execution": { description: "App-managed execution capture", prompt: "" } }), "--agent", "sane-app-execution"]), "--append-system-prompt-file", standingFile, "--settings", settingsFile);
      } else args.push("--settings", "{}");
      const records: any[] = [];
      const record = (kind: string, data: any) => records.push({ seq: records.length + 1, time: new Date().toISOString(), runId, sessionId: runSessionId, kind, data });
      record("launch", { harness: "claude-code", resume, operation: name, nativeAgent: delivery ? "sane-app-execution" : "default", claudeVersion: version, model: options.execution ? "claude-opus-4-6" : "claude-sonnet-4-6",
        ...(options.execution ? { agentFile: manifest.nativeDefinitions, policyTranslation: options.execution.policyTranslation } : {}) });
      if (delivery) {
        record("context", { type: "canonical-context", stage: "prepared", delivery });
        record("context", { type: "canonical-context", stage: "configured", binding: delivery.binding,
          packageRevision: delivery.packageRevision, staticHash: delivery.staticHash, dynamicHash: delivery.dynamicHash, payloadHash: delivery.payloadHash,
          channel: "append-system-prompt-file + UserPromptSubmit", dynamicDelivered: false, snapshot: options.snapshot ?? "default" });
      }
      const trace = traces[name] = { schema: 1, runId, sessionId: runSessionId, status: "started", records };
      const result = await run(name, cli, [...args, prompt]);
      trace.status = result.code === 0 ? "completed" : "failed";
      const captured = requests.filter(r => r.phase === name && r.body);
      for (const request of captured) {
        for (const [channel, text] of [["system", textBlocks(request.body.system).join("\n\n")], ["messages", JSON.stringify(request.body.messages, null, 2)], ...(options.execution ? [[`${request.nativeRequestKind}.full-request`, request.raw]] : [])]) {
          observations.push({ stage: "effective-model-request", evidenceKind: "fixture", observer: "real Claude Code HTTP request captured at loopback mock provider", evidenceRef: join(root, `${request.requestId}.request.json`), requestId: request.requestId,
            runId, sessionId: runSessionId, channel, source: endpoint + "/v1/messages", reason: "real-harness/mock-provider; native serialized request observed, no live model inference", text, sha256: contextHash(text) });
        }
      }
      write(`${name}.trace.json`, trace);
      return { result, captured, delivery, nativeSessionId };
    };
    const base = await launch("base", "Capture this ordinary Base request. Reply briefly.", null, false, { snapshot: "on" });
    expect(base.result.code).toBe(0); expect(base.captured.length).toBeGreaterThan(0);
    const baseSystem = textBlocks(base.captured.at(-1).body.system).join("\n\n");
    expect(baseSystem).toContain("You are");
    expect(baseSystem).not.toContain("CAPTURE_ROLE_MARKER");
    expect(baseSystem).not.toContain("# SANE private procedures");
    check("base-negative-control", "passed", "Ordinary built-in system present; no SANE role or private index injected.", join(root, "base.trace.json"));
    const dynamic = (n: number) => `# Session\nCAPTURE_DYNAMIC_${n}\nworkstreamRoot: ${join(root, `workstream-${n}`)}\nimplementationRoot: ${join(root, `implementation-${n}`)}\n`;
    // Evidence of an existing native snapshot must precede the upgrade. Passing
    // an argv flag alone is insufficient: inspect only our disposable transcript.
    const projectDir = join(config, "projects");
    const baseHistory = readdirSync(projectDir).map(dir => join(projectDir, dir, `${base.nativeSessionId}.jsonl`)).find(existsSync);
    expect(baseHistory).toBeDefined();
    const beforeUpgrade = readFileSync(baseHistory!, "utf8");
    writeFileSync(join(root, "base-before-upgrade.native.jsonl"), beforeUpgrade, { mode: 0o600 });
    const snapshots = beforeUpgrade.trim().split("\n").map(line => JSON.parse(line)).filter(r => r.type === "attachment" && r.attachment?.type === "prompt_snapshot");
    expect(snapshots.length).toBeGreaterThan(0);
    const recordedSystem = snapshots.at(-1).attachment.systemPrompt.join("\n\n");
    expect(recordedSystem).not.toContain("CAPTURE_ROLE_MARKER");
    expect(recordedSystem).not.toContain("# SANE private procedures");
    expect(recordedSystem.length).toBeGreaterThan(1000);
    check("base-snapshot-established", "passed", "Native prompt_snapshot persisted before upgrade; ordinary Base contains no SANE role/index.", join(root, "base-before-upgrade.native.jsonl"));
    let upgradeStanding = "";
    for (const [name, n] of [["upgrade", 4], ["upgrade-resume", 5]] as const) {
      const value = await launch(name, `Capture canonical upgrade turn ${n}. Reply briefly.`, dynamic(n), true,
        // Production retains activation:"upgrade", so every subsequent App
        // launch continues to pass off; it is not a one-time snapshot reset.
        { nativeSessionId: base.nativeSessionId, snapshot: "off" });
      expect(value.result.code).toBe(0); expect(value.captured.length).toBeGreaterThan(0);
      const init = value.result.out.trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "system" && e.subtype === "init");
      expect(init?.session_id).toBe(base.nativeSessionId);
      const body = value.captured.at(-1).body, system = textBlocks(body.system).join("\n\n");
      expect(system).toContain(value.delivery!.standing);
      expect(system.split(role).length - 1).toBe(1);
      expect(system).not.toContain(`CAPTURE_DYNAMIC_${n}`);
      const latest = textBlocks(body.messages.filter((m: any) => m.role === "user").at(-1).content).join("\n\n");
      expect(latest).toContain(dynamic(n));
      if (name === "upgrade") upgradeStanding = value.delivery!.standing;
      else { expect(value.delivery!.standing).toBe(upgradeStanding); expect(latest).not.toContain("CAPTURE_DYNAMIC_4"); }
      check(name, "passed", `${name === "upgrade" ? "Existing native Base snapshot bypassed with --system-prompt-snapshot off" : "Normal App resume retains activation:upgrade and --system-prompt-snapshot off"}; same native session, exact pinned static role/framework/index present once, latest dynamic roots refreshed.`, join(root, `${name}.trace.json`));
      if (name === "upgrade") {
        const control = await launch("upgrade-default-snapshot-control", "Capture snapshot-reuse negative control.", dynamic(6), true,
          { nativeSessionId: base.nativeSessionId });
        expect(control.result.code).toBe(0); expect(control.captured.length).toBeGreaterThan(0);
        const controlSystem = textBlocks(control.captured.at(-1).body.system).join("\n\n");
        expect(controlSystem).not.toContain("CAPTURE_ROLE_MARKER");
        expect(controlSystem).not.toContain("# SANE private procedures");
        expect(controlSystem).toContain(recordedSystem);
        check("upgrade-default-snapshot-control", "passed", "Negative control: omitting off replays the original Base snapshot, losing SANE static text despite appended canonical bytes. Therefore off must persist on normal App resumes of upgraded sessions; it does not replace the old snapshot.", join(root, "upgrade-default-snapshot-control.trace.json"));
      }
    }
    for (const [name, n, resume] of [["fresh", 1, false], ["resume", 2, true]] as const) {
      const value = await launch(name, `Capture turn ${n}. Reply briefly.`, dynamic(n), resume);
      expect(value.result.code).toBe(0); expect(value.captured.length).toBeGreaterThan(0);
      const request = value.captured.at(-1).body;
      const system = textBlocks(request.system).join("\n\n");
      // Native dynamic attribution and environment paragraphs can differ. Compare
      // a substantial unchanged ordinary system block, not just the word Claude.
      const ordinary = textBlocks(base.captured.at(-1).body.system).find(t => t.length > 1000);
      expect(ordinary).toBeDefined();
      expect(system).toContain(ordinary!);
      expect(system).toContain(value.delivery!.standing);
      expect(system.split(role).length - 1).toBe(1);
      expect(system).not.toContain(`CAPTURE_DYNAMIC_${n}`);
      const latest = request.messages.filter((m: any) => m.role === "user").at(-1);
      expect(textBlocks(latest.content).join("\n\n")).toContain(dynamic(n));
      if (n === 2) expect(textBlocks(latest.content).join("\n\n")).not.toContain("CAPTURE_DYNAMIC_1");
      expect(existsSync(join(root, `${name}.dynamic.txt.delivered`))).toBe(true);
      check(name, "passed", "Built-in system block retained by empty main-agent prompt; exact appended role/framework/index bytes present once; fresh dynamic roots in latest user turn.", join(root, `${name}.trace.json`));
    }
    const compact = await launch("compact", "/compact", dynamic(2), true);
    if (compact.result.code === 0 && compact.captured.length && compact.result.out.includes("compact_boundary")) {
      check("compaction", "passed", "Native compact_boundary observed with mock summary; no inference-quality claim.", join(root, "compact.process.json"));
      const restarted = await launch("restart", "Capture after compact and process restart.", dynamic(3), true);
      expect(restarted.result.code).toBe(0); expect(restarted.captured.length).toBeGreaterThan(0);
      const body = restarted.captured.at(-1).body;
      expect(textBlocks(body.system).join("\n\n")).toContain(restarted.delivery!.standing);
      expect(textBlocks(body.messages.filter((m: any) => m.role === "user").at(-1).content).join("\n\n")).toContain(dynamic(3));
      check("post-compaction-restart", "passed", "New process resumed compacted session with exact static text and refreshed dynamic roots.", join(root, "restart.trace.json"));
    } else {
      check("compaction", "skipped", "Bounded /compact probe did not expose a successful native compact_boundary; see raw process and request evidence.", join(root, "compact.process.json"));
      check("post-compaction-restart", "skipped", "Requires evidenced successful compaction.");
    }
    phase = "scout-native-preflight";
    const operationsSource = resolve(import.meta.dir, "../src/canonical-agent-operations.ts");
    writeFileSync(join(root, "canonical-agent-operations.source.ts"), readFileSync(operationsSource), { mode: 0o600 });
    manifest.operationsSource = { path: operationsSource, sha256: contextHash(readFileSync(operationsSource, "utf8")) };
    const loadWorker = (name: string, override?: { model: string; variant: string }) => {
      const path = resolve(import.meta.dir, `../../../opencode/agents/sane/worker/${name}.md`);
      const markdown = readFileSync(path, "utf8");
      writeFileSync(join(root, `${name}.source.md`), markdown, { mode: 0o600 });
      const policy = parseCanonicalAgentOperations(markdown, `sane/worker/${name}`, override);
      write(`${name}.policy.json`, { path, sha256: contextHash(markdown), policy });
      return policy;
    };
    const implementer = loadWorker("implementer"), scout = loadWorker("scout", { model: "anthropic/claude-sonnet-4-6", variant: "high" }), researcher = loadWorker("researcher");
    scoutRole = scout.spec.body;
    const execution = claudeExecutionConfiguration({ policy: implementer, children: [scout, researcher], model: "claude-opus-4-6", effort: "low" });
    write("scout-native.execution.json", execution);
    const definitions = JSON.stringify(execution.agents, null, 2) + "\n";
    writeFileSync(join(root, "scout-native.definitions.json"), definitions, { mode: 0o600 });
    manifest.nativeDefinitions = { path: join(root, "scout-native.definitions.json"), sha256: contextHash(definitions) };
    expect(execution.agents["sane-worker-scout"]?.prompt).toBe(scoutRole);
    expect(execution.policyTranslation.children.find(c => c.canonicalId === scout.spec.name)?.model.source).toBe("pinned");
    const workerBundle = createContextPackage({ kind: "worker", role: "implementer" }, [contextAsset("role.worker.implementer", "implementer.source.md", implementer.spec.body, "role")]);
    write("implementer.source-package.json", workerBundle);
    const childRun = await launch("scout-native", "Invoke the configured Scout once for this bounded transport capture; report its result.", dynamic(7), false,
      { nativeSessionId: randomUUID(), execution, bundle: workerBundle, assignment: "CAPTURE_PARENT_ASSIGNMENT_ONLY: Delegate one bounded Scout capture; no file changes." });
    expect(childRun.result.code).toBe(0);
    const nativeEvents = childRun.result.out.trim().split("\n").map(line => JSON.parse(line));
    expect(nativeEvents.find(e => e.type === "system" && e.subtype === "init")?.permissionMode).toBe("bypassPermissions");
    expect(nativeEvents.some(e => e.type === "assistant" && e.parent_tool_use_id === "toolu_capture_scout")).toBe(true);
    expect(nativeEvents.some(e => e.type === "system" && e.subtype === "task_notification" && e.status === "completed")).toBe(true);
    expect(nativeEvents.filter(e => e.type === "result").every(e => e.subtype === "success" && !e.is_error)).toBe(true);
    const parents = childRun.captured.filter(r => r.nativeRequestKind === "implementer-parent");
    const children = childRun.captured.filter(r => r.nativeRequestKind === "scout-child");
    expect(parents.length).toBeGreaterThanOrEqual(2); expect(children.length).toBe(1);
    expect(parents[0].body.model).toBe("claude-opus-4-6");
    expect(parents[0].body.output_config.effort).toBe("low");
    expect(parents[0].body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["Agent", "Edit", "Write", "NotebookEdit"]));
    const childRequest = children[0], childSystem = textBlocks(childRequest.body.system).join("\n\n");
    expect(childSystem.split(scoutRole).length - 1).toBe(1);
    expect(childRequest.raw).not.toContain("CAPTURE_PARENT_ASSIGNMENT_ONLY");
    expect(childSystem).not.toContain(implementer.spec.body);
    expect(childSystem).not.toContain(workerBundle.assets.find(a => a.id === "worker-procedure.implementer")!.text);
    expect(childRequest.raw).not.toContain(JSON.stringify(workerBundle.assets.find(a => a.id === "worker-procedure.implementer")!.text).slice(1, -1));
    const childTools = childRequest.body.tools.map((t: any) => t.name);
    expect(childTools).toEqual(expect.arrayContaining(["Read", "Bash"]));
    for (const denied of execution.agents["sane-worker-scout"]!.disallowedTools!) expect(childTools).not.toContain(denied);
    expect(childRequest.body.model).toBe("claude-sonnet-4-6");
    const childEvidence = { requestId: childRequest.requestId, model: childRequest.body.model, effort: childRequest.body.output_config?.effort ?? null,
      tools: childTools, nativeDefinitions: manifest.nativeDefinitions, policyTranslation: execution.policyTranslation, parentPermissionMode: "bypassPermissions" };
    write("scout-native.observed-policy.json", childEvidence);
    check("native-scout-role", "passed", "Real Agent tool invocation delivered exact authored Scout role once; no parent role, worker procedure, or assignment leaked.", join(root, `${childRequest.requestId}.request.json`));
    check("native-scout-disallowed-tools", "passed", `Parent had Edit/Write/NotebookEdit and bypassPermissions; child inventory excluded all translated denies and retained Read/Bash. Observed tools: ${childTools.join(", ")}. This is whole-tool inventory enforcement, not a read-only OS sandbox: authored Bash access remains.`, join(root, "scout-native.observed-policy.json"));
    check("native-scout-pinned-model", "passed", "Child request model claude-sonnet-4-6 overrides parent claude-opus-4-6 using pinned child policy (no childProfiles or Agent model argument).", join(root, "scout-native.observed-policy.json"));
    if (childEvidence.effort !== null) {
      expect(childEvidence.effort).toBe("high");
      check("native-scout-pinned-effort", "passed", "Child request output_config.effort is high, from pinned variant.", join(root, "scout-native.observed-policy.json"));
    } else check("native-scout-pinned-effort", "skipped", "Native definition effort=high is captured; this CLI/provider request did not expose output_config.effort, so runtime effort is unproven.", join(root, "scout-native.observed-policy.json"));
    expect(calls).toBeLessThanOrEqual(maxProviderCalls);
    expect(requests.every(r => r.authorizationAbsent && (r.dummyKeyMatched || (r.apiKeyAbsent && r.method === "HEAD" && new URL(r.url).pathname === "/api/hello")))).toBe(true);
    expect(requests.filter(r => r.body).every(r => r.dummyKeyMatched)).toBe(true);
    check("dummy-auth-only", "passed", `${calls} local calls; model requests carried only the known dummy API key, HEAD /api/hello probes were unauthenticated; kernel policy prevents remote provider access.`);
    check("live-model-behavior", "skipped", "Intentionally no live model or paid provider: mock responses prove transport only.");
  } catch (error) {
    check(phase, "failed", String(error));
    throw error;
  } finally {
    for (const pid of active) kill(pid);
    server?.stop(true);
    manifest.claudeVersion = version; manifest.providerCalls = calls;
    manifest.checkCounts = Object.fromEntries(["passed", "failed", "skipped"].map(s => [s, checks.filter(c => c.status === s).length]));
    write("manifest.json", manifest); write("requests.json", requests);
    write("checks.json", { schema: 1, checks, observations });
    for (const [name, trace] of Object.entries(traces)) {
      write(`${name}.trace.json`, trace);
      write(`${name}.checks.json`, { schema: 1, checks, observations: observations.filter(o => o.runId === trace.runId) });
    }
  }
}, 240000);
