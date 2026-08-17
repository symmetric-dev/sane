import { expect, test } from "bun:test"
import { accessSync, constants } from "node:fs"
import { CURSOR_RUNTIME_DIAGNOSTICS } from "../src/cursor-runtime.ts"

test("configures the installed native ripgrep path at startup", () => {
  expect(CURSOR_RUNTIME_DIAGNOSTICS.sdkEntry).toBe("@cursor/sdk/bundled")
  expect(CURSOR_RUNTIME_DIAGNOSTICS.sdkVersion).toBe("1.0.28")
  expect(CURSOR_RUNTIME_DIAGNOSTICS.publicRipgrepConfigurator).toBe(false)
  expect(CURSOR_RUNTIME_DIAGNOSTICS.ripgrepWarningStatus).toBe("fixed")
  expect(CURSOR_RUNTIME_DIAGNOSTICS.nativeRipgrepPath).toBe(process.env.CURSOR_RIPGREP_PATH)

  if (!CURSOR_RUNTIME_DIAGNOSTICS.nativeRipgrepPath) throw new Error("native ripgrep path was not recorded")
  accessSync(CURSOR_RUNTIME_DIAGNOSTICS.nativeRipgrepPath, constants.X_OK)
})
