import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli";

for (const args of [
  ["unknown"],
  ["run", "--manifest", "/synthetic/run.json"],
  ["run", "--output", "relative-output"],
  ["run", "--output", "/synthetic/one", "--output", "/synthetic/two"],
  ["replay"],
  ["replay", "--manifest", "relative.json"],
  ["replay", "--manifest", "/synthetic/run.json", "--json", "--html"],
  ["replay", "--manifest", "/synthetic/run.json", "--output", "/synthetic/output"],
] as const) {
  test(`rejects unsupported CLI arguments without starting fixtures: ${args.join(" ")}`, async () => {
    await expect(main([...args])).rejects.toThrow();
  });
}

test("run refuses an existing output directory without changing its contents", async () => {
  const root = mkdtempSync(join("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", "context-demo-cli-test-"));
  try {
    await expect(main(["run", "--output", root])).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true }); }
});
