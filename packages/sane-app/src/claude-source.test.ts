import { expect, test } from "bun:test";
import { claudeSourceRoot } from "./claude-source";

test("Claude source cannot depend on the SDK versus resumed CLI working directory or custom project selector", () => {
  for (const path of ["", "relative-config", "../config"]) expect(() => claudeSourceRoot({ CLAUDE_CONFIG_DIR: path })).toThrow("must be an absolute directory");
  for (const config of [undefined, "/fixture/config"]) expect(() => claudeSourceRoot({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "selected-project" })).toThrow("unsupported");
  expect(claudeSourceRoot({ CLAUDE_CONFIG_DIR: "/fixture/config/", CLAUDE_CODE_PROJECT_DIR_NAME: "" })).toBe("/fixture/config");
});
