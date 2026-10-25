import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { externalFixtureRoot } from "./paths";

test("fixture destinations reject source descendants and aliases before creating anything", () => {
  const root = mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-demo-path-test-");
  try {
    const source = join(root, "source"), context = join(source, "context"), outside = join(root, "outside");
    mkdirSync(source); mkdirSync(context); mkdirSync(outside);
    expect(() => externalFixtureRoot(source, source)).toThrow("outside the source");
    const forbidden = join(context, "new-output");
    expect(() => externalFixtureRoot(forbidden, source)).toThrow("outside the source");
    expect(existsSync(forbidden)).toBe(false);
    const alias = join(root, "source-alias"); symlinkSync(context, alias);
    expect(() => externalFixtureRoot(join(alias, "new-output"), source)).toThrow("outside the source");
    expect(existsSync(forbidden)).toBe(false);
    const symlink = join(outside, "linked-output"); symlinkSync(context, symlink);
    expect(() => externalFixtureRoot(symlink, source)).toThrow("symbolic link");
    expect(externalFixtureRoot(join(outside, "fresh"), source)).toBe(join(outside, "fresh"));
    expect(existsSync(join(outside, "fresh"))).toBe(false);
    expect(() => externalFixtureRoot("relative", source)).toThrow("absolute");
  } finally { rmSync(root, { recursive: true }); }
});
