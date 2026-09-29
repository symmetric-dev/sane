import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepository, initializeRepository, inspectRepositoryStore, normalizeNativeSource, openRepositoryDomain } from "../packages/sane-core/src/server.ts"
import { linkNativeCaller, nativeCallerContext, nativeCallerEnvelope, openNativeCaller, type NativeCaller } from "../packages/sane-cli/src/native-caller.ts"
import { consumeClaudeInvocation, issueClaudeInvocation } from "../packages/sane-cli/src/native-claude.ts"
import { classifyCaller } from "../packages/sane-cli/src/cli-arguments.ts"

test("native enrollment shares repository authority, inherits locally and preserves execution pins", () => {
  const root = mkdtempSync(join(tmpdir(), "sane-native-"))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
  try {
    const repo = join(root, "repo"), other = join(root, "other"), worktree = join(root, "worktree"), profile = join(root, "profile")
    for (const path of [repo, other, profile]) mkdirSync(path)
    for (const path of [repo, other]) {
      git(path, "init"); git(path, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "initial")
      const domain = openRepositoryDomain(initializeRepository(discoverRepository(path)))
      try { domain.createWorkstream({ id: "native", title: "Native", type: "feature" }, { actor: { kind: "local" }, correlationId: crypto.randomUUID() }) } finally { domain.close() }
    }
    git(repo, "worktree", "add", "-b", "native", worktree)
    const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile })
    const caller: NativeCaller = { source: source.descriptor, authorityId: source.authorityId, nativeId: crypto.randomUUID(), cwd: repo, ancestors: [], correlationId: crypto.randomUUID() }
    expect(() => nativeCallerContext(caller)).toThrow("not enrolled")
    const parent = linkNativeCaller(caller, { slot: "design", workstream: "native" })
    expect(parent.workstream).toBe("native")
    expect(parent.harness).toBe("cc")
    expect(parent.phase).toBe("design")
    expect(nativeCallerEnvelope(caller).nativeId).toBe(caller.nativeId)
    expect(classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(nativeCallerEnvelope(caller)) }).actorKind).toBe("native")
    const child = { ...caller, nativeId: crypto.randomUUID(), cwd: worktree, ancestors: [{ nativeId: caller.nativeId, cwd: repo }] }
    const linked = linkNativeCaller(child, { slot: "engineering" })
    expect(linked.workstream).toBe("native")
    expect(linked.phase).toBe("engineering")
    const openedChild = openNativeCaller(child)
    try {
      expect(openedChild.context.conversation.parent).toEqual({ harness: "cc", authorityId: source.authorityId, nativeId: caller.nativeId })
      expect(openedChild.context.executionCheckout).toBe(discoverRepository(worktree).invocationCheckout.path)
    } finally { openedChild.domain.close() }
    expect(linked.context).toContain(discoverRepository(worktree).invocationCheckout.path)
    expect(() => nativeCallerContext({ ...child, cwd: repo })).toThrow("execution checkout")
    const foreign = openNativeCaller({ ...caller, nativeId: crypto.randomUUID(), cwd: other, ancestors: child.ancestors }, true)
    try { expect(foreign.context.conversation.parent).toBeNull(); expect(foreign.context.workstream).toBeNull() } finally { foreign.domain.close() }
    const state = inspectRepositoryStore(discoverRepository(repo))
    if (state.state !== "ready") throw new Error(state.message)
    const domain = openRepositoryDomain(state.context)
    try { domain.associateConversation({ harness: "cc", authorityId: source.authorityId, nativeId: child.nativeId }, null, { actor: { kind: "local" }, correlationId: crypto.randomUUID() }) } finally { domain.close() }
    expect(nativeCallerContext(child).workstream).toBeNull()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("Claude invocation capabilities bind concurrent callers and reject substitution, replay and child aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "sane-claude-binding-")), profile = join(root, "profile"), bindings = join(root, "bindings")
  mkdirSync(profile)
  const hook = (session_id: string) => ({ hook_event_name: "PreToolUse", session_id, cwd: root, tool_use_id: crypto.randomUUID(), prompt_id: crypto.randomUUID(), tool_name: "mcp__sane__sane_context", tool_input: {} })
  try {
    const first = hook(crypto.randomUUID()), second = hook(crypto.randomUUID())
    const a = issueClaudeInvocation(bindings, profile, first), b = issueClaudeInvocation(bindings, profile, second)
    expect(consumeClaudeInvocation(bindings, profile, "sane_context", b).caller.nativeId).toBe(second.session_id)
    expect(consumeClaudeInvocation(bindings, profile, "sane_context", a).caller.nativeId).toBe(first.session_id)
    expect(() => consumeClaudeInvocation(bindings, profile, "sane_context", a)).toThrow()
    expect(() => consumeClaudeInvocation(bindings, profile, "sane_context", {})).toThrow()
    const changed = issueClaudeInvocation(bindings, profile, first)
    expect(() => consumeClaudeInvocation(bindings, profile, "sane_context", { ...changed, workstream: "other" })).toThrow()
    expect(() => consumeClaudeInvocation(bindings, profile, "sane_context", changed)).toThrow()
    expect(() => issueClaudeInvocation(bindings, profile, { ...first, agent_id: "child" })).toThrow("not a qualified resumable conversation")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
