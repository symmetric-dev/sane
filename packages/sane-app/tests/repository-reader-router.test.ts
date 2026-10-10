import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepositoryReader } from "sane-core/server";
import { performanceFixture } from "./fixtures/app-performance";

test("router asynchronous evidence retains the final live store fence", async () => {
  const f = await performanceFixture(), inspect = RepositoryReader.prototype.inspect;
  const held = spyOn(RepositoryReader.prototype, "inspect").mockImplementation(async function(this: RepositoryReader, discovery, options) {
    const store = await inspect.call(this, discovery, options);
    writeFileSync(join(f.primary, ".sane", "complete.json"), "broken");
    return store;
  });
  try {
    await expect(f.router.forWorkspace(f.workspaceId)).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  } finally { held.mockRestore(); f.close(); }
});

test("router cancellation and shutdown refuse subsequent repository reads", async () => {
  const f = await performanceFixture();
  try {
    const controller = new AbortController(); controller.abort();
    await expect(f.router.inspect(f.workspaceId, { signal: controller.signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await f.router.forWorkspace(f.workspaceId)).domain.primaryCheckout).toBe(f.primary);
    f.router.stopReads();
    await expect(f.router.forWorkspace(f.workspaceId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  } finally { f.close(); }
});
