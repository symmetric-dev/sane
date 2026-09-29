import { describe, expect, test } from "bun:test"
import { classifyCaller, parseCliCommand as parse, type CallerEnvelope } from "../src/cli-arguments.ts"

const cc: CallerEnvelope = { version: 1, repository: "/repo", source: { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/profiles/cc" }, authorityId: "authority-cc", nativeId: "native-one" }
const oc: CallerEnvelope = { ...cc, source: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/sources/service.json" }, authorityId: "authority-oc" }
const explicit = (caller: CallerEnvelope) => ["--caller-repo", caller.repository, "--caller-source", JSON.stringify(caller.source), "--caller-authority", caller.authorityId, "--caller-native-id", caller.nativeId]
const managed = ["--harness", "oc", "--authority", "other-source", "--native-id", "managed-id"]
const ok = (args: string[]) => expect(parse(args).kind).toBe("command")
const bad = (args: string[]) => expect(parse(args).kind).toBe("error")

describe("pure caller classification", () => {
  test("absent is local, never a fabricated human/native", () => expect(classifyCaller({})).toEqual({ actorKind: "local" }))
  for (const caller of [cc, oc]) {
    test(`${caller.source.harness}: envelope and explicit complete flags`, () => {
      const signals = { SANE_CALLER_CONTEXT: JSON.stringify(caller), SANE_SESSION_ID: caller.nativeId }
      expect(classifyCaller(signals)).toEqual({ actorKind: "native", envelope: caller })
      expect(parse(["status", ...explicit(caller)], signals).kind).toBe("command")
      expect(parse(["status", ...explicit(caller)]).kind).toBe("command")
      expect(parse(["status", ...explicit({ ...caller, repository: "/different" })], signals)).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
    })
    test(`${caller.source.harness}: every partial envelope fails even with explicit target`, () => {
      for (const key of Object.keys(caller)) {
        const partial = { ...caller } as Record<string, unknown>; delete partial[key]
        expect(parse(["init", "--repo", "/override"], { SANE_CALLER_CONTEXT: JSON.stringify(partial) })).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
      }
      for (let i = 0; i < 8; i += 2) {
        const flags = explicit(caller); flags.splice(i, 2)
        expect(parse(["status", "--workstream", "target", ...flags])).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
      }
    })
  }
  test("raw session IDs never fallback, including empty/conflicting values", () => {
    for (const key of ["SANE_SESSION_ID", "OPENCODE_SESSION_ID"]) for (const value of ["", "native-one"]) {
      expect(parse(["status", "--repo", "/repo", "--workstream", "target"], { [key]: value })).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
    }
    expect(parse(["status"], { SANE_CALLER_CONTEXT: JSON.stringify(cc), OPENCODE_SESSION_ID: cc.nativeId }).kind).toBe("error")
    expect(parse(["status"], { SANE_CALLER_CONTEXT: JSON.stringify(oc), OPENCODE_SESSION_ID: oc.nativeId }).kind).toBe("command")
    expect(parse(["status"], { SANE_CALLER_CONTEXT: JSON.stringify(oc), SANE_SESSION_ID: "different" }).kind).toBe("error")
  })
  test("strict version, shape, source, and value validation; errors redact input", () => {
    const malformed = ["", "{secret", "null", "[]", JSON.stringify({ ...cc, version: 2 }), JSON.stringify({ ...cc, extra: true }), JSON.stringify({ ...cc, repository: "relative" }), JSON.stringify({ ...cc, nativeId: "\n" }), JSON.stringify({ ...cc, source: { ...cc.source, extra: true } }), JSON.stringify({ ...oc, source: { ...oc.source, kind: "endpoint" } })]
    for (const value of malformed) {
      const result = parse(["init", "--repo", "/repo"], { SANE_CALLER_CONTEXT: value })
      expect(result).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
      expect(JSON.stringify(result)).not.toContain("secret")
    }
  })
  test("malformed source harness types return structured errors without coercion", () => {
    const malformedHarnesses: unknown[] = [["oc"], ["cc"], { toString: "oc" }, { toString: "cc" }, {}, [], null, true, 1]
    for (const source of [cc.source, oc.source]) {
      for (const harness of malformedHarnesses) {
        const malformedSource = { ...source, harness }
        expect(parse(["init", "--repo", "/override"], {
          SANE_CALLER_CONTEXT: JSON.stringify({ ...cc, source: malformedSource }),
        })).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
        expect(parse(["authority", "declare", "--repo", "/repo", "--source", JSON.stringify(malformedSource)]))
          .toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" })
      }
    }
  })
  test("managed subject and invoking caller remain separate", () => {
    const result = parse(["conversation", "associate", "--repo", "/repo", "--workstream", "target", ...managed, ...explicit(cc)])
    expect(result).toMatchObject({ kind: "command", intent: { caller: { actorKind: "native", envelope: cc }, options: { "native-id": "managed-id", harness: "oc" } } })
    expect(parse(["conversation", "associate", "--repo", "/repo", "--workstream", "target", ...managed], { SANE_SESSION_ID: "managed-id" }).kind).toBe("error")
  })
})

describe("command grammar", () => {
  test("ordinary lifecycle and selectors", () => {
    for (const command of ["init", "inspect", "list", "detail", "status", "view", "sessions", "audit"]) ok([command, "--repo", "../checkout", "--json"])
    for (const type of ["feature", "foundation", "issue", "maintenance"]) ok(["create", "--name", "safe-id", "--type", type, "--title", "Display title"])
    ok(["select", "--workstream", "target"])
    for (const phase of ["design", "engineering", "planning", "execution"]) {
      ok(["provide", phase, "--refresh-templates"]); ok(["validate", phase]); ok(["approve", phase, "--ref", "user-approval"])
    }
    ok(["validate", "execution", "report", "--id", "job-1"])
    ok(["job", "--register"]); ok(["job", "job-1"]); ok(["job", "job-1", "running"]); ok(["job", "job-1", "completed"])
  })
  test("research subcommands", () => {
    ok(["research"]); ok(["research", "index"]); ok(["research", "register", "--topic", "topic", "--path", "research/topic.md"]); ok(["research", "unregister", "--topic", "topic"])
    for (const args of [["register"], ["register", "--topic", "topic"], ["index", "--topic", "topic"], ["unregister", "--topic", "topic", "--path", "x"], ["--register"], ["unknown"]]) bad(["research", ...args])
  })
  test("qualified administration and exact assignment ending", () => {
    ok(["authority", "declare", "--repo", "/repo", "--source", JSON.stringify(cc.source)])
    for (const action of ["get", "context", "unassign"]) ok(["conversation", action, "--repo", "/repo", ...managed])
    ok(["conversation", "register", "--repo", "/repo", ...managed, "--checkout", "/checkout", "--parent-harness", "cc", "--parent-authority", "parent-source", "--parent-native-id", "parent-id"])
    ok(["phase", "assign", "research:topic", "--repo", "/repo", ...managed])
    ok(["phase", "target", "execution", "--repo", "/repo", "--workstream", "target"])
    ok(["phase", "end", "--repo", "/repo", "--assignment-id", "exact-episode"])
    ok(["default-checkout", "--workstream", "target", "--clear"])
    ok(["default-checkout", "--workstream", "target", "--checkout", "/checkout"])
    bad(["phase", "end", "--repo", "/repo", ...managed]); bad(["conversation", "get", ...managed]); bad(["conversation", "get", "--repo", "/repo", "--native-id", "bare"])
    bad(["conversation", "register", "--repo", "/repo", ...managed, "--checkout", "/checkout", "--parent-harness", "cc"])
  })
  test("strict duplicates, unknowns, conflicts, arity and retired flags", () => {
    for (const args of [
      ["status", "--repo", "a", "--repo", "a"], ["status", "--json", "--json"], ["status", "--json", "--verbose"],
      ["status", "--repo"], ["status", "--repo=a"], ["status", "--wat"], ["status", "--session", "bare"],
      ["status", "--candidate-workstream", "x"], ["status", "old-root", "old-workstream"], ["status", "--workstream", "../escape"],
      ["create", "--name", "x"], ["create", "--name", "x", "--type", "unknown"], ["approve", "design"],
      ["validate", "design", "--id", "job"], ["validate", "design", "report", "--id", "job"], ["job", "job", "planned"], ["job", "job", "--register"],
      ["default-checkout", "--workstream", "x", "--clear", "--checkout", "/x"], ["constructor", "--repo", "/x"], ["unknown"],
    ]) bad(args)
    bad(["select", "--workstream", "target", ...explicit(cc)])
  })
  test("help and retired commands are terminal even with unusable native evidence", () => {
    const signals = { SANE_SESSION_ID: "bare" }
    expect(parse([], signals).kind).toBe("help")
    expect(parse(["init", "--help", "--unknown"], signals).kind).toBe("help")
    for (const command of ["candidate", "link", "handoff", "worktree", "merge", "delete", "archive", "purge", "rename"]) expect(parse([command, "--anything"], signals)).toEqual({ kind: "unavailable", code: "FEATURE_UNAVAILABLE", command })
  })
  test("inputs remain unchanged and no ambient signal is consulted", () => {
    const args = Object.freeze(["status", "--repo", "relative"])
    const signals = Object.freeze({})
    expect(parse(args, signals)).toEqual(parse(args, signals))
    expect(args).toEqual(["status", "--repo", "relative"])
  })
})
