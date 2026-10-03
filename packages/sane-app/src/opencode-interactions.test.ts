import { describe, expect, test } from "bun:test";
import type { Interaction, InteractionReply } from "./oc-contract";
import { OpenCodeAdapter } from "./opencode";

/** Fully injected adapter: no service discovery, HTTP, processes or models. */
class InteractionFixture extends OpenCodeAdapter {
  reads = 0;
  writes: { path: string; method: string; data: unknown }[] = [];
  override async interactions(): Promise<Interaction[]> {
    this.reads++;
    return [{ id: "permission", type: "permission", title: "fixture", options: [] }, { id: "question", type: "question", title: "fixture", fields: [] }];
  }
  override async request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    this.writes.push({ path, method, data }); return undefined as T;
  }
}

describe("OpenCode reply discriminant admission", () => {
  test("malformed discriminants return 400 before inbox reads or native mutation", async () => {
    const fixture = new InteractionFixture();
    for (const reply of [undefined, null, {}, { type: "form", answer: {} }, { type: "gemini", answer: {} }, { type: false }, []]) {
      await expect(fixture.reply("ses_fixture", "question", reply as InteractionReply)).rejects.toMatchObject({ status: 400, message: "Invalid interaction reply type" });
    }
    expect(fixture.reads).toBe(0); expect(fixture.writes).toEqual([]);
  });

  test("permission and question replies retain exact native paths and payloads", async () => {
    const fixture = new InteractionFixture();
    await fixture.reply("ses_fixture", "permission", { type: "permission", decision: "once", message: "offline" });
    await fixture.reply("ses_fixture", "question", { type: "question", answer: { fixture: "answer" } });
    expect(fixture.writes).toEqual([
      { path: "/api/session/ses_fixture/permission/permission/reply", method: "POST", data: { decision: "once", message: "offline" } },
      { path: "/api/session/ses_fixture/form/question/reply", method: "POST", data: { answer: { fixture: "answer" } } },
    ]);
  });

  test("valid type never redirects a mismatched pending interaction to another endpoint", async () => {
    const fixture = new InteractionFixture();
    await expect(fixture.reply("ses_fixture", "permission", { type: "question", answer: {} })).rejects.toMatchObject({ status: 404 });
    expect(fixture.writes).toEqual([]);
  });

  test("invalid permission decisions and question bodies cannot mutate native state", async () => {
    const fixture = new InteractionFixture();
    await expect(fixture.reply("ses_fixture", "permission", { type: "permission", decision: "unknown" } as unknown as InteractionReply)).rejects.toMatchObject({ status: 400 });
    await expect(fixture.reply("ses_fixture", "question", { type: "question", answer: [] } as unknown as InteractionReply)).rejects.toMatchObject({ status: 400 });
    expect(fixture.writes).toEqual([]);
  });
});
