import * as cursorSdk from "@cursor/sdk"

const result = {
  runtime: `node ${process.version}`,
  sdkEntry: "@cursor/sdk",
  agentCreateExported: typeof cursorSdk.Agent?.create === "function",
  publicConfigureCursorSdkExported: typeof cursorSdk.configureCursorSdk === "function",
  publicConfigureRipgrepPathExported: "configureRipgrepPath" in cursorSdk,
}

process.stdout.write(`${JSON.stringify(result)}\n`)
