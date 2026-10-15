import { describe, expect, test } from "bun:test";
import { DomainError } from "sane-core/server";
import type { Handoff } from "sane-core/contracts";
import { HandoffService } from "./handoff";

// Focused approval-gate coverage: approve/deny via domain.advanceHandoff with
// optimistic-concurrency revisions. Stale revisions must surface as CONFLICT
// so callers refresh before retrying (validateWorkstreamInput pattern).

function makeService(initial: Handoff, opts?: { bound?: boolean }) {
  let stored: Handoff = structuredClone(initial);
  const calls: { id: string; revision: number; change: unknown; actor: unknown }[] = [];
  const checkout = (stored.recipient as unknown as { checkout: unknown }).checkout;
  void checkout;
  void opts;
  const domain = {
    getHandoff: (id: string): Handoff => {
      if (id !== stored.id) throw new DomainError("NOT_FOUND", "Unknown handoff.");
      return structuredClone(stored);
    },
    advanceHandoff: (id: string, expectedRevision: number, change: { status: Handoff["status"]; evidence?: string }, context: { actor: { kind: string }; correlationId: string }): Handoff => {
      calls.push({ id, revision: expectedRevision, change: structuredClone(change), actor: structuredClone(context.actor) });
      if (id !== stored.id) throw new DomainError("NOT_FOUND", "Unknown handoff.");
      if (expectedRevision !== stored.revision) throw new DomainError("CONFLICT", "Handoff changed; reconcile current state.");
      const allowed: Record<string, string[]> = { awaiting_approval: ["queued", "failed"] };
      if (!(allowed[stored.status] ?? []).includes(change.status)) throw new DomainError("CONFLICT", "Invalid handoff transition.");
      if (change.status === "failed" && !change.evidence?.trim()) throw new DomainError("INVALID_INPUT", "Denial reason required.");
      if (context.actor.kind !== "human" && context.actor.kind !== "system") throw new DomainError("INVALID_CONTEXT", "Handoff approval requires a human operator or the App execution owner.");
      stored = { ...structuredClone(stored), status: change.status, revision: stored.revision + 1, evidence: change.evidence ?? null, updatedAt: new Date().toISOString() };
      return structuredClone(stored);
    },
  };
  const router = { forWorkspace: async (_workspaceId: string) => ({ domain }) } as unknown as ConstructorParameters<typeof HandoffService>[2];
  const admissions = { get: () => undefined, list: () => [] } as unknown as ConstructorParameters<typeof HandoffService>[0];
  const catalog = {} as ConstructorParameters<typeof HandoffService>[1];
  const sources = {} as ConstructorParameters<typeof HandoffService>[3];
  const sessions = () => [] as ReturnType<ConstructorParameters<typeof HandoffService>[4]>;
  const service = new HandoffService(admissions, catalog, router, sources, sessions, () => {}, "store-1", async () => {
    throw new Error("unused");
  });
  return { service, domain, calls, current: () => structuredClone(stored) };
}

const baseHandoff = (overrides?: Partial<Handoff>): Handoff =>
  ({
    id: "handoff-1",
    repositoryId: "repo-1",
    sender: { harness: "cc", authorityId: "auth-1", nativeId: "native-sender" },
    workstreamId: "ws-1",
    input: { requestId: "req-1", to: "engineering", message: "help" } as Handoff["input"],
    recipient: { ownerId: "store-1", sessionId: "sess-recipient", ref: null, harness: "cc", authorityId: "auth-1", checkout: { path: "/tmp", commonDir: "/tmp", gitDir: "/tmp/.git", device: 1, inode: 1, commonDevice: 1, commonInode: 1, gitDevice: 1, gitInode: 1 } },
    status: "awaiting_approval",
    revision: 4,
    attemptId: null,
    nativeCommandId: null,
    runId: null,
    evidence: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as Handoff;

describe("handoff approval gate", () => {
  test("approve moves awaiting_approval to queued with human actor", async () => {
    const { service, calls, current } = makeService(baseHandoff());
    const result = await service.approve("workspace-1", "handoff-1", 4, "looks good");
    expect(result.status).toBe("queued");
    expect(result.revision).toBe(5);
    expect(result.evidence).toBe("looks good");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.actor as { kind: string }).kind).toBe("human");
    expect((calls[0]!.change as { status: string }).status).toBe("queued");
    expect(current().status).toBe("queued");
  });

  test("deny moves awaiting_approval to failed with reason", async () => {
    const { service, calls } = makeService(baseHandoff({ revision: 7 }));
    const result = await service.deny("workspace-1", "handoff-1", 7, "not needed");
    expect(result.status).toBe("failed");
    expect(result.revision).toBe(8);
    expect(result.evidence).toBe("not needed");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.actor as { kind: string }).kind).toBe("human");
    expect((calls[0]!.change as { status: string }).status).toBe("failed");
  });

  test("stale revision surfaces CONFLICT without mutating", async () => {
    const { service, calls, current } = makeService(baseHandoff({ revision: 2 }));
    let approveError: unknown;
    try {
      await service.approve("workspace-1", "handoff-1", 1, "stale");
    } catch (error) {
      approveError = error;
    }
    expect(approveError).toBeInstanceOf(DomainError);
    expect((approveError as DomainError).code).toBe("CONFLICT");
    // Advance was still attempted (compare-and-swap); the row is unchanged.
    expect(calls).toHaveLength(1);
    expect(current().revision).toBe(2);
    expect(current().status).toBe("awaiting_approval");

    let denyError: unknown;
    try {
      await service.deny("workspace-1", "handoff-1", 99, "stale deny");
    } catch (error) {
      denyError = error;
    }
    expect(denyError).toBeInstanceOf(DomainError);
    expect((denyError as DomainError).code).toBe("CONFLICT");
    expect(current().revision).toBe(2);
  });

  test("deny requires a non-empty reason", async () => {
    const { service } = makeService(baseHandoff());
    let error: unknown;
    try {
      await service.deny("workspace-1", "handoff-1", 4, "   ");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INVALID_INPUT");
  });
});
