import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { consumeClaudeInvocation, issueClaudeInvocation } from "../src/native-claude.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const path = mkdtempSync(join(tmpdir(), "sane-binding-test-")); roots.push(path); return path }
let profile: string
beforeEach(() => { profile = root() })
const body = { worker: "critic", prompt: "private prompt must never appear in errors" }
function issue(directory: string, input: Record<string, unknown> = body) {
  return issueClaudeInvocation(directory, profile, {
    hook_event_name: "PreToolUse", session_id: "274b8339-79a3-47a9-95be-29d0c279f6be",
    cwd: "/test/repository", tool_use_id: "tool-call", tool_name: "mcp__sane__sane_worker_start", tool_input: input,
  })
}
function failure(action: () => unknown, reason: string) {
  try { action(); throw new Error("Expected rejection") } catch (error) {
    expect((error as { code: string }).code).toBe("NATIVE_CONTEXT_UNAVAILABLE")
    expect((error as Error).message).toBe(`Claude native caller binding is missing, invalid, expired or already consumed. [${reason}]`)
  }
}
test("duplicate hooks with different roots cannot authorize each other's tokens", () => {
  const appRoot = root(), serverRoot = root()
  const appInput = issue(appRoot), serverInput = issue(serverRoot)
  failure(() => consumeClaudeInvocation(serverRoot, profile, "sane_worker_start", appInput), "binding-not-found")
  expect(consumeClaudeInvocation(serverRoot, profile, "sane_worker_start", serverInput).input).toEqual(body)
  // A wrong-root lookup neither consumes nor authorizes the other root's binding.
  expect(consumeClaudeInvocation(appRoot, profile, "sane_worker_start", appInput).input).toEqual(body)
  failure(() => consumeClaudeInvocation(serverRoot, profile, "sane_worker_start", serverInput), "binding-not-found")
})
test("missing hook output and malformed tokens have distinct secret-safe diagnostics", () => {
  const directory = root()
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", body), "missing-token")
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", { ...body, _invocation: "secret" }), "invalid-token")
})
test("body transforms fail closed and consume the binding; property order does not matter", () => {
  const directory = root(), input = issue(directory)
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", { ...input, prompt: "changed private prompt" }), "body-mismatch")
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", input), "binding-not-found")
  const fresh = issue(directory)
  expect(consumeClaudeInvocation(directory, profile, "sane_worker_start", { _invocation: fresh._invocation, prompt: body.prompt, worker: body.worker }).input).toEqual(body)
})
test("tool and profile mismatches remain rejected", () => {
  const directory = root()
  failure(() => consumeClaudeInvocation(directory, profile, "sane_context", issue(directory)), "tool-mismatch")
  failure(() => consumeClaudeInvocation(directory, root(), "sane_worker_start", issue(directory)), "profile-mismatch")
  failure(() => consumeClaudeInvocation(directory, "/missing/private-profile", "sane_worker_start", issue(directory)), "binding-read-failed")
})
test("stored binding failures expose only fixed reasons", () => {
  const directory = root()
  for (const [reason, mutate] of [
    ["expired-binding", (b: any) => { b.issuedAt = Date.now() - 300001 }],
    ["future-binding", (b: any) => { b.issuedAt = Date.now() + 60000 }],
    ["invalid-binding", (b: any) => { b.version = 2 }],
  ] as const) {
    const input = issue(directory), path = join(directory, `${createHash("sha256").update(input._invocation).digest("hex")}.json`)
    const binding = JSON.parse(readFileSync(path, "utf8")); mutate(binding); writeFileSync(path, JSON.stringify(binding))
    failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", input), reason)
  }
  const input = issue(directory), path = join(directory, `${createHash("sha256").update(input._invocation).digest("hex")}.json`)
  writeFileSync(path, "secret invalid JSON")
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", input), "binding-read-failed")
  const unsafe = issue(directory), unsafePath = join(directory, `${createHash("sha256").update(unsafe._invocation).digest("hex")}.json`)
  chmodSync(unsafePath, 0o644)
  failure(() => consumeClaudeInvocation(directory, profile, "sane_worker_start", unsafe), "unsafe-binding")
})
