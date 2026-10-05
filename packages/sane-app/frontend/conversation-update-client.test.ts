import { afterEach, describe, expect, test } from "bun:test";
import { conversationClient, ApiError } from "./cc-client";
import { updateOccurrenceId, type ConversationUpdatePage } from "../shared/conversation/conversation-updates";

const originalFetch = globalThis.fetch;
const source = { harness: "claude-code" as const, authorityId: "authority", nativeSessionId: "native" };
const wire = (): ConversationUpdatePage => ({ storeId: "store", epoch: "epoch", retainedAfter: 0, through: 2,
  nextCursor: { epoch: "epoch", after: 2 }, hasMore: false, coverage: [], updates: [{
    id: updateOccurrenceId(source, "E2"), source, conversationId: "A", kind: "reply", sequence: 2, occurrenceSequence: 2, revision: 1,
    occurredAt: null, observedAt: "2026-10-05T00:00:00Z",
  }] });

describe("conversation update API client validation", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });
  test("valid traversal binds encoded epoch/cursor/through/limit and abort signal", async () => {
    let url = "", init: RequestInit | undefined;
    globalThis.fetch = (async (input: any, options: any) => { url = String(input); init = options; return Response.json(wire()); }) as typeof fetch;
    const controller = new AbortController();
    expect(await conversationClient.conversationUpdates!({ cursor: { epoch: "epoch", after: 1 }, through: 2, limit: 1 }, controller.signal)).toEqual(wire());
    expect(url).toBe("/api/conversation-updates?limit=1&epoch=epoch&after=1&through=2"); expect(init?.credentials).toBe("same-origin"); expect(init?.cache).toBe("no-store");
    controller.abort(); expect(init?.signal?.aborted).toBe(true);
  });
  for (const mismatch of ["epoch", "through", "regressed cursor", "cursor epoch", "retention", "page limit", "order", "bootstrap on feed", "unknown body"] as const) {
    test(`rejects ${mismatch} mismatch`, async () => {
      const body: any = wire();
      if (mismatch === "epoch") { body.epoch = "other"; body.nextCursor.epoch = "other"; }
      if (mismatch === "through") { body.through = 3; body.hasMore = true; }
      if (mismatch === "regressed cursor") { body.nextCursor.after = 0; body.hasMore = true; body.updates = []; }
      if (mismatch === "cursor epoch") body.nextCursor.epoch = "other";
      if (mismatch === "retention") body.retainedAfter = 2;
      if (mismatch === "page limit") body.updates.unshift({ ...body.updates[0], id: updateOccurrenceId(source, "E1"), sequence: 1, occurrenceSequence: 1 });
      if (mismatch === "order") body.updates[0].sequence = 1;
      if (mismatch === "bootstrap on feed") body.bootstrap = { activeRunIds: [], sourceBaselines: [] };
      if (mismatch === "unknown body") body.transcript = "must not be accepted";
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
      await expect(conversationClient.conversationUpdates!({ cursor: { epoch: "epoch", after: mismatch === "page limit" ? 0 : 1 }, through: 2, limit: 1 })).rejects.toThrow("Invalid conversation update page.");
    });
  }
  test("bootstrap requires metadata and refuses feed traversal inputs before fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(wire()); }) as unknown as typeof fetch;
    await expect(conversationClient.conversationUpdates!({}, undefined, true)).rejects.toThrow("Invalid conversation update page.");
    await expect(conversationClient.conversationUpdates!({ cursor: { epoch: "epoch", after: 0 } }, undefined, true)).rejects.toThrow("Invalid conversation update request.");
    await expect(conversationClient.conversationUpdates!({ limit: 101 })).rejects.toThrow("Invalid conversation update request."); expect(calls).toBe(1);
    const body = { ...wire(), bootstrap: { activeRunIds: [], sourceBaselines: [] } };
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
    expect(await conversationClient.conversationUpdates!({}, undefined, true)).toEqual(body);
  });
  test("authentication and retention errors preserve API status/reason", async () => {
    for (const status of [401, 409]) {
      globalThis.fetch = (async () => Response.json({ error: "reset required", reason: "epoch_changed" }, { status })) as unknown as typeof fetch;
      try { await conversationClient.conversationUpdates!({}); throw new Error("must reject"); }
      catch (error) { expect(error).toBeInstanceOf(ApiError); expect(error).toMatchObject({ status, code: "epoch_changed" }); }
    }
  });
});
