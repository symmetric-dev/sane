import { expect, test } from "bun:test";
import { branchContextDynamic } from "./branch-context";
import type { BranchOperation } from "./branches";
import { contextAsset, createContextPackage, renderContextDelivery } from "./context-package";
import type { Session } from "./history";
import { OpenCodeAdapter } from "./opencode";

const bundle = createContextPackage({ kind: "assistant", role: "planning" }, [
  contextAsset("role.assistant.planning", "planning.md", "Pinned planning role", "role"),
  contextAsset("sane-assistant-planning-pickup", "pickup.md", "Pinned Pickup procedure", "procedure"),
]);
const roots = "# SANE Session\n\nImplementation root: /repo";
const canonical = (sessionId: string): Pick<Session, "sessionId" | "saneExecution" | "saneContext"> => ({ sessionId,
  saneExecution: { schema: 1, revision: "a".repeat(64) },
  saneContext: { version: 4, framework: "pinned", package: { schema: 1, revision: bundle.revision, delivery: "standing-native-role" } },
});
const branch = (sourceId: string, destinationId: string): BranchOperation => ({ id: destinationId, sourceId, destinationId, nativeId: "ses_fixture", boundary: "boundary", sourceFingerprint: "b".repeat(64), selector: "message:boundary", replace: true, state: "completed", createdAt: "2026-10-13T03:29:41.495Z", canonicalActivation: true });
const delivery = (sessionId: string, dynamic: string, harness = "opencode") => renderContextDelivery(bundle,
  { sessionId, nativeSessionId: "ses_fixture", authorityId: "authority", harness, cwd: "/repo" },
  { "sane-assistant-planning-pickup": "/pinned/pickup.md" }, dynamic, undefined, true);

test("already-canonical native fork reads inherited entry without rewriting it", async () => {
  const sessions = [canonical("source"), canonical("fork")];
  const original = delivery("source", roots);
  const fork = delivery("fork", branchContextDynamic("fork", roots, [branch("source", "fork")], sessions));
  const inherited = `${original.standing}\n\n${original.dynamic}`;
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const methods: string[] = [];
  adapter.request = async <T>(_path: string, method = "GET"): Promise<T> => {
    methods.push(method);
    if (method !== "GET") throw new Error("Fork rewrote inherited canonical context");
    return { data: [{ key: "sane.context", value: inherited }] } as T;
  };
  await adapter.deliverContextEntry("ses_fixture", `${fork.standing}\n\n${fork.dynamic}`, true, () => {});
  expect(methods).toEqual(["GET"]);
  expect(fork.staticHash).toBe(original.staticHash);
  expect(fork.payloadHash).toBe(original.payloadHash);
  expect(fork.standing.split("Pinned planning role")).toHaveLength(2);
});

test("legacy activation and its canonical descendants retain identical migration guidance", () => {
  const sessions = [{ sessionId: "legacy" }, canonical("migrated"), canonical("fork")];
  const operations = [branch("legacy", "migrated"), branch("migrated", "fork")];
  const migrated = branchContextDynamic("migrated", roots, operations, sessions);
  expect(migrated).toContain("Do not restart Pickup");
  expect(branchContextDynamic("fork", roots, operations, sessions)).toBe(migrated);
  expect(sessions[0]).toEqual({ sessionId: "legacy" });
});

test("fresh native Claude launch retains standing policy and current dynamic roots", () => {
  const dynamic = branchContextDynamic("fork", roots + "/changed", [branch("source", "fork")], [canonical("source")]);
  const current = delivery("fork", dynamic, "claude-code");
  expect(current.standing).toContain("Pinned planning role");
  expect(current.standing).toContain("# SANE Context");
  expect(current.standing).toContain("Pinned Pickup procedure");
  expect(current.dynamic).toBe(roots + "/changed");
});

test("uncompleted branches do not change context; incomplete provenance retains migration guidance", () => {
  expect(branchContextDynamic("fork", roots, [{ ...branch("source", "fork"), state: "confirmed" }], [])).toBe(roots);
  expect(branchContextDynamic("fork", roots, [branch("source", "fork")], [])).toContain("branch continuation");
  expect(() => branchContextDynamic("fork", roots, [branch("source", "fork"), branch("fork", "source")], [canonical("source"), canonical("fork")])).toThrow("Cyclic");
});
