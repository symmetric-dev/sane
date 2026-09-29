import { expect, test } from "bun:test";
import { OpenCodeAdapter, type NativeMessage } from "./opencode";

const message = (id: string, type: string, outcome?: string): NativeMessage => ({ id, type, time: { created: 1 }, ...(outcome ? { outcome } : {}) });
for (const [app, external] of [["failed", "succeeded"], ["succeeded", "failed"]]) test(`App ${app} is not relabeled by later external ${external}`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const history = [message("msg_app", "user"), message("answer_app", "assistant"), message("idle_app", "idle", app), message("msg_external", "user"), message("answer_external", "assistant"), message("idle_external", "idle", external)];
  adapter.request = async (path: string) => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as any;
    if (path.endsWith("/active")) return { data: { ses_fixture: { type: "running" } } } as any; // Yet another external turn may already be running.
    if (path.endsWith("/inbox")) return { data: [] } as any;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, outcome: external, time: { created: 0, updated: 3, idle: 3 } } } as any;
  };
  const snapshot = await adapter.snapshot("ses_fixture", "msg_app", "/fixture");
  expect(snapshot.outcome).toBe(app);
  expect(snapshot.messages.map(m => m.id)).toEqual(["msg_app", "answer_app", "idle_app"]);
});

test("ambiguous or missing command boundaries never fall back to the latest session outcome", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  let history = [message("msg_app", "user"), message("msg_external", "user"), message("idle_external", "idle", "succeeded")];
  adapter.request = async (path: string) => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as any;
    if (path.endsWith("/active")) return { data: {} } as any;
    if (path.endsWith("/inbox")) return { data: [] } as any;
    return { data: { id: "ses_fixture", time: { created: 0, updated: 2, idle: 2 }, outcome: "succeeded" } } as any;
  };
  expect(await adapter.snapshot("ses_fixture", "msg_app")).toMatchObject({ outcome: undefined, messages: [history[0]] });
  history = [message("msg_app", "user"), message("idle_app", "idle")];
  expect((await adapter.snapshot("ses_fixture", "msg_app")).outcome).toBeUndefined();
  history = [message("idle_external", "idle", "succeeded")];
  expect(await adapter.snapshot("ses_fixture", "msg_app")).toMatchObject({ outcome: undefined, messages: [] });
});
