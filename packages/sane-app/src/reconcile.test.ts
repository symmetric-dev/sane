import { expect, test } from "bun:test";
import { normalizeClaudeHistory, coveredNativeRuns } from "./reconcile";
import { validateMetadata } from "./history";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("reconciliation coverage requires actual native command identity; Claude coverage stays separate", () => {
  const session = { sessionId: "A", harness: "opencode" as const, nativeSessionId: "ses_A", cwd: "/fixture", lastRunId: "rejected", lastStatus: "failed" as const };
  const runs = ["accepted", "rejected"].map(runId => ({ runId, sessionId: "A", nativeCommandId: `msg_${runId}`, cwd: "/fixture", status: "failed" as const, createdAt: new Date().toISOString() }));
  const messages = [{ messageId: "msg_accepted", role: "user" as const, parts: [], status: "completed" as const, createdAt: "" }];
  expect(coveredNativeRuns(session, runs, messages)).toEqual(["accepted"]);
  expect(coveredNativeRuns({ ...session, harness: "claude-code" }, runs, messages)).toEqual([]);
  expect(coveredNativeRuns(session, runs, [{ ...messages[0]!, role: "assistant" }])).toEqual([]);
});

test("Claude import upserts native IDs and tool results without inventing time or completion", () => {
  const record = (uuid: string, type: "assistant" | "user", content: unknown) => ({ uuid, type, session_id: "fixture", message: { content }, parent_tool_use_id: null, parent_agent_id: null });
  const messages = normalizeClaudeHistory("fixture", [
    record("user", "user", "  retain spaces  "),
    record("assistant", "assistant", [{ type: "text", text: "before" }]),
    record("assistant", "assistant", [{ type: "text", text: "after" }, { type: "tool_use", id: "tool", name: "Read", input: { file: "fixture" } }]),
    record("result", "user", [{ type: "tool_result", tool_use_id: "tool", content: "file content" }]),
    { ...record("subagent", "assistant", "not main history"), parent_tool_use_id: "tool" },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages.map(m => m.createdAt)).toEqual(["", ""]);
  expect(messages.map(m => m.status)).toEqual(["unknown", "unknown"]);
  expect(messages[1]!.parts[1]).toMatchObject({ id: "tool", status: "completed", output: "file content" });
  expect(messages[0]!.parts[0]).toMatchObject({ text: "  retain spaces  " });
  expect(() => normalizeClaudeHistory("wrong", [record("user", "user", "wrong session")])).toThrow("identity mismatch");
});

test("metadata permits parallel runs but rejects duplicate native aliases and same-conversation overlap", () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID(), ar = crypto.randomUUID(), br = crypto.randomUUID();
  const authorityId = `sane-native-v1:oc:${"a".repeat(64)}`;
  const sessions = [a, b].map((id, i) => ({ sessionId: id, nativeSessionId: `ses_${i}`, harness: "opencode", authorityId, cwd: "/fixture", lastStatus: "running", lastRunId: i ? br : ar }));
  const runs = sessions.map(s => ({ runId: s.lastRunId, sessionId: s.sessionId, cwd: s.cwd, status: "running", createdAt: new Date().toISOString(), nativeCommandId: `msg_${s.sessionId}`, nativePhase: "accepted" }));
  expect(validateMetadata({ sessions, runs, reconciliationRequired: false }).runs).toHaveLength(2);
  expect(() => validateMetadata({ sessions: [sessions[0], { ...sessions[1], nativeSessionId: "ses_0" }], runs, reconciliationRequired: false })).toThrow();
  expect(() => validateMetadata({ sessions, runs: [...runs, { ...runs[0], runId: crypto.randomUUID() }], reconciliationRequired: false })).toThrow();
});

test("installed Claude SDK reads a synthetic isolated transcript without launching Claude", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-c6-sdk-")));
  try {
    const cwd = join(root, "repo"), config = join(root, "config"), id = crypto.randomUUID(); await mkdir(cwd);
    const project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(project, { recursive: true });
    const user = crypto.randomUUID(), assistant = crypto.randomUUID();
    const base = { sessionId: id, cwd, version: "2.1.283", isSidechain: false, timestamp: new Date().toISOString() };
    await writeFile(join(project, `${id}.jsonl`), [
      { ...base, type: "user", uuid: user, parentUuid: null, message: { role: "user", content: "fixture only" } },
      { ...base, type: "assistant", uuid: assistant, parentUuid: user, message: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "fixture response" }] } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    // Separate environment prevents SDK caches/config lookup from ever touching
    // real Claude history. This is a reader process, not a native agent invocation.
    const child = Bun.spawn([process.execPath, "-e", `import {readClaudeHistory} from ${JSON.stringify(resolve(import.meta.dir, "reconcile.ts"))}; console.log(JSON.stringify(await readClaudeHistory(${JSON.stringify(id)},${JSON.stringify(cwd)})));`], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "", PATH: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    const messages = JSON.parse(out); expect(messages).toHaveLength(2);
    expect(messages[0].messageId).toBe(user); expect(messages[1].parts[0].text).toBe("fixture response");
  } finally { await rm(root, { recursive: true, force: true }); }
});
