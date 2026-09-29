import { expect, test } from "bun:test";
import { OpenCodeAdapter } from "./opencode";
import { Service } from "@opencode/client/service";

test("unavailable managed discovery asks to verify the existing service, never to start a replacement", async () => {
  const discover = Service.discover; let reads = 0;
  Service.discover = async () => { reads++; return undefined; };
  try {
    const adapter = new OpenCodeAdapter(undefined, undefined, "/fixture/service.json");
    const first = await adapter.connection("/fixture");
    expect(first).toMatchObject({ available: false, state: "unavailable" });
    expect(first.reason).toContain("verify the intended existing service");
    expect(first.reason).not.toContain("service start");
    expect(await adapter.connection("/fixture")).toEqual(first);
    expect(reads).toBe(1);
  } finally { Service.discover = discover; }
});
