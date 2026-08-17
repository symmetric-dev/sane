#!/usr/bin/env bun

import { main } from "../src/cli/work-sdk.ts"

if (import.meta.main) {
  process.exitCode = await main()
}
