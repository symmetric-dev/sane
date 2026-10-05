import { describe, expect, test } from "bun:test";
import { conversationUpdateRoute, type ConversationUpdateRoutes } from "./conversation-update-routes";
import type { ConversationUpdatePage } from "../shared/conversation/conversation-updates";

const page = (after = 0): ConversationUpdatePage => ({ storeId: "store", epoch: "epoch", retainedAfter: 0, through: after, nextCursor: { epoch: "epoch", after }, hasMore: false, updates: [], coverage: [] });
const service: ConversationUpdateRoutes = { bootstrap: async () => ({ ...page(), bootstrap: { activeRunIds: [], sourceBaselines: [] } }), page: async input => page(input.cursor!.after) };
const request = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });

describe("authenticated conversation update route projection", () => {
  test("bootstrap is bounded and uncached", async () => {
    const response = await conversationUpdateRoute(request("/api/conversation-updates/bootstrap"), service);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect((await response!.json()).bootstrap).toEqual({ activeRunIds: [], sourceBaselines: [] });
  });
  test("incremental cursor is passed without manufacturing read state", async () => {
    const response = await conversationUpdateRoute(request("/api/conversation-updates?epoch=epoch&after=4&through=4&limit=10"), service);
    expect(response?.status).toBe(200);
    expect((await response!.json()).nextCursor.after).toBe(4);
  });
  test("rejects malformed, unknown, repeated and unbounded parameters", async () => {
    for (const query of ["", "epoch=epoch", "after=1", "epoch=epoch&after=-1", "epoch=epoch&after=01", "epoch=epoch&after=9007199254740992", "epoch=epoch&after=0&limit=101", "epoch=epoch&after=0&after=1", "epoch=epoch&after=0&workspace=x", "epoch=epoch&after=2&through=1"]) {
      expect((await conversationUpdateRoute(request(`/api/conversation-updates?${query}`), service))?.status).toBe(400);
    }
    expect((await conversationUpdateRoute(request("/api/conversation-updates/bootstrap?after=0"), service))?.status).toBe(400);
  });
  test("does not match other APIs or accept mutation", async () => {
    expect(await conversationUpdateRoute(request("/api/sessions"), service)).toBeNull();
    const response = await conversationUpdateRoute(request("/api/conversation-updates", "POST"), service);
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET");
  });
  test("expired coverage is explicit and derived failures are unavailable", async () => {
    const expired = { ...service, page: async () => { throw Object.assign(new Error("gap"), { status: 410 }); } };
    const gap = await conversationUpdateRoute(request("/api/conversation-updates?epoch=epoch&after=0"), expired);
    expect(gap?.status).toBe(410);
    expect((await gap!.json()).code).toBe("conversation-update-gap");
    const unavailable = { ...service, bootstrap: async () => { throw new Error("private disk path"); } };
    const response = await conversationUpdateRoute(request("/api/conversation-updates/bootstrap"), unavailable);
    expect(response?.status).toBe(503);
    expect(await response!.text()).not.toContain("private disk path");
  });
  test("rejects malformed or cross-epoch service projections", async () => {
    const invalid = { ...service, page: async () => ({ ...page(), epoch: "other", nextCursor: { epoch: "other", after: 0 } }) };
    expect((await conversationUpdateRoute(request("/api/conversation-updates?epoch=epoch&after=0"), invalid))?.status).toBe(503);
  });
});
